import {
    buildDecideMessages,
    buildMessagesRawConfig,
    buildUpdateMessages,
    createJsonPatchResponseSchema,
    normalizeGenerateText,
} from '@/innovation/agent_request';

describe('buildDecideMessages（第一轮：完整正文 + 规则全文直喂）', () => {
    test('system 固定任务 + user 完整正文/候选清单', () => {
        const messages = buildDecideMessages({
            story: '剧情文本',
            candidates: ['理.好感度', '世界.时间'],
        });
        expect(messages).toHaveLength(2);
        expect(messages[0].role).toBe('system');
        // v2.0.8 输出格式：只列 Y 路径（不逐项 Y/N——候选可能是 ZOD 全集上百条）
        expect(messages[0].content).toContain('每行一个【需要更新的】变量路径');
        expect(messages[0].content).toContain('标注【必须/每轮/MANDATORY】的变量必须列出');
        expect(messages[0].content).toContain('none');
        expect(messages[1].role).toBe('user');
        expect(messages[1].content).toContain('最近剧情');
        expect(messages[1].content).toContain('剧情文本');
        expect(messages[1].content).toContain('理.好感度');
    });

    test('规则全文直接喂入（不解析规则→路径，通用化）', () => {
        const messages = buildDecideMessages({
            story: '',
            candidates: ['世界.绝色榜'],
            rules: ['强制更新（每回合必须更新）: 绝色榜', '事件触发: 主角.修为'],
        });
        expect(messages[1].content).toContain('相关更新规则（判断依据');
        expect(messages[1].content).toContain('强制更新（每回合必须更新）: 绝色榜');
        expect(messages[1].content).toContain('事件触发: 主角.修为');
    });

    test('规则全文超长截断', () => {
        const long = '规则'.repeat(7000);
        const messages = buildDecideMessages({
            story: '',
            candidates: [],
            rules: [long],
        });
        expect(messages[1].content).toContain('规则过长已截断');
    });

    test('跨轮上下文（上一轮更新情况）与失败原因注入 user', () => {
        const messages = buildDecideMessages({
            story: '',
            candidates: ['a.b'],
            lastRound: '更新了 1 个变量：a.b',
            last_error: '决策路径不存在',
        });
        expect(messages[1].content).toContain('上一轮更新情况');
        expect(messages[1].content).toContain('更新了 1 个变量：a.b');
        expect(messages[1].content).toContain('决策路径不存在');
    });
});

describe('buildUpdateMessages（第二轮：同一对话里续，不重复喂正文）', () => {
    const prev = buildDecideMessages({ story: '剧情文本', candidates: ['理.好感度'] });

    test('消息序列：第一轮 + assistant 决策输出 + system 更新任务 + user 观察/规则/背景', () => {
        const messages = buildUpdateMessages({
            prev,
            decideOutput: '理.好感度: Y',
            observation: '<Observation>\n- 理.好感度: 42\n</Observation>',
            rules: ['rule1'],
            lore: ['森林的传说：好感度神圣'],
        });
        expect(messages.length).toBe(prev.length + 3);
        // 上下文延续：第一轮的 user 剧情还在消息里，但更新轮【不新增】剧情内容
        expect(messages[0].content).toContain('需要更新的】变量路径');
        expect(messages[1].content).toContain('剧情文本');
        // assistant 携带决策输出
        expect(messages[2].role).toBe('assistant');
        expect(messages[2].content).toBe('理.好感度: Y');
        // system 更新任务明确说明剧情已在上下文
        expect(messages[3].role).toBe('system');
        expect(messages[3].content).toContain('剧情已在上下文中，不要重复阅读或复述剧情');
        // user 观察/规则/背景（启发式构建的背景在此轮追加）
        expect(messages[4].role).toBe('user');
        expect(messages[4].content).toContain('理.好感度: 42');
        expect(messages[4].content).toContain('rule1');
        expect(messages[4].content).toContain('森林的传说：好感度神圣');
    });

    test('结构化模式要求 JSON 输出', () => {
        const messages = buildUpdateMessages({
            prev,
            decideOutput: 'x',
            observation: '',
            rules: [],
            structured: true,
        });
        expect(messages[3].content).toContain('结构化 JSON');
        expect(messages[3].content).toContain('json_patch');
        expect(messages[3].content).not.toContain('格式A');
    });

    test('越权边界与失败原因喂回', () => {
        const messages = buildUpdateMessages({
            prev,
            decideOutput: 'x',
            observation: '',
            rules: [],
            last_error: '越权路径',
        });
        expect(messages[3].content).toContain('越权写入会被本地引擎拒绝');
        expect(messages[4].content).toContain('越权路径');
    });
});

describe('buildMessagesRawConfig（多轮消息 → generateRaw 配置）', () => {
    test('ordered_prompts 为消息序列，末尾 user 触发生成', () => {
        const messages = buildDecideMessages({ story: 's', candidates: ['a.b'] });
        const config = buildMessagesRawConfig({ messages, max_tokens: 500 });
        expect(config.should_stream).toBe(false);
        expect(config.max_tokens).toBe(500);
        expect(config.ordered_prompts).toHaveLength(2);
        expect(config.ordered_prompts[0]).toEqual({ role: 'system', content: expect.any(String) });
        expect(config.ordered_prompts[1]).toEqual({ role: 'user', content: expect.any(String) });
        expect(config.ordered_prompts.at(-1).role).toBe('user');
    });

    test('支持 custom_api 与 json_schema', () => {
        const schema = createJsonPatchResponseSchema();
        const config = buildMessagesRawConfig({
            messages: buildDecideMessages({ story: '', candidates: [] }),
            custom_api: { apiurl: 'http://x' },
            json_schema: schema,
        });
        expect(config.custom_api).toEqual({ apiurl: 'http://x' });
        expect(config.json_schema).toBe(schema);
    });
});

describe('normalizeGenerateText', () => {
    test('字符串原样返回', () => {
        expect(normalizeGenerateText('hello')).toBe('hello');
    });

    test('tool_calls 提取 delta', () => {
        const result = normalizeGenerateText({
            content: '',
            tool_calls: [
                {
                    type: 'function',
                    function: { name: 'x', arguments: '{"delta":"_.set(\'a\',1);"}' },
                },
            ],
        });
        expect(result).toContain('_.set');
    });

    test('tool_calls 提取结构化 json_patch 数组', () => {
        const result = normalizeGenerateText({
            content: '',
            tool_calls: [
                {
                    type: 'function',
                    function: {
                        name: 'x',
                        arguments: '{"analysis":"a","json_patch":[{"op":"replace","path":"/理/好感度","value":50}]}',
                    },
                },
            ],
        });
        expect(result).toContain('"op":"replace"');
        expect(result).not.toContain('json_patch');
    });

    test('非法输入返回空串', () => {
        expect(normalizeGenerateText(null)).toBe('');
        expect(normalizeGenerateText(123)).toBe('');
        expect(normalizeGenerateText({})).toBe('');
    });
});
