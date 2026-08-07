<template>
    <Section label="革新版实验（MVU-Innovation）">
        <template #content>
            <Detail title="Agent 更新（主模型流内多步工具调用）">
                <Checkbox v-model="settings.agentEnabled">
                    <span>启用 Agent 更新（多步循环）</span>
                </Checkbox>

                <Field id="nlkaleido_agent_max_steps" label="最大步数">
                    <RangeNumber
                        v-model="settings.maxSteps"
                        :min="1"
                        :max="10"
                        :step="1"
                    />
                </Field>

                <Field id="nlkaleido_agent_loop_threshold" label="死循环熔断阈值">
                    <RangeNumber
                        v-model="settings.loopThreshold"
                        :min="2"
                        :max="10"
                        :step="1"
                    />
                </Field>

                <p class="nlkaleido-tip">
                    开启后，变量更新从「单次解析」升级为「多步循环」：
                    每轮分析最近剧情 → 更新变量 → 直到变量稳定或达到最大步数。
                </p>
            </Detail>

            <Detail title="缓存命中度量">
                <Checkbox v-model="settings.cacheMetricsEnabled">
                    <span>在 console 输出缓存命中率</span>
                </Checkbox>
                <div class="nlkaleido-cache-metrics">
                    <span>请求 <b>{{ cacheMetrics.totalRequests }}</b></span>
                    <span>命中 <b>{{ cacheMetrics.hitTokens }}</b></span>
                    <span>未命中 <b>{{ cacheMetrics.missTokens }}</b></span>
                    <span>
                        命中率
                        <b>{{ cacheRateText }}</b>
                    </span>
                </div>
            </Detail>

            <Detail title="最近 Agent 循环">
                <div v-if="lastLoop" class="nlkaleido-loop-result">
                    <span>步数 <b>{{ lastLoop.steps.length }}</b></span>
                    <span>终止原因 <b>{{ lastLoop.termination }}</b></span>
                    <span v-if="lastLoop.loop_broken" class="nlkaleido-warn">
                        死循环已熔断
                    </span>
                </div>
                <p v-else class="nlkaleido-tip">尚无循环记录（开启 Agent 后产生）。</p>
            </Detail>
        </template>
    </Section>
</template>

<script setup lang="ts">
import Checkbox from '@/panel/component/Checkbox.vue';
import Detail from '@/panel/component/Detail.vue';
import Field from '@/panel/component/Field.vue';
import RangeNumber from '@/panel/component/RangeNumber.vue';
import Section from '@/panel/component/Section.vue';
import { getCacheMetricsState } from '@/innovation/cache_metrics_bridge';
import { getLastAgentLoopResult } from '@/innovation/agent_update_bridge';
import {
    loadInnovationSettings,
    saveInnovationSettings,
} from '@/innovation/settings';
import { computed, onUnmounted, ref, watch } from 'vue';

const settings = ref(loadInnovationSettings(localStorage));

watch(
    settings,
    value => {
        saveInnovationSettings(localStorage, value);
    },
    { deep: true }
);

const cacheMetrics = ref(getCacheMetricsState());
const lastLoop = ref(getLastAgentLoopResult());
const cacheRateText = computed(() => {
    const total = cacheMetrics.value.hitTokens + cacheMetrics.value.missTokens;
    if (total <= 0) return 'N/A';
    return `${((cacheMetrics.value.hitTokens / total) * 100).toFixed(1)}%`;
});

// 周期性刷新缓存度量与循环状态
const timer = setInterval(() => {
    cacheMetrics.value = getCacheMetricsState();
    lastLoop.value = getLastAgentLoopResult();
}, 3000);

onUnmounted(() => {
    clearInterval(timer);
});
</script>

<style scoped>
.nlkaleido-tip {
    opacity: 0.8;
    font-size: calc(var(--mainFontSize, 1rem) * 0.9);
    margin: 0.25rem 0;
}
.nlkaleido-cache-metrics,
.nlkaleido-loop-result {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 0.9rem;
    margin-top: 0.35rem;
}
.nlkaleido-warn {
    color: var(--SmartThemeEmColor, #d39e00);
}
</style>
