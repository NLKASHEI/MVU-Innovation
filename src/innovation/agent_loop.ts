/**
 * [革新版·Agent 更新] 多步 Agent 循环核心（纯逻辑，可单测）。
 *
 * 目标：让变量更新从「单次 generate」升级为「多步循环」——
 * 每轮：分析最近剧情 → 提取变量更新块 → 应用到变量 → 判断是否还需再生成，
 * 直到变量不再变化（稳定）或达到最大步数（熔断），并把每轮结果汇总。
 *
 * 本模块只含纯逻辑；真实的「调模型/解析/应用变量」由调用方以注入函数提供，
 * 以便在不依赖 tavern_helper 全局的前提下进行单测。
 */

/** 一轮多步 Agent 的结果 */
export interface AgentStepResult {
    /** 步骤序号（从 1 开始） */
    step: number;
    /** 该步提取到的更新块文本（可能为空串表示无更新） */
    delta: string;
    /** 该步模型给出的分析文本（用于日志/审计） */
    analysis: string;
    /** 该步是否实际修改了变量 */
    did_modify: boolean;
}

/** 多步 Agent 循环的最终结果 */
export interface AgentLoopResult {
    /** 实际执行的步数 */
    steps: AgentStepResult[];
    /** 终止原因 */
    termination: 'stable' | 'max_steps' | 'no_delta' | 'error';
    /** 触发终止的那一步（1-based）；若 error 在循环外则为此前最后一步或 0 */
    terminated_at_step: number;
    /** 是否发生死循环熔断（连续 N 步 delta 完全相同） */
    loop_broken: boolean;
}

/** 单步执行器：调用方注入。返回 null 表示该步失败（视为 error）。 */
export type AgentStepExecutor = (step: number) => Promise<{
    delta: string;
    analysis: string;
    did_modify: boolean;
} | null>;

/**
 * 计算一个更新块内容的稳定签名（用于死循环检测：连续相同内容视为死循环）。
 * @param delta 更新块文本
 * @param analysis 分析文本
 */
export function computeStepSignature(delta: string, analysis: string): string {
    return `${delta.trim()}|${analysis.trim()}`;
}

/**
 * 多步 Agent 主循环。
 * @param executor 单步执行器（调用方注入：调模型→解析→应用变量）
 * @param max_steps 最大步数（>=1），超过即熔断终止
 * @param loop_threshold 连续相同签名的步数阈值（>=2），达到即判定死循环
 */
export async function runMultiStepAgent(
    executor: AgentStepExecutor,
    max_steps: number,
    loop_threshold: number = 3
): Promise<AgentLoopResult> {
    const steps: AgentStepResult[] = [];
    let last_signature: string | null = null;
    let repeat_count = 0;
    let terminated_at_step = 0;
    let termination: AgentLoopResult['termination'] = 'max_steps';
    let loop_broken = false;

    for (let step = 1; step <= max_steps; step++) {
        let result: Awaited<ReturnType<AgentStepExecutor>>;
        try {
            result = await executor(step);
        } catch {
            termination = 'error';
            terminated_at_step = step;
            return { steps, termination, terminated_at_step, loop_broken };
        }
        if (result === null) {
            termination = 'error';
            terminated_at_step = step;
            return { steps, termination, terminated_at_step, loop_broken };
        }

        const { delta, analysis, did_modify } = result;
        steps.push({ step, delta, analysis, did_modify });

        // 无更新块 → 稳定终止
        if (delta.trim().length === 0) {
            termination = 'no_delta';
            terminated_at_step = step;
            return { steps, termination, terminated_at_step, loop_broken };
        }

        // 死循环检测：连续相同签名
        const signature = computeStepSignature(delta, analysis);
        if (signature === last_signature) {
            repeat_count += 1;
        } else {
            repeat_count = 1;
        }
        last_signature = signature;
        if (repeat_count >= loop_threshold) {
            termination = 'max_steps';
            terminated_at_step = step;
            loop_broken = true;
            return { steps, termination, terminated_at_step, loop_broken };
        }

        // 该步未实际修改变量 → 视为已稳定，无需继续
        if (!did_modify) {
            termination = 'stable';
            terminated_at_step = step;
            return { steps, termination, terminated_at_step, loop_broken };
        }
    }

    terminated_at_step = max_steps;
    termination = 'max_steps';
    return { steps, termination, terminated_at_step, loop_broken };
}

/** 汇总结果的可读日志文本 */
export function formatAgentLoopResult(result: AgentLoopResult): string {
    const deltas = result.steps.filter(s => s.delta.trim().length > 0).map(s => s.delta.trim());
    return (
        `[革新版·Agent] steps=${result.steps.length} term=${result.termination}` +
        ` at=${result.terminated_at_step} loop_broken=${result.loop_broken}` +
        ` deltas=${deltas.length}`
    );
}
