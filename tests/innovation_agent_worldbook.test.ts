import {
    entryMentionsPath,
    isPlotEntry,
    isUpdateRuleEntry,
    pickUpdateWorldbookNames,
    selectRelevantLore,
    selectUpdateRules,
    splitRulePlotEntries,
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

    test('标记写在条目标题（name）也能识别（v1.11.1 修复）', () => {
        expect(isUpdateRuleEntry({ name: '[mvu_update] 好感度规则', content: '每天更新', enabled: true })).toBe(true);
        expect(isPlotEntry({ name: '[mvu_plot] 森林传说', content: '背景', enabled: true })).toBe(true);
    });

    test('名字叫「规则」但无标记的背景不算规则（v1.11.1 修复）', () => {
        expect(isUpdateRuleEntry({ name: '规则', content: '森林的传说背景', enabled: true })).toBe(false);
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

describe('splitRulePlotEntries（世界书读了再读更新规则的分拣）', () => {
    test('三类分拣 + 禁用条目排除', () => {
        const entries = [
            update_entry('[mvu_update] 规则A'),
            { ...update_entry('[mvu_update] 规则B'), enabled: false },
            update_entry('[mvu_plot] 剧情A'),
            update_entry('普通背景A'),
            { ...update_entry('[mvu_plot] 剧情B'), enabled: false },
        ];
        const { rules, plot, others } = splitRulePlotEntries(entries);
        expect(rules).toHaveLength(1);
        expect(rules[0].content).toContain('规则A');
        expect(plot).toHaveLength(1);
        expect(others).toHaveLength(1);
        expect(others[0].content).toContain('背景A');
    });

    test('空输入返回空三类', () => {
        expect(splitRulePlotEntries([])).toEqual({ rules: [], plot: [], others: [] });
    });
});

describe('selectRelevantLore（按需世界书背景）', () => {
    const lore = [
        { name: '森林', content: '这片森林很神圣，好感度相关的传说很多', enabled: true },
        { name: '城邦', content: '城邦的贸易规则', enabled: true },
        { name: '好感', content: '关于好感度的世界背景', enabled: true },
        { name: '时间', content: '时间相关的背景', enabled: true },
    ];

    test('只取与候选路径相关的背景', () => {
        const result = selectRelevantLore(lore, ['理.好感度']);
        expect(result.length).toBe(2); // 森林 + 好感（都提到好感度）
        expect(result.every(r => r.includes('好感度'))).toBe(true);
    });

    test('限制条数与截断', () => {
        const long = { name: '好感', content: '好感度背景' + 'x'.repeat(5000), enabled: true };
        const result = selectRelevantLore([long], ['理.好感度'], 1, 100);
        expect(result).toHaveLength(1);
        expect(result[0]).toContain('…');
        // 条目名前缀 + 截断内容 + 省略号
        expect(result[0].length).toBeLessThanOrEqual(110);
    });

    test('带条目名前缀', () => {
        const result = selectRelevantLore(lore.slice(2, 3), ['理.好感度']);
        expect(result[0]).toContain('好感：');
    });

    test('无候选返回空', () => {
        expect(selectRelevantLore(lore, [])).toEqual([]);
    });
});
