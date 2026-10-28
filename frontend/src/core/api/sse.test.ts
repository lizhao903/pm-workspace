import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, setApiBase } from './client'
import { runs } from './resources'
import { SSEParser, StreamError, chat, runObject, type RunEvent } from './sse'

type Call = { url: string; init: RequestInit }

const enc = new TextEncoder()

// 打桩 fetch：按给定的 chunk 逐块吐出事件流；breakAfter 为真时最后一块之后让读取报错（模拟连接断开）
function mockStream(chunks: (string | Uint8Array)[], opts: { breakAfter?: boolean } = {}) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      let i = 0
      const body = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          if (init.signal?.aborted) {
            ctrl.error(new DOMException('aborted', 'AbortError'))
            return
          }
          if (i < chunks.length) {
            const c = chunks[i++]
            ctrl.enqueue(typeof c === 'string' ? enc.encode(c) : c)
          } else if (opts.breakAfter) {
            ctrl.error(new TypeError('network error'))
          } else {
            ctrl.close()
          }
        },
      })
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
    }),
  )
  return calls
}

const line = (ev: object) => `data: ${JSON.stringify(ev)}\n\n`

const start = { type: 'start', run_id: 'run_1', workdir: '/w' }
const delta = { type: 'delta', text: '你好' }
const tool = { type: 'tool', id: 't1', name: 'Read', detail: 'a.go' }
const toolResult = { type: 'tool_result', id: 't1', name: 'Read', ok: true, error: '' }
const done = { type: 'done', run_id: 'run_1', exit_code: 0 }

async function collect(chunks: (string | Uint8Array)[], opts?: { breakAfter?: boolean }) {
  mockStream(chunks, opts)
  const got: RunEvent[] = []
  const fin = await runObject('obj_1', {}, { onEvent: (e) => got.push(e) })
  return { got, fin }
}

afterEach(() => {
  vi.unstubAllGlobals()
  setApiBase('')
})

describe('SSEParser', () => {
  it('多行 data 用换行连接，忽略注释和别的字段，兼容 \\r\\n', () => {
    const p = new SSEParser()
    expect(p.push(': ping\r\nevent: x\r\nid: 1\r\ndata: a\r\ndata:b\r\n\r\n')).toEqual(['a\nb'])
  })

  it('连续空行不产生空事件', () => {
    const p = new SSEParser()
    expect(p.push('\n\ndata: x\n\n\n\n')).toEqual(['x'])
    expect(p.end()).toEqual([])
  })

  it('最后一行没有换行也能在 end 时交出', () => {
    const p = new SSEParser()
    expect(p.push('data: x')).toEqual([])
    expect(p.end()).toEqual(['x'])
  })
})

describe('分块边界', () => {
  it('一个事件跨两个 chunk', async () => {
    const s = line(delta)
    const { got, fin } = await collect([line(start), s.slice(0, 9), s.slice(9), line(done)])
    expect(got).toEqual([start, delta, done])
    expect(fin).toEqual(done)
  })

  it('切在 data: 前缀中间、切在两个换行之间', async () => {
    const s = line(start) + line(delta) + line(done)
    const a = s.indexOf('data:', 5) + 2
    const b = s.indexOf('\n\n') + 1
    const { got } = await collect([s.slice(0, b), s.slice(b, a), s.slice(a)])
    expect(got).toEqual([start, delta, done])
  })

  it('多字节字符被切开时不出乱码', async () => {
    const bytes = enc.encode(line(start) + line(delta) + line(done))
    // 「你」占三个字节，从它中间切开
    const cut = enc.encode(line(start)).length + enc.encode('data: {"type":"delta","text":"').length + 1
    const { got } = await collect([bytes.slice(0, cut), bytes.slice(cut)])
    expect(got[1]).toEqual(delta)
  })

  it('一个 chunk 里多个事件', async () => {
    const { got } = await collect([line(start) + line(delta) + line(tool) + line(toolResult) + line(done)])
    expect(got.map((e) => e.type)).toEqual(['start', 'delta', 'tool', 'tool_result', 'done'])
  })

  it('逐字节送也一样', async () => {
    const s = line(start) + line(delta) + line(done)
    const { got } = await collect(s.split(''))
    expect(got).toEqual([start, delta, done])
  })

  it('结尾没有空行：最后的 done 照样认', async () => {
    const { got, fin } = await collect([line(start), `data: ${JSON.stringify(done)}\n`])
    expect(got).toEqual([start, done])
    expect(fin).toEqual(done)
  })

  it('结尾连换行都没有', async () => {
    const { fin } = await collect([line(start) + `data: ${JSON.stringify(done)}`])
    expect(fin).toEqual(done)
  })
})

describe('断流和错误', () => {
  it('没有 done 就结束，报 truncated 而不是正常完成', async () => {
    mockStream([line(start), line(delta)])
    const got: RunEvent[] = []
    const p = runObject('obj_1', {}, { onEvent: (e) => got.push(e) })
    await expect(p).rejects.toBeInstanceOf(StreamError)
    await expect(p).rejects.toMatchObject({ kind: 'truncated' })
    // 断流前收到的事件照常交出去
    expect(got).toEqual([start, delta])
  })

  it('读到一半连接断开也报 truncated', async () => {
    mockStream([line(start)], { breakAfter: true })
    await expect(runObject('obj_1')).rejects.toMatchObject({ name: 'StreamError', kind: 'truncated' })
  })

  it('空流报 truncated', async () => {
    mockStream([])
    await expect(runObject('obj_1')).rejects.toMatchObject({ kind: 'truncated' })
  })

  it('执行里的 error 不是终止事件，后面跟着 done 时正常 resolve', async () => {
    const err = { type: 'error', message: '有工具调用被拒' }
    const { got, fin } = await collect([line(start), line(err), line(done)])
    expect(got).toEqual([start, err, done])
    expect(fin).toEqual(done)
  })

  it('只有 error 没有 done（对话出错）报 server，带上后端的原因', async () => {
    mockStream([line({ type: 'delta', text: 'a' }), line({ type: 'error', message: '模型超时' })])
    await expect(chat({ message: 'hi' })).rejects.toMatchObject({ kind: 'server', message: '模型超时' })
  })

  it('data 不是 JSON 报 malformed', async () => {
    mockStream(['data: {oops\n\n'])
    await expect(runObject('obj_1')).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('开流之前的失败是 ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: 'validation', message: '没有工作目录' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const p = runObject('obj_1')
    await expect(p).rejects.toBeInstanceOf(ApiError)
    await expect(p).rejects.toMatchObject({ status: 400, code: 'validation', message: '没有工作目录' })
  })

  it('请求没到后端是 network', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))))
    await expect(runObject('obj_1')).rejects.toMatchObject({ status: 0, code: 'network' })
  })
})

describe('请求和中断', () => {
  it('POST 到 /api/objects/{id}/run，带 body 和界面来源', async () => {
    setApiBase('http://127.0.0.1:7796/')
    const calls = mockStream([line(start), line(done)])
    await runObject('obj/1', { allow_writes: false })
    expect(calls[0].url).toBe('http://127.0.0.1:7796/api/objects/obj%2F1/run')
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ allow_writes: false })
    expect(new Headers(calls[0].init.headers).get('X-Actor-Source')).toBe('ui')
  })

  it('对话的 question 事件后跟 done', async () => {
    const q = { type: 'question', id: 'q_1', question: '要不要拆？', options: [{ label: '拆', detail: '按端拆' }], multi: false }
    const d = { type: 'done', session_id: 's1', message_id: 'm1' }
    const calls = mockStream([line(q) + line(d)])
    const got: unknown[] = []
    const fin = await chat({ message: 'hi' }, { onEvent: (e) => got.push(e) })
    expect(calls[0].url).toBe('/api/agent/chat')
    expect(got).toEqual([q, d])
    expect(fin).toEqual(d)
  })

  it('abort 中断读取抛 AbortError，不会调 cancel 接口', async () => {
    const calls = mockStream([line(start), line(delta), line(delta), line(done)])
    const ac = new AbortController()
    const got: RunEvent[] = []
    const p = runObject('obj_1', {}, {
      signal: ac.signal,
      onEvent: (e) => {
        got.push(e)
        if (e.type === 'start') ac.abort()
      },
    })
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(got.map((e) => e.type)).toEqual(['start'])
    expect(calls).toHaveLength(1)
  })

  it('同一个 chunk 里中断，剩下的事件不再交出去', async () => {
    mockStream([line(start) + line(delta) + line(done)])
    const ac = new AbortController()
    const got: RunEvent[] = []
    const p = runObject('obj_1', {}, {
      signal: ac.signal,
      onEvent: (e) => {
        got.push(e)
        ac.abort()
      },
    })
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(got).toEqual([start])
  })

  it('取消执行是单独的 POST /api/runs/{id}/cancel', async () => {
    const calls: Call[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return new Response(JSON.stringify({ data: { id: 'run_1', status: 'canceled' } }), { status: 200 })
      }),
    )
    await runs.cancel('run_1')
    expect(calls[0].url).toBe('/api/runs/run_1/cancel')
    expect(calls[0].init.method).toBe('POST')
  })
})
