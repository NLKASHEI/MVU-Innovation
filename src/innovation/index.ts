/**
 * [革新版] 聚合初始化模块。
 *
 * 统一挂载所有革新版实验功能，main.ts 只需调用一次 initInnovation()。
 * 目前包含：
 *  - 缓存命中度量（cache_metrics_bridge）：监听 GENERATION_ENDED，统计额外模型解析的
 *    usage.prompt_cache_hit_tokens / prompt_cache_miss_tokens，输出命中率到 console。
 *  - Agent 更新（agent_update_bridge）：主模型流内 tool_call 更新变量实验，
 *    默认 sessionStorage 开关关闭，不影响既有行为。
 *
 * 设计原则：
 *  - 不修改任何原版核心文件；原版升级冲突时本模块可独立裁剪。
 *  - 各子模块的 stop 函数统一收集，pagehide 时一并清理。
 */

import { initCacheMetricsBridge } from '@/innovation/cache_metrics_bridge';
import { initAgentUpdateBridge } from '@/innovation/agent_update_bridge';

/**
 * 初始化所有革新版实验功能。
 * @returns 停止函数（清理所有子模块挂载）
 */
export function initInnovation(): () => void {
    const stop_list: Array<() => void> = [];

    // 切片 B：缓存命中度量
    stop_list.push(initCacheMetricsBridge());

    // 切片 A：Agent 更新（默认 sessionStorage 开关关闭）
    stop_list.push(initAgentUpdateBridge());

    return () => {
        stop_list.forEach(stop => stop());
    };
}
