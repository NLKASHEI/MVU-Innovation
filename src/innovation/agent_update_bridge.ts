/**
 * [革新版·Agent 更新] 运行时桥接层。
 *
 * 将 agent_update / agent_loop / agent_extra_loop 纯逻辑接入 ST 运行时：
 *  - 注册独立工具名（避免与原版 mvu_VariableUpdate 冲突）
 *  - 监听 CHAT_COMPLETION_SETTINGS_READY，在主模型 generate_data 上注入工具 + 格式强调
 *  - 工具 action 复用原版 updateVariables 执行变量更新，并跑多步循环（runMultiStepAgent）
 *  - 【Agent 化更新主通道】runAgentExtraAnalysisLoop：把「额外模型解析」升级为多轮循环——
 *    每轮调用 invokeExtraModelWithStrategy，基于最新变量状态反复分析，直到稳定/无delta/达步数/熔断
 *  - 设置从 settings 模块（localStorage）读取，供面板开关控制
 *
 * 本文件依赖 tavern_helper 全局，仅作运行时接入用，不纳入单测。
 * 同时维护「运行时诊断状态」，供面板直观定位：工具是否注册、是否注入、是否被模型调用。
 */

import { updateVariables } from '@/function/update_variables';
import { useDataStore } from '@/store';
import { controlledStoppableEventOn, getLastValidVariable } from '@/util';
import {
    AGENT_UPDATE_FUNCTION_PREFIX,
    applyAgentToolToGenerateData,
    buildAgentFormatEmphasis,
    createAgentUpdateToolSchema,
    evaluateAgentShouldRegister,
} from '@/innovation/agent_update';
import {
    AgentLoopResult,
    runMultiStepAgent,
} from '@/innovation/agent_loop';
import {
    ExtraLoopResult,
    runExtraModelAgentLoop,
} from '@/innovation/agent_extra_loop';
import { invokeExtraModelWithStrategy } from '@/function/update/invoke_extra_model';
import { loadInnovationSettings } from '@/innovation/settings';

/** 最近一次多步循环结果（供面板显示） */
let last_agent_loop_result: AgentLoopResult | ExtraLoopResult | null = null;

export function getLastAgentLoopResult(): AgentLoopResult | ExtraLoopResult | null {
    return last_agent_loop_result;
}

/** 运行时诊断状态（供面板定位 Agent 是否生效） */
export interface AgentRuntimeState {
    /** shouldRegister 被 ST 查询的次数（每次请求都会查） */
    shouldRegisterCalls: number;
    /** 最近一次 shouldRegister 决策 */
    lastShouldRegister: { ok: boolean; reason: string } | null;
    /** 注入尝试次数（CHAT_COMPLETION_SETTINGS_READY 触发次数） */
    injectCalls: number;
    /** 最近一次注入结果 */
    lastInject: { ok: boolean; reason: string } | null;
    /** 工具 action 被模型实际调用的次数（>0 才算真的 agent 化生效） */
    actionCalls: number;
    /** 最近一次 action 的错误（无则为 null） */
    lastActionError: string | null;
    /** 最近一次注入时 generate_data 是否已有 tools（帮助判断 ST 是否在别处注入工具） */
    lastExistingToolsCount: number;
}

const runtime_state: AgentRuntimeState = {
    shouldRegisterCalls: 0,
    lastShouldRegister: null,
    injectCalls: 0,
    lastInject: null,
    actionCalls: 0,
    lastActionError: null,
    lastExistingToolsCount: 0,
};

export function getAgentRuntimeState(): AgentRuntimeState {
    return { ...runtime_state, lastShouldRegister: runtime_state.lastShouldRegister ? { ...runtime_state.lastShouldRegister } : null, lastInject: runtime_state.lastInject ? { ...runtime_state.lastInject } : null };
}

/** 生成唯一工具名（带 scriptId，隔离多实例） */
export function getAgentToolName(): string {
    return `${AGENT_UPDATE_FUNCTION_PREFIX}_${getScriptId()}`;
}

/**
 * 【Agent 化更新主通道】额外模型多轮解析。
 *
 * 原版每次 MESSAGE_RECEIVED 只调用一次 invokeExtraModelWithStrategy（单轮）。
 * 此函数把该流程升级为多轮：每轮调用额外模型解析 → 提取 delta 应用到最新变量 → 写回，
 * 下一轮额外模型基于**更新后的变量状态**重新分析，直到：
 *   stable / no_delta / max_steps / loop_broken（死循环熔断）
 *
 * @param message_id 当前收到的消息 id（与原版 onMessageReceived 一致）
 * @returns 合并后的 <UpdateVariable> 块文本（供回填消息），无则 null
 */
export async function runAgentExtraAnalysisLoop(message_id: number): Promise<string | null> {
    const settings = loadInnovationSettings(localStorage);
    if (!settings.agentEnabled) return null;

    const variables = getLastValidVariable(message_id + 1);
    if (!variables || !_.has(variables, 'stat_data')) return null;

    const loop_result = await runExtraModelAgentLoop(
        // 每轮：基于最新变量状态调用一次额外模型解析
        async () => invokeExtraModelWithStrategy(),
        // 每轮：把 delta 应用到变量并写回，供下一轮读取最新状态
        async (delta: string) => {
            const modified = await updateVariables(delta, variables);
            await replaceVariables(variables, { type: 'message', message_id });
            return modified;
        },
        { maxSteps: settings.maxSteps, loopThreshold: settings.loopThreshold }
    );

    last_agent_loop_result = loop_result;

    if (loop_result.termination === 'error') {
        console.error('[革新版·Agent多轮] 失败', loop_result.error);
        return null;
    }

    const blocks = loop_result.steps.map(s => s.block).filter(Boolean);
    if (blocks.length === 0) {
        return null;
    }
    console.debug(
        `[革新版·Agent多轮] ${loop_result.steps.length} 轮，终止=${loop_result.termination}`
    );
    // 合并各轮块，回填消息（handleVariablesInMessage 会应用；_.set 绝对赋值幂等）
    return blocks.join('\n\n');
}

/**
 * 主模型工具 action：复用原版变量更新逻辑。
 * 参数 shape：{ analysis?: string, delta: string }
 * 返回 JSON delta_data（与原版 onVariableUpdatedCall 一致）。
 */
async function onAgentUpdateCall(args: any): Promise<string> {
    runtime_state.actionCalls += 1;
    runtime_state.lastActionError = null;
    try {
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
    } catch (e) {
        runtime_state.lastActionError = e instanceof Error ? e.message : String(e);
        console.error('[革新版·Agent] action 异常', e);
        return '';
    }
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
                const decision = evaluateAgentShouldRegister(
                    Boolean(store.should_enable),
                    settings.agentEnabled
                );
                runtime_state.shouldRegisterCalls += 1;
                runtime_state.lastShouldRegister = decision;
                return decision.ok;
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
            runtime_state.injectCalls += 1;

            if (!settings.agentEnabled) {
                runtime_state.lastInject = { ok: false, reason: '革新版 Agent 开关未开启' };
                return;
            }
            runtime_state.lastExistingToolsCount = Array.isArray(generate_data?.tools)
                ? generate_data.tools.length
                : 0;

            const injected = applyAgentToolToGenerateData(generate_data, getAgentToolName(), {
                is_agent_mode: settings.agentEnabled,
                is_during_extra_analysis: store.runtimes.is_during_extra_analysis,
                tool_choice: 'required',
            });
            runtime_state.lastInject = {
                ok: injected,
                reason: injected
                    ? '已注入工具+格式强调'
                    : '未注入（处于额外模型解析期间或开关关闭）',
            };
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
