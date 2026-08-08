/**
 * [革新版·ZOD 变量仓库解析] 纯逻辑模块（零 MVU 依赖）。
 *
 * 部分角色卡作者会在卡的酒馆助手脚本里放一个 ZOD 脚本（变量仓库）：
 *   开头 `import { registerMvuSchema } from '.../mvu_zod.js'`
 *   定义 `export const Schema = z.object({ ... })` 声明完整的 stat_data 结构
 *   （类型、describe、prefault 默认值、record 动态键、enum 枚举）。
 *
 * 革新版通过 tavern-helper `getScriptTrees({type:'character'})` 拿到角色卡脚本源码，
 * 用本模块【结构化解析】出变量路径树——这是作者声明的权威「变量仓库」，
 * 并入候选搜索（存在性校验后），AI 分池失败时候选也不会只剩剧情命中的几个。
 *
 * 说明：这是对脚本源码的结构化解析（括号配对/键值扫描），不是从文本里"猜路径"的正则。
 */

/** 判断脚本是否为 ZOD 变量仓库脚本（用户给的识别方式：开头 import registerMvuSchema / mvu_zod） */
export function isZodScript(content: string): boolean {
    const text = String(content ?? '');
    return /registerMvuSchema/.test(text) || /mvu_zod(?:\.js)?/.test(text);
}

/** 找配对的闭合括号位置（引号/括号感知），找不到返回 -1 */
function findMatchingClose(str: string, open: string, close: string, start: number): number {
    let depth = 0;
    let inQuote = false;
    let quoteChar = '';
    for (let i = start; i < str.length; i++) {
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
        if (inQuote) continue;
        if (char === open) depth++;
        else if (char === close) {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/** 在给定范围内按逗号切分顶层条目（引号/括号感知，z.object/record 嵌套不会被切开） */
function splitTopLevelItems(text: string): string[] {
    const items: string[] = [];
    let current = '';
    let depth = 0;
    let inQuote = false;
    let quoteChar = '';
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const prev = i > 0 ? text[i - 1] : '';
        if ((char === '"' || char === "'" || char === '`') && prev !== '\\') {
            if (!inQuote) {
                inQuote = true;
                quoteChar = char;
            } else if (char === quoteChar) {
                inQuote = false;
            }
        }
        if (!inQuote) {
            if (char === '(' || char === '{' || char === '[') depth++;
            else if (char === ')' || char === '}' || char === ']') depth--;
            if (char === ',' && depth === 0) {
                items.push(current.trim());
                current = '';
                continue;
            }
        }
        current += char;
    }
    if (current.trim()) items.push(current.trim());
    return items;
}

/** 键名正则：中文/字母/数字/下划线/$ 开头，允许连字符 */
const KEY_RE = /^[$_\p{L}\p{N}][$_\p{L}\p{N}-]*/u;

/** 从值表达式判断类型分支 */
type ValueKind = 'object' | 'record' | 'array' | 'leaf';

function kindOfValue(value: string): { kind: ValueKind; inner?: string } {
    const v = value.trim();
    if (v.startsWith('z.object(')) {
        const open = v.indexOf('(');
        return { kind: 'object', inner: v.slice(open + 1) };
    }
    if (v.startsWith('z.record(')) {
        // z.record(键schema, 值schema) —— 取第二个参数（值 schema）
        const open = v.indexOf('(');
        const close = findMatchingClose(v, '(', ')', open);
        if (close === -1) return { kind: 'record' };
        const args = splitTopLevelItems(v.slice(open + 1, close));
        return { kind: 'record', inner: args[1] ?? args[0] };
    }
    if (v.startsWith('z.array(')) return { kind: 'array' };
    return { kind: 'leaf' };
}

/**
 * 解析 ZOD 脚本源码，枚举变量路径树。
 * @param source 脚本源码（角色卡 TH 脚本 content）
 * @returns 路径数组（如 世界.当前时间 / 主角.姓名 / 道侣（record 容器）/ $器灵台词）
 */
export function parseZodSchemaPaths(source: string): string[] {
    const text = String(source ?? '');
    const paths: string[] = [];
    const seen = new Set<string>();

    // 定位 Schema 定义（export const Schema = z.object( 或 const Schema = z.object(）
    // 注意：`Schema = z.object(` 共 18 字符，切片长度必须足够（v1.12.2 修复 12 字符截断导致定位失败）
    const schema_match = text.match(/Schema\s*=\s*z\.object\(/);
    if (!schema_match || schema_match.index === undefined) return paths;
    const schema_start = schema_match.index;
    const obj_open = text.indexOf('(', schema_start + 6);
    if (obj_open === -1) return paths;
    const open = text.indexOf('{', obj_open);
    if (open === -1) return paths;
    const close = findMatchingClose(text, '{', '}', open);
    if (close === -1) return paths;
    const body = text.slice(open + 1, close);

    const add = (path: string) => {
        if (!seen.has(path)) {
            seen.add(path);
            paths.push(path);
        }
    };

    // 递归解析对象体：键: 值（值可能是 z.object 嵌套 / z.record / 叶子）
    const parseObjectBody = (bodyText: string, prefix: string) => {
        for (const item of splitTopLevelItems(bodyText)) {
            const colon = findTopLevelColon(item);
            if (colon === -1) continue;
            const keyRaw = item.slice(0, colon).trim();
            const keyMatch = keyRaw.match(KEY_RE);
            if (!keyMatch) continue;
            const key = keyMatch[0];
            // 键可能带引号（'世界': z.object(...)）
            const cleanKey = key.replace(/^['"`]|['"`]$/g, '');
            const path = prefix ? `${prefix}.${cleanKey}` : cleanKey;
            const value = item.slice(colon + 1).trim();
            const { kind, inner } = kindOfValue(value);
            if (kind === 'object' && inner !== undefined) {
                const objOpen = inner.indexOf('{');
                if (objOpen !== -1) {
                    const objClose = findMatchingClose(inner, '{', '}', objOpen);
                    if (objClose !== -1) {
                        // 容器本身也是路径（可能是中间对象）
                        add(path);
                        parseObjectBody(inner.slice(objOpen + 1, objClose), path);
                        continue;
                    }
                }
                add(path);
            } else if (kind === 'record') {
                // record 容器：动态键（道侣姓名/物品名），容器本身作为路径
                add(path);
                // record 的值若是 z.object，其子字段作为模板路径（带 <键> 占位）
                if (inner !== undefined) {
                    const { kind: innerKind, inner: innerInner } = kindOfValue(inner);
                    if (innerKind === 'object' && innerInner !== undefined) {
                        const objOpen = innerInner.indexOf('{');
                        if (objOpen !== -1) {
                            const objClose = findMatchingClose(innerInner, '{', '}', objOpen);
                            if (objClose !== -1) {
                                parseObjectBody(
                                    innerInner.slice(objOpen + 1, objClose),
                                    `${path}.<键>`
                                );
                            }
                        }
                    }
                }
            } else {
                // 叶子（string/number/enum/array）
                add(path);
            }
        }
    };

    parseObjectBody(body, '');
    return paths;
}

/** 在条目中找顶层冒号（值里的冒号/引号内冒号不算） */
function findTopLevelColon(item: string): number {
    let depth = 0;
    let inQuote = false;
    let quoteChar = '';
    for (let i = 0; i < item.length; i++) {
        const char = item[i];
        const prev = i > 0 ? item[i - 1] : '';
        if ((char === '"' || char === "'" || char === '`') && prev !== '\\') {
            if (!inQuote) {
                inQuote = true;
                quoteChar = char;
            } else if (char === quoteChar) {
                inQuote = false;
            }
        }
        if (inQuote) continue;
        if (char === '(' || char === '{' || char === '[') depth++;
        else if (char === ')' || char === '}' || char === ']') depth--;
        if (char === ':' && depth === 0) return i;
    }
    return -1;
}
