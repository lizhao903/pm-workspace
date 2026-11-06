// SSE 流式响应：/api/objects/{id}/run 和 /api/agent/chat。
// 两个都是 POST 带 body，EventSource 只能 GET，所以用 fetch + ReadableStream 自己按空行切块。
// 后端每条事件只写一行 `data: <json>`，类型在 JSON 的 type 字段里，不用 SSE 的 event: 行。

import { ApiError, apiBase, errorCode } from './client'

// ---- 事件类型 ----

// 任务执行的事件，形状以 internal/runner 的 Event.MarshalJSON 为准。
export type RunEvent =
  // session_id 只有交给工作台 Agent（harness=agent）时有：这次用的 Agent 会话
  | { type: 'start'; run_id: string; workdir: string; session_id?: string }
  | { type: 'delta'; text: string }
  // 工具调用开始；靠 id 和 tool_result 配对，被取消时可能等不到配对的结果
  | { type: 'tool'; id: string; name: string; detail: string }
  // summary 只有工作台 Agent 的有：给人看的结果一句话
  | { type: 'tool_result'; id: string; name: string; ok: boolean; error: string; summary?: string }
  // 以下两种只有工作台 Agent 的有（TSK-0460）：要人确认的写操作，执行停下等（记录状态 waiting），
  // 确认或拒绝走 /api/agent/tool-calls/{id}/confirm|reject；deadline 到了按拒绝处理，之后发 decision
  | { type: 'confirm'; id: string; name: string; args: string; summary: string; deadline: string }
  | { type: 'decision'; id: string; approved: boolean; reason: 'user' | 'timeout' | (string & {}) }
  // 收尾时登记的产出，在 done 之前发；path 相对 workdir
  | { type: 'artifact'; artifact_id: string; path: string; size: number; is_new: boolean }
  | { type: 'done'; run_id: string; exit_code: number }
  // 不是终止事件：后面还会跟 done
  | { type: 'error'; message: string }

export type QuestionOption = { label: string; detail: string }

// Agent 对话的事件，形状以 internal/agent 的 StreamEvent 为准。
export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; name: string; args: string }
  // object_id 是内部 id，人读编号在 summary 里
  | { type: 'tool_result'; name: string; summary: string; object_id?: string }
  | { type: 'artifact'; path: string; size: number }
  // 发出后本轮就结束（后面跟 done），回答走下一条普通 chat 消息
  | { type: 'question'; id: string; question: string; options: QuestionOption[]; multi: boolean }
  // 要人确认的调用（AG-02a）：没执行，发出后本轮结束；id 会话里是 atc_，调试对话里是 dbg_
  | { type: 'confirm'; id: string; name: string; args: string; summary: string }
  // 调试对话的 done 没有 session_id、message_id
  | { type: 'done'; session_id: string; message_id: string }
  // 对话出错时后端只发 error 不发 done
  | { type: 'error'; message: string }

export type StreamEvent = RunEvent | ChatEvent
export type RunDone = Extract<RunEvent, { type: 'done' }>
export type ChatDone = Extract<ChatEvent, { type: 'done' }>

// ---- 错误 ----

// 流已经开始（200 之后）才出的错。开流之前的失败仍是 ApiError。
//   truncated：没收到 done 流就结束了（后端崩了、连接断了），不能当正常完成
//   server：没收到 done，但收到过 error 事件（对话出错走这条），message 取最后一条 error
//   malformed：某条 data 不是合法 JSON 或缺 type
export type StreamErrorKind = 'truncated' | 'server' | 'malformed'

export class StreamError extends Error {
  readonly kind: StreamErrorKind

  constructor(kind: StreamErrorKind, message: string) {
    super(message)
    this.name = 'StreamError'
    this.kind = kind
  }
}

export function isStreamError(e: unknown, kind?: StreamErrorKind): e is StreamError {
  return e instanceof StreamError && (kind === undefined || e.kind === kind)
}

// ---- 解析 ----

// SSEParser 按空行切块，返回每块 data 行拼起来的内容（多行 data 用 \n 连接）。
// 只认 data:，注释行（: 开头）和 event: / id: / retry: 忽略；兼容 \r\n。
// 跨 chunk 的半行留在缓冲里，等下一块再拼。
export class SSEParser {
  private buf = ''
  private data: string[] = []

  push(chunk: string): string[] {
    this.buf += chunk
    const out: string[] = []
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      this.line(line, out)
    }
    return out
  }

  // 流结束时调用：结尾没有空行（甚至最后一行没有换行）的那块也交出去。
  // 规范里这种不完整的块应当丢弃，但后端的最后一条往往就是 done，丢了会被误判成断流。
  end(): string[] {
    const out: string[] = []
    if (this.buf) {
      const line = this.buf.endsWith('\r') ? this.buf.slice(0, -1) : this.buf
      this.buf = ''
      this.line(line, out)
    }
    this.line('', out)
    return out
  }

  private line(line: string, out: string[]) {
    if (line === '') {
      if (this.data.length) out.push(this.data.join('\n'))
      this.data = []
      return
    }
    if (line.startsWith('data:')) {
      const v = line.slice(5)
      this.data.push(v.startsWith(' ') ? v.slice(1) : v)
    }
  }
}

function parseEvent<E extends StreamEvent>(raw: string): E {
  let ev: unknown
  try {
    ev = JSON.parse(raw)
  } catch {
    throw new StreamError('malformed', '流事件不是合法 JSON：' + raw.slice(0, 200))
  }
  if (!ev || typeof ev !== 'object' || typeof (ev as { type?: unknown }).type !== 'string') {
    throw new StreamError('malformed', '流事件缺少 type：' + raw.slice(0, 200))
  }
  return ev as E
}

// ---- 请求 ----

export type StreamOptions<E> = {
  // 每条事件到达时调用，包括 done 和 error
  onEvent?: (ev: E) => void
  // 中断读取。只是不再听，不会停掉后端的执行；停执行用 runs.cancel(run_id)
  signal?: AbortSignal
}

// streamPost 发 POST 并逐条读事件，收到 done 时 resolve（值就是 done 事件）。
// reject 的几种情况：开流前失败是 ApiError；流里出问题是 StreamError；
// signal 中断是 AbortError（DOMException），和 client.ts 一样原样抛出。
export async function streamPost<E extends StreamEvent>(
  path: string,
  body: unknown,
  opts: StreamOptions<E> = {},
): Promise<Extract<E, { type: 'done' }>> {
  const { signal, onEvent } = opts
  let res: Response
  try {
    res = await fetch(apiBase() + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-Actor-Source': 'ui' },
      body: JSON.stringify(body ?? {}),
      signal,
    })
  } catch (e) {
    if (isAbort(e)) throw e
    throw new ApiError(0, 'network', e instanceof Error ? e.message : '网络错误')
  }

  // 开流之前的失败（对象不存在、没有工作目录等）走普通 JSON 错误
  const ctype = res.headers.get('Content-Type') ?? ''
  if (!res.ok || !ctype.includes('text/event-stream')) throw await toApiError(res)
  if (!res.body) throw new StreamError('truncated', '响应没有内容')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const parser = new SSEParser()
  let lastError = ''

  // 返回 done 事件表示可以收工
  const handle = (raws: string[]) => {
    for (const raw of raws) {
      const ev = parseEvent<E>(raw)
      if (ev.type === 'error') lastError = (ev as { message?: string }).message || '执行出错'
      onEvent?.(ev)
      if (ev.type === 'done') return ev as Extract<E, { type: 'done' }>
      // 回调里中断的，同一块里剩下的事件也不再交出去
      signal?.throwIfAborted()
    }
    return undefined
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      // stream: true 让跨 chunk 的多字节字符留到下一块再解码
      const raws = done ? parser.push(decoder.decode()).concat(parser.end()) : parser.push(decoder.decode(value, { stream: true }))
      const fin = handle(raws)
      if (fin) {
        // done 之后后端就关流了，不再等；cancel 失败无所谓
        if (!done) reader.cancel().catch(() => {})
        return fin
      }
      if (done) break
    }
  } catch (e) {
    reader.cancel().catch(() => {})
    if (isAbort(e) || e instanceof StreamError) throw e
    // 读到一半连接断了
    throw new StreamError('truncated', '流中断：' + (e instanceof Error ? e.message : String(e)))
  }

  if (lastError) throw new StreamError('server', lastError)
  throw new StreamError('truncated', '流在收到 done 之前就结束了')
}

function isAbort(e: unknown) {
  return e instanceof DOMException && e.name === 'AbortError'
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string } } | null = null
  try {
    body = await res.json()
  } catch {
    // 非 JSON
  }
  const status = res.ok ? 500 : res.status
  const code = errorCode(body?.error?.code, status)
  const message = body?.error?.message || (res.ok ? '响应不是事件流' : res.statusText || 'HTTP ' + res.status)
  return new ApiError(status, code, message)
}

// ---- 两个流式接口 ----

export type RunRequest = {
  workdir?: string
  extra_prompt?: string
  allow_writes?: boolean
  /** 权限档位（TSK-0499）：给了以它为准，不给按 allow_writes；只读角色后端压成 read_only */
  permission?: 'read_only' | 'accept_edits' | 'edits_and_tests' | 'custom'
  preset_id?: string
  /** 执行器，空是 claude（TSK-0460 加 agent） */
  harness?: 'claude' | 'deepseek' | 'agent'
  /** deepseek / agent：用哪个服务商；agent 不给时用 Agent 设置的，deepseek 不给时后端挑（带 deepseek 的优先，TSK-0722） */
  provider_id?: string
  /** deepseek / agent：接着上次同一执行器的会话；没有可续的 400 */
  resume_session?: boolean
  /** 只对 agent：交给哪个 Agent（空用场景「执行任务」选的） */
  agent_id?: string
  /** agent / deepseek：这一次用的模型，空用服务商（agent 没给服务商时用 Agent）设置的 */
  model?: string
  /** 以下只对 agent：步数和时长上限、等确认多久按拒绝 */
  max_steps?: number
  max_minutes?: number
  confirm_wait_minutes?: number
}

export type ChatRequest = {
  session_id?: string
  provider_id?: string
  model?: string
  workdir?: string
  object_id?: string
  message: string
}

// 执行任务。中断读取（signal）不等于取消执行，取消用 runs.cancel(start 事件里的 run_id)。
export function runObject(id: string, req: RunRequest = {}, opts?: StreamOptions<RunEvent>): Promise<RunDone> {
  return streamPost<RunEvent>(`/api/objects/${encodeURIComponent(id)}/run`, req, opts)
}

export function chat(req: ChatRequest, opts?: StreamOptions<ChatEvent>): Promise<ChatDone> {
  return streamPost<ChatEvent>('/api/agent/chat', req, opts)
}

// 确认或拒绝一次要人确认的调用（AG-02a），事件同 chat：确认先执行再接着跑，拒绝把「用户拒绝了」交回模型接着跑。
// 已经处理过、Agent 停用或删了、授权已关是开流前的 409；调试里的 dbg_ 过期是 404。
export function decideToolCall(id: string, approve: boolean, opts?: StreamOptions<ChatEvent>): Promise<ChatDone> {
  return streamPost<ChatEvent>(`/api/agent/tool-calls/${encodeURIComponent(id)}/${approve ? 'confirm' : 'reject'}`, {}, opts)
}

export type DebugChatMessage = { role: 'user' | 'assistant'; content: string }

// 调试对话（AG-02c）：用没保存的配置跑，不写会话和消息。Agent 字段同 PATCH /api/agents/{id}，
// grants 不给时用 agent_id 存着的；messages 是整段对话，最后一条是这次要发的 user
export type DebugChatRequest = {
  agent_id?: string
  name?: string
  desc?: string
  provider_id?: string
  model?: string
  instructions?: string
  skills?: string[]
  mcps?: string[]
  kbs?: string[]
  grants?: Record<string, 'off' | 'confirm' | 'auto'>
  workdir?: string
  messages: DebugChatMessage[]
}

export function debugChat(req: DebugChatRequest, opts?: StreamOptions<ChatEvent>): Promise<ChatDone> {
  return streamPost<ChatEvent>('/api/agents/debug/chat', req, opts)
}
