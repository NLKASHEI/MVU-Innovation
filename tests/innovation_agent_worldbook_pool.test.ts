import {
    buildWorldbookPool,
    parseAiClassification,
    poolQueryLoreByPaths,
    poolQueryRulesByPaths,
} from '@/innovation/agent_worldbook_pool';

const rule_entry = (content: string, strategy?: { type?: string; keys?: (string | RegExp)[] }) => ({
    name: 'rule',
    enabled: true,
    content,
    strategy,
});

const background_entry = (name: string, content: string, strategy?: { type?: string; keys?: (string | RegExp)[] }) => ({
    name,
    enabled: true,
    content,
    strategy,
});

describe('buildWorldbookPool（初始化分类 + 索引）', () => {
    test('按标记分类：规则/剧情/其他，禁用条目排除', () => {
        const pool = buildWorldbookPool([
            rule_entry('[mvu_update] 好感度规则'),
            rule_entry('[mvu_plot] 剧情背景'),
            { name: 'x', enabled: true, content: '普通背景' },
            { name: 'y', enabled: false, content: '[mvu_update] 禁用的规则' },
            { name: 'z', content: '[mvu_update] 无 enabled 字段' },
        ]);
        expect(pool.rules.map(r => r.content)).toEqual([
            '[mvu_update] 好感度规则',
            '[mvu_update] 无 enabled 字段',
        ]);
        expect(pool.entries).toHaveLength(4);
    });

    test('灯效状态：constant/selective/vectorized 计数与 keys 记录', () => {
        const pool = buildWorldbookPool([
            rule_entry('[mvu_update] 蓝灯规则', { type: 'constant' }),
            background_entry('绿', '绿色背景', { type: 'selective', keys: ['好感度'] }),
            background_entry('向', '向量', { type: 'vectorized' }),
        ]);
        expect(pool.strategyCount).toEqual({ constant: 1, selective: 1, vectorized: 1 });
        expect(pool.entries[1].keys).toEqual(['好感度']);
    });

    test('无 AI 分池时 rulePaths 为空（v1.11.4 无正则提取）', () => {
        const pool = buildWorldbookPool([
            rule_entry("[mvu_update] _.set('主角.境界', 1); 每当 主角.道心 降低时"),
        ]);
        // 正则已彻底删除：规则→路径只来自 AI 分池（aiByIndex）
        expect(pool.rulePaths).toEqual([]);
        expect(pool.rulePathToRules.size).toBe(0);
        expect(pool.aiMerged).toBe(false);
    });

    test('AI 规则分池：规则条目路径并入精确层，背景条目 AI 路径被忽略（v1.10.2）', () => {
        const entries = [
            rule_entry('[mvu_update] 散文式规则'),
            background_entry('森林', '森林传说'),
            background_entry('城邦', '城邦贸易'),
        ];
        const aiByIndex = new Map([
            [0, ['主角.境界']], // 规则 → 精确层
            [1, ['理.好感度']], // 背景 → AI 路径被忽略（背景不 AI 分池）
            [2, []], // 无关
        ]);
        const pool = buildWorldbookPool(entries, { aiByIndex });
        // 规则 AI 路径并入精确层
        expect(pool.rulePaths).toContain('主角.境界');
        expect(pool.rulePathToRules.get('主角.境界')?.[0]).toContain('散文式规则');
        expect(pool.aiMerged).toBe(true);
    });

    test('强制更新（mandatory 细粒度）：只标 AI 明确标记的路径，不整条规则全标（v1.12.1 修复）', () => {
        const entries = [
            rule_entry('[mvu_update] 11.BEAUTY RANKING: MANDATORY — 绝色榜轮换'),
            rule_entry('[mvu_update] 每轮刷新 世界.当前时间'),
            rule_entry('[mvu_update] 普通规则，无强制'),
        ];
        const aiByIndex = new Map([
            [0, ['世界.绝色榜', '绝色.仙姿']],
            [1, ['世界.当前时间']],
            [2, ['主角.修为']],
        ]);
        // 规则 0 内容虽含 MANDATORY，但 AI 只标记「世界.绝色榜」强制（绝色.仙姿 不标）
        const aiMandatoryByIndex = new Map([[0, ['世界.绝色榜']]]);
        const pool = buildWorldbookPool(entries, { aiByIndex, aiMandatoryByIndex });
        expect(pool.mandatoryPaths).toEqual(['世界.绝色榜']);
        // 未被 AI 标记的路径即使规则含 MANDATORY 也不强制（此前会整条规则全标）
        expect(pool.mandatoryPaths).not.toContain('绝色.仙姿');
        // 无 AI 强制标记 → 不强制（「每轮」规则若 AI 没标也不强制）
        expect(pool.mandatoryPaths).not.toContain('世界.当前时间');
        expect(pool.mandatoryPaths).not.toContain('主角.修为');
    });

    test('无 AI 分池时无强制路径', () => {
        const pool = buildWorldbookPool([rule_entry('[mvu_update] MANDATORY 规则')]);
        expect(pool.mandatoryPaths).toEqual([]);
    });

    test('下标对齐：输入含禁用/空条目时规则 AI 路径不错位（v1.10.1 修复）', () => {
        // 输入下标 1 是禁用条目、下标 3 是空内容条目——AI 归属按【输入下标】给
        const entries = [
            rule_entry('[mvu_update] 规则A'),
            { name: '禁用', enabled: false, content: '[mvu_update] 不该入池' },
            background_entry('森林', '森林传说'),
            { name: '空', enabled: true, content: '   ' },
        ];
        const pool = buildWorldbookPool(entries, {
            aiByIndex: new Map([[0, ['主角.境界']]]),
        });
        // 规则 A 的 AI 路径进了精确层，没有错位到禁用/空条目
        expect(pool.rulePathToRules.get('主角.境界')?.[0]).toContain('规则A');
        expect(pool.rulePaths).toEqual(['主角.境界']);
    });

    test('indexStats 统计索引规模（AI 分池后）', () => {
        const entries = [
            rule_entry("[mvu_update] _.set('a.b', 1); _.set('a.c', 2);"),
            background_entry('绿', 'x', { type: 'selective', keys: ['k1', 'k2'] }),
        ];
        const pool = buildWorldbookPool(entries, {
            aiByIndex: new Map([[0, ['a.b', 'a.c']]]),
        });
        expect(pool.indexStats).toEqual({ rulePaths: 2, rulePathToRules: 2 });
    });

    test('空输入产出空池', () => {
        const pool = buildWorldbookPool([]);
        expect(pool.entries).toEqual([]);
        expect(pool.rulePaths).toEqual([]);
        expect(pool.aiMerged).toBe(false);
        expect(pool.indexStats.rulePathToRules).toBe(0);
    });
});

describe('parseAiClassification（AI 逐条分池输出解析）', () => {
    test('标准数组（显式 idx）', () => {
        const r = parseAiClassification(
            '[{"idx":0,"paths":["主角.境界"],"topic":"a"},{"idx":1,"paths":[],"topic":""}]',
            2
        );
        expect(r?.paths.get(0)).toEqual(['主角.境界']);
        expect(r?.paths.get(1)).toEqual([]);
        expect(r?.mandatory.size).toBe(0);
    });

    test('mandatory 细粒度字段解析（v1.12.1）', () => {
        const r = parseAiClassification(
            '[{"idx":0,"paths":["世界.绝色榜","绝色.仙姿"],"mandatory":["世界.绝色榜"]}]',
            1
        );
        expect(r?.paths.get(0)).toEqual(['世界.绝色榜', '绝色.仙姿']);
        expect(r?.mandatory.get(0)).toEqual(['世界.绝色榜']);
    });

    test('缺省 idx 按顺序对齐', () => {
        const r = parseAiClassification('[{"paths":["a.b"]},{"paths":[]}]', 2);
        expect(r?.paths.get(0)).toEqual(['a.b']);
        expect(r?.paths.get(1)).toEqual([]);
    });

    test('对象形式 {"0":[...]}', () => {
        const r = parseAiClassification('{"1":["x.y"],"0":[]}', 2);
        expect(r?.paths.get(1)).toEqual(['x.y']);
        expect(r?.paths.get(0)).toEqual([]);
    });

    test('围栏/尾部逗号/单引号容错', () => {
        const r = parseAiClassification("```json\n[{'idx':0,'paths':['a.b'],},]\n```", 1);
        expect(r?.paths.get(0)).toEqual(['a.b']);
    });

    test('路径归一化与非法过滤', () => {
        const r = parseAiClassification(
            '[{"idx":0,"paths":["stat_data.理.好感度","_.set","",123]}]',
            1
        );
        expect(r?.paths.get(0)).toEqual(['理.好感度']);
    });

    test('越界序号丢弃', () => {
        const r = parseAiClassification('[{"idx":5,"paths":["a.b"]},{"idx":1,"paths":["c.d"]}]', 2);
        expect(r?.paths.size).toBe(1);
        expect(r?.paths.get(1)).toEqual(['c.d']);
    });

    test('非 JSON → null', () => {
        expect(parseAiClassification('随便写写', 2)).toBeNull();
        expect(parseAiClassification('', 2)).toBeNull();
    });
});

describe('poolQueryRulesByPaths（精确层 + 文本兜底）', () => {
    test('精确层：决策路径命中 AI 给出的管辖路径 → 必中（正文写法无关）', () => {
        const pool = buildWorldbookPool(
            [
                rule_entry("[mvu_update] _.set('理.好感度', 0); // 每天更新"),
                rule_entry('[mvu_update] 世界.时间 规则'),
            ],
            { aiByIndex: new Map([[0, ['理.好感度']]]) }
        );
        const rules = poolQueryRulesByPaths(pool, ['理.好感度']);
        expect(rules).toEqual(["[mvu_update] _.set('理.好感度', 0); // 每天更新"]);
    });

    test('精确层：AI 分池给出的规则路径命中', () => {
        const pool = buildWorldbookPool(
            [rule_entry('[mvu_update] 每当主角境界提升时，同步更新修为')],
            { aiByIndex: new Map([[0, ['主角.境界']]]) }
        );
        const rules = poolQueryRulesByPaths(pool, ['主角.境界']);
        expect(rules).toEqual(['[mvu_update] 每当主角境界提升时，同步更新修为']);
    });

    test('文本兜底：AI 分池未覆盖时按内容段匹配补漏', () => {
        const pool = buildWorldbookPool([
            rule_entry('[mvu_update] 每当主角境界提升时，同步更新修为'),
        ]);
        const rules = poolQueryRulesByPaths(pool, ['主角.境界']);
        expect(rules).toEqual(['[mvu_update] 每当主角境界提升时，同步更新修为']);
    });

    test('精确层与兜底层结果去重', () => {
        const pool = buildWorldbookPool(
            [rule_entry("[mvu_update] _.set('a.b', 1); a.b 规则正文")],
            { aiByIndex: new Map([[0, ['a.b']]]) }
        );
        expect(poolQueryRulesByPaths(pool, ['a.b'])).toHaveLength(1);
    });

    test('空路径返回空', () => {
        const pool = buildWorldbookPool([rule_entry("[mvu_update] _.set('a.b', 1);")]);
        expect(poolQueryRulesByPaths(pool, [])).toEqual([]);
    });
});

describe('poolQueryLoreByPaths（相关性打分启发搜索）', () => {
    test('绿灯 keys 命中（+3）优先于内容段命中（+2）', () => {
        const pool = buildWorldbookPool([
            background_entry('城邦', '城邦也有好感度体系', { type: 'constant' }),
            background_entry('森林', '森林传说：好感度神圣', { type: 'selective', keys: ['好感度'] }),
        ]);
        const lore = poolQueryLoreByPaths(pool, ['理.好感度'], '剧情里提到好感度提升');
        // 森林（keys 命中 +3）排在城邦（内容段命中 +2）前面；两条都进
        expect(lore[0]).toContain('森林传说');
        expect(lore.some(l => l.includes('城邦也有好感度体系'))).toBe(true);
    });

    test('文本兜底：内容提到决策路径段', () => {
        const pool = buildWorldbookPool([
            background_entry('时间', '时间的流逝不影响修行'),
        ]);
        const lore = poolQueryLoreByPaths(pool, ['世界.时间']);
        expect(lore.some(l => l.includes('时间的流逝'))).toBe(true);
    });

    test('按相关性给数量：多条相关全取，不固定 3 条', () => {
        const pool = buildWorldbookPool(
            Array.from({ length: 6 }, (_, i) => background_entry(`好感${i}`, `好感度背景${i}`))
        );
        const lore = poolQueryLoreByPaths(pool, ['理.好感度']);
        expect(lore).toHaveLength(6);
    });

    test('条数上限与总字符预算', () => {
        const pool = buildWorldbookPool(
            Array.from({ length: 12 }, (_, i) => background_entry(`好感${i}`, `好感度背景${i}`))
        );
        const lore = poolQueryLoreByPaths(pool, ['理.好感度'], undefined, { maxEntries: 8 });
        expect(lore.length).toBeLessThanOrEqual(8);
        const tiny = poolQueryLoreByPaths(pool, ['理.好感度'], undefined, {
            maxEntries: 8,
            maxTotalChars: 60,
        });
        const total = tiny.reduce((sum, l) => sum + l.length, 0);
        expect(total).toBeLessThanOrEqual(60);
    });

    test('单条长度上限', () => {
        const long = background_entry('长', '好感度' + 'x'.repeat(5000));
        const p = buildWorldbookPool([long]);
        const lore = poolQueryLoreByPaths(p, ['理.好感度'], '好感度', { maxEntryLength: 100 });
        expect(lore).toHaveLength(1);
        expect(lore[0].length).toBeLessThanOrEqual(110);
    });

    test('规则条目不进背景', () => {
        const pool = buildWorldbookPool([
            rule_entry('[mvu_update] 理.好感度 规则'),
            background_entry('森林', '好感度传说'),
        ]);
        const lore = poolQueryLoreByPaths(pool, ['理.好感度'], '好感度');
        expect(lore.every(l => !l.includes('[mvu_update]'))).toBe(true);
    });

    test('无路径无剧情返回空', () => {
        const pool = buildWorldbookPool([background_entry('a', 'b')]);
        expect(poolQueryLoreByPaths(pool, [], undefined)).toEqual([]);
    });
});
