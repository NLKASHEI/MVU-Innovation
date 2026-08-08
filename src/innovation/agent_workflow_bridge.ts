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

import { parseDecidePaths, runAgentWorkflow, AgentWorkflowResult, PreparedOps } from '@/innovation/agent_workflow';
import { isZodScript, parseZodSchemaPaths } from '@/innovation/agent_zod';
import { createCacheMetricsState, recordCacheUsage, CacheMetricsState } from '@/innovation/cache_metrics';
import {
    buildDecideMessages,
    buildMessagesRawConfig,
    buildUpdateMessages,
    buildDecideRawConfig,
    createAiClassifySchema,
    createJsonPatchResponseSchema,
    ChatMessage,
    DECIDE_MAX_TOKENS,
    normalizeGenerateText,
    UPDATE_MAX_TOKENS,
} from '@/innovation/agent_request';
import {
    pickUpdateWorldbookNames,
    splitRulePlotEntries,
    WorldbookEntryLike,
} from '@/innovation/agent_worldbook';
import {
    buildWorldbookPool,
    parseAiClassification,
    poolQueryLoreByPaths,
    poolQueryRulesByPaths,
    AiByIndex,
    AiMandatoryByIndex,
    PooledEntry,
    PoolIndexStats,
    PoolMarker,
    PoolStrategy,
    WorldbookPool,
} from '@/innovation/agent_worldbook_pool';
import { updateVariables } from '@/function/update_variables';
import { MVU_TOOL_DEFINITION } from '@/function/function_call';
import { getLastValidVariable, normalizeBaseURL } from '@/util';
import { loadInnovationSettings } from '@/innovation/settings';
import { useDataStore } from '@/store';

/** 最近一次工作流结果（供面板显示） */
let last_workflow_result: AgentWorkflowResult | null = null;

/** 跨轮上下文：上一轮更新摘要（喂回下一轮 decide/update 任务，解决「不看前一层输入」） */
let last_round_summary: string | null = null;

/**
 * 实时组装额外模型 API 配置（每次调用读取，切换配置立即生效）：
 * 复用原版 MVU「额外模型解析配置」——模型来源=自定义 时用独立 API（地址/密钥/模型/温度等），
 * 否则回退主插头（custom_api 不传）。修复 v1.12.8 前 custom_api 硬编码 undefined 的 bug。
 */
function buildExtraCustomApi(): Record<string, any> | undefined {
    try {
        const cfg = useDataStore().settings.额外模型解析配置;
        if (!cfg || cfg.模型来源 !== '自定义') return undefined;
        const unset_if_equal = (value: number, expected: number) =>
            value === expected ? 'unset' : value;
        return {
            apiurl: normalizeBaseURL(String(cfg.api地址 ?? '')),
            key: cfg.密钥,
            model: cfg.模型名称,
            max_tokens: cfg.最大回复token数,
            temperature: unset_if_equal(cfg.温度 ?? 1, 1),
            frequency_penalty: unset_if_equal(cfg.频率惩罚 ?? 0, 0),
            presence_penalty: unset_if_equal(cfg.存在惩罚 ?? 0, 0),
            top_p: unset_if_equal(cfg.top_p ?? 1, 1),
            top_k: unset_if_equal(cfg.top_k ?? 0, 0),
        };
    } catch {
        return undefined;
    }
}

/** 当前 API 来源描述（面板显示）：自定义（模型名）/ 与插头相同 */
function getCurrentApiSource(): string {
    const api = buildExtraCustomApi();
    return api ? `自定义 ${api.model ?? '未知模型'}` : '与插头相同';
}

/** 革新版自身模型调用的缓存命中统计（decide/update 的 usage，与面板原版统计分离） */
let innovation_cache: CacheMetricsState = createCacheMetricsState();

/** 记录一次革新版模型调用的 usage（provider 返回 prompt_cache_hit/miss_tokens） */
function recordInnovationUsage(result: unknown): void {
    try {
        const usage = (result as { usage?: unknown } | null)?.usage;
        if (usage) {
            innovation_cache = recordCacheUsage(innovation_cache, usage);
        } else {
            // 无 usage（如纯文本返回）也计入请求总数
            innovation_cache = recordCacheUsage(innovation_cache, undefined);
        }
    } catch {
        /* 度量失败不影响工作流 */
    }
}

/** 革新版模型调用缓存命中状态（供面板显示） */
export function getInnovationCacheMetrics(): CacheMetricsState {
    return innovation_cache;
}

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
    /** 完整输入提示词（DEBUG 面板） */
    fullTask: string;
    /** 完整模型输出（DEBUG 面板） */
    fullRaw: string;
    duration_ms: number;
    /** 喂回给模型的失败原因（第 2 次起） */
    fed_error?: string;
}

/** 决策调用详情 */
export interface DecideCallDetail {
    /** 决策输出（截断预览） */
    text_preview: string;
    /** 完整输入提示词（DEBUG 面板） */
    fullTask: string;
    /** 完整模型输出（DEBUG 面板） */
    fullRaw: string;
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
    /** AI 规则分池是否已尝试过（失败也置位，面板显示「尝试过（失败）」） */
    aiAttempted: boolean;
    /** AI 规则分池耗时 ms（逐条阅读规则条目） */
    aiDurationMs: number;
    /** AI 分池成功批数/总批数 */
    aiBatchesOk: number;
    aiBatchesTotal: number;
    /** 索引统计（rulePaths 规则路径 / rulePathToRules 精确映射） */
    indexStats: { rulePaths: number; rulePathToRules: number };
    /** ZOD 变量仓库：命中的脚本名与解析路径数 */
    zodScripts: string[];
    zodPathCount: number;
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
    /** 本轮模型调用 API 来源（自定义 模型名 / 与插头相同） */
    apiSource: string;
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

/** 列表预览放宽上限（完整内容在 fullTask/fullRaw，展开区不截断） */
const PREVIEW_BLOCK = 2000;
const PREVIEW_RAW = 4000;
const PREVIEW_TEXT = 2000;

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
    /** AI 分池是否已尝试过（失败也置位，面板显示「尝试过（失败）」） */
    aiAttempted: boolean;
    /** AI 分池最近一次尝试时间（失败后 AI_RETRY_MS 可自动重试，不永久放弃） */
    aiLastAttemptAt: number;
    /** AI 分池成功批数 */
    aiBatchesOk: number;
    /** AI 分池总批数 */
    aiBatchesTotal: number;
    /** ZOD 变量仓库：解析出的变量路径（作者声明，并入候选；AI 分池失败时兜底） */
    zodPaths: string[];
    /** ZOD 变量仓库：命中的脚本名 */
    zodScripts: string[];
    /** 原始加载条目（已过滤：enabled 且 content 非空；供 AI 分池时重建池） */
    rawEntries: any[];
}

/** AI 分池失败后的自动重试间隔 */
const AI_RETRY_MS = 10 * 60_000;

/** 持久化池（localStorage；不含 rawEntries——可从 entries 还原） */
interface PersistedPool {
    version: number;
    key: string;
    builtAt: number;
    entries: {
        name: string;
        content: string;
        marker: PoolMarker;
        strategy: PoolStrategy;
        keys: string[];
    }[];
    rulePaths: string[];
    mandatoryPaths: string[];
    rulePathToRules: [string, string[]][];
    strategyCount: { constant: number; selective: number; vectorized: number };
    aiMerged: boolean;
    indexStats: PoolIndexStats;
    scan: WorldbookScanDetail;
    aiDurationMs: number;
    aiAttempted: boolean;
    aiLastAttemptAt: number;
    aiBatchesOk: number;
    aiBatchesTotal: number;
    zodPaths?: string[];
    zodScripts?: string[];
}

const POOL_STORAGE_KEY = 'nlkaleido:worldbook_pool_v2';
/** 持久化池结构版本（v2：AI 细粒度强制标记；旧版粗粒度 mandatoryPaths 的池直接重建） */
const POOL_STORAGE_VERSION = 2;
/** 持久化池最多保留的卡数（LRU，按 builtAt 淘汰最旧） */
const POOL_STORAGE_MAX = 5;
/** 池 TTL：24h（进入同一卡/重载脚本直接读回持久化池，不重建） */
const POOL_TTL_MS = 24 * 60 * 60 * 1000;

let pool_state: PoolState | null = null;
let pool_loading = false;
/** 世界书 API 错误（池子没 API 时报错提示，不静默降级） */
let pool_error: string | null = null;

/** 面板：缓存池是否正在加载 */
export function isWorldbookPoolLoading(): boolean {
    return pool_loading;
}

/** 面板：当前缓存池状态（未加载返回 null） */
export function getWorldbookPoolState(): (PoolDebugDetail & {
    builtAt: number;
    loaded_names: string[];
    error: string | null;
}) | null {
    if (!pool_state) {
        return pool_error
            ? {
                  builtAt: 0,
                  loaded_names: [],
                  entries: 0,
                  rules: 0,
                  strategy: { constant: 0, selective: 0, vectorized: 0 },
                  aiMerged: false,
                  aiAttempted: false,
                  aiDurationMs: 0,                  aiBatchesOk: 0,
                  aiBatchesTotal: 0,
                  indexStats: { rulePaths: 0, rulePathToRules: 0 },
                  zodScripts: [],
                  zodPathCount: 0,
                  error: pool_error,
              }
            : null;
    }
    return {
        builtAt: pool_state.builtAt,
        loaded_names: pool_state.scan.loaded_names,
        entries: pool_state.pool.entries.length,
        rules: pool_state.pool.rules.length,
        strategy: { ...pool_state.pool.strategyCount },
        aiMerged: pool_state.pool.aiMerged,
        aiAttempted: pool_state.aiAttempted,
        aiDurationMs: pool_state.aiDurationMs,
        aiBatchesOk: pool_state.aiBatchesOk,
        aiBatchesTotal: pool_state.aiBatchesTotal,
        indexStats: { ...pool_state.pool.indexStats },
        zodScripts: pool_state.zodScripts ?? [],
        zodPathCount: (pool_state.zodPaths ?? []).length,
        error: pool_error,
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

// ---------------------------------------------------------------------------
// 池持久化（localStorage：进入同一卡/重载脚本直接读回，不重建不重复 AI 分池）
// ---------------------------------------------------------------------------

function loadPersistedPools(): Record<string, PersistedPool> {
    try {
        const raw = localStorage.getItem(POOL_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as { pools?: Record<string, PersistedPool> };
        return parsed?.pools && typeof parsed.pools === 'object' ? parsed.pools : {};
    } catch {
        return {};
    }
}

function savePersistedPool(state: PoolState): void {
    try {
        const pools = loadPersistedPools();
        const persisted: PersistedPool = {
            version: POOL_STORAGE_VERSION,
            key: state.key,
            builtAt: state.builtAt,
            entries: state.pool.entries.map(e => ({
                name: e.name,
                content: e.content,
                marker: e.marker,
                strategy: e.strategy,
                keys: e.keys,
            })),
            rulePaths: [...state.pool.rulePaths],
            mandatoryPaths: [...(state.pool.mandatoryPaths ?? [])],
            rulePathToRules: [...state.pool.rulePathToRules.entries()],
            strategyCount: { ...state.pool.strategyCount },
            aiMerged: state.pool.aiMerged,
            indexStats: { ...state.pool.indexStats },
            scan: state.scan,
            aiDurationMs: state.aiDurationMs,
            aiAttempted: state.aiAttempted,
            aiLastAttemptAt: state.aiLastAttemptAt,
            aiBatchesOk: state.aiBatchesOk,
            aiBatchesTotal: state.aiBatchesTotal,
            zodPaths: state.zodPaths,
            zodScripts: state.zodScripts,
        };
        pools[state.key] = persisted;
        // LRU 淘汰：保留 builtAt 最新的 POOL_STORAGE_MAX 个
        const keys = Object.keys(pools);
        if (keys.length > POOL_STORAGE_MAX) {
            keys
                .sort((a, b) => (pools[a]?.builtAt ?? 0) - (pools[b]?.builtAt ?? 0))
                .slice(0, keys.length - POOL_STORAGE_MAX)
                .forEach(k => delete pools[k]);
        }
        localStorage.setItem(POOL_STORAGE_KEY, JSON.stringify({ pools }));
    } catch (e) {
        console.warn('[革新版·Agent] 缓存池持久化失败', e);
    }
}

/** 从持久化池恢复内存态（rawEntries 从 entries 还原，供 AI 分池补做） */
function poolFromPersisted(p: PersistedPool): PoolState {
    const entries: PooledEntry[] = p.entries.map(e => ({
        name: e.name,
        content: e.content,
        marker: e.marker,
        strategy: e.strategy,
        keys: e.keys,
    }));
    const pool: WorldbookPool = {
        entries,
        rules: entries.filter(e => e.marker === 'rule'),
        rulePaths: [...p.rulePaths],
        mandatoryPaths: [...(p.mandatoryPaths ?? [])],
        rulePathToRules: new Map(p.rulePathToRules),
        strategyCount: { ...p.strategyCount },
        aiMerged: p.aiMerged,
        indexStats: { ...p.indexStats },
    };
    const rawEntries: WorldbookEntryLike[] = entries.map(e => ({
        name: e.name,
        content: e.content,
        enabled: true,
        strategy:
            e.strategy === 'selective' || e.strategy === 'vectorized'
                ? { type: e.strategy, keys: e.keys.map(k => k) }
                : { type: 'constant' },
    }));
    return {
        key: p.key,
        builtAt: p.builtAt,
        pool,
        scan: { ...p.scan, active_names: [...p.scan.active_names], loaded_names: [...p.scan.loaded_names] },
        aiDurationMs: p.aiDurationMs,
        aiAttempted: p.aiAttempted,
        aiLastAttemptAt: p.aiLastAttemptAt ?? 0,
        aiBatchesOk: p.aiBatchesOk,
        aiBatchesTotal: p.aiBatchesTotal,
        // ZOD 变量仓库：持久化缺失时留空，由 ensureWorldbookPool 读回后异步补扫（脚本变化也能跟上）
        zodPaths: p.zodPaths ?? [],
        zodScripts: p.zodScripts ?? [],
        rawEntries,
    };
}

/** 尝试从 localStorage 读回指定 key 的池（未过期且结构版本匹配） */
function loadPersistedPool(key: string): PoolState | null {
    const pools = loadPersistedPools();
    const persisted = pools[key];
    if (!persisted || persisted.version !== POOL_STORAGE_VERSION) return null;
    if (Date.now() - persisted.builtAt >= POOL_TTL_MS) return null;
    try {
        return poolFromPersisted(persisted);
    } catch {
        return null;
    }
}

/**
 * AI 规则分池（v1.11.4）：让模型【分批完整阅读】[mvu_update] 规则条目，输出每条规则
 * 管辖/关联的变量路径 + 细粒度强制标记（v1.12.1）——规则→路径映射全部由 AI 语义确定，无正则提取。
 *
 * 读取策略（对齐用户「一次读不完就慢慢读，分批次读」）：
 *   - 规则内容【完整】交给 AI（不截断 800；仅超过单条上限 8000 才截断，对齐原版条目上限）
 *   - 按【总字符预算】自适应分批：每批总字符 ≤ AI_CLASSIFY_BATCH_CHARS（默认 24000 ≈ 12k token），
 *     规则多/长时自动拆多批慢慢读
 *
 * 下标约定：entries 必须是【已过滤】的可用条目（enabled !== false 且 content 非空），
 * AI 输出序号 = 该数组下标（buildWorldbookPool 内部经 indexMap 映射，防错位）。
 * @param entries 已过滤的可用条目（tavern-helper 形状）
 * @returns { byIndex, mandatoryByIndex, batchesOk, batchesTotal, durationMs }；全批失败返回 null
 */
const AI_CLASSIFY_BATCH = 15;
/** 每批总字符预算（约 12k token；超出自动拆下一批慢慢读） */
const AI_CLASSIFY_BATCH_CHARS = 24_000;
/** 单条规则内容上限（对齐原版条目上限；超长才截断，其余完整读取） */
const AI_CLASSIFY_ENTRY_MAX = 8_000;

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

    // 自适应分批：按条数与总字符预算双上限（一次读不完就慢慢读）
    const batches: number[][] = [];
    let current: number[] = [];
    let current_chars = 0;
    for (const idx of targetIndexes) {
        const entry_chars =
            String(entries[idx].name ?? '').length + String(entries[idx].content ?? '').length;
        if (
            current.length > 0 &&
            (current.length >= AI_CLASSIFY_BATCH || current_chars + entry_chars > AI_CLASSIFY_BATCH_CHARS)
        ) {
            batches.push(current);
            current = [];
            current_chars = 0;
        }
        current.push(idx);
        current_chars += entry_chars;
    }
    if (current.length > 0) batches.push(current);

    const started = Date.now();
    const byIndex: AiByIndex = new Map();
    const mandatoryByIndex: AiMandatoryByIndex = new Map();
    let batchesOk = 0;
    const batchesTotal = batches.length;

    for (let b = 0; b < batches.length; b++) {
        const batchIndexes = batches[b];
        const lines = batchIndexes
            .map(idx => {
                const name = String(entries[idx].name ?? '');
                let content = String(entries[idx].content ?? '');
                if (content.length > AI_CLASSIFY_ENTRY_MAX) {
                    content = content.slice(0, AI_CLASSIFY_ENTRY_MAX) + '…（超长已截断）';
                }
                return `[${idx}] name=${name}\n${content}`;
            })
            .join('\n\n');
        const task = [
            '<must>',
            `以下是变量更新规则条目清单（第 ${b + 1}/${batchesTotal} 批，共 ${batchIndexes.length} 条）。`,
            '请【完整阅读】每条规则，确定它管辖/关联的变量路径（相对于 stat_data，如 主角.境界）。',
            '输出 JSON 数组，元素与规则一一对应：',
            '[{"idx":0,"paths":["主角.境界"],"mandatory":["主角.境界"],"topic":"境界突破"},',
            ' {"idx":1,"paths":[],"mandatory":[],"topic":""}]',
            '要求：',
            '- idx 必须与规则序号一致，不得遗漏任何一条，不得编造不存在的规则。',
            '- paths 为规则管辖的变量路径；规则正文没写变量名的，凭语义推断管辖路径；',
            '  与变量无关给空数组 []。',
            '- mandatory 为【该规则中明确标注 MANDATORY/必须/每轮/always】的管辖路径子集；',
            '  规则中某条路径被标注强制更新才列入，没有则给空数组 []（不得整条规则全标）。',
            '- 不要输出解释，只输出 JSON。',
            '</must>',
            '',
            '规则条目清单：',
            lines,
        ].join('\n');
        try {
            // 首选结构化输出（json_schema，解析成功率大增）；provider 不支持或解析失败时降级纯文本
            // API 来源跟随原版「额外模型解析配置」（模型来源=自定义时用独立 API）
            const custom_api = buildExtraCustomApi();
            const apply_batch = (text: string): boolean => {
                const parsed = parseAiClassification(text, batchIndexes.length);
                if (!parsed) return false;
                for (const [local_idx, paths] of parsed.paths) {
                    const global_idx = batchIndexes[local_idx];
                    if (global_idx !== undefined) byIndex.set(global_idx, paths);
                }
                for (const [local_idx, m] of parsed.mandatory) {
                    const global_idx = batchIndexes[local_idx];
                    if (global_idx !== undefined) mandatoryByIndex.set(global_idx, m);
                }
                return true;
            };
            // 1. json_schema 结构化
            let text = '';
            let applied = false;
            try {
                const config = buildDecideRawConfig({
                    task,
                    custom_api,
                    max_tokens: 2000,
                    json_schema: createAiClassifySchema(),
                });
                text = normalizeGenerateText(await generateRaw(config));
                applied = apply_batch(text);
            } catch (e) {
                console.warn('[革新版·Agent] AI 分池 json_schema 失败，降级文本', e);
            }
            // 2. 解析失败（模型输出不合 schema）→ 文本模式重试
            if (!applied) {
                try {
                    const fallback_config = buildDecideRawConfig({ task, custom_api, max_tokens: 2000 });
                    text = normalizeGenerateText(await generateRaw(fallback_config));
                    applied = apply_batch(text);
                } catch (e) {
                    console.warn('[革新版·Agent] AI 分池文本模式也失败', e);
                }
            }
            if (applied) {
                batchesOk++;
            } else {
                console.warn(
                    `[革新版·Agent] AI 分池批次 ${b + 1}/${batches.length} 输出无法解析（json_schema 与文本均失败），已跳过`
                );
            }
        } catch (e) {
            console.warn('[革新版·Agent] AI 分池批次异常', e);
        }
    }

    if (batchesOk === 0) return null;
    return { byIndex, mandatoryByIndex, batchesOk, batchesTotal, durationMs: Date.now() - started };
}

/** AI 规则分池：让模型分批完整阅读规则条目，重建池（合并规则路径精确层 + 细粒度强制标记） */
async function classifyPoolWithAi(state: PoolState): Promise<PoolState> {
    if (state.pool.entries.length === 0) {
        return { ...state, aiAttempted: true, aiLastAttemptAt: Date.now() };
    }
    const result = await aiClassifyEntries(state.rawEntries);
    if (!result) {
        return {
            ...state,
            aiAttempted: true,
            aiLastAttemptAt: Date.now(),
            aiBatchesOk: 0,
            aiBatchesTotal: Math.ceil(state.rawEntries.length / AI_CLASSIFY_BATCH),
        };
    }
    const pool = buildWorldbookPool(state.rawEntries, {
        aiByIndex: result.byIndex,
        aiMandatoryByIndex: result.mandatoryByIndex,
    });
    return {
        ...state,
        pool,
        aiDurationMs: result.durationMs,
        aiAttempted: true,
        aiLastAttemptAt: Date.now(),
        aiBatchesOk: result.batchesOk,
        aiBatchesTotal: result.batchesTotal,
    };
}

/** 扫描角色卡 TH 脚本，识别 ZOD 变量仓库脚本并解析出变量路径树（作者声明的权威变量仓库） */
async function scanZodScripts(): Promise<{ scriptNames: string[]; paths: string[] }> {
    const scriptNames: string[] = [];
    const paths: string[] = [];
    try {
        const visit = (node: any) => {
            if (!node) return;
            if (node.type === 'script' && typeof node.content === 'string') {
                if (isZodScript(node.content)) {
                    scriptNames.push(String(node.name ?? node.id ?? '未知'));
                    for (const p of parseZodSchemaPaths(node.content)) {
                        if (!paths.includes(p)) paths.push(p);
                    }
                }
            } else if (node.type === 'folder' && Array.isArray(node.scripts)) {
                node.scripts.forEach(visit);
            }
        };
        // 兼容同步/异步返回 + 多类型（ZOD 脚本可能在角色卡/全局/预设脚本树里）
        for (const type of ['character', 'global', 'preset'] as const) {
            const raw: any = getScriptTrees({ type });
            const trees: any[] = Array.isArray(raw) ? raw : ((await raw) as any[]) ?? [];
            trees.forEach(visit);
        }
    } catch (e) {
        console.warn('[革新版·Agent] ZOD 脚本扫描失败', e);
    }
    return { scriptNames, paths };
}

/**
 * 初始化/获取世界书缓存池（四级查找，尽量避免重建）：
 *   0. 内存池（key 匹配且未过期）
 *   1. 持久化池（localStorage，key 匹配且未过期——进入同一卡/重载脚本直接读回，
 *      不重建、不重复 AI 分池；多卡各存一份，LRU 上限 5）
 *   2. 读世界书重建（绑定集 → 名字启发式唯一回退）+ AI 规则分池，构建后持久化
 * 世界书 API 不可用（getWorldbookNames 抛错）时：能读回持久化池就用，否则
 * 明确 toastr 报错并记录 pool_error（不静默降级）。
 * @param force 强制重建（手动加载按钮，跳过持久化读回）；AI 规则分池在 Agent 启用或手动加载时执行
 */
async function ensureWorldbookPool(force = false): Promise<PoolState> {
    let all_names: string[] = [];
    let api_error: string | null = null;
    try {
        all_names = getWorldbookNames();
    } catch (e) {
        api_error = e instanceof Error ? e.message : String(e);
    }

    const active_names = collectActiveWorldbookNames(all_names);
    const fallback_names = pickUpdateWorldbookNames(
        all_names.filter(name => !active_names.includes(name))
    );
    const key = poolKey(active_names, fallback_names);

    // API 报错（池子没 API）
    if (api_error) {
        if (pool_error !== api_error) {
            pool_error = `世界书 API 不可用：${api_error}（请检查 TavernHelper 版本）`;
            try {
                toastr.error(pool_error, '[革新版·Agent]缓存池');
            } catch {
                /* toastr 不可用时忽略 */
            }
        }
        // 尽力读回持久化池（同 key 未过期）→ 仍可用
        const persisted = loadPersistedPool(key);
        if (persisted) {
            pool_state = persisted;
            return persisted;
        }
        return {
            key,
            builtAt: Date.now(),
            pool: buildWorldbookPool([]),
            scan: {
                total_names: 0,
                active_names,
                loaded_names: [],
                loaded_entries: 0,
                rules_matched: 0,
                plot_matched: 0,
                fell_back: false,
                duration_ms: 0,
            },
            aiDurationMs: 0,
            aiAttempted: true,
            aiLastAttemptAt: 0,
            aiBatchesOk: 0,
            aiBatchesTotal: 0,
            zodPaths: [],
            zodScripts: [],
            rawEntries: [],
        };
    }
    pool_error = null;

    const fresh =
        pool_state !== null &&
        pool_state.key === key &&
        Date.now() - pool_state.builtAt < POOL_TTL_MS;

    // AI 分池需要补做的判定：未合并 && Agent 启用 &&（未尝试过 || 距上次尝试超重试间隔）
    const should_retry_ai = (s: PoolState) =>
        !s.pool.aiMerged &&
        loadInnovationSettings(localStorage).agentEnabled &&
        (!s.aiAttempted || Date.now() - s.aiLastAttemptAt > AI_RETRY_MS);

    // 0. 内存池已新鲜：仅当 AI 规则分池需要补做时执行（如预热时 Agent 未开/失败后到重试窗口）
    if (!force && fresh) {
        if (!should_retry_ai(pool_state)) {
            return pool_state;
        }
        pool_loading = true;
        try {
            const classified = await classifyPoolWithAi(pool_state);
            pool_state = classified;
            savePersistedPool(classified);
            return classified;
        } finally {
            pool_loading = false;
        }
    }

    // 1. 持久化池读回（key 匹配未过期）——进入同一卡/重载脚本零重建
    if (!force) {
        const persisted = loadPersistedPool(key);
        if (persisted) {
            // ZOD 变量仓库缺失（旧池/首次）→ 异步补扫脚本
            if ((persisted.zodScripts ?? []).length === 0) {
                const zod = await scanZodScripts();
                persisted.zodPaths = zod.paths;
                persisted.zodScripts = zod.scriptNames;
            }
            pool_state = persisted;
            // AI 规则分池需要补做 → 补做（rawEntries 已还原；失败后到重试窗口自动再试）
            if (should_retry_ai(persisted)) {
                pool_loading = true;
                try {
                    const classified = await classifyPoolWithAi(persisted);
                    pool_state = classified;
                    savePersistedPool(classified);
                    return classified;
                } finally {
                    pool_loading = false;
                }
            }
            return persisted;
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
        // ZOD 变量仓库：扫描角色卡/全局/预设 TH 脚本，解析作者声明的变量路径（辅助候选，AI 分池失败时兜底）
        const zod = await scanZodScripts();
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
            aiLastAttemptAt: 0,
            aiBatchesOk: 0,
            aiBatchesTotal: Math.ceil(usable_entries.length / AI_CLASSIFY_BATCH),
            zodPaths: zod.paths,
            zodScripts: zod.scriptNames,
            rawEntries: usable_entries,
        };
        pool_state = state;

        // AI 规则分池：Agent 启用或手动加载 → 让模型逐条阅读 [mvu_update] 规则条目
        if (loadInnovationSettings(localStorage).agentEnabled || force) {
            state = await classifyPoolWithAi(state);
            pool_state = state;
        }
        savePersistedPool(state);
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
    // 额外模型 API 配置：每次调用实时读取原版「额外模型解析配置」
    // （模型来源=自定义 → 独立 API；否则主插头）——切换配置立即生效（v1.12.9 修复）
    // 多轮对话上下文：第一轮（决策）消息序列 + 决策输出——第二轮（更新）在同一对话里续
    let round_messages: ChatMessage[] = [];
    let decide_output: string | null = null;

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
        apiSource: '',
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
                aiAttempted: state.aiAttempted,
                aiDurationMs: state.aiDurationMs,
                aiBatchesOk: state.aiBatchesOk,
                aiBatchesTotal: state.aiBatchesTotal,
                indexStats: { ...state.pool.indexStats },
                zodScripts: state.zodScripts ?? [],
                zodPathCount: (state.zodPaths ?? []).length,
            };
            const contents = state.pool.rules.map(r => r.content);
            // 候选路径来源：AI 规则分池路径（ZOD 仓库路径改由核心兜底——仅候选为空时启用，
            // 避免 115 条 ZOD 路径每轮全量并入导致决策逐项判断 150+ 行拖慢速度）
            return {
                entries: contents,
                raw: contents.join('\n---\n'),
                lore: [],
                extraPaths: state.pool.rulePaths,
                zodPaths: state.zodPaths ?? [],
                mandatoryPaths: state.pool.mandatoryPaths,
            };
        },
        // 阶段2 AI 决策（第一轮，喂完整正文）：对启发式候选清单逐项 Y/N 判断。
        // 记录本轮消息序列（round_messages）——第二轮更新在同一对话里续，正文不重复喂。
        decide: async (
            input: { story: string; candidates: string[]; mandatory?: string[] },
            last_error?: string
        ) => {
            const call_started = Date.now();
            const custom_api = buildExtraCustomApi();
            entry.apiSource = getCurrentApiSource();
            round_messages = buildDecideMessages({
                story: input.story,
                candidates: input.candidates,
                mandatory: input.mandatory,
                lastRound: last_round_summary ?? undefined,
                last_error,
            });
            const config = buildMessagesRawConfig({
                messages: round_messages,
                custom_api,
                max_tokens: DECIDE_MAX_TOKENS,
            });
            const raw_result = await generateRaw(config);
            recordInnovationUsage(raw_result);
            const text = normalizeGenerateText(raw_result);
            decide_output = text;
            entry.decide = {
                text_preview: preview(text, PREVIEW_TEXT),
                fullTask: round_messages.map(m => `${m.role}：${m.content}`).join('\n\n'),
                fullRaw: text,
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
                // 背景按需给足（v2.0.2 恢复预算——收紧是倒退，世界观背景该给就给）
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
        // 阶段4 一步 agent 回合（第二轮，同一对话里续）：基于（上一轮决策 + 观察 + 规则 + 背景）
        // 产出 delta——正文在第一轮上下文里，不重复喂；启发式构建的背景在此轮追加。
        // 首选结构化输出（json_schema）；provider 不支持时降级纯文本指令。
        update: async (ctx: { story: string; observation: string; rules: string[]; lore: string[] }, last_error?: string) => {
            const attempt = entry.updates.length + 1;
            // 进入二阶段（更新）弹窗提醒，避免用户干等（决策可能耗时 30-40s）
            try {
                if (attempt === 1) {
                    toastr.info('决策完成，正在更新变量…', '[革新版·Agent]');
                } else {
                    toastr.warning(`校验未通过，正在重试（第 ${attempt} 次）…`, '[革新版·Agent]');
                }
            } catch {
                /* toastr 不可用时忽略 */
            }
            const call_started = Date.now();
            const custom_api = buildExtraCustomApi();
            // 跟随原版「额外模型解析配置.应答格式」：工具调用 → tools+tool_choice required；
            // 格式化输出/V4 → json_schema（ST 自动转换：OpenAI → response_format，Claude → 强制工具）
            const response_format = useDataStore().settings.额外模型解析配置.应答格式;
            const use_tool_call = response_format === '工具调用';
            let structured = true;
            let result: unknown;
            let messages: ChatMessage[] = [];
            try {
                messages = buildUpdateMessages({
                    prev: round_messages,
                    decideOutput: decide_output ?? '',
                    observation: ctx.observation,
                    rules: ctx.rules,
                    lore: ctx.lore,
                    last_error,
                    structured: true,
                });
                const config = buildMessagesRawConfig({
                    messages,
                    custom_api,
                    max_tokens: UPDATE_MAX_TOKENS,
                });
                if (use_tool_call) {
                    config.tools = [MVU_TOOL_DEFINITION];
                    config.tool_choice = 'required';
                } else {
                    config.json_schema = createJsonPatchResponseSchema();
                }
                result = await generateRaw(config);
            } catch {
                // 降级：同消息去掉 tools/json_schema（模型输出 <UpdateVariable> 块）
                structured = false;
                messages = buildUpdateMessages({
                    prev: round_messages,
                    decideOutput: decide_output ?? '',
                    observation: ctx.observation,
                    rules: ctx.rules,
                    lore: ctx.lore,
                    last_error,
                });
                const fallback_config = buildMessagesRawConfig({
                    messages,
                    custom_api,
                    max_tokens: UPDATE_MAX_TOKENS,
                });
                result = await generateRaw(fallback_config);
            }
            recordInnovationUsage(result);
            const text = normalizeGenerateText(result);
            const structured_block = wrapStructuredPatch(text);
            const block = structured_block ?? extractUpdateBlock(text);
            entry.updates.push({
                attempt,
                structured,
                block_preview: preview(block, PREVIEW_BLOCK),
                raw_preview: preview(text, PREVIEW_RAW),
                fullTask: messages.map(m => `${m.role}：${m.content}`).join('\n\n'),
                fullRaw: text,
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

    // ---- 跨轮上下文：记录本轮摘要，下一轮 decide/update 任务里喂回 ----
    // 解决「不看前一层输入」：模型知道上一轮更新了哪些变量、更新块是什么，
    // 避免重复改/漏改（如绝色榜「strictly avoid repeating recently used names」）。
    if (workflow_result.termination === 'done' && entry.applied && entry.due) {
        const applied_block =
            entry.updates.length > 0 ? entry.updates[entry.updates.length - 1].block_preview : '';
        last_round_summary = [
            `更新了 ${entry.due.length} 个变量：${entry.due.join('、')}`,
            applied_block ? `更新块：${applied_block}` : '',
            `时间：${new Date().toLocaleTimeString()}`,
        ]
            .filter(Boolean)
            .join('\n');
    } else if (workflow_result.termination === 'done') {
        last_round_summary = `上轮无实际更新（决策 ${entry.due?.length ?? 0} 个，未应用）`;
    } else if (workflow_result.termination === 'no_change') {
        last_round_summary = '上轮决策无变化（none）';
    } else {
        last_round_summary = `上轮终止：${workflow_result.termination}${
            workflow_result.error ? `（${workflow_result.error}）` : ''
        }`;
    }

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
