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
    buildAgentUpdateRawConfig,    buildAgentUpdateTask,
    buildDecideRawConfig,
    buildDecideTask,
    createJsonPatchResponseSchema,
    normalizeGenerateText,
} from '@/innovation/agent_request';
import {
    pickUpdateWorldbookNames,
    splitRulePlotEntries,
} from '@/innovation/agent_worldbook';
import {
    buildWorldbookPool,
    parseAiClassification,
    poolQueryLoreByPaths,
    poolQueryRulesByPaths,
    AiByIndex,
    WorldbookPool,
} from '@/innovation/agent_worldbook_pool';
import { updateVariables } from '@/function/update_variables';
import { getLastValidVariable } from '@/util';
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
    /** 是否发生了回退读取（绑定集无规则 → 名字启发式） */
    fell_back: boolean;
    /** 扫描耗时 ms（本地读取+分拣；命中缓存时为 0） */
    duration_ms: number;
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

/** 缓存池详情（供调试面板） */
export interface PoolDebugDetail {
    /** 入池条目总数 */
    entries: number;
    /** 规则条目数 */
    rules: number;
    /** 灯效状态分布（蓝灯/绿灯/向量） */
    strategy: { constant: number; selective: number; vectorized: number };
    /** 是否已合并 AI 语义分池 */
    aiMerged: boolean;
    /** AI 规则分池耗时 ms（逐条阅读规则条目） */
    aiDurationMs: number;
    /** AI 分池成功批数/总批数 */
    aiBatchesOk: number;
    aiBatchesTotal: number;
    /** 索引统计（rulePaths 规则路径 / rulePathToRules 精确映射） */
    indexStats: { rulePaths: number; rulePathToRules: number };
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
    candidates: string[] | null;
    candidateSource: { from_rules: number; from_story: number } | null;
    worldbook: WorldbookScanDetail | null;
    pool: PoolDebugDetail | null;
    due: string[] | null;
    observation: { paths: string[]; folded: number } | null;
    updates: UpdateCallDetail[];
    validation_errors: string[];
    applied: boolean;
    /** 本轮搜索到的背景条目数（按相关性打分，不固定 3 条） */
    loreCount: number;
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
// 世界书缓存池（初始化分类 + 灯效状态索引，之后每轮直接查池）
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
 * 收集「正在使用的」世界书名（角色绑定 primary/additional + 聊天绑定 + 全局）——
 * 只读这些，不扫描全部世界书。
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

/** 缓存池状态（池 + 扫描详情；key 变化或超 TTL 才重建） */
interface PoolState {
    key: string;
    builtAt: number;
    pool: WorldbookPool;
    scan: WorldbookScanDetail;
    /** AI 规则分池耗时 ms（逐条阅读规则条目；失败为 0） */
    aiDurationMs: number;
    /** AI 分池是否已尝试过（失败不重复打） */
    aiAttempted: boolean;
    /** AI 分池成功批数 */
    aiBatchesOk: number;
    /** AI 分池总批数 */
    aiBatchesTotal: number;
    /** 原始加载条目（已过滤：enabled 且 content 非空；供 AI 分池时重建池） */
    rawEntries: any[];
}

let pool_state: PoolState | null = null;
let pool_loading = false;
const POOL_TTL_MS = 10 * 60_000;

/** 面板：缓存池是否正在加载 */
export function isWorldbookPoolLoading(): boolean {
    return pool_loading;
}

/** 面板：当前缓存池状态（未加载返回 null） */
export function getWorldbookPoolState(): (PoolDebugDetail & {
    builtAt: number;
    loaded_names: string[];
}) | null {
    if (!pool_state) return null;
    return {
        builtAt: pool_state.builtAt,
        loaded_names: pool_state.scan.loaded_names,
        entries: pool_state.pool.entries.length,
        rules: pool_state.pool.rules.length,
        strategy: { ...pool_state.pool.strategyCount },
        aiMerged: pool_state.pool.aiMerged,
        aiDurationMs: pool_state.aiDurationMs,
        aiBatchesOk: pool_state.aiBatchesOk,
        aiBatchesTotal: pool_state.aiBatchesTotal,
        indexStats: { ...pool_state.pool.indexStats },
    };
}

function poolKey(active_names: string[], fallback_names: string[]): string {
    let chat_id = '';
    try {
        chat_id = String(SillyTavern.getCurrentChatId() ?? '');
    } catch {
        /* ignore */
    }
    return `${chat_id}|${active_names.join(',')}|${fallback_names.join(',')}`;
}

/**
 * AI 规则分池（v1.10.2）：让模型【逐条阅读】[mvu_update] 规则条目，输出每条规则
 * 管辖/关联的变量路径——散文式规则（正则抓不到 `_.set`）的路径映射由 AI 语义确定。
 *
 * 现实依据：卡作者只写 [mvu_update] 标记，普通背景条目不写标记——AI 分池只瞄准
 * 规则条目（通常几条到几十条 = 1-3 批、几秒）；背景条目不 AI 分池
 * （绿灯 keys + 文本兜底足够，AI 语义归属对 ≤3 条辅助背景的收益不抵成本）。
 *
 * 下标约定：entries 必须是【已过滤】的可用条目（enabled !== false 且 content 非空），
 * AI 输出序号 = 该数组下标（buildWorldbookPool 内部经 indexMap 映射，防错位）。
 * @param entries 已过滤的可用条目（tavern-helper 形状）
 * @returns { byIndex, batchesOk, batchesTotal, durationMs }；全批失败返回 null
 */
const AI_CLASSIFY_BATCH = 15;

async function aiClassifyEntries(
    entries: any[]
): Promise<{ byIndex: AiByIndex; batchesOk: number; batchesTotal: number; durationMs: number } | null> {
    if (entries.length === 0) return null;
    // 只取 [mvu_update] 规则条目（idx 保持全局下标）
    const targetIndexes: number[] = [];
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const text = `${String(e.name ?? '')}\n${String(e.content ?? '')}`;
        if (/\[mvu_update\]/i.test(text)) targetIndexes.push(i);
    }
    if (targetIndexes.length === 0) return null;

    const started = Date.now();
    const byIndex: AiByIndex = new Map();
    let batchesOk = 0;
    const batchesTotal = Math.ceil(targetIndexes.length / AI_CLASSIFY_BATCH);

    for (let b = 0; b < batchesTotal; b++) {
        const batchIndexes = targetIndexes.slice(b * AI_CLASSIFY_BATCH, (b + 1) * AI_CLASSIFY_BATCH);
        const lines = batchIndexes
            .map(
                idx =>
                    `[${idx}] name=${String(entries[idx].name ?? '')} content=${String(entries[idx].content ?? '').slice(0, 800)}`
            )
            .join('\n');
        const task = [
            '<must>',
            `以下是变量更新规则条目清单（第 ${b + 1}/${batchesTotal} 批，共 ${batchIndexes.length} 条）。`,
            '请【逐条阅读】每条规则，确定它管辖/关联的变量路径（相对于 stat_data，如 主角.境界）。',
            '输出 JSON 数组，元素与规则一一对应：',
            '[{"idx":0,"paths":["主角.境界"],"topic":"境界突破"},',
            ' {"idx":1,"paths":[],"topic":""}]',
            '要求：',
            '- idx 必须与规则序号一致，不得遗漏任何一条，不得编造不存在的规则。',
            '- paths 为规则管辖的变量路径；规则正文没写变量名的，凭语义推断管辖路径；',
            '  与变量无关给空数组 []。',
            '- 不要输出解释，只输出 JSON。',
            '</must>',
            '',
            '规则条目清单：',
            lines,
        ].join('\n');
        try {
            const config = buildDecideRawConfig({ task, max_tokens: 1500 });
            const text = normalizeGenerateText(await generateRaw(config));
            const parsed = parseAiClassification(text, batchIndexes.length);
            if (parsed) {
                for (const [local_idx, paths] of parsed) {
                    const global_idx = batchIndexes[local_idx];
                    if (global_idx !== undefined) byIndex.set(global_idx, paths);
                }
                batchesOk++;
            }
        } catch {
            /* 本批失败：跳过继续，不影响其余批 */
        }
    }

    if (batchesOk === 0) return null;
    return { byIndex, batchesOk, batchesTotal, durationMs: Date.now() - started };
}

/** AI 规则分池：让模型逐条阅读规则条目，重建池（合并规则路径精确层） */
async function classifyPoolWithAi(state: PoolState): Promise<PoolState> {
    if (state.pool.entries.length === 0) {
        return { ...state, aiAttempted: true };
    }
    const result = await aiClassifyEntries(state.rawEntries);
    if (!result) {
        return {
            ...state,
            aiAttempted: true,
            aiBatchesOk: 0,
            aiBatchesTotal: Math.ceil(state.rawEntries.length / AI_CLASSIFY_BATCH),
        };
    }
    const pool = buildWorldbookPool(state.rawEntries, { aiByIndex: result.byIndex });
    return {
        ...state,
        pool,
        aiDurationMs: result.durationMs,
        aiAttempted: true,
        aiBatchesOk: result.batchesOk,
        aiBatchesTotal: result.batchesTotal,
    };
}

/**
 * 初始化/获取世界书缓存池：
 *   1. 读世界书（绑定集 → 名字启发式唯一回退，不做全量回退）
 *   2. 过滤可用条目（enabled 且 content 非空——AI 分池与建池共用同一数组，保证下标对齐）
 *   3. 分好类别进池（规则/剧情/其他 + 灯效状态 + 正则索引）
 *   4. AI 规则分池：Agent 启用或手动加载时，让模型逐条阅读 [mvu_update] 规则条目
 *      （通常 1-3 批、几秒），补全散文规则的管辖路径；失败静默降级纯本地索引
 * 之后每轮工作流直接查池，不再重复读取世界书（池 TTL 10 分钟）。
 * @param force 强制重建（手动加载按钮）；AI 规则分池在 Agent 启用或手动加载时执行
 */
async function ensureWorldbookPool(force = false): Promise<PoolState> {
    const all_names: string[] = (() => {
        try {
            return getWorldbookNames();
        } catch {
            return [];
        }
    })();
    const active_names = collectActiveWorldbookNames(all_names);
    const fallback_names = pickUpdateWorldbookNames(
        all_names.filter(name => !active_names.includes(name))
    );
    const key = poolKey(active_names, fallback_names);
    const fresh =
        pool_state !== null &&
        pool_state.key === key &&
        Date.now() - pool_state.builtAt < POOL_TTL_MS;

    // 池已新鲜：仅当 Agent 已启用且 AI 规则分池未做过时补做（如预热时 Agent 未开）
    if (!force && fresh) {
        if (
            pool_state.pool.aiMerged ||
            pool_state.aiAttempted ||
            !loadInnovationSettings(localStorage).agentEnabled
        ) {
            return pool_state;
        }
        pool_loading = true;
        try {
            const classified = await classifyPoolWithAi(pool_state);
            pool_state = classified;
            return classified;
        } finally {
            pool_loading = false;
        }
    }

    pool_loading = true;
    try {
        const scanned_at = Date.now();
        const loaded_names: string[] = [];
        const loaded_entries: any[] = [];
        const loadInto = async (names: string[]) => {
            for (const name of names) {
                if (loaded_names.includes(name)) continue;
                loaded_names.push(name);
                loaded_entries.push(...(await loadWorldbookEntries(name)));
            }
        };

        await loadInto(active_names);
        let fell_back = false;
        // 绑定集无规则 → 名字启发式唯一回退
        if (splitRulePlotEntries(loaded_entries).rules.length === 0 && fallback_names.length > 0) {
            fell_back = true;
            await loadInto(fallback_names);
        }

        // 过滤可用条目：AI 分池与建池共用同一数组（下标对齐，杜绝禁用条目错位）
        const usable_entries = loaded_entries.filter(
            (e: any) => e?.enabled !== false && String(e?.content ?? '').trim().length > 0
        );

        // 本地分类建池（规则/剧情/其他 + 灯效状态 + 正则索引）
        const pool = buildWorldbookPool(usable_entries);
        let state: PoolState = {
            key,
            builtAt: Date.now(),
            pool,
            scan: {
                total_names: all_names.length,
                active_names,
                loaded_names,
                loaded_entries: loaded_entries.length,
                rules_matched: pool.rules.length,
                plot_matched: pool.entries.filter(e => e.marker === 'plot').length,
                fell_back,
                duration_ms: Date.now() - scanned_at,
            },
            aiDurationMs: 0,
            aiAttempted: false,
            aiBatchesOk: 0,
            aiBatchesTotal: Math.ceil(usable_entries.length / AI_CLASSIFY_BATCH),
            rawEntries: usable_entries,
        };
        pool_state = state;

        // AI 规则分池：Agent 启用或手动加载 → 让模型逐条阅读 [mvu_update] 规则条目
        if (loadInnovationSettings(localStorage).agentEnabled || force) {
            state = await classifyPoolWithAi(state);
            pool_state = state;
        }
        return state;
    } finally {
        pool_loading = false;
    }
}

/**
 * 进入卡/初次加载时预热缓存池（本地分类必做；AI 规则分池按 Agent 开关自动补做）。
 * 脚本加载与 CHAT_CHANGED 时调用，fire-and-forget。
 */
export function prewarmWorldbookPool(): Promise<PoolState | null> {
    try {
        return ensureWorldbookPool(false);
    } catch {
        return Promise.resolve(null);
    }
}

/** 手动加载缓存池（强制重建 + AI 语义分池）——面板「手动加载」按钮 */
export function loadWorldbookPoolNow(force = true): Promise<PoolState> {
    return ensureWorldbookPool(force);
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

    // 更新中提示（toastr 为 ST 全局；革新版自己的提示，不复用原版通知开关）
    try {
        toastr.info('革新版 Agent 变量更新中…', '[革新版·Agent]');
    } catch {
        /* toastr 不可用时忽略 */
    }

    const state = extractStateText(message_id);
    if (!state) {
        // 无变量状态可更新 → 记录一个 no_change
        last_workflow_result = {
            stages: [],
            rules: null,
            candidates: null,
            candidateSource: null,
            decide: null,
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
        candidates: null,
        candidateSource: null,
        worldbook: null,
        pool: null,
        due: null,
        observation: null,
        updates: [],
        validation_errors: [],
        applied: false,
        loreCount: 0,
    };
    const workflow_started = Date.now();

    const executor = {
        // 阶段0 读规则：从缓存池取全部 [mvu_update] 规则内容（零世界书读取，
        // 池已含分类/灯效索引/AI 深化路径；首次建池时初始化）
        readRules: async () => {
            const state = await ensureWorldbookPool();
            entry.worldbook = state.scan;
            entry.pool = {
                entries: state.pool.entries.length,
                rules: state.pool.rules.length,
                strategy: { ...state.pool.strategyCount },
                aiMerged: state.pool.aiMerged,
                aiDurationMs: state.aiDurationMs,
                aiBatchesOk: state.aiBatchesOk,
                aiBatchesTotal: state.aiBatchesTotal,
                indexStats: { ...state.pool.indexStats },
            };
            const contents = state.pool.rules.map(r => r.content);
            return {
                entries: contents,
                raw: contents.join('\n---\n'),
                lore: [],
                extraPaths: state.pool.rulePaths,
            };
        },
        // 阶段2 AI 决策：对启发式候选清单逐项 Y/N 判断（防偷懒）。
        // 候选已由本地启发式筛过（规则路径 ∪ AI 深化路径 ∪ 剧情命中），决策只能选候选内。
        decide: async (input: { story: string; candidates: string[] }, last_error?: string) => {
            const call_started = Date.now();
            const task = buildDecideTask({ story: input.story, candidates: input.candidates, last_error });
            const config = buildDecideRawConfig({ task, custom_api });
            const text = normalizeGenerateText(await generateRaw(config));
            entry.decide = {
                text_preview: preview(text, 400),
                parsed_count: parseDecidePaths(text, input.candidates).length,
                duration_ms: Date.now() - call_started,
            };
            return { text, raw: text };
        },
        // 阶段3 按 AI 决策路径裁剪规则 + 按候选全集搜索背景（零世界书读取）：
        // 规则先精确层（rulePathToRules 显式声明/AI 补全）再文本兜底；
        // 背景按相关性打分（绿灯 keys +3 / 内容段 +2 / 条目名 +1），分数>0 全取，
        // 条数 ≤10、总字符 ≤6000——要改什么就搜什么背景，不拍脑袋定 3 条
        fetchRules: async (paths: string[], story?: string, lorePaths?: string[]) => {
            const state = await ensureWorldbookPool();
            entry.worldbook = state.scan;
            const rules = poolQueryRulesByPaths(state.pool, paths);
            const lore = poolQueryLoreByPaths(state.pool, lorePaths ?? paths, story, {
                maxEntries: 10,
                maxTotalChars: 6000,
                maxEntryLength: 1000,
            });
            entry.loreCount = lore.length;
            return {
                entries: rules,
                raw: rules.join('\n---\n'),
                lore,
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
    entry.candidates = workflow_result.candidates;
    entry.candidateSource = workflow_result.candidateSource;
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
        try {
            toastr.error(
                `革新版 Agent 更新失败：${workflow_result.error ?? '未知错误'}`,
                '[革新版·Agent]'
            );
        } catch {
            /* toastr 不可用时忽略 */
        }
    } else if (workflow_result.termination === 'done' && entry.applied) {
        console.debug(
            `[革新版·Agent工作流] 阶段=${workflow_result.stages.join('→')} 终止=${workflow_result.termination} 模型调用=${(entry.decide ? 1 : 0) + entry.updates.length}次（决策${entry.decide ? 1 : 0}+更新${entry.updates.length}）`
        );
        try {
            toastr.success(
                `已更新 ${entry.due?.length ?? 0} 个变量（${entry.updates.length} 次模型调用）`,
                '[革新版·Agent]'
            );
        } catch {
            /* toastr 不可用时忽略 */
        }
    } else {
        console.debug(
            `[革新版·Agent工作流] 阶段=${workflow_result.stages.join('→')} 终止=${workflow_result.termination} 模型调用=${(entry.decide ? 1 : 0) + entry.updates.length}次（决策${entry.decide ? 1 : 0}+更新${entry.updates.length}）`
        );
    }
    return workflow_result;
}

/**
 * 手动重试最近一次更新（面板「重试最近一次更新」按钮）——
 * 走革新版工作流（决策→拉取→观察→更新→校验），不复用原版额外模型解析。
 */
export async function retryLastAgentWorkflow(): Promise<AgentWorkflowResult | null> {
    const message_id = getLastMessageId();
    if (message_id === null || message_id === undefined) return null;
    return runAgentWorkflowForMessage(message_id);
}

/**
 * 初始化革新版独立 Agent 工作流监听。
 * 自己监听 MESSAGE_RECEIVED，不复用 MVU 的 onMessageReceived；
 * 是否启用完全由革新版自身设置（agentEnabled）决定，不依赖原版 MVU 的更新方式配置。
 * 脚本加载（初次加载 MVU）与 CHAT_CHANGED（进入卡）时自动预热世界书缓存池。
 * @returns 停止函数
 */
export function initAgentWorkflowBridge(): () => void {
    const stops: Array<() => void> = [];
    const { stop } = eventOn(tavern_events.MESSAGE_RECEIVED, async (message_id: number) => {
        await runAgentWorkflowForMessage(message_id);
    });
    stops.push(stop);

    // 进入卡/初次加载 MVU：预热世界书缓存池（本地分类必做；AI 深化按 Agent 开关补做）
    void prewarmWorldbookPool();
    const { stop: stop_chat } = eventOn(tavern_events.CHAT_CHANGED, async () => {
        void prewarmWorldbookPool();
    });
    stops.push(stop_chat);

    return () => {
        stops.forEach(s => s());
    };
}
