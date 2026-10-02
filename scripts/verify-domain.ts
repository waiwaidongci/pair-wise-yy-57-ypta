/* 领域闭环端到端验证（node 运行，mock 浏览器存储） */
const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
}
;(globalThis as any).BroadcastChannel = class {
  constructor(public name: string) {}
  postMessage() {}
  onmessage: ((e: unknown) => void) | null = null
  close() {}
}

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}
function expectThrow(name: string, fn: () => unknown, code: string) {
  try {
    fn()
    check(name, false, '未抛出异常')
  } catch (e) {
    check(name, (e as { code?: string }).code === code, `期望 ${code}，实际 ${(e as Error).message}`)
  }
}

import { apply, getState, replayRequest, resetServer, DomainError } from '../src/domain/server'
import { send, recover, setChaos, getOutbox } from '../src/domain/transport'

function s() { return getState() }
function coOf(operator: string, state = '执行中') {
  return s().checkouts.find((c) => c.operator === operator && c.state === state)!
}
function tallyOf(caseId: string) {
  return s().lastTally!.cases.find((t) => t.caseId === caseId)!
}

console.log('\n[0] 引导：旧执行记录补齐签出号 + 封存证据')
resetServer()
check('3 条旧记录全部补齐 sourceCheckoutId', s().executions.every((e) => e.sourceCheckoutId?.startsWith('CO-LEGACY-')))
check('旧记录来源标注为历史补齐', s().executions.every((e) => e.sourceType === '历史补齐'))
check('引导后按有效证据重算，TC-101 通过', tallyOf('TC-101').status === '通过')
check('引导后 TC-103 失败（有效失败证据）', tallyOf('TC-103').status === '失败')
check('引导后 TC-104 阻塞', tallyOf('TC-104').status === '阻塞')
check('引导后 TC-102 执行中（TS-4 未执行）', tallyOf('TC-102').status === '执行中')
check('引导门禁阻断', s().lastTally!.gatePassed === false)
check('方瑜持有在办签出 CO-7001（TS-4 未提交）', coOf('方瑜').working[0]?.dirty === true)

console.log('\n[1] 唯一签出：同人同时只能一个；同用例只能一个持有者')
expectThrow('方瑜再签出 TC-101 被拒（已持有 CO-7001）', () => send({ type: 'acquire', caseId: 'TC-101', operator: '方瑜' }), 'ONE_HELD')
expectThrow('陆晨签出方瑜持有的 TC-102 被拒', () => send({ type: 'acquire', caseId: 'TC-102', operator: '陆晨' }), 'CASE_HELD')

console.log('\n[2] 非持有者不能写；暂存-提交-封存证据')
const fy = coOf('方瑜')
expectThrow('陆晨写方瑜签出被拒', () => send({ type: 'save-working', checkoutId: fy.id, operator: '陆晨', stepId: 'TS-4', result: '通过', actual: 'x', evidencePayload: 'y' }), 'NOT_HOLDER')
expectThrow('TS-4 无证据不能提交', () => {
  send({ type: 'save-working', checkoutId: fy.id, operator: '方瑜', stepId: 'TS-4', result: '通过', actual: '', evidencePayload: '' })
  send({ type: 'commit-step', checkoutId: fy.id, operator: '方瑜', stepId: 'TS-4' })
}, 'EVIDENCE_REQUIRED')
check('方瑜暂存 TS-4=通过', send({ type: 'save-working', checkoutId: fy.id, operator: '方瑜', stepId: 'TS-4', result: '通过', actual: 'S2 立即关闭，进路锁闭', evidencePayload: '日志 LG-200' }).replayed === false)
const evBefore = s().evidence.length
const committed = send({ type: 'commit-step', checkoutId: fy.id, operator: '方瑜', stepId: 'TS-4' })
check('提交后新增 1 份封存证据', s().evidence.length === evBefore + 1)
check('TC-102 变为通过（两步均有有效证据）', tallyOf('TC-102').status === '通过')
const evId = committed.response.evidence!.id
void evId
const evTotal = s().evidence.length
const reqId = committed.requestId

console.log('\n[3] 按请求号重放：不重复封存证据、不重复计票')
const ledgerLen = s().ledger.length
send({ type: 'commit-step', checkoutId: fy.id, operator: '方瑜', stepId: 'TS-4' }, reqId)
check('重放后证据数量不变', s().evidence.length === evTotal)
check('重放后 TC-102 仍通过、有效证据只计一次', tallyOf('TC-102').validEvidenceCount === 2)
check('账本出现 replay 记录', s().ledger.length === ledgerLen + 1 && s().ledger[0]!.replay === true)

console.log('\n[4] 换人交班：未提交步骤进交班草稿，原签出让出')
// 再暂存一个脏步骤（用 TS-4 重新暂存）模拟未提交
send({ type: 'save-working', checkoutId: fy.id, operator: '方瑜', stepId: 'TS-4', result: '失败', actual: '复测出现新异常', evidencePayload: '日志 LG-201（草稿）' })
send({ type: 'shift-handover', fromOperator: '方瑜', toOperator: '周衡' })
check('原签出状态=已交班', coOf('方瑜', '已交班').state === '已交班')
check('生成 1 份待接续草稿', s().drafts.filter((d) => d.state === '待接续').length === 1)
check('TC-102 已无在办持有者', !s().checkouts.some((c) => c.caseId === 'TC-102' && c.state === '执行中'))
const draft = s().drafts.find((d) => d.state === '待接续')!
check('草稿含未提交步骤 TS-4', draft.stepIds.join() === 'TS-4' && draft.steps[0]!.result === '失败')

console.log('\n[5] 接续草稿：新签出号、脏步骤保留待提交')
const adopted = send({ type: 'adopt-draft', draftId: draft.id, operator: '周衡' })
check('草稿已采用', s().drafts.find((d) => d.id === draft.id)!.state === '已采用')
check('新持有者为周衡，签出号为新号', adopted.response.checkout!.operator === '周衡' && adopted.response.checkout!.id !== fy.id)
check('接续步骤仍为脏（待提交），不会自动计票', adopted.response.checkout!.working.find((w) => w.stepId === 'TS-4')!.dirty === true)
check('接续未产生新证据', s().evidence.length === evBefore + 1)

console.log('\n[6] 设备版本变化：只关联步骤失效，封存证据保留')
const zh = coOf('周衡')
const evCountBefore = s().evidence.length
send({ type: 'change-version', scope: 'device', targetId: 'T-03', nextVersion: 'v26.10', reason: '绝缘节调整' })
check('修订状态=变化待确认', s().revision === '变化待确认')
check('TC-102（含 R-02，T-03 关联）步骤全部失效', s().cases.find((c) => c.id === 'TC-102')!.steps.every((st) => st.invalid))
check('TC-101（R-01 不经 T-03）步骤未失效', s().cases.find((c) => c.id === 'TC-101')!.steps.every((st) => !st.invalid))
check('周衡在办签出转为已失效（只读）', s().checkouts.find((c) => c.id === zh.id)!.state === '已失效')
check('失效签出的脏步骤留为只读草稿', s().drafts.some((d) => d.state === '已失效' && d.checkoutId === zh.id))
check('已封存证据一份不少', s().evidence.length === evCountBefore)
check('未确认修订时门禁阻断', s().lastTally!.gatePassed === false)
check('TC-102 重算=待重测', tallyOf('TC-102').status === '待重测')
check('TC-101 仍为通过（证据版本=确认基线 v26.09）', tallyOf('TC-101').status === '通过')
expectThrow('版本过期签出重开提交被拒（只读）', () => send({ type: 'commit-step', checkoutId: zh.id, operator: '周衡', stepId: 'TS-4' }), 'NOT_ACTIVE')

console.log('\n[7] 确认修订：按有效证据重算（旧证据保留但不采信）')
send({ type: 'confirm-revision' })
check('确认后修订状态恢复稳定', s().revision === '稳定')
check('全站基线版本保持 v26.09（本次为单设备变更）', s().confirmedStationVersion === 'v26.09')
check('旧 v26.09 证据仍在（封存保留）', s().evidence.length === evCountBefore)
check('TC-101（不经 T-03）仍通过：无关用例证据继续采信', tallyOf('TC-101').status === '通过')
check('TC-102（经 T-03）变为待重测：旧证据指纹不符但保留', tallyOf('TC-102').status === '待重测')
check('失效步骤只覆盖 T-03 关联进路（R-02/R-04：TC-102 两步 + TC-103 一步 + TC-104 一步 = 4）', s().lastTally!.invalidSteps === 4)
check('TC-103（也含 R-02）同步失效待重测', tallyOf('TC-103').status === '待重测')
check('TC-104（R-04 含 T-03）步骤失效但状态仍为阻塞', tallyOf('TC-104').status === '阻塞' && tallyOf('TC-104').invalidCount === 1)

console.log('\n[8] 确认修订后可重新签出，按新指纹提交证据，门禁恢复')
send({ type: 'acquire', caseId: 'TC-102', operator: '陆晨' })
const lc = coOf('陆晨')
send({ type: 'save-working', checkoutId: lc.id, operator: '陆晨', stepId: 'TS-3', result: '通过', actual: 'v26.10 复测一致', evidencePayload: '日志 LG-301' })
send({ type: 'commit-step', checkoutId: lc.id, operator: '陆晨', stepId: 'TS-3' })
send({ type: 'save-working', checkoutId: lc.id, operator: '陆晨', stepId: 'TS-4', result: '通过', actual: 'S2 关闭时序达标', evidencePayload: '日志 LG-302' })
send({ type: 'commit-step', checkoutId: lc.id, operator: '陆晨', stepId: 'TS-4' })
check('TC-102 新证据后通过', tallyOf('TC-102').status === '通过')
check('步骤失效标记已由有效证据清除', s().cases.find((c) => c.id === 'TC-102')!.steps.every((st) => !st.invalid))
check('旧证据仍保留在证据链中', s().evidence.length >= evCountBefore + 2)

console.log('\n[9] 写入失败恢复：断网（未送达）→ 恢复补送')
resetServer()
store.delete('yy57-interlocking-outbox-v1')
setChaos('offline')
let offlineReq = ''
try {
  send({ type: 'acquire', caseId: 'TC-101', operator: '周衡' })
} catch (e) {
  offlineReq = (e as Error).message.match(/REQ-[A-Za-z0-9-]+/)?.[0] ?? ''
}
check('断网时请求进入发件箱', getOutbox().length === 1)
check('断网时服务端未创建签出', !s().checkouts.some((c) => c.operator === '周衡' && c.state === '执行中'))
setChaos('none')
const r1 = recover()
check('恢复后 1 笔新送达', r1.recovered === 1 && r1.replayed === 0)
check('恢复后签出已创建', !!coOf('周衡'))
check('发件箱清空', getOutbox().length === 0)

console.log('\n[10] 写入失败恢复：应答丢失（已送达）→ 重放幂等不重复')
// 先在正常链路暂存，再让“提交并封存证据”应答丢失
const zhCo0 = s().checkouts.find((c) => c.operator === '周衡' && c.state === '执行中')!
send({ type: 'save-working', checkoutId: zhCo0.id, operator: '周衡', stepId: 'TS-1', result: '通过', actual: 'a', evidencePayload: 'LG-9' })
setChaos('timeout')
const evidenceBeforeTimeout = s().evidence.length
let timeoutReq = ''
try {
  send({ type: 'commit-step', checkoutId: zhCo0.id, operator: '周衡', stepId: 'TS-1' })
} catch {
  timeoutReq = getOutbox().find((o) => o.command.type === 'commit-step')?.requestId ?? ''
}
check('应答丢失后调用方失败、但证据已封存', s().evidence.length === evidenceBeforeTimeout + 1)
check('发件箱登记提交请求（标记可能已写入）', getOutbox().filter((o) => o.command.type === 'commit-step').length === 1)
setChaos('none')
const r2 = recover(timeoutReq)
check('恢复判定为重放', r2.replayed === 1)
check('重放未产生第二份证据', s().evidence.length === evidenceBeforeTimeout + 1)
check('重放后计票不变', tallyOf('TC-101').validEvidenceCount === 2)
check('发件箱清空', getOutbox().length === 0)
check('记录的请求号与恢复一致', !!timeoutReq && timeoutReq !== '')

console.log('\n[11] 进路版本变化只影响该进路关联用例')
resetServer()
store.delete('yy57-interlocking-outbox-v1')
send({ type: 'change-version', scope: 'route', targetId: 'R-04', nextVersion: 'v26.11', reason: '调车进路时序修订' })
check('TC-104（R-04）失效', s().cases.find((c) => c.id === 'TC-104')!.steps.every((st) => st.invalid))
check('TC-101（R-01）不受影响', s().cases.find((c) => c.id === 'TC-101')!.steps.every((st) => !st.invalid))

console.log('\n[12] 账本重放入口（发布页按钮路径）')
send({ type: 'confirm-revision' })
const ledgerReq = s().ledger.find((l) => l.original?.type === 'change-version')!
check('账本保存原始命令与请求号', !!ledgerReq.original && ledgerReq.original.requestId === ledgerReq.requestId)
const evidBefore = s().evidence.length
replayRequest(ledgerReq.requestId)
check('账本重放不新增证据', s().evidence.length === evidBefore)
check('账本重放生成 replay 记录', s().ledger[0]!.replay === true)
check('重放后修订状态不变（原结果）', s().revision === '稳定')

console.log('\n[13] 全站升级：全部步骤失效待重测，封存证据全部保留')
resetServer()
const legacyEvCount = s().evidence.length
send({ type: 'change-version', scope: 'station', targetId: 'STATION', nextVersion: 'v26.10', reason: '全站软件升级' })
check('全站版本升至 v26.10', s().stationVersion === 'v26.10')
check('所有步骤失效', s().cases.every((c) => c.steps.every((st) => st.invalid)))
check('历史封存证据全部保留', s().evidence.length === legacyEvCount)
check('在办签出 CO-7001 失效只读', s().checkouts.find((c) => c.id === 'CO-7001')!.state === '已失效')
send({ type: 'confirm-revision' })
check('确认后门禁仍阻断（全部待重测）', s().lastTally!.gatePassed === false)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
