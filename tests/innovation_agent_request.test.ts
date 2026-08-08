import {
    buildAgentUpdateRawConfig,
    buildAgentUpdateTask,
    buildDecideRawConfig,
    buildDecideTask,
    createJsonPatchResponseSchema,
    normalizeGenerateText,
    squashStory,
} from '@/innovation/agent_request';

describe('squashStory（剧情压缩，万花筒 §5.4 L3 squash 下放）', () => {
    test('相邻同发件人消息合并去重前缀', () => {
        const story = '角色A：第一句\n角色A：第二句\n角色B：另一句';
        const out = squashStory(story);
        expect(out).toContain('角色A：第一句 第二句');
        expect(out).not.toContain('角色A：第二句\n');
        expect(out).toContain('角色B：另一句');
    });

    test('截断到上限', () => {
        const story = '角色A：' + 'x'.repeat(500);
        const out = squashStory(story, 200);
        expect(out.length).toBeLessThanOrEqual(210);
        expect(out).toContain('剧情压缩截断');
    });

    test('不同发件人不合并，空输入返回空', () => {
        const story = 'A：1\nB：2\nA：3';
        expect(squashStory(story)).toBe('A：1\nB：2\nA：3');
        expect(squashStory('')).toBe('');
    });
});

describe('buildDecideTask', () => {
    test('包含剧情、候选清单与决策指令', () => {
        const task = buildDecideTask({ story: '剧情文本', candidates: ['理.好感度', '世界.时间'] });
        expect(task).toContain('最近剧情');
        expect(task).toContain('剧情文本');
        expect(task).toContain('候选清单');
        expect(task).toContain('理.好感度');
        expect(task).toContain('世界.时间');
        expect(task).toContain('none');
    });

    test('必须逐项判断（防偷懒）', () => {
        const task = buildDecideTask({ story: '', candidates: ['a.b'] });
        expect(task).toContain('逐项判断，不得省略任何一行');
        expect(task).toContain('路径: Y');
        expect(task).toContain('路径: N');
    });

    test('禁止写候选外路径与更新块', () => {
        const task = buildDecideTask({ story: '', candidates: ['a.b'] });
        expect(task).toContain('候选清单之外的路径');
        expect(task).toContain('不要输出 <UpdateVariable> 更新块');
    });

    test('强制更新路径标注 MANDATORY（防偷懒）', () => {
        const task = buildDecideTask({
            story: '',
            candidates: ['世界.绝色榜', '主角.修为'],
            mandatory: ['世界.绝色榜'],
        });
        expect(task).toContain('世界.绝色榜  ← MANDATORY：必须更新，不得输出 N');
        expect(task).not.toContain('主角.修为  ←');
    });

    test('跨轮上下文（上一轮更新情况）注入', () => {
        const task = buildDecideTask({
            story: '',
            candidates: ['a.b'],
            lastRound: '更新了 1 个变量：a.b',
        });
        expect(task).toContain('上一轮更新情况');
        expect(task).toContain('更新了 1 个变量：a.b');
        const update_task = buildAgentUpdateTask({
            story: '',
            observation: '',
            rules: [],
            lastRound: '上轮无实际更新',
        });
        expect(update_task).toContain('上一轮更新情况');
    });

    test('失败原因会被喂回', () => {
        const task = buildDecideTask({ story: '', candidates: [], last_error: '决策路径不存在' });
        expect(task).toContain('决策路径不存在');
    });
});

describe('buildDecideRawConfig', () => {
    test('默认配置结构：任务在尾部，user_input 收尾，限 max_tokens', () => {
        const config = buildDecideRawConfig({ task: 'TASK' });
        expect(config.user_input).toBe('遵循<must>指令');
        expect(config.should_stream).toBe(false);
        expect(config.max_tokens).toBe(500);
        expect(config.ordered_prompts.at(-1)).toBe('user_input');
        expect(config.ordered_prompts.at(-2).content).toContain('TASK');
    });

    test('支持 custom_api 与自定义 ordered_prompts 前缀', () => {
        const config = buildDecideRawConfig({
            task: 'T',
            custom_api: { apiurl: 'http://x' },
            ordered_prompts: ['chat_history'],
        });
        expect(config.custom_api).toEqual({ apiurl: 'http://x' });
        expect(config.ordered_prompts[0]).toBe('chat_history');
    });
});

describe('buildAgentUpdateTask', () => {
    test('包含剧情、观察与规则', () => {
        const task = buildAgentUpdateTask({
            story: '剧情文本',
            observation: '<Observation>\n- 理.好感度: 42\n</Observation>',
            rules: ['rule1', 'rule2'],
        });
        expect(task).toContain('最近剧情');
        expect(task).toContain('剧情文本');
        expect(task).toContain('理.好感度');
        expect(task).toContain('rule1');
        expect(task).toContain('rule2');
    });

    test('越权边界指令存在', () => {
        const task = buildAgentUpdateTask({ story: '', observation: '', rules: [] });
        expect(task).toContain('越权写入会被本地引擎拒绝');
        expect(task).toContain('<UpdateVariable>');
        expect(task).toContain('JSON Patch');
    });

    test('校验失败原因会被喂回', () => {
        const task = buildAgentUpdateTask(
            { story: '', observation: '', rules: [], last_error: '越权路径' },
        );
        expect(task).toContain('越权路径');
    });

    test('包含相关世界书背景（世界书读了再读更新规则）', () => {
        const task = buildAgentUpdateTask({
            story: '',
            observation: '',
            rules: ['rule1'],
            lore: ['森林的传说：好感度神圣'],
        });
        expect(task).toContain('相关世界书背景');
        expect(task).toContain('森林的传说：好感度神圣');
    });

    test('structured 模式要求结构化 JSON 输出', () => {
        const task = buildAgentUpdateTask({ story: '', observation: '', rules: [], structured: true });
        expect(task).toContain('结构化 JSON');
        expect(task).toContain('json_patch');
        expect(task).toContain('[]（structured 模式）');
        expect(task).not.toContain('格式A');
    });
});

describe('createJsonPatchResponseSchema', () => {
    test('形状与 op 方言正确', () => {
        const schema: any = createJsonPatchResponseSchema();
        expect(schema.name).toBe('nlkaleido_agent_patch');
        expect(schema.value.type).toBe('object');
        expect(schema.value.required).toEqual(['analysis', 'json_patch']);
        const op_any_of = schema.value.properties.json_patch.items.anyOf;
        expect(op_any_of.length).toBe(6);
        expect(op_any_of[1].properties.op.enum).toEqual(['delta']);
        expect(op_any_of[0].properties.op.enum).toEqual(['replace']);
    });
});

describe('buildAgentUpdateRawConfig', () => {
    test('默认配置结构：任务在尾部，user_input 收尾，限 max_tokens', () => {
        const config = buildAgentUpdateRawConfig({ task: 'TASK' });
        expect(config.user_input).toBe('遵循<must>指令');
        expect(config.should_stream).toBe(false);
        expect(config.max_tokens).toBe(3000);
        expect(Array.isArray(config.ordered_prompts)).toBe(true);
        expect(config.ordered_prompts.at(-1)).toBe('user_input');
        // 动态任务压尾部，利于前缀缓存
        expect(config.ordered_prompts.at(-2).content).toContain('TASK');
    });

    test('支持 custom_api 与自定义 ordered_prompts 前缀', () => {
        const config = buildAgentUpdateRawConfig({
            task: 'T',
            custom_api: { apiurl: 'http://x', model: 'm' },
            ordered_prompts: ['chat_history'],
        });
        expect(config.custom_api).toEqual({ apiurl: 'http://x', model: 'm' });
        expect(config.ordered_prompts[0]).toBe('chat_history');
    });

    test('支持 json_schema 结构化输出', () => {
        const schema = createJsonPatchResponseSchema();
        const config = buildAgentUpdateRawConfig({ task: 'T', json_schema: schema });
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
