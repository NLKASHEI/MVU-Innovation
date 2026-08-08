/**
 * [革新版] 聚合初始化模块。
 *
 * 统一挂载所有革新版实验功能，main.ts 只需调用一次 initInnovation()。
 * 目前包含：
 *  - 缓存命中度量（cache_metrics_bridge）：监听 GENERATION_ENDED，统计额外模型解析的
 *    usage.prompt_cache_hit_tokens / prompt_cache_miss_tokens，输出命中率到 console。
 *  - Agent 独立工作流（agent_workflow_bridge）：革新版自己的四阶段更新链路，
 *    自己监听 MESSAGE_RECEIVED、自己构造请求（generateRaw）、自己读世界书规则、
 *    自己应用变量——不复用 MVU 的 invokeExtraModelWithStrategy / onMessageReceived。
 *  - 更新检查（update_check_bridge）：面板「检查更新」，GitHub tags API 版本比对。
 *
 * 设计原则：
 *  - 革新版 Agent 更新链路完全独立（见 agent_workflow_bridge.ts）。
 *  - 各子模块的 stop 函数统一收集，pagehide 时一并清理。
 */

import { initCacheMetricsBridge } from '@/innovation/cache_metrics_bridge';
import { initAgentWorkflowBridge } from '@/innovation/agent_workflow_bridge';

/**
 * 初始化所有革新版实验功能。
 * @returns 停止函数（清理所有子模块挂载）
 */
export function initInnovation(): () => void {
    const stop_list: Array<() => void> = [];

    // 切片 B：缓存命中度量
    stop_list.push(initCacheMetricsBridge());

    // 切片 A：Agent 独立工作流（革新版自己的四阶段更新链路）
    stop_list.push(initAgentWorkflowBridge());

    return () => {
        stop_list.forEach(stop => stop());
    };
}
