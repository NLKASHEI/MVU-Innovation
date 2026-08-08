import {
    AgentWorkflowExecutor,
    AgentWorkflowResult,
    isNoChange,
    parseCheckPaths,
    runAgentWorkflow,
} from '@/innovation/agent_workflow';

const CHECK_TEXT = [
    'stat_data.理.好感度: Y',
    'stat_data.理.心情: N',
    'stat_data.世界.时间: Y',
].join('\n');

function buildExecutor(overrides: Partial<AgentWorkflowExecutor> = {}): AgentWorkflowExecutor {
    return {
        check: async () => CHECK_TEXT,
        readRules: async paths => ({
            entries: paths.map(p => `rule for ${p}`),
            raw: '',
        }),
        update: async () => ({
            block: '<UpdateVariable>_.set("a",1);</UpdateVariable>',
            applied: true,
            raw: '',
        }),
        selfCheck: async () => ({ ok: true }),
        ...overrides,
    };
}

describe('parseCheckPaths', () => {
    test('解析 Y/N 判断', () => {
        const paths = parseCheckPaths(CHECK_TEXT);
        expect(paths).toEqual(['stat_data.理.好感度', 'stat_data.世界.时间']);
    });

    test('空文本返回空数组', () => {
        expect(parseCheckPaths('')).toEqual([]);
        expect(parseCheckPaths('   ')).toEqual([]);
    });

    test('裸路径视为需更新', () => {
        expect(parseCheckPaths('- stat_data.a\n- stat_data.b')).toEqual([
            'stat_data.a',
            'stat_data.b',
        ]);
    });

    test('去重保序', () => {
        expect(parseCheckPaths('a: Y\na: Y\nb: Y')).toEqual(['a', 'b']);
    });
});

describe('isNoChange', () => {
    test('空清单为无变化', () => {
        expect(isNoChange({ paths: [], raw: '' })).toBe(true);
    });
    test('有路径为有变化', () => {
        expect(isNoChange({ paths: ['a'], raw: 'a: Y' })).toBe(false);
    });
});

describe('runAgentWorkflow 四阶段', () => {
    test('正常流程：检查→读规则→更新→自检，done，只更新一次', async () => {
        const calls: string[] = [];
        const executor = buildExecutor({
            check: async () => {
                calls.push('check');
                return CHECK_TEXT;
            },
            readRules: async paths => {
                calls.push(`read:${paths.length}`);
                return { entries: paths, raw: '' };
            },
            update: async () => {
                calls.push('update');
                return { block: '<UpdateVariable>x</UpdateVariable>', applied: true, raw: '' };
            },
            selfCheck: async () => {
                calls.push('self_check');
                return { ok: true };
            },
        });

        const result = await runAgentWorkflow(executor, 'state', {
            maxRetries: 3,
            loopThreshold: 2,
        });
        expect(result.termination).toBe('done');
        // 检查、读规则各 1 次，更新 + 自检各 1 次（只应用一次！）
        expect(calls).toEqual(['check', 'read:2', 'update', 'self_check']);
        expect(result.stages).toEqual(['check', 'read_rules', 'update', 'self_check']);
        expect(result.check?.paths).toEqual(['stat_data.理.好感度', 'stat_data.世界.时间']);
        expect(result.retries).toBe(0);
    });

    test('检查无变化 → no_change，不读规则不更新', async () => {
        const calls: string[] = [];
        const executor = buildExecutor({
            check: async () => 'stat_data.a: N\nstat_data.b: N',
            readRules: async () => {
                calls.push('read');
                return { entries: [], raw: '' };
            },
        });
        const result = await runAgentWorkflow(executor, 'state', {
            maxRetries: 3,
            loopThreshold: 2,
        });
        expect(result.termination).toBe('no_change');
        expect(calls).toEqual([]);
        expect(result.check?.paths).toEqual([]);
    });

    test('自检失败重试：喂回原因，成功后 done', async () => {
        let self_check_calls = 0;
        const update_calls: string[] = [];
        const executor = buildExecutor({
            update: async (_rules, _check, lastError) => {
                update_calls.push(lastError ?? 'first');
                return { block: '<UpdateVariable>x</UpdateVariable>', applied: true, raw: '' };
            },
            selfCheck: async () => {
                self_check_calls += 1;
                return self_check_calls === 1
                    ? { ok: false, reason: '缺失 json_patch 语法' }
                    : { ok: true };
            },
        });
        const result = await runAgentWorkflow(executor, 'state', {
            maxRetries: 3,
            loopThreshold: 2,
        });
        expect(result.termination).toBe('done');
        expect(result.retries).toBe(1);
        expect(update_calls).toEqual(['first', '缺失 json_patch 语法']);
    });

    test('连续相同自检失败 → loop_broken 熔断', async () => {
        const executor = buildExecutor({
            selfCheck: async () => ({ ok: false, reason: 'same bad format' }),
        });
        const result = await runAgentWorkflow(executor, 'state', {
            maxRetries: 5,
            loopThreshold: 2,
        });
        expect(result.termination).toBe('loop_broken');
        // 第 2 次连续相同失败即熔断 → 重试 1 次
        expect(result.retries).toBeGreaterThanOrEqual(1);
    });

    test('自检失败但未连续相同 → max_retries', async () => {
        let n = 0;
        const executor = buildExecutor({
            selfCheck: async () => {
                n += 1;
                return { ok: false, reason: `reason_${n}` }; // 每次都不同 → 不熔断
            },
        });
        const result = await runAgentWorkflow(executor, 'state', {
            maxRetries: 2,
            loopThreshold: 3,
        });
        expect(result.termination).toBe('max_retries');
        expect(result.retries).toBe(2);
    });

    test('update 无实际修改 → done', async () => {
        const executor = buildExecutor({
            update: async () => ({ block: '<UpdateVariable>x</UpdateVariable>', applied: false, raw: '' }),
        });
        const result = await runAgentWorkflow(executor, 'state', {
            maxRetries: 3,
            loopThreshold: 2,
        });
        expect(result.termination).toBe('done');
    });

    test('executor 抛异常 → error', async () => {
        const executor = buildExecutor({
            check: async () => {
                throw new Error('check boom');
            },
        });
        const result = await runAgentWorkflow(executor, 'state', {
            maxRetries: 3,
            loopThreshold: 2,
        });
        expect(result.termination).toBe('error');
        expect(result.error).toContain('check boom');
    });

    test('结果携带 stages 与 elapsed_ms', async () => {
        const result: AgentWorkflowResult = await runAgentWorkflow(
            buildExecutor(),
            'state',
            { maxRetries: 3, loopThreshold: 2 }
        );
        expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
        expect(result.stages).toContain('check');
    });
});
