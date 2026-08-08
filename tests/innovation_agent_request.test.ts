import {
    buildCheckRawConfig,
    buildCheckTask,
    buildUpdateRawConfig,
    buildUpdateTask,
    normalizeGenerateText,
} from '@/innovation/agent_request';

describe('buildCheckTask', () => {
    test('包含检查指令与状态', () => {
        const task = buildCheckTask('{"a":1}');
        expect(task).toContain('检查');
        expect(task).toContain('不要输出任何 <UpdateVariable>');
        expect(task).toContain('{"a":1}');
    });
});

describe('buildUpdateTask', () => {
    test('包含规则与检查结果', () => {
        const task = buildUpdateTask(['rule1', 'rule2'], 'a: Y');
        expect(task).toContain('<UpdateVariable>');
        expect(task).toContain('rule1');
        expect(task).toContain('a: Y');
    });

    test('自检失败原因会被喂回', () => {
        const task = buildUpdateTask([], 'a: Y', '更新块内没有有效更新命令');
        expect(task).toContain('更新块内没有有效更新命令');
    });
});

describe('buildCheckRawConfig', () => {
    test('默认配置结构', () => {
        const config = buildCheckRawConfig({ state_text: 'state' });
        expect(config.user_input).toBe('遵循<must>指令');
        expect(config.max_chat_history).toBe(2);
        expect(config.should_stream).toBe(false);
        expect(Array.isArray(config.ordered_prompts)).toBe(true);
        expect(config.ordered_prompts.at(-1)).toBe('user_input');
        // 任务在尾部（动态内容压尾部）
        expect(config.ordered_prompts.at(-2).content).toContain('检查');
    });

    test('支持 custom_api 与自定义 ordered_prompts 前缀', () => {
        const config = buildCheckRawConfig({
            state_text: 's',
            custom_api: { apiurl: 'http://x', model: 'm' },
            ordered_prompts: ['chat_history'],
        });
        expect(config.custom_api).toEqual({ apiurl: 'http://x', model: 'm' });
        expect(config.ordered_prompts[0]).toBe('chat_history');
    });
});

describe('buildUpdateRawConfig', () => {
    test('更新配置包含规则与检查文本', () => {
        const config = buildUpdateRawConfig({
            rules: ['r1'],
            check_raw: 'a: Y',
        });
        expect(config.ordered_prompts.at(-2).content).toContain('r1');
        expect(config.ordered_prompts.at(-2).content).toContain('a: Y');
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

    test('非法输入返回空串', () => {
        expect(normalizeGenerateText(null)).toBe('');
        expect(normalizeGenerateText(123)).toBe('');
        expect(normalizeGenerateText({})).toBe('');
    });
});
