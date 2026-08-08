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

            <Detail title="工作流调试日志（最近 50 次运行）">
                <div class="nlkaleido-debug-list">
                    <div
                        v-for="entry in debugLogs"
                        :key="entry.id"
                        class="nlkaleido-debug-run"
                    >
                        <button
                            class="menu_button nlkaleido-debug-header"
                            @click="toggleDebug(entry.id)"
                        >
                            <span class="nlkaleido-debug-id">#{{ entry.id }}</span>
                            <span class="nlkaleido-debug-time">{{ formatTime(entry.ts) }}</span>
                            <span class="nlkaleido-debug-term">{{ entry.termination }}</span>
                            <span
                                class="nlkaleido-debug-calls"
                                :class="{ 'nlkaleido-warn': (entry.decide ? 1 : 0) + entry.updates.length > 1 }"
                            >
                                模型调用 ×{{ (entry.decide ? 1 : 0) + entry.updates.length }}
                            </span>
                            <span class="nlkaleido-debug-dur">{{ entry.duration_ms }}ms</span>
                            <span class="nlkaleido-debug-stages">{{ entry.stages.join('→') }}</span>
                        </button>
                        <div v-if="expanded[entry.id]" class="nlkaleido-debug-body">
                            <div v-if="entry.decide" class="nlkaleido-debug-update">
                                <p class="nlkaleido-debug-line">
                                    <b>AI 决策</b>（{{ entry.decide.duration_ms }}ms）：决策
                                    {{ entry.decide.parsed_count }} 个变量
                                </p>
                                <pre class="nlkaleido-debug-pre">{{ entry.decide.text_preview }}</pre>
                            </div>
                            <p v-if="entry.worldbook" class="nlkaleido-debug-line">
                                <b>世界书扫描</b>：全部 {{ entry.worldbook.total_names }} 本 ·
                                活跃 {{ entry.worldbook.active_names.length }} 本 ·
                                加载「{{ entry.worldbook.loaded_names.join('、') }}」·
                                条目 {{ entry.worldbook.loaded_entries }} ·
                                规则 {{ entry.worldbook.rules_matched }} 条 ·
                                剧情 {{ entry.worldbook.plot_matched }} 条 ·
                                回退 {{ entry.worldbook.fell_back ? '是' : '否' }}
                            </p>
                            <p v-if="entry.due && entry.due.length" class="nlkaleido-debug-line">
                                <b>due 候选</b>：{{ entry.due.join('、') }}
                            </p>
                            <p v-if="entry.observation" class="nlkaleido-debug-line">
                                <b>观察投影</b>：{{ entry.observation.paths.length }} 字段
                                <span v-if="entry.observation.folded > 0">
                                    （折叠 {{ entry.observation.folded }}）
                                </span>
                                ：{{ entry.observation.paths.join('、') }}
                            </p>
                            <div
                                v-for="upd in entry.updates"
                                :key="upd.attempt"
                                class="nlkaleido-debug-update"
                            >
                                <p class="nlkaleido-debug-line">
                                    <b>调用 #{{ upd.attempt }}</b>
                                    （{{ upd.structured ? 'json_schema' : '文本降级' }}，
                                    {{ upd.duration_ms }}ms）
                                    <span v-if="upd.fed_error" class="nlkaleido-warn">
                                        喂回：{{ upd.fed_error }}
                                    </span>
                                </p>
                                <pre class="nlkaleido-debug-pre">{{ upd.block_preview }}</pre>
                            </div>
                            <p
                                v-if="entry.validation_errors.length"
                                class="nlkaleido-debug-line nlkaleido-warn"
                            >
                                <b>校验错误</b>：{{ entry.validation_errors.join('；') }}
                            </p>
                            <p class="nlkaleido-debug-line">
                                <b>应用</b>：{{ entry.applied ? '已修改变量' : '未修改' }}
                                <span v-if="entry.error" class="nlkaleido-warn">
                                    ｜错误：{{ entry.error }}
                                </span>
                            </p>
                        </div>
                    </div>
                    <p v-if="debugLogs.length === 0" class="nlkaleido-tip">
                        尚无运行记录（开启 Agent 并发送消息后产生）。
                    </p>
                </div>
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
import {
    getLastWorkflowResult,
    getWorkflowDebugLogs,
} from '@/innovation/agent_workflow_bridge';
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
const debugLogs = ref(getWorkflowDebugLogs());
const expanded = ref<Record<number, boolean>>({});
const cacheRateText = computed(() => {
    const total = cacheMetrics.value.hitTokens + cacheMetrics.value.missTokens;
    if (total <= 0) return 'N/A';
    return `${((cacheMetrics.value.hitTokens / total) * 100).toFixed(1)}%`;
});

function toggleDebug(id: number) {
    expanded.value[id] = !expanded.value[id];
}

function formatTime(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

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

// 周期性刷新缓存度量、工作流状态与调试日志
const timer = setInterval(() => {
    cacheMetrics.value = getCacheMetricsState();
    lastWorkflow.value = getLastWorkflowResult();
    debugLogs.value = getWorkflowDebugLogs();
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
.nlkaleido-debug-list {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-top: 0.35rem;
}
.nlkaleido-debug-header {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.7rem;
    align-items: center;
    width: 100%;
    justify-content: flex-start;
    text-align: left;
    font-size: calc(var(--mainFontSize, 1rem) * 0.88);
}
.nlkaleido-debug-id {
    color: var(--SmartThemeEmColor, #d39e00);
    font-weight: bold;
}
.nlkaleido-debug-term {
    font-weight: bold;
}
.nlkaleido-debug-calls {
    font-weight: bold;
}
.nlkaleido-debug-stages {
    opacity: 0.75;
}
.nlkaleido-debug-body {
    border-left: 2px solid var(--SmartThemeBorderColor, #555);
    margin: 0.25rem 0 0.5rem 0.35rem;
    padding: 0.25rem 0.6rem;
}
.nlkaleido-debug-line {
    margin: 0.2rem 0;
    font-size: calc(var(--mainFontSize, 1rem) * 0.85);
    opacity: 0.95;
    word-break: break-all;
}
.nlkaleido-debug-pre {
    margin: 0.15rem 0 0.4rem;
    padding: 0.3rem 0.5rem;
    background: rgba(0, 0, 0, 0.25);
    border-radius: 4px;
    white-space: pre-wrap;
    word-break: break-all;
    font-size: calc(var(--mainFontSize, 1rem) * 0.78);
    max-height: 8em;
    overflow-y: auto;
}
.nlkaleido-debug-update {
    margin-top: 0.25rem;
}
</style>
