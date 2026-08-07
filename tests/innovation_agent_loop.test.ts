import {
    computeStepSignature,
    formatAgentLoopResult,
    runMultiStepAgent,
    AgentStepExecutor,
} from '@/innovation/agent_loop';

async function run(steps: Array<{ delta: string; analysis?: string; did_modify?: boolean }>, max = 5) {
    let i = 0;
    const executor: AgentStepExecutor = async () => {
        if (i >= steps.length) return null;
        const s = steps[i++];
        return {
            delta: s.delta,
            analysis: s.analysis ?? `analysis-${i}`,
            did_modify: s.did_modify ?? true,
        };
    };
    return runMultiStepAgent(executor, max);
}

describe('innovation agent_loop (多步 Agent 循环)', () => {
    describe('computeStepSignature', () => {
        test('相同 delta+analysis 得到相同签名，不同则不同', () => {
            expect(computeStepSignature('_.set(a,1)', 'x')).toBe(
                computeStepSignature('_.set(a,1)', 'x')
            );
            expect(computeStepSignature('_.set(a,1)', 'x')).not.toBe(
                computeStepSignature('_.set(a,2)', 'x')
            );
        });
    });

    describe('runMultiStepAgent', () => {
        test('单步更新后变量稳定（did_modify=true 后无更多 delta → 触达 max 或稳定）', async () => {
            const result = await run([{ delta: '_.set(好感度,10);' }], 5);
            expect(result.steps.length).toBe(1);
            expect(result.steps[0].did_modify).toBe(true);
        });

        test('多步连续更新（2 步）', async () => {
            const result = await run([
                { delta: '_.set(a,1);' },
                { delta: '_.set(b,2);' },
            ], 5);
            expect(result.steps.length).toBe(2);
            expect(result.steps[0].delta).toContain('a');
            expect(result.steps[1].delta).toContain('b');
        });

        test('步内未修改变量（did_modify=false）→ 立即稳定终止', async () => {
            const result = await run([{ delta: '_.set(a,1);', did_modify: false }], 5);
            expect(result.termination).toBe('stable');
            expect(result.steps.length).toBe(1);
        });

        test('无 delta（空串）→ no_delta 终止', async () => {
            const result = await run([{ delta: '   ' }], 5);
            expect(result.termination).toBe('no_delta');
        });

        test('超过最大步数 → max_steps 终止', async () => {
            const steps = [
                { delta: '_.set(a,1);' },
                { delta: '_.set(b,2);' },
                { delta: '_.set(c,3);' },
                { delta: '_.set(d,4);' },
                { delta: '_.set(e,5);' },
                { delta: '_.set(f,6);' },
            ];
            const result = await run(steps, 3);
            expect(result.steps.length).toBe(3);
            expect(result.termination).toBe('max_steps');
            expect(result.terminated_at_step).toBe(3);
        });

        test('连续相同签名达阈值 → 死循环熔断 loop_broken=true', async () => {
            const steps = [
                { delta: '_.set(a,1);', analysis: 'same' },
                { delta: '_.set(a,1);', analysis: 'same' },
                { delta: '_.set(a,1);', analysis: 'same' },
            ];
            const result = await run(steps, 5);
            expect(result.loop_broken).toBe(true);
            expect(result.termination).toBe('max_steps');
        });

        test('执行器抛错 → error 终止', async () => {
            const executor: AgentStepExecutor = async () => {
                throw new Error('model timeout');
            };
            const result = await runMultiStepAgent(executor, 5);
            expect(result.termination).toBe('error');
            expect(result.terminated_at_step).toBe(1);
        });

        test('执行器返回 null → error 终止', async () => {
            const executor: AgentStepExecutor = async () => null;
            const result = await runMultiStepAgent(executor, 5);
            expect(result.termination).toBe('error');
        });
    });

    describe('formatAgentLoopResult', () => {
        test('可读日志包含步数与终止原因', async () => {
            const result = await run([{ delta: '_.set(a,1);' }], 5);
            const text = formatAgentLoopResult(result);
            expect(text).toContain('[革新版·Agent]');
            expect(text).toContain('steps=1');
            expect(text).toContain('term=');
        });
    });
});
