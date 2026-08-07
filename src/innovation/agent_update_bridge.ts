/**
 * [革新版·Agent 更新] 运行时桥接层。
 *
 * 将 agent_update 纯逻辑接入 ST 运行时：
 *  - 注册独立工具名（避免与原版 mvu_VariableUpdate 冲突）
 *  - 监听 CHAT_COMPLETION_SETTINGS_READY，在主模型 generate_data 上注入工具 + 格式强调
 *  - 复用原版 updateVariables（只读引用）执行变量更新
 *
 * 本文件依赖 tavern_helper 全局（SillyTavern / getScriptId / getLastMessageId 等），
 * 仅作运行时接入用，不纳入单测。
 * 默认通过 sessionStorage 临时开关控制，避免影响既有行为。
 */

import { updateVariables } from '@/function/update_variables';
import { useDataStore } from '@/store';
import { controlledStoppableEventOn, getLastValidVariable } from '@/util';
import {
    AGENT_UPDATE_FUNCTION_PREFIX,
    applyAgentToolToGenerateData,
    buildAgentFormatEmphasis,
    createAgentUpdateToolSchema,
} from '@/innovation/agent_update';

const AGENT_MODE_SESSION_KEY = 'nlkaleido_agent_mode';

/** 读取 Agent 模式开关（sessionStorage 临时开关，便于实验；后续可接设置面板） */
export function isAgentModeEnabled(): boolean {
    try {
        return sessionStorage.getItem(AGENT_MODE_SESSION_KEY) === '1';
    } catch {
        return false;
    }
}

/** 设置 Agent 模式开关 */
export function setAgentModeEnabled(enabled: boolean): void {
    try {
        if (enabled) sessionStorage.setItem(AGENT_MODE_SESSION_KEY, '1');
        else sessionStorage.removeItem(AGENT_MODE_SESSION_KEY);
    } catch {
        /* ignore */
    }
}

/** 生成唯一工具名（带 scriptId，隔离多实例） */
export function getAgentToolName(): string {
    return `${AGENT_UPDATE_FUNCTION_PREFIX}_${getScriptId()}`;
}

/**
 * 主模型工具 action：复用原版变量更新逻辑。
 * 参数 shape：{ analysis?: string, delta: string }
 */
async function onAgentUpdateCall(args: any): Promise<string> {
    if (!args?.delta) return '';
    const message_id = getLastMessageId();
    const chat_message = getChatMessages(message_id).at(-1);
    if (!chat_message) return '';

    // 取最近含 stat_data 的变量
    const variables = getLastValidVariable(message_id + 1);
    if (!_.has(variables, 'stat_data')) return '';

    const has_modified = await updateVariables(args.delta, variables);
    if (has_modified && useDataStore().settings.兼容性.更新到聊天变量) {
        await replaceVariables(variables, { type: 'chat' });
    }
    await replaceVariables(variables, { type: 'message', message_id });
    return JSON.stringify(variables.delta_data);
}

/**
 * 初始化 Agent 更新桥接层。
 * @returns 停止函数
 */
export function initAgentUpdateBridge(): () => void {
    const stop_list: Array<() => void> = [];

    // 注册独立工具（Agent 模式开启时才注册）
    const { registerFunctionTool } = SillyTavern;
    if (registerFunctionTool) {
        registerFunctionTool({
            name: getAgentToolName(),
            displayName: '革新版 Agent 更新',
            stealth: true,
            description: 'use this tool to UpdateVariable from the main response stream.',
            parameters: createAgentUpdateToolSchema(),
            shouldRegister: () => {
                const store = useDataStore();
                return Boolean(store.should_enable) && isAgentModeEnabled();
            },
            action: onAgentUpdateCall,
            formatMessage: () => '',
        });
        stop_list.push(() => {
            SillyTavern.unregisterFunctionTool(getAgentToolName());
        });
    }

    // 主模型请求注入：监听 CHAT_COMPLETION_SETTINGS_READY，向 generate_data 附加工具与格式强调
    stop_list.push(
        controlledStoppableEventOn('CHAT_COMPLETION_SETTINGS_READY', (generate_data: any) => {
            const store = useDataStore();
            const injected = applyAgentToolToGenerateData(generate_data, getAgentToolName(), {
                is_agent_mode: isAgentModeEnabled(),
                is_during_extra_analysis: store.runtimes.is_during_extra_analysis,
                tool_choice: 'required',
            });
            if (injected && typeof generate_data?.injects?.push === 'function') {
                generate_data.injects.push({
                    position: 'in_chat',
                    depth: 0,
                    should_scan: false,
                    role: 'system',
                    content: buildAgentFormatEmphasis(getAgentToolName()),
                });
            }
        })
    );

    return () => {
        stop_list.forEach(stop => stop());
    };
}
