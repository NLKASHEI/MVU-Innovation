/**
 * [革新版·Agent 工作流] 独立四阶段工作流核心（纯逻辑，零 MVU 依赖）。
 *
 * 这是革新版自己的更新工作流，不复用 MVU 的 invokeExtraModelWithStrategy：
 *   阶段1 检查（check）  ：基于当前剧情 + 变量状态，列出「需要更新的变量」清单（检查格式）
 *   阶段2 读规则（read_rules）：根据检查清单，读取这些变量对应的更新规则
 *   阶段3 更新（update） ：基于规则产出 delta，应用【一次】（不重复完整更新）
 *   阶段4 自检（self_check）：校验 delta 格式（_.set / json_patch 语法），不合格则修正重试
 *
 * 关键设计：
 *   - 「检查」与「更新」分离：先只检查要更新哪些（不更新），确认后才执行一次更新，
 *     从根本上杜绝「每轮完整更新三遍」。
 *   - 检查无变化 → 直接 no_change 终止，不发更新请求（省 token）。
 *   - 自检失败 → 把失败原因喂回，从阶段3重试（max_retries 护栏）；连续相同失败 → loop_broken。
 *   - 模型调用与变量应用全部通过 executor 注入，本模块可独立单测。
 */

/** 工作流阶段 */
export type WorkflowStage = 'check' | 'read_rules' | 'update' | 'self_check';

/** 终止原因 */
export type AgentWorkflowTermination =
    | 'done'
    | 'no_change'
    | 'max_retries'
    | 'loop_broken'
    | 'error';

/** 阶段1 检查结果 */
export interface CheckResult {
    /** 需要更新的变量路径清单（空 = 无变化，直接终止） */
    paths: string[];
    /** 模型原始检查文本（供面板/日志） */
    raw: string;
}

/** 阶段2 读取到的规则集 */
export interface RuleSet {
    /** 规则条目（世界书 [mvu_update] 等） */
    entries: string[];
    raw: string;
}

/** 阶段3 更新结果 */
export interface UpdateResult {
    /** 应用后的 delta 更新块（供自检） */
    block: string;
    /** 是否有实际修改 */
    applied: boolean;
    raw: string;
}

/** 阶段4 自检结果 */
export interface SelfCheckResult {
    ok: boolean;
    reason?: string;
}

/**
 * 工作流执行器（桥接层实现，注入真实模型调用与变量应用）。
 * 本模块只负责编排，不接触 tavern-helper / MVU 任何全局。
 */
export interface AgentWorkflowExecutor {
    /** 阶段1：检查要更新的有哪些。返回模型文本（检查格式），由解析器提炼 paths */
    check(currentState: string): Promise<string>;
    /** 阶段2：根据清单读取相应规则 */
    readRules(paths: string[]): Promise<RuleSet>;
    /** 阶段3：基于规则产出 delta 并应用【一次】。失败原因可喂回重试 */
    update(rules: RuleSet, checkRaw: string, lastError?: string): Promise<UpdateResult>;
    /** 阶段4：格式自检 */
    selfCheck(block: string): Promise<SelfCheckResult>;
}

/** 工作流结果 */
export interface AgentWorkflowResult {
    /** 实际经历的阶段序列（诊断用） */
    stages: WorkflowStage[];
    check: CheckResult | null;
    rules: RuleSet | null;
    update: UpdateResult | null;
    selfCheck: SelfCheckResult | null;
    termination: AgentWorkflowTermination;
    /** 总重试次数（阶段3自检失败重试） */
    retries: number;
    /** 总耗时 ms */
    elapsed_ms: number;
    error?: string;
}

/** 工作流配置 */
export interface AgentWorkflowOptions {
    /** 阶段3自检失败的最大重试次数（≥1） */
    maxRetries: number;
    /** 连续相同失败判定阈值（≥2 生效；连续 N 次相同失败原因 → 熔断） */
    loopThreshold: number;
}

/**
 * 从模型检查文本中提炼「需要更新的变量路径」。
 * 支持：
 *   - 每行 `路径: Y/N`（Y 表示需要更新，N 跳过）
 *   - 每行 `路径`（出现在 <CheckList> 中即视为需要更新）
 * @returns 需要更新的路径数组
 */
export function parseCheckPaths(raw: string): string[] {
    if (!raw) return [];
    const paths: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // `路径: Y` / `路径 : Y` / `路径：Y`
        const judge = trimmed.match(/^(.+?)\s*[:：]\s*(Y|N|YES|NO|y|n|是|否)\s*$/i);
        if (judge) {
            const path = judge[1].trim();
            const verdict = judge[2].toUpperCase();
            if (path && (verdict === 'Y' || verdict === 'YES' || verdict === '是')) {
                paths.push(path);
            }
            continue;
        }
        // 形如 `- 路径` 或裸路径（在检查清单上下文视为需更新）
        const bare = trimmed.replace(/^[-*•]\s*/, '').trim();
        if (bare && !/^(检查|清单|Check|List|UpdateVariable|Analysis)/i.test(bare)) {
            paths.push(bare);
        }
    }
    // 去重保序
    return paths.filter((p, i) => paths.indexOf(p) === i);
}

/** 是否应判定为「无变化」（检查结果为空或未列出任何路径） */
export function isNoChange(check: CheckResult): boolean {
    return check.paths.length === 0;
}

/**
 * 运行革新版四阶段 Agent 工作流。
 * 只在「检查到有变化」时才执行更新；更新只应用一次，自检失败重试。
 */
export async function runAgentWorkflow(
    executor: AgentWorkflowExecutor,
    currentState: string,
    options: AgentWorkflowOptions
): Promise<AgentWorkflowResult> {
    const started_at = Date.now();
    const max_retries = Math.max(1, Math.floor(options.maxRetries) || 1);
    const loop_threshold = Math.max(2, Math.floor(options.loopThreshold) || 2);

    const stages: WorkflowStage[] = [];
    const base: AgentWorkflowResult = {
        stages,
        check: null,
        rules: null,
        update: null,
        selfCheck: null,
        termination: 'error',
        retries: 0,
        elapsed_ms: 0,
    };

    try {
        // ---- 阶段1 检查 ----
        stages.push('check');
        const check_raw = await executor.check(currentState);
        const check: CheckResult = { paths: parseCheckPaths(check_raw), raw: check_raw };
        base.check = check;

        // 无变化 → 直接终止，不发更新请求
        if (isNoChange(check)) {
            return { ...base, termination: 'no_change', elapsed_ms: Date.now() - started_at };
        }

        // ---- 阶段2 读取相应规则 ----
        stages.push('read_rules');
        const rules = await executor.readRules(check.paths);
        base.rules = rules;

        // ---- 阶段3 + 阶段4：更新一次 + 格式自检（失败重试） ----
        let last_error: string | undefined;
        let consecutive_failures = 0;
        let last_failure_reason: string | undefined;

        for (let attempt = 1; attempt <= max_retries + 1; attempt++) {
            stages.push('update');
            const update_result = await executor.update(rules, check_raw, last_error);
            base.update = update_result;
            base.retries = attempt - 1;

            if (!update_result.applied) {
                // 没有实际修改 → 视为 done（无变化可应用）
                return { ...base, termination: 'done', elapsed_ms: Date.now() - started_at };
            }

            // ---- 阶段4 格式自检 ----
            stages.push('self_check');
            const self_check = await executor.selfCheck(update_result.block);
            base.selfCheck = self_check;
            if (self_check.ok) {
                return { ...base, termination: 'done', elapsed_ms: Date.now() - started_at };
            }

            // 自检失败：喂回原因重试
            const reason = self_check.reason ?? '格式自检未通过';
            if (reason === last_failure_reason) {
                consecutive_failures++;
            } else {
                consecutive_failures = 1;
                last_failure_reason = reason;
            }
            last_error = reason;

            // 连续相同失败达到阈值 → 熔断
            if (consecutive_failures >= loop_threshold) {
                return {
                    ...base,
                    termination: 'loop_broken',
                    elapsed_ms: Date.now() - started_at,
                };
            }

            if (attempt > max_retries) {
                return {
                    ...base,
                    termination: 'max_retries',
                    elapsed_ms: Date.now() - started_at,
                };
            }
        }

        return { ...base, termination: 'done', elapsed_ms: Date.now() - started_at };
    } catch (e) {
        return {
            ...base,
            termination: 'error',
            error: e instanceof Error ? e.message : String(e),
            elapsed_ms: Date.now() - started_at,
        };
    }
}
