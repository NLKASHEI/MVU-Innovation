/**
 * [革新版·缓存率] 事件挂载桥接层。
 *
 * 将纯逻辑模块 cache_metrics 接入 tavern_events（运行时全局，由 tavern_helper 提供）。
 * 事件名用字符串字面量（ST 的 tavern_events.GENERATION_ENDED === 'GENERATION_ENDED'），
 * 避免依赖 tavern_helper 全局类型。
 *
 * 用法：
 *  - 在 main.ts 的初始化列表追加 `stop_list.push(initCacheMetricsBridge());`。
 */

import { useDataStore } from '@/store';
import { controlledStoppableEventOn } from '@/util';
import {
    createCacheMetricsState,
    formatCacheMetrics,
    handleGenerationEndedEvent,
    CacheMetricsState,
} from '@/innovation/cache_metrics';

/** 模块内共享状态，供调试/导出使用 */
let bridge_state: CacheMetricsState = createCacheMetricsState();

/**
 * 初始化缓存度量桥接层。
 * @param event_name ST 生成结束事件名（默认 'GENERATION_ENDED'）
 */
export function initCacheMetricsBridge(
    event_name: string = 'GENERATION_ENDED'
): () => void {
    const store = useDataStore();
    const stop = controlledStoppableEventOn(event_name as any, (event_data: unknown) => {
        bridge_state = handleGenerationEndedEvent(
            bridge_state,
            event_data,
            store.runtimes.is_during_extra_analysis
        );
        console.debug(formatCacheMetrics(bridge_state));
    });
    return () => {
        stop();
    };
}

/** 读取当前缓存度量状态（供调试面板/导出使用） */
export function getCacheMetricsState(): CacheMetricsState {
    return bridge_state;
}
