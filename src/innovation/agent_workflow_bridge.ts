/**
 * [革新版·独立 Agent 工作流执行器 v3] 运行时桥接层。
 *
 * 革新版自己的 Agent 更新链路——不复用 MVU 的 invokeExtraModelWithStrategy / onMessageReceived：
 *   - 自己监听 tavern_events.MESSAGE_RECEIVED
 *   - 自己读取当前变量状态（getVariables）
 *   - 自己构造请求（tavern-helper 底层 generateRaw，见 agent_request.ts）
 *   - 自己执行 agent 化工作流（agent_workflow.ts）：AI 决策 → 按决策拉取世界书 → 观察 → 一步更新 → 校验
 *   - 变量应用【复用原版 MVU 的命令解释器 updateVariables】（魔改原版：校验过的
 *     delta 回放给原版解释器，原版负责 VWD/schema/display_data 等全部语义）
 *   - 每次运行全链路细节写入调试日志（getWorkflowDebugLogs，面板展示）
 *
 * v3（相对 v2 本地 dueFields 调度）：
 *   - 候选范围改由 AI 自主决策（decide 阶段带剧情上下文 + 变量索引清单），
 *     不再用本地正则从规则里猜——AI 决策什么，世界书就拉取相应的。
 *   - 世界书在决策【之后】才按需拉取：活跃世界书 → 名字启发式 → 全量回退，
 *     规则与背景都按 AI 决策路径裁剪，绝不全量喂给模型。
 *   - 模型调用：有更新 2 次（decide + update），无更新 1 次（decide 后 no_change）；
 *     应用恰好一次。
 *
 * 本文件依赖 tavern-helper 全局（已通过 slash-runner/@types 声明），仅作运行时接入，不纳入单测。
 * 纯逻辑部分（请求构造/决策解析/投影/校验/工作流编排/规则分拣）均有独立单测。
 */

import {
    parseDecidePaths,
    runAgentWorkflow,
    AgentWorkflowResult,
    PreparedOps,
} from '@/innovation/agent_workflow';
import {
    buildAgentUpdateRawConfig,
    buildAgentUpdateTask,
    buildDecideRawConfig,
    buildDecideTask,
    createJsonPatchResponseSchema,
    normalizeGenerateText,
} from '@/innovation/agent_request';
import {
    pickUpdateWorldbookNames,
    selectRelevantLore,
    selectUpdateRules,
    splitRulePlotEntries,
} from '@/innovation/agent_worldbook';
import { updateVariables } from '@/function/update_variables';
import { loadInnovationSettings } from '@/innovation/settings';
import { useDataStore } from '@/store';

/** 最近一次工作流结果（供面板显示） */
let last_workflow_result: AgentWorkflowResult | null = null;

export function getLastWorkflowResult(): AgentWorkflowResult | null {
    return last_workflow_result;
}

// ---------------------------------------------------------------------------
// 调试日志（供 DEBUG 面板展示每次运行的全链路细节）
// ---------------------------------------------------------------------------

/** 世界书扫描详情（按需读取的每一级） */
export interface WorldbookScanDetail {
    /** 全部世界书数量 */
    total_names: number;
    /** 活跃世界书名（全局+角色+聊天绑定） */
    active_names: string[];
    /** 实际加载了内容的世界书名 */
    loaded_names: string[];
    /** 加载到的条目总数 */
    loaded_entries: number;
    /** [mvu_update] 规则条目数 */
    rules_matched: number;
    /** [mvu_plot] 剧情条目数 */
    plot_matched: number;
    /** 是否发生了回退读取（活跃集无规则） */
    fell_back: boolean;
}

/** 单次模型调用详情 */
export interface UpdateCallDetail {
    attempt: number;
    /** 本次调用是否尝试了结构化输出（json_schema） */
    structured: boolean;
    /** 模型输出块（截断预览） */
    block_preview: string;
    /** 模型原始输出（截断预览） */
    raw_preview: string;
    duration_ms: number;
    /** 喂回给模型的失败原因（第 2 次起） */
    fed_error?: string;
}

/** 决策调用详情 */
export interface DecideCallDetail {
    /** 决策输出（截断预览） */
    text_preview: string;
    /** 解析出的决策路径数 */
    parsed_count: number;
    duration_ms: number;
}

/** 一次工作流运行的完整调试记录 */
export interface WorkflowDebugEntry {
    id: number;
    ts: number;
    duration_ms: number;
    termination: string;
    stages: string[];
    retries: number;
    error?: string;
    decide: DecideCallDetail | null;
    worldbook: WorldbookScanDetail | null;
    due: string[] | null;
    observation: { paths: string[]; folded: number } | null;
    updates: UpdateCallDetail[];
    validation_errors: string[];
    applied: boolean;
}

const DEBUG_LOG_MAX = 50;
const workflow_debug_log: WorkflowDebugEntry[] = [];
let debug_seq = 0;

/** 调试日志（最新在前） */
export function getWorkflowDebugLogs(): WorkflowDebugEntry[] {
    return [...workflow_debug_log];
}

function pushDebugEntry(entry: WorkflowDebugEntry): void {
    workflow_debug_log.unshift(entry);
    if (workflow_debug_log.length > DEBUG_LOG_MAX) {
        workflow_debug_log.length = DEBUG_LOG_MAX;
    }
}

function preview(text: string, max = 200): string {
    const t = String(text ?? '').trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
}

// ---------------------------------------------------------------------------
// 状态与剧情上下文
// ---------------------------------------------------------------------------

/** 从当前消息提取「当前变量状态」对象（供观察层投影） */
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
            const name =
                typeof m.name === 'string' && m.name
                    ? m.name
                    : m.role === 'user'
                      ? 'user'
                      : 'assistant';
            lines.push(`${name}: ${m.message.trim()}`);
        }
        let text = lines.join('\n');
        if (text.length > max_chars) text = text.slice(0, max_chars) + '\n…（剧情过长已截断）';
        return text;
    } catch {
        return '';
    }
}

// ---------------------------------------------------------------------------
// 世界书按需读取（先读「正在用的」，规则不够再回退）
// ---------------------------------------------------------------------------

async function loadWorldbookEntries(name: string): Promise<any[]> {
    try {
        const wb = await getWorldbook(name);
        return Array.isArray(wb) ? wb : [];
    } catch {
        return [];
    }
}

/**
 * 收集「正在使用的」世界书名（全局 + 角色绑定 + 聊天绑定）——
 * 这是按需读取的第一级：不加载未在用的世界书。
 */
function collectActiveWorldbookNames(all_names: string[]): string[] {
    const active = new Set<string>();
    try {
        for (const name of getGlobalWorldbookNames()) {
            if (name) active.add(name);
        }
    } catch {
        /* ignore */
    }
    try {
        const char = getCharWorldbookNames('current');
        if (char?.primary) active.add(char.primary);
        for (const name of char?.additional ?? []) {
            if (name) active.add(name);
        }
    } catch {
        /* ignore */
    }
    try {
        const chat = getChatWorldbookName('current');
        if (chat) active.add(chat);
    } catch {
        /* ignore */
    }
    return all_names.filter(name => active.has(name));
}

/**
 * 读取世界书上下文（按需三级读取），并按 AI 决策路径裁剪：
 *   一级：活跃世界书（全局+角色+聊天绑定）
 *   二级（活跃集无 [mvu_update] 规则）：剩余中名字含 mvu/update/变量 的
 *   三级（仍无规则）：全部剩余
 * 规则与背景都只取与决策路径相关的（不会一股子喂给模型），并记录扫描详情（供调试面板）。
 * @param paths AI 决策的变量路径（裁剪依据）
 */
async function readWorldbookContext(paths: string[]): Promise<{
    rules: string[];
    lore: string[];
    scan: WorldbookScanDetail;
}> {
    const all_names: string[] = (() => {
        try {
            return getWorldbookNames();
        } catch {
            return [];
        }
    })();
    const active_names = collectActiveWorldbookNames(all_names);
    const loaded_names: string[] = [];
    const loaded_entries: any[] = [];
    let fell_back = false;

    const loadAndSplit = async (names: string[]) => {
        for (const name of names) {
            if (loaded_names.includes(name)) continue;
            loaded_names.push(name);
            loaded_entries.push(...(await loadWorldbookEntries(name)));
        }
        return splitRulePlotEntries(loaded_entries);
    };

    let { rules, plot, others } = await loadAndSplit(active_names);

    // 活跃集无规则 → 逐级回退（先名字启发式，再全量）
    if (rules.length === 0) {
        const remaining = all_names.filter(name => !loaded_names.includes(name));
        if (remaining.length > 0) {
            fell_back = true;
            const heuristic = pickUpdateWorldbookNames(remaining);
            const picked = await loadAndSplit(heuristic);
            rules = picked.rules;
            plot = picked.plot;
            others = picked.others;
        }
        if (rules.length === 0) {
            const rest = all_names.filter(name => !loaded_names.includes(name));
            const picked = await loadAndSplit(rest);
            rules = picked.rules;
            plot = picked.plot;
            others = picked.others;
        }
    }

    // 按 AI 决策路径裁剪：规则（无匹配回退全量但限总长）+ 背景（≤3 条）
    const rule_contents = selectUpdateRules([...rules], paths).entries;
    const lore_entries = [...plot, ...others];
    const lore = selectRelevantLore(lore_entries, paths);
    const scan: WorldbookScanDetail = {
        total_names: all_names.length,
        active_names,
        loaded_names,
        loaded_entries: loaded_entries.length,
        rules_matched: rules.length,
        plot_matched: plot.length,
        fell_back,
    };
    // lore 已按决策路径挑选（≤3 条）
    return { rules: rule_contents, lore, scan };
}

// ---------------------------------------------------------------------------
// 模型输出解析
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 应用层（复用原版 updateVariables）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 工作流入口
// ---------------------------------------------------------------------------

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
            decide: null,
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

    // ---- 调试日志载体 ----
    const entry: WorkflowDebugEntry = {
        id: ++debug_seq,
        ts: Date.now(),
        duration_ms: 0,
        termination: 'running',
        stages: [],
        retries: 0,
        decide: null,
        worldbook: null,
        due: null,
        observation: null,
        updates: [],
        validation_errors: [],
        applied: false,
    };
    const workflow_started = Date.now();

    const executor = {
        // 阶段1 AI 自主决策：基于（剧情 + 变量索引清单）决定本轮更新哪些变量。
        // 决策只输出路径清单，不产出更新块——世界书在此阶段【之后】才按需拉取。
        decide: async (input: { story: string; index: string }, last_error?: string) => {
            const call_started = Date.now();
            const task = buildDecideTask({ story: input.story, index: input.index, last_error });
            const config = buildDecideRawConfig({ task, custom_api });
            const text = normalizeGenerateText(await generateRaw(config));
            entry.decide = {
                text_preview: preview(text, 400),
                parsed_count: parseDecidePaths(text).length,
                duration_ms: Date.now() - call_started,
            };
            return { text, raw: text };
        },
        // 阶段2 按 AI 决策路径拉取世界书相应规则+背景：
        // 按需三级读取（活跃 → 名字启发式 → 全量回退），规则与背景都按决策路径裁剪，零模型调用
        fetchRules: async (paths: string[]) => {
            const ctx = await readWorldbookContext(paths);
            entry.worldbook = ctx.scan;
            return {
                entries: ctx.rules,
                raw: ctx.rules.join('\n---\n'),
                lore: ctx.lore,
            };
        },
        // 阶段4 一步 agent 回合：基于（剧情+观察+规则+背景）产出 delta。
        // 首选结构化输出（json_schema，ST 自动按 provider 转换：OpenAI → response_format，
        // Claude → 强制工具调用）；provider 不支持时降级纯文本指令。
        update: async (ctx: { story: string; observation: string; rules: string[]; lore: string[] }, last_error?: string) => {
            const attempt = entry.updates.length + 1;
            const call_started = Date.now();
            let structured = true;
            let result: unknown;
            try {
                const config = buildAgentUpdateRawConfig({
                    task: buildAgentUpdateTask({
                        story: ctx.story,
                        observation: ctx.observation,
                        rules: ctx.rules,
                        lore: ctx.lore,
                        last_error,
                        structured: true,
                    }),
                    custom_api,
                    json_schema: createJsonPatchResponseSchema(),
                });
                result = await generateRaw(config);
            } catch {
                // 降级：纯文本指令（模型输出 <UpdateVariable> 块）
                structured = false;
                const fallback_config = buildAgentUpdateRawConfig({
                    task: buildAgentUpdateTask({
                        story: ctx.story,
                        observation: ctx.observation,
                        rules: ctx.rules,
                        lore: ctx.lore,
                        last_error,
                    }),
                    custom_api,
                });
                result = await generateRaw(fallback_config);
            }
            const text = normalizeGenerateText(result);
            const structured_block = wrapStructuredPatch(text);
            const block = structured_block ?? extractUpdateBlock(text);
            entry.updates.push({
                attempt,
                structured,
                block_preview: preview(block),
                raw_preview: preview(text, 400),
                duration_ms: Date.now() - call_started,
                fed_error: last_error,
            });
            return { block, raw: text };
        },
        // 阶段5 应用：回放给原版 updateVariables
        apply: async (prepared: PreparedOps) => {
            const result = await applyPreparedOps(prepared);
            entry.applied = result.applied;
            return result;
        },
    };

    const workflow_result = await runAgentWorkflow(executor, { state, story }, {
        maxRetries: Math.max(1, settings.maxSteps - 1),
        loopThreshold: settings.loopThreshold,
    });
    last_workflow_result = workflow_result;

    // ---- 收尾：补全调试日志 ----
    entry.duration_ms = Date.now() - workflow_started;
    entry.termination = workflow_result.termination;
    entry.stages = workflow_result.stages;
    entry.retries = workflow_result.retries;
    entry.error = workflow_result.error;
    entry.due = workflow_result.due;
    entry.observation = workflow_result.observation
        ? { paths: workflow_result.observation.paths, folded: workflow_result.observation.folded }
        : null;
    entry.validation_errors = workflow_result.selfCheck?.ok
        ? []
        : workflow_result.selfCheck?.reason
          ? [workflow_result.selfCheck.reason]
          : [];
    pushDebugEntry(entry);

    if (workflow_result.termination === 'error') {
        console.error('[革新版·Agent工作流] 失败', workflow_result.error);
    } else {
        console.debug(
            `[革新版·Agent工作流] 阶段=${workflow_result.stages.join('→')} 终止=${workflow_result.termination} 模型调用=${(entry.decide ? 1 : 0) + entry.updates.length}次（决策${entry.decide ? 1 : 0}+更新${entry.updates.length}）`
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
