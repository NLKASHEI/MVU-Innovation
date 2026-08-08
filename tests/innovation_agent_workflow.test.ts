import {
    AgentWorkflowExecutor,
    AgentWorkflowResult,
    buildObservation,
    buildVariableIndex,
    enumerateLeafPaths,
    extractRecordFields,
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
        // 模拟 AI 规则分池已给出管辖路径（v1.11.4 起规则路径唯一来源 = AI，无正则）
        readRules: async () => ({
            entries: ['理.好感度 每轮更新'],
            raw: '理.好感度 每轮更新',
            extraPaths: ['理.好感度'],
        }),
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

describe('searchCandidates（启发式候选搜索）', () => {
    test('规则路径并入候选（AI 分池给出的路径）', () => {
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

    test('规则假路径过滤：Analysis 清单（1.TIME 等）不存在于状态 → 丢弃（v1.11.4 修复）', () => {
        const rule_paths = [
            '理.好感度',
            '1.TIME',
            '3.PROTAGONIST',
            '15.ENCOUNTER',
            '主角.不存在',
        ];
        const { candidates, from_rules } = searchCandidates(STATE, '', rule_paths);
        expect(candidates).toEqual(['理.好感度']);
        expect(from_rules).toBe(1);
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

    test('带列表前缀的 Y/N 判断（- 路径: Y，v1.12.1 修复：此前全被丢弃）', () => {
        expect(
            parseDecidePaths('- 世界.当前时间: Y\n- 主角.境界: Y\n- 主角.姓名: N')
        ).toEqual(['世界.当前时间', '主角.境界']);
    });

    test('模型照抄模板字面量「路径: Y」→ 跳过不产生假路径（v1.12.10 修复）', () => {
        expect(
            parseDecidePaths('路径: N\n路径: Y\n路径: Y\n主角.容貌: Y')
        ).toEqual(['主角.容貌']);
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

    test('record 容器显示子字段模板（模型不再漏字段，v2.0.1）', () => {
        const obs = buildObservation(
            { 绝色榜: {}, 人物: {} },
            ['绝色榜', '人物'],
            {
                recordFields: {
                    绝色榜: ['排名', '头衔', '仙姿', '群芳谱'],
                    人物: ['性别', '境界', '好感', '描述'],
                },
            }
        );
        expect(obs.text).toContain('绝色榜: {}（record 子字段：排名/头衔/仙姿/群芳谱）');
        expect(obs.text).toContain('人物: {}（record 子字段：性别/境界/好感/描述）');
    });
});

describe('extractRecordFields（ZOD 仓库 record 子字段模板提取）', () => {
    test('从模板路径提取容器子字段', () => {
        const fields = extractRecordFields([
            '绝色榜.<键>.排名',
            '绝色榜.<键>.头衔',
            '绝色榜.<键>.仙姿',
            '绝色榜.<键>.群芳谱',
            '人物.<键>.好感',
            '道侣',
        ]);
        expect(fields['绝色榜']).toEqual(['排名', '头衔', '仙姿', '群芳谱']);
        expect(fields['人物']).toEqual(['好感']);
        // 非模板路径不产生容器
        expect(fields['道侣']).toBeUndefined();
    });

    test('空输入返回空映射', () => {
        expect(extractRecordFields([])).toEqual({});
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

describe('validateOps（v1.12.12 只做权力边界，结构校验放行——「能录进去就放行」由 ZOD/应用层兜底）', () => {
    test('越权路径拒绝', () => {
        const prepared = parseDeltaBlock("<UpdateVariable>_.set('理.心情', 1);</UpdateVariable>");
        const errors = validateOps(prepared, STATE, ['理.好感度']);
        expect(errors.some(e => e.includes('越权'))).toBe(true);
    });

    test('不存在路径放行（结构校验交给 ZOD/应用层，不再本地拦截）', () => {
        const set = parseDeltaBlock("<UpdateVariable>_.set('不存在.路径', 1);</UpdateVariable>");
        expect(validateOps(set, STATE, [])).toEqual([]);
        const delta = parseDeltaBlock(
            '<UpdateVariable><JSONPatch>[{"op":"delta","path":"/人物/姜梦/好感度","value":1}]</JSONPatch></UpdateVariable>'
        );
        expect(validateOps(delta, STATE, ['人物'])).toEqual([]);
        const remove = parseDeltaBlock(
            '<UpdateVariable><JSONPatch>[{"op":"remove","path":"/不存在/东西"}]</JSONPatch></UpdateVariable>'
        );
        expect(validateOps(remove, STATE, ['不存在'])).toEqual([]);
    });

    test('初始化流程放行：先 add 空对象再 replace 填字段、直接 replace 深层路径', () => {
        const state = { 人物: {} };
        const fill = parseDeltaBlock(
            '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/人物/姜梦/好感度","value":20}]</JSONPatch></UpdateVariable>'
        );
        expect(validateOps(fill, state, ['人物'])).toEqual([]);
        const batch = parseDeltaBlock(
            '<UpdateVariable><JSONPatch>[{"op":"add","path":"/人物/姜梦","value":{}},{"op":"replace","path":"/人物/姜梦/好感度","value":20}]</JSONPatch></UpdateVariable>'
        );
        expect(validateOps(batch, state, ['人物'])).toEqual([]);
    });

    test('insert 到已存在父路径允许', () => {
        const prepared = parseDeltaBlock("<UpdateVariable>_.insert('理.新键', 1);</UpdateVariable>");
        expect(validateOps(prepared, STATE, ['理'])).toEqual([]);
    });

    test('JSON Patch 越权拒绝 / 合法通过', () => {
        const bad = parseDeltaBlock(
            '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/世界/时间","value":"x"}]</JSONPatch></UpdateVariable>'
        );
        expect(validateOps(bad, STATE, ['理.好感度']).length).toBeGreaterThan(0);

        const ok = parseDeltaBlock(
            '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/理/好感度","value":50}]</JSONPatch></UpdateVariable>'
        );
        expect(validateOps(ok, STATE, ['理.好感度'])).toEqual([]);
    });

    test('命令缺路径拒绝（基本形状）', () => {
        const prepared = parseDeltaBlock("<UpdateVariable>_.set('', 1);</UpdateVariable>");
        const errors = validateOps(prepared, STATE, []);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some(e => e.includes('缺少路径'))).toBe(true);
    });

    test('record 容器新条目值必须是对象（v2.0.10 静默格式校验，动向 insert 字符串拒绝）', () => {
        const prepared = parseDeltaBlock(
            '<UpdateVariable><JSONPatch>[{"op":"insert","path":"/世界/动向/降临玄天","value":"起 - 秦海降临"}]</JSONPatch></UpdateVariable>'
        );
        const errors = validateOps(prepared, STATE, ['世界.动向'], ['世界.动向', '绝色榜']);
        expect(errors.some(e => e.includes('必须是对象'))).toBe(true);
        expect(errors.some(e => e.includes('字符串'))).toBe(true);
    });

    test('record 容器新条目值对象 → 通过', () => {
        const prepared = parseDeltaBlock(
            '<UpdateVariable><JSONPatch>[{"op":"insert","path":"/世界/动向/降临玄天","value":{"阶段":"起","类型":"机缘"}}]</JSONPatch></UpdateVariable>'
        );
        expect(validateOps(prepared, STATE, ['世界.动向'], ['世界.动向'])).toEqual([]);
    });

    test('record 容器本身 replace 值必须是对象（replace {} 通过，replace 数组拒绝）', () => {
        const ok = parseDeltaBlock(
            '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/世界/动向","value":{}}]</JSONPatch></UpdateVariable>'
        );
        expect(validateOps(ok, STATE, ['世界.动向'], ['世界.动向'])).toEqual([]);
        const bad = parseDeltaBlock(
            '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/世界/动向","value":[]}]</JSONPatch></UpdateVariable>'
        );
        expect(validateOps(bad, STATE, ['世界.动向'], ['世界.动向']).length).toBeGreaterThan(0);
    });

    test('record 深层子字段（如 /世界/动向/xxx/阶段）字符串不误拒', () => {
        const prepared = parseDeltaBlock(
            '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/世界/动向/降临玄天/阶段","value":"起"}]</JSONPatch></UpdateVariable>'
        );
        expect(validateOps(prepared, STATE, ['世界.动向'], ['世界.动向'])).toEqual([]);
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
                return { entries: ['理.好感度 每轮更新'], raw: '', extraPaths: ['理.好感度'] };
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

    test('候选 = ZOD 变量全集（v2.0.8：extraPaths 传入，存在性校验过滤模板/不存在路径）', async () => {
        const seen: string[][] = [];
        const executor = buildExecutor({
            readRules: async () => ({
                entries: ['散文规则，不解析路径'],
                raw: '',
                extraPaths: ['理.好感度', '世界.时间', '不存在.路径', '道侣.<键>.亲密'],
            }),
            decide: async input => {
                seen.push(input.candidates);
                return { text: '理.好感度: Y', raw: '' };
            },
        });
        const result = await runAgentWorkflow(executor, { state: STATE, story: '' }, {
            maxRetries: 3,
            loopThreshold: 2,
        });
        // 存在的路径进候选，不存在的（含 record 模板）被存在性校验过滤
        expect(seen[0]).toEqual(['理.好感度', '世界.时间']);
        expect(result.termination).toBe('done');
    });

    test('AI 规则路径存在时 ZOD 不兜底（避免每轮全量并入拖慢）', async () => {
        const seen: string[][] = [];
        const executor = buildExecutor({
            readRules: async () => ({
                entries: ['规则'],
                raw: '',
                extraPaths: ['理.好感度'],
                zodPaths: ['世界.时间', '理.心情'],
            }),
            decide: async input => {
                seen.push(input.candidates);
                return { text: '理.好感度: Y', raw: '' };
            },
        });
        await runAgentWorkflow(executor, { state: STATE, story: '' }, {
            maxRetries: 3,
            loopThreshold: 2,
        });
        // 候选只有 AI 规则路径 + 剧情命中，ZOD 路径不并入
        expect(seen[0]).toEqual(['理.好感度']);
    });

    test('v2.0.8 通用化：规则全文直接传入决策（不解析规则→路径）', async () => {
        const seen: { candidates: string[]; rules: string[] }[] = [];
        const executor = buildExecutor({
            readRules: async () => ({
                entries: ['强制更新（每回合必须更新）: 绝色榜', '事件触发: 主角.修为'],
                raw: '',
                extraPaths: ['理.好感度', '理.心情'],
            }),
            decide: async input => {
                seen.push({ candidates: input.candidates, rules: input.rules });
                return { text: '理.好感度: Y\n理.心情: Y', raw: '' };
            },
        });
        const result = await runAgentWorkflow(executor, { state: STATE, story: '' }, {
            maxRetries: 3,
            loopThreshold: 2,
        });
        // 规则全文原样传入决策（模型自己判断强制/相关）
        expect(seen[0].rules).toEqual(['强制更新（每回合必须更新）: 绝色榜', '事件触发: 主角.修为']);
        // 候选 = extraPaths（ZOD 全集）+ 剧情命中
        expect(seen[0].candidates).toContain('理.好感度');
        expect(seen[0].candidates).toContain('理.心情');
        expect(result.termination).toBe('done');
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
