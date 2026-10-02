<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useTestStore } from '../store'
import type { StepCheckout } from '../types'

const store = useTestStore()
const { currentExecutor, myActiveCheckout, handoverDrafts, pendingRecovery, gateRecalcs, checkouts, evidences } = storeToRefs(store)

const commitForms = reactive<Record<string, { result: '通过' | '失败'; actual: string; refs: string }>>({})
const draftForms = reactive<Record<string, { result: '通过' | '失败'; actual: string; note: string }>>({})

function formFor(stepId: string) {
  return commitForms[stepId] ?? (commitForms[stepId] = { result: '通过', actual: '', refs: '' })
}
function draftFor(stepId: string) {
  return draftForms[stepId] ?? (draftForms[stepId] = { result: '通过', actual: '', note: '' })
}

function holderTag(stepId: string) {
  return store.stepState(store.selectedCaseId, stepId)
}

function doCheckout(stepId: string) { store.checkoutStep(store.selectedCaseId, stepId) }
function doHandover(stepId: string) { store.handoverStep(store.selectedCaseId, stepId) }
function doSaveDraft(stepId: string) {
  const f = draftFor(stepId)
  store.saveStepDraft(store.selectedCaseId, stepId, { result: f.result, actual: f.actual, note: f.note })
}
function doCommit(stepId: string) {
  const f = formFor(stepId)
  const refs = f.refs.split(/[、,，]/).map((item) => item.trim()).filter(Boolean)
  store.commitStep(store.selectedCaseId, stepId, f.result, f.actual, refs)
}
function doTakeOver(co: StepCheckout) { store.takeOverHandover(co.id) }

function stepEvidence(stepId: string) {
  return evidences.value.filter((ev) => ev.caseId === store.selectedCaseId && ev.stepId === stepId)
}
function validEvidenceCount(c: { steps: { validEvidence: number }[] }) {
  return c.steps.reduce((a, s) => a + s.validEvidence, 0)
}
function checkoutOf(coId?: string) { return checkouts.value.find((co) => co.id === coId) }

const metrics = computed(() => [
  { label:'当前持有者', value: currentExecutor.value, note: myActiveCheckout.value ? `持有 ${myActiveCheckout.value.caseId} ${myActiveCheckout.value.stepId}` : '无有效签出' },
  { label:'有效签出', value: checkouts.value.filter((co) => co.status === '有效').length, note: '同一执行员只持一个' },
  { label:'交班草稿', value: handoverDrafts.value.length, note: '换人后未提交步骤' },
  { label:'待恢复请求', value: pendingRecovery.value.length, note: '按请求号重放' },
])

const failureReason = ref('模拟 3G 占用后，S2 信号未立即关闭，联锁日志出现 126ms 延迟')
const evidence = ref('录屏 VID-021、联锁日志 LG-144、CS-LEU-09 设备快照')
function failStep() {
  const item = store.selectedCase
  const step = item?.steps.find((entry) => entry.result === '未执行')
  if (item && step && failureReason.value.trim()) store.setStepResult(item.id, step.id, '失败', failureReason.value)
}
function passStep() {
  const item = store.selectedCase
  const step = item?.steps.find((entry) => entry.result === '未执行')
  if (item && step) store.setStepResult(item.id, step.id, '通过', '预期结果一致，证据已归档')
}
</script>

<template>
  <section class="page-head">
    <div><p class="eyebrow">签出、证据与可恢复闭环</p><h1>回归执行记录</h1>
      <p>步骤签出与持有者绑定，换人后未提交内容进入交班草稿；设备/进路版本变化只失效关联步骤，封存证据保留；写入失败按请求号恢复，重放不重复计票。</p></div>
    <n-space>
      <n-select v-model:value="currentExecutor" :options="store.roster.map((name) => ({ label:`执行员 ${name}`, value:name }))" style="width:150px" @update:value="store.switchExecutor" />
      <n-button @click="store.simulateDisconnect">模拟断线</n-button>
      <n-button :type="store.simulateWriteFailure ? 'warning' : 'default'" @click="store.simulateWriteFailure = !store.simulateWriteFailure">
        {{ store.simulateWriteFailure ? '写入失败模拟：开' : '写入失败模拟：关' }}
      </n-button>
      <n-button @click="store.invalidateByChange({ devices:['P-02'] }, 'P-02 转辙机更换')">设备版本变化</n-button>
      <n-button @click="store.invalidateByChange({ routes:['R-04'] }, 'R-04 进路版本变化')">进路版本变化</n-button>
    </n-space>
  </section>

  <div class="metrics">
    <article v-for="item in metrics" :key="item.label" class="card metric"><span>{{ item.label }}</span><strong>{{ item.value }}</strong><small>{{ item.note }}</small></article>
  </div>

  <n-alert v-if="store.simulateWriteFailure" type="warning" title="已开启写入失败模拟" description="下次提交或计票将写入失败并进入恢复队列，按请求号重放，不重复计票。" style="margin-bottom:16px" />

  <div class="execution-grid">
    <article class="card">
      <div class="panel-head"><div><h2>{{ store.selectedCase?.id }} 执行面板</h2><p>{{ store.selectedCase?.name }}</p></div>
        <n-tag :type="store.connection === '在线' ? 'success' : 'warning'">{{ store.connection }} · {{ store.liveMessage }}</n-tag></div>
      <n-progress type="line" :percentage="store.progress" :height="12" />

      <div v-for="step in store.selectedCase?.steps" :key="step.id" class="execute-step" :class="{ failed: step.result === '失败', invalid: step.invalid }">
        <div class="step-main">
          <div class="step-head">
            <b>{{ step.id }} · {{ step.action }}</b>
            <n-space :size="6">
              <n-tag v-if="holderTag(step.id).holder" type="info" size="small">持有者 {{ holderTag(step.id).holder }}</n-tag>
              <n-tag v-if="holderTag(step.id).expired" type="default" size="small">已过期 · 只读</n-tag>
              <n-tag v-if="holderTag(step.id).handed && !holderTag(step.id).holder" type="warning" size="small">已交班</n-tag>
              <n-tag :type="step.result === '通过' ? 'success' : step.result === '失败' ? 'error' : 'info'" size="small">{{ step.result }}</n-tag>
            </n-space>
          </div>
          <small>预期：{{ step.expected }}</small>
          <small v-if="step.actual">实测：{{ step.actual }}</small>
          <small v-if="step.invalid" class="invalid-reason">已失效：{{ step.invalidReason }}</small>
          <small v-if="holderTag(step.id).readOnly && !step.invalid" class="readonly-reason">{{ holderTag(step.id).reason }}</small>

          <div v-if="holderTag(step.id).checkout?.draft" class="draft-box">
            <b>签出草稿 {{ holderTag(step.id).checkout?.id }}</b>
            <small>结果：{{ holderTag(step.id).checkout?.draft?.result ?? '未填' }} · 实测：{{ holderTag(step.id).checkout?.draft?.actual ?? '未填' }}</small>
            <small v-if="holderTag(step.id).checkout?.draft?.note">备注：{{ holderTag(step.id).checkout?.draft?.note }}</small>
            <small>保存于 {{ holderTag(step.id).checkout?.draft?.savedAt }}</small>
          </div>

          <div v-for="ev in stepEvidence(step.id)" :key="ev.id" class="evidence-line">
            <n-tag :type="ev.valid ? 'success' : 'default'" size="small" :bordered="false">{{ ev.kind }}</n-tag>
            <span :class="{ 'ev-invalid': !ev.valid }">{{ ev.ref }}</span>
            <n-tag v-if="ev.sealed" size="small" :bordered="false">已封存</n-tag>
            <n-tag v-if="!ev.valid" type="warning" size="small" :bordered="false">已失效·保留</n-tag>
            <small v-if="ev.checkoutId">来源签出 {{ ev.checkoutId }}</small>
          </div>

          <div class="step-actions">
            <n-button v-if="!holderTag(step.id).checkout || step.invalid" size="small" type="primary" ghost @click="doCheckout(step.id)">
              {{ holderTag(step.id).checkout ? '重新签出' : '签出' }}
            </n-button>
            <template v-if="holderTag(step.id).checkout && !holderTag(step.id).readOnly">
              <n-button size="small" @click="doSaveDraft(step.id)">保存草稿</n-button>
              <n-button size="small" @click="doHandover(step.id)">交班</n-button>
            </template>
          </div>

          <div v-if="holderTag(step.id).checkout && !holderTag(step.id).readOnly" class="commit-form">
            <n-space vertical :size="8">
              <n-space :size="8" align="center">
                <span>提交结果</span>
                <n-radio-group v-model:value="formFor(step.id).result" size="small">
                  <n-radio value="通过">通过</n-radio><n-radio value="失败">失败</n-radio>
                </n-radio-group>
              </n-space>
              <n-input v-model:value="formFor(step.id).actual" placeholder="实测结果" size="small" />
              <n-input v-model:value="formFor(step.id).refs" placeholder="证据附件（、分隔），如：录屏 VID-021、日志 LG-144" size="small" />
              <n-button size="small" type="primary" @click="doCommit(step.id)">提交并封存证据</n-button>
            </n-space>
          </div>
        </div>
      </div>

      <n-divider />
      <div class="panel-head"><div><h2>快速记录（兼容批量）</h2><p>未通过用例不能无痕跳过</p></div></div>
      <n-form label-placement="top">
        <n-form-item label="失败原因与设备快照"><n-input v-model:value="failureReason" type="textarea" :rows="2" /></n-form-item>
        <n-form-item label="证据附件"><n-input v-model:value="evidence" /></n-form-item>
      </n-form>
      <n-space><n-button type="success" @click="passStep">记录通过</n-button><n-button type="error" @click="failStep">记录失败</n-button></n-space>
    </article>

    <aside class="card">
      <div class="panel-head"><div><h2>交班草稿</h2><p>换人后原执行员未提交步骤</p></div><n-tag>{{ handoverDrafts.length }}</n-tag></div>
      <n-empty v-if="!handoverDrafts.length" description="暂无交班草稿" size="small" />
      <div v-for="co in handoverDrafts" :key="co.id" class="handover-card">
        <div class="step-head"><b>{{ co.caseId }} {{ co.stepId }}</b><n-tag type="warning" size="small">待接手</n-tag></div>
        <small>交班人 {{ co.handedOverBy }} · {{ co.handedOverAt }}</small>
        <small v-if="co.draft">草稿：{{ co.draft.result ?? '未填结果' }} · {{ co.draft.actual ?? '未填实测' }}</small>
        <small v-if="co.draft?.note">备注：{{ co.draft.note }}</small>
        <small v-if="co.handedOverTo">已由 {{ co.handedOverTo }} 接手</small>
        <n-button size="small" type="primary" block style="margin-top:6px" @click="doTakeOver(co)">接手草稿（生成我的签出）</n-button>
      </div>

      <n-divider />
      <div class="panel-head"><div><h2>待恢复请求</h2><p>写入失败后按请求号重放</p></div><n-tag type="warning">{{ pendingRecovery.length }}</n-tag></div>
      <n-empty v-if="!pendingRecovery.length" description="无待恢复请求" size="small" />
      <div v-for="req in pendingRecovery" :key="req.requestId" class="handover-card">
        <small><b>{{ req.label }}</b></small>
        <small>请求号 {{ req.requestId }}</small>
        <n-button size="small" type="warning" block style="margin-top:6px" @click="store.recoverRequest(req.requestId)">按请求号恢复（不重复计票）</n-button>
      </div>

      <n-divider />
      <div class="panel-head"><div><h2>门禁重算结果</h2><p>确认修订后按有效证据重算</p></div><n-tag>{{ gateRecalcs.length }}</n-tag></div>
      <n-empty v-if="!gateRecalcs.length" description="尚未重算" size="small" />
      <div v-for="rec in gateRecalcs" :key="rec.id" class="handover-card">
        <div class="step-head"><b>{{ rec.trigger }}</b><n-tag :type="rec.passed ? 'success' : 'error'" size="small">{{ rec.passed ? '通过' : '阻断' }}</n-tag></div>
        <small>{{ rec.id }} · {{ rec.at }}</small>
        <small v-for="c in rec.cases" :key="c.caseId">{{ c.caseId }}：{{ c.passed ? '通过' : c.reason }}（有效证据 {{ validEvidenceCount(c) }} 份）</small>
      </div>

      <n-divider />
      <div class="panel-head"><div><h2>执行历史</h2><p>失败与重测记录不可覆盖 · 缺签出号已补齐</p></div></div>
      <n-timeline>
        <n-timeline-item v-for="record in store.executions" :key="record.id" :type="record.result === '通过' ? 'success' : record.result === '失败' ? 'error' : 'info'" :title="`${record.caseId} · ${record.result}`" :content="`${record.operator} ${record.startedAt}${record.finishedAt ? ' → ' + record.finishedAt : ''}\n${record.snapshot}\n证据：${record.evidence.join('、') || '采集中'}\n签出号：${record.checkoutId ?? '未补齐'}`" />
      </n-timeline>
    </aside>
  </div>
</template>

<style scoped>
.execute-step.invalid { opacity: .72; }
.step-main { flex: 1; min-width: 0; }
.invalid-reason { color: #b45309; }
.readonly-reason { color: #64748b; }
.draft-box { margin: 8px 0; padding: 8px 10px; border-left: 3px solid #d97706; background: #fffbeb; border-radius: 4px; display: flex; flex-direction: column; gap: 2px; }
.evidence-line { display: flex; align-items: center; gap: 8px; margin: 4px 0; flex-wrap: wrap; }
.ev-invalid { color: #94a3b8; text-decoration: line-through; }
.step-actions { margin: 8px 0; }
.commit-form { margin: 8px 0; padding: 10px; border: 1px dashed #cbd5e1; border-radius: 6px; background: #f8fafc; }
.handover-card { padding: 10px; border: 1px solid #e7ebf1; border-radius: 6px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 3px; }
</style>
