import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { EvidenceKind, EvidenceRecord, ExecutionRecord, GateRecalc, PendingRequest, ReleaseVote, StepCheckout, StepDraft, TestStep } from './types'
import { routes, seedCases, seedCheckouts, seedEvidences, seedExecutions } from './mock'

const STORAGE_KEY = 'yy57-interlocking-draft-v2'
const STATION_VERSION = 'v26.10'

function nowTime() { return new Date().toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', hour12:false }) }
function nowStamp() {
  const d = new Date()
  return `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`
}
function compareVersion(a: string, b: string) { return a.localeCompare(b) }

let seq = 0
function genId(prefix: string) { seq += 1; return `${prefix}-${Date.now().toString(36).toUpperCase()}-${String(seq).padStart(3,'0')}` }

/** 证据引用文本 → 证据类型 */
function inferKind(ref: string): EvidenceKind {
  if (ref.includes('VID') || ref.includes('录屏')) return '录屏'
  if (ref.includes('LG') || ref.includes('日志')) return '日志'
  if (ref.includes('XS') || ref.includes('截图')) return '截图'
  return '快照'
}

export const useTestStore = defineStore('interlocking', () => {
  const cases = ref(seedCases.map((item) => ({ ...item, steps: item.steps.map((step) => ({ ...step })) })))
  const executions = ref<ExecutionRecord[]>(structuredClone(seedExecutions))
  const checkouts = ref<StepCheckout[]>(seedCheckouts.map((item) => ({ ...item })))
  const evidences = ref<EvidenceRecord[]>(seedEvidences.map((item) => ({ ...item })))
  const votes = ref<ReleaseVote[]>([])
  const gateRecalcs = ref<GateRecalc[]>([])
  const pendingRequests = ref<PendingRequest[]>([])
  const processedRequestIds = ref<string[]>([])

  const selectedCaseId = ref('TC-102')
  const selectedRouteIds = ref<string[]>(['R-02'])
  const baselineLocked = ref(false)
  const connection = ref<'在线' | '重连中'>('在线')
  const pendingRetry = ref(0)
  const liveMessage = ref('执行进度已同步')

  /** 当前执行员（交班后持有者随之切换） */
  const currentExecutor = ref('方瑜')
  const roster = ['方瑜', '陆晨', '当前用户']
  /** 模拟写入失败：下次提交/计票写入失败，进入按请求号恢复队列 */
  const simulateWriteFailure = ref(false)

  const selectedCase = computed(() => cases.value.find((item) => item.id === selectedCaseId.value))
  const progress = computed(() => {
    const steps = cases.value.flatMap((item) => item.steps)
    return Math.round(steps.filter((step) => step.result !== '未执行').length / steps.length * 100)
  })
  const changedDevices = ['P-02 转辙机更换', 'T-03 绝缘节调整']
  const affectedCases = computed(() => cases.value.filter((item) => item.routeIds.some((routeId) => ['R-02','R-04'].includes(routeId))))

  /** 当前执行员持有的有效签出（同一时刻只能有一个） */
  const myActiveCheckout = computed(() => checkouts.value.find((item) => item.executor === currentExecutor.value && item.status === '有效'))
  /** 交班草稿：原执行员未提交、等待接班人处理的步骤 */
  const handoverDrafts = computed(() => checkouts.value.filter((item) => item.status === '已交班'))
  /** 待恢复请求：写入失败后按请求号排队 */
  const pendingRecovery = computed(() => pendingRequests.value.filter((item) => item.status === '待重试'))

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      cases: cases.value, executions: executions.value, checkouts: checkouts.value, evidences: evidences.value,
      votes: votes.value, gateRecalcs: gateRecalcs.value, pendingRequests: pendingRequests.value,
      processedRequestIds: processedRequestIds.value, currentExecutor: currentExecutor.value,
    }))
  }
  function restore() {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const draft = JSON.parse(raw)
    cases.value = draft.cases
    executions.value = draft.executions
    checkouts.value = draft.checkouts ?? []
    evidences.value = draft.evidences ?? []
    votes.value = draft.votes ?? []
    gateRecalcs.value = draft.gateRecalcs ?? []
    pendingRequests.value = draft.pendingRequests ?? []
    processedRequestIds.value = draft.processedRequestIds ?? []
    if (draft.currentExecutor) currentExecutor.value = draft.currentExecutor
  }

  function selectCase(id: string) { selectedCaseId.value = id; selectedRouteIds.value = cases.value.find((item) => item.id === id)?.routeIds ?? [] }

  function activeCheckout(caseId: string, stepId: string) {
    return checkouts.value.find((item) => item.caseId === caseId && item.stepId === stepId && item.status === '有效')
  }

  /** 步骤签出状态：持有者 / 是否只读 / 失效原因 */
  function stepState(caseId: string, stepId: string) {
    const step = cases.value.find((item) => item.id === caseId)?.steps.find((item) => item.id === stepId)
    const co = activeCheckout(caseId, stepId)
    const expired = checkouts.value.find((item) => item.caseId === caseId && item.stepId === stepId && item.status === '已过期')
    const handed = checkouts.value.find((item) => item.caseId === caseId && item.stepId === stepId && item.status === '已交班')
    let readOnly = false
    let reason = ''
    if (step?.invalid) { readOnly = true; reason = step.invalidReason ?? '步骤已失效，需重新签出执行' }
    else if (expired) { readOnly = true; reason = '签出已过期，重开只能查看' }
    else if (co && co.executor !== currentExecutor.value) { readOnly = true; reason = `当前持有者为 ${co.executor}` }
    else if (handed && !co) { readOnly = true; reason = '已交班，等待接班人接手' }
    else if (!co) { readOnly = true; reason = '未签出' }
    return { holder: co?.executor, checkout: co, expired, handed, readOnly, reason, invalid: step?.invalid }
  }

  /** 签出步骤：换人时原持有者未提交内容进入交班草稿 */
  function checkoutStep(caseId: string, stepId: string) {
    const item = cases.value.find((entry) => entry.id === caseId)
    const step = item?.steps.find((entry) => entry.id === stepId)
    if (!item || !step) return
    if (step.invalid) {
      // 修订后重新签出：作废旧签出已在版本变化时处理，这里直接开新签出
      step.invalid = false
      step.invalidReason = undefined
    }
    const existing = activeCheckout(caseId, stepId)
    if (existing) {
      if (existing.executor === currentExecutor.value) { liveMessage.value = `已持有 ${caseId} ${stepId} 的有效签出 ${existing.id}`; return }
      // 换人：原执行员未提交步骤进入交班草稿
      existing.status = '已交班'
      existing.handedOverBy = existing.executor
      existing.handedOverAt = nowTime()
      if (!existing.draft) {
        existing.draft = {
          result: step.result !== '未执行' ? step.result : undefined,
          actual: step.actual,
          note: '交班时未提交内容',
          savedAt: nowStamp(),
        }
      }
      existing.handedOverTo = currentExecutor.value
      liveMessage.value = `${existing.handedOverBy} 已交班，未提交步骤进入交班草稿 ${existing.id}`
    }
    // 同一执行员同一时刻只持有一个有效签出
    const held = myActiveCheckout.value
    if (held && !(held.caseId === caseId && held.stepId === stepId)) {
      liveMessage.value = `签出被拒绝：${currentExecutor.value} 仍持有 ${held.caseId} ${held.stepId}（${held.id}），同一执行员同一时刻只允许一个有效签出`
      persist()
      return
    }
    const status = compareVersion(item.version, STATION_VERSION) < 0 ? '已过期' : '有效'
    const co: StepCheckout = {
      id: genId('CO'), caseId, stepId, executor: currentExecutor.value,
      version: item.version, checkedOutAt: nowTime(), status, source: '正常签出',
    }
    checkouts.value.push(co)
    if (status === '已过期') liveMessage.value = `${caseId} ${stepId} 版本已过期（${item.version}），重开只能查看，不能提交`
    else if (!existing) liveMessage.value = `已签出 ${caseId} ${stepId}，签出号 ${co.id}`
    persist()
  }

  /** 保存草稿（未提交内容随签出保存）；clientCheckoutId 用于并发冲突检测 */
  function saveStepDraft(caseId: string, stepId: string, patch: Partial<StepDraft>, clientCheckoutId?: string) {
    const co = activeCheckout(caseId, stepId)
    if (!co) { liveMessage.value = '没有该步骤的有效签出，请先签出'; return false }
    if (co.executor !== currentExecutor.value) { liveMessage.value = `签出持有者为 ${co.executor}，不能保存草稿`; return false }
    if (clientCheckoutId && clientCheckoutId !== co.id) { liveMessage.value = '签出已在其他页面变更（版本冲突），请刷新后重开'; return false }
    co.draft = {
      result: patch.result ?? co.draft?.result,
      actual: patch.actual ?? co.draft?.actual,
      note: patch.note ?? co.draft?.note,
      savedAt: nowStamp(),
    }
    liveMessage.value = `草稿已保存到签出 ${co.id}`
    persist()
    return true
  }

  /** 显式交班：未提交步骤进入交班草稿 */
  function handoverStep(caseId: string, stepId: string) {
    const co = activeCheckout(caseId, stepId)
    if (!co || co.executor !== currentExecutor.value) { liveMessage.value = '无有效签出，不能交班'; return }
    co.status = '已交班'
    co.handedOverBy = currentExecutor.value
    co.handedOverAt = nowTime()
    if (!co.draft) co.draft = { note: '交班时未提交内容', savedAt: nowStamp() }
    persist()
    liveMessage.value = `已交班 ${caseId} ${stepId}，步骤进入交班草稿，等待接班人接手`
  }

  /** 接班人接手交班草稿：生成自己的新签出，原草稿保留可追溯 */
  function takeOverHandover(coId: string) {
    const old = checkouts.value.find((item) => item.id === coId)
    if (!old) return
    const held = myActiveCheckout.value
    if (held) { liveMessage.value = `仍持有 ${held.caseId} ${held.stepId}，请先提交或交班后再接手`; return }
    old.handedOverTo = currentExecutor.value
    const status = compareVersion(old.version, STATION_VERSION) < 0 ? '已过期' : '有效'
    const co: StepCheckout = {
      id: genId('CO'), caseId: old.caseId, stepId: old.stepId, executor: currentExecutor.value,
      version: old.version, checkedOutAt: nowTime(), status, source: '正常签出',
      draft: old.draft ? { ...old.draft } : undefined,
    }
    checkouts.value.push(co)
    persist()
    liveMessage.value = `已接手 ${old.handedOverBy} 的交班草稿，新签出号 ${co.id}${status === '已过期' ? '（版本过期，只能查看）' : ''}`
  }

  /** 提交步骤结果并封存证据；请求号幂等，写入失败进入恢复队列 */
  function commitStep(caseId: string, stepId: string, result: '通过' | '失败', actual: string, refs: string[], requestId?: string) {
    const reqId = requestId ?? genId('REQ')
    if (processedRequestIds.value.includes(reqId)) {
      liveMessage.value = `请求号 ${reqId} 已处理，重放不重复提交/计票`
      return { ok: true, idempotent: true as const, requestId: reqId }
    }
    const payload = { kind: 'commit' as const, caseId, stepId, result, actual, refs }
    if (simulateWriteFailure.value) {
      pendingRequests.value.push({ requestId: reqId, label: `${caseId} ${stepId} 提交签出`, status: '待重试', payload })
      simulateWriteFailure.value = false
      persist()
      liveMessage.value = `写入失败：${reqId} 已进入恢复队列，可按请求号恢复`
      return { ok: false as const, requestId: reqId }
    }
    const item = cases.value.find((entry) => entry.id === caseId)
    const step = item?.steps.find((entry) => entry.id === stepId)
    const co = activeCheckout(caseId, stepId)
    if (!item || !step) return { ok: false as const, requestId: reqId }
    if (!co || co.executor !== currentExecutor.value) { liveMessage.value = '无有效签出或持有者不一致，不能提交'; return { ok: false as const, requestId: reqId } }
    if (co.status !== '有效') { liveMessage.value = '签出已交班/过期，只能查看'; return { ok: false as const, requestId: reqId } }
    if (step.invalid) { liveMessage.value = '步骤已失效，请重新签出后执行'; return { ok: false as const, requestId: reqId } }
    if (step.dependency && item.steps.find((entry) => entry.id === step.dependency)?.result !== '通过') {
      liveMessage.value = `前置步骤 ${step.dependency} 未通过，禁止跳过`
      return { ok: false as const, requestId: reqId }
    }
    step.result = result
    step.actual = actual
    step.invalid = false
    step.invalidReason = undefined
    refs.forEach((ref) => {
      evidences.value.push({
        id: genId('EV'), caseId, stepId, kind: inferKind(ref), ref: ref.trim(),
        sealed: true, valid: true, checkoutId: co.id, sealedAt: nowStamp(),
      })
    })
    co.status = '已提交'
    co.submittedAt = nowStamp()
    item.status = item.steps.some((entry) => entry.result === '失败') ? '失败'
      : item.steps.every((entry) => entry.result === '通过') ? '通过' : '执行中'
    processedRequestIds.value.push(reqId)
    persist()
    liveMessage.value = `签出 ${co.id} 已提交，${refs.length} 份证据封存（${reqId}）`
    return { ok: true as const, requestId: reqId }
  }

  /** 设备/进路版本变化：只让关联步骤失效，已封存证据保留（置失效、不删除） */
  function invalidateByChange(scope: { devices?: string[]; routes?: string[] }, reason: string) {
    const affectedCaseIds = new Set<string>()
    cases.value.forEach((item) => {
      const hitRoute = item.routeIds.some((routeId) => scope.routes?.includes(routeId))
      const hitDevice = routes
        .filter((route) => item.routeIds.includes(route.id))
        .flatMap((route) => route.devices)
        .some((deviceId) => scope.devices?.includes(deviceId))
      if (hitRoute || hitDevice) affectedCaseIds.add(item.id)
    })
    let invalidated = 0
    affectedCaseIds.forEach((cid) => {
      const item = cases.value.find((entry) => entry.id === cid)!
      item.steps.forEach((step) => {
        const co = checkouts.value.find((entry) => entry.caseId === cid && entry.stepId === step.id && entry.status === '有效')
        if (co) { co.status = '已失效'; invalidated += 1 }
        if (step.result !== '未执行') { step.invalid = true; step.invalidReason = reason }
        evidences.value.forEach((ev) => {
          if (ev.caseId === cid && ev.stepId === step.id && ev.sealed) { ev.valid = false; ev.invalidReason = reason }
        })
      })
    })
    const retained = evidences.value.filter((ev) => !ev.valid).length
    liveMessage.value = `${reason}：${affectedCaseIds.size} 条用例关联步骤失效，${invalidated} 份签出作废；封存证据保留 ${retained} 份（可查，不计入门禁）`
    persist()
  }

  /** 确认修订后按有效证据重算发布门禁 */
  function confirmRevision(caseId?: string) {
    const targets = caseId ? cases.value.filter((item) => item.id === caseId) : cases.value
    const detail = targets.map((item) => {
      const steps = item.steps.map((step) => {
        const validEvidence = evidences.value.filter((ev) => ev.caseId === item.id && ev.stepId === step.id && ev.valid && ev.sealed).length
        const invalidEvidence = evidences.value.filter((ev) => ev.caseId === item.id && ev.stepId === step.id && !ev.valid).length
        const ok = step.result === '通过' && !step.invalid && validEvidence > 0
        return { stepId: step.id, ok, validEvidence, invalidEvidence }
      })
      const passed = item.status === '通过' && !item.steps.some((step) => step.invalid) && steps.every((entry) => entry.ok)
      const reason = passed ? undefined
        : item.steps.some((step) => step.invalid) ? '关联步骤已失效，需重新签出执行'
        : item.status !== '通过' ? '存在未闭环步骤'
        : '缺少有效封存证据'
      return { caseId: item.id, passed, reason, steps }
    })
    const rec: GateRecalc = {
      id: genId('GR'), at: nowStamp(),
      trigger: caseId ? `确认修订 ${caseId}` : '确认修订（全部用例）',
      passed: detail.every((entry) => entry.passed),
      cases: detail,
    }
    gateRecalcs.value.unshift(rec)
    liveMessage.value = rec.passed ? '重算完成：发布门禁通过' : `重算完成：${detail.filter((entry) => !entry.passed).length} 条用例不满足门禁，需按有效证据重新闭环`
    persist()
    return rec
  }

  /** 发布计票：请求号幂等，重放不重复计票 */
  function castVote(caseId: string, vote: '同意' | '反对', evidenceId?: string, requestId?: string) {
    const reqId = requestId ?? genId('REQ')
    if (votes.value.some((item) => item.requestId === reqId)) {
      liveMessage.value = `请求号 ${reqId} 已处理，重放不重复计票`
      return { ok: true, idempotent: true as const, requestId: reqId }
    }
    if (simulateWriteFailure.value) {
      pendingRequests.value.push({ requestId: reqId, label: `${caseId} 发布计票`, status: '待重试', payload: { kind: 'vote', caseId, vote, evidenceId } })
      simulateWriteFailure.value = false
      persist()
      liveMessage.value = `写入失败：${reqId} 已进入恢复队列，可按请求号恢复（不重复计票）`
      return { ok: false as const, requestId: reqId }
    }
    votes.value.push({ requestId: reqId, caseId, vote, evidenceId, operator: currentExecutor.value, createdAt: nowStamp() })
    persist()
    liveMessage.value = `计票已写入（${reqId}），重放该请求号不重复计票`
    return { ok: true as const, requestId: reqId }
  }

  /** 写入失败后按请求号恢复：同一请求号重放，不重复计票/提交 */
  function recoverRequest(reqId: string) {
    const req = pendingRequests.value.find((item) => item.requestId === reqId)
    if (!req) return
    if (req.payload.kind === 'vote') {
      const { caseId, vote, evidenceId } = req.payload
      castVote(caseId, vote, evidenceId, reqId)
    } else {
      const { caseId, stepId, result, actual, refs } = req.payload
      commitStep(caseId, stepId, result, actual, refs, reqId)
    }
    req.status = '已恢复'
    pendingRequests.value = pendingRequests.value.filter((item) => item.requestId !== reqId)
    persist()
    liveMessage.value = `请求 ${reqId} 已按原请求号恢复，未重复计票/提交`
  }

  /** 旧执行记录缺少签出号：按执行历史补齐来源 */
  function backfillCheckoutSources() {
    let created = 0
    executions.value.forEach((rec) => {
      if (rec.checkoutId) return
      const linked = checkouts.value.find((co) => co.caseId === rec.caseId && (co.executor === rec.operator || co.source === '历史补齐'))
      if (linked) { rec.checkoutId = linked.id; return }
      const stepId = cases.value.find((item) => item.id === rec.caseId)?.steps[0]?.id ?? ''
      const co: StepCheckout = {
        id: genId('CO'), caseId: rec.caseId, stepId, executor: rec.operator,
        version: rec.snapshot.split(' / ')[0] || STATION_VERSION,
        checkedOutAt: rec.startedAt, status: rec.result === '执行中' ? '有效' : '已提交',
        source: '历史补齐',
      }
      checkouts.value.push(co)
      rec.checkoutId = co.id
      created += 1
    })
    evidences.value.forEach((ev) => {
      if (!ev.checkoutId) {
        const co = checkouts.value.find((item) => item.caseId === ev.caseId)
        if (co) ev.checkoutId = co.id
      }
    })
    persist()
    liveMessage.value = created ? `已按执行历史补齐 ${created} 份签出来源` : '执行记录签出号完整，无需补齐'
  }

  function switchExecutor(name: string) {
    currentExecutor.value = name
    const held = myActiveCheckout.value
    liveMessage.value = held ? `已换人：${name} 接管，当前持有 ${held.caseId} ${held.stepId}（${held.id}）` : `已换人：${name}，当前无有效签出`
    persist()
  }

  function setStepResult(caseId: string, stepId: string, result: TestStep['result'], actual?: string) {
    if (baselineLocked.value) return
    const item = cases.value.find((entry) => entry.id === caseId)
    const step = item?.steps.find((entry) => entry.id === stepId)
    if (!item || !step) return
    if (step.dependency && item.steps.find((entry) => entry.id === step.dependency)?.result !== '通过') {
      liveMessage.value = `前置步骤 ${step.dependency} 未通过，禁止跳过`
      return
    }
    step.result = result
    step.actual = actual ?? step.actual
    item.status = item.steps.some((entry) => entry.result === '失败') ? '失败' : item.steps.every((entry) => entry.result === '通过') ? '通过' : '执行中'
    persist()
  }
  function startExecution() {
    const item = selectedCase.value
    if (!item) return
    item.status = '执行中'
    executions.value.unshift({ id:`EX-${Date.now().toString().slice(-6)}`, caseId:item.id, operator:currentExecutor.value, startedAt:nowTime(), snapshot:`${STATION_VERSION} / CS-LEU-09`, result:'执行中', evidence:[] })
    persist()
  }
  function updateLiveProgress(value: number) { liveMessage.value = value >= 100 ? '全部用例执行完成，等待审核锁定' : `实时同步：已完成 ${value}%`; if (value >= 100) { const active = executions.value.find((item) => item.result === '执行中'); if (active) { active.result = '失败'; active.finishedAt = nowTime() } } }
  function simulateDisconnect() { connection.value = '重连中'; pendingRetry.value += 1 }
  function retry() { connection.value = '在线'; pendingRetry.value = 0; liveMessage.value = '断线期间执行记录已补传' }
  function lockBaseline() { baselineLocked.value = true }

  watch(cases, persist, { deep:true })
  restore()
  backfillCheckoutSources()

  return {
    cases, executions, checkouts, evidences, votes, gateRecalcs, pendingRequests, processedRequestIds,
    selectedCaseId, selectedRouteIds, selectedCase, progress, baselineLocked, connection, pendingRetry, liveMessage,
    changedDevices, affectedCases, currentExecutor, roster, simulateWriteFailure,
    myActiveCheckout, handoverDrafts, pendingRecovery,
    selectCase, stepState, checkoutStep, saveStepDraft, handoverStep, takeOverHandover, commitStep,
    invalidateByChange, confirmRevision, castVote, recoverRequest, backfillCheckoutSources, switchExecutor,
    setStepResult, startExecution, updateLiveProgress, simulateDisconnect, retry, lockBaseline,
  }
})
