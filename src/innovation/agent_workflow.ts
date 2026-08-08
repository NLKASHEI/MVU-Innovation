/**
 * [革新版·Agent 工作流 v3] AI 自主决策 → 按需拉取 → 一步更新（纯逻辑，零 MVU 依赖）。
 *
 * 对齐用户要求的 agent 化顺序：「AI 自主先决策改什么，再读什么，拉取世界书相应的」：
 *   阶段1 决策（decide）       ：AI 基于（最近剧情 + 变量索引清单）自主决定本轮更新哪些变量
 *   阶段2 拉取（fetch_rules）  ：按 AI 决策的路径，拉取世界书并裁剪出相应规则 + 背景（零模型调用）
 *   阶段3 观察（observe）     ：对决策路径做状态投影（截断/折叠/只暴露决策字段）
 *   阶段4 更新（update）      ：一步 agent 回合——模型基于（剧情+观察+规则+背景）产出 delta，应用一次
 *   阶段5 校验（validate）    ：JSON Patch 语法容错（§4.8 下放）→ 权力边界校验（以 AI 决策路径为准）→ 失败原因喂回重试
 *
 * 与 v2（读规则→本地 dueFields→观察→更新）的差异：
 *   - 候选范围不再由本地正则从规则里猜（可能猜错/漏），而是 AI 自主决策——AI 有剧情上下文，
 *     且能看到全部变量索引（路径清单），决策范围不受规则文本写法限制。
 *   - 世界书在决策【之后】才按需拉取：只拉「正在用的」世界书（活跃集），
 *     且规则/背景都按 AI 决策路径裁剪——不会把世界书一股子喂给模型。
 *   - 模型调用：有更新时 2 次（decide + update），无更新时 1 次（decide 后 no_change）。
 *     应用恰好一次，重试只发生在校验失败时（失败原因喂回）。
 *
 * 模型调用与变量应用全部通过 executor 注入，本模块可独立单测。
 */

/** 工作流阶段 */
export type WorkflowStage =
    | 'read_rules'
    | 'candidate_search'
    | 'decide'
    | 'fetch_rules'
    | 'observe'
    | 'update'
    | 'validate';

/** 终止原因 */
export type AgentWorkflowTermination =
    | 'done'
    | 'no_change'
    | 'max_retries'
    | 'loop_broken'
    | 'error';

/** 阶段2 拉取到的规则集（按 AI 决策路径裁剪后的产物） */
export interface RuleSet {
    /** 规则内容（世界书 [mvu_update] 条目正文，已按决策路径裁剪） */
    entries: string[];
    raw: string;
    /** 世界书背景条目（[mvu_plot] 等，已按决策路径挑选） */
    lore?: string[];
    /** AI 深化分类补全的规则路径（世界书缓存池产出，供候选搜索并入） */
    extraPaths?: string[];
}

/** 阶段3 观察层投影结果（§3.6 下放） */
export interface Observation {
    /** 投影出的字段路径（状态中实际存在的候选） */
    paths: string[];
    /** 投影文本（供 Agent 请求） */
    text: string;
    /** 被折叠的字段数 */
    folded: number;
}

/** 阶段1 决策结果 */
export interface DecideResult {
    /** 模型决策文本（候选逐项 Y/N 判断，供解析器提炼 paths） */
    text: string;
    raw: string;
}

/** 启发式候选搜索来源统计 */
export interface CandidateSource {
    /** 来自规则声明的路径数 */
    from_rules: number;
    /** 来自剧情命中的路径数 */
    from_story: number;
}

/** 阶段4 更新上下文 */
export interface UpdateContext {
    /** 最近剧情文本（桥接层从聊天消息提取） */
    story: string;
    /** 观察层投影文本 */
    observation: string;
    /** 与决策路径相关的规则子集 */
    rules: string[];
    /** 与决策路径相关的世界书背景（世界书读了再读更新规则） */
    lore: string[];
    /** 本轮决策路径（AI 决策范围） */
    due: string[];
}

/** 阶段4 更新结果 */
export interface UpdateResult {
    /** 模型产出的 <UpdateVariable> 块（空 = 明确无更新） */
    block: string;
    raw: string;
}

/** 校验通过后交给执行器应用的 ops */
export interface PreparedOps {
    /** 命令方言解析结果（fullMatch 可原样回放） */
    commands: ParsedCommand[];
    /** JSON Patch 方言解析结果（已 sanitize） */
    patch: PatchOp[] | null;
}

/** 解析出的单条更新命令 */
export interface ParsedCommand {
    /** 命令类型（set/insert/assign/remove/unset/delete/add） */
    type: string;
    /** 原始命令文本（含分号与注释，供原样回放） */
    fullMatch: string;
    /** 参数0（变量路径，已去引号/已归一化） */
    path: string;
    /** 全部参数原始串 */
    args: string[];
    /** 行尾注释（//原因） */
    reason: string;
}

/** JSON Patch 方言操作（对齐 MVU 方言：replace/delta/insert/add/remove/move） */
export interface PatchOp {
    op: 'replace' | 'delta' | 'insert' | 'add' | 'remove' | 'move';
    path: string;
    value?: unknown;
    from?: string;
    to?: string;
}

/** 阶段5 校验结果 */
export interface SelfCheckResult {
    ok: boolean;
    reason?: string;
}

/** 工作流执行器（桥接层实现，注入真实模型调用与变量应用） */
export interface AgentWorkflowExecutor {
    /** 阶段0：本地读取全部 [mvu_update] 规则内容（世界书，零模型调用，带缓存） */
    readRules(): Promise<RuleSet>;
    /** 阶段1：AI 在启发式候选清单内逐项决策——输出「哪些候选要更新」 */
    decide(
        input: { story: string; candidates: string[] },
        lastError?: string
    ): Promise<DecideResult>;
    /**
     * 阶段3：按 AI 决策路径裁剪世界书规则 + 按候选全集搜索背景（本地，零模型调用）。
     * @param paths AI 决策的变量路径（规则裁剪依据）
     * @param story 最近剧情文本（背景相关性搜索源）
     * @param lorePaths 背景搜索关键词全集（候选：决策路径 ∪ 剧情命中路径）
     */
    fetchRules(paths: string[], story?: string, lorePaths?: string[]): Promise<RuleSet>;
    /** 阶段5：一步 agent 回合——基于（剧情+观察+规则+背景）产出 delta。失败原因可喂回重试 */
    update(ctx: UpdateContext, lastError?: string): Promise<UpdateResult>;
    /** 阶段6：应用校验通过的 ops 到真实变量；返回是否实际修改 */
    apply(prepared: PreparedOps): Promise<{ applied: boolean; errors?: string[] }>;
}

/** 工作流结果 */
export interface AgentWorkflowResult {
    /** 实际经历的阶段序列（诊断用） */
    stages: WorkflowStage[];
    rules: RuleSet | null;
    candidates: string[] | null;
    candidateSource: CandidateSource | null;
    decide: DecideResult | null;
    due: string[] | null;
    observation: Observation | null;
    update: UpdateResult | null;
    prepared: PreparedOps | null;
    selfCheck: SelfCheckResult | null;
    termination: AgentWorkflowTermination;
    /** 总重试次数（阶段6校验失败重试） */
    retries: number;
    /** 总耗时 ms */
    elapsed_ms: number;
    error?: string;
}

/** 工作流配置 */
export interface AgentWorkflowOptions {
    /** 阶段6校验失败的最大重试次数（≥1） */
    maxRetries: number;
    /** 连续相同失败判定阈值（≥2 生效；连续 N 次相同失败原因 → 熔断） */
    loopThreshold: number;
    /** 观察层单值长度上限（默认 300） */
    maxValueLen?: number;
    /** 观察层最大字段数（超出折叠，默认 60） */
    maxFields?: number;
    /** 启发式候选上限（默认 80） */
    maxCandidates?: number;
}

// ---------------------------------------------------------------------------
// 路径工具（lodash-free）
// ---------------------------------------------------------------------------

/** 'a.b[0].c' / 'a[0].c' / 'stat_data.理.好感度' → 段数组 */
export function splitPath(path: string): string[] {
    return String(path)
        .replace(/\[(\d+|[^[\]]+)\]/g, '.$1')
        .replace(/^stat_data\./, '')
        .replace(/['"]/g, '')
        .split('.')
        .map(s => s.trim())
        .filter(s => s.length > 0);
}

/** 路径归一化：去掉 stat_data. 前缀 */
export function normalizePath(path: string): string {
    return splitPath(path).join('.');
}

/** 判断路径是否存在于对象 */
export function hasPath(obj: unknown, path: string): boolean {
    if (obj == null) return false;
    const segments = splitPath(path);
    if (segments.length === 0) return false;
    let cur: unknown = obj;
    for (const seg of segments) {
        if (cur == null || typeof cur !== 'object') return false;
        cur = (cur as Record<string, unknown>)[seg];
    }
    return cur !== undefined;
}

/** 取路径值 */
export function getPathValue(obj: unknown, path: string): unknown {
    if (obj == null) return undefined;
    const segments = splitPath(path);
    let cur: unknown = obj;
    for (const seg of segments) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
}

// ---------------------------------------------------------------------------
// 阶段0-1 启发式候选搜索 + 决策：本地缩小范围，模型逐项判断（防偷懒）
// ---------------------------------------------------------------------------

/**
 * 枚举 stat_data 的叶子路径（跳过 $ 内部字段）。
 * @param state stat_data 对象
 */
export function enumerateLeafPaths(state: unknown): string[] {
    const paths: string[] = [];
    const walk = (obj: unknown, prefix: string) => {
        if (obj == null || typeof obj !== 'object') return;
        for (const [key, value] of Object.entries(obj)) {
            if (key.startsWith('$')) continue; // 跳过 $internal 等内部字段
            const path = prefix ? `${prefix}.${key}` : key;
            if (value != null && typeof value === 'object' && !Array.isArray(value)) {
                walk(value, path);
            } else {
                paths.push(path);
            }
        }
    };
    walk(state, '');
    return paths;
}

/**
 * 生成紧凑的「变量索引」文本（决策阶段兜底用）。
 * 只列路径名（不列值），超限折叠为摘要行。
 * @param state stat_data 对象
 * @param max_paths 索引上限（默认 200）
 */
export function buildVariableIndex(state: unknown, max_paths: number = 200): string {
    const lines: string[] = [];
    const all = enumerateLeafPaths(state);
    for (const path of all) {
        if (lines.length < max_paths) lines.push(path);
    }
    if (lines.length === 0) return '';
    let text = lines.join('\n');
    const hidden = all.length - lines.length;
    if (hidden > 0) {
        text += `\n…（另有 ${hidden} 个变量未列出）`;
    }
    return text;
}

/**
 * 启发式搜索「本轮候选变量」（零模型调用，保证效率与准确度）：
 *   1. 规则路径：**AI 规则分池给出的管辖路径**（worldbook_pool 产物，经 extraPaths 传入；
 *      v1.11.4 起无正则提取——规则→路径映射全部由 AI 分批完整读取产生）
 *   2. 剧情命中：剧情文本包含变量路径的最长段（如剧情出现「好感度」→ 候选 理.好感度）
 * 合并去重后返回候选清单；模型必须在候选内决策（候选 = 可见范围，防越权）。
 * @param state stat_data 对象
 * @param story 最近剧情文本
 * @param rule_paths AI 分池给出的规则管辖路径
 * @returns 候选清单与来源统计
 */
export function searchCandidates(
    state: unknown,
    story: string,
    rule_paths: string[],
    opts: { maxCandidates?: number; minSegmentLen?: number } = {}
): { candidates: string[]; from_rules: number; from_story: number } {
    const max_candidates = Math.max(1, opts.maxCandidates ?? 80);
    const min_segment_len = opts.minSegmentLen ?? 2;
    const candidates: string[] = [];
    const push = (path: string) => {
        const normalized = normalizePath(path);
        if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
    };

    // 1. AI 分池给出的规则路径（先入，保序优先）——必须真实存在于 stat_data：
    //    防 AI 编造/旧数据残留污染候选清单
    for (const path of rule_paths) {
        const normalized = normalizePath(path);
        if (!normalized) continue;
        if (getPathValue(state, normalized) === undefined) continue;
        push(normalized);
    }
    const from_rules = candidates.length;

    // 2. 剧情命中：路径段出现在剧情中（取最长段；同长取叶子段——叶子更具体，
    //    避免「主角」这类公共前缀把全部 主角.* 拉进候选）
    if (story) {
        const story_text = String(story);
        for (const path of enumerateLeafPaths(state)) {
            if (candidates.length >= max_candidates) break;
            if (candidates.includes(path)) continue;
            const segments = splitPath(path);
            let best = segments[0];
            for (const seg of segments) {
                if (seg.length >= best.length) best = seg; // 同长取后者（叶子段）
            }
            if (best && best.length >= min_segment_len && story_text.includes(best)) {
                push(path);
            }
        }
    }

    const from_story = Math.max(0, candidates.length - from_rules);
    return { candidates: candidates.slice(0, max_candidates), from_rules, from_story };
}

const DECIDE_NONE_RE = /^(?:none|no|nothing|无|无需|无变化|不更新|都不需要|没有|0)$/i;

/**
 * 解析 AI 决策文本，提炼「要更新的变量路径」清单。
 * 支持：
 *   - 每行 `路径: Y/N`（Y 需要更新，N 跳过；逐项判断格式，防偷懒）
 *   - 每行 `- 路径` / 裸路径（决策清单上下文视为需要更新）
 *   - 整行 `none / 无 / 无变化` → 无更新（v1 曾把 none 误当路径的 bug 已修）
 * @param raw 模型决策文本
 * @param allowed 候选清单；模型写了候选之外的路径会被丢弃（权力边界）
 * @returns 决策路径数组（去重保序，且限于候选内）
 */
export function parseDecidePaths(raw: string, allowed?: string[]): string[] {
    if (!raw) return [];
    const paths: string[] = [];
    const push = (path: string) => {
        const normalized = normalizePath(path);
        if (!normalized || paths.includes(normalized)) return;
        if (allowed && !allowed.includes(normalized)) return; // 越权路径丢弃
        paths.push(normalized);
    };
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // 整行「无更新」声明 → 清空并短路（防止把 none 当路径）
        if (DECIDE_NONE_RE.test(trimmed) || DECIDE_NONE_RE.test(trimmed.replace(/^[-*•]\s*/, ''))) {
            return [];
        }
        // `路径: Y` / `路径 : Y` / `路径：Y`
        const judge = trimmed.match(/^(.+?)\s*[:：]\s*(Y|N|YES|NO|y|n|是|否)\s*$/i);
        if (judge) {
            const path = judge[1].trim();
            const verdict = judge[2].toUpperCase();
            if (path && (verdict === 'Y' || verdict === 'YES' || verdict === '是')) {
                push(path);
            }
            continue;
        }
        // `- 路径` 或裸路径
        const bare = trimmed.replace(/^[-*•]\s*/, '').trim();
        if (
            bare &&
            !/^(决策|清单|Check|List|更新|变量|需要|以下|本轮|建议|Update|Decide)/i.test(bare)
        ) {
            push(bare);
        }
    }
    // 去重保序（兜底）
    return paths;
}

/** 过滤出与候选路径相关的规则子集（字符串版，避免把全量规则塞进请求） */
export function filterRelevantRules(rules: string[], paths: string[]): string[] {
    if (paths.length === 0) return [];
    return rules.filter(rule => {
        if (!rule) return false;
        return paths.some(path => {
            // 取最长路径段做宽松包含匹配，容忍写法差异
            const segments = splitPath(path);
            const key = segments
                .map(s => s.trim())
                .filter(Boolean)
                .sort((a, b) => b.length - a.length)[0];
            return key ? rule.includes(key) : false;
        });
    });
}

/**
 * 过滤出与候选路径相关的世界书背景条目（「世界书读了再读更新规则」：
 * 背景只取相关的，控制 token 成本）。
 * @param lore 世界书背景条目内容（RuleSet.lore）
 * @param paths 本轮候选路径
 * @param max_entries 最多保留条数（默认 3）
 * @param max_entry_length 单条截断长度（默认 2000）
 */
export function filterRelevantLore(
    lore: string[],
    paths: string[],
    max_entries: number = 3,
    max_entry_length: number = 2000
): string[] {
    if (paths.length === 0) return [];
    const relevant = lore.filter(entry => {
        if (!entry) return false;
        return paths.some(path => {
            const segments = splitPath(path);
            const key = segments
                .map(s => s.trim())
                .filter(Boolean)
                .sort((a, b) => b.length - a.length)[0];
            return key ? entry.includes(key) : false;
        });
    });
    return relevant
        .slice(0, max_entries)
        .map(entry =>
            entry.length > max_entry_length ? entry.slice(0, max_entry_length) + '…' : entry
        );
}

// ---------------------------------------------------------------------------
// 阶段3 观察层 observe：状态投影 + 可见性控制（§3.6 下放）
// ---------------------------------------------------------------------------

export interface ObservationOptions {
    /** 单值文本长度上限（超出截断，默认 300） */
    maxValueLen?: number;
    /** 最大字段数（超出折叠为摘要行，默认 60） */
    maxFields?: number;
}

function stringifyValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/**
 * 观察层投影（§3.6 下放）：只暴露候选路径的值，长值截断、超限折叠。
 * 绝不把完整状态直接暴露给模型（token 浪费 + 越权上下文）。
 */
export function buildObservation(
    state: unknown,
    paths: string[],
    opts: ObservationOptions = {}
): Observation {
    const max_value_len = opts.maxValueLen ?? 300;
    const max_fields = opts.maxFields ?? 60;
    const seen: string[] = [];
    const lines: string[] = [];
    // 先统计全部存在的候选数（用于折叠计数）
    const existing_count = paths.filter(p => {
        const path = normalizePath(p);
        return path ? getPathValue(state, path) !== undefined : false;
    }).length;

    for (const raw of paths) {
        if (seen.length >= max_fields) break;
        const path = normalizePath(raw);
        if (!path) continue;
        const value = getPathValue(state, path);
        if (value === undefined) continue; // 状态中不存在 → 跳过
        seen.push(path);
        let text = stringifyValue(value);
        if (text.length > max_value_len) text = text.slice(0, max_value_len) + '…';
        lines.push(`- ${path}: ${text}`);
    }

    const folded = Math.max(0, existing_count - lines.length);
    let text = lines.join('\n');
    if (folded > 0) {
        text += `\n…（另有 ${folded} 个字段未展示，本轮不更新）`;
    }
    if (text) {
        text = '<Observation>\n' + text + '\n</Observation>';
    }
    return { paths: seen, text, folded };
}

// ---------------------------------------------------------------------------
// 阶段5 校验：JSON Patch 语法容错（§4.8 下放）+ 权力边界
// ---------------------------------------------------------------------------

const PATCH_OPS = ['replace', 'delta', 'insert', 'add', 'remove', 'move'];

function isPlainRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 把 JSON Pointer 路径（/理/好感度）转为点分路径（理.好感度） */
export function pointerToPath(pointer: string): string {
    return String(pointer)
        .replace(/^\//, '')
        .replace(/~1/g, '/')
        .replace(/~0/g, '~')
        .split('/')
        .filter(Boolean)
        .join('.');
}

/**
 * JSON Patch 语法容错（万花筒 §4.8 下放）：
 * 修复常见语法错误（尾部多余逗号 / 围栏 / 缺前导斜杠），修复失败返回 null + 原因。
 * 绝不把脏 op 交给应用器。
 */
export function sanitizeJsonPatch(raw: string): { ops: PatchOp[] | null; reason: string | null } {
    const fail = (reason: string) => ({ ops: null, reason });

    let text = String(raw ?? '').trim();
    if (!text) return fail('JSON Patch 内容为空');
    // 剥离代码围栏
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    // 剥离 <JSONPatch> 包裹标签
    text = text.replace(/^<json_?patch>\s*/i, '').replace(/\s*<\/json_?patch>$/i, '');

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        // 修复常见语法错误：尾部多余逗号 / 单引号 → 双引号
        const repaired = text
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/,\s*,/g, ',')
            .replace(/'/g, '"');
        try {
            parsed = JSON.parse(repaired);
        } catch {
            return fail('无法解析为合法 JSON');
        }
    }

    if (!Array.isArray(parsed)) return fail('JSON Patch 必须是操作数组');

    const ops: PatchOp[] = [];
    for (const item of parsed) {
        if (!isPlainRecord(item)) return fail('操作项必须是对象');
        const op = item.op;
        if (typeof op !== 'string' || !PATCH_OPS.includes(op)) {
            return fail(`不支持的 op: ${String(op)}`);
        }
        const path_raw = typeof item.path === 'string' ? item.path : '';
        const op_any = op as PatchOp['op'];
        const needs_value = op_any === 'replace' || op_any === 'delta' || op_any === 'insert' || op_any === 'add';
        if (needs_value && item.value === undefined) return fail(`op ${op} 缺少 value`);
        if (op_any === 'delta' && typeof item.value !== 'number') return fail('op delta 的 value 必须是数字');
        if (op_any === 'move' && !(typeof item.from === 'string')) return fail('op move 缺少 from');
        // 路径漏点修复：无前导斜杠（点分或斜杠分隔）→ 补成 JSON Pointer
        let path = path_raw;
        if (path !== '' && path !== '/' && !path.startsWith('/')) {
            path = '/' + path.replace(/\./g, '/').replace(/^\/+/, '');
        }
        ops.push({
            op: op_any,
            path,
            value: item.value,
            from: typeof item.from === 'string' ? item.from : undefined,
            to: typeof item.to === 'string' ? item.to : undefined,
        });
    }
    return { ops, reason: null };
}

// ---------------------------------------------------------------------------
// 命令方言解析（自包含，支持多行/嵌套引号/注释）
// ---------------------------------------------------------------------------

function findMatchingCloseParen(str: string, startPos: number): number {
    let parenCount = 1;
    let inQuote = false;
    let quoteChar = '';
    for (let i = startPos; i < str.length; i++) {
        const char = str[i];
        const prev = i > 0 ? str[i - 1] : '';
        if ((char === '"' || char === "'" || char === '`') && prev !== '\\') {
            if (!inQuote) {
                inQuote = true;
                quoteChar = char;
            } else if (char === quoteChar) {
                inQuote = false;
            }
        }
        if (!inQuote) {
            if (char === '(') parenCount++;
            else if (char === ')') {
                parenCount--;
                if (parenCount === 0) return i;
            }
        }
    }
    return -1;
}

/** 顶层逗号切分参数（引号/括号/花括号感知） */
export function splitTopLevelParams(paramsString: string): string[] {
    const params: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';
    let paren = 0;
    let brace = 0;
    let bracket = 0;
    for (let i = 0; i < paramsString.length; i++) {
        const char = paramsString[i];
        const prev = i > 0 ? paramsString[i - 1] : '';
        if ((char === '"' || char === "'" || char === '`') && prev !== '\\') {
            if (!inQuote) {
                inQuote = true;
                quoteChar = char;
            } else if (char === quoteChar) {
                inQuote = false;
            }
        }
        if (!inQuote) {
            if (char === '(') paren++;
            else if (char === ')') paren--;
            else if (char === '{') brace++;
            else if (char === '}') brace--;
            else if (char === '[') bracket++;
            else if (char === ']') bracket--;
            if (char === ',' && paren === 0 && brace === 0 && bracket === 0) {
                params.push(current.trim());
                current = '';
                continue;
            }
        }
        current += char;
    }
    if (current.trim().length > 0) params.push(current.trim());
    return params;
}

function stripQuotes(text: string): string {
    return String(text).replace(/^[\s\\"'`]*/, '').replace(/[\s\\"'`]*$/, '');
}

const COMMAND_TYPES = ['set', 'insert', 'assign', 'remove', 'unset', 'delete', 'add'];

function validArgCount(type: string, count: number): boolean {
    switch (type) {
        case 'set':
        case 'insert':
        case 'assign':
            return count >= 2;
        case 'add':
            return count === 1 || count === 2;
        default:
            return count >= 1;
    }
}

/**
 * 从 <UpdateVariable> 块（或裸命令文本）中解析命令方言。
 * 返回逐条命令；fullMatch 保留原始文本供原样回放。
 */
export function parseCommands(text: string): ParsedCommand[] {
    const commands: ParsedCommand[] = [];
    let i = 0;
    while (i < text.length) {
        const match = text
            .substring(i)
            .match(new RegExp(`_\\.(${COMMAND_TYPES.join('|')})\\s*\\(`));
        if (!match || match.index === undefined) break;
        const type = match[1];
        const start = i + match.index;
        const openParen = start + match[0].length;
        const closeParen = findMatchingCloseParen(text, openParen);
        if (closeParen === -1) {
            i = openParen;
            continue;
        }
        let end = closeParen + 1;
        if (end >= text.length || text[end] !== ';') {
            i = closeParen + 1;
            continue;
        }
        end++;
        let reason = '';
        const comment = text.substring(end).match(/^\s*\/\/(.*)/);
        if (comment) {
            reason = comment[1].trim();
            end += comment[0].length;
        }
        const fullMatch = text.substring(start, end);
        const args = splitTopLevelParams(text.substring(openParen, closeParen));
        if (validArgCount(type, args.length) && args.length > 0) {
            commands.push({
                type,
                fullMatch,
                path: normalizePath(stripQuotes(args[0])),
                args,
                reason,
            });
        }
        i = end;
    }
    return commands;
}

// ---------------------------------------------------------------------------
// 阶段5 校验：权力边界（§0.2 下放）
// ---------------------------------------------------------------------------

/** 路径是否处于某候选路径的子树内（同子树允许，防越权） */
export function isWithinScope(path: string, duePaths: string[]): boolean {
    if (duePaths.length === 0) return true;
    const normalized = normalizePath(path);
    return duePaths.some(due => {
        const d = normalizePath(due);
        return (
            normalized === d ||
            normalized.startsWith(d + '.') ||
            d.startsWith(normalized + '.')
        );
    });
}

function patchParentPath(op: PatchOp): string | null {
    if (op.path === '' || op.path === '/') return '';
    const segments = splitPath(pointerToPath(op.path));
    if (segments.length === 0) return null;
    // 数组尾部追加：/a/- → 父为 /a
    if (op.path.endsWith('/-')) return segments.slice(0, -1).join('.') || '';
    return segments.slice(0, -1).join('.');
}

/**
 * 校验 ops 是否允许应用（万花筒 §0.2「Agent 有推理权，没有破坏契约的权力」下放）：
 *   - 只允许写入本轮调度范围（duePaths）内的路径 → 越权拒绝
 *   - set/replace/remove 的路径必须已存在于状态；insert/add 的父路径必须存在
 * @returns 错误列表（空 = 通过）
 */
export function validateOps(
    prepared: PreparedOps,
    state: unknown,
    duePaths: string[]
): string[] {
    const errors: string[] = [];

    for (const cmd of prepared.commands) {
        if (!cmd.path) {
            errors.push(`命令缺少路径: ${cmd.fullMatch}`);
            continue;
        }
        if (!isWithinScope(cmd.path, duePaths)) {
            errors.push(`越权路径 '${cmd.path}'（不在本轮调度范围）`);
            continue;
        }
        if (cmd.type === 'set' || cmd.type === 'remove' || cmd.type === 'unset' || cmd.type === 'delete') {
            if (!hasPath(state, cmd.path)) {
                errors.push(`路径 '${cmd.path}' 不存在于 stat_data`);
            }
        } else if (cmd.type === 'insert' || cmd.type === 'assign' || cmd.type === 'add') {
            if (!hasPath(state, cmd.path)) {
                const parent = splitPath(cmd.path).slice(0, -1).join('.');
                if (!hasPath(state, parent)) {
                    errors.push(`父路径 '${parent}' 不存在，无法插入 '${cmd.path}'`);
                }
            }
        }
    }

    if (prepared.patch) {
        for (const op of prepared.patch) {
            const dot = pointerToPath(op.path);
            if (!isWithinScope(dot, duePaths)) {
                errors.push(`越权路径 '${dot}'（不在本轮调度范围）`);
                continue;
            }
            if (op.op === 'replace' || op.op === 'remove' || op.op === 'delta') {
                if (!hasPath(state, dot)) {
                    errors.push(`路径 '${dot}' 不存在于 stat_data`);
                }
            } else if (op.op === 'insert' || op.op === 'add') {
                const parent = patchParentPath(op);
                if (parent !== null && !hasPath(state, parent)) {
                    errors.push(`父路径 '${parent}' 不存在，无法插入 '${dot}'`);
                }
            } else if (op.op === 'move') {
                if (op.from && !hasPath(state, pointerToPath(op.from))) {
                    errors.push(`move 来源 '${op.from}' 不存在`);
                }
            }
        }
    }

    return errors;
}

// ---------------------------------------------------------------------------
// delta 块解析（双通道）
// ---------------------------------------------------------------------------

/** 剥离 <UpdateVariable> 外壳与 <Analysis>/<Analyze> 块 */
export function stripUpdateBlock(block: string): string {
    let text = String(block ?? '').trim();
    text = text.replace(/<\/?UpdateVariable>/gi, '');
    text = text.replace(/<Analysis>[\s\S]*?<\/Analysis>/gi, '');
    text = text.replace(/<Analyze>[\s\S]*?<\/Analyze>/gi, '');
    return text.trim();
}

/**
 * 解析 <UpdateVariable> 块，支持多通道：
 *   - JSON Patch 方言（<JSONPatch>…</JSONPatch> 包裹）
 *   - 结构化输出（整体 JSON：op 数组，或 {analysis, json_patch} 对象，含代码围栏）
 *   - 命令方言（_.set 等）
 * @returns errors 非空 = 没有可用的更新内容（调用方喂回重试）
 */
export function parseDeltaBlock(block: string): { commands: ParsedCommand[]; patch: PatchOp[] | null; errors: string[] } {
    const text = stripUpdateBlock(block);
    if (!text) return { commands: [], patch: null, errors: [] };

    const errors: string[] = [];

    // 1. <JSONPatch> 包裹
    const patch_match = text.match(/<json_?patch>([\s\S]*?)<\/json_?patch>/i);
    if (patch_match) {
        const { ops, reason } = sanitizeJsonPatch(patch_match[1]);
        if (ops) return { commands: [], patch: ops, errors: [] };
        errors.push(`JSON Patch 无法修复: ${reason}`);
    }

    // 2. 整体 JSON：op 数组，或 {analysis, json_patch} 结构化输出（含代码围栏）
    const json_text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    if (json_text.startsWith('[') || json_text.startsWith('{')) {
        try {
            const parsed: unknown = JSON.parse(json_text);
            const patch_source =
                Array.isArray(parsed)
                    ? parsed
                    : parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                      ? (parsed as Record<string, unknown>).json_patch ??
                        (parsed as Record<string, unknown>).jsonPatch ??
                        (parsed as Record<string, unknown>).patch ??
                        (parsed as Record<string, unknown>).delta
                      : undefined;
            if (Array.isArray(patch_source)) {
                const { ops, reason } = sanitizeJsonPatch(JSON.stringify(patch_source));
                if (ops) return { commands: [], patch: ops, errors: [] };
                errors.push(`JSON Patch 无法修复: ${reason}`);
            } else {
                errors.push('结构化输出缺少 json_patch 数组');
                return { commands: [], patch: null, errors };
            }
        } catch {
            /* 解析失败 → 走命令方言 */
        }
    }

    // 3. 命令方言
    const commands = parseCommands(text);
    if (commands.length > 0) return { commands, patch: null, errors: [] };

    if (errors.length === 0) {
        errors.push('更新块内没有可用的更新命令（_.set(...) 或 JSON Patch）');
    }
    return { commands: [], patch: null, errors };
}

// ---------------------------------------------------------------------------
// 工作流编排
// ---------------------------------------------------------------------------

/**
 * 运行革新版 agent 化工作流：
 *   读规则（read_rules，本地）→ 启发式候选搜索（candidate_search，本地）
 *   → AI 逐项决策（decide）→ 按决策拉取世界书（fetch_rules）→ 观察投影（observe）
 *   → 一步更新（update，失败原因喂回重试）→ 校验（validate，连续相同失败熔断）。
 * 启发式保证效率（候选远小于全量）与准确度（规则+剧情双路不漏），
 * 模型必须对候选逐项判断（防偷懒）；决策范围即候选（越权路径本地丢弃）。
 * 模型调用：有更新 2 次（decide + update），决策无变化 1 次（decide 后 no_change）。
 */
export async function runAgentWorkflow(
    executor: AgentWorkflowExecutor,
    input: { state: unknown; story: string },
    options: AgentWorkflowOptions
): Promise<AgentWorkflowResult> {
    const started_at = Date.now();
    const max_retries = Math.max(1, Math.floor(options.maxRetries) || 1);
    const loop_threshold = Math.max(2, Math.floor(options.loopThreshold) || 2);

    const stages: WorkflowStage[] = [];
    const base: AgentWorkflowResult = {
        stages,
        rules: null,
        candidates: null,
        candidateSource: null,
        decide: null,
        due: null,
        observation: null,
        update: null,
        prepared: null,
        selfCheck: null,
        termination: 'error',
        retries: 0,
        elapsed_ms: 0,
    };
    const finish = (termination: AgentWorkflowTermination): AgentWorkflowResult => ({
        ...base,
        termination,
        elapsed_ms: Date.now() - started_at,
    });

    try {
        // ---- 阶段0 读规则（本地，零模型调用） ----
        stages.push('read_rules');
        const rules = await executor.readRules();
        base.rules = rules;

        // ---- 阶段1 启发式候选搜索（本地）：AI 分池规则路径 ∪ 剧情命中路径 ----
        stages.push('candidate_search');
        // 规则路径唯一来源 = AI 规则分池（worldbook_pool 经 extraPaths 传入）；无正则提取
        const rule_paths = rules.extraPaths ?? [];
        const { candidates, from_rules, from_story } = searchCandidates(
            input.state,
            input.story,
            rule_paths,
            { maxCandidates: options.maxCandidates }
        );
        base.candidates = candidates;
        base.candidateSource = { from_rules, from_story };
        if (candidates.length === 0) {
            // 规则没提、剧情也没命中任何变量 → 直接终止，不发模型请求
            return finish('no_change');
        }

        // ---- 阶段2 AI 决策：对候选清单逐项判断（防偷懒），只能选候选内 ----
        stages.push('decide');
        const decide_result = await executor.decide(
            { story: input.story, candidates },
            undefined
        );
        base.decide = decide_result;
        const due = parseDecidePaths(decide_result.text, candidates);
        base.due = due;
        if (due.length === 0) {
            // AI 决策无变化 → 直接终止，不发更新请求
            return finish('no_change');
        }

        // ---- 阶段3 按决策路径裁剪规则 + 按候选全集搜索背景（本地，缓存命中） ----
        stages.push('fetch_rules');
        // 背景搜索关键词 = 候选全集（决策路径 ∪ 剧情命中路径）——要改什么就搜什么背景
        const fetched = await executor.fetchRules(due, input.story, candidates);
        base.rules = fetched;

        // ---- 阶段4 观察层投影（只投影决策路径的值） ----
        stages.push('observe');
        const observation = buildObservation(input.state, due, {
            maxValueLen: options.maxValueLen,
            maxFields: options.maxFields,
        });
        base.observation = observation;
        if (observation.paths.length === 0) return finish('no_change');

        // ---- 阶段5 + 阶段6：一步更新 + 校验（失败喂回重试） ----
        let last_error: string | undefined;
        let consecutive_failures = 0;
        let last_failure_reason: string | undefined;

        const ctx: UpdateContext = {
            story: input.story,
            observation: observation.text,
            rules: fetched.entries,
            lore: fetched.lore ?? [],
            due,
        };

        for (let attempt = 1; attempt <= max_retries + 1; attempt++) {
            stages.push('update');
            const update_result = await executor.update(ctx, last_error);
            base.update = update_result;
            base.retries = attempt - 1;

            // 模型完全没输出（raw 与 block 都是空）→ 视为失败，喂回「输出为空」重试
            if (!String(update_result.raw ?? '').trim() && !String(update_result.block ?? '').trim()) {
                const reason = '模型输出为空（未返回任何内容）';
                if (reason === last_failure_reason) {
                    consecutive_failures++;
                } else {
                    consecutive_failures = 1;
                    last_failure_reason = reason;
                }
                last_error = reason;
                if (consecutive_failures >= loop_threshold) {
                    return finish('loop_broken');
                }
                if (attempt > max_retries) {
                    return finish('max_retries');
                }
                continue;
            }

            // 模型输出了空块（<UpdateVariable></UpdateVariable> 等）→ 明确无更新 → done
            if (!String(update_result.block ?? '').trim()) {
                return finish('done');
            }

            // ---- 阶段5 校验 ----
            stages.push('validate');
            const prepared = parseDeltaBlock(update_result.block);
            base.prepared = prepared;

            // 空更新块（<UpdateVariable></UpdateVariable> 等，无任何内容）→ 无更新
            if (prepared.commands.length === 0 && prepared.patch === null && prepared.errors.length === 0) {
                return finish('done');
            }

            const validation_errors = validateOps(prepared, input.state, due);
            const self_check: SelfCheckResult =
                validation_errors.length > 0
                    ? { ok: false, reason: validation_errors.join('；') }
                    : { ok: true };
            base.selfCheck = self_check;

            if (self_check.ok) {
                // 应用一次；无论是否实际修改，本轮回合即完成
                await executor.apply(prepared);
                return finish('done');
            }

            // 校验失败：喂回原因重试
            const reason = self_check.reason ?? '校验未通过';
            if (reason === last_failure_reason) {
                consecutive_failures++;
            } else {
                consecutive_failures = 1;
                last_failure_reason = reason;
            }
            last_error = reason;

            // 连续相同失败达到阈值 → 熔断
            if (consecutive_failures >= loop_threshold) {
                return finish('loop_broken');
            }

            if (attempt > max_retries) {
                return finish('max_retries');
            }
        }

        return finish('done');
    } catch (e) {
        return {
            ...base,
            termination: 'error',
            error: e instanceof Error ? e.message : String(e),
            elapsed_ms: Date.now() - started_at,
        };
    }
}
