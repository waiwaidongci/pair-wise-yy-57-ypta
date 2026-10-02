export type StepResult = '未执行' | '通过' | '失败'
export type TestStatus = '未执行' | '执行中' | '通过' | '失败' | '阻塞' | '待重测'

// 签出生命周期：执行中（有效持有）→ 已交班 / 已提交 / 已释放；版本过期 → 已失效（只读）
export type CheckoutState = '执行中' | '已交班' | '已提交' | '已失效' | '已释放'
export type DraftState = '待接续' | '已采用' | '已放弃' | '已失效'
export type RevisionStatus = '稳定' | '变化待确认'

export interface StationDevice {
  id: string
  name: string
  kind: '道岔' | '信号机' | '轨道区段'
  x: number
  y: number
  routeIds: string[]
}

export interface RouteRelation {
  id: string
  name: string
  color: string
  points: [number, number][]
  devices: string[]
  affectedBy: string[]
}

/** 服务端步骤：结果与失效标记分离，失效只影响采信，不抹除历史 */
export interface ServerStep {
  id: string
  action: string
  expected: string
  dependency?: string
  result: StepResult
  actual?: string
  invalid: boolean
  invalidReason?: string
}

export interface ServerCase {
  id: string
  name: string
  routeIds: string[]
  precondition: string
  version: string
  blockedReason?: string
  steps: ServerStep[]
}

/** 执行证据：只增不删、只增不改；token 不匹配即封存留档，不再参与门禁计票 */
export interface StepEvidence {
  id: string
  caseId: string
  stepId: string
  checkoutId: string
  requestId: string
  operator: string
  result: StepResult
  payload: string
  actual: string
  stationVersion: string
  caseVersionToken: string
  source: '执行' | '历史补齐'
  sealedAt: string
}

export interface WorkingStep {
  stepId: string
  result: StepResult
  actual: string
  evidencePayload: string
  dirty: boolean
}

export interface Checkout {
  id: string
  caseId: string
  operator: string
  /** 签出时用例版本指纹，提交时不一致即判为版本过期 */
  baseToken: string
  state: CheckoutState
  acquiredAt: string
  submittedAt?: string
  evidenceIds: string[]
  working: WorkingStep[]
  staleReason?: string
  supersededFromDraft?: string
}

export interface HandoverDraft {
  id: string
  caseId: string
  stepIds: string[]
  fromOperator: string
  toOperator: string
  checkoutId: string
  token: string
  steps: WorkingStep[]
  createdAt: string
  state: DraftState
  invalidReason?: string
}

export interface ExecutionRecord {
  id: string
  caseId: string
  operator: string
  startedAt: string
  finishedAt?: string
  snapshot: string
  result: TestStatus
  evidence: string[]
  evidenceIds?: string[]
  /** 旧记录缺少签出号时按执行历史补齐 */
  sourceCheckoutId?: string
  sourceType?: '执行' | '历史补齐'
}

export interface LedgerEntry {
  requestId: string
  command: string
  /** 原始命令（重放时据此重建；请求号不变，命中幂等） */
  original?: Command
  at: string
  ok: boolean
  replay: boolean
  message: string
  evidenceIds?: string[]
  fingerprint?: string
  checkoutId?: string
  draftId?: string
}

export interface CaseTally {
  caseId: string
  status: TestStatus
  stepCount: number
  invalidCount: number
  passedWithEvidence: number
  missingCount: number
  validEvidenceCount: number
  reasons: string[]
}

export interface TallyResult {
  computedAt: string
  stationVersion: string
  confirmed: boolean
  totalSteps: number
  invalidSteps: number
  passedWithEvidence: number
  validEvidenceCount: number
  gatePassed: boolean
  reasons: string[]
  cases: CaseTally[]
}

type CommandBase<T extends string> = { type: T; requestId?: string }

export type Command =
  | (CommandBase<'acquire'> & { caseId: string; operator: string })
  | (CommandBase<'save-working'> & { checkoutId: string; operator: string; stepId: string; result: StepResult; actual: string; evidencePayload: string })
  | (CommandBase<'commit-step'> & { checkoutId: string; operator: string; stepId: string })
  | (CommandBase<'release'> & { checkoutId: string; operator: string })
  | (CommandBase<'shift-handover'> & { fromOperator: string; toOperator: string })
  | (CommandBase<'adopt-draft'> & { draftId: string; operator: string })
  | (CommandBase<'discard-draft'> & { draftId: string })
  | (CommandBase<'change-version'> & { scope: 'station' | 'device' | 'route'; targetId: string; nextVersion: string; reason: string })
  | (CommandBase<'confirm-revision'>)
  | (CommandBase<'recalc'>)

export interface CommandResponse {
  message: string
  checkout?: Checkout
  draft?: HandoverDraft
  evidence?: StepEvidence
  tally?: TallyResult
}

export interface ServerState {
  stationVersion: string
  confirmedStationVersion: string
  revision: RevisionStatus
  deviceVersions: Record<string, string>
  routeVersions: Record<string, string>
  cases: ServerCase[]
  checkouts: Checkout[]
  evidence: StepEvidence[]
  drafts: HandoverDraft[]
  executions: ExecutionRecord[]
  ledger: LedgerEntry[]
  lastTally: TallyResult | null
  seq: { co: number; ev: number; hd: number }
  bootstrapped: boolean
}

export interface OutboxItem {
  requestId: string
  command: Command
  attempts: number
  lastError: string
  at: string
}
