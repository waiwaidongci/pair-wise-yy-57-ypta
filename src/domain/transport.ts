import { DomainError, apply } from './server'
import type { Command, CommandResponse, OutboxItem } from '../types'

const OUTBOX_KEY = 'yy57-interlocking-outbox-v1'
const APPLIED_MARK = '应答丢失'

export class TransportError extends Error {
  constructor(public kind: 'offline' | 'timeout', message: string) {
    super(message)
    this.name = 'TransportError'
  }
}

/** 故障注入：offline = 发出前断网（服务端未收到）；timeout = 服务端已写入但应答丢失 */
let chaos: 'none' | 'offline' | 'timeout' = 'none'
export function setChaos(mode: 'none' | 'offline' | 'timeout') {
  chaos = mode
}
export function getChaos() {
  return chaos
}

const listeners = new Set<() => void>()
function emit() {
  listeners.forEach((fn) => fn())
}
export function subscribeOutbox(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function loadOutbox(): OutboxItem[] {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]') as OutboxItem[]
  } catch {
    return []
  }
}
function saveOutbox(items: OutboxItem[]) {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(items))
  emit()
}
export function getOutbox() {
  return loadOutbox()
}

export function newRequestId(prefix = 'REQ') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

export interface SendResult {
  requestId: string
  response: CommandResponse
  /** true=首次送达；false=重放命中（原写入已在服务端生效） */
  replayed: boolean
}

/**
 * 发送写命令：
 * - 每个命令带全局唯一请求号；
 * - 发出前断网（offline）：进入发件箱等待恢复，服务端未执行；
 * - 应答丢失（timeout）：服务端实际已写入，调用方按失败处理，恢复时凭请求号重放，账本去重、不重复计票。
 */
export function send(command: Command, requestId = newRequestId()): SendResult {
  const withId = { ...command, requestId } as Command
  const outbox = loadOutbox()
  const queued = outbox.find((item) => item.requestId === requestId)
  const wasApplied = !!queued?.lastError.startsWith(APPLIED_MARK)

  if (chaos === 'offline') {
    if (!queued) {
      outbox.unshift({
        requestId, command: withId, attempts: 1,
        lastError: '网络不可用（服务端尚未收到）',
        at: new Date().toISOString(),
      })
      saveOutbox(outbox)
    }
    throw new TransportError('offline', `请求 ${requestId} 已进入发件箱，可按请求号恢复`)
  }

  try {
    const response = apply(withId, { replay: !!queued })
    // 服务端已处理但应答在回程丢失：调用方视为失败，请求留在发件箱等待按请求号恢复
    if (chaos === 'timeout' && !queued) {
      outbox.unshift({
        requestId, command: withId, attempts: 1,
        lastError: `${APPLIED_MARK}：服务端可能已写入，恢复时按请求号幂等重放`,
        at: new Date().toISOString(),
      })
      saveOutbox(outbox)
      throw new TransportError('timeout', `请求 ${requestId} 写入后应答丢失，已登记发件箱`)
    }
    if (queued) saveOutbox(outbox.filter((item) => item.requestId !== requestId))
    return { requestId, response, replayed: wasApplied }
  } catch (error) {
    if (error instanceof TransportError) throw error
    if (error instanceof DomainError) {
      // 业务拒绝：重放也不会成功，从发件箱摘除并交由调用方提示
      if (queued) saveOutbox(outbox.filter((item) => item.requestId !== requestId))
      throw error
    }
    throw error
  }
}

/** 按请求号恢复发件箱：同一请求号重放，服务端账本幂等去重，重放不重复计票 */
export function recover(requestId?: string): { recovered: number; replayed: number; failed: { requestId: string; reason: string }[] } {
  const items = loadOutbox().filter((item) => !requestId || item.requestId === requestId)
  let recovered = 0
  let replayed = 0
  const failed: { requestId: string; reason: string }[] = []
  const previousChaos = chaos
  chaos = 'none'
  try {
    items.forEach((item) => {
      const wasApplied = item.lastError.startsWith(APPLIED_MARK)
      try {
        send(item.command, item.requestId)
        recovered += 1
        if (wasApplied) replayed += 1
      } catch (error) {
        failed.push({ requestId: item.requestId, reason: error instanceof Error ? error.message : String(error) })
      }
    })
  } finally {
    chaos = previousChaos
  }
  return { recovered, replayed, failed }
}
