import {
    computeCacheHitRate,
    createCacheMetricsState,
    formatCacheMetrics,
    handleGenerationEndedEvent,
    recordCacheUsage,
} from '@/innovation/cache_metrics';

describe('innovation cache_metrics', () => {
    describe('recordCacheUsage', () => {
        test('累加 hit/miss token，并更新最近值', () => {
            let state = createCacheMetricsState();
            state = recordCacheUsage(state, {
                prompt_cache_hit_tokens: 100,
                prompt_cache_miss_tokens: 200,
            });
            expect(state.totalRequests).toBe(1);
            expect(state.measuredRequests).toBe(1);
            expect(state.hitTokens).toBe(100);
            expect(state.missTokens).toBe(200);
            expect(state.lastHitTokens).toBe(100);
            expect(state.lastMissTokens).toBe(200);

            state = recordCacheUsage(state, {
                prompt_cache_hit_tokens: 50,
                prompt_cache_miss_tokens: 10,
            });
            expect(state.totalRequests).toBe(2);
            expect(state.measuredRequests).toBe(2);
            expect(state.hitTokens).toBe(150);
            expect(state.missTokens).toBe(210);
            expect(state.lastHitTokens).toBe(50);
            expect(state.lastMissTokens).toBe(10);
        });

        test('usage 嵌套在 { usage } 里也能解析', () => {
            let state = createCacheMetricsState();
            state = recordCacheUsage(state, {
                usage: { prompt_cache_hit_tokens: 42, prompt_cache_miss_tokens: 8 },
            });
            expect(state.measuredRequests).toBe(1);
            expect(state.hitTokens).toBe(42);
            expect(state.missTokens).toBe(8);
        });

        test('无缓存字段或 undefined 时，totalRequests 递增但 measured 不变', () => {
            let state = createCacheMetricsState();
            state = recordCacheUsage(state, undefined);
            expect(state.totalRequests).toBe(1);
            expect(state.measuredRequests).toBe(0);

            state = recordCacheUsage(state, { prompt_tokens: 999, completion_tokens: 5 });
            expect(state.totalRequests).toBe(2);
            expect(state.measuredRequests).toBe(0);
            expect(state.hitTokens).toBe(0);
        });

        test('不修改原 state（不可变性）', () => {
            const state = createCacheMetricsState();
            recordCacheUsage(state, {
                prompt_cache_hit_tokens: 10,
                prompt_cache_miss_tokens: 5,
            });
            expect(state.totalRequests).toBe(0);
            expect(state.hitTokens).toBe(0);
        });
    });

    describe('handleGenerationEndedEvent', () => {
        test('在额外模型解析期间记录 usage', () => {
            const state = createCacheMetricsState();
            const next = handleGenerationEndedEvent(
                state,
                { prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 5 },
                true
            );
            expect(next.totalRequests).toBe(1);
            expect(next.hitTokens).toBe(10);
            expect(next.missTokens).toBe(5);
        });

        test('不在额外模型解析期间（主模型请求）时跳过，返回原状态', () => {
            const state = createCacheMetricsState();
            const next = handleGenerationEndedEvent(
                state,
                { prompt_cache_hit_tokens: 999, prompt_cache_miss_tokens: 999 },
                false
            );
            expect(next).toBe(state);
            expect(next.totalRequests).toBe(0);
        });
    });

    describe('computeCacheHitRate', () => {
        test('有数据时返回 hit/(hit+miss)', () => {
            let state = createCacheMetricsState();
            state = recordCacheUsage(state, {
                prompt_cache_hit_tokens: 300,
                prompt_cache_miss_tokens: 100,
            });
            expect(computeCacheHitRate(state)).toBeCloseTo(0.75);
        });

        test('无数据时返回 null', () => {
            expect(computeCacheHitRate(createCacheMetricsState())).toBeNull();
        });

        test('仅 miss 时返回 0', () => {
            let state = createCacheMetricsState();
            state = recordCacheUsage(state, {
                prompt_cache_hit_tokens: 0,
                prompt_cache_miss_tokens: 100,
            });
            expect(computeCacheHitRate(state)).toBe(0);
        });
    });

    describe('formatCacheMetrics', () => {
        test('格式化输出包含各统计字段', () => {
            let state = createCacheMetricsState();
            state = recordCacheUsage(state, {
                prompt_cache_hit_tokens: 150,
                prompt_cache_miss_tokens: 50,
            });
            const text = formatCacheMetrics(state);
            expect(text).toContain('[革新版·缓存]');
            expect(text).toContain('requests=1');
            expect(text).toContain('hit=150');
            expect(text).toContain('miss=50');
            expect(text).toContain('rate=75.0%');
        });

        test('无数据时 rate=N/A', () => {
            const text = formatCacheMetrics(createCacheMetricsState());
            expect(text).toContain('rate=N/A');
        });
    });
});
