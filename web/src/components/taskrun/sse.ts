// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 执行流的 SSE 解析。EventSource 只能发 GET，而 POST /api/objects/{id}/run 要带 body，
// 所以走 fetch + ReadableStream 自己按空行切块。
// 与 agent/sse.ts 同构但独立：那边的事件集合是对话的，两边各自演进，不互相牵制。
import type { TaskRunEvent } from '../../lib/types'

// 契约就是 types.ts 的 TaskRunEvent，这里不再自己扩联合——本地补丁比契约少字段的话，
// 窄化之后 ev.workdir 这种会被判成不存在。
export type TaskRunStreamEvent = TaskRunEvent

// 用 Record 从契约反推出事件名，而不是手写数组：漏写一个字符串不违反任何类型，
// 但 Record 少一个 key 是编译错误。以后契约加事件、这里忘了跟，构建当场红。
const KNOWN_MAP: Record<TaskRunEvent['type'], true> = {
  start: true, delta: true, tool: true, tool_result: true, done: true, error: true,
  artifact: true,
}
const KNOWN = new Set(Object.keys(KNOWN_MAP))

/**
 * 解析一个事件块（多行 field: value）。
 * 认不出来的事件返回 null 而不是抛错——后端以后加事件类型时前端不该整条流崩掉。
 */
function parseBlock(block: string): TaskRunStreamEvent | null {
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
  if (!KNOWN.has(type)) {
    // 类型不认识但带了 run_id，就当先导事件收下——run_id 是「停止」能真正生效的前提，
    // 宁可把未知事件当 start，也不能把它丢掉。
    if (typeof rec.run_id === 'string' && rec.run_id) {
      return { type: 'start', run_id: rec.run_id, workdir: typeof rec.workdir === 'string' ? rec.workdir : '' }
    }
    return null
  }
  return { ...rec, type } as TaskRunStreamEvent
}

/** 把响应体流式切成事件。调用方用 for await 消费，abort 时 reader.read() 自己会抛。 */
export async function* streamTaskRun(body: ReadableStream<Uint8Array>): AsyncGenerator<TaskRunStreamEvent> {
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
