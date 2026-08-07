import {
    applyAgentToolToGenerateData,
    buildAgentFormatEmphasis,
    createAgentToolDefinition,
    createAgentUpdateToolSchema,
    shouldInjectAgentTool,
} from '@/innovation/agent_update';

describe('innovation agent_update (纯逻辑)', () => {
    describe('createAgentUpdateToolSchema', () => {
        test('构造符合要求的结构：object + delta required', () => {
            const schema = createAgentUpdateToolSchema();
            expect(schema.type).toBe('object');
            expect(schema.additionalProperties).toBe(false);
            expect(schema.properties.delta.type).toBe('string');
            expect(schema.required).toContain('delta');
        });
    });

    describe('buildAgentFormatEmphasis', () => {
        test('包含正文完整 + 末尾调用工具的强调', () => {
            const text = buildAgentFormatEmphasis('nlkaleido_agentUpdate_x');
            expect(text).toContain('nlkaleido_agentUpdate_x');
            expect(text).toContain('完整');
            expect(text).toContain('末尾');
            expect(text).toContain('<must>');
            expect(text).toContain('</must>');
        });
    });

    describe('shouldInjectAgentTool', () => {
        test('agent 模式开启且非额外模型解析期间 → 注入', () => {
            expect(shouldInjectAgentTool(true, false, [])).toBe(true);
        });

        test('agent 模式关闭 → 不注入', () => {
            expect(shouldInjectAgentTool(false, false, [])).toBe(false);
        });

        test('额外模型解析期间 → 不注入（避免干扰 required 工具流程）', () => {
            expect(shouldInjectAgentTool(true, true, [])).toBe(false);
        });
    });

    describe('createAgentToolDefinition', () => {
        test('构造 ST 兼容 tool definition', () => {
            const def: any = createAgentToolDefinition('nlkaleido_agentUpdate_abc');
            expect(def.type).toBe('function');
            expect(def.function.name).toBe('nlkaleido_agentUpdate_abc');
            expect(def.function.parameters.type).toBe('object');
        });
    });

    describe('applyAgentToolToGenerateData', () => {
        test('注入工具 + 设置 tool_choice=required，返回 true', () => {
            const generate_data: Record<string, any> = {};
            const ok = applyAgentToolToGenerateData(generate_data, 'nlkaleido_agentUpdate_x', {
                is_agent_mode: true,
                is_during_extra_analysis: false,
            });
            expect(ok).toBe(true);
            expect(generate_data.tools).toHaveLength(1);
            expect((generate_data.tools as any[])[0].function.name).toBe(
                'nlkaleido_agentUpdate_x'
            );
            expect(generate_data.tool_choice).toBe('required');
        });

        test('已有同名单时不重复添加', () => {
            const generate_data: Record<string, any> = {
                tools: [{ type: 'function', function: { name: 'nlkaleido_agentUpdate_x' } }],
            };
            applyAgentToolToGenerateData(generate_data, 'nlkaleido_agentUpdate_x', {
                is_agent_mode: true,
                is_during_extra_analysis: false,
            });
            expect(generate_data.tools).toHaveLength(1);
        });

        test('非 agent 模式时不修改 generate_data，返回 false', () => {
            const generate_data: Record<string, any> = {};
            const ok = applyAgentToolToGenerateData(generate_data, 'nlkaleido_agentUpdate_x', {
                is_agent_mode: false,
                is_during_extra_analysis: false,
            });
            expect(ok).toBe(false);
            expect(generate_data.tools).toBeUndefined();
        });
    });
});
