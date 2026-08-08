/**
 * [革新版·Agent 工作流 v2] 单次 Agent 回合核心（纯逻辑，零 MVU 依赖）。
 *
 * 对齐万花筒 §0.1-A / §3.4「单次模式 = 一步 agent 回合」：
 *   阶段1 读规则（read_rules）：本地读取全部 [mvu_update] 更新规则（零模型调用）
 *   阶段2 调度（due）       ：dueFields 本地确定性调度——从规则中提取本轮候选变量路径
 *                             （替代 v1 的「让模型列出全部变量 Y/N」——那是 MVU 的反面教材）
 *   阶段3 观察（observe）    ：状态投影 + 可见性控制（只暴露候选字段，截断/折叠）
 *   阶段4 更新（update）     ：一步 agent 回合——模型基于（最近剧情 + 观察 + 规则）产出 delta，应用一次
 *   阶段5 校验（validate）   ：JSON Patch 语法容错（§4.8 下放）→ 权力边界校验 → 失败原因喂回重试
 *
 * 与 v1（检查→读规则→更新→自检）的差异：
 *   - 删掉「模型检查阶段」：v1 的 check 请求只有 stat_data 文本、没有剧情上下文（盲人摸象），
 *     且要求模型逐行输出全部变量 Y/N（token 浪费、上下文膨胀、行为不可控）。
 *   - 候选范围由本地 dueFields 决定（防止 Agent 自行膨胀上下文，§0.2）。
 *   - 模型每轮只发 1 次请求（原 2 次），省 token；无候选直接 no_change 不发请求。
 *   - delta 解析支持命令方言（_.set 等）与 JSON Patch 方言双通道，并做语法容错（sanitizeJsonPatch）。
 *   - 校验后只允许写入「本轮调度范围」内的路径（越权写入本地拒绝）。
 *
 * 模型调用与变量应用全部通过 executor 注入，本模块可独立单测。
 */

/** 工作流阶段 */
export type WorkflowStage = 'read_rules' | 'due' | 'observe' | 'update' | 'validate';

/** 终止原因 */
export type AgentWorkflowTermination =
    | 'done'
    | 'no_change'
    | 'max_retries'
    | 'loop_broken'
    | 'error';

/** 阶段1 读取到的规则集 */
export interface RuleSet {
    /** 规则内容（世界书 [mvu_update] 条目正文） */
    entries: string[];
    raw: string;
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

/** 阶段4 更新上下文 */
export interface UpdateContext {
    /** 最近剧情文本（桥接层从聊天消息提取） */
    story: string;
    /** 观察层投影文本 */
    observation: string;
    /** 与候选路径相关的规则子集 */
    rules: string[];
    /** 本轮候选路径（dueFields 结果） */
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
    /** 阶段1：本地读取全部 [mvu_update] 更新规则（世界书，零模型调用） */
    readRules(): Promise<RuleSet>;
    /** 阶段4：一步 agent 回合——基于（剧情+观察+规则）产出 delta。失败原因可喂回重试 */
    update(ctx: UpdateContext, lastError?: string): Promise<UpdateResult>;
    /** 阶段5：应用校验通过的 ops 到真实变量；返回是否实际修改 */
    apply(prepared: PreparedOps): Promise<{ applied: boolean; errors?: string[] }>;
}

/** 工作流结果 */
export interface AgentWorkflowResult {
    /** 实际经历的阶段序列（诊断用） */
    stages: WorkflowStage[];
    rules: RuleSet | null;
    due: string[] | null;
    observation: Observation | null;
    update: UpdateResult | null;
    prepared: PreparedOps | null;
    selfCheck: SelfCheckResult | null;
    termination: AgentWorkflowTermination;
    /** 总重试次数（阶段5校验失败重试） */
    retries: number;
    /** 总耗时 ms */
    elapsed_ms: number;
    error?: string;
}

/** 工作流配置 */
export interface AgentWorkflowOptions {
    /** 阶段5校验失败的最大重试次数（≥1） */
    maxRetries: number;
    /** 连续相同失败判定阈值（≥2 生效；连续 N 次相同失败原因 → 熔断） */
    loopThreshold: number;
    /** 观察层单值长度上限（默认 300） */
    maxValueLen?: number;
    /** 观察层最大字段数（超出折叠，默认 60） */
    maxFields?: number;
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
// 阶段2 dueFields：本地确定性调度（从规则中提取候选路径）
// ---------------------------------------------------------------------------

const COMMAND_PATH_RE = /_\.(?:set|insert|assign|remove|unset|delete|add)\s*\(\s*(['"])([^'"]+)\1/g;
const DOTTED_PATH_RE = /(?:stat_data\.)?([\p{L}\p{N}_][\p{L}\p{N}_-]*(?:\.[\p{L}\p{N}_][\p{L}\p{N}_-]*)+)/gu;
function looksLikePath(token: string): boolean {
    const segments = token.split('.').map(s => s.trim()).filter(Boolean);
    if (segments.length < 2) return false;
    // 纯数字路径（如 1.0）不是变量路径
    return !segments.every(s => /^\d+$/.test(s));
}

/**
 * dueFields 本地调度（万花筒 §0.2 下放）：
 * 从 [mvu_update] 规则内容中确定性提取「本轮候选变量路径」。
 * 候选范围 = 规则声明涉及的路径——Agent 无权自行扩大范围。
 * @param rules 规则内容数组
 * @returns 候选路径（已去掉 stat_data. 前缀，去重保序）
 */
export function extractDuePaths(rules: string[]): string[] {
    const paths: string[] = [];
    const push = (path: string) => {
        const normalized = normalizePath(path);
        // 跳过内建前缀（_.set 等命令文本）与空串
        if (normalized.startsWith('_')) return;
        if (normalized && looksLikePath(normalized) && !paths.includes(normalized)) {
            paths.push(normalized);
        }
    };
    for (const rule of rules) {
        if (!rule) continue;
        // 1. 命令中的路径参数（_._.set('path', ...)）
        for (const m of rule.matchAll(COMMAND_PATH_RE)) {
            push(m[2]);
        }
        // 2. 规则正文中的点分路径（如「当 理.好感度 低于 30」）
        for (const m of rule.matchAll(DOTTED_PATH_RE)) {
            push(m[1]);
        }
    }
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
 * 运行革新版单次 Agent 回合工作流。
 * 本地调度决定候选（无候选不发模型请求）；模型只发一次更新请求；
 * 校验失败把原因喂回重试（maxRetries 护栏）；连续相同失败熔断（loop_broken）。
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
        // ---- 阶段1 读规则（本地） ----
        stages.push('read_rules');
        const rules = await executor.readRules();
        base.rules = rules;
        if (rules.entries.length === 0) return finish('no_change');

        // ---- 阶段2 dueFields 本地调度 ----
        stages.push('due');
        const due = extractDuePaths(rules.entries);
        base.due = due;
        if (due.length === 0) return finish('no_change');

        // ---- 阶段3 观察层投影 ----
        stages.push('observe');
        const observation = buildObservation(input.state, due, {
            maxValueLen: options.maxValueLen,
            maxFields: options.maxFields,
        });
        base.observation = observation;
        if (observation.paths.length === 0) return finish('no_change');

        // 与候选相关的规则子集（不把全量规则塞进请求）
        const relevant_rules = filterRelevantRules(rules.entries, due);

        // ---- 阶段4 + 阶段5：一步 agent 回合 + 校验（失败喂回重试） ----
        let last_error: string | undefined;
        let consecutive_failures = 0;
        let last_failure_reason: string | undefined;

        const ctx: UpdateContext = {
            story: input.story,
            observation: observation.text,
            rules: relevant_rules,
            due,
        };

        for (let attempt = 1; attempt <= max_retries + 1; attempt++) {
            stages.push('update');
            const update_result = await executor.update(ctx, last_error);
            base.update = update_result;
            base.retries = attempt - 1;

            // 模型明确表示无更新 → done（不发应用）
            if (!update_result.block.trim()) {
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
