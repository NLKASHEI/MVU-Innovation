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

            <Detail title="最近 Agent 工作流">
                <div v-if="lastWorkflow" class="nlkaleido-loop-result">
                    <span>阶段 <b>{{ lastWorkflow.stages.join(' → ') || '（无）' }}</b></span>
                    <span>终止 <b>{{ lastWorkflow.termination }}</b></span>
                    <span v-if="lastWorkflow.retries > 0">自检重试 <b>{{ lastWorkflow.retries }}</b> 次</span>
                    <span v-if="lastWorkflow.error" class="nlkaleido-warn">
                        错误：{{ lastWorkflow.error }}
                    </span>
                </div>
                <p v-else class="nlkaleido-tip">尚无工作流记录（开启 Agent 并发送消息后产生）。</p>
            </Detail>

            <Detail title="版本与更新">
                <p class="nlkaleido-tip">
                    当前版本 <b>{{ currentVersion }}</b>
                    <span v-if="updateCheck">
                        <template v-if="updateCheck.ok && updateCheck.hasUpdate">
                            · 有新版 <b class="nlkaleido-warn">{{ updateCheck.latest }}</b>
                        </template>
                        <template v-else-if="updateCheck.ok">
                            · 已是最新
                        </template>
                        <template v-else>
                            · 检查失败（{{ updateCheck.error }}）
                        </template>
                    </span>
                </p>
                <button class="menu_button" :disabled="checking" @click="onCheckUpdate">
                    {{ checking ? '检查中…' : '检查更新' }}
                </button>
                <button
                    v-if="updateCheck && updateCheck.url"
                    class="menu_button"
                    @click="onCopyUpdateUrl"
                >
                    复制最新 URL
                </button>
                <p
                    v-if="updateCheck && updateCheck.ok && updateCheck.hasUpdate"
                    class="nlkaleido-tip"
                >
                    更新方法：把 TavernHelper 脚本地址换成上方 URL，并「重新加载」脚本即可。
                </p>
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
import { getLastWorkflowResult } from '@/innovation/agent_workflow_bridge';
import {
    checkForUpdatesNow,
    getLastUpdateCheck,
    isCheckingUpdates,
} from '@/innovation/update_check_bridge';
import { INNOVATION_VERSION } from '@/innovation/version';
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
const lastWorkflow = ref(getLastWorkflowResult());
const cacheRateText = computed(() => {
    const total = cacheMetrics.value.hitTokens + cacheMetrics.value.missTokens;
    if (total <= 0) return 'N/A';
    return `${((cacheMetrics.value.hitTokens / total) * 100).toFixed(1)}%`;
});

const currentVersion = INNOVATION_VERSION;
const updateCheck = ref(getLastUpdateCheck());
const checking = ref(isCheckingUpdates());

async function onCheckUpdate() {
    checking.value = true;
    updateCheck.value = await checkForUpdatesNow();
    checking.value = isCheckingUpdates();
}

async function onCopyUpdateUrl() {
    if (!updateCheck.value?.url) return;
    try {
        await navigator.clipboard.writeText(updateCheck.value.url);
    } catch {
        // 某些环境剪贴板不可用，忽略
    }
}

// 周期性刷新缓存度量与工作流状态
const timer = setInterval(() => {
    cacheMetrics.value = getCacheMetricsState();
    lastWorkflow.value = getLastWorkflowResult();
}, 2000);

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
