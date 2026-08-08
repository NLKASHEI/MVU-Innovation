/**
 * [革新版·独立 Agent 工作流执行器] 运行时桥接层。
 *
 * 革新版自己的 Agent 更新链路——**不复用 MVU 的 invokeExtraModelWithStrategy / onMessageReceived**：
 *   - 自己监听 tavern_events.MESSAGE_RECEIVED
 *   - 自己读取当前变量状态（getVariables）
 *   - 自己构造请求（tavern-helper 底层 generateRaw，见 agent_request.ts）
 *   - 自己读取世界书规则（getWorldbook，见 agent_worldbook.ts）
 *   - 自己执行四阶段工作流（agent_workflow.ts：检查→读规则→更新→自检）
 *   - 自己应用变量（updateVariablesWith / replaceVariables）
 *
 * 本文件依赖 tavern-helper 全局（已通过 slash-runner/@types 声明），仅作运行时接入，不纳入单测。
 * 纯逻辑部分（请求构造/规则筛选/工作流编排）均有独立单测。
 */

import { runAgentWorkflow, AgentWorkflowResult } from '@/innovation/agent_workflow';
import {
    buildCheckRawConfig,
    buildUpdateRawConfig,
    normalizeGenerateText,
} from '@/innovation/agent_request';
import { selectUpdateRules } from '@/innovation/agent_worldbook';
import { loadInnovationSettings } from '@/innovation/settings';
import { useDataStore } from '@/store';

/** 最近一次工作流结果（供面板显示） */
let last_workflow_result: AgentWorkflowResult | null = null;

export function getLastWorkflowResult(): AgentWorkflowResult | null {
    return last_workflow_result;
}

/** 从当前消息提取「当前变量状态」文本（供检查阶段） */
function extractStateText(message_id: number): string {
    try {
        const vars: any = getVariables({ type: 'message', message_id });
        const stat = vars?.stat_data;
        if (stat === undefined) return '';
        return typeof stat === 'string' ? stat : JSON.stringify(stat, null, 2);
    } catch {
        return '';
    }
}

/** 读取当前角色可用世界书的 [mvu_update] 规则 */
async function readWorldbookRules(paths: string[]): Promise<string[]> {
    try {
        const names: string[] = getWorldbookNames();
        const entries: any[] = [];
        for (const name of names) {
            try {
                const wb = await getWorldbook(name);
                entries.push(...wb);
            } catch {
                /* 单个世界书读取失败不阻断 */
            }
        }
        return selectUpdateRules(entries, paths).entries;
    } catch {
        return [];
    }
}

/** 解析模型输出中的 <UpdateVariable> 块 */
function extractUpdateBlock(text: string): string {
    const match = text.match(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/i);
    if (match) return match[0];
    if (/<UpdateVariable>/i.test(text)) {
        const start = text.indexOf('<UpdateVariable>');
        return text.slice(start);
    }
    return text.trim();
}

/** 简易格式自检：必须含有效更新命令 */
function selfCheckUpdateBlock(block: string): { ok: boolean; reason?: string } {
    if (!block) return { ok: false, reason: '更新块为空' };
    const has_set = /_\.(?:set|insert|assign|remove|unset|delete|add)\s*\([\s\S]*?\)\s*;/.test(block);
    const has_patch = /json_?patch/i.test(block);
    if (!has_set && !has_patch) {
        return { ok: false, reason: '更新块内没有有效更新命令（_.set(...) 或 json_patch）' };
    }
    return { ok: true };
}

/**
 * 对一条 MESSAGE_RECEIVED 执行革新版四阶段工作流。
 * @param message_id 收到的消息 id
 * @returns 工作流结果；Agent 未启用或状态缺失时返回 null
 */
export async function runAgentWorkflowForMessage(
    message_id: number
): Promise<AgentWorkflowResult | null> {
    const settings = loadInnovationSettings(localStorage);
    if (!settings.agentEnabled) return null;

    const state_text = extractStateText(message_id);
    if (!state_text) {
        // 无变量状态可更新 → 记录一个 no_change
        last_workflow_result = {
            stages: [],
            check: null,
            rules: null,
            update: null,
            selfCheck: null,
            termination: 'no_change',
            retries: 0,
            elapsed_ms: 0,
        };
        return last_workflow_result;
    }

    // 自定义额外模型配置（可选；缺省用当前插头）
    const custom_api: Record<string, any> | undefined = undefined;

    const executor = {
        // 阶段1 检查：只列出需要更新的变量
        check: async (state: string) => {
            const config = buildCheckRawConfig({ state_text: state, custom_api });
            const result = normalizeGenerateText(await generateRaw(config));
            return result;
        },
        // 阶段2 读取相应规则
        readRules: async (paths: string[]) => {
            const entries = await readWorldbookRules(paths);
            return { entries, raw: entries.join('\n---\n') };
        },
        // 阶段3 更新：基于规则产出 delta 并应用【一次】
        update: async (rules: { entries: string[] }, check_raw: string, last_error?: string) => {
            const config = buildUpdateRawConfig({
                rules: rules.entries,
                check_raw,
                last_error,
                custom_api,
            });
            const result = normalizeGenerateText(await generateRaw(config));
            const block = extractUpdateBlock(result);
            if (!block) {
                return { block: '', applied: false, raw: result };
            }
            // 应用到最新变量
            const applied = await applyDeltaBlock(block);
            return { block, applied, raw: result };
        },
        // 阶段4 格式自检
        selfCheck: async (block: string) => selfCheckUpdateBlock(block),
    };

    const workflow_result = await runAgentWorkflow(executor, state_text, {
        maxRetries: Math.max(1, settings.maxSteps - 1),
        loopThreshold: settings.loopThreshold,
    });
    last_workflow_result = workflow_result;

    if (workflow_result.termination === 'error') {
        console.error('[革新版·Agent工作流] 失败', workflow_result.error);
    } else {
        console.debug(
            `[革新版·Agent工作流] 阶段=${workflow_result.stages.join('→')} 终止=${workflow_result.termination}`
        );
    }
    return workflow_result;
}

/** 把 <UpdateVariable> 块解析成可执行命令文本，并用 tavern-helper 变量 API 应用一次 */
async function applyDeltaBlock(block: string): Promise<boolean> {
    const delta = extractDeltaText(block);
    if (!delta) return false;

    const message_id = getLastMessageId();
    const variables: any = getVariables({ type: 'message', message_id: message_id ?? -1 });
    if (!variables || !_.has(variables, 'stat_data')) return false;

    let modified = false;
    updateVariablesWith(
        vars => {
            try {
                // 复用轻量命令提取：_.set(path, value) 等
                const set_regex = /_\.set\s*\(\s*['"](.+?)['"]\s*,\s*(.+?)\s*\)\s*;/gs;
                let m: RegExpExecArray | null;
                let touched = false;
                while ((m = set_regex.exec(delta)) !== null) {
                    const path = m[1];
                    const raw_value = m[2];
                    let value: any = raw_value;
                    try {
                        value = JSON.parse(raw_value);
                    } catch {
                        value = raw_value.replace(/^['"]|['"]$/g, '');
                    }
                    _.set(vars.stat_data, path, value);
                    touched = true;
                }
                if (touched) modified = true;
            } catch {
                /* ignore */
            }
            return vars;
        },
        { type: 'message', message_id: message_id ?? -1 }
    );

    if (modified && useDataStore().settings.兼容性.更新到聊天变量) {
        updateVariablesWith(
            vars => {
                try {
                    _.set(vars, 'stat_data', variables.stat_data);
                } catch {
                    /* ignore */
                }
                return vars;
            },
            { type: 'chat' }
        );
    }
    return modified;
}

/** 从更新块中提取命令文本（去掉 <UpdateVariable> 标签） */
function extractDeltaText(block: string): string {
    if (!block) return '';
    return block
        .replace(/<UpdateVariable>/gi, '')
        .replace(/<\/UpdateVariable>/gi, '')
        .replace(/<Analysis>[\s\S]*?<\/Analysis>/gi, '')
        .trim();
}

/**
 * 初始化革新版独立 Agent 工作流监听。
 * 自己监听 MESSAGE_RECEIVED，不复用 MVU 的 onMessageReceived。
 * @returns 停止函数
 */
export function initAgentWorkflowBridge(): () => void {
    const { stop } = eventOn(tavern_events.MESSAGE_RECEIVED, async (message_id: number) => {
        // 革新的更新方式必须是「额外模型解析」（与 MVU 兼容路径），否则不接管
        const store = useDataStore();
        if (store.settings.更新方式 !== '额外模型解析') {
            return;
        }
        await runAgentWorkflowForMessage(message_id);
    });
    return () => {
        stop();
    };
}
