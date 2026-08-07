/**
 * [革新版·缓存率] 纯逻辑模块：缓存命中度量。
 *
 * 设计原则：
 *  - 零依赖（不 import store / util），纯函数，可直接单测。
 *  - 是否处于「额外模型解析」期间由调用方以布尔参数传入，
 *    避免本模块依赖 tavern_helper 全局类型与 store。
 *  - 读取 provider 返回的 usage.prompt_cache_hit_tokens / prompt_cache_miss_tokens。
 *    （DeepSeek/Kimi/GLM 等隐式前缀缓存渠道会返回；OpenAI 无缓存计费则不返回，跳过即可。）
 */

export interface CacheMetricsState {
    /** 已记录请求次数（含无 usage 返回的请求） */
    totalRequests: number;
    /** 有 usage 返回的请求次数 */
    measuredRequests: number;
    /** 累计命中的 prompt token 数 */
    hitTokens: number;
    /** 累计未命中的 prompt token 数 */
    missTokens: number;
    /** 最近一次命中的 prompt token 数 */
    lastHitTokens: number;
    /** 最近一次未命中的 prompt token 数 */
    lastMissTokens: number;
}

export function createCacheMetricsState(): CacheMetricsState {
    return {
        totalRequests: 0,
        measuredRequests: 0,
        hitTokens: 0,
        missTokens: 0,
        lastHitTokens: 0,
        lastMissTokens: 0,
    };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从任意层级的 usage 对象里取数字字段（兼容 usage 直接给或嵌在 event.data 里） */
function readUsageNumber(
    root: unknown,
    key: 'prompt_cache_hit_tokens' | 'prompt_cache_miss_tokens'
): number {
    if (!isPlainObject(root)) return 0;
    if (typeof root[key] === 'number') return root[key] as number;
    // 兼容嵌套：{ data: { usage: {...} } }
    const usage = root.usage;
    if (isPlainObject(usage) && typeof usage[key] === 'number') return usage[key] as number;
    return 0;
}

/**
 * 计算命中率。无可用数据返回 null。
 * @param state 缓存度量状态
 */
export function computeCacheHitRate(state: CacheMetricsState): number | null {
    const total = state.hitTokens + state.missTokens;
    if (total <= 0) return null;
    return state.hitTokens / total;
}

/**
 * 记录一次请求的 usage。
 * @param state 当前状态（不会被修改）
 * @param usage provider 返回的 usage 对象（可为 undefined/不含缓存字段）
 * @returns 更新后的新状态
 */
export function recordCacheUsage(state: CacheMetricsState, usage: unknown): CacheMetricsState {
    const next = { ...state };
    next.totalRequests += 1;
    const hit = readUsageNumber(usage, 'prompt_cache_hit_tokens');
    const miss = readUsageNumber(usage, 'prompt_cache_miss_tokens');
    if (hit > 0 || miss > 0) {
        next.measuredRequests += 1;
        next.hitTokens += hit;
        next.missTokens += miss;
        next.lastHitTokens = hit;
        next.lastMissTokens = miss;
    }
    return next;
}

/**
 * 处理一次 generation ended 事件。
 * @param state 当前状态
 * @param event_data ST 事件回调的第一个参数
 * @param is_during_extra_analysis 是否处于额外模型解析期间（由调用方从 store 读取）
 * @returns 更新后的新状态（原状态不被修改）；若不在额外模型解析期间则原样返回
 */
export function handleGenerationEndedEvent(
    state: CacheMetricsState,
    event_data: unknown,
    is_during_extra_analysis: boolean
): CacheMetricsState {
    if (!is_during_extra_analysis) return state;
    return recordCacheUsage(state, event_data);
}

export function formatCacheMetrics(state: CacheMetricsState): string {
    const rate = computeCacheHitRate(state);
    return (
        `[革新版·缓存] requests=${state.totalRequests} measured=${state.measuredRequests} ` +
        `hit=${state.hitTokens} miss=${state.missTokens} ` +
        `rate=${rate === null ? 'N/A' : `${(rate * 100).toFixed(1)}%`}`
    );
}
