// 会话页的纯函数（AG-01a）：把落库的消息、流里的事件折成界面上的一条条消息，时间分段，提问的解析。
import type { AgentMessage, Artifact, ChatEvent, QuestionOption } from '../../core/data'

/** 新建会话的标题；第一句话发出后改成它的前 20 个字（SPEC-sessions-1.16） */
export const NEW_TITLE = '新会话'
const TITLE_LEN = 20

export function titleFrom(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? ''
  return [...line].slice(0, TITLE_LEN).join('') || NEW_TITLE
}

// 工具的显示名；没列到的照原名显示。write 为真的是写操作，卡片圆点着色
const TOOLS: Record<string, { label: string; write?: boolean }> = {
  search_objects: { label: '查工作对象' },
  get_object: { label: '读工作对象' },
  list_types: { label: '查对象类型' },
  create_object: { label: '新建工作对象', write: true },
  update_object: { label: '修改工作对象', write: true },
  write_file: { label: '写文件', write: true },
}
export const toolLabel = (name: string) => TOOLS[name]?.label ?? name
export const isWriteTool = (name: string) => !!TOOLS[name]?.write

export type CallState = 'running' | 'done'
export type CallView = { name: string; args: string; summary?: string; state: CallState }
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

/**
 * 落库的消息折成界面消息：tool 消息挂到它后面那条回复上（卡片在文字上面）；
 * 回复里的提问拆成问题卡。最后一组工具调用后面没有回复（对话中途失败）时单独成一条。
 */
export function foldHistory(msgs: readonly AgentMessage[]): ChatMsgView[] {
  const out: ChatMsgView[] = []
  let calls: CallView[] = []
  let firstCall = ''
  const flush = () => {
    if (!calls.length) return
    out.push({ id: firstCall, role: 'agent', text: '', calls })
    calls = []
  }
  for (const m of msgs) {
    if (m.role === 'tool') {
      if (!calls.length) firstCall = m.id
      calls.push({ name: m.tool_name || '工具', args: m.tool_args ?? '', summary: m.content, state: 'done' })
      continue
    }
    if (m.role === 'user') {
      flush()
      out.push({ id: m.id, role: 'user', text: m.content, calls: [], at: m.created_at })
      continue
    }
    const q = parseQuestion(m.content)
    out.push({ id: m.id, role: 'agent', text: q ? q.text : m.content, calls, question: q?.question, at: m.created_at })
    calls = []
  }
  flush()
  return out
}

/** 流里的事件折成正在回复的那条：工具调用和结果按名字依次配对 */
export function foldLive(events: readonly ChatEvent[]): ChatMsgView & { error?: string } {
  const msg: ChatMsgView & { error?: string } = { id: 'live', role: 'agent', text: '', calls: [] }
  for (const e of events) {
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
