/**
 * [革新版·世界书缓存池 v1.10.2] 初始化分类 + 规则语义索引（纯逻辑，零 MVU 依赖）。
 *
 * 现实依据（v1.10.2 修正）：卡作者只写 [mvu_update] 规则标记，普通背景条目不写标记——
 * AI 分池只瞄准【规则条目】（AI 逐条阅读规则，输出管辖路径，补全散文规则的路径映射）；
 * 背景条目不 AI 分池（绿灯 keys + 文本兜底足够，对 ≤3 条辅助背景的语义归属不抵成本）。
 *
 * 索引体系（每条都有语义依据、真实被查询）：
 *   1. rulePaths / rulePathToRules（精确层）
 *      依据：规则【显式声明】的路径（正则提取）∪ AI 阅读规则补全的管辖路径。
 *      用途：候选搜索路径来源；fetch 时决策路径精确命中直接取规则 O(1)。
 *   2. 背景相关性打分（启发机制）
 *      依据：条目自带的绿灯 keys（ST 激活语义）+ 内容/条目名与候选路径段的命中。
 *      用途：fetch 背景时按 候选路径全集 + 剧情 打分排序，要改什么就搜什么背景。
 *
 * 每轮工作流直接查池（不再重复读取世界书）。
 */

import {
    extractRulePaths,
    normalizePath,
} from '@/innovation/agent_workflow';
import { WorldbookEntryLike, isPlotEntry, isUpdateRuleEntry } from '@/innovation/agent_worldbook';

/** 条目类别 */
export type PoolMarker = 'rule' | 'plot' | 'other';

/** 灯效状态（激活策略） */
export type PoolStrategy = 'constant' | 'selective' | 'vectorized';

/** 入池条目（含分类与灯效元信息） */
export interface PooledEntry {
    name: string;
    content: string;
    marker: PoolMarker;
    strategy: PoolStrategy;
    /** selective（绿灯）条目的激活关键词（RegExp 转 source 字符串） */
    keys: string[];
}

/** 索引统计（面板展示「建了什么索引」） */
export interface PoolIndexStats {
    /** 规则声明的路径数（rulePaths，正则 + AI 分类） */
    rulePaths: number;
    /** 路径→规则 精确映射键数（rulePathToRules） */
    rulePathToRules: number;
}

/** 世界书缓存池 */
export interface WorldbookPool {
    /** 全部入池条目（enabled 的） */
    entries: PooledEntry[];
    /** 规则条目（[mvu_update]） */
    rules: PooledEntry[];
    /** 规则声明的变量路径（去重保序；正则提取 + AI 阅读规则补全） */
    rulePaths: string[];
    /** 精确索引：规则声明的路径（正则 + AI）→ 声明它的规则内容 */
    rulePathToRules: Map<string, string[]>;
    /** 池内各策略计数 */
    strategyCount: { constant: number; selective: number; vectorized: number };
    /** 是否已合并 AI 规则分池 */
    aiMerged: boolean;
    /** 索引统计 */
    indexStats: PoolIndexStats;
}

/**
 * AI 规则分池结果：AI 逐条阅读规则后确定的「规则条目输入下标 → 管辖变量路径」。
 * 下标 = 传入 buildWorldbookPool 的 entries 数组下标（内部经 indexMap 映射，防错位）。
 */
export type AiByIndex = Map<number, string[]>;

function strategyOf(entry: WorldbookEntryLike): PoolStrategy {
    const type = String(entry.strategy?.type ?? 'constant');
    if (type === 'selective' || type === 'vectorized') return type;
    return 'constant';
}

function keysOf(entry: WorldbookEntryLike): string[] {
    const keys = entry.strategy?.keys;
    if (!Array.isArray(keys)) return [];
    const out: string[] = [];
    for (const key of keys) {
        const text = key instanceof RegExp ? key.source : String(key ?? '').trim();
        if (text) out.push(text);
    }
    return out;
}

function normalizeAiPaths(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const normalized = normalizePath(item);
        if (normalized && !normalized.startsWith('_') && !out.includes(normalized)) {
            out.push(normalized);
        }
    }
    return out;
}

/**
 * 解析 AI 逐条分池输出（JSON 数组或 {"序号": [...]} 对象，容忍围栏/尾部逗号/单引号）。
 * @param raw 模型输出
 * @param count 本批条目数（序号必须在 [0, count) 内）
 * @returns 序号 → 路径清单；无法解析返回 null
 */
export function parseAiClassification(raw: string, count: number): Map<number, string[]> | null {
    if (!raw) return null;
    let text = String(raw).trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        const repaired = text
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/,\s*,/g, ',')
            .replace(/'/g, '"');
        try {
            parsed = JSON.parse(repaired);
        } catch {
            // 兜底：提取数组段（模型可能输出解释文字+数组）
            const arr_match = text.match(/\[[\s\S]*\]/);
            if (!arr_match) return null;
            try {
                parsed = JSON.parse(arr_match[0]);
            } catch {
                return null;
            }
        }
    }

    const map = new Map<number, string[]>();
    if (Array.isArray(parsed)) {
        // 数组：优先用显式 idx，缺省按顺序对齐
        for (let i = 0; i < parsed.length && i < count; i++) {
            const item = parsed[i];
            if (!item || typeof item !== 'object') continue;
            const rec = item as Record<string, unknown>;
            const idx = typeof rec.idx === 'number' ? rec.idx : i;
            if (!Number.isInteger(idx) || idx < 0 || idx >= count) continue;
            map.set(idx, normalizeAiPaths(rec.paths));
        }
    } else if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            const idx = Number(key);
            if (!Number.isInteger(idx) || idx < 0 || idx >= count) continue;
            map.set(idx, normalizeAiPaths(value));
        }
    } else {
        return null;
    }
    return map.size > 0 ? map : null;
}

/**
 * 把世界书条目分好类别并建立索引，产出缓存池。
 * aiByIndex 的序号 = 传入 entries 的【输入数组下标】（禁用/空条目被跳过，但下标语义
 * 按输入数组对齐——内部通过 indexMap 映射到池内下标，杜绝错位）。
 * @param entries 已加载的世界书条目（含禁用项，本函数跳过）
 * @param opts.aiByIndex AI 逐条分池结果（条目输入下标 → 关联路径）
 * @param opts.extraRulePaths 兼容参数：AI 分类的规则路径（并入 rulePaths）
 */
export function buildWorldbookPool(
    entries: WorldbookEntryLike[],
    opts?: { aiByIndex?: AiByIndex; extraRulePaths?: string[] }
): WorldbookPool {
    const pooled: PooledEntry[] = [];
    /** 输入下标 → 池内下标（禁用/空条目无映射） */
    const indexMap = new Map<number, number>();
    const rules: PooledEntry[] = [];
    const strategyCount = { constant: 0, selective: 0, vectorized: 0 };

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.enabled === false) continue;
        const content = String(entry.content ?? '').trim();
        if (!content) continue;
        const marker: PoolMarker = isUpdateRuleEntry(entry)
            ? 'rule'
            : isPlotEntry(entry)
              ? 'plot'
              : 'other';
        const strategy = strategyOf(entry);
        const keys = keysOf(entry);
        strategyCount[strategy]++;
        const item: PooledEntry = {
            name: String(entry.name ?? '').trim(),
            content,
            marker,
            strategy,
            keys,
        };
        indexMap.set(i, pooled.length);
        pooled.push(item);
        if (marker === 'rule') rules.push(item);
    }

    // 精确层：规则声明的路径（正则提取），建 路径→规则 映射
    const rulePaths: string[] = [];
    const rulePathToRules = new Map<string, string[]>();
    const addRulePath = (path: string, ruleContent: string) => {
        const normalized = normalizePath(path);
        if (!normalized || normalized.startsWith('_')) return;
        if (!rulePaths.includes(normalized)) rulePaths.push(normalized);
        const list = rulePathToRules.get(normalized) ?? [];
        if (!list.includes(ruleContent)) list.push(ruleContent);
        rulePathToRules.set(normalized, list);
    };
    for (const rule of rules) {
        for (const path of extractRulePaths([rule.content])) {
            addRulePath(path, rule.content);
        }
    }

    // AI 规则分池：AI 逐条阅读规则确定的管辖路径（按输入下标经 indexMap 映射，防错位）
    // 只作用于规则条目——背景条目不 AI 分池（绿灯 keys + 文本兜底足够）
    const aiByIndex = opts?.aiByIndex;
    if (aiByIndex && aiByIndex.size > 0) {
        for (const [input_idx, paths] of aiByIndex) {
            const pooled_idx = indexMap.get(input_idx);
            if (pooled_idx === undefined) continue;
            const entry = pooled[pooled_idx];
            if (!entry || entry.marker !== 'rule') continue;
            for (const path of paths) {
                const normalized = normalizePath(path);
                if (!normalized || normalized.startsWith('_')) continue;
                addRulePath(normalized, entry.content);
            }
        }
    }

    // 兼容参数：extraRulePaths 并入规则路径（无对应规则内容，仅供候选搜索）
    let aiMerged = false;
    if (aiByIndex && aiByIndex.size > 0) aiMerged = true;
    if (opts?.extraRulePaths && opts.extraRulePaths.length > 0) {
        for (const path of opts.extraRulePaths) {
            const normalized = normalizePath(path);
            if (normalized && !normalized.startsWith('_') && !rulePaths.includes(normalized)) {
                rulePaths.push(normalized);
            }
        }
        aiMerged = true;
    }

    return {
        entries: pooled,
        rules,
        rulePaths,
        rulePathToRules,
        strategyCount,
        aiMerged,
        indexStats: {
            rulePaths: rulePaths.length,
            rulePathToRules: rulePathToRules.size,
        },
    };
}

/** 池内路径段集（文本兜底层用） */
function pathSegments(path: string): string[] {
    return String(path)
        .replace(/\[(\d+|[^[\]]+)\]/g, '.$1')
        .replace(/^stat_data\./, '')
        .split('.')
        .map(s => s.trim())
        .filter(s => s.length > 0);
}

/** 路径是否命中某段文本（文本兜底层：最长段优先，同长取叶子段） */
function pathHitsText(path: string, text: string): boolean {
    const segments = pathSegments(path);
    if (segments.length === 0) return false;
    let best = segments[0];
    for (const seg of segments) {
        if (seg.length >= best.length) best = seg; // 同长取叶子段（更具体）
    }
    return best.length >= 2 && text.includes(best);
}

/**
 * 从池中按决策路径取规则子集（不会一股子全喂）：
 *   1. 精确层：决策路径命中规则声明的路径（正则提取 + AI 分类，O(1)）
 *   2. 文本兜底：规则内容提到决策路径段（散文式规则补漏）
 * @param pool 缓存池
 * @param paths AI 决策的变量路径
 */
export function poolQueryRulesByPaths(pool: WorldbookPool, paths: string[]): string[] {
    if (paths.length === 0) return [];
    const out: string[] = [];
    const push = (content: string) => {
        if (content && !out.includes(content)) out.push(content);
    };

    // 1. 精确层：rulePathToRules 精确命中（顺序 = 决策路径顺序）
    for (const path of paths) {
        const normalized = normalizePath(path);
        if (!normalized) continue;
        const rules_for_path = pool.rulePathToRules.get(normalized);
        if (rules_for_path) {
            for (const content of rules_for_path) push(content);
        }
    }

    // 2. 文本兜底：内容提到决策路径段
    for (const rule of pool.rules) {
        const hit = paths.some(path => pathHitsText(path, rule.content));
        if (hit) push(rule.content);
    }

    return out;
}

/** 背景查询选项 */
export interface LoreQueryOptions {
    /** 最多保留条数（默认 10——按相关性给，不拍脑袋定 3） */
    maxEntries?: number;
    /** 总字符预算（默认 6000，按分数顺序裁剪） */
    maxTotalChars?: number;
    /** 单条截断长度（默认 1000） */
    maxEntryLength?: number;
}

/** 背景条目相关性打分（启发机制：命中维度越多越相关） */
function scoreLoreEntry(entry: PooledEntry, paths: string[], story: string): number {
    let score = 0;
    // 绿灯 keys 命中（ST 激活语义）：+3
    if (
        entry.strategy === 'selective' &&
        entry.keys.some(
            key => key.length >= 2 && (story.includes(key) || paths.some(p => pathHitsText(p, key)))
        )
    ) {
        score += 3;
    }
    // 内容提到候选路径段：+2
    if (paths.some(path => pathHitsText(path, entry.content))) {
        score += 2;
    }
    // 条目名提到候选路径段：+1
    if (entry.name && paths.some(path => pathHitsText(path, entry.name))) {
        score += 1;
    }
    return score;
}

/**
 * 从池中按决策路径 + 剧情文本搜索世界书背景（剧情条目+其他）：
 *   启发机制：以【候选路径全集 + 剧情文本】为搜索关键词，按相关性打分
 *   （绿灯 keys 命中 +3 / 内容段命中 +2 / 条目名命中 +1），分数 > 0 的全部返回，
 *   按分数排序、条数上限与总字符预算裁剪——要改什么，就搜什么背景。
 * @param pool 缓存池
 * @param paths 背景搜索关键词（候选全集：决策路径 ∪ 剧情命中路径）
 * @param story 最近剧情文本（绿灯 keys 扫描源）
 * @param opts 数量/预算控制
 */
export function poolQueryLoreByPaths(
    pool: WorldbookPool,
    paths: string[],
    story?: string,
    opts?: LoreQueryOptions
): string[] {
    if (paths.length === 0 && !story) return [];
    const max_entries = Math.max(1, opts?.maxEntries ?? 10);
    const max_total_chars = Math.max(1, opts?.maxTotalChars ?? 6000);
    const max_entry_length = Math.max(1, opts?.maxEntryLength ?? 1000);
    const story_text = story ? String(story) : '';

    // 打分排序
    const scored: Array<{ entry: PooledEntry; score: number }> = [];
    for (const entry of pool.entries) {
        if (entry.marker === 'rule') continue;
        const score = scoreLoreEntry(entry, paths, story_text);
        if (score > 0) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score);

    // 按分数顺序取，条数 + 总字符预算双上限
    const out: string[] = [];
    let total = 0;
    for (const { entry } of scored) {
        if (out.length >= max_entries) break;
        const name = entry.name ? `${entry.name}：` : '';
        let content = entry.content;
        if (content.length > max_entry_length) content = content.slice(0, max_entry_length) + '…';
        const line = `${name}${content}`;
        if (total + line.length > max_total_chars) break;
        total += line.length;
        out.push(line);
    }
    return out;
}
