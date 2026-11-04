// 会话页的纯函数（AG-01a）：把落库的消息、流里的事件折成界面上的一条条消息，时间分段，提问的解析。
import type { Agent, AgentMessage, AgentProvider, AgentSession, Artifact, ChatEvent, QuestionOption } from '../data'

/** 新建会话的标题；第一句话发出后改成它的前 20 个字（SPEC-sessions-1.16） */
export const NEW_TITLE = '新会话'
const TITLE_LEN = 20

export function titleFrom(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? ''
  return [...line].slice(0, TITLE_LEN).join('') || NEW_TITLE
}

// 工具的显示名；没列到的照原名显示。write 为真的是写操作，卡片圆点着色。
// ability 是它归哪项授权（契约「Agent 工具授权」的内置工具表），权限没开时提示要开哪一项
const TOOLS: Record<string, { label: string; write?: boolean; ability?: string }> = {
  search_objects: { label: '查工作对象', ability: '查任务' },
  get_object: { label: '读工作对象', ability: '查任务' },
  list_types: { label: '查对象类型' },
  create_object: { label: '新建工作对象', write: true, ability: '新建 / 更新任务' },
  update_object: { label: '修改工作对象', write: true, ability: '新建 / 更新任务' },
  write_file: { label: '写文件', write: true, ability: '写文档' },
  kb_search: { label: '查知识库', ability: '读文档' },
}
export const toolLabel = (name: string) => TOOLS[name]?.label ?? name
export const isWriteTool = (name: string) => !!TOOLS[name]?.write
/** 权限没开时要开的那一项：内置工具是能力名，连接器工具照原名 */
export const toolAbility = (name: string) => TOOLS[name]?.ability ?? name

/** running 执行中、done 已执行；执行记录里要人确认的还有 pending 等你确认、confirmed 已确认执行、rejected 已拒绝 */
export type CallState = 'running' | 'done' | 'pending' | 'confirmed' | 'rejected'
export type CallView = {
  name: string
  args: string
  summary?: string
  state: CallState
  /** 要人确认的调用 id（atc_） */
  id?: string
  /** 是要人确认的那种（历史里「等待确认：」那条），配 id 时按顺序数它 */
  asked?: boolean
  /** 历史里这次调用对应的原始消息 id（等确认的那条加确认后的结果那条），移除气泡时一起删 */
  msgIds?: string[]
}
export type QuestionView = { id?: string; question: string; options: QuestionOption[]; multi: boolean }
export type ChatMsgView = {
  id: string
  role: 'user' | 'agent'
  text: string
  calls: CallView[]
  question?: QuestionView
  /** 流里写出的文件（相对产物目录） */
  files?: { path: string; size: number }[]
  at?: string
}

// 后端落库时把提问拼成这段文字（internal/agent 的 renderQuestion）：
//   【需要你确认】问题（可多选）
//   - 选项：说明
const Q_MARK = '【需要你确认】'
const Q_MULTI = '（可多选）'

/** 从落库的回复里拆出提问；没有提问返回 null。text 是提问之前的正文 */
export function parseQuestion(content: string): { text: string; question: QuestionView } | null {
  const at = content.lastIndexOf(Q_MARK)
  if (at < 0) return null
  const lines = content.slice(at + Q_MARK.length).split('\n')
  let head = (lines.shift() ?? '').trim()
  const multi = head.endsWith(Q_MULTI)
  if (multi) head = head.slice(0, -Q_MULTI.length).trim()
  const options: QuestionOption[] = []
  for (const l of lines) {
    const m = /^- (.*)$/.exec(l.trim())
    if (!m) continue
    const i = m[1].indexOf('：')
    options.push(i < 0 ? { label: m[1].trim(), detail: '' } : { label: m[1].slice(0, i).trim(), detail: m[1].slice(i + 1).trim() })
  }
  if (!head || !options.length) return null
  return { text: content.slice(0, at).trim(), question: { question: head, options, multi } }
}

// 要人确认的调用（AG-02a）：后端先记一条「等待确认：…」的 tool 消息，回复里并进一行「【等你确认】…」；
// 确认、拒绝后再记一条同名同参数的 tool 消息，拒绝的以「用户拒绝了：」开头
export const WAIT_MARK = '等待确认：'
const REJECT_MARK = '用户拒绝了：'
const CONFIRM_LINE = /^【等你确认】.*$\n?/gm

/** 参数比较用：去掉空白差异，空的按 {}（后端 defaultArgs） */
export function normArgs(args: string | undefined): string {
  const t = (args ?? '').trim()
  if (!t) return '{}'
  try {
    return JSON.stringify(JSON.parse(t))
  } catch {
    return t
  }
}

/**
 * 落库的消息折成界面消息：tool 消息挂到它后面那条回复上（卡片在文字上面）；
 * 回复里的提问拆成问题卡。最后一组工具调用后面没有回复（对话中途失败）时单独成一条。
 * 「等待确认：」的是等你确认的卡片；后面同名同参数的结果合回这张卡片（已确认执行、已拒绝），不另起一张；
 * 回复里的「【等你确认】」那行有卡片了，不再重复显示。
 */
/**
 * 一个历史气泡对应的原始消息 id（SPEC-sessions-1.43「移除」用）：用户的那一条；Agent 的是回复那条加上面挂的工具调用
 * （等确认的连同确认后的结果）。只有工具调用、没有回复的气泡 id 取第一条调用，不算回复
 */
export function bubbleIds(v: ChatMsgView): string[] {
  const ids = new Set<string>()
  if (v.role === 'user' || v.text || v.question) ids.add(v.id)
  for (const c of v.calls) for (const id of c.msgIds ?? []) ids.add(id)
  if (!ids.size && v.id) ids.add(v.id)
  return [...ids]
}

export function foldHistory(msgs: readonly AgentMessage[]): ChatMsgView[] {
  const out: ChatMsgView[] = []
  let calls: CallView[] = []
  let firstCall = ''
  const waiting: CallView[] = []
  const flush = () => {
    if (!calls.length) return
    out.push({ id: firstCall, role: 'agent', text: '', calls })
    calls = []
  }
  for (const m of msgs) {
    if (m.role === 'tool') {
      const name = m.tool_name || '工具'
      const args = m.tool_args ?? ''
      if (m.content.startsWith(WAIT_MARK)) {
        const c: CallView = { name, args, state: 'pending', asked: true, msgIds: [m.id] }
        waiting.push(c)
        if (!calls.length) firstCall = m.id
        calls.push(c)
        continue
      }
      const i = waiting.findIndex((w) => w.name === name && normArgs(w.args) === normArgs(args))
      if (i >= 0) {
        const w = waiting.splice(i, 1)[0]
        w.state = m.content.startsWith(REJECT_MARK) ? 'rejected' : 'confirmed'
        w.summary = m.content
        w.msgIds = [...(w.msgIds ?? []), m.id]
        continue
      }
      if (!calls.length) firstCall = m.id
      calls.push({ name, args, summary: m.content, state: 'done', msgIds: [m.id] })
      continue
    }
    if (m.role === 'user') {
      flush()
      out.push({ id: m.id, role: 'user', text: m.content, calls: [], at: m.created_at })
      continue
    }
    const content = m.content.replace(CONFIRM_LINE, '').trim()
    const q = parseQuestion(content)
    out.push({ id: m.id, role: 'agent', text: q ? q.text : content, calls, question: q?.question, at: m.created_at })
    calls = []
  }
  flush()
  return out
}

/**
 * 流里的事件折成正在回复的那条：工具调用和结果按名字依次配对。
 * decision 为真时是确认、拒绝后接着跑的这一轮：第一对 tool_call / tool_result 是那次调用本身，结果写回原卡片，这里不再列。
 */
export function foldLive(events: readonly ChatEvent[], decision = false): ChatMsgView & { error?: string } {
  const msg: ChatMsgView & { error?: string } = { id: 'live', role: 'agent', text: '', calls: [] }
  let skip = decision
  for (const e of events) {
    if (skip && (e.type === 'tool_call' || e.type === 'tool_result')) {
      if (e.type === 'tool_result') skip = false
      continue
    }
    switch (e.type) {
      case 'delta':
        msg.text += e.text
        break
      case 'tool_call':
        msg.calls = [...msg.calls, { name: e.name, args: e.args, state: 'running' }]
        break
      case 'tool_result': {
        const i = msg.calls.findIndex((c) => c.state === 'running' && c.name === e.name)
        if (i >= 0) msg.calls = msg.calls.map((c, j) => (j === i ? { ...c, summary: e.summary, state: 'done' } : c))
        else msg.calls = [...msg.calls, { name: e.name, args: '', summary: e.summary, state: 'done' }]
        break
      }
      case 'artifact':
        msg.files = [...(msg.files ?? []), { path: e.path, size: e.size }]
        break
      case 'question':
        msg.question = { id: e.id, question: e.question, options: e.options, multi: e.multi }
        break
      case 'confirm':
        msg.calls = [...msg.calls, { name: e.name, args: e.args, state: 'pending', id: e.id }]
        break
      case 'error':
        msg.error = e.message
        break
    }
  }
  // 提问的文字后端也会拼进正文，这里不用；流里只有 delta 正文
  return msg
}

/** 工具参数按 JSON 美化，不是 JSON 就原样 */
export function prettyArgs(args: string): string {
  if (!args.trim()) return ''
  try {
    return JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    return args
  }
}

export type WhenGroup = '今天' | '本周' | '更早'

/** 更新时间分段：今天 / 本周（从周一算）/ 更早，按本地时区 */
export function whenGroup(iso: string, now: Date = new Date()): WhenGroup {
  const t = new Date(iso).getTime()
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (t >= day0) return '今天'
  const week0 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)).getTime()
  return t >= week0 ? '本周' : '更早'
}

/** 相对时间，和任务模块的写法一致 */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const m = Math.round((now.getTime() - new Date(iso).getTime()) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  if (m < 1440) return `${Math.floor(m / 60)} 小时前`
  if (m < 2880) return '昨天'
  return `${Math.floor(m / 1440)} 天前`
}

/** 回答提问发出去的那句话：单选就是选项名，多选用顿号连起来 */
export const answerText = (labels: string[]) => labels.join('、')

/** 空会话里的示例问题（SPEC-sessions-1.19）；原型那句回 IM 消息的现有工具做不了，换成查需求 */
export const CHAT_EXAMPLES = ['我现在有哪些任务最急？', '建一条任务：周五前整理演示环境', '最近有哪些需求还没开始？', '这周的周报帮我汇总一下']

/** 产出物的类型：备注开头的 [commit] / [branch] / [pr] 标记（契约「代码类产物」），否则按有没有链接分 */
export const KIND_LABEL = { file: '文件', link: '链接', commit: '提交', branch: '分支', pr: 'PR' } as const
export type ArtifactKind = keyof typeof KIND_LABEL

export function artifactKind(a: Pick<Artifact, 'note' | 'url'>): ArtifactKind {
  const m = /^\[(commit|branch|pr)\]/.exec(a.note)
  if (m) return m[1] as ArtifactKind
  return a.url ? 'link' : 'file'
}

/** 服务商头像用的名字：名字里有英文词就取第一个（「本机 Ollama」显示 O），否则用名字，都没有用类型 */
export function avatarName(p: { name: string; kind: string } | undefined): string {
  if (!p) return '?'
  return /[A-Za-z][\w-]*/.exec(p.name)?.[0] ?? (p.name || p.kind)
}

/**
 * 会话在和谁聊（AG-01b8）：挂了 Agent 的按 Agent（停用的照样返回，只能回看）；Agent 删了是 gone；
 * Agent 列表还没取回是 pending（先不让发，也不显示成已删除）；不挂 Agent 的旧会话按服务商。
 */
export type ChatWho =
  | { kind: 'agent'; agent: Agent }
  | { kind: 'gone' }
  | { kind: 'pending' }
  | { kind: 'provider'; provider: AgentProvider | undefined }

export function whoOf(
  s: Pick<AgentSession, 'agent_id' | 'agent_deleted' | 'provider_id'>,
  agents: readonly Agent[] | undefined,
  providers: readonly AgentProvider[],
): ChatWho {
  if (!s.agent_id) return { kind: 'provider', provider: providers.find((p) => p.id === s.provider_id) }
  if (s.agent_deleted) return { kind: 'gone' }
  if (!agents) return { kind: 'pending' }
  const agent = agents.find((a) => a.id === s.agent_id)
  return agent ? { kind: 'agent', agent } : { kind: 'gone' }
}

export const GONE_AGENT = '已删除的 Agent'

/** 列表、头部显示的名字 */
export function whoName(w: ChatWho): string {
  switch (w.kind) {
    case 'agent': return w.agent.name || '未命名'
    case 'gone': return GONE_AGENT
    case 'pending': return 'Agent'
    case 'provider': return w.provider ? w.provider.name || '未命名' : '已删除的服务商'
  }
}

/** 能不能发消息；不能时 note 是输入框下面的提示（SPEC-sessions-1.26、1.27） */
export function whoUsable(w: ChatWho): { usable: boolean; note?: string } {
  switch (w.kind) {
    case 'agent': return w.agent.enabled ? { usable: true } : { usable: false, note: '这个 Agent 已停用，只能回看' }
    case 'gone': return { usable: false, note: '这个 Agent 已删除，只能回看' }
    case 'pending': return { usable: false }
    case 'provider':
      if (!w.provider) return { usable: false, note: '这个服务商已删除，只能回看' }
      return w.provider.enabled ? { usable: true } : { usable: false, note: '这个服务商已停用，只能回看' }
  }
}

/** 会话筛选的取值：Agent id，或者下面两个特殊值 */
export const FILTER_NO_AGENT = '-'
export const FILTER_GONE = '~gone'

/** 会话是否落在筛选里：空串全部；FILTER_NO_AGENT 是不挂 Agent 的；FILTER_GONE 是 Agent 已删除的 */
export function matchAgentFilter(s: Pick<AgentSession, 'agent_id' | 'agent_deleted'>, filter: string): boolean {
  if (!filter) return true
  if (filter === FILTER_NO_AGENT) return !s.agent_id
  if (filter === FILTER_GONE) return !!s.agent_id && !!s.agent_deleted
  return s.agent_id === filter && !s.agent_deleted
}

/** 新会话面板的 Agent 顺序：最近聊过的在前，没聊过的保持原顺序（SPEC-sessions-1.6） */
export function recentAgents(agents: readonly Agent[], sessions: readonly Pick<AgentSession, 'agent_id' | 'updated_at'>[]): Agent[] {
  const last = new Map<string, string>()
  for (const s of sessions) if (s.agent_id && (last.get(s.agent_id) ?? '') < s.updated_at) last.set(s.agent_id, s.updated_at)
  return [...agents].sort((a, b) => (last.get(b.id) ?? '').localeCompare(last.get(a.id) ?? ''))
}

/** 已知的要确认调用：confirm 事件里的，或者执行记录详情里的 */
export type CallRef = { id: string; name: string; args: string }
/** 点了确认、拒绝还没读回的：先换状态，结果来了写上 */
export type CallDecision = { approve: boolean; summary?: string }

/**
 * 历史里等你确认的卡片补上调用 id（按工具名和参数配对，从最近的往前配：已知的 id 总是最近提出的那些），
 * 点过确认、拒绝的先换状态。配不上 id 的（页面刷新过、不是执行记录的会话）保持等你确认，没有按钮。
 */
export function overlayCalls(views: readonly ChatMsgView[], refs: readonly CallRef[], decisions: Readonly<Record<string, CallDecision>>): ChatMsgView[] {
  const left = [...refs]
  const ids = new Map<CallView, string>()
  for (let i = views.length - 1; i >= 0; i--) {
    const cs = views[i].calls
    for (let j = cs.length - 1; j >= 0; j--) {
      const c = cs[j]
      if (!c.asked) continue
      // 已经处理过的也占掉它那个 id，前面同样的调用才配得对
      let k = -1
      for (let x = left.length - 1; x >= 0; x--) if (left[x].name === c.name && normArgs(left[x].args) === normArgs(c.args)) { k = x; break }
      if (k >= 0) ids.set(c, left.splice(k, 1)[0].id)
    }
  }
  if (!ids.size) return [...views]
  return views.map((v) => ({
    ...v,
    calls: v.calls.map((c) => {
      const id = ids.get(c)
      if (!id) return c
      const d = c.state === 'pending' ? decisions[id] : undefined
      if (!d) return { ...c, id }
      return { ...c, id, state: d.approve ? 'confirmed' : 'rejected', summary: d.summary ?? c.summary }
    }),
  }))
}

/** 会话旁边的浏览器最多列几个链接（SPEC-sessions-1.36） */
export const SESSION_LINK_LIMIT = 8
// 地址到空白、引号、尖括号、反引号、中文标点和汉字为止；末尾的英文标点、不成对的右括号另外去掉
const URL_RE = /https?:\/\/[^\s<>"'`　-〿（），：；！？一-鿿]+/gi

function trimUrl(raw: string): string {
  let u = raw.replace(/[.,;:!?*_~]+$/, '')
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
    while (u.endsWith(close) && u.split(open).length < u.split(close).length) u = u.slice(0, -1).replace(/[.,;:!?]+$/, '')
  }
  return u
}

/**
 * 会话里出现过的链接（SPEC-sessions-1.36）：Agent 回复和工具结果里的 http/https 地址，人说的话不算。
 * 新的在前，同一地址只留一次（忽略末尾斜杠），最多 limit 个
 */
export function sessionLinks(msgs: readonly Pick<AgentMessage, 'role' | 'content'>[], limit = SESSION_LINK_LIMIT): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (let i = msgs.length - 1; i >= 0 && out.length < limit; i--) {
    const m = msgs[i]
    if (m.role === 'user') continue
    const found = [...m.content.matchAll(URL_RE)].map((x) => trimUrl(x[0]))
    // 同一条消息里按出现顺序
    for (const u of found) {
      const key = u.replace(/\/+$/, '')
      if (!/^https?:\/\/[^/]+/i.test(u) || seen.has(key)) continue
      seen.add(key)
      out.push(u)
      if (out.length >= limit) break
    }
  }
  return out
}
