/**
 * [革新版·独立请求构造] 纯逻辑模块。
 *
 * 革新版自己的 Agent 请求构造——不依赖 MVU 的 invokeExtraModelWithStrategy / extra_model_task，
 * 直接按 tavern-helper 底层 generateRaw 的 GenerateRawConfig 构造。
 *
 * 四阶段工作流对应两种请求：
 *   - check（检查）：让模型只输出「需要更新的变量清单」（不产出更新块）
 *   - update（更新）：基于已读取的规则产出 <UpdateVariable> delta
 * 自检在本地完成（见 agent_apply.ts），无需模型请求。
 *
 * 纯逻辑零依赖（只拼字符串/对象），可独立单测。
 */

/** 检查阶段提示词：只列出需要更新的变量，不更新 */
export function buildCheckTask(state_text: string): string {
    return [
        '<must>',
        '你是变量更新 Agent。仅执行【检查】阶段，不要输出任何 <UpdateVariable> 更新块。',
        '基于以下最新剧情与当前变量状态，判断哪些变量需要更新。',
        '逐行输出格式（每行一个变量路径 + 判断）：',
        '  变量路径: Y    （需要更新）',
        '  变量路径: N    （不需要更新）',
        '不要输出解释，不要输出更新命令。若都不需要更新，输出：none',
        '</must>',
        '',
        '当前变量状态：',
        state_text,
    ].join('\n');
}

/** 更新阶段提示词：基于规则产出 delta（一次） */
export function buildUpdateTask(
    rules: string[],
    check_raw: string,
    last_error?: string
): string {
    const parts = [
        '<must>',
        '你是变量更新 Agent。基于检查结果与以下相关规则，输出 <UpdateVariable> 更新块。',
        '只更新【检查结果中判定为 Y】的变量，不要重复更新不需要更新的变量。',
        '格式：',
        '<UpdateVariable>',
        '  <Analysis>.../Analysis>',
        '  _.set(\'变量路径\', 新值);//原因',
        '</UpdateVariable>',
        '只输出一个 <UpdateVariable> 块，不要额外解释。',
        '</must>',
        '',
        '检查结果：',
        check_raw,
    ];
    if (rules.length > 0) {
        parts.push('', '相关更新规则：', rules.join('\n---\n'));
    }
    if (last_error) {
        parts.push('', '上次输出未通过格式自检，原因：' + last_error, '请修正后重新输出。');
    }
    return parts.join('\n');
}

/**
 * 构造检查阶段 generateRaw 配置。
 * @param opts 生成选项
 */
export function buildCheckRawConfig(opts: {
    state_text: string;
    custom_api?: Record<string, any>;
    max_chat_history?: number;
    ordered_prompts?: (string | { role: string; content: string })[];
}): Record<string, any> {
    const ordered_prompts: (string | { role: string; content: string })[] = opts.ordered_prompts
        ? [...opts.ordered_prompts]
        : [];
    // 确保任务在末尾（动态内容压尾部，利于前缀缓存）
    ordered_prompts.push({ role: 'system', content: buildCheckTask(opts.state_text) });
    ordered_prompts.push('user_input');
    const config: Record<string, any> = {
        user_input: '遵循<must>指令',
        max_chat_history: opts.max_chat_history ?? 2,
        should_stream: false,
        ordered_prompts,
    };
    if (opts.custom_api) {
        config.custom_api = opts.custom_api;
    }
    return config;
}

/**
 * 构造更新阶段 generateRaw 配置。
 */
export function buildUpdateRawConfig(opts: {
    rules: string[];
    check_raw: string;
    last_error?: string;
    custom_api?: Record<string, any>;
    max_chat_history?: number;
    ordered_prompts?: (string | { role: string; content: string })[];
}): Record<string, any> {
    const ordered_prompts: (string | { role: string; content: string })[] = opts.ordered_prompts
        ? [...opts.ordered_prompts]
        : [];
    ordered_prompts.push({
        role: 'system',
        content: buildUpdateTask(opts.rules, opts.check_raw, opts.last_error),
    });
    ordered_prompts.push('user_input');
    const config: Record<string, any> = {
        user_input: '遵循<must>指令',
        max_chat_history: opts.max_chat_history ?? 2,
        should_stream: false,
        ordered_prompts,
    };
    if (opts.custom_api) {
        config.custom_api = opts.custom_api;
    }
    return config;
}

/** 从 generateRaw 结果中规范化出纯文本（兼容 tool_calls 形态） */
export function normalizeGenerateText(result: unknown): string {
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object') {
        const r = result as { content?: unknown; tool_calls?: unknown };
        // content 非空字符串才直接返回；空串继续尝试 tool_calls（Gemini 等可能 content='' + tool_calls）
        if (typeof r.content === 'string' && r.content.length > 0) return r.content;
        if (Array.isArray(r.tool_calls)) {
            const first = r.tool_calls[0] as { function?: { arguments?: string } } | undefined;
            if (first?.function?.arguments) {
                try {
                    const parsed = JSON.parse(first.function.arguments) as { delta?: string };
                    if (typeof parsed.delta === 'string') return parsed.delta;
                } catch {
                    /* ignore */
                }
            }
        }
        if (typeof r.content === 'string') return r.content;
    }
    return '';
}
