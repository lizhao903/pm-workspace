import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { changesFor, eventStreamStatus, onServerEvent, startEventStream, type ServerEvent } from './events'
import { dataKeys } from './keys'

describe('事件到改动', () => {
  const ev = (type: string, payload: Record<string, unknown> = {}) => ({ type, payload })

  it('内核事件各走各的失效规则', () => {
    expect(changesFor(ev('object.created', { id: 'obj_a', type_id: 'task' }))).toEqual([{ kind: 'object', id: 'obj_a' }])
    expect(changesFor(ev('object.updated', { id: 'obj_a', fields: ['status'] }))).toEqual([{ kind: 'object', id: 'obj_a' }])
    expect(changesFor(ev('task.review_requested', { id: 'obj_a' }))).toEqual([{ kind: 'progress', id: 'obj_a' }])
    expect(changesFor(ev('object.progress_appended', { id: 'obj_a', kind: 'note' }))).toEqual([{ kind: 'progress', id: 'obj_a' }])
    expect(changesFor(ev('run.finished', { run_id: 'run_1', object_id: 'obj_a', ok: true }))).toEqual([{ kind: 'run-settled', objectId: 'obj_a' }])
  })

  it('状态变化跟着 object.updated 一起来，不重复刷；通知和插件事件不动缓存', () => {
    expect(changesFor(ev('object.status_changed', { id: 'obj_a', from: 'todo', to: 'doing' }))).toEqual([])
    expect(changesFor(ev('notification.created', { id: 'ntf_1' }))).toEqual([])
    expect(changesFor(ev('im.message_received', { id: 'msg_1' }))).toEqual([])
  })

  it('以后新增的对象类事件带对象 id 时按对象改动刷新', () => {
    expect(changesFor(ev('object.future_kind', { id: 'obj_a' }))).toEqual([{ kind: 'object', id: 'obj_a' }])
    expect(changesFor(ev('object.whatever'))).toEqual([])
  })
})

// 假的 EventSource：记下每次连的地址，测试里手动发消息、出错
class FakeES {
  static all: FakeES[] = []
  readyState = 0
  onopen: ((ev: Event) => unknown) | null = null
  onmessage: ((ev: MessageEvent) => unknown) | null = null
  onerror: ((ev: Event) => unknown) | null = null
  url: string
  constructor(url: string) {
    this.url = url
    FakeES.all.push(this)
  }
  close() {
    this.readyState = 2
  }
  open() {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }
  send(e: Partial<ServerEvent> & { type: string }) {
    const id = e.id ?? ''
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ at: '', payload: {}, ...e, id }), lastEventId: id }))
  }
  fail(closed: boolean) {
    this.readyState = closed ? 2 : 0
    this.onerror?.(new Event('error'))
  }
}
const last = () => FakeES.all[FakeES.all.length - 1]

describe('连接', () => {
  let qc: QueryClient
  let stop: () => void = () => {}
  beforeEach(() => {
    vi.useFakeTimers()
    FakeES.all = []
    qc = new QueryClient()
    qc.setQueryData(dataKeys.objects.progress('obj_a'), [])
    qc.setQueryData(dataKeys.objects.progress('obj_b'), [])
    qc.setQueryData(dataKeys.objectTypes, [])
  })
  afterEach(() => {
    stop()
    vi.useRealTimers()
  })
  const invalid = (k: readonly unknown[]) => qc.getQueryState(k)?.isInvalidated

  it('连上是 open；事件合并后按规则失效', async () => {
    stop = startEventStream(qc, { EventSource: FakeES })
    expect(eventStreamStatus()).toBe('connecting')
    last().open()
    last().send({ id: '10', type: 'stream.ready' })
    expect(eventStreamStatus()).toBe('open')
    last().send({ id: '11', type: 'task.review_requested', payload: { id: 'obj_a' } })
    expect(invalid(dataKeys.objects.progress('obj_a'))).toBe(false)
    await vi.advanceTimersByTimeAsync(60)
    expect(invalid(dataKeys.objects.progress('obj_a'))).toBe(true)
    expect(invalid(dataKeys.objects.progress('obj_b'))).toBe(false)
    expect(invalid(dataKeys.objectTypes)).toBe(false)
  })

  it('连不上时关掉、按退避重连，带上最后一个 id；补不齐整页重拉', async () => {
    stop = startEventStream(qc, { EventSource: FakeES })
    last().open()
    last().send({ id: '10', type: 'stream.ready' })
    last().send({ id: '12', type: 'object.status_changed', payload: { id: 'obj_a' } })
    // 中途断：浏览器自己重连
    last().fail(false)
    expect(eventStreamStatus()).toBe('connecting')
    // 重连被拒（服务停了）：EventSource 关掉，等退避
    last().fail(true)
    expect(eventStreamStatus()).toBe('closed')
    expect(FakeES.all).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(FakeES.all).toHaveLength(2)
    expect(last().url).toBe('/api/events?last_event_id=12')
    // 第二次也连不上，退避变长
    last().fail(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(FakeES.all).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(FakeES.all).toHaveLength(3)
    // 服务重启过：后端回 reset，所有缓存过期
    last().open()
    last().send({ id: '99', type: 'stream.reset' })
    expect(eventStreamStatus()).toBe('open')
    expect(invalid(dataKeys.objectTypes)).toBe(true)
    expect(invalid(dataKeys.objects.progress('obj_b'))).toBe(true)
  })

  it('原始事件按类型分发，停止后状态回到 closed', () => {
    const got: string[] = []
    const off = onServerEvent('im.message_received', (e) => got.push(e.id))
    const offAll = onServerEvent('*', (e) => got.push(`*${e.type}`))
    stop = startEventStream(qc, { EventSource: FakeES })
    last().open()
    last().send({ id: '1', type: 'im.message_received' })
    off()
    last().send({ id: '2', type: 'im.message_received' })
    offAll()
    expect(got).toEqual(['1', '*im.message_received', '*im.message_received'])
    stop()
    expect(eventStreamStatus()).toBe('closed')
    expect(last().readyState).toBe(2)
  })

  it('没有 EventSource 时什么都不做', () => {
    stop = startEventStream(qc)
    expect(eventStreamStatus()).toBe('closed')
  })
})
