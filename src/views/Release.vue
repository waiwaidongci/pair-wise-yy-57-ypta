<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useTestStore } from '../store'

const store = useTestStore()
const { votes, gateRecalcs, evidences, cases } = storeToRefs(store)

const voteCaseId = ref('TC-102')
const voteChoice = ref<'同意' | '反对'>('同意')
const lastRequestId = ref('')
const lastMessage = ref('')

const ready = computed(() => {
  const rec = gateRecalcs.value[0]
  if (rec) return rec.passed
  return cases.value.every((item) => item.status === '通过')
})

function validEvidenceOf(caseId: string) {
  return evidences.value.filter((ev) => ev.caseId === caseId && ev.valid && ev.sealed)
}
function invalidEvidenceOf(caseId: string) {
  return evidences.value.filter((ev) => ev.caseId === caseId && !ev.valid)
}

function cast() {
  const res = store.castVote(voteCaseId.value, voteChoice.value, validEvidenceOf(voteCaseId.value)[0]?.id)
  lastRequestId.value = res.requestId
  lastMessage.value = res.ok ? (res.idempotent ? '重放请求号，未重复计票' : '计票已写入') : '写入失败，已进入恢复队列'
}
function replay() {
  if (!lastRequestId.value) return
  const res = store.castVote(voteCaseId.value, voteChoice.value, validEvidenceOf(voteCaseId.value)[0]?.id, lastRequestId.value)
  lastMessage.value = res.idempotent ? `请求号 ${lastRequestId.value} 重放：未重复计票` : '重放结果异常'
}
function recalcAll() { store.confirmRevision() }
function recalcOne(caseId: string) { store.confirmRevision(caseId) }
function hasInvalidSteps(caseId: string) {
  return cases.value.find((item) => item.id === caseId)?.steps.some((step) => step.invalid) ?? false
}

function exportPackage() {
  const report = {
    station:'海州站 CS', version:'v26.10', locked:store.baselineLocked,
    gate: ready.value ? '通过' : '阻断',
    latestRecalc: gateRecalcs.value[0] ?? null,
    cases: cases.value.map((item) => ({
      id:item.id, name:item.name, status:item.status,
      steps:item.steps.length, failureReason:item.failureReason,
      invalidSteps:item.steps.filter((s)=>s.invalid).map((s)=>s.id),
      validEvidence:validEvidenceOf(item.id).map((ev)=>ev.ref),
      invalidEvidence:invalidEvidenceOf(item.id).map((ev)=>ev.ref),
    })),
    votes: votes.value.map((v) => ({ requestId:v.requestId, caseId:v.caseId, vote:v.vote, operator:v.operator, at:v.createdAt })),
    executions: store.executions,
    generatedAt:new Date().toISOString(),
  }
  const blob = new Blob([JSON.stringify(report,null,2)],{type:'application/json'})
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download='联锁测试报告-v26.10.json'; link.click(); URL.revokeObjectURL(link.href)
}
</script>

<template>
  <section class="page-head"><div><p class="eyebrow">发布门禁、计票与基线</p><h1>基线锁定与测试报告</h1><p>确认修订后按有效证据重算发布门禁；计票按请求号幂等，写入失败可恢复，重放不重复计票。</p></div>
    <n-space><n-button @click="exportPackage">导出测试报告</n-button><n-button @click="recalcAll">确认修订并重算门禁</n-button><n-button type="primary" :disabled="!ready || store.baselineLocked" @click="store.lockBaseline">锁定发布基线</n-button></n-space></section>
  <n-alert :type="ready ? 'success' : 'error'" :title="ready ? '发布门禁通过' : '发布门禁未通过'" :description="ready ? '设备快照、有效封存证据与计票均完整。' : '存在失效步骤、无效证据或未闭环项；已封存证据保留但不计入门禁，任何人员不得无痕跳过。'" style="margin-bottom:16px" />

  <div class="grid-2">
    <article class="card">
      <div class="panel-head"><div><h2>发布计票</h2><p>一票一请求号，重放不重复计票</p></div><n-tag>{{ votes.length }} 票</n-tag></div>
      <n-space vertical :size="10">
        <n-space :size="8" align="center">
          <span>用例</span>
          <n-select v-model:value="voteCaseId" :options="cases.map((item) => ({ label:`${item.id} · ${item.name}`, value:item.id }))" style="width:320px" />
        </n-space>
        <n-radio-group v-model:value="voteChoice">
          <n-radio value="同意">同意发布</n-radio><n-radio value="反对">反对</n-radio>
        </n-radio-group>
        <n-space>
          <n-button type="primary" @click="cast">发起计票（生成请求号）</n-button>
          <n-button :disabled="!lastRequestId" @click="replay">重放最近请求号</n-button>
        </n-space>
        <n-alert v-if="lastRequestId" type="info" :title="`请求号 ${lastRequestId}`" :description="lastMessage" />
      </n-space>
      <n-divider />
      <div v-for="v in votes" :key="v.requestId" class="gate">
        <div><b>{{ v.caseId }} · {{ v.vote === '同意' ? '同意发布' : '反对' }}</b><small>{{ v.operator }} · {{ v.createdAt }} · 请求号 {{ v.requestId }}</small></div>
        <n-tag :type="v.vote === '同意' ? 'success' : 'error'">{{ v.vote }}</n-tag>
      </div>
      <n-empty v-if="!votes.length" description="暂无计票" size="small" />
    </article>

    <article class="card">
      <div class="panel-head"><div><h2>门禁清单</h2><p>按有效证据自动重算</p></div><n-tag :type="ready ? 'success' : 'error'">{{ ready ? '可发布' : '阻断' }}</n-tag></div>
      <div v-for="item in cases" :key="item.id" class="gate">
        <div>
          <b>{{ item.id }} · {{ item.name }}</b>
          <small>{{ item.failureReason || '执行记录完整' }}</small>
          <small>有效证据 {{ validEvidenceOf(item.id).length }} 份 · 失效保留 {{ invalidEvidenceOf(item.id).length }} 份</small>
          <small v-if="hasInvalidSteps(item.id)" class="invalid-note">步骤已失效，需重新签出执行</small>
        </div>
        <n-space :size="6" align="center">
          <n-button size="small" @click="recalcOne(item.id)">重算</n-button>
          <n-tag :type="item.status === '通过' ? 'success' : item.status === '失败' ? 'error' : 'warning'">{{ item.status }}</n-tag>
        </n-space>
      </div>
    </article>
  </div>

  <div class="grid-2" style="margin-top:16px">
    <article class="card">
      <div class="panel-head"><div><h2>差异与影响范围</h2><p>v26.09 → v26.10</p></div><n-tag>2 项设备变更</n-tag></div>
      <div class="diff"><b>P-02 转辙机更换</b><p>影响 R-01、R-02、R-03；关联步骤签出作废，已封存证据保留但不计入门禁。</p></div>
      <div class="diff"><b>T-03 绝缘节调整</b><p>影响 R-02、R-04；进路版本变化只失效关联步骤，修订后按有效证据重算。</p></div>
    </article>
    <article class="card">
      <div class="panel-head"><div><h2>基线状态</h2><p>锁定后生成只读版本快照</p></div></div>
      <n-result :status="store.baselineLocked ? 'success' : 'info'" :title="store.baselineLocked ? 'v26.10 已锁定' : '等待有效证据闭环'" :description="store.baselineLocked ? '报告、证据哈希与计票已签章。' : '未提交步骤随交班草稿流转，写入失败按请求号恢复。'" />
    </article>
  </div>
</template>
