/**
 * [革新版·独立世界书规则读取] 纯逻辑模块。
 *
 * 革新版自己读取世界书规则，不依赖 MVU 的 filter_entries / is_extra_model_supported。
 * 通过 tavern-helper 底层 getWorldbook / getWorldbookNames 等获取世界书条目，
 * 这里只做纯逻辑筛选（可单测）：从条目中挑出 [mvu_update] 相关规则，并尽可能按需裁剪。
 *
 * 设计要点（对齐「读取相应规则」）：
 *   - 只保留含 [mvu_update] 标记的条目（更新规则），丢弃 [mvu_plot] 剧情条目（非本阶段职责）。
 *   - 若提供了「需要更新的变量路径」，优先保留内容中出现这些路径的条目；若都匹配不到，
 *     回退为全部 [mvu_update] 条目（保守可用）。
 *   - 单条过长时按 char 上限截断，避免撑爆上下文。
 */

/** 更新规则条目标记 */
export const INNOVATION_UPDATE_REGEX = /\[mvu_update\]/i;
/** 剧情条目标记（革新版本阶段不读） */
export const INNOVATION_PLOT_REGEX = /\[mvu_plot\]/i;

/** 世界书条目（tavern-helper WorldbookEntry 的最小形状） */
export interface WorldbookEntryLike {
    uid?: number;
    name?: string;
    enabled?: boolean;
    content?: string;
    comment?: string;
    world?: string;
    /** 激活策略（灯效状态）：constant=蓝灯常驻，selective=绿灯按关键词激活，vectorized=向量 */
    strategy?: {
        type?: string;
        keys?: (string | RegExp)[];
    };
}

/** 读取结果 */
export interface WorldbookRulesResult {
    /** 命中的规则条目内容 */
    entries: string[];
    /** 总条目数（诊断） */
    total: number;
    /** 被 [mvu_update] 命中的条目数 */
    matched: number;
    /** 是否因无路径匹配而回退到全量 */
    fell_back: boolean;
}

/** 默认单条内容截断长度 */
export const DEFAULT_MAX_ENTRY_LENGTH = 8000;

/**
 * 判断条目是否为更新规则条目。
 */
export function isUpdateRuleEntry(entry: WorldbookEntryLike): boolean {
    const content = String(entry.content ?? '');
    return INNOVATION_UPDATE_REGEX.test(content);
}

/**
 * 判断条目是否为剧情条目（本阶段应排除）。
 */
export function isPlotEntry(entry: WorldbookEntryLike): boolean {
    const content = String(entry.content ?? '');
    return INNOVATION_PLOT_REGEX.test(content);
}

/**
 * 判断条目标题/内容是否与某个变量路径相关（宽松包含匹配）。
 * @param entry 条目
 * @param path 变量路径（如 'stat_data.理.好感度'）
 */
export function entryMentionsPath(entry: WorldbookEntryLike, path: string): boolean {
    const text = `${entry.name ?? ''}\n${entry.content ?? ''}\n${entry.comment ?? ''}`;
    if (!text) return false;
    const trimmed = String(path).trim();
    if (!trimmed) return false;
    // 路径各段（取最长段做包含匹配，容忍路径写法差异）
    const segments = trimmed.split(/[.，,、/]/).map(s => s.trim()).filter(s => s.length >= 1);
    return segments.some(seg => text.includes(seg));
}

/**
 * 从世界书条目中筛选「相应规则」。
 * @param entries tavern-helper 返回的世界书条目
 * @param paths 检查阶段判定的需要更新变量路径（可空）
 * @param max_entry_length 单条截断长度
 */
export function selectUpdateRules(
    entries: WorldbookEntryLike[],
    paths: string[] = [],
    max_entry_length: number = DEFAULT_MAX_ENTRY_LENGTH
): WorldbookRulesResult {
    const total = entries.length;
    // 1. 只保留 [mvu_update] 条目
    const update_entries = entries.filter(isUpdateRuleEntry);
    const matched = update_entries.length;

    if (update_entries.length === 0) {
        return { entries: [], total, matched, fell_back: false };
    }

    let chosen = update_entries;
    let fell_back = false;
    if (paths.length > 0) {
        // 2. 优先保留与某路径相关的条目
        const relevant = update_entries.filter(entry =>
            paths.some(path => entryMentionsPath(entry, path))
        );
        if (relevant.length > 0) {
            chosen = relevant;
        } else {
            // 无匹配 → 回退全量
            fell_back = true;
        }
    }

    const entries_out = chosen
        .map(entry => String(entry.content ?? '').trim())
        .filter(Boolean)
        .map(content =>
            content.length > max_entry_length ? content.slice(0, max_entry_length) : content
        );

    return { entries: entries_out, total, matched, fell_back };
}

/**
 * 从 tavern-helper 世界书名称列表推算出需要加载的世界书清单。
 * @param names tavern-helper getWorldbookNames() 返回的名称
 */
export function pickUpdateWorldbookNames(names: string[]): string[] {
    return names.filter(name => /mvu|update|变量/i.test(String(name ?? '')));
}

/**
 * 把已加载条目分成三类（「先读世界书，再读更新规则」的两级读取分拣）：
 *   - rules：更新规则条目（[mvu_update]）
 *   - plot：剧情条目（[mvu_plot]，作 Agent 的世界背景）
 *   - others：其它启用条目（无标记，也作背景候选）
 * 禁用的条目（enabled === false）一律不进任何一类。
 * @param entries 世界书条目
 */
export function splitRulePlotEntries(
    entries: WorldbookEntryLike[]
): { rules: WorldbookEntryLike[]; plot: WorldbookEntryLike[]; others: WorldbookEntryLike[] } {
    const rules: WorldbookEntryLike[] = [];
    const plot: WorldbookEntryLike[] = [];
    const others: WorldbookEntryLike[] = [];
    for (const entry of entries) {
        if (entry.enabled === false) continue;
        if (isUpdateRuleEntry(entry)) {
            rules.push(entry);
        } else if (isPlotEntry(entry)) {
            plot.push(entry);
        } else {
            others.push(entry);
        }
    }
    return { rules, plot, others };
}

/**
 * 挑选与候选路径相关的背景条目（剧情/其他），作为 Agent 的世界上下文。
 * 「世界书读了再读更新规则」：背景只取与本次更新相关的，控制 token 成本。
 * @param entries 背景候选（plot + others）
 * @param paths 本轮候选路径
 * @param max_entries 最多保留条数（默认 3）
 * @param max_entry_length 单条截断长度（默认 2000）
 * @returns 截断后的条目内容
 */
export function selectRelevantLore(
    entries: WorldbookEntryLike[],
    paths: string[],
    max_entries: number = 3,
    max_entry_length: number = 2000
): string[] {
    if (paths.length === 0) return [];
    const relevant = entries.filter(entry => paths.some(path => entryMentionsPath(entry, path)));
    return relevant
        .slice(0, max_entries)
        .map(entry => {
            const name = String(entry.name ?? '').trim();
            let content = String(entry.content ?? '').trim();
            if (content.length > max_entry_length) {
                content = content.slice(0, max_entry_length) + '…';
            }
            return name ? `${name}：${content}` : content;
        })
        .filter(Boolean);
}
