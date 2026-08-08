/**
 * [革新版·独立请求构造 v2] 纯逻辑模块。
 *
 * 对齐万花筒 §3.4「单次模式 = 一步 agent 回合」：不再有独立的「检查」模型请求
 * （v1 的检查请求只有变量状态文本、没有剧情上下文，是盲人摸象；且要求模型
 * 逐行列出全部变量 Y/N，是 MVU 的反面教材）。候选范围改由本地 dueFields 调度
 * （见 agent_workflow.ts），模型每轮只发一次「更新」请求：
 *
 *   最近剧情（story，桥接层从聊天消息提取） + 观察层投影（observation） + 相关规则
 *   → 模型输出 <UpdateVariable> 块（命令方言或 JSON Patch 方言）
 *
 * 请求构造直接按 tavern-helper 底层 generateRaw 的 GenerateRawConfig 构造，
 * 动态内容（任务）压尾部，利于前缀缓存。
 *
 * 纯逻辑零依赖（只拼字符串/对象），可独立单测。
 */

/** 更新阶段提示词：基于剧情 + 观察 + 规则产出 delta（一步 agent 回合） */
export function buildAgentUpdateTask(opts: {
    story: string;
    observation: string;
    rules: string[];
    last_error?: string;
    /** 结构化输出模式（配合 json_schema）：要求模型输出 {analysis, json_patch} JSON */
    structured?: boolean;
}): string {
    const format_instructions = opts.structured
        ? [
              '你必须以结构化 JSON 输出（不要 <UpdateVariable> 标签、不要解释）：',
              '  {"analysis": "英文简要推理", "json_patch": [{"op":"replace","path":"/理/好感度","value":50}]}',
              'json_patch 的 op 支持 replace/delta/insert/add/remove/move，path 为 JSON Pointer。',
          ]
        : [
              '更新块格式（二选一）：',
              '  格式A（命令方言）：',
              '    <UpdateVariable>',
              '      _.set(\'变量路径\', 新值);//原因',
              '      _.insert(\'变量路径\', 新值);',
              '    </UpdateVariable>',
              '  格式B（JSON Patch 方言）：',
              '    <UpdateVariable>',
              '      <JSONPatch>[{"op":"replace","path":"/理/好感度","value":50}]</JSONPatch>',
              '    </UpdateVariable>',
          ];
    const parts = [
        '<must>',
        '你是变量更新 Agent。基于以下「最近剧情」与「变量观察」，判断哪些变量需要更新，',
        opts.structured
            ? '并只输出结构化 JSON，不要输出任何解释或正文。'
            : '并只输出一个 <UpdateVariable> 更新块，不要输出任何解释或正文。',
        ...format_instructions,
        '规则：',
        '- 只更新「变量观察」中列出的变量；不在列表中的变量一律不要写（越权写入会被本地引擎拒绝）。',
        '- 变量路径相对于 stat_data（如 理.好感度），JSON Patch 的 path 为 JSON Pointer（如 /理/好感度）。',
        '- 若本轮无需更新任何变量，输出空数组：[]（structured 模式）或空块：<UpdateVariable></UpdateVariable>（文本模式）。',
        '</must>',
        '',
        '最近剧情：',
        opts.story || '（无）',
        '',
        '变量观察：',
        opts.observation || '（无）',
    ];
    if (opts.rules.length > 0) {
        parts.push('', '相关更新规则：', opts.rules.join('\n---\n'));
    }
    if (opts.last_error) {
        parts.push('', '上次输出未通过本地校验，原因：' + opts.last_error, '请修正后重新输出。');
    }
    return parts.join('\n');
}

// ---------------------------------------------------------------------------
// 结构化输出（json_schema）——对齐万花筒 §3.4 [F4] 变量请求结构化输出
// ---------------------------------------------------------------------------

const json_primitive_value_schemas = [
    { type: 'string' },
    { type: 'number' },
    { type: 'integer' },
    { type: 'boolean' },
    { type: 'null' },
];

const json_array_item_schema = {
    anyOf: [...json_primitive_value_schemas, { type: 'object' }, { type: 'array' }],
};

const json_value_schema = {
    anyOf: [
        ...json_primitive_value_schemas,
        { type: 'object' },
        { type: 'array', items: json_array_item_schema },
    ],
};

const json_patch_operation_schema = {
    anyOf: [
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                op: { type: 'string', enum: ['replace'] },
                path: { type: 'string' },
                value: json_value_schema,
            },
            required: ['op', 'path', 'value'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                op: { type: 'string', enum: ['delta'] },
                path: { type: 'string' },
                value: { type: 'number' },
            },
            required: ['op', 'path', 'value'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                op: { type: 'string', enum: ['insert', 'add'] },
                path: { type: 'string' },
                value: json_value_schema,
            },
            required: ['op', 'path', 'value'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                op: { type: 'string', enum: ['remove'] },
                path: { type: 'string' },
            },
            required: ['op', 'path'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                op: { type: 'string', enum: ['move'] },
                from: { type: 'string' },
                path: { type: 'string' },
            },
            required: ['op', 'from', 'path'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                op: { type: 'string', enum: ['move'] },
                from: { type: 'string' },
                to: { type: 'string' },
            },
            required: ['op', 'from', 'to'],
        },
    ],
};

/**
 * 构造结构化输出的 JSON Schema（与 tavern-helper GenerateConfig.json_schema 兼容；
 * ST 服务端会自动转换：OpenAI 系 → response_format.json_schema，Claude → 强制工具调用）。
 * @returns 兼容 tavern-helper JsonSchema 形状的 schema 对象
 */
export function createJsonPatchResponseSchema(): object {
    return {
        name: 'nlkaleido_agent_patch',
        description:
            'variable update structured output. Return analysis plus json_patch operations only.',
        strict: false,
        value: {
            type: 'object',
            additionalProperties: false,
            properties: {
                analysis: {
                    type: 'string',
                    description:
                        'Write in ENGLISH. Compactly summarize the variable update decision without revealing variable contents.',
                },
                json_patch: {
                    type: 'array',
                    description:
                        'MVU JsonPatch dialect operations. Use replace, delta, insert/add, remove, or move with JSON Pointer paths.',
                    items: json_patch_operation_schema,
                },
            },
            required: ['analysis', 'json_patch'],
        },
    };
}

/**
 * 构造更新阶段 generateRaw 配置。
 * 动态任务在尾部（利于前缀缓存）；不注入聊天历史占位符——
 * 剧情上下文由桥接层显式构造并嵌入任务（对齐万花筒自构 L3 尾部）。
 * @param opts 生成选项
 */
export function buildAgentUpdateRawConfig(opts: {
    task: string;
    custom_api?: Record<string, any>;
    ordered_prompts?: (string | { role: string; content: string })[];
    /** 结构化输出 schema（ST 自动按 provider 转换：OpenAI → response_format，Claude → 强制工具） */
    json_schema?: object;
}): Record<string, any> {
    const ordered_prompts: (string | { role: string; content: string })[] = opts.ordered_prompts
        ? [...opts.ordered_prompts]
        : [];
    ordered_prompts.push({ role: 'system', content: opts.task });
    ordered_prompts.push('user_input');
    const config: Record<string, any> = {
        user_input: '遵循<must>指令',
        should_stream: false,
        ordered_prompts,
    };
    if (opts.custom_api) {
        config.custom_api = opts.custom_api;
    }
    if (opts.json_schema) {
        config.json_schema = opts.json_schema;
    }
    return config;
}

/** 从 generateRaw 结果中规范化出纯文本（兼容 tool_calls 形态与结构化输出） */
export function normalizeGenerateText(result: unknown): string {
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object') {
        const r = result as { content?: unknown; tool_calls?: unknown };
        // content 非空字符串才直接返回；空串继续尝试 tool_calls（Gemini/Claude 等可能 content='' + tool_calls）
        if (typeof r.content === 'string' && r.content.length > 0) return r.content;
        if (Array.isArray(r.tool_calls)) {
            const first = r.tool_calls[0] as { function?: { arguments?: string } } | undefined;
            if (first?.function?.arguments) {
                try {
                    const parsed = JSON.parse(first.function.arguments) as Record<string, unknown>;
                    // 文本工具：delta 字段；结构化工具：json_patch 数组
                    if (typeof parsed.delta === 'string') return parsed.delta;
                    const patch = parsed.json_patch ?? parsed.jsonPatch ?? parsed.patch;
                    if (Array.isArray(patch)) return JSON.stringify(patch);
                } catch {
                    /* ignore */
                }
            }
        }
        if (typeof r.content === 'string') return r.content;
    }
    return '';
}
