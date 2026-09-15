// 对话框的全部状态机：供应商 / 会话 / 输出目录 / 消息流 / SSE 收发与中断。
// 组件只负责渲染，异步都收在这里。
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import type { AgentMessage, AgentProvider, AgentSession, QuestionOption, WorkdirCheck } from '../../lib/types'
import { streamSSE } from './sse'
import { setAgentStatus } from './status'

const LS_WORKDIR = 'pmw.agent.workdir'
const LS_RECENT = 'pmw.agent.recent-dirs'
const RECENT_MAX = 8
/** Agent 连着建好几条对象时，列表刷新要合并成一次 */
const RELOAD_DEBOUNCE = 600
/** 工具名里出现这些词就当作写操作，收到结果后刷新工作台 */
const WRITE_TOOL = /(create|update|delete|patch|add|set|move|archive|restore|link|merge|remove)/i

let seq = 0
const nextId = () => `ag${++seq}`

export type ChatItemKind = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'artifact' | 'question' | 'error'

export interface ChatItem {
  id: string
  kind: ChatItemKind
  /** user/assistant 的正文，tool_result 的 summary，question 的问题，error 的错误文案 */
  text: string
  toolName?: string
  /** tool_result 带的对象内部 id，渲染成可点链接直接 select 跳转 */
  objectId?: string
  /** artifact 的相对路径与字节数 */
  path?: string
  size?: number
  /** tool_call 还没等到结果，转圈 */
  running?: boolean
  /** assistant 气泡仍在追加 */
  streaming?: boolean
  /** error 可重试 */
  retryable?: boolean

  /* ── question 专用 ── */
  options?: QuestionOption[]
  multi?: boolean
  /** 用户当前选中的 label。单选时至多一个 */
  picked?: string[]
  /** 已经答过的问题不再可点：答案已经作为一条普通消息发出去了，再点一次只会重复发 */
  answered?: boolean
}

export interface UseAgentChat {
  providers: AgentProvider[]
  providerId: string
  setProvider: (id: string) => void
  model: string

  sessions: AgentSession[]
  sessionId: string | null
  openSession: (id: string | null) => void
  removeSession: (id: string) => Promise<void>

  workdir: string
  setWorkdir: (v: string) => void
  workdirCheck: WorkdirCheck | null
  checkingWorkdir: boolean
  checkWorkdir: () => Promise<WorkdirCheck | null>
  recentDirs: string[]

  items: ChatItem[]
  streaming: boolean
  send: (text: string) => Promise<void>
  stop: () => void
  retry: () => void

  /** 点一个选项。单选且只有这一个问题待答时直接发出去，否则先攒着 */
  pickOption: (id: string, label: string) => void
  /** 把所有待答问题的选择一次发出去 */
  submitAnswers: () => void
}

function readRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_RECENT) ?? '[]')
    return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string').slice(0, RECENT_MAX) : []
  } catch { return [] }
}

/** 把选择拼成一句普通的话发回去。
 *  只有一个问题时就只发选项本身——用户自己打字也是这么写的，
 *  而且后端的 assistant 消息里已经留着问题原文，对得上号。
 *  一次问了好几个才需要把问题带上，否则答案和问题会错位。 */
function answerText(qs: ChatItem[]): string {
  if (qs.length === 1) return (qs[0].picked ?? []).join('、')
  return qs.map((q) => `${q.text} → ${(q.picked ?? []).join('、')}`).join('\n')
}

/** 历史消息回放：role=tool 的按 tool_result 样式渲染 */
function toItem(m: AgentMessage): ChatItem {
  if (m.role === 'tool') {
    return { id: m.id, kind: 'tool_result', text: m.content, toolName: m.tool_name || '工具' }
  }
  return { id: m.id, kind: m.role === 'user' ? 'user' : 'assistant', text: m.content }
}

/**
 * @param objectId 用户此刻打开的工作对象。传给后端只为解决「这个需求怎么推进」里的
 *   「这个」指谁——正文由模型自己调 get_object 现取，这里不承担取数。
 *   没选中任何东西时传空，后端按没传处理。
 */
export function useAgentChat(onDataChanged: () => void, objectId?: string | null): UseAgentChat {
  const [providers, setProviders] = useState<AgentProvider[]>([])
  const [providerId, setProviderId] = useState('')
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [workdir, setWorkdirState] = useState(() => {
    try { return localStorage.getItem(LS_WORKDIR) ?? '' } catch { return '' }
  })
  const [workdirCheck, setWorkdirCheck] = useState<WorkdirCheck | null>(null)
  const [checkingWorkdir, setCheckingWorkdir] = useState(false)
  const [recentDirs, setRecentDirs] = useState<string[]>(readRecent)
  const [items, setItems] = useState<ChatItem[]>([])
  const [streaming, setStreaming] = useState(false)
  // 出错要粘住：否则 streaming 转 false 时下面的 effect 会立刻把状态栏刷回「就绪」
  const [failed, setFailed] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const assistantRef = useRef<string | null>(null) // 当前正在追加的 assistant 气泡 id
  const lastSent = useRef('')
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 刷新回调存成 ref，这样 send 的闭包不必因为它变化而重建。
  // 写 ref 要放进 effect：并发渲染下 render 期间改 ref 不安全。
  const changedRef = useRef(onDataChanged)
  useEffect(() => { changedRef.current = onDataChanged }, [onDataChanged])

  const model = providers.find((p) => p.id === providerId)?.model ?? ''

  // 状态栏跟着走
  useEffect(() => {
    // 「生成中」优先于「未配置」：没配供应商也能直接发（后端首次对话自动接本机 ollama），
    // 这时候状态栏还报「未配置模型」就和用户眼前正在流的字对不上了。
    if (streaming) { setAgentStatus({ phase: 'streaming', model }); return }
    if (!providers.length) { setAgentStatus({ phase: 'unconfigured', model: '' }); return }
    setAgentStatus({ phase: failed ? 'error' : 'idle', model })
  }, [providers.length, streaming, failed, model])

  /* ───────── 初始加载：供应商 + 会话 ───────── */

  useEffect(() => {
    let alive = true
    void (async () => {
      // 后端可能还没上线，失败一律按空态，不弹横幅
      const ps = await api.providers().catch(() => [] as AgentProvider[])
      const ss = await api.agentSessions().catch(() => [] as AgentSession[])
      if (!alive) return
      // 默认供应商排前，选择器第一项就是开箱即用的那个
      const usable = ps.filter((p) => p.enabled !== false)
        .sort((a, b) => Number(b.is_default) - Number(a.is_default))
      setProviders(usable)
      setSessions(ss)
      const last = ss[0] ?? null
      const pick = usable.find((p) => p.id === last?.provider_id)
        ?? usable.find((p) => p.is_default)
        ?? usable[0]
      if (pick) setProviderId(pick.id)
    })()
    return () => { alive = false }
  }, [])

  const refreshSessions = useCallback(async () => {
    const ss = await api.agentSessions().catch(() => null)
    if (ss) setSessions(ss)
  }, [])

  /** 一个供应商都没有时，后端会在首次对话里自动建一条本机 ollama 的默认配置。
   *  流跑完补拉一次，模型选择器就不用等用户刷新页面才出现选项。 */
  const backfillProviders = useCallback(async () => {
    const ps = await api.providers().catch(() => null)
    if (!ps?.length) return
    const usable = ps.filter((p) => p.enabled !== false)
      .sort((a, b) => Number(b.is_default) - Number(a.is_default))
    setProviders(usable)
    setProviderId((cur) => cur || usable.find((p) => p.is_default)?.id || usable[0].id)
  }, [])

  /* ───────── 输出目录 ───────── */

  const setWorkdir = useCallback((v: string) => {
    setWorkdirState(v)
    setWorkdirCheck(null) // 路径一改，旧的校验结果就作废
  }, [])

  const rememberDir = useCallback((dir: string) => {
    if (!dir) return
    try { localStorage.setItem(LS_WORKDIR, dir) } catch { /* 忽略写入失败 */ }
    setRecentDirs((prev) => {
      const next = [dir, ...prev.filter((d) => d !== dir)].slice(0, RECENT_MAX)
      try { localStorage.setItem(LS_RECENT, JSON.stringify(next)) } catch { /* 忽略 */ }
      return next
    })
  }, [])

  const checkWorkdir = useCallback(async (): Promise<WorkdirCheck | null> => {
    const dir = workdir.trim()
    if (!dir) { setWorkdirCheck(null); return null }
    setCheckingWorkdir(true)
    try {
      const r = await api.checkWorkdir(dir)
      setWorkdirCheck(r)
      if (r.exists && r.is_dir && r.writable) {
        rememberDir(dir)
        if (sessionId) await api.updateAgentSession(sessionId, { workdir: dir }).catch(() => null)
      }
      return r
    } catch (e) {
      const r: WorkdirCheck = {
        path: dir, exists: false, is_dir: false, writable: false,
        message: e instanceof Error ? e.message : String(e),
      }
      setWorkdirCheck(r)
      return r
    } finally {
      setCheckingWorkdir(false)
    }
  }, [workdir, sessionId, rememberDir])

  /* ───────── 会话切换 ───────── */

  const openSession = useCallback((id: string | null) => {
    abortRef.current?.abort()
    assistantRef.current = null
    setSessionId(id)
    if (!id) { setItems([]); return }
    void (async () => {
      const msgs = await api.agentMessages(id).catch(() => [] as AgentMessage[])
      setItems(msgs.map(toItem))
    })()
    const s = sessions.find((x) => x.id === id)
    if (s?.provider_id) setProviderId(s.provider_id)
    if (s?.workdir) { setWorkdirState(s.workdir); setWorkdirCheck(null) }
  }, [sessions])

  const removeSession = useCallback(async (id: string) => {
    await api.deleteAgentSession(id)
    setSessions((prev) => prev.filter((s) => s.id !== id))
    if (sessionId === id) { setSessionId(null); setItems([]) }
  }, [sessionId])

  const setProvider = useCallback((id: string) => {
    setProviderId(id)
    const m = providers.find((p) => p.id === id)?.model ?? ''
    if (sessionId) void api.updateAgentSession(sessionId, { provider_id: id, model: m }).catch(() => null)
  }, [providers, sessionId])

  /* ───────── 消息流 ───────── */

  const push = useCallback((it: ChatItem) => setItems((prev) => [...prev, it]), [])

  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current)
    reloadTimer.current = setTimeout(() => { changedRef.current() }, RELOAD_DEBOUNCE)
  }, [])

  useEffect(() => () => { if (reloadTimer.current) clearTimeout(reloadTimer.current) }, [])

  /** 收尾当前 assistant 气泡：空的就丢掉，免得留一个空框 */
  const sealAssistant = useCallback(() => {
    const id = assistantRef.current
    assistantRef.current = null
    if (!id) return
    setItems((prev) => {
      const hit = prev.find((x) => x.id === id)
      if (hit && !hit.text) return prev.filter((x) => x.id !== id)
      return prev.map((x) => (x.id === id ? { ...x, streaming: false } : x))
    })
  }, [])

  const send = useCallback(async (text: string) => {
    const msg = text.trim()
    if (!msg || streaming) return
    lastSent.current = msg
    setFailed(false)

    // 目录填了但没校验过就先校验一次；结果只用来提示，不拦纯对话
    const dir = workdir.trim()
    if (dir && workdirCheck?.path !== dir) await checkWorkdir()

    let sid = sessionId
    if (!sid) {
      // 会话由前端显式创建，后端不必猜；建失败就让后端自己兜（session_id 传空）
      const s = await api.createAgentSession({
        title: msg.slice(0, 40), provider_id: providerId, model, workdir: dir,
      }).catch(() => null)
      if (s) { sid = s.id; setSessionId(s.id); setSessions((prev) => [s, ...prev]) }
    }

    push({ id: nextId(), kind: 'user', text: msg })
    const aid = nextId()
    assistantRef.current = aid
    push({ id: aid, kind: 'assistant', text: '', streaming: true })

    const ac = new AbortController()
    abortRef.current = ac
    setStreaming(true)
    let sawTerminal = false // 收到 done 或 error 才算正常收场

    try {
      const res = await fetch(api.agentChatUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Actor-Source': 'ui' },
        body: JSON.stringify({
          session_id: sid ?? '', provider_id: providerId, model, workdir: dir,
          object_id: objectId ?? '', message: msg,
        }),
        signal: ac.signal,
      })
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '')
        throw new Error(`对话请求失败（HTTP ${res.status}）${detail ? `：${detail.slice(0, 200)}` : ''}`)
      }

      for await (const ev of streamSSE(res.body)) {
        switch (ev.type) {
          case 'delta': {
            // 工具卡之后的续写要新开一个气泡，否则正文会跳回卡片上方
            if (!assistantRef.current) {
              const id = nextId()
              assistantRef.current = id
              setItems((prev) => [...prev, { id, kind: 'assistant', text: ev.text, streaming: true }])
              break
            }
            const cur = assistantRef.current
            setItems((prev) => prev.map((x) => (x.id === cur ? { ...x, text: x.text + ev.text } : x)))
            break
          }
          case 'tool_call':
            sealAssistant()
            push({ id: nextId(), kind: 'tool_call', text: ev.args ?? '', toolName: ev.name, running: true })
            break
          case 'tool_result': {
            const card: ChatItem = {
              id: nextId(), kind: 'tool_result', text: ev.summary,
              toolName: ev.name, objectId: ev.object_id,
            }
            // 就地把「正在 X…」那一行换成结果卡，保持时间顺序又不留冗余行
            setItems((prev) => {
              const i = prev.findLastIndex((x) => x.kind === 'tool_call' && x.running && x.toolName === ev.name)
              if (i < 0) return [...prev, card]
              const next = prev.slice()
              next[i] = card
              return next
            })
            if (WRITE_TOOL.test(ev.name)) scheduleReload()
            break
          }
          case 'artifact':
            sealAssistant()
            push({ id: nextId(), kind: 'artifact', text: '', path: ev.path, size: ev.size })
            break
          case 'question':
            sealAssistant()
            // 用后端给的 q_… 当 item id：回答时要按它把这一张标成已答，
            // 而本地的 ag1/ag2 序号跟后端对不上。
            push({ id: ev.id, kind: 'question', text: ev.question, options: ev.options ?? [], multi: ev.multi })
            break
          case 'done':
            sawTerminal = true
            sealAssistant()
            if (ev.session_id && ev.session_id !== sid) { sid = ev.session_id; setSessionId(ev.session_id) }
            break
          case 'error':
            sawTerminal = true
            sealAssistant()
            push({ id: nextId(), kind: 'error', text: ev.message, retryable: true })
            setFailed(true)
            break
        }
      }
      sealAssistant()
      // 后端半路挂了 / 网络断了，TCP 一关流就「正常」结束了，读不到任何异常。
      // 只有靠「没见过 done 也没见过 error」才认得出来，否则界面会静默停在半句话上。
      if (!sawTerminal) {
        push({ id: nextId(), kind: 'error', text: '连接中断：数据流意外结束，没有收到完成信号。', retryable: true })
        setFailed(true)
      }
    } catch (e) {
      sealAssistant()
      if (ac.signal.aborted) {
        push({ id: nextId(), kind: 'error', text: '已停止生成。', retryable: true })
      } else {
        const why = e instanceof Error ? e.message : String(e)
        push({ id: nextId(), kind: 'error', text: `连接中断：${why}`, retryable: true })
        setFailed(true)
      }
    } finally {
      abortRef.current = null
      setStreaming(false)
      if (dir) rememberDir(dir)
      void refreshSessions()
      if (!providers.length) void backfillProviders()
    }
  }, [
    streaming, workdir, workdirCheck, checkWorkdir, sessionId, providerId, model, objectId,
    push, sealAssistant, scheduleReload, rememberDir, refreshSessions,
    providers.length, backfillProviders,
  ])

  /* ───────── 回答提问 ───────── */

  const submit = useCallback(async (qs: ChatItem[]) => {
    const text = answerText(qs)
    if (!text) return
    const ids = new Set(qs.map((q) => q.id))
    // 先标成已答再发：发出去之后这几张卡就不该还能点，
    // 点第二下等于把同一个答案再发一遍。
    setItems((prev) => prev.map((x) => (ids.has(x.id) ? { ...x, answered: true, picked: x.picked } : x)))
    await send(text)
  }, [send])

  const pickOption = useCallback((id: string, label: string) => {
    if (streaming) return
    const q = items.find((x) => x.id === id)
    if (!q || q.kind !== 'question' || q.answered) return

    const cur = q.picked ?? []
    const picked = q.multi
      ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label])
      : [label]

    const otherPending = items.some(
      (x) => x.kind === 'question' && !x.answered && x.id !== id,
    )
    // 一问一答是绝大多数情况，单选时点一下就发。让用户再点一次「回答」，
    // 等于为了迁就「模型一次问三个」这种少数情况，给多数情况加一次点击。
    if (!q.multi && !otherPending) {
      void submit([{ ...q, picked }])
      return
    }
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, picked } : x)))
  }, [items, streaming, submit])

  const submitAnswers = useCallback(() => {
    if (streaming) return
    const pending = items.filter((x) => x.kind === 'question' && !x.answered)
    // 一次问了好几个就要一起答：只答一半发回去，模型下一轮会为剩下的再问一遍，
    // 正是「答完一个又冒出一个」那种车轱辘。
    if (!pending.length || pending.some((q) => !q.picked?.length)) return
    void submit(pending)
  }, [items, streaming, submit])

  const stop = useCallback(() => { abortRef.current?.abort() }, [])
  const retry = useCallback(() => {
    if (!lastSent.current || streaming) return
    // 重试前把末尾的失败提示摘掉，免得越堆越长
    setItems((prev) => {
      let end = prev.length
      while (end > 0 && prev[end - 1].kind === 'error') end -= 1
      return end === prev.length ? prev : prev.slice(0, end)
    })
    void send(lastSent.current)
  }, [send, streaming])

  return {
    providers, providerId, setProvider, model,
    sessions, sessionId, openSession, removeSession,
    workdir, setWorkdir, workdirCheck, checkingWorkdir, checkWorkdir, recentDirs,
    items, streaming, send, stop, retry,
    pickOption, submitAnswers,
  }
}
