import {
    extractDeltaFromBlock,
    hasValidDelta,
    runExtraModelAgentLoop,
} from '@/innovation/agent_extra_loop';

/** 构造一个 <UpdateVariable> 块 */
function block(delta: string): string {
    return `<UpdateVariable>\n${delta}\n</UpdateVariable>`;
}

const SET_DELTA = "_.set('stat_data.好感度', 80);";
const SET_DELTA_2 = "_.set('stat_data.好感度', 90);";

describe('extractDeltaFromBlock', () => {
    test('提取 _.set 命令', () => {
        const delta = extractDeltaFromBlock(block(SET_DELTA));
        expect(delta).toContain("_.set('stat_data.好感度', 80);");
    });

    test('空块返回空串', () => {
        expect(extractDeltaFromBlock('')).toBe('');
        expect(extractDeltaFromBlock('   ')).toBe('');
    });

    test('无有效命令返回空串', () => {
        expect(extractDeltaFromBlock('<UpdateVariable>\n一些普通文字\n</UpdateVariable>')).toBe('');
    });

    test('json_patch 块有效', () => {
        expect(hasValidDelta('<UpdateVariable>json_patch: [{"op":"replace"}]</UpdateVariable>')).toBe(
            true
        );
    });

    test('大小写与内嵌标签容错', () => {
        expect(hasValidDelta('<updatevariable>\n_.set("a", 1);\n</updatevariable>')).toBe(true);
    });
});

describe('runExtraModelAgentLoop', () => {
    test('第一轮无输出 → no_delta', async () => {
        const result = await runExtraModelAgentLoop(
            async () => null,
            async () => false,
            { maxSteps: 3, loopThreshold: 3 }
        );
        expect(result.termination).toBe('no_delta');
        expect(result.steps.length).toBe(0);
        expect(result.loop_broken).toBe(false);
    });

    test('每轮都修改直到 max_steps', async () => {
        const calls: number[] = [];
        const result = await runExtraModelAgentLoop(
            async round => {
                calls.push(round);
                return block(SET_DELTA + ` // round ${round}`);
            },
            async () => true,
            { maxSteps: 3, loopThreshold: 3 }
        );
        expect(calls).toEqual([1, 2, 3]);
        expect(result.termination).toBe('max_steps');
        expect(result.steps.length).toBe(3);
        expect(result.terminated_at_step).toBe(3);
    });

    test('delta 无实际修改 → stable', async () => {
        const result = await runExtraModelAgentLoop(
            async () => block(SET_DELTA),
            async () => false, // 不修改
            { maxSteps: 3, loopThreshold: 3 }
        );
        expect(result.termination).toBe('stable');
        expect(result.terminated_at_step).toBe(1);
    });

    test('连续相同 delta → loop_broken 熔断', async () => {
        const result = await runExtraModelAgentLoop(
            async () => block(SET_DELTA),
            async () => true, // 每次都"修改"
            { maxSteps: 5, loopThreshold: 3 }
        );
        expect(result.termination).toBe('loop_broken');
        expect(result.loop_broken).toBe(true);
        expect(result.steps.length).toBe(3); // 恰好 3 步熔断
    });

    test('执行器抛异常 → error', async () => {
        const result = await runExtraModelAgentLoop(
            async () => {
                throw new Error('boom');
            },
            async () => false,
            { maxSteps: 3, loopThreshold: 3 }
        );
        expect(result.termination).toBe('error');
        expect(result.error).toContain('boom');
    });

    test('applyDelta 抛异常 → error', async () => {
        const result = await runExtraModelAgentLoop(
            async () => block(SET_DELTA),
            async () => {
                throw new Error('apply failed');
            },
            { maxSteps: 3, loopThreshold: 3 }
        );
        expect(result.termination).toBe('error');
        expect(result.error).toContain('apply failed');
    });

    test('不同 delta 交替不熔断，走满 max_steps', async () => {
        let round = 0;
        const result = await runExtraModelAgentLoop(
            async () => {
                round += 1;
                return block(round % 2 === 1 ? SET_DELTA : SET_DELTA_2);
            },
            async () => true,
            { maxSteps: 4, loopThreshold: 2 }
        );
        expect(result.termination).toBe('max_steps');
        expect(result.steps.length).toBe(4);
        expect(result.loop_broken).toBe(false);
    });

    test('elapsed_ms 存在', async () => {
        const result = await runExtraModelAgentLoop(
            async () => null,
            async () => false,
            { maxSteps: 3, loopThreshold: 3 }
        );
        expect(typeof result.elapsed_ms).toBe('number');
    });
});
