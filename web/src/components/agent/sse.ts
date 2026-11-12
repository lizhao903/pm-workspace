// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 手写 SSE 解析。EventSource 只能发 GET，而 /api/agent/chat 要 POST 一个 body，
// 所以走 fetch + ReadableStream，自己按空行切事件块。
import type { AgentStreamEvent } from '../../lib/types'

// 事件名单从类型派生，而不是手写一个字符串数组。
// 手写的话漏掉一种事件不违反任何类型——TypeScript 一个字都不会说，
// 那种事件会在 parseBlock 里被静默丢掉，界面上表现为「后端明明发了，前端什么都没有」。
// 写成 Record<AgentStreamEvent['type'], true> 之后，后端加一种而这里没跟上，编译就红。
const KNOWN_TYPES: Record<AgentStreamEvent['type'], true> = {
  delta: true,
  tool_call: true,
  tool_result: true,
  artifact: true,
  question: true,
  done: true,
  error: true,
}
const KNOWN = new Set<string>(Object.keys(KNOWN_TYPES))

/**
 * 解析一个事件块（多行 field: value）。
 * 认不出来的事件返回 null 而不是抛错——后端以后加事件类型时前端不该整条流崩掉。
 */
function parseBlock(block: string): AgentStreamEvent | null {
  let name = ''
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue // 空行与注释（心跳）
    if (line.startsWith('event:')) { name = line.slice(6).trim(); continue }
    if (line.startsWith('data:')) { data.push(line.slice(5).replace(/^ /, '')); continue }
  }
  if (!data.length) return null

  const raw = data.join('\n').trim()
  if (!raw || raw === '[DONE]') return null

  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return { type: 'error', message: `无法解析事件数据：${raw.slice(0, 200)}` }
  }
  if (!obj || typeof obj !== 'object') return null

  const rec = obj as Record<string, unknown>
  // 以 data 里的 type 为准；后端若只写在 event: 行上也认
  const type = typeof rec.type === 'string' ? rec.type : name
  if (!KNOWN.has(type)) return null
  return { ...rec, type } as AgentStreamEvent
}

/** 把响应体流式切成事件。调用方用 for await 消费，abort 时 reader.read() 自己会抛。 */
export async function* streamSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<AgentStreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let cut = buf.indexOf('\n\n')
      while (cut >= 0) {
        const block = buf.slice(0, cut)
        buf = buf.slice(cut + 2)
        const ev = parseBlock(block)
        if (ev) yield ev
        cut = buf.indexOf('\n\n')
      }
    }
    buf += decoder.decode().replace(/\r\n/g, '\n')
    // 后端没以空行收尾时，最后一个事件不能丢
    const tail = parseBlock(buf)
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}
