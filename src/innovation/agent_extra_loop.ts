/**
 * [革新版·Agent 多轮循环] 额外模型解析通道的多步循环核心（纯逻辑）。
 *
 * 背景：原作者证明「主模型流内 tool_call 更新」不现实（LLM 无视 auto / required 肘正文），
 * 原版因此走「额外模型单独 generate + required 工具」通道。Agent 化更新应接在这条**已验证可用**的通道上：
 * 让便宜模型像 Agent 一样多轮思考——第 1 轮分析最新剧情并产出 delta，
 * 应用后再基于**最新变量状态**发起第 2 轮解析，若有变化继续，直到：
 *   - 变量稳定（delta 应用后无实际修改）→ stable
 *   - 本轮无有效 delta → no_delta
 *   - 连续相同 delta 签名达到阈值 → loop_broken（死循环熔断）
 *   - 达到最大步数 → max_steps
 *   - 执行器异常 → error
 *
 * 纯逻辑零依赖（fetch/ST 全局均不接触），可独立单测；运行时由 agent_update_bridge 注入真实 executor。
 */

import { computeStepSignature } from '@/innovation/agent_loop';

/** 多轮循环中的一步 */
export interface ExtraLoopStep {
    step: number;
    /** 本轮额外模型返回的 <UpdateVariable> 块（原始） */
    block: string;
    /** 从块中提取出的 delta 更新命令 */
    delta: string;
    /** 应用 delta 后变量是否有实际修改 */
    did_modify: boolean;
    /** delta 签名（用于死循环检测） */
    signature: string;
}

/** 多轮循环终止原因 */
export type ExtraLoopTermination = 'stable' | 'no_delta' | 'loop_broken' | 'max_steps' | 'error';

/** 多轮循环结果 */
export interface ExtraLoopResult {
    steps: ExtraLoopStep[];
    termination: ExtraLoopTermination;
    loop_broken: boolean;
    /** 终止于第几步（1-based；无步则 0） */
    terminated_at_step: number;
    /** 循环总耗时（ms） */
    elapsed_ms: number;
    /** error 时的信息 */
    error?: string;
}

/** 多轮循环配置 */
export interface ExtraLoopOptions {
    /** 最大步数（≥1） */
    maxSteps: number;
    /** 死循环熔断阈值：连续 N 步签名相同即熔断（≥2） */
    loopThreshold: number;
}

/**
 * 从 <UpdateVariable> 块中提取 delta 更新命令。
 * 兼容原版 invokeExtraModel 产出的块（`_.set(...)` 等命令，或 JsonPatch）。
 * @returns 提取出的命令文本；无有效内容返回 ''
 */
export function extractDeltaFromBlock(block: string): string {
    if (!block) return '';
    // 剥掉可能的 <UpdateVariable> 外层标签
    let inner = block.replace(/<\/?update(?:variable|variableupdate)?\s*>/gi, '').trim();
    if (!inner) return '';

    // 支持 _.<op>(...) 命令方言
    const fn_call_match =
        /_\.(?:set|insert|assign|remove|unset|delete|add)\s*\([\s\S]*?\)\s*;/.test(inner);
    // 支持 json_patch 块
    const json_patch_match = /json_?patch/i.test(inner);
    if (fn_call_match || json_patch_match) {
        return inner;
    }
    return '';
}

/** 判断块中是否含有效 delta */
export function hasValidDelta(block: string): boolean {
    return extractDeltaFromBlock(block) !== '';
}

/**
 * 执行额外模型多轮循环。
 * @param executor 每轮调用一次额外模型解析；返回 <UpdateVariable> 块字符串，null 表示本轮无输出/失败
 * @param applyDelta 应用 delta 到变量；返回是否有实际修改
 * @param options 循环配置
 */
export async function runExtraModelAgentLoop(
    executor: (round: number) => Promise<string | null>,
    applyDelta: (delta: string) => Promise<boolean>,
    options: ExtraLoopOptions
): Promise<ExtraLoopResult> {
    const started_at = Date.now();
    const max_steps = Math.max(1, Math.floor(options.maxSteps) || 1);
    const loop_threshold = Math.max(2, Math.floor(options.loopThreshold) || 2);

    const steps: ExtraLoopStep[] = [];

    try {
        for (let round = 1; round <= max_steps; round++) {
            const block = await executor(round);
            // 本轮无输出 → no_delta（第一轮即无输出也是终止）
            if (block === null) {
                return {
                    steps,
                    termination: 'no_delta',
                    loop_broken: false,
                    terminated_at_step: round,
                    elapsed_ms: Date.now() - started_at,
                };
            }

            const delta = extractDeltaFromBlock(block);
            if (!delta) {
                return {
                    steps,
                    termination: 'no_delta',
                    loop_broken: false,
                    terminated_at_step: round,
                    elapsed_ms: Date.now() - started_at,
                };
            }

            const did_modify = await applyDelta(delta);
            const signature = computeStepSignature(delta, '');
            steps.push({ step: round, block, delta, did_modify, signature });

            // 变量稳定：delta 应用后无实际修改 → 终止
            if (!did_modify) {
                return {
                    steps,
                    termination: 'stable',
                    loop_broken: false,
                    terminated_at_step: round,
                    elapsed_ms: Date.now() - started_at,
                };
            }

            // 死循环熔断：最后 loop_threshold 步签名全部相同
            if (steps.length >= loop_threshold) {
                const tail = steps.slice(-loop_threshold);
                if (tail.every(s => s.signature === tail[0].signature)) {
                    return {
                        steps,
                        termination: 'loop_broken',
                        loop_broken: true,
                        terminated_at_step: round,
                        elapsed_ms: Date.now() - started_at,
                    };
                }
            }

            // 达到最大步数
            if (round >= max_steps) {
                return {
                    steps,
                    termination: 'max_steps',
                    loop_broken: false,
                    terminated_at_step: round,
                    elapsed_ms: Date.now() - started_at,
                };
            }
        }

        // 理论不可达
        return {
            steps,
            termination: 'max_steps',
            loop_broken: false,
            terminated_at_step: steps.length,
            elapsed_ms: Date.now() - started_at,
        };
    } catch (e) {
        return {
            steps,
            termination: 'error',
            loop_broken: false,
            terminated_at_step: steps.length + 1,
            elapsed_ms: Date.now() - started_at,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}
