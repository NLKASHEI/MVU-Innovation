/**
 * [革新版·Agent 更新] 运行时桥接层。
 *
 * 将 agent_update / agent_loop 纯逻辑接入 ST 运行时：
 *  - 注册独立工具名（避免与原版 mvu_VariableUpdate 冲突）
 *  - 监听 CHAT_COMPLETION_SETTINGS_READY，在主模型 generate_data 上注入工具 + 格式强调
 *  - 工具 action 复用原版 updateVariables 执行变量更新，并跑多步循环（runMultiStepAgent）
 *  - 设置从 settings 模块（localStorage）读取，供面板开关控制
 *
 * 本文件依赖 tavern_helper 全局，仅作运行时接入用，不纳入单测。
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
import {
    AgentLoopResult,
    runMultiStepAgent,
} from '@/innovation/agent_loop';
import { loadInnovationSettings } from '@/innovation/settings';

/** 最近一次多步循环结果（供面板显示） */
let last_agent_loop_result: AgentLoopResult | null = null;

export function getLastAgentLoopResult(): AgentLoopResult | null {
    return last_agent_loop_result;
}

/** 生成唯一工具名（带 scriptId，隔离多实例） */
export function getAgentToolName(): string {
    return `${AGENT_UPDATE_FUNCTION_PREFIX}_${getScriptId()}`;
}

/**
 * 主模型工具 action：复用原版变量更新逻辑。
 * 参数 shape：{ analysis?: string, delta: string }
 * 返回 JSON delta_data（与原版 onVariableUpdatedCall 一致）。
 */
async function onAgentUpdateCall(args: any): Promise<string> {
    if (!args?.delta) return '';
    const settings = loadInnovationSettings(localStorage);

    const message_id = getLastMessageId();
    const chat_message = getChatMessages(message_id).at(-1);
    if (!chat_message) return '';

    const variables = getLastValidVariable(message_id + 1);
    if (!_.has(variables, 'stat_data')) return '';

    if (settings.agentEnabled && settings.maxSteps > 1) {
        // 多步循环：每步应用一次 delta 到同一变量对象，直到稳定/达最大步数
        const loop_result = await runMultiStepAgent(
            async step => {
                if (step > 1 && !args?.delta) return null;
                // 首步用参数 delta；后续步用同一 delta 重试（近似：模型应产出新 delta，
                // 实际接入时可由真实多轮 generate 提供；此处先以单 delta 多步验证循环框架）
                const delta = step === 1 ? args.delta : args.delta;
                const has_modified = await updateVariables(delta, variables);
                return {
                    delta,
                    analysis: args.analysis ?? '',
                    did_modify: has_modified,
                };
            },
            settings.maxSteps,
            settings.loopThreshold
        );
        last_agent_loop_result = loop_result;
        console.debug(
            `[革新版·Agent] ${loop_result.steps.length} 步，终止=${loop_result.termination}`
        );
    } else {
        // 单步（与默认行为一致）
        const has_modified = await updateVariables(args.delta, variables);
        last_agent_loop_result = {
            steps: [
                {
                    step: 1,
                    delta: args.delta,
                    analysis: args.analysis ?? '',
                    did_modify: has_modified,
                },
            ],
            termination: has_modified ? 'stable' : 'no_delta',
            terminated_at_step: 1,
            loop_broken: false,
        };
    }

    if (useDataStore().settings.兼容性.更新到聊天变量) {
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
                const settings = loadInnovationSettings(localStorage);
                return Boolean(store.should_enable) && settings.agentEnabled;
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
            const settings = loadInnovationSettings(localStorage);
            const injected = applyAgentToolToGenerateData(generate_data, getAgentToolName(), {
                is_agent_mode: settings.agentEnabled,
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
