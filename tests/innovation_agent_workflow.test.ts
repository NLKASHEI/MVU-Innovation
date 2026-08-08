import {
    AgentWorkflowExecutor,
    AgentWorkflowResult,
    buildObservation,
    buildVariableIndex,
    enumerateLeafPaths,
    extractRulePaths,
    filterRelevantLore,
    filterRelevantRules,
    parseDecidePaths,
    parseDeltaBlock,
    runAgentWorkflow,
    sanitizeJsonPatch,
    searchCandidates,
    validateOps,
} from '@/innovation/agent_workflow';

const STATE = { 理: { 好感度: 42, 心情: '开心' }, 世界: { 时间: '19:30' } };

function buildExecutor(overrides: Partial<AgentWorkflowExecutor> = {}): AgentWorkflowExecutor {
    return {
        readRules: async () => ({ entries: ['理.好感度 每轮更新'], raw: '理.好感度 每轮更新' }),
        decide: async () => ({ text: '理.好感度: Y\n世界.时间: N', raw: '' }),
        fetchRules: async () => ({
            entries: ['理.好感度 每轮更新'],
            raw: '理.好感度 每轮更新',
        }),
        update: async () => ({
            block: "<UpdateVariable>_.set('理.好感度', 50);</UpdateVariable>",
            raw: '',
        }),
        apply: async () => ({ applied: true }),
        ...overrides,
    };
}

describe('buildVariableIndex（决策阶段变量索引兜底）', () => {
    test('枚举叶子路径', () => {
        expect(buildVariableIndex(STATE)).toContain('理.好感度');
        expect(buildVariableIndex(STATE)).toContain('理.心情');
        expect(buildVariableIndex(STATE)).toContain('世界.时间');
    });

    test('跳过 $ 内部字段', () => {
        expect(
            buildVariableIndex({ 理: { 好感度: 1 }, $internal: { display_data: {} } })
        ).not.toContain('$internal');
    });

    test('空状态返回空串', () => {
        expect(buildVariableIndex({})).toBe('');
        expect(buildVariableIndex(null)).toBe('');
    });

    test('超限折叠', () => {
        const big: Record<string, Record<string, number>> = { a: {} };
        for (let i = 0; i < 300; i++) big.a[`p${i}`] = i;
        const index = buildVariableIndex(big, 50);
        expect(index).toContain('另有 250 个变量未列出');
        expect(index.split('\n').length).toBeLessThanOrEqual(52);
    });
});

describe('enumerateLeafPaths', () => {
    test('枚举叶子路径并跳过内部字段', () => {
        expect(enumerateLeafPaths(STATE)).toEqual(['理.好感度', '理.心情', '世界.时间']);
        expect(enumerateLeafPaths({})).toEqual([]);
    });
});

describe('extractRulePaths（规则声明的路径）', () => {
    test('从 _.set 命令提取', () => {
        expect(
            extractRulePaths(["_.set('理.好感度', 5); _.set('世界.时间','19:30');"])
        ).toEqual(['理.好感度', '世界.时间']);
    });

    test('支持 stat_data. 前缀与正文点分路径', () => {
        expect(extractRulePaths(['stat_data.理.好感度 每轮更新', '当 理.心情 低于 30 时'])).toEqual([
            '理.好感度',
            '理.心情',
        ]);
    });

    test('去重保序，空输入返回空', () => {
        expect(extractRulePaths(['a.b a.b a.c'])).toEqual(['a.b', 'a.c']);
        expect(extractRulePaths([])).toEqual([]);
    });
});

describe('searchCandidates（启发式候选搜索）', () => {
    test('规则路径并入候选', () => {
        const { candidates, from_rules } = searchCandidates(STATE, '', ['理.好感度', '理.好感度']);
        expect(candidates).toEqual(['理.好感度']);
        expect(from_rules).toBe(1);
    });

    test('剧情命中：路径最长段出现在剧情中', () => {
        const story = '今天的心情很好，时间飞逝';
        const { candidates, from_story } = searchCandidates(STATE, story, []);
        expect(candidates).toContain('理.心情');
        expect(candidates).toContain('世界.时间');
        expect(candidates).not.toContain('理.好感度');
        expect(from_story).toBe(2);
    });

    test('规则+剧情合并去重', () => {
        const { candidates } = searchCandidates(STATE, '好感度暴涨', ['理.好感度']);
        expect(candidates).toEqual(['理.好感度']);
    });

    test('超短段不参与剧情命中', () => {
        const state = { a: { xy: 1 }, b: { abcdef: 2 } };
        const { candidates } = searchCandidates(state, 'xy', [], { minSegmentLen: 3 });
        expect(candidates).toEqual([]);
    });

    test('候选上限', () => {
        const big: Record<string, Record<string, number>> = { a: {} };
        for (let i = 0; i < 100; i++) big.a[`p${i}`] = i;
        const story = Array.from({ length: 100 }, (_, i) => `p${i}`).join(' ');
        const { candidates } = searchCandidates(big, story, [], { maxCandidates: 20 });
        expect(candidates.length).toBeLessThanOrEqual(20);
    });

    test('无剧情无规则 → 空候选', () => {
        expect(searchCandidates(STATE, '', []).candidates).toEqual([]);
    });
});

describe('parseDecidePaths（AI 决策清单解析）', () => {
    test('解析 Y/N 判断', () => {
        expect(
            parseDecidePaths('理.好感度: Y\n理.心情: N\n世界.时间: Y')
        ).toEqual(['理.好感度', '世界.时间']);
    });

    test('支持是/否 与冒号变体', () => {
        expect(parseDecidePaths('理.好感度：是\n世界.时间 : 否')).toEqual(['理.好感度']);
    });

    test('裸路径视为需更新', () => {
        expect(parseDecidePaths('- 理.好感度\n- 世界.时间')).toEqual(['理.好感度', '世界.时间']);
    });

    test('只输出 Y 路径的简洁格式（v1.6.1 提速格式）', () => {
        expect(parseDecidePaths('世界.当前时间\n主角.境界\n主角.宗门')).toEqual([
            '世界.当前时间',
            '主角.境界',
            '主角.宗门',
        ]);
    });

    test('模型前言行被忽略', () => {
        expect(parseDecidePaths('需要更新的变量：\n以下是决策结果\n理.好感度\n世界.时间')).toEqual([
            '理.好感度',
            '世界.时间',
        ]);
    });

    test('none/无 声明 → 空清单（v1 曾把 none 当路径的 bug）', () => {
        expect(parseDecidePaths('none')).toEqual([]);
        expect(parseDecidePaths('无变化')).toEqual([]);
        expect(parseDecidePaths('- none')).toEqual([]);
        expect(parseDecidePaths('理.好感度: N\nnone')).toEqual([]);
    });

    test('空文本返回空数组', () => {
        expect(parseDecidePaths('')).toEqual([]);
        expect(parseDecidePaths('   ')).toEqual([]);
    });

    test('stat_data. 前缀归一化 + 去重保序', () => {
        expect(parseDecidePaths('stat_data.理.好感度: Y\n理.好感度: Y\n世界.时间: Y')).toEqual([
            '理.好感度',
            '世界.时间',
        ]);
    });

    test('候选边界：模型写候选外的路径被丢弃', () => {
        expect(
            parseDecidePaths('理.好感度: Y\n理.心情: Y', ['理.好感度'])
        ).toEqual(['理.好感度']);
    });
});

describe('filterRelevantRules', () => {
    test('只保留提到候选路径的规则', () => {
        const rules = ['理.好感度 规则A', '无关规则B', '理.心情 规则C'];
        expect(filterRelevantRules(rules, ['理.好感度'])).toEqual(['理.好感度 规则A']);
    });
    test('无候选返回空', () => {
        expect(filterRelevantRules(['a'], [])).toEqual([]);
    });
});

describe('filterRelevantLore（世界书读了再读更新规则）', () => {
    test('只保留与候选路径相关的背景', () => {
        const lore = ['森林的传说：好感度神圣', '城邦的贸易规则', '时间的流逝'];
        expect(filterRelevantLore(lore, ['理.好感度'])).toEqual(['森林的传说：好感度神圣']);
    });
    test('限制条数与截断', () => {
        const lore = ['a'.repeat(5000), '好感度相关'];
        const result = filterRelevantLore(lore, ['理.好感度'], 1, 100);
        expect(result).toHaveLength(1);
        expect(result[0].length).toBeLessThanOrEqual(101);
    });
    test('无候选返回空', () => {
        expect(filterRelevantLore(['x'], [])).toEqual([]);
    });
});

describe('buildObservation（观察层投影）', () => {
    test('只投影候选路径', () => {
        const obs = buildObservation(STATE, ['理.好感度']);
        expect(obs.paths).toEqual(['理.好感度']);
        expect(obs.text).toContain('理.好感度: 42');
        expect(obs.text).not.toContain('心情');
        expect(obs.folded).toBe(0);
    });

    test('缺失路径跳过', () => {
        const obs = buildObservation(STATE, ['理.好感度', '理.不存在']);
        expect(obs.paths).toEqual(['理.好感度']);
    });

    test('长值截断', () => {
        const obs = buildObservation({ a: { b: 'x'.repeat(500) } }, ['a.b'], { maxValueLen: 100 });
        expect(obs.text).toContain('…');
        expect(obs.text.length).toBeLessThan(200);
    });

    test('超限字段折叠为摘要行', () => {
        const paths = Array.from({ length: 80 }, (_, i) => `a.p${i}`);
        const state: Record<string, Record<string, number>> = { a: {} };
        for (let i = 0; i < 80; i++) state.a[`p${i}`] = i;
        const obs = buildObservation(state, paths, { maxFields: 50 });
        expect(obs.paths.length).toBe(50);
        expect(obs.folded).toBe(30);
        expect(obs.text).toContain('另有 30 个字段未展示');
    });

    test('空候选/空状态返回空观察', () => {
        expect(buildObservation(STATE, []).paths).toEqual([]);
        expect(buildObservation({}, ['a.b']).paths).toEqual([]);
    });
});

describe('sanitizeJsonPatch（语法容错）', () => {
    test('干净 JSON 直接通过', () => {
        const r = sanitizeJsonPatch('[{"op":"replace","path":"/理/好感度","value":50}]');
        expect(r.ops).toHaveLength(1);
        expect(r.ops?.[0].op).toBe('replace');
        expect(r.reason).toBeNull();
    });

    test('代码围栏与标签剥离', () => {
        const r = sanitizeJsonPatch('```json\n[{"op":"remove","path":"/a"}]\n```');
        expect(r.ops?.[0].op).toBe('remove');
        const r2 = sanitizeJsonPatch('<JSONPatch>[{"op":"remove","path":"/a"}]</JSONPatch>');
        expect(r2.ops?.[0].op).toBe('remove');
    });

    test('尾部多余逗号修复', () => {
        const r = sanitizeJsonPatch('[{"op":"replace","path":"/a","value":1,},]');
        expect(r.ops).toHaveLength(1);
    });

    test('路径漏点修复（无前导斜杠 / 点分路径）', () => {
        expect(sanitizeJsonPatch('[{"op":"replace","path":"理/好感度","value":1}]').ops?.[0].path).toBe(
            '/理/好感度'
        );
        expect(sanitizeJsonPatch('[{"op":"replace","path":"理.好感度","value":1}]').ops?.[0].path).toBe(
            '/理/好感度'
        );
    });

    test('delta 必须为数字', () => {
        expect(sanitizeJsonPatch('[{"op":"delta","path":"/a","value":5}]').ops).toHaveLength(1);
        expect(sanitizeJsonPatch('[{"op":"delta","path":"/a","value":"x"}]').ops).toBeNull();
    });

    test('非法 op 拒绝并给原因', () => {
        const r = sanitizeJsonPatch('[{"op":"hack","path":"/a","value":1}]');
        expect(r.ops).toBeNull();
        expect(r.reason).toContain('hack');
    });

    test('非 JSON 拒绝', () => {
        expect(sanitizeJsonPatch('not json').ops).toBeNull();
    });
});

describe('parseDeltaBlock（双通道解析）', () => {
    test('命令方言：多行/嵌套引号/注释', () => {
        const block = [
            '<UpdateVariable>',
            "_.set('理.好感度', 50);//剧情发展",
            "_.set('理.独白', '他说\"你好\");');",
            '</UpdateVariable>',
        ].join('\n');
        const r = parseDeltaBlock(block);
        expect(r.errors).toEqual([]);
        expect(r.commands.map(c => c.path)).toEqual(['理.好感度', '理.独白']);
        expect(r.commands[0].reason).toBe('剧情发展');
        expect(r.patch).toBeNull();
    });

    test('JSON Patch 方言', () => {
        const block =
            '<UpdateVariable><JSONPatch>[{"op":"delta","path":"/理/好感度","value":5}]</JSONPatch></UpdateVariable>';
        const r = parseDeltaBlock(block);
        expect(r.errors).toEqual([]);
        expect(r.patch).toHaveLength(1);
        expect(r.commands).toEqual([]);
    });

    test('结构化输出 {analysis, json_patch} 对象', () => {
        const block = JSON.stringify({
            analysis: 'time passed',
            json_patch: [{ op: 'replace', path: '/理/好感度', value: 50 }],
        });
        const r = parseDeltaBlock(block);
        expect(r.errors).toEqual([]);
        expect(r.patch).toHaveLength(1);
        expect(r.patch?.[0].op).toBe('replace');
    });

    test('结构化输出带代码围栏', () => {
        const block =
            '```json\n' +
            JSON.stringify({ analysis: 'x', json_patch: [{ op: 'delta', path: '/理/好感度', value: 5 }] }) +
            '\n```';
        const r = parseDeltaBlock(block);
        expect(r.errors).toEqual([]);
        expect(r.patch).toHaveLength(1);
    });

    test('结构化输出缺 json_patch → errors', () => {
        const r = parseDeltaBlock('{"analysis":"只有推理"}');
        expect(r.errors.some(e => e.includes('json_patch'))).toBe(true);
    });

    test('结构化输出空数组 → 空 patch 通过', () => {
        const r = parseDeltaBlock('[]');
        expect(r.errors).toEqual([]);
        expect(r.patch).toEqual([]);
    });

    test('分析块被剥离', () => {
        const block = [
            '<UpdateVariable>',
            '<Analysis>英语推理</Analysis>',
            "_.set('理.好感度', 50);",
            '</UpdateVariable>',
        ].join('\n');
        const r = parseDeltaBlock(block);
        expect(r.errors).toEqual([]);
        expect(r.commands).toHaveLength(1);
    });

    test('无有效内容 → errors（调用方喂回重试）', () => {
        const r = parseDeltaBlock('<UpdateVariable>随便写写</UpdateVariable>');
        expect(r.errors.length).toBeGreaterThan(0);
    });

    test('空块 → 无内容且无 errors（调用方按「无更新」处理）', () => {
        const r = parseDeltaBlock('');
        expect(r.commands).toEqual([]);
        expect(r.patch).toBeNull();
        expect(r.errors).toEqual([]);
    });
});

describe('validateOps（权力边界）', () => {
    test('越权路径拒绝', () => {
        const prepared = parseDeltaBlock("<UpdateVariable>_.set('理.心情', 1);</UpdateVariable>");
        const errors = validateOps(prepared, STATE, ['理.好感度']);
        expect(errors.some(e => e.includes('越权'))).toBe(true);
    });

    test('set 不存在路径拒绝', () => {
        const prepared = parseDeltaBlock("<UpdateVariable>_.set('理.不存在', 1);</UpdateVariable>");
        const errors = validateOps(prepared, STATE, ['理.好感度']);
        expect(errors.some(e => e.includes('不存在'))).toBe(true);
    });

    test('insert 到已存在父路径允许', () => {
        const prepared = parseDeltaBlock("<UpdateVariable>_.insert('理.新键', 1);</UpdateVariable>");
        expect(validateOps(prepared, STATE, ['理'])).toEqual([]);
    });

    test('JSON Patch 越权/存在性校验', () => {
        const bad = parseDeltaBlock(
            '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/世界/时间","value":"x"}]</JSONPatch></UpdateVariable>'
        );
        expect(validateOps(bad, STATE, ['理.好感度']).length).toBeGreaterThan(0);

        const ok = parseDeltaBlock(
            '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/理/好感度","value":50}]</JSONPatch></UpdateVariable>'
        );
        expect(validateOps(ok, STATE, ['理.好感度'])).toEqual([]);
    });

    test('合法命令全部通过', () => {
        const prepared = parseDeltaBlock(
            "<UpdateVariable>_.set('理.好感度', 50);\n_.set('世界.时间', '20:00');</UpdateVariable>"
        );
        expect(validateOps(prepared, STATE, ['理.好感度', '世界.时间'])).toEqual([]);
    });
});

describe('runAgentWorkflow agent 化工作流（候选搜索→决策→拉取→观察→更新→校验）', () => {
    test('正常流程：读规则→候选搜索→决策→拉取→观察→一步更新→校验→应用，done，只更新一次', async () => {
        const calls: string[] = [];
        const executor = buildExecutor({
            readRules: async () => {
                calls.push('read');
                return { entries: ['理.好感度 每轮更新'], raw: '' };
            },
            decide: async () => {
                calls.push('decide');
                return { text: '理.好感度: Y', raw: '' };
            },
            fetchRules: async () => {
                calls.push('fetch');
                return { entries: ['理.好感度 每轮更新'], raw: '' };
            },
            update: async () => {
                calls.push('update');
                return { block: "<UpdateVariable>_.set('理.好感度', 50);</UpdateVariable>", raw: '' };
            },
            apply: async () => {
                calls.push('apply');
                return { applied: true };
            },
        });

        const result = await runAgentWorkflow(executor, { state: STATE, story: '剧情' }, {
            maxRetries: 3,
            loopThreshold: 2,
        });
        expect(result.termination).toBe('done');
        expect(calls).toEqual(['read', 'decide', 'fetch', 'update', 'apply']);
        expect(result.stages).toEqual([
            'read_rules',
            'candidate_search',
            'decide',
            'fetch_rules',
            'observe',
            'update',
            'validate',
        ]);
        // 候选来自规则声明的路径（story 未命中额外路径）
        expect(result.candidates).toEqual(['理.好感度']);
        expect(result.candidateSource).toEqual({ from_rules: 1, from_story: 0 });
        expect(result.due).toEqual(['理.好感度']);
        expect(result.observation?.paths).toEqual(['理.好感度']);
        expect(result.retries).toBe(0);
    });

    test('剧情命中路径并入候选', async () => {
        const seen_candidates: string[][] = [];
        const executor = buildExecutor({
            decide: async input => {
                seen_candidates.push(input.candidates);
                return { text: '理.心情: Y', raw: '' };
            },
        });
        const result = await runAgentWorkflow(executor, { state: STATE, story: '今天心情不错' }, {
            maxRetries: 3,
            loopThreshold: 2,
        });
        // 规则命中 理.好感度 + 剧情命中 理.心情
        expect(seen_candidates[0]).toEqual(['理.好感度', '理.心情']);
        expect(result.candidateSource).toEqual({ from_rules: 1, from_story: 1 });
    });

    test('启发式候选为空 → no_change，不发模型请求', async () => {
        const calls: string[] = [];
        const executor = buildExecutor({
            readRules: async () => {
                calls.push('read');
                return { entries: ['与变量无关的规则内容'], raw: '' };
            },
            decide: async () => {
                calls.push('decide');
                return { text: 'x', raw: '' };
            },
        });
        const result = await runAgentWorkflow(executor, { state: STATE, story: '' }, {
            maxRetries: 3,
            loopThreshold: 2,
        });
        expect(result.termination).toBe('no_change');
        expect(calls).toEqual(['read']);
    });

    test('AI 决策无变化 → no_change，不拉取不更新', async () => {
        const calls: string[] = [];
        const executor = buildExecutor({
            decide: async () => {
                calls.push('decide');
                return { text: '理.好感度: N\nnone', raw: '' };
            },
            fetchRules: async () => {
                calls.push('fetch');
                return { entries: [], raw: '' };
            },
            update: async () => {
                calls.push('update');
                return { block: 'x', raw: '' };
            },
        });
        const result = await runAgentWorkflow(executor, { state: STATE, story: '' }, {
            maxRetries: 3,
            loopThreshold: 2,
        });
        expect(result.termination).toBe('no_change');
        expect(calls).toEqual(['decide']);
    });

    test('模型写候选外的路径 → 被丢弃 → no_change', async () => {
        const executor = buildExecutor({
            // 候选只有 理.好感度（规则），模型却写 不存在.路径
            decide: async () => ({ text: '不存在.路径: Y', raw: '' }),
            update: async () => {
                throw new Error('不应调用更新');
            },
        });
        const result = await runAgentWorkflow(executor, { state: STATE, story: '' }, {
            maxRetries: 3,
            loopThreshold: 2,
        });
        expect(result.termination).toBe('no_change');
    });

    test('模型输出空块 → done，不应用', async () => {
        const calls: string[] = [];
        const executor = buildExecutor({
            update: async () => {
                calls.push('update');
                return { block: '<UpdateVariable></UpdateVariable>', raw: '' };
            },
            apply: async () => {
                calls.push('apply');
                return { applied: true };
            },
        });
        const result = await runAgentWorkflow(executor, { state: STATE, story: '' }, {
            maxRetries: 3,
            loopThreshold: 2,
        });
        expect(result.termination).toBe('done');
        expect(calls).toEqual(['update']);
    });

    test('模型完全没输出（raw 与 block 皆空）→ 喂回「输出为空」重试，成功补上', async () => {
        const update_calls: (string | undefined)[] = [];
        const executor = buildExecutor({
            update: async (_ctx, lastError) => {
                update_calls.push(lastError);
                // 第一次完全没输出，第二次正常输出
                return update_calls.length === 1
                    ? { block: '', raw: '' }
                    : { block: "<UpdateVariable>_.set('理.好感度', 50);</UpdateVariable>", raw: 'x' };
            },
        });
        const result = await runAgentWorkflow(executor, { state: STATE, story: '' }, {
            maxRetries: 3,
            loopThreshold: 2,
        });
        expect(result.termination).toBe('done');
        expect(result.retries).toBe(1);
        expect(update_calls).toEqual([undefined, expect.stringContaining('输出为空')]);
    });

    test('模型持续没输出 → max_retries', async () => {
        const executor = buildExecutor({
            update: async () => ({ block: '', raw: '' }),
        });
        const result = await runAgentWorkflow(executor, { state: STATE, story: '' }, {
            maxRetries: 2,
            loopThreshold: 4,
        });
        expect(result.termination).toBe('max_retries');
        expect(result.retries).toBe(2);
    });

    test('模型持续没输出且连续相同 → loop_broken', async () => {
        const executor = buildExecutor({
            update: async () => ({ block: '', raw: '' }),
        });
        const result = await runAgentWorkflow(executor, { state: STATE, story: '' }, {
            maxRetries: 5,
            loopThreshold: 2,
        });
        expect(result.termination).toBe('loop_broken');
    });

    test('校验失败喂回原因重试，成功后 done', async () => {
        const update_calls: (string | undefined)[] = [];
        const executor = buildExecutor({
            update: async (_ctx, lastError) => {
                update_calls.push(lastError);
                // 第一次越权写入，第二次修正
                return {
                    block:
                        update_calls.length === 1
                            ? "<UpdateVariable>_.set('理.心情', 1);</UpdateVariable>"
                            : "<UpdateVariable>_.set('理.好感度', 50);</UpdateVariable>",
                    raw: '',
                };
            },
        });
        const result = await runAgentWorkflow(executor, { state: STATE, story: '' }, {
            maxRetries: 3,
            loopThreshold: 2,
        });
        expect(result.termination).toBe('done');
        expect(result.retries).toBe(1);
        expect(update_calls).toEqual([undefined, expect.stringContaining('越权')]);
    });

    test('连续相同校验失败 → loop_broken 熔断', async () => {
        const executor = buildExecutor({
            update: async () => ({
                block: "<UpdateVariable>_.set('理.心情', 1);</UpdateVariable>",
                raw: '',
            }),
        });
        const result = await runAgentWorkflow(executor, { state: STATE, story: '' }, {
            maxRetries: 5,
            loopThreshold: 2,
        });
        expect(result.termination).toBe('loop_broken');
        expect(result.retries).toBeGreaterThanOrEqual(1);
    });

    test('校验失败但原因不同 → max_retries', async () => {
        let n = 0;
        const executor = buildExecutor({
            update: async () => {
                n += 1;
                // 每次都换一个越权路径 → 失败原因不同 → 不熔断
                return {
                    block: `<UpdateVariable>_.set('理.p${n}', 1);</UpdateVariable>`,
                    raw: '',
                };
            },
        });
        const result = await runAgentWorkflow(executor, { state: STATE, story: '' }, {
            maxRetries: 2,
            loopThreshold: 3,
        });
        expect(result.termination).toBe('max_retries');
        expect(result.retries).toBe(2);
    });

    test('apply 未实际修改 → done', async () => {
        const executor = buildExecutor({
            apply: async () => ({ applied: false }),
        });
        const result = await runAgentWorkflow(executor, { state: STATE, story: '' }, {
            maxRetries: 3,
            loopThreshold: 2,
        });
        expect(result.termination).toBe('done');
    });

    test('世界书背景（lore）随 fetchRules 传入 update', async () => {
        let received_lore: string[] | undefined;
        const executor = buildExecutor({
            fetchRules: async () => ({
                entries: ['理.好感度 每轮更新'],
                raw: '',
                lore: ['森林的传说：好感度神圣'],
            }),
            update: async ctx => {
                received_lore = ctx.lore;
                return { block: "<UpdateVariable>_.set('理.好感度', 50);</UpdateVariable>", raw: '' };
            },
        });
        await runAgentWorkflow(executor, { state: STATE, story: '' }, {
            maxRetries: 3,
            loopThreshold: 2,
        });
        // fetchRules 已按决策路径裁剪（核心不再重复过滤）
        expect(received_lore).toEqual(['森林的传说：好感度神圣']);
    });

    test('executor 抛异常 → error', async () => {
        const executor = buildExecutor({
            update: async () => {
                throw new Error('update boom');
            },
        });
        const result = await runAgentWorkflow(executor, { state: STATE, story: '' }, {
            maxRetries: 3,
            loopThreshold: 2,
        });
        expect(result.termination).toBe('error');
        expect(result.error).toContain('update boom');
    });

    test('结果携带 stages 与 elapsed_ms', async () => {
        const result: AgentWorkflowResult = await runAgentWorkflow(
            buildExecutor(),
            { state: STATE, story: '' },
            { maxRetries: 3, loopThreshold: 2 }
        );
        expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
        expect(result.stages).toContain('decide');
    });
});
