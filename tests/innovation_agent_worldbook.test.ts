import {
    entryMentionsPath,
    isPlotEntry,
    isUpdateRuleEntry,
    pickUpdateWorldbookNames,
    selectUpdateRules,
} from '@/innovation/agent_worldbook';

const update_entry = (content: string, world = 'wb') => ({
    name: 'rule',
    enabled: true,
    content,
    world,
});

describe('isUpdateRuleEntry / isPlotEntry', () => {
    test('识别 [mvu_update]', () => {
        expect(isUpdateRuleEntry(update_entry('[mvu_update] 变量更新规则'))).toBe(true);
        expect(isUpdateRuleEntry(update_entry('普通条目'))).toBe(false);
    });

    test('识别 [mvu_plot]', () => {
        expect(isPlotEntry(update_entry('[mvu_plot] 剧情'))).toBe(true);
        expect(isPlotEntry(update_entry('普通'))).toBe(false);
    });
});

describe('entryMentionsPath', () => {
    test('内容包含路径段', () => {
        expect(entryMentionsPath(update_entry('关于 好感度 的规则'), 'stat_data.理.好感度')).toBe(true);
    });

    test('不相关返回 false', () => {
        expect(entryMentionsPath(update_entry('关于 剧情 的规则'), 'stat_data.理.好感度')).toBe(false);
    });

    test('空路径/空文本返回 false', () => {
        expect(entryMentionsPath(update_entry('x'), '')).toBe(false);
        expect(entryMentionsPath({ content: '' }, 'a')).toBe(false);
    });
});

describe('selectUpdateRules', () => {
    const entries = [
        update_entry('[mvu_update] 好感度规则'),
        update_entry('[mvu_update] 心情规则'),
        update_entry('[mvu_plot] 剧情条目'),
        update_entry('普通条目'),
    ];

    test('只保留 [mvu_update]，排除 plot 与普通', () => {
        const result = selectUpdateRules(entries);
        expect(result.entries.length).toBe(2);
        expect(result.entries.every(e => e.includes('[mvu_update]'))).toBe(true);
        expect(result.matched).toBe(2);
        expect(result.total).toBe(4);
    });

    test('按路径裁剪相关规则', () => {
        const result = selectUpdateRules(entries, ['stat_data.理.好感度']);
        expect(result.entries.length).toBe(1);
        expect(result.entries[0]).toContain('好感度');
        expect(result.fell_back).toBe(false);
    });

    test('无路径匹配时回退全量', () => {
        const result = selectUpdateRules(entries, ['stat_data.不存在.路径']);
        expect(result.entries.length).toBe(2);
        expect(result.fell_back).toBe(true);
    });

    test('无 [mvu_update] 条目时返回空', () => {
        const result = selectUpdateRules([update_entry('普通')]);
        expect(result.entries).toEqual([]);
        expect(result.matched).toBe(0);
    });

    test('单条超长截断', () => {
        const long = 'x'.repeat(100);
        const result = selectUpdateRules([update_entry(`[mvu_update] ${long}`)], [], 50);
        expect(result.entries[0].length).toBeLessThanOrEqual(50);
    });
});

describe('pickUpdateWorldbookNames', () => {
    test('按名称筛选相关世界书', () => {
        expect(pickUpdateWorldbookNames(['mvu更新规则', '剧情世界', '变量卡'])).toEqual([
            'mvu更新规则',
            '变量卡',
        ]);
    });
});
