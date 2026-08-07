/**
 * [革新版] 设置存储模块（纯逻辑，可单测）。
 *
 * 用 localStorage 持久化革新版实验设置，避免修改原版 store.ts 的 zod schema。
 * 存储键统一前缀 `nlkaleido:` 隔离。
 */

export interface InnovationSettings {
    /** Agent 更新（主模型流内工具调用）开关 */
    agentEnabled: boolean;
    /** 多步 Agent 循环最大步数 */
    maxSteps: number;
    /** 死循环熔断阈值（连续相同 delta 步数） */
    loopThreshold: number;
    /** 是否在 console 输出缓存命中度量 */
    cacheMetricsEnabled: boolean;
}

export const INNOVATION_DEFAULTS: InnovationSettings = Object.freeze({
    agentEnabled: false,
    maxSteps: 3,
    loopThreshold: 3,
    cacheMetricsEnabled: true,
});

const STORAGE_KEY = 'nlkaleido:innovation';

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.min(max, Math.max(min, Math.round(value)));
    }
    return fallback;
}

/** 解析存储值并合并默认值（容错） */
export function parseInnovationSettings(raw: unknown): InnovationSettings {
    if (!isPlainObject(raw)) return { ...INNOVATION_DEFAULTS };
    return {
        agentEnabled: raw.agentEnabled === true,
        maxSteps: clampInt(raw.maxSteps, INNOVATION_DEFAULTS.maxSteps, 1, 10),
        loopThreshold: clampInt(raw.loopThreshold, INNOVATION_DEFAULTS.loopThreshold, 2, 10),
        cacheMetricsEnabled: raw.cacheMetricsEnabled !== false,
    };
}

/** 从 localStorage 读取设置（解析失败回退默认） */
export function loadInnovationSettings(storage: Pick<Storage, 'getItem'>): InnovationSettings {
    try {
        const raw = storage.getItem(STORAGE_KEY);
        if (raw === null) return { ...INNOVATION_DEFAULTS };
        return parseInnovationSettings(JSON.parse(raw));
    } catch {
        return { ...INNOVATION_DEFAULTS };
    }
}

/** 写入设置到 localStorage */
export function saveInnovationSettings(
    storage: Pick<Storage, 'setItem'>,
    settings: InnovationSettings
): void {
    storage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/** 合并部分更新 */
export function updateInnovationSettings(
    current: InnovationSettings,
    patch: Partial<InnovationSettings>
): InnovationSettings {
    return { ...current, ...patch };
}
