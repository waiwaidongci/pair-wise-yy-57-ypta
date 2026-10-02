import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import type {
  Checkout, Command, HandoverDraft, OutboxItem, ServerCase, StepEvidence, StepResult, TallyResult,
} from './types'
import { DomainError, evidenceUsable, getState, replayRequest, resetServer, subscribe, caseToken } from './domain/server'
import { TransportError, getOutbox, newRequestId, recover, send, setChaos } from './domain/transport'
import { devices as allDevices, changedDevicesSeed, routes } from './mock'

import { notify } from './notify'

const OPERATOR_KEY = 'yy57-current-operator'

export const useTestStore = defineStore('interlocking', () => {
  // 领域状态（localStorage + 跨标签页广播同步），整体替换触发响应
  const snapshot = shallowRef(getState())
  subscribe(() => {
    snapshot.value = getState()
  })
  function sync() {
    snapshot.value = getState()
  }

  const operator = ref(localStorage.getItem(OPERATOR_KEY) ?? '方瑜')
  function setOperator(name: string) {
    operator.value = name
    localStorage.setItem(OPERATOR_KEY, name)
  }

  const selectedCaseId = ref('TC-102')
  const selectedRouteIds = ref<string[]>(['R-02'])
  function selectCase(id: string) {
    selectedCaseId.value = id
    selectedRouteIds.value = cases.value.find((item) => item.id === id)?.routeIds ?? []
  }

  // ---------- 对领域状态的只读视图 ----------
  const cases = computed<ServerCase[]>(() => snapshot.value.cases)
  const checkouts = computed<Checkout[]>(() => snapshot.value.checkouts)
  const evidenceAll = computed<StepEvidence[]>(() => snapshot.value.evidence)
  const drafts = computed<HandoverDraft[]>(() => snapshot.value.drafts)
  const executions = computed(() => snapshot.value.executions)
  const ledger = computed(() => snapshot.value.ledger)
  const stationVersion = computed(() => snapshot.value.stationVersion)
  const confirmedStationVersion = computed(() => snapshot.value.confirmedStationVersion)
  const revision = computed(() => snapshot.value.revision)
  const deviceVersions = computed(() => snapshot.value.deviceVersions)
  const routeVersions = computed(() => snapshot.value.routeVersions)
  const tally = computed<TallyResult | null>(() => snapshot.value.lastTally)

  const selectedCase = computed(() => cases.value.find((item) => item.id === selectedCaseId.value))
  const myCheckout = computed(() => checkouts.value.find((co) => co.operator === operator.value && co.state === '执行中'))
  const selectedCaseCheckout = computed(() =>
    checkouts.value.find((co) => co.caseId === selectedCaseId.value && (co.state === '执行中' || co.state === '已交班' || co.state === '已失效')))
  const pendingDrafts = computed(() => drafts.value.filter((d) => d.state === '待接续'))
  const outbox = ref<OutboxItem[]>(getOutbox())
  // 简易轮询兜底，保证跨页面写入/恢复后发件箱标记及时刷新
  const outboxTimer = setInterval(() => { outbox.value = getOutbox() }, 1200)
  onScopeDispose(() => clearInterval(outboxTimer))

  const changedDevices = changedDevicesSeed

  const progress = computed(() => {
    const t = tally.value
    if (!t) return 0
    return Math.round((t.passedWithEvidence / Math.max(1, t.totalSteps)) * 100)
  })
  const gatePassed = computed(() => tally.value?.gatePassed ?? false)
  const baselineLocked = ref(false)
  watch(gatePassed, (ok) => {
    if (!ok) baselineLocked.value = false
  })
  function lockBaseline() {
    if (!gatePassed.value) {
      notify.error('发布门禁未通过，不能锁定基线')
      return
    }
    baselineLocked.value = true
    notify.success(`发布基线已锁定：${stationVersion.value}`)
  }

  // ---------- 连接 / 实时同步（保留原有模拟） ----------
  const connection = ref<'在线' | '重连中'>('在线')
  const pendingRetry = computed(() => outbox.value.length)
  const liveMessage = ref('执行进度已同步')
  function updateLiveProgress(value: number) {
    liveMessage.value = value >= 100 ? '全部用例执行完成，等待按有效证据重算门禁' : `实时同步：已完成 ${value}%`
  }
  function simulateDisconnect() {
    connection.value = '重连中'
    liveMessage.value = '链路中断：写请求将进入发件箱，恢复后按请求号重放'
  }
  function retry() {
    const result = recover()
    connection.value = '在线'
    sync()
    outbox.value = getOutbox()
    if (result.replayed > 0) {
      notify.success(`按请求号恢复完成：重放 ${result.replayed} 笔（命中幂等，未重复计票），新送达 ${result.recovered - result.replayed} 笔`)
      liveMessage.value = `应答丢失的请求已重放，证据只计一次`
    } else if (result.recovered > 0) {
      notify.success(`断线期间 ${result.recovered} 笔请求已补传`)
      liveMessage.value = '断线期间执行记录已补传'
    } else if (result.failed.length > 0) {
      notify.error(`仍有 ${result.failed.length} 笔请求未恢复：${result.failed[0]!.reason}`)
    } else {
      notify.info('发件箱为空，无需恢复')
    }
  }
  function recoverOne(requestId: string) {
    const result = recover(requestId)
    sync()
    outbox.value = getOutbox()
    if (result.replayed > 0) notify.success(`请求 ${requestId} 重放命中：原结果已生效，未重复封存证据/计票`)
    else if (result.recovered > 0) notify.success(`请求 ${requestId} 已补送成功`)
    else if (result.failed[0]) notify.error(`请求 ${requestId} 恢复失败：${result.failed[0].reason}`)
  }

  // ---------- 统一命令发送：失败不吞，业务错误与传输错误分流 ----------
  function run(command: Command, successHint?: string): boolean {
    const requestId = newRequestId(command.type.toUpperCase())
    try {
      const { response, replayed } = send(command, requestId)
      sync()
      outbox.value = getOutbox()
      if (replayed) notify.info(`请求 ${requestId} 重放命中，已返回原结果，不重复计票`)
      else notify.success(successHint ?? response.message)
      return true
    } catch (error) {
      sync()
      outbox.value = getOutbox()
      if (error instanceof DomainError) {
        notify.error(error.message)
      } else if (error instanceof TransportError) {
        notify.warning(`${error.message}（请求号 ${requestId}，可在执行页/发布页恢复）`)
      } else {
        notify.error(error instanceof Error ? error.message : String(error))
      }
      return false
    }
  }

  // 暂存为易失前的本地保护：写失败也存本地（由发件箱承担恢复）
  function acquireCase(caseId: string) {
    return run({ type: 'acquire', caseId, operator: operator.value }, `${operator.value} 已取得 ${caseId} 的唯一有效签出`)
  }
  function saveWorking(checkoutId: string, stepId: string, result: StepResult, actual: string, evidencePayload: string) {
    return run({ type: 'save-working', checkoutId, operator: operator.value, stepId, result, actual, evidencePayload })
  }
  function commitStep(checkoutId: string, stepId: string) {
    return run({ type: 'commit-step', checkoutId, operator: operator.value, stepId }, '步骤已提交，执行证据已封存')
  }
  function releaseCheckout(checkoutId: string) {
    return run({ type: 'release', checkoutId, operator: operator.value })
  }
  function shiftHandover(toOperator: string) {
    return run({ type: 'shift-handover', fromOperator: operator.value, toOperator }, `已交班给 ${toOperator}，未提交步骤进入交班草稿`)
  }
  function adoptDraft(draftId: string) {
    return run({ type: 'adopt-draft', draftId, operator: operator.value }, `已接续交班草稿，签出号已更换`)
  }
  function discardDraft(draftId: string) {
    return run({ type: 'discard-draft', draftId })
  }
  function changeVersion(scope: 'station' | 'device' | 'route', targetId: string, nextVersion: string, reason: string) {
    return run({ type: 'change-version', scope, targetId, nextVersion, reason }, '关联步骤已失效，封存证据保留')
  }
  function confirmRevision() {
    return run({ type: 'confirm-revision' }, '修订已确认，已按有效证据重算发布门禁')
  }
  function recalc() {
    return run({ type: 'recalc' })
  }
  function replayLedgerRequest(requestId: string) {
    try {
      replayRequest(requestId)
      sync()
      notify.info(`请求 ${requestId} 重放完成：返回原结果，证据与计票均未变化`)
    } catch (error) {
      notify.error(error instanceof Error ? error.message : String(error))
    }
  }

  // ---------- 查询辅助 ----------
  function stepEvidence(caseId: string, stepId: string): StepEvidence | undefined {
    const state = snapshot.value
    const list = state.evidence.filter((ev) => ev.caseId === caseId && ev.stepId === stepId && evidenceUsable(ev, state))
    return list[list.length - 1]
  }
  function stepAllEvidence(caseId: string, stepId: string) {
    return snapshot.value.evidence.filter((ev) => ev.caseId === caseId && ev.stepId === stepId)
  }
  function caseTally(caseId: string) {
    return tally.value?.cases.find((item) => item.caseId === caseId)
  }
  function holderOf(caseId: string) {
    return checkouts.value.find((co) => co.caseId === caseId && co.state === '执行中')
  }
  function tokenOf(caseId: string) {
    const state = snapshot.value
    const c = state.cases.find((item) => item.id === caseId)
    return c ? caseToken(c, state) : ''
  }
  function draftsForOperator(name: string) {
    return drafts.value.filter((d) => d.toOperator === name || d.fromOperator === name)
  }
  function draftsForCase(caseId: string) {
    return drafts.value.filter((d) => d.caseId === caseId)
  }

  function exportPackage() {
    const state = snapshot.value
    const report = {
      station: '海州站 CS',
      version: state.stationVersion,
      confirmedVersion: state.confirmedStationVersion,
      revision: state.revision,
      gate: state.lastTally,
      cases: state.cases.map((item) => ({
        id: item.id, name: item.name, version: item.version,
        steps: item.steps.map((s) => ({ id: s.id, result: s.result, invalid: s.invalid, invalidReason: s.invalidReason })),
        blockedReason: item.blockedReason,
      })),
      evidence: state.evidence,
      checkouts: state.checkouts,
      drafts: state.drafts,
      executions: state.executions,
      ledger: state.ledger,
      generatedAt: new Date().toISOString(),
    }
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `联锁测试报告-${state.stationVersion}.json`
    link.click()
    URL.revokeObjectURL(link.href)
  }

  function resetAll() {
    resetServer()
    localStorage.removeItem('yy57-interlocking-outbox-v1')
    outbox.value = []
    baselineLocked.value = false
    sync()
    notify.success('已恢复到初始演示状态（含在办签出与交班场景）')
  }

  return {
    // 常量
    devices: allDevices, routes, changedDevices,
    // 身份 / 选择
    operator, setOperator, selectedCaseId, selectedRouteIds, selectCase,
    // 状态
    cases, checkouts, evidenceAll, drafts, executions, ledger, outbox,
    stationVersion, confirmedStationVersion, revision, deviceVersions, routeVersions, tally,
    selectedCase, myCheckout, selectedCaseCheckout, pendingDrafts,
    progress, gatePassed, baselineLocked, lockBaseline,
    connection, pendingRetry, liveMessage, updateLiveProgress, simulateDisconnect, retry, recoverOne,
    setChaosMode: setChaos,
    // 动作
    acquireCase, saveWorking, commitStep, releaseCheckout, shiftHandover, adoptDraft, discardDraft,
    changeVersion, confirmRevision, recalc, replayLedgerRequest,
    stepEvidence, stepAllEvidence, caseTally, holderOf, tokenOf, draftsForOperator, draftsForCase,
    exportPackage, resetAll,
  }
})
