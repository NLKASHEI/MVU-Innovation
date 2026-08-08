/**
 * [革新版·独立 Agent 工作流执行器 v2] 运行时桥接层。
 *
 * 革新版自己的 Agent 更新链路——不复用 MVU 的 invokeExtraModelWithStrategy / onMessageReceived：
 *   - 自己监听 tavern_events.MESSAGE_RECEIVED
 *   - 自己读取当前变量状态（getVariables）
 *   - 自己构造请求（tavern-helper 底层 generateRaw，见 agent_request.ts）
 *   - 自己读取世界书规则（getWorldbook，见 agent_worldbook.ts）
 *   - 自己执行单次 Agent 回合工作流（agent_workflow.ts：读规则→dueFields 调度→观察→一步更新→校验）
 *   - 变量应用【复用原版 MVU 的命令解释器 updateVariables】（魔改原版：校验过的
 *     delta 回放给原版解释器，原版负责 VWD/schema/display_data 等全部语义）
 *
 * v2 修复（相对 v1 四阶段检查工作流）：
 *   - 移除「盲检查」阶段：v1 的 check 请求只有 stat_data 文本、无剧情上下文，
 *     模型根本看不到剧情；现在剧情上下文（extractRecentStory）显式构造进更新请求。
 *   - 移除对原版 MVU 设置（store.settings.更新方式）的依赖——革新版独立开关即可。
 *   - 应用层不再用弱正则，改为回放给原版 updateVariables（支持命令方言 + JSON Patch 方言）。
 *
 * 本文件依赖 tavern-helper 全局（已通过 slash-runner/@types 声明），仅作运行时接入，不纳入单测。
 * 纯逻辑部分（请求构造/调度/投影/校验/工作流编排）均有独立单测。
 */

import { runAgentWorkflow, AgentWorkflowResult, PreparedOps } from '@/innovation/agent_workflow';
import {
    buildAgentUpdateRawConfig,
    buildAgentUpdateTask,
    createJsonPatchResponseSchema,
    normalizeGenerateText,
} from '@/innovation/agent_request';
import { selectUpdateRules } from '@/innovation/agent_worldbook';
import { updateVariables } from '@/function/update_variables';
import { loadInnovationSettings } from '@/innovation/settings';
import { useDataStore } from '@/store';

/** 最近一次工作流结果（供面板显示） */
let last_workflow_result: AgentWorkflowResult | null = null;

export function getLastWorkflowResult(): AgentWorkflowResult | null {
    return last_workflow_result;
}

/** 从当前消息提取「当前变量状态」文本（供观察层投影） */
function extractStateText(message_id: number): Record<string, any> | null {
    try {
        const vars: any = getVariables({ type: 'message', message_id });
        const stat = vars?.stat_data;
        if (stat === undefined || stat === null) return null;
        return typeof stat === 'object' ? stat : null;
    } catch {
        return null;
    }
}

/**
 * 提取「最近剧情」文本（对齐万花筒 L3 尾部 recent_story 的下放版）：
 * 取最近 N 条消息（跳过 system/空消息），带角色名前缀，截断到上限。
 */
function extractRecentStory(
    message_id: number,
    max_messages: number = 6,
    max_chars: number = 6000
): string {
    try {
        const messages: any[] = getChatMessages(message_id);
        if (!Array.isArray(messages) || messages.length === 0) return '';
        const recent = messages
            .filter((m: any) => m && typeof m.message === 'string' && m.message.trim().length > 0)
            .slice(-max_messages);
        const lines: string[] = [];
        for (const m of recent) {
            const name = typeof m.name === 'string' && m.name ? m.name : m.role === 'user' ? 'user' : 'assistant';
            lines.push(`${name}: ${m.message.trim()}`);
        }
        let text = lines.join('\n');
        if (text.length > max_chars) text = text.slice(0, max_chars) + '\n…（剧情过长已截断）';
        return text;
    } catch {
        return '';
    }
}

/** 读取当前角色可用世界书的 [mvu_update] 规则（全部，不按路径过滤——调度在核心做） */
async function readWorldbookRules(): Promise<string[]> {
    try {
        const names: string[] = getWorldbookNames();
        const entries: any[] = [];
        for (const name of names) {
            try {
                const wb = await getWorldbook(name);
                entries.push(...wb);
            } catch {
                /* 单个世界书读取失败不阻断 */
            }
        }
        return selectUpdateRules(entries, []).entries;
    } catch {
        return [];
    }
}

/** 解析模型输出中的 <UpdateVariable> 块 */
function extractUpdateBlock(text: string): string {
    const match = text.match(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/i);
    if (match) return match[0];
    if (/<UpdateVariable>/i.test(text)) {
        const start = text.indexOf('<UpdateVariable>');
        return text.slice(start);
    }
    return text.trim();
}

/**
 * 把结构化输出（{analysis, json_patch} 或 op 数组，含代码围栏）包成 <UpdateVariable><JSONPatch> 块，
 * 让核心统一走 sanitizeJsonPatch 通道。不是 JSON → 返回 null（走文本通道）。
 */
function wrapStructuredPatch(text: string): string | null {
    const json_text = text
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();
    if (!(json_text.startsWith('[') || json_text.startsWith('{'))) return null;
    try {
        const parsed: unknown = JSON.parse(json_text);
        const patch = Array.isArray(parsed)
            ? parsed
            : parsed && typeof parsed === 'object' && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>).json_patch ??
                (parsed as Record<string, unknown>).jsonPatch ??
                (parsed as Record<string, unknown>).patch ??
                (parsed as Record<string, unknown>).delta
              : undefined;
        if (Array.isArray(patch)) {
            return `<UpdateVariable>\n<JSONPatch>${JSON.stringify(patch)}</JSONPatch>\n</UpdateVariable>`;
        }
    } catch {
        /* 不是 JSON → 文本通道 */
    }
    return null;
}

/**
 * 把校验通过的 ops 回放给原版 MVU 命令解释器（updateVariables）应用一次。
 * 命令方言 → 原样拼接命令文本；JSON Patch 方言 → 包 <JSONPatch> 标签。
 * 原版解释器负责 VWD/schema/display_data/事件等全部语义；返回是否实际修改。
 */
async function applyPreparedOps(prepared: PreparedOps): Promise<{ applied: boolean }> {
    const parts: string[] = [];
    for (const cmd of prepared.commands) {
        if (cmd.fullMatch) parts.push(cmd.fullMatch);
    }
    if (prepared.patch && prepared.patch.length > 0) {
        parts.push(`<JSONPatch>${JSON.stringify(prepared.patch)}</JSONPatch>`);
    }
    const delta_text = parts.join('\n');
    if (!delta_text.trim()) return { applied: false };

    const message_id = getLastMessageId();
    if (message_id === null || message_id === undefined) return { applied: false };

    const variables: any = getLastValidVariable(message_id + 1);
    if (!variables || !_.has(variables, 'stat_data')) return { applied: false };

    const has_variable_modified = await updateVariables(delta_text, variables);
    if (has_variable_modified && useDataStore().settings.兼容性.更新到聊天变量) {
        await replaceVariables(variables, { type: 'chat' });
    }
    await replaceVariables(variables, { type: 'message', message_id });
    return { applied: has_variable_modified };
}

/**
 * 对一条 MESSAGE_RECEIVED 执行革新版单次 Agent 回合工作流。
 * @param message_id 收到的消息 id
 * @returns 工作流结果；Agent 未启用或状态缺失时返回 null
 */
export async function runAgentWorkflowForMessage(
    message_id: number
): Promise<AgentWorkflowResult | null> {
    const settings = loadInnovationSettings(localStorage);
    if (!settings.agentEnabled) return null;

    const state = extractStateText(message_id);
    if (!state) {
        // 无变量状态可更新 → 记录一个 no_change
        last_workflow_result = {
            stages: [],
            rules: null,
            due: null,
            observation: null,
            update: null,
            prepared: null,
            selfCheck: null,
            termination: 'no_change',
            retries: 0,
            elapsed_ms: 0,
        };
        return last_workflow_result;
    }

    const story = extractRecentStory(message_id);
    // 自定义额外模型配置（可选；缺省用当前插头）
    const custom_api: Record<string, any> | undefined = undefined;

    const executor = {
        // 阶段1 读规则：本地读取全部 [mvu_update] 规则（零模型调用）
        readRules: async () => {
            const entries = await readWorldbookRules();
            return { entries, raw: entries.join('\n---\n') };
        },
        // 阶段4 一步 agent 回合：基于（剧情+观察+规则）产出 delta。
        // 首选结构化输出（json_schema，ST 自动按 provider 转换：OpenAI → response_format，
        // Claude → 强制工具调用）；provider 不支持时降级纯文本指令。
        update: async (ctx: { story: string; observation: string; rules: string[] }, last_error?: string) => {
            let result: unknown;
            try {
                const config = buildAgentUpdateRawConfig({
                    task: buildAgentUpdateTask({
                        story: ctx.story,
                        observation: ctx.observation,
                        rules: ctx.rules,
                        last_error,
                        structured: true,
                    }),
                    custom_api,
                    json_schema: createJsonPatchResponseSchema(),
                });
                result = await generateRaw(config);
            } catch {
                // 降级：纯文本指令（模型输出 <UpdateVariable> 块）
                const fallback_config = buildAgentUpdateRawConfig({
                    task: buildAgentUpdateTask({
                        story: ctx.story,
                        observation: ctx.observation,
                        rules: ctx.rules,
                        last_error,
                    }),
                    custom_api,
                });
                result = await generateRaw(fallback_config);
            }
            const text = normalizeGenerateText(result);
            const structured_block = wrapStructuredPatch(text);
            if (structured_block) return { block: structured_block, raw: text };
            return { block: extractUpdateBlock(text), raw: text };
        },
        // 阶段5 应用：回放给原版 updateVariables
        apply: async (prepared: PreparedOps) => applyPreparedOps(prepared),
    };

    const workflow_result = await runAgentWorkflow(executor, { state, story }, {
        maxRetries: Math.max(1, settings.maxSteps - 1),
        loopThreshold: settings.loopThreshold,
    });
    last_workflow_result = workflow_result;

    if (workflow_result.termination === 'error') {
        console.error('[革新版·Agent工作流] 失败', workflow_result.error);
    } else {
        console.debug(
            `[革新版·Agent工作流] 阶段=${workflow_result.stages.join('→')} 终止=${workflow_result.termination}`
        );
    }
    return workflow_result;
}

/**
 * 初始化革新版独立 Agent 工作流监听。
 * 自己监听 MESSAGE_RECEIVED，不复用 MVU 的 onMessageReceived；
 * 是否启用完全由革新版自身设置（agentEnabled）决定，不依赖原版 MVU 的更新方式配置。
 * @returns 停止函数
 */
export function initAgentWorkflowBridge(): () => void {
    const { stop } = eventOn(tavern_events.MESSAGE_RECEIVED, async (message_id: number) => {
        await runAgentWorkflowForMessage(message_id);
    });
    return () => {
        stop();
    };
}
