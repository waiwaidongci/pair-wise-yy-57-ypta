<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Checkout, ServerStep, StepEvidence, StepResult } from '../types'
import { useTestStore } from '../store'

const props = defineProps<{
  caseId: string
  step: ServerStep
  checkout?: Checkout
  tokenCurrent: string
}>()

const store = useTestStore()

const working = computed(() => props.checkout?.working.find((w) => w.stepId === props.step.id))
const iamHolder = computed(() => props.checkout?.state === '执行中' && props.checkout.operator === store.operator)
const tokenFresh = computed(() => !!props.checkout && props.checkout.baseToken === props.tokenCurrent)
const editable = computed(() => iamHolder.value && tokenFresh.value && !props.step.invalid)
const stale = computed(() => !!props.checkout && (props.checkout.state === '已失效' || !tokenFresh.value))

const result = ref<StepResult>('通过')
const actual = ref('')
const evidencePayload = ref('')
watch(
  working,
  (w) => {
    if (w) {
      result.value = w.result === '未执行' ? '通过' : w.result
      actual.value = w.actual
      evidencePayload.value = w.evidencePayload
    }
  },
  { immediate: true },
)

const latest = computed<StepEvidence | undefined>(() => store.stepEvidence(props.caseId, props.step.id))
const sealed = computed(() => store.stepAllEvidence(props.caseId, props.step.id))

function save() {
  if (!props.checkout) return
  store.saveWorking(props.checkout.id, props.step.id, result.value, actual.value, evidencePayload.value)
}
function commit() {
  if (!props.checkout) return
  if (!evidencePayload.value.trim()) return
  store.commitStep(props.checkout.id, props.step.id)
}
</script>

<template>
  <div class="step-co" :class="{ invalid: step.invalid, stale }">
    <div class="step-co-head">
      <b>{{ step.id }} · {{ step.action }}</b>
      <n-space :size="6" align="center">
        <n-tag v-if="step.invalid" type="warning" size="small">失效待重测</n-tag>
        <n-tag v-else-if="latest" :type="latest.result === '通过' ? 'success' : 'error'" size="small">
          {{ latest.result }} · {{ latest.source === '历史补齐' ? '历史证据' : `证据 ${latest.id}` }}
        </n-tag>
        <n-tag v-else :type="step.result === '未执行' ? 'default' : 'info'" size="small">{{ step.result }}（无有效证据）</n-tag>
        <n-tag v-if="working?.dirty" type="warning" size="small">未提交</n-tag>
      </n-space>
    </div>
    <p class="muted">预期：{{ step.expected }}<template v-if="step.dependency"> · 依赖 {{ step.dependency }}</template></p>
    <p v-if="step.invalid" class="invalid-note">失效原因：{{ step.invalidReason }}；原封存证据保留，确认修订后按有效证据重算。</p>

    <!-- 当前持有者可编辑（版本过期只读） -->
    <div v-if="editable" class="step-edit">
      <n-radio-group v-model:value="result" size="small">
        <n-radio-button value="通过">通过</n-radio-button>
        <n-radio-button value="失败">失败</n-radio-button>
      </n-radio-group>
      <n-input v-model:value="actual" placeholder="实测情况" size="small" />
      <n-input v-model:value="evidencePayload" placeholder="执行证据：截图 / 录屏 / 联锁日志编号（提交必填）" size="small" />
      <n-space :size="8">
        <n-button size="small" @click="save">暂存到签出</n-button>
        <n-button size="small" type="primary" :disabled="!evidencePayload.trim()" @click="commit">提交并封存证据</n-button>
      </n-space>
    </div>

    <!-- 非持有者 / 过期：只读 -->
    <div v-else class="step-readonly">
      <n-alert v-if="stale" type="warning" :show-icon="false" class="readonly-alert">
        签出 {{ checkout?.id }} 版本指纹已过期（{{ checkout?.staleReason || '重开仅可查看' }}），不可再提交。
      </n-alert>
      <template v-if="working && (working.actual || working.evidencePayload)">
        <small class="muted">签出内草稿：{{ working.result }} · {{ working.actual }} · {{ working.evidencePayload || '无证据' }}</small>
      </template>
      <small v-else-if="!iamHolder" class="muted">只读视图：当前持有者 {{ checkout?.operator ?? '—' }}，可在取得签出后填写。</small>
    </div>

    <!-- 封存证据链：只增不改 -->
    <div v-if="sealed.length" class="evidence-chain">
      <small class="muted">封存证据 {{ sealed.length }} 份（保留留档，按版本采信）：</small>
      <div v-for="ev in sealed" :key="ev.id" class="evidence-item" :class="{ unusable: latest?.id !== ev.id }">
        <n-tag size="tiny" :type="ev.source === '历史补齐' ? 'info' : 'success'">{{ ev.source }}</n-tag>
        <span><b>{{ ev.id }}</b> · {{ ev.operator }} · {{ ev.result }} · {{ ev.stationVersion }}</span>
        <small class="muted">{{ ev.payload }} · 签出 {{ ev.checkoutId }} · 请求 {{ ev.requestId }}</small>
      </div>
    </div>
  </div>
</template>
