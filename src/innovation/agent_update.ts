/**
 * [革新版·Agent 更新] 纯逻辑模块：主模型流内 tool_call 更新变量的实验设计。
 *
 * 目标：验证 ST 1.17 下，主模型在同一流里输出正文 + tool_call 更新变量是否可行，
 * 以区别于现有「额外模型单独 generate 触发 required 工具」的折衷方案。
 *
 * 本模块只含纯逻辑（可单测）；运行时注册/事件挂载见 agent_update_bridge.ts。
 * 不修改任何原版文件；独立工具名避免与原版 mvu_VariableUpdate 冲突。
 */

/** Agent 更新工具的独立名称前缀（桥接层会拼上 scriptId 以隔离多实例） */
export const AGENT_UPDATE_FUNCTION_PREFIX = 'nlkaleido_agentUpdate';

/**
 * 构造 Agent 更新工具的 JSON Schema。
 * 与原版 mvu_update_schema 类似，但只要求 delta（更新块），analysis 可选。
 */
export interface AgentUpdateToolSchema {
    $schema: string;
    type: 'object';
    additionalProperties: false;
    properties: {
        analysis: {
            type: 'string';
            minLength: 1;
            description: string;
        };
        delta: {
            type: 'string';
            minLength: 0;
            description: string;
        };
    };
    required: ['delta'];
}

export function createAgentUpdateToolSchema(): AgentUpdateToolSchema {
    return {
        $schema: 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        additionalProperties: false,
        properties: {
            analysis: {
                type: 'string',
                minLength: 1,
                description:
                    'Write in ENGLISH. Compact reasoning: list each variable to update and why (no contents).',
            },
            delta: {
                type: 'string',
                minLength: 0,
                description:
                    'variable update block, in MVU command dialect (_.set(...) etc.) or JsonPatch block.',
            },
        },
        required: ['delta'],
    };
}

/**
 * 生成给主模型的格式强调指令。
 * 这是万花筒核心挑战的答案：通过外部格式强调让主模型在 required/auto 下
 * 输出完整正文 + 末尾调用工具，避免肘掉正文。
 *
 * @param tool_name 工具名
 * @returns 应注入到 system 的格式强调文本
 */
export function buildAgentFormatEmphasis(tool_name: string): string {
    return [
        '<must>',
        '你必须在回复中输出完整、自然的剧情正文（不得省略、不得只输出工具调用）。',
        `若需要更新变量，请在正文**末尾**调用 \`${tool_name}\` 工具；不需要更新变量则不要调用。`,
        '正文与工具调用可同时存在：先写完整正文，再调用工具。',
        '</must>',
    ].join('\n');
}

/**
 * 判断是否应注入 Agent 工具到主模型请求。
 * @param is_agent_mode 革新版 Agent 更新开关
 * @param is_during_extra_analysis 当前是否处于额外模型解析期间（此时不应叠加主模型工具）
 * @param existing_tools 主请求已有的 tools 数组（可为空）
 */
export function shouldInjectAgentTool(
    is_agent_mode: boolean,
    is_during_extra_analysis: boolean,
    existing_tools: unknown[] | undefined
): boolean {
    if (!is_agent_mode) return false;
    // 额外模型解析期间不要干扰其 required 工具流程
    if (is_during_extra_analysis) return false;
    // 主模型已有其它工具时（如 ST 内建），仍可叠加（tool 名唯一即可）；这里不做拦截
    void existing_tools;
    return true;
}

/**
 * 构造注入用的 tool definition（兼容 ST ToolDefinition 形状）。
 * @param tool_name 唯一工具名（含 scriptId）
 */
export function createAgentToolDefinition(tool_name: string): unknown {
    return {
        type: 'function',
        function: {
            name: tool_name,
            description: 'use this tool to UpdateVariable from the main response stream.',
            parameters: createAgentUpdateToolSchema(),
        },
    };
}

/**
 * 在 ST generate_data 上叠加 Agent 工具与格式强调。
 * @param generate_data ST 的 generate_data 对象（会被原地修改）
 * @param tool_name 工具名
 * @param opts 注入选项
 */
export function applyAgentToolToGenerateData(
    generate_data: Record<string, any>,
    tool_name: string,
    opts: {
        is_agent_mode: boolean;
        is_during_extra_analysis: boolean;
        tool_choice?: 'auto' | 'required';
    }
): boolean {
    if (
        !shouldInjectAgentTool(
            opts.is_agent_mode,
            opts.is_during_extra_analysis,
            generate_data.tools
        )
    ) {
        return false;
    }

    const tools = Array.isArray(generate_data.tools) ? generate_data.tools : [];
    const tool_def = createAgentToolDefinition(tool_name);
    const already = tools.some((t: any) => t?.function?.name === tool_name);
    if (!already) {
        tools.push(tool_def);
        generate_data.tools = tools;
    }
    // 实验：优先 required 以验证「不肘正文 + 工具共存」；可切 auto
    generate_data.tool_choice = opts.tool_choice ?? 'required';
    return true;
}
