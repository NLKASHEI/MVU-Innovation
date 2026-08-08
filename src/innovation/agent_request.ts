/**
 * [革新版·独立请求构造 v4] 纯逻辑模块。
 *
 * agent 化工作流两种请求：
 *   - 决策（decide）：AI 基于【最近剧情 + 启发式候选清单】逐项判断「哪些候选要更新」。
 *     候选是本地启发式（规则路径 ∪ 剧情命中）筛过的，数量远小于全量变量——
 *     模型必须逐项输出 Y/N（防偷懒），且只能选候选内的路径（越权本地丢弃）。
 *   - 更新（update）：AI 基于（剧情 + 观察投影 + 相关规则 + 相关背景）产出 <UpdateVariable> 块
 *     （命令方言或 JSON Patch 方言），支持 json_schema 结构化输出。
 *
 * 请求构造直接按 tavern-helper 底层 generateRaw 的 GenerateRawConfig 构造，
 * 动态内容（任务）压尾部，利于前缀缓存。
 *
 * 纯逻辑零依赖（只拼字符串/对象），可独立单测。
 */

/** 对话消息（多轮上下文：第一次喂完整正文出决策，第二次在同一对话里续——不重复喂正文） */
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** 决策阶段输出 token 上限（只列要更新的路径，几十到几百字符） */
export const DECIDE_MAX_TOKENS = 500;
/** 更新阶段输出 token 上限（JSON Patch 数组，18 个 op 含大 insert 约 2-3k token） */
export const UPDATE_MAX_TOKENS = 3000;
/** 决策阶段规则全文上限（直接喂给模型，不解析——通用化，规则格式不限） */
export const DECIDE_RULES_MAX = 6000;

/**
 * 第一轮【决策】消息（v2.0.8 通用化）：
 *   system = 固定任务指令；user = 完整正文 + 【规则全文】（直接喂，不解析路径，
 *   模型结合剧情自行判断哪些变量相关、哪些标注必须）+ 候选清单（ZOD 变量全集）。
 * 输出格式 = 每行一个【要更新的路径】（只列 Y，不逐项 N）——候选可能是 ZOD 全集
 * （上百条），逐项 Y/N 会拖慢且对弱模型不友好。
 */
export function buildDecideMessages(opts: {
    story: string;
    candidates: string[];
    rules?: string[];
    lastRound?: string;
    last_error?: string;
}): ChatMessage[] {
    const system_parts = [
        '<must>',
        '你是变量更新 Agent。先执行【决策】阶段：基于最近剧情与下方【相关更新规则】，',
        '判断哪些变量需要更新。',
        '输出格式：每行一个【需要更新的】变量路径，不要输出判断后缀：',
        '  世界.当前时间',
        '  主角.修为',
        '要求：',
        '- 仔细阅读规则：规则中标注【必须/每轮/MANDATORY】的变量必须列出，不得遗漏。',
        '- 结合剧情判断事件触发的变量（规则中「发生时更新」的条目）。',
        '- 只写候选清单中的路径（越权写入会被本地引擎拒绝）。',
        '- 全部都不需要更新时，才输出一行：none。',
        '- 不要输出解释，不要输出 <UpdateVariable> 更新块。',
        '</must>',
    ].join('\n');
    const user_parts = ['最近剧情：', opts.story || '（无）'];
    if (opts.lastRound) {
        user_parts.push('', '上一轮更新情况（参考，避免重复/遗漏）：', opts.lastRound);
    }
    if (opts.rules && opts.rules.length > 0) {
        let rules_text = opts.rules.join('\n---\n');
        if (rules_text.length > DECIDE_RULES_MAX) {
            rules_text = rules_text.slice(0, DECIDE_RULES_MAX) + '\n…（规则过长已截断）';
        }
        user_parts.push('', '相关更新规则（判断依据，标注 必须/每轮/MANDATORY 的必须更新）：', rules_text);
    }
    user_parts.push('', '候选清单（全部变量，从其中选择要更新的）：');
    if (opts.candidates.length > 0) {
        for (const path of opts.candidates) {
            user_parts.push(`- ${path}`);
        }
    } else {
        user_parts.push('（无）');
    }
    if (opts.last_error) {
        user_parts.push('', '上次决策未通过校验，原因：' + opts.last_error, '请修正后重新输出。');
    }
    return [
        { role: 'system', content: system_parts },
        { role: 'user', content: user_parts.join('\n') },
    ];
}

/**
 * 第二轮【更新】消息：在同一对话里续——正文已在第一轮上下文，不重复喂。
 *   assistant = 第一轮的决策输出；system = 更新任务指令（结构化/文本格式）；
 *   user = 观察投影 + 相关规则 + 相关背景（启发式构建的背景在此轮追加）。
 * 注意：不重复注入「上一轮更新情况」（lastRound）——它已在第一轮 user 消息里，
 * 而本轮 messages 包含第一轮全部消息，再带一遍就是真重复（v2.0.2 修复）。
 */
export function buildUpdateMessages(opts: {
    prev: ChatMessage[];
    decideOutput: string;
    observation: string;
    rules: string[];
    lore?: string[];
    last_error?: string;
    /** 结构化输出模式（配合 json_schema）：要求模型输出 {analysis, json_patch} JSON */
    structured?: boolean;
}): ChatMessage[] {
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
    const system_parts = [
        '<must>',
        '你是变量更新 Agent。现在执行【更新】阶段：基于上一轮决策与以下「变量观察」，输出变量更新。',
        '剧情已在上下文中，不要重复阅读或复述剧情。',
        opts.structured
            ? '并只输出结构化 JSON，不要输出任何解释或正文。'
            : '并只输出一个 <UpdateVariable> 更新块，不要输出任何解释或正文。',
        ...format_instructions,
        '规则：',
        '- 只更新「变量观察」中列出的变量；不在列表中的变量一律不要写（越权写入会被本地引擎拒绝）。',
        '- 对「变量观察」中的每个变量逐一判断：确实需要更新的，必须写出对应的 op，不要因为数量多而省略。',
        '- 变量路径相对于 stat_data（如 理.好感度），JSON Patch 的 path 为 JSON Pointer（如 /理/好感度）。',
        '- record 动态对象（绝色榜/人物/道侣/灵宠/机遇/玉简/动向/储物袋/功法/器物/气运）：必须用【对象键】操作（如 /绝色榜/角色名、/人物/角色名/好感度），严禁数组索引与整体 replace。',
        '- 初始化新条目：先 insert 空对象（如 /人物/角色名: {}），再 replace 填各子字段。',
        '- 若本轮无需更新任何变量，输出空数组：[]（structured 模式）或空块：<UpdateVariable></UpdateVariable>（文本模式）。',
        '</must>',
    ].join('\n');
    const user_parts = ['变量观察：', opts.observation || '（无）'];
    if (opts.rules.length > 0) {
        user_parts.push('', '相关更新规则：', opts.rules.join('\n---\n'));
    }
    if (opts.lore && opts.lore.length > 0) {
        user_parts.push('', '相关世界书背景（理解世界用，不是更新规则）：', opts.lore.join('\n---\n'));
    }
    // 不重复注入 lastRound（已在第一轮 user 消息里，本轮 messages 包含第一轮全部）
    if (opts.last_error) {
        user_parts.push('', '上次输出未通过本地校验，原因：' + opts.last_error, '请修正后重新输出。');
    }
    return [
        ...opts.prev,
        { role: 'assistant', content: opts.decideOutput },
        { role: 'system', content: system_parts },
        { role: 'user', content: user_parts.join('\n') },
    ];
}

/** 把多轮消息构造为 generateRaw 配置（消息即 ordered_prompts，末尾 user 触发生成） */
export function buildMessagesRawConfig(opts: {
    messages: ChatMessage[];
    custom_api?: Record<string, any>;
    json_schema?: object;
    max_tokens?: number;
}): Record<string, any> {
    const config: Record<string, any> = {
        should_stream: false,
        max_tokens: opts.max_tokens ?? UPDATE_MAX_TOKENS,
        ordered_prompts: opts.messages.map(m => ({ role: m.role, content: m.content })),
    };
    if (opts.custom_api) {
        config.custom_api = opts.custom_api;
    }
    if (opts.json_schema) {
        config.json_schema = opts.json_schema;
    }
    return config;
}

/** 构造决策阶段 generateRaw 配置（纯文本，不结构化；限 max_tokens 防长输出） */
export function buildDecideRawConfig(opts: {
    task: string;
    custom_api?: Record<string, any>;
    ordered_prompts?: (string | { role: string; content: string })[];
    max_tokens?: number;
    /** 结构化输出 schema（分池等任务用，ST 自动按 provider 转换） */
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
        max_tokens: opts.max_tokens ?? DECIDE_MAX_TOKENS,
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

/**
 * AI 规则分池的结构化输出 schema（v1.12.2）：
 * 输出 {classification: [{idx, paths, mandatory, topic}]}——结构化保证解析成功率。
 */
export function createAiClassifySchema(): object {
    return {
        name: 'nlkaleido_ai_classify',
        description:
            'classify worldbook update rules into managed variable paths. Return one entry per rule.',
        strict: false,
        value: {
            type: 'object',
            additionalProperties: false,
            properties: {
                classification: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            idx: { type: 'integer' },
                            paths: { type: 'array', items: { type: 'string' } },
                            mandatory: { type: 'array', items: { type: 'string' } },
                            topic: { type: 'string' },
                        },
                        required: ['idx', 'paths'],
                    },
                },
            },
            required: ['classification'],
        },
    };
}

/** 更新阶段提示词：基于剧情 + 观察 + 规则产出 delta（一步 agent 回合） */
export function buildAgentUpdateTask(opts: {
    story: string;
    observation: string;
    rules: string[];
    lore?: string[];
    lastRound?: string;
    last_error?: string;
    /** 结构化输出模式（配合 json_schema）：要求模型输出 {analysis, json_patch} JSON */
    structured?: boolean;
}): string {
    // 兼容旧单轮调用（多轮消息见 buildUpdateMessages）；剧情仍拼入（旧调用方）
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
        '- 对「变量观察」中的每个变量逐一判断：确实需要更新的，必须写出对应的 op，不要因为数量多而省略。',
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
    if (opts.lore && opts.lore.length > 0) {
        parts.push('', '相关世界书背景（理解世界用，不是更新规则）：', opts.lore.join('\n---\n'));
    }
    if (opts.lastRound) {
        parts.push('', '上一轮更新情况（参考，避免重复/遗漏）：', opts.lastRound);
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
                    maxLength: 200,
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
    max_tokens?: number;
}): Record<string, any> {
    const ordered_prompts: (string | { role: string; content: string })[] = opts.ordered_prompts
        ? [...opts.ordered_prompts]
        : [];
    ordered_prompts.push({ role: 'system', content: opts.task });
    ordered_prompts.push('user_input');
    const config: Record<string, any> = {
        user_input: '遵循<must>指令',
        should_stream: false,
        max_tokens: opts.max_tokens ?? UPDATE_MAX_TOKENS,
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
