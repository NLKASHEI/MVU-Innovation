import {
    AgentWorkflowExecutor,
    AgentWorkflowResult,
    buildObservation,
    extractDuePaths,
    filterRelevantRules,
    parseDeltaBlock,
    runAgentWorkflow,
    sanitizeJsonPatch,
    validateOps,
} from '@/innovation/agent_workflow';

const STATE = { 理: { 好感度: 42, 心情: '开心' }, 世界: { 时间: '19:30' } };

function buildExecutor(overrides: Partial<AgentWorkflowExecutor> = {}): AgentWorkflowExecutor {
    return {
        readRules: async () => ({ entries: ['理.好感度 每轮更新'], raw: '理.好感度 每轮更新' }),
        update: async () => ({
            block: "<UpdateVariable>_.set('理.好感度', 50);</UpdateVariable>",
            raw: '',
        }),
        apply: async () => ({ applied: true }),
        ...overrides,
    };
}

describe('extractDuePaths（dueFields 本地调度）', () => {
    test('从 _.set 命令提取路径', () => {
        expect(
            extractDuePaths(["_.set('理.好感度', 5); _.set('世界.时间','19:30');"])
        ).toEqual(['理.好感度', '世界.时间']);
    });

    test('支持 stat_data. 前缀并归一化', () => {
        expect(extractDuePaths(['stat_data.理.好感度 每轮更新'])).toEqual(['理.好感度']);
    });

    test('支持规则正文中的点分路径', () => {
        expect(extractDuePaths(['当 理.心情 低于 30 时更新'])).toEqual(['理.心情']);
    });

    test('忽略纯数字路径与无点内容，去重保序', () => {
        expect(extractDuePaths(['a.b 1.0 a.b a.c 简单文本'])).toEqual(['a.b', 'a.c']);
    });

    test('空规则返回空数组', () => {
        expect(extractDuePaths([])).toEqual([]);
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

describe('runAgentWorkflow 单次 Agent 回合', () => {
    test('正常流程：读规则→调度→观察→一步更新→校验→应用，done，只更新一次', async () => {
        const calls: string[] = [];
        const executor = buildExecutor({
            readRules: async () => {
                calls.push('read');
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
        expect(calls).toEqual(['read', 'update', 'apply']);
        expect(result.stages).toEqual(['read_rules', 'due', 'observe', 'update', 'validate']);
        expect(result.due).toEqual(['理.好感度']);
        expect(result.observation?.paths).toEqual(['理.好感度']);
        expect(result.retries).toBe(0);
    });

    test('无规则 → no_change，不调模型', async () => {
        const calls: string[] = [];
        const executor = buildExecutor({
            readRules: async () => {
                calls.push('read');
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
        expect(calls).toEqual(['read']);
    });

    test('规则无候选路径 → no_change', async () => {
        const calls: string[] = [];
        const executor = buildExecutor({
            readRules: async () => {
                calls.push('read');
                return { entries: ['无关内容，没有变量路径'], raw: '' };
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
        expect(calls).toEqual(['read']);
    });

    test('观察无字段（状态里没有候选）→ no_change', async () => {
        const executor = buildExecutor({
            update: async () => {
                throw new Error('不应调用模型');
            },
        });
        const result = await runAgentWorkflow(executor, { state: {}, story: '' }, {
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
        expect(result.stages).toContain('observe');
    });
});
