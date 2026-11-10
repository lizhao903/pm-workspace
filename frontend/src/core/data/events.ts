// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 事件流订阅（CORE-07c）：EventSource 连 GET /api/events，按事件类型走失效规则（invalidate.ts）刷新缓存。
// 连接状态给轮询做开关：连着时靠推送，断开时各处退回原来的轮询。契约见 docs/api-contract.md「事件流」。
import { useSyncExternalStore } from 'react'
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { invalidationsFor, type Change } from './invalidate'

/** 流里的一条，即 SSE 的 data */
export type ServerEvent = { id: string; type: string; at: string; payload: Record<string, unknown> }

/** connecting：正在连或浏览器在自动重连；open：连着；closed：没启动、不支持或断开等重连 */
export type EventStreamStatus = 'connecting' | 'open' | 'closed'

export const STREAM_READY = 'stream.ready'
export const STREAM_RESET = 'stream.reset'
const EVENTS_URL = '/api/events'
// 断开后自己重连的退避：1、2、4、8、15 秒封顶（服务没起时 EventSource 不会自己重试）
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000]
// 一批事件（重连补发、改一次发两三条）合并成一次失效
const FLUSH_MS = 50

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

/**
 * 一条事件对应的改动。载荷只有 id 和字段名，内容靠失效后回查。
 * object.status_changed 不单独处理：同一次改动一定先发了带 status 的 object.updated。
 */
export function changesFor(e: Pick<ServerEvent, 'type' | 'payload'>): Change[] {
  const p = e.payload ?? {}
  switch (e.type) {
    case 'object.created':
    case 'object.updated':
      return [{ kind: 'object', id: str(p.id) }]
    case 'object.status_changed':
    case 'notification.created':
      return []
    case 'object.progress_appended':
    case 'task.review_requested': {
      const id = str(p.id)
      return id ? [{ kind: 'progress', id }] : [{ kind: 'object' }]
    }
    case 'incident':
      // 运行异常新记、合并、改状态、转任务（INC-01a）：只带 id，列表整份重取
      return [{ kind: 'incident', id: str(p.id) }]
    case 'run.finished': {
      const objectId = str(p.object_id)
      return objectId ? [{ kind: 'run-settled', objectId }] : [{ kind: 'run-canceled' }]
    }
  }
  // 以后新增的对象类内核事件（带对象 id）按对象改动刷新；插件事件不动缓存，由订阅方自己处理
  if (e.type.startsWith('incident.')) return [{ kind: 'incident', id: str(p.id) }]
  const id = str(p.id)
  if (id && (e.type.startsWith('object.') || e.type.startsWith('task.'))) return [{ kind: 'object', id }]
  return []
}

// ---- 连接状态（模块级，应用里只有一条流） ----

let status: EventStreamStatus = 'closed'
const statusListeners = new Set<() => void>()

function setStatus(s: EventStreamStatus) {
  if (s === status) return
  status = s
  for (const l of statusListeners) l()
}

export const eventStreamStatus = () => status

/** 外壳显示连接状态用 */
export function useEventStreamStatus(): EventStreamStatus {
  return useSyncExternalStore(
    (l) => {
      statusListeners.add(l)
      return () => statusListeners.delete(l)
    },
    eventStreamStatus,
    () => 'closed',
  )
}

/** 事件流连着：轮询可以停 */
export const useEventsLive = () => useEventStreamStatus() === 'open'

// ---- 按类型订阅原始事件（插件 EventRegistry.on 以后接在这上面） ----

type Handler = (e: ServerEvent) => void
const handlers = new Map<string, Set<Handler>>()

/** type 传 '*' 收全部；返回取消订阅 */
export function onServerEvent(type: string, h: Handler): () => void {
  let set = handlers.get(type)
  if (!set) handlers.set(type, (set = new Set()))
  set.add(h)
  return () => set.delete(h)
}

function dispatch(e: ServerEvent) {
  for (const t of [e.type, '*']) {
    for (const h of handlers.get(t) ?? []) {
      try {
        h(e)
      } catch (err) {
        console.error('event handler failed', e.type, err)
      }
    }
  }
}

// ---- 连接 ----

type ESLike = Pick<EventSource, 'readyState' | 'close'> & {
  onopen: ((ev: Event) => unknown) | null
  onmessage: ((ev: MessageEvent) => unknown) | null
  onerror: ((ev: Event) => unknown) | null
}

export type EventStreamOptions = {
  /** 测试里换成假的；默认用浏览器的 */
  EventSource?: new (url: string) => ESLike
  url?: string
}

const CLOSED = 2

/**
 * 启动订阅，返回停止函数。没有 EventSource（Node、测试环境）时什么都不做，状态保持 closed，各处照常轮询。
 * 断开分两种：连接中途断了浏览器会带 Last-Event-ID 自动重连（状态 connecting）；
 * 连不上（服务没起、代理回 5xx）EventSource 直接关掉，这里按退避自己重连，带上收到的最后一个 id 让后端补齐。
 */
export function startEventStream(qc: QueryClient, opts: EventStreamOptions = {}): () => void {
  const ES = opts.EventSource ?? (typeof EventSource === 'undefined' ? undefined : EventSource)
  if (!ES) return () => {}
  const url = opts.url ?? EVENTS_URL

  let es: ESLike | null = null
  let lastId = ''
  let ready = false // 这次启动以来收到过 ready 或 reset
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const pending = new Map<string, QueryKey>()

  const flush = () => {
    flushTimer = undefined
    const keys = [...pending.values()]
    pending.clear()
    for (const queryKey of keys) void qc.invalidateQueries({ queryKey })
  }
  const queue = (cs: Change[]) => {
    for (const c of cs) for (const k of invalidationsFor(c)) pending.set(JSON.stringify(k), k)
    if (pending.size && !flushTimer) flushTimer = setTimeout(flush, FLUSH_MS)
  }
  // 补不齐：整页重新拉，有人在看的查询马上重取
  const resetAll = () => {
    pending.clear()
    void qc.invalidateQueries()
  }

  const onMessage = (m: MessageEvent) => {
    let e: ServerEvent
    try {
      e = JSON.parse(String(m.data)) as ServerEvent
    } catch {
      return
    }
    if (m.lastEventId) lastId = m.lastEventId
    else if (e.id) lastId = e.id
    attempt = 0
    setStatus('open')
    if (e.type === STREAM_READY) {
      // 重连时没能带上 id（只会是第一次连上之前就断了），中间漏了什么不知道，整页重拉
      if (ready) resetAll()
      ready = true
    } else if (e.type === STREAM_RESET) {
      ready = true
      resetAll()
    } else {
      queue(changesFor(e))
    }
    dispatch(e)
  }

  const connect = () => {
    retryTimer = undefined
    if (stopped) return
    setStatus('connecting')
    const src = new ES(lastId ? `${url}?last_event_id=${encodeURIComponent(lastId)}` : url)
    es = src
    src.onopen = () => {
      if (es === src) setStatus('open')
    }
    src.onmessage = (m) => {
      if (es === src) onMessage(m)
    }
    src.onerror = () => {
      if (es !== src || stopped) return
      if (src.readyState !== CLOSED) {
        // 浏览器在自动重连
        setStatus('connecting')
        return
      }
      src.close()
      es = null
      setStatus('closed')
      retryTimer = setTimeout(connect, BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)])
    }
  }

  connect()
  return () => {
    stopped = true
    clearTimeout(retryTimer)
    clearTimeout(flushTimer)
    es?.close()
    es = null
    setStatus('closed')
  }
}
