export type TestStatus = '未执行' | '执行中' | '通过' | '失败' | '阻塞'

/** 签出状态：有效 / 已交班（进入交班草稿）/ 已提交（证据封存）/ 已失效（版本变化关联步骤）/ 已过期（重开只读） */
export type CheckoutStatus = '有效' | '已交班' | '已提交' | '已失效' | '已过期'

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

/** 交班草稿：换人后原执行员未提交的步骤内容 */
export interface StepDraft {
  result?: '通过' | '失败'
  actual?: string
  note?: string
  savedAt: string
}

/** 步骤签出：同一执行员同一时刻只持有一个有效签出 */
export interface StepCheckout {
  id: string
  caseId: string
  stepId: string
  executor: string
  version: string
  checkedOutAt: string
  status: CheckoutStatus
  draft?: StepDraft
  handedOverBy?: string
  handedOverAt?: string
  handedOverTo?: string
  submittedAt?: string
  source: '正常签出' | '历史补齐'
}

export type EvidenceKind = '截图' | '日志' | '录屏' | '快照'

/** 执行证据：封存后保留；版本变化只置失效、不删除 */
export interface EvidenceRecord {
  id: string
  caseId: string
  stepId: string
  kind: EvidenceKind
  ref: string
  sealed: boolean
  valid: boolean
  invalidReason?: string
  checkoutId?: string
  sealedAt?: string
}

/** 发布计票：请求号幂等，重放不重复计票 */
export interface ReleaseVote {
  requestId: string
  caseId: string
  vote: '同意' | '反对'
  evidenceId?: string
  operator: string
  createdAt: string
}

/** 门禁重算结果 */
export interface GateRecalcStep {
  stepId: string
  ok: boolean
  validEvidence: number
  invalidEvidence: number
}

export interface GateRecalcCase {
  caseId: string
  passed: boolean
  reason?: string
  steps: GateRecalcStep[]
}

export interface GateRecalc {
  id: string
  at: string
  trigger: string
  passed: boolean
  cases: GateRecalcCase[]
}

/** 写入失败后按请求号恢复的待处理请求 */
export interface PendingRequest {
  requestId: string
  label: string
  status: '待重试' | '已恢复'
  payload:
    | { kind: 'commit'; caseId: string; stepId: string; result: '通过' | '失败'; actual: string; refs: string[] }
    | { kind: 'vote'; caseId: string; vote: '同意' | '反对'; evidenceId?: string }
}

export interface TestStep {
  id: string
  action: string
  expected: string
  dependency?: string
  result: '未执行' | '通过' | '失败'
  actual?: string
  evidence?: string
  /** 设备/进路版本变化后关联步骤失效，需重新签出执行；封存证据保留 */
  invalid?: boolean
  invalidReason?: string
}

export interface TestCase {
  id: string
  name: string
  routeIds: string[]
  precondition: string
  version: string
  status: TestStatus
  steps: TestStep[]
  failureReason?: string
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
  /** 签出号；旧记录缺失时按执行历史补齐来源 */
  checkoutId?: string
}
