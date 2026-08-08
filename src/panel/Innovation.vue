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
                    <span>原版额外模型解析 请求 <b>{{ cacheMetrics.totalRequests }}</b></span>
                    <span>命中 <b>{{ cacheMetrics.hitTokens }}</b></span>
                    <span>未命中 <b>{{ cacheMetrics.missTokens }}</b></span>
                    <span>
                        命中率
                        <b>{{ cacheRateText }}</b>
                    </span>
                </div>
                <div class="nlkaleido-cache-metrics">
                    <span>革新版 Agent 调用 请求 <b>{{ innovationCache.totalRequests }}</b></span>
                    <span>命中 <b>{{ innovationCache.hitTokens }}</b></span>
                    <span>未命中 <b>{{ innovationCache.missTokens }}</b></span>
                    <span>
                        命中率
                        <b>{{ innovationCacheRateText }}</b>
                    </span>
                </div>
                <p class="nlkaleido-tip">
                    革新版每楼层两次调用（决策+更新）：第二次请求前缀 = 第一次全部消息 → 楼内命中率高；
                    跨楼层仅命中固定任务模板。无 usage 返回的 provider（OpenAI）不计费不显示。
                </p>
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
                <button
                    class="menu_button"
                    :disabled="retrying || !settings.agentEnabled"
                    @click="onRetryWorkflow"
                >
                    {{ retrying ? '更新中…' : '重试最近一次更新' }}
                </button>
            </Detail>

            <Detail title="世界书缓存池（初始化预热）">
                <p v-if="poolState && poolState.error" class="nlkaleido-warn">
                    缓存池错误：{{ poolState.error }}
                </p>
                    <p v-else-if="poolState" class="nlkaleido-tip">
                        建池 {{ formatTime(poolState.builtAt) }} ·
                        加载「{{ poolState.loaded_names.join('、') }}」·
                        入池 <b>{{ poolState.entries }}</b> 条目
                        （规则 {{ poolState.rules }} ·
                        背景 {{ poolState.entries - poolState.rules }} ·
                        灯效 蓝{{ poolState.strategy.constant }} / 绿{{ poolState.strategy.selective }} /
                        向量{{ poolState.strategy.vectorized }}）·
                        索引 规则路径{{ poolState.indexStats.rulePaths }} /
                        精确映射{{ poolState.indexStats.rulePathToRules }} ·
                        ZOD 仓库
                        {{
                            poolState.zodScripts.length > 0
                                ? `「${poolState.zodScripts.join('、')}」${poolState.zodPathCount} 路径`
                                : '未发现'
                        }} ·
                        AI 规则分池
                    {{
                        poolState.aiMerged
                            ? `已合并（${poolState.aiBatchesOk}/${poolState.aiBatchesTotal} 批，${poolState.aiDurationMs}ms）`
                            : poolState.aiBatchesTotal > 0 && poolState.aiDurationMs > 0
                              ? `尝试过（${poolState.aiBatchesOk}/${poolState.aiBatchesTotal} 批）`
                              : '未触发'
                    }}
                </p>
                <p v-else class="nlkaleido-tip">
                    缓存池尚未加载（进入卡或手动加载后自动预热）。
                </p>
                <button class="menu_button" :disabled="poolLoading" @click="onLoadPool">
                    {{ poolLoading ? '加载中…' : '手动加载缓存池' }}
                </button>
                <p class="nlkaleido-tip">
                    进入卡时自动做 AI 规则分池（模型逐条阅读 [mvu_update] 规则条目，通常几秒）；
                    手动按钮强制重建池并重新分池。
                </p>
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
                            <span v-if="entry.apiSource" class="nlkaleido-debug-line">
                                API {{ entry.apiSource }}
                            </span>
                        </button>
                        <div v-if="expanded[entry.id]" class="nlkaleido-debug-body">
                            <p v-if="entry.candidates" class="nlkaleido-debug-line">
                                <b>启发式候选</b>：{{ entry.candidates.length }} 个
                                （规则 {{ entry.candidateSource?.from_rules ?? 0 }} +
                                剧情 {{ entry.candidateSource?.from_story ?? 0 }}）
                                ：{{ entry.candidates.join('、') }}
                            </p>
                            <div v-if="entry.decide" class="nlkaleido-debug-update">
                                <p class="nlkaleido-debug-line">
                                    <b>AI 决策</b>（{{ entry.decide.duration_ms }}ms）：决策
                                    {{ entry.decide.parsed_count }} 个变量
                                    <button
                                        class="menu_button nlkaleido-debug-toggle"
                                        @click="toggleFull(entry.id, 'decide')"
                                    >
                                        {{ fullOpen[entry.id + ':decide'] ? '收起' : '查看完整输入/输出' }}
                                    </button>
                                </p>
                                <pre class="nlkaleido-debug-pre">{{ entry.decide.text_preview }}</pre>
                                <div v-if="fullOpen[entry.id + ':decide']">
                                    <p class="nlkaleido-debug-line"><b>完整输入提示词：</b></p>
                                    <pre class="nlkaleido-debug-pre nlkaleido-debug-full">{{
                                        entry.decide.fullTask
                                    }}</pre>
                                    <p class="nlkaleido-debug-line"><b>完整模型输出：</b></p>
                                    <pre class="nlkaleido-debug-pre nlkaleido-debug-full">{{
                                        entry.decide.fullRaw
                                    }}</pre>
                                </div>
                            </div>
                            <p v-if="entry.worldbook" class="nlkaleido-debug-line">
                                <b>世界书扫描</b>（{{ entry.worldbook.duration_ms }}ms）：
                                全部 {{ entry.worldbook.total_names }} 本 ·
                                只读「{{ entry.worldbook.loaded_names.join('、') }}」·
                                条目 {{ entry.worldbook.loaded_entries }} ·
                                规则 {{ entry.worldbook.rules_matched }} 条 ·
                                剧情 {{ entry.worldbook.plot_matched }} 条 ·
                                回退 {{ entry.worldbook.fell_back ? '是' : '否' }}
                            </p>
                            <p v-if="entry.pool" class="nlkaleido-debug-line">
                                <b>缓存池</b>：入池 {{ entry.pool.entries }} 条目
                                （规则 {{ entry.pool.rules }} ·
                                灯效 蓝{{ entry.pool.strategy.constant }} / 绿{{ entry.pool.strategy.selective }} /
                                向量{{ entry.pool.strategy.vectorized }}）·
                                索引 规则路径{{ entry.pool.indexStats.rulePaths }} /
                                精确映射{{ entry.pool.indexStats.rulePathToRules }} ·
                                ZOD 仓库
                                {{
                                    entry.pool.zodScripts.length > 0
                                        ? `「${entry.pool.zodScripts.join('、')}」${entry.pool.zodPathCount} 路径`
                                        : '未发现'
                                }} ·
                                AI 规则分池
                                {{
                                    entry.pool.aiMerged
                                        ? '已合并'
                                        : entry.pool.aiAttempted
                                          ? '尝试过（失败）'
                                          : '未触发'
                                }}
                                <span v-if="entry.pool.aiBatchesTotal > 0">
                                    （{{ entry.pool.aiBatchesOk }}/{{ entry.pool.aiBatchesTotal }} 批，
                                    {{ entry.pool.aiDurationMs }}ms）
                                </span>
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
                                <span v-if="entry.loreCount > 0" class="nlkaleido-debug-line">
                                    ｜背景 {{ entry.loreCount }} 条
                                </span>
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
                                    <button
                                        class="menu_button nlkaleido-debug-toggle"
                                        @click="toggleFull(entry.id, 'update' + upd.attempt)"
                                    >
                                        {{
                                            fullOpen[entry.id + ':update' + upd.attempt]
                                                ? '收起'
                                                : '查看完整输入/输出'
                                        }}
                                    </button>
                                </p>
                                <pre class="nlkaleido-debug-pre">{{ upd.block_preview }}</pre>
                                <div v-if="fullOpen[entry.id + ':update' + upd.attempt]">
                                    <p class="nlkaleido-debug-line"><b>完整输入提示词：</b></p>
                                    <pre class="nlkaleido-debug-pre nlkaleido-debug-full">{{
                                        upd.fullTask
                                    }}</pre>
                                    <p class="nlkaleido-debug-line"><b>完整模型输出：</b></p>
                                    <pre class="nlkaleido-debug-pre nlkaleido-debug-full">{{
                                        upd.fullRaw
                                    }}</pre>
                                </div>
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
    getInnovationCacheMetrics,
    getLastWorkflowResult,
    getWorkflowDebugLogs,
    getWorldbookPoolState,
    isWorldbookPoolLoading,
    loadWorldbookPoolNow,
    retryLastAgentWorkflow,
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
const innovationCache = ref(getInnovationCacheMetrics());
const lastWorkflow = ref(getLastWorkflowResult());
const debugLogs = ref(getWorkflowDebugLogs());
const expanded = ref<Record<number, boolean>>({});
const poolState = ref(getWorldbookPoolState());
const poolLoading = ref(isWorldbookPoolLoading());
const cacheRateText = computed(() => {
    const total = cacheMetrics.value.hitTokens + cacheMetrics.value.missTokens;
    if (total <= 0) return 'N/A';
    return `${((cacheMetrics.value.hitTokens / total) * 100).toFixed(1)}%`;
});

const innovationCacheRateText = computed(() => {
    const total = innovationCache.value.hitTokens + innovationCache.value.missTokens;
    if (total <= 0) return 'N/A';
    return `${((innovationCache.value.hitTokens / total) * 100).toFixed(1)}%`;
});

async function onLoadPool() {
    poolLoading.value = true;
    try {
        await loadWorldbookPoolNow(true);
    } finally {
        poolLoading.value = false;
        poolState.value = getWorldbookPoolState();
    }
}

const retrying = ref(false);

async function onRetryWorkflow() {
    retrying.value = true;
    try {
        await retryLastAgentWorkflow();
    } finally {
        retrying.value = false;
        lastWorkflow.value = getLastWorkflowResult();
        debugLogs.value = getWorkflowDebugLogs();
    }
}

function toggleDebug(id: number) {
    expanded.value[id] = !expanded.value[id];
}

const fullOpen = ref<Record<string, boolean>>({});

function toggleFull(id: number, key: string) {
    const full_key = `${id}:${key}`;
    fullOpen.value[full_key] = !fullOpen.value[full_key];
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

// 周期性刷新缓存度量、工作流状态、调试日志与缓存池状态
const timer = setInterval(() => {
    cacheMetrics.value = getCacheMetricsState();
    innovationCache.value = getInnovationCacheMetrics();
    lastWorkflow.value = getLastWorkflowResult();
    debugLogs.value = getWorkflowDebugLogs();
    poolState.value = getWorldbookPoolState();
    poolLoading.value = isWorldbookPoolLoading();
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
.nlkaleido-debug-toggle {
    font-size: calc(var(--mainFontSize, 1rem) * 0.75);
    padding: 0.1rem 0.4rem;
    margin-left: 0.4rem;
    vertical-align: middle;
}
.nlkaleido-debug-full {
    /* 展开区不截断：完整输入/输出原样显示 */
    max-height: none;
    max-width: 100%;
}
.nlkaleido-debug-update {
    margin-top: 0.25rem;
}
</style>
