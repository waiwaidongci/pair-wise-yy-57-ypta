import type {
  CaseTally,
  Checkout,
  Command,
  CommandResponse,
  HandoverDraft,
  LedgerEntry,
  ServerCase,
  ServerState,
  StepEvidence,
  StepResult,
  TallyResult,
  WorkingStep,
} from '../types'
import { routes, seedCases, seedEvidence, seedExecutions } from '../mock'

const STORAGE_KEY = 'yy57-interlocking-server-v2'
const STORAGE_CHANNEL = 'yy57-interlocking-server-v2-sync'
export const LEGACY_PREFIX = 'CO-LEGACY-'
export const SYSTEM_OPERATOR = '系统'

export class DomainError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'DomainError'
  }
}

function now() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}
function stamp() {
  return new Date().toISOString()
}
function fnv(text: string) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
function fingerprint(state: ServerState, text: string) {
  const body = `${state.stationVersion}|${state.revision}|${state.evidence.length}|${state.ledger.length}|${text}`
  return fnv(body)
}

/** 用例版本指纹：结构 + 关联设备/进路/全站版本；执行结果不影响指纹 */
export function caseToken(c: ServerCase, state: ServerState) {
  const parts = [
    state.stationVersion,
    c.version,
    c.routeIds.map((r) => `${r}:${state.routeVersions[r] ?? ''}`).join(','),
    routes
      .filter((r) => c.routeIds.includes(r.id))
      .flatMap((r) => r.devices.map((d) => `${d}:${state.deviceVersions[d] ?? ''}`))
      .join(','),
    c.steps.map((s) => `${s.id}:${s.action}:${s.expected}`).join(';'),
  ]
  return `TOK-${fnv(parts.join('|'))}`
}

export function isLegacy(coId: string) {
  return coId.startsWith(LEGACY_PREFIX)
}

/**
 * 证据是否仍可用于门禁：封存后不删除，按用例版本指纹采信。
 * 设备/进路变化只改变关联用例的指纹，无关用例的封存证据继续有效。
 */
export function evidenceUsable(ev: StepEvidence, state: ServerState) {
  const c = state.cases.find((item) => item.id === ev.caseId)
  if (!c || !ev.caseVersionToken) return false
  return ev.caseVersionToken === caseToken(c, state)
}

function findCase(state: ServerState, id: string) {
  const c = state.cases.find((item) => item.id === id)
  if (!c) throw new DomainError('CASE_NOT_FOUND', `用例 ${id} 不存在`)
  return c
}
function findCheckout(state: ServerState, id: string) {
  const co = state.checkouts.find((item) => item.id === id)
  if (!co) throw new DomainError('CHECKOUT_NOT_FOUND', `签出号 ${id} 不存在`)
  return co
}
function activeCheckoutOf(state: ServerState, operator: string) {
  return state.checkouts.find((item) => item.operator === operator && item.state === '执行中')
}
function activeCheckoutOnCase(state: ServerState, caseId: string) {
  return state.checkouts.find((item) => item.caseId === caseId && item.state === '执行中')
}
function dirtySteps(co: Checkout) {
  return co.working.filter((w) => w.dirty)
}

function bootstrap(): ServerState {
  const deviceVersions = Object.fromEntries(routes.flatMap((r) => r.devices).map((id) => [id, 'v26.09']))
  const routeVersions = Object.fromEntries(routes.map((r) => [r.id, 'v26.09']))
  const cases = structuredClone(seedCases)
  const state: ServerState = {
    stationVersion: 'v26.09',
    confirmedStationVersion: 'v26.09',
    revision: '稳定',
    deviceVersions,
    routeVersions,
    cases,
    checkouts: [
      // 接班前的在办签出：含未提交步骤，交班后应进入交班草稿
      {
        id: 'CO-7001',
        caseId: 'TC-102',
        operator: '方瑜',
        baseToken: '',
        state: '执行中',
        acquiredAt: '14:52:00',
        evidenceIds: ['EV-SEED-04'],
        working: [
          { stepId: 'TS-4', result: '失败', actual: '模拟 3G 占用后 S2 未立即关闭（待复核）', evidencePayload: '联锁日志 LG-143（待提交）', dirty: true },
        ],
      },
    ],
    evidence: structuredClone(seedEvidence),
    drafts: [],
    executions: structuredClone(seedExecutions),
    ledger: [],
    lastTally: null,
    seq: { co: 7001, ev: 100, hd: 40 },
    bootstrapped: true,
  }
  state.checkouts[0]!.baseToken = caseToken(state.cases[1]!, state)

  // 旧执行记录缺少签出号：按执行历史补齐来源
  const legacyByCase: Record<string, string> = {
    'EX-260929-04': 'CO-LEGACY-04',
    'EX-260929-03': 'CO-LEGACY-03',
    'EX-260929-02': 'CO-LEGACY-02',
  }
  state.executions.forEach((ex) => {
    if (!ex.sourceCheckoutId) {
      ex.sourceCheckoutId = legacyByCase[ex.id] ?? `${LEGACY_PREFIX}${ex.id}`
      ex.sourceType = '历史补齐'
      ex.evidenceIds = state.evidence.filter((ev) => ev.checkoutId === ex.sourceCheckoutId).map((ev) => ev.id)
    }
  })
  // 历史证据按执行当时的用例版本补齐用例指纹（v26.09 基线）
  state.evidence.forEach((ev) => {
    if (!ev.caseVersionToken) {
      const c = state.cases.find((item) => item.id === ev.caseId)
      if (c) ev.caseVersionToken = caseToken(c, state)
    }
  })
  // 旧签出以只读历史身份补登（不再可写）
  const legacyOps: Record<string, string> = { 'CO-LEGACY-02': '方瑜', 'CO-LEGACY-03': '陆晨', 'CO-LEGACY-04': '陆晨' }
  Object.entries(legacyOps).forEach(([id, operator]) => {
    const ev = state.evidence.find((item) => item.checkoutId === id)
    state.checkouts.push({
      id, caseId: ev?.caseId ?? '', operator, baseToken: '', state: '已提交',
      acquiredAt: '历史班次', submittedAt: '历史班次', evidenceIds: state.evidence.filter((item) => item.checkoutId === id).map((item) => item.id), working: [],
    })
  })

  state.ledger.push({
    requestId: 'BOOT-001', command: 'bootstrap', at: stamp(), ok: true, replay: false,
    message: '已按执行历史为 3 条旧记录补齐签出来源，封存证据 4 份', evidenceIds: state.evidence.map((ev) => ev.id),
    fingerprint: '',
  })
  state.lastTally = computeTally(state, true)
  state.ledger[0]!.fingerprint = fingerprint(state, 'bootstrap')
  persist(state)
  return state
}

let state: ServerState | null = null
const listeners = new Set<() => void>()
let channel: BroadcastChannel | null = null
function load(): ServerState {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ServerState
      if (parsed.bootstrapped) return parsed
    } catch {
      // 损坏存档：重新引导
    }
  }
  return bootstrap()
}
function persist(next: ServerState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
}
function emit(origin: 'local' | 'peer') {
  listeners.forEach((fn) => fn())
  if (origin === 'local' && channel) channel.postMessage({ at: Date.now() })
}
function ensureChannel() {
  if (channel || typeof BroadcastChannel === 'undefined') return
  channel = new BroadcastChannel(STORAGE_CHANNEL)
  channel.onmessage = () => {
    state = load()
    emit('peer')
  }
}

export function getState(): ServerState {
  if (!state) state = load()
  ensureChannel()
  return state
}
export function subscribe(fn: () => void) {
  ensureChannel()
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export function resetServer() {
  localStorage.removeItem(STORAGE_KEY)
  state = bootstrap()
  emit('local')
}

function logEntry(state: ServerState, entry: Omit<LedgerEntry, 'at' | 'fingerprint'> & { at?: string }) {
  const full: LedgerEntry = { ...entry, at: entry.at ?? stamp(), fingerprint: '' }
  full.fingerprint = fingerprint(state, `${full.requestId}:${full.command}:${full.ok}`)
  state.ledger.unshift(full)
  if (state.ledger.length > 80) state.ledger.length = 80
  return full
}

function nextId(state: ServerState, kind: 'co' | 'ev' | 'hd') {
  const prefix = kind === 'co' ? 'CO-' : kind === 'ev' ? 'EV-' : 'HD-'
  state.seq[kind] += 1
  return `${prefix}${state.seq[kind]}`
}

function assertRevisionUsable(state: ServerState, c: ServerCase) {
  if (state.revision !== '稳定') {
    throw new DomainError('REVISION_PENDING', `设备/进路版本已变化（${c.id} 关联步骤待重测），请先在发布页确认修订`)
  }
}

function recalc(state: ServerState, confirmed: boolean, at = stamp()): TallyResult {
  const tally = computeTally(state, confirmed, at)
  state.lastTally = tally
  return tally
}

/** 按有效证据重算发布门禁；封存证据保留，但不采信版本不符的部分 */
export function computeTally(state: ServerState, confirmed = state.revision === '稳定', at = stamp()): TallyResult {
  const caseTallies: CaseTally[] = state.cases.map((c) => {
    const reasons: string[] = []
    let passedWithEvidence = 0
    let validEvidenceCount = 0
    let invalidCount = 0
    const missing: string[] = []
    c.steps.forEach((step) => {
      if (step.invalid) {
        invalidCount += 1
        reasons.push(`${step.id} 因${step.invalidReason ?? '版本变化'}失效，需重测`)
        return
      }
      const usable = state.evidence.filter((ev) => ev.caseId === c.id && ev.stepId === step.id && evidenceUsable(ev, state))
      // 证据数组只增：同版本令牌下最后一份即最新；失效证据不参与
      const latest = usable[usable.length - 1]
      if (!latest) {
        if (step.result !== '未执行') reasons.push(`${step.id} 历史结果无可用证据，需重测`)
        else reasons.push(`${step.id} 尚未执行`)
        missing.push(step.id)
        return
      }
      validEvidenceCount += 1
      if (latest.result === '通过') passedWithEvidence += 1
      else reasons.push(`${step.id} 有效证据判定失败`)
    })
    let status: CaseTally['status']
    if (c.blockedReason) status = '阻塞'
    else if (invalidCount > 0) status = '待重测'
    else if (missing.length > 0) status = stepResultsAllUnchecked(c) ? '未执行' : '执行中'
    else if (passedWithEvidence === c.steps.length) status = '通过'
    else status = '失败'
    if (c.blockedReason) reasons.unshift(c.blockedReason)
    return {
      caseId: c.id, status, stepCount: c.steps.length, invalidCount,
      passedWithEvidence, missingCount: missing.length, validEvidenceCount, reasons,
    }
  })
  const totalSteps = caseTallies.reduce((sum, t) => sum + t.stepCount, 0)
  const invalidSteps = caseTallies.reduce((sum, t) => sum + t.invalidCount, 0)
  const passedWithEvidence = caseTallies.reduce((sum, t) => sum + t.passedWithEvidence, 0)
  const validEvidenceCount = caseTallies.reduce((sum, t) => sum + t.validEvidenceCount, 0)
  const reasons = caseTallies.flatMap((t) => t.reasons.map((r) => `${t.caseId}：${r}`))
  return {
    computedAt: at, stationVersion: state.stationVersion, confirmed,
    totalSteps, invalidSteps, passedWithEvidence, validEvidenceCount,
    gatePassed: confirmed && caseTallies.every((t) => t.status === '通过'),
    reasons, cases: caseTallies,
  }
}
function stepResultsAllUnchecked(c: ServerCase) {
  return c.steps.every((s) => s.result === '未执行')
}

// ---------- 命令处理 ----------
function acquire(state: ServerState, cmd: Extract<Command, { type: 'acquire' }>): CommandResponse {
  if (activeCheckoutOf(state, cmd.operator)) throw new DomainError('ONE_HELD', `同一执行员只能持有一个有效签出（${cmd.operator} 已持有在办签出）`)
  const c = findCase(state, cmd.caseId)
  if (c.blockedReason) throw new DomainError('CASE_BLOCKED', c.blockedReason)
  const held = activeCheckoutOnCase(state, c.id)
  if (held) throw new DomainError('CASE_HELD', `${c.id} 当前由 ${held.operator} 持有（${held.id}），请先交班或释放`)
  assertRevisionUsable(state, c)
  const co: Checkout = {
    id: nextId(state, 'co'), caseId: c.id, operator: cmd.operator,
    baseToken: caseToken(c, state), state: '执行中', acquiredAt: now(),
    evidenceIds: [], working: c.steps.map((s) => ({ stepId: s.id, result: s.result, actual: s.actual ?? '', evidencePayload: '', dirty: false })),
  }
  state.checkouts.push(co)
  return { message: `${cmd.operator} 已签出 ${c.id}（签出号 ${co.id}，版本指纹 ${co.baseToken}）`, checkout: co }
}

function saveWorking(state: ServerState, cmd: Extract<Command, { type: 'save-working' }>): CommandResponse {
  const co = findCheckout(state, cmd.checkoutId)
  if (co.state !== '执行中') throw new DomainError('NOT_ACTIVE', `签出 ${co.id} 已${co.state}，步骤为只读`)
  if (co.operator !== cmd.operator) throw new DomainError('NOT_HOLDER', `当前持有者为 ${co.operator}，${cmd.operator} 不能写入`)
  if (co.baseToken !== caseToken(findCase(state, co.caseId), state)) throw new DomainError('TOKEN_STALE', '版本指纹已过期，重开仅可查看')
  const w = co.working.find((item) => item.stepId === cmd.stepId)
  if (!w) throw new DomainError('STEP_NOT_FOUND', `步骤 ${cmd.stepId} 不在签出范围内`)
  const c = findCase(state, co.caseId)
  const step = c.steps.find((item) => item.id === cmd.stepId)!
  if (step.dependency) {
    const dep = co.working.find((item) => item.stepId === step.dependency)
    if (dep?.result !== '通过') throw new DomainError('DEPENDENCY_BLOCKED', `前置步骤 ${step.dependency} 未通过，禁止跳过`)
  }
  w.result = cmd.result
  w.actual = cmd.actual
  w.evidencePayload = cmd.evidencePayload
  w.dirty = true
  return { message: `${cmd.stepId} 暂存于签出 ${co.id}（未提交，断网不丢失）`, checkout: co }
}

function commitStep(state: ServerState, cmd: Extract<Command, { type: 'commit-step' }>): CommandResponse {
  const co = findCheckout(state, cmd.checkoutId)
  if (co.state !== '执行中') throw new DomainError('NOT_ACTIVE', `签出 ${co.id} 已${co.state}，不能提交（只读查看）`)
  if (co.operator !== cmd.operator) throw new DomainError('NOT_HOLDER', `当前持有者为 ${co.operator}`)
  const c = findCase(state, co.caseId)
  const token = caseToken(c, state)
  if (co.baseToken !== token) {
    co.state = '已失效'
    co.staleReason = `版本指纹过期：${co.baseToken} → ${token}`
    throw new DomainError('TOKEN_STALE', `版本过期，签出 ${co.id} 已转只读；请在确认修订后重新签出`)
  }
  const w = co.working.find((item) => item.stepId === cmd.stepId)
  if (!w) throw new DomainError('STEP_NOT_FOUND', `步骤 ${cmd.stepId} 不在签出范围内`)
  if (!w.dirty) throw new DomainError('NOT_DIRTY', `${cmd.stepId} 没有待提交内容`)
  if (!w.evidencePayload.trim()) throw new DomainError('EVIDENCE_REQUIRED', `${cmd.stepId} 缺少执行证据，不能提交`)
  const step = c.steps.find((item) => item.id === cmd.stepId)!
  const ev: StepEvidence = {
    id: nextId(state, 'ev'), caseId: c.id, stepId: step.id, checkoutId: co.id,
    requestId: cmd.requestId ?? '', operator: cmd.operator, result: w.result,
    payload: w.evidencePayload.trim(), actual: w.actual,
    stationVersion: state.stationVersion, caseVersionToken: token, source: '执行', sealedAt: stamp(),
  }
  state.evidence.push(ev)
  co.evidenceIds.push(ev.id)
  step.result = w.result
  step.actual = w.actual
  step.invalid = false
  step.invalidReason = undefined
  w.dirty = false
  return { message: `证据 ${ev.id} 已封存（${step.id}=${w.result}），晚到结果无法覆盖`, evidence: ev, checkout: co }
}

function release(state: ServerState, cmd: Extract<Command, { type: 'release' }>): CommandResponse {
  const co = findCheckout(state, cmd.checkoutId)
  if (co.state !== '执行中') throw new DomainError('NOT_ACTIVE', `签出 ${co.id} 已${co.state}`)
  if (co.operator !== cmd.operator) throw new DomainError('NOT_HOLDER', `当前持有者为 ${co.operator}`)
  if (dirtySteps(co).length > 0) throw new DomainError('DIRTY_EXISTS', '仍有未提交步骤，请先提交或交班，不能直接释放')
  co.state = '已释放'
  return { message: `签出 ${co.id} 已释放，${co.caseId} 可被重新签出`, checkout: co }
}

/** 换人：原执行员未提交步骤整体进入交班草稿，原签出立即让出 */
function shiftHandover(state: ServerState, cmd: Extract<Command, { type: 'shift-handover' }>): CommandResponse {
  const held = state.checkouts.filter((co) => co.operator === cmd.fromOperator && co.state === '执行中')
  if (held.length === 0) throw new DomainError('NOTHING_TO_SHIFT', `${cmd.fromOperator} 没有在办签出`)
  const co = held[0]!
  const token = caseToken(findCase(state, co.caseId), state)
  const pending = dirtySteps(co)
  let draft: HandoverDraft | undefined
  if (pending.length > 0) {
    draft = {
      id: nextId(state, 'hd'), caseId: co.caseId, stepIds: pending.map((w) => w.stepId),
      fromOperator: cmd.fromOperator, toOperator: cmd.toOperator, checkoutId: co.id,
      token, steps: structuredClone(pending), createdAt: now(), state: '待接续',
    }
    state.drafts.unshift(draft)
  }
  co.state = '已交班'
  co.baseToken = token
  return { message: draft ? `${co.caseId} 已交班：${pending.length} 个未提交步骤进入草稿 ${draft.id}` : `${co.caseId} 已交班（无未提交步骤）`, checkout: co, draft }
}

function adoptDraft(state: ServerState, cmd: Extract<Command, { type: 'adopt-draft' }>): CommandResponse {
  const draft = state.drafts.find((d) => d.id === cmd.draftId)
  if (!draft) throw new DomainError('DRAFT_NOT_FOUND', `交班草稿 ${cmd.draftId} 不存在`)
  if (draft.state !== '待接续') throw new DomainError('DRAFT_CLOSED', `草稿 ${draft.id} 已${draft.state}`)
  if (activeCheckoutOf(state, cmd.operator)) throw new DomainError('ONE_HELD', `${cmd.operator} 已持有在办签出，不能再接续草稿`)
  const c = findCase(state, draft.caseId)
  if (activeCheckoutOnCase(state, c.id)) throw new DomainError('CASE_HELD', `${c.id} 仍被他人持有`)
  if (draft.invalidReason) throw new DomainError('DRAFT_STALE', `草稿 ${draft.id} 关联版本已变化：${draft.invalidReason}，仅可查看`)
  assertRevisionUsable(state, c)
  const token = caseToken(c, state)
  if (draft.token !== token) {
    draft.state = '已失效'
    draft.invalidReason = `版本指纹过期：${draft.token} → ${token}`
    throw new DomainError('TOKEN_STALE', `草稿 ${draft.id} 版本过期，仅可查看`)
  }
  const co: Checkout = {
    id: nextId(state, 'co'), caseId: c.id, operator: cmd.operator, baseToken: token,
    state: '执行中', acquiredAt: now(), evidenceIds: [],
    working: c.steps.map((s) => {
      const carried = draft.steps.find((w) => w.stepId === s.id)
      return carried ? structuredClone(carried) : { stepId: s.id, result: s.result, actual: s.actual ?? '', evidencePayload: '', dirty: false }
    }),
    supersededFromDraft: draft.id,
  }
  state.checkouts.push(co)
  draft.state = '已采用'
  return { message: `${cmd.operator} 已接续草稿 ${draft.id}，新签出号 ${co.id}（原步骤标记待提交）`, checkout: co, draft }
}

function discardDraft(state: ServerState, cmd: Extract<Command, { type: 'discard-draft' }>): CommandResponse {
  const draft = state.drafts.find((d) => d.id === cmd.draftId)
  if (!draft) throw new DomainError('DRAFT_NOT_FOUND', `交班草稿 ${cmd.draftId} 不存在`)
  draft.state = '已放弃'
  return { message: `草稿 ${draft.id} 已放弃（留档可查）`, draft }
}

/** 设备/进路版本变化：只让关联步骤失效，封存证据保留 */
function changeVersion(state: ServerState, cmd: Extract<Command, { type: 'change-version' }>): CommandResponse {
  const affectedRouteIds =
    cmd.scope === 'station'
      ? routes.map((r) => r.id)
      : cmd.scope === 'route'
        ? [cmd.targetId]
        : routes.filter((r) => r.devices.includes(cmd.targetId)).map((r) => r.id)
  if (affectedRouteIds.length === 0) throw new DomainError('NO_IMPACT', `${cmd.targetId} 未关联任何进路`)

  const affectedCases = state.cases.filter((c) => c.routeIds.some((rid) => affectedRouteIds.includes(rid)))
  const affectedStepKeys = new Set(affectedCases.flatMap((c) => c.steps.map((s) => `${c.id}/${s.id}`)))
  affectedCases.forEach((c) => {
    c.version = cmd.nextVersion
    c.steps.forEach((s) => {
      s.invalid = true
      s.invalidReason = `${cmd.scope === 'device' ? '设备' : '进路'} ${cmd.targetId} 升至 ${cmd.nextVersion}（${cmd.reason}）`
    })
  })
  if (cmd.scope === 'station') {
    state.stationVersion = cmd.nextVersion
    Object.keys(state.deviceVersions).forEach((id) => { state.deviceVersions[id] = cmd.nextVersion })
    Object.keys(state.routeVersions).forEach((id) => { state.routeVersions[id] = cmd.nextVersion })
  } else if (cmd.scope === 'route') {
    state.routeVersions[cmd.targetId] = cmd.nextVersion
    const r = routes.find((item) => item.id === cmd.targetId)
    r?.devices.forEach((d) => { state.deviceVersions[d] = cmd.nextVersion })
  } else {
    state.deviceVersions[cmd.targetId] = cmd.nextVersion
  }
  state.revision = '变化待确认'
  // 在办签出与待接续草稿：仅关联的失效，未关联的保持有效
  state.checkouts.forEach((co) => {
    if (co.state !== '执行中') return
    const hit = co.working.some((w) => affectedStepKeys.has(`${co.caseId}/${w.stepId}`))
    if (!hit) return
    co.state = '已失效'
    co.staleReason = `${cmd.scope === 'device' ? '设备' : '进路'} ${cmd.targetId} 版本变化，重开仅可查看`
    const pending = dirtySteps(co)
    if (pending.length > 0) {
      state.drafts.unshift({
        id: nextId(state, 'hd'), caseId: co.caseId, stepIds: pending.map((w) => w.stepId),
        fromOperator: co.operator, toOperator: co.operator, checkoutId: co.id,
        token: co.baseToken, steps: structuredClone(pending), createdAt: now(),
        state: '已失效', invalidReason: co.staleReason,
      })
    }
  })
  state.drafts.forEach((d) => {
    if (d.state !== '待接续') return
    const hit = d.stepIds.some((sid) => affectedStepKeys.has(`${d.caseId}/${sid}`))
    if (hit) {
      d.state = '已失效'
      d.invalidReason = `${cmd.scope === 'device' ? '设备' : '进路'} ${cmd.targetId} 升至 ${cmd.nextVersion}`
    }
  })

  return {
    message: `版本变化仅使 ${affectedCases.length} 个用例的 ${affectedStepKeys.size} 个关联步骤失效；已封存证据全部保留待确认`,
  }
}

/** 确认修订：按有效证据重算门禁（指纹不符的证据保留但不采信） */
function confirmRevision(state: ServerState): CommandResponse {
  if (state.revision === '稳定') throw new DomainError('NO_REVISION', '当前没有待确认的修订')
  state.revision = '稳定'
  // 各用例当前令牌即重测基线；旧证据保留，指纹不符不采信（重算在 apply 末尾统一执行）
  return { message: `修订已确认（${state.stationVersion}），已按有效证据重算发布门禁` }
}

function recalcCommand(state: ServerState): CommandResponse {
  void state
  return { message: '已按有效证据重算发布门禁' }
}

/** 按原始请求号重放：从账本取出原命令重投，命中幂等不重复计票 */
export function replayRequest(requestId: string): CommandResponse {
  const s = getState()
  const original = s.ledger.find((entry) => entry.requestId === requestId)?.original
  if (!original) throw new DomainError('REQUEST_NOT_FOUND', `账本中找不到请求号 ${requestId}`)
  return apply(original, { replay: true })
}

// ---------- 对外入口（幂等：按请求号查重，重放不重复计票） ----------
export function apply(command: Command, opts: { replay?: boolean } = {}): CommandResponse {
  const s = getState()
  const requestId = command.requestId ?? `AUTO-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const existing = s.ledger.find((entry) => entry.requestId === requestId)
  if (existing) {
    // 重放：返回原结果，不再封存证据、不重复计票
    const replayEntry = logEntry(s, {
      requestId: `${requestId}#replay@${Date.now()}`, command: command.type, original: existing.original, ok: existing.ok,
      replay: true, message: existing.ok ? `重放请求 ${requestId}：返回原结果，未重复计票` : `重放失败请求 ${requestId}：原写入未生效`,
      evidenceIds: existing.evidenceIds, checkoutId: existing.checkoutId, draftId: existing.draftId,
    })
    persist(s)
    emit('local')
    const co = existing.checkoutId ? s.checkouts.find((item) => item.id === existing.checkoutId) : undefined
    const draft = existing.draftId ? s.drafts.find((item) => item.id === existing.draftId) : undefined
    const ev = existing.evidenceIds?.[0] ? s.evidence.find((item) => item.id === existing.evidenceIds![0]) : undefined
    return {
      message: replayEntry.message,
      checkout: co, draft, evidence: ev,
      tally: s.lastTally ?? undefined,
    }
  }

  let response: CommandResponse
  let evidenceIds: string[] | undefined
  try {
    switch (command.type) {
      case 'acquire': response = acquire(s, command); break
      case 'save-working': response = saveWorking(s, command); break
      case 'commit-step': response = commitStep(s, command); break
      case 'release': response = release(s, command); break
      case 'shift-handover': response = shiftHandover(s, command); break
      case 'adopt-draft': response = adoptDraft(s, command); break
      case 'discard-draft': response = discardDraft(s, command); break
      case 'change-version': response = changeVersion(s, command); break
      case 'confirm-revision': response = confirmRevision(s); break
      case 'recalc': response = recalcCommand(s); break
    }
  } catch (error) {
    if (error instanceof DomainError) {
      logEntry(s, { requestId, command: command.type, original: command, ok: false, replay: !!opts.replay, message: error.message })
      persist(s)
      emit('local')
      throw error
    }
    throw error
  }

  if (response.evidence) evidenceIds = [response.evidence.id]
  // 先完成封存/失效等全部状态变更，再统一按有效证据重算（避免计票早于证据落账）
  if (['commit-step', 'change-version', 'confirm-revision', 'recalc'].includes(command.type)) {
    response.tally = recalc(s, s.revision === '稳定')
  }
  logEntry(s, {
    requestId, command: command.type, original: command, ok: true, replay: !!opts.replay,
    message: response.message, evidenceIds, checkoutId: response.checkout?.id, draftId: response.draft?.id,
  })
  persist(s)
  emit('local')
  return response
}
