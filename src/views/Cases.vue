<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useTestStore } from '../store'

const store = useTestStore()
const router = useRouter()
const editMode = ref(false)
const selectedCase = computed(() => store.selectedCase)

function statusType(status?: string) {
  return status === '通过' ? 'success' : status === '失败' ? 'error' : status === '待重测' ? 'warning' : 'info'
}
</script>

<template>
  <section class="page-head">
    <div><p class="eyebrow">步骤、预期与依赖</p><h1>测试用例编排</h1><p>步骤结果以封存证据为准；版本失效的步骤必须重测，任何人不得无痕跳过。</p></div>
    <n-space><n-switch v-model:value="editMode">查看签出信息</n-switch><n-button type="primary" @click="router.push('/execution')">前往执行签出</n-button></n-space>
  </section>
  <div class="case-grid">
    <aside class="card case-list">
      <n-input placeholder="搜索用例、进路或设备" clearable />
      <button v-for="item in store.cases" :key="item.id" :class="{ active: item.id === store.selectedCaseId }" @click="store.selectCase(item.id)">
        <div>
          <b>{{ item.id}}</b>
          <small>{{ item.name }}</small>
          <small v-if="editMode" class="muted">持有者：{{ store.holderOf(item.id)?.operator ?? '—' }} · 版本 {{ item.version }}</small>
        </div>
        <n-tag :type="statusType(store.caseTally(item.id)?.status)">{{ store.caseTally(item.id)?.status ?? '—' }}</n-tag>
      </button>
    </aside>
    <article class="card detail" v-if="selectedCase">
      <div class="panel-head">
        <div><h2>{{ selectedCase.id }} · {{ selectedCase.name }}</h2><p>{{ selectedCase.precondition }}</p></div>
        <n-space align="center">
          <n-tag type="info">{{ selectedCase.version }}</n-tag>
          <n-tag :type="store.holderOf(selectedCase.id) ? 'warning' : 'default'">
            持有者 {{ store.holderOf(selectedCase.id)?.operator ?? '空闲' }}
          </n-tag>
        </n-space>
      </div>
      <n-alert v-if="selectedCase.blockedReason" type="error" title="当前阻塞原因" :description="selectedCase.blockedReason" />
      <h3>执行步骤与依赖（重算：{{ store.caseTally(selectedCase.id)?.status }}）</h3>
      <div v-for="(step, index) in selectedCase.steps" :key="step.id" class="step" :class="{ invalid: step.invalid }">
        <div class="step-index">{{ index + 1 }}</div>
        <div class="step-main">
          <div class="step-head">
            <b>{{ step.action }}</b>
            <n-space :size="6">
              <n-tag v-if="step.invalid" type="warning" size="small">失效待重测</n-tag>
              <n-tag :type="store.stepEvidence(selectedCase.id, step.id)?.result === '通过' ? 'success' : store.stepEvidence(selectedCase.id, step.id)?.result === '失败' ? 'error' : 'default'" size="small">
                {{ store.stepEvidence(selectedCase.id, step.id)?.result ?? '未执行' }}
              </n-tag>
            </n-space>
          </div>
          <p>预期：{{ step.expected }}</p>
          <small v-if="step.dependency">依赖步骤：{{ step.dependency }}</small>
          <small v-if="step.invalidReason" class="invalid-note">失效原因：{{ step.invalidReason }}（证据保留，确认修订后重算）</small>
          <template v-for="ev in store.stepAllEvidence(selectedCase.id, step.id)" :key="ev.id">
            <small :class="['ev-line', { unusable: store.stepEvidence(selectedCase.id, step.id)?.id !== ev.id }]">
              {{ ev.source }}证据 {{ ev.id }}（{{ ev.stationVersion }}）：{{ ev.payload }} · 签出 {{ ev.checkoutId }}
            </small>
          </template>
        </div>
        <n-button size="small" @click="router.push('/execution')">去签出执行</n-button>
      </div>
      <n-divider />
      <div class="dependency"><b>依赖图</b><div class="nodes"><span v-for="step in selectedCase.steps" :key="step.id">{{ step.id }}</span></div><div class="lines">→ 顺序执行 · 前一步未通过时不得跳过 · 无有效证据的步骤不计入门禁</div></div>
    </article>
  </div>
</template>
