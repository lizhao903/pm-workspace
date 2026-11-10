// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 执行记录的纯函数：事件折成显示块、落库输出解析成显示块、状态显示、附加说明、用时。
import type { RunEvent, RunStatus, TaskRun } from '../../core/data'

// 工具卡片的状态：pending 执行中，unknown 是落库输出里看不出结果（被取消时最后一个调用）
export type ToolState = 'pending' | 'ok' | 'failed' | 'unknown'

// 要人确认的写操作（工作台 Agent，TSK-0460）：pending 在等，approved 已确认，rejected 已拒绝，timeout 等待超时按拒绝
export type ConfirmState = 'pending' | 'approved' | 'rejected' | 'timeout'

export type OutBlock =
  | { k: 'text'; text: string }
  | { k: 'tool'; id: string; name: string; detail: string; state: ToolState; error: string; summary?: string }
  | { k: 'confirm'; id: string; name: string; summary: string; deadline: string; state: ConfirmState }

// 会改文件或跑命令的工具，圆点标橙
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash'])
export const isWriteTool = (name: string) => WRITE_TOOLS.has(name)

// foldEvents 把流事件折成显示块：delta 连续拼成一段，tool 和 tool_result 按 id 配成一张卡片，
// confirm 是一张确认卡片、decision 改它的状态（工作台 Agent）。其余事件（start、artifact、error、done）由调用方处理。
export function foldEvents(events: readonly RunEvent[]): OutBlock[] {
  const out: OutBlock[] = []
  const byId = new Map<string, Extract<OutBlock, { k: 'tool' }>>()
  const asks = new Map<string, Extract<OutBlock, { k: 'confirm' }>>()
  for (const e of events) {
    if (e.type === 'confirm') {
      const b = { k: 'confirm' as const, id: e.id, name: e.name, summary: e.summary, deadline: e.deadline, state: 'pending' as ConfirmState }
      out.push(b)
      asks.set(e.id, b)
      continue
    }
    if (e.type === 'decision') {
      const b = asks.get(e.id)
      if (b) b.state = e.approved ? 'approved' : e.reason === 'timeout' ? 'timeout' : 'rejected'
      continue
    }
    if (e.type === 'delta') {
      const last = out[out.length - 1]
      if (last?.k === 'text') last.text += e.text
      else out.push({ k: 'text', text: e.text })
    } else if (e.type === 'tool') {
      const b = { k: 'tool' as const, id: e.id, name: e.name, detail: e.detail, state: 'pending' as ToolState, error: '' }
      out.push(b)
      byId.set(e.id, b)
    } else if (e.type === 'tool_result') {
      const b = byId.get(e.id)
      if (b) {
        b.state = e.ok ? 'ok' : 'failed'
        b.error = e.error
        if (e.summary && e.ok) b.summary = e.summary
      } else {
        // 没等到开始事件的结果也显示出来，免得失败被吞掉（拒绝了的确认也走这里）
        out.push({ k: 'tool', id: e.id, name: e.name, detail: '', state: e.ok ? 'ok' : 'failed', error: e.error, ...(e.summary && e.ok ? { summary: e.summary } : {}) })
      }
    }
  }
  return out
}

// 落库输出的格式见 internal/runner 的 render：正文原样，工具调用一行「[工具] 名 · 摘要」，
// 失败的结果一行「[工具失败] 名 · 原因」，成功的结果不写。
const TOOL_LINE = /^\[工具\] (.+?)(?: · (.*))?$/
const FAIL_LINE = /^\[工具失败\] (.*?)(?: · (.*))?$/
// 工作台 Agent 的执行另有确认的两行（internal/api 的 renderAgentEvent）：「[等待确认] 摘要」和随后的决定
const ASK_LINE = /^\[等待确认\] (.*)$/
const DECIDE: Record<string, ConfirmState> = { '[已确认]': 'approved', '[已拒绝]': 'rejected', '[等待超时，按拒绝处理]': 'timeout' }

// parseOutput 把落库输出解析成显示块。落库输出没有 id，失败行配给最近一个同名、还没配上的调用；
// 没有失败行的调用记成功。被取消、还在跑的记录，最后一个没配上的调用结果未知。
export function parseOutput(output: string, status: RunStatus): OutBlock[] {
  const out: OutBlock[] = []
  const tools: Extract<OutBlock, { k: 'tool' }>[] = []
  const failed = new Set<Extract<OutBlock, { k: 'tool' }>>()
  let text: string[] = []
  const flush = () => {
    const s = text.join('\n')
    if (s.trim()) out.push({ k: 'text', text: s.replace(/^\n+|\n+$/g, '') })
    text = []
  }
  let ask: Extract<OutBlock, { k: 'confirm' }> | null = null
  for (const line of output.split('\n')) {
    const a = ASK_LINE.exec(line)
    if (a) {
      flush()
      ask = { k: 'confirm', id: 'c' + out.length, name: '', summary: a[1], deadline: '', state: 'pending' }
      out.push(ask)
      continue
    }
    if (ask && DECIDE[line.trim()]) {
      ask.state = DECIDE[line.trim()]
      ask = null
      continue
    }
    const t = TOOL_LINE.exec(line)
    if (t) {
      flush()
      const b = { k: 'tool' as const, id: 'o' + tools.length, name: t[1], detail: t[2] ?? '', state: 'ok' as ToolState, error: '' }
      tools.push(b)
      out.push(b)
      continue
    }
    const f = FAIL_LINE.exec(line)
    if (f) {
      const b = [...tools].reverse().find((x) => x.name === f[1] && !failed.has(x))
      if (b) {
        failed.add(b)
        b.state = 'failed'
        b.error = f[2] ?? ''
        continue
      }
      flush()
      out.push({ k: 'tool', id: 'o' + tools.length, name: f[1], detail: '', state: 'failed', error: f[2] ?? '' })
      continue
    }
    text.push(line)
  }
  flush()
  const last = tools[tools.length - 1]
  if (last && !failed.has(last) && (status === 'canceled' || status === 'running' || status === 'pending')) last.state = 'unknown'
  return out
}

// 状态显示按 TaskRun.status，不看 exit_code（exit 0 也可能是失败，见契约「任务执行 runs」）。
// 执行状态是契约里的固定枚举，不在后端字典里，所以显示名写在这里。
export const RUN_STATUS: Record<RunStatus, { label: string; tone: 'run' | 'ok' | 'bad' | 'off' }> = {
  pending: { label: '等待中', tone: 'run' },
  running: { label: '运行中', tone: 'run' },
  waiting: { label: '等待确认', tone: 'run' },
  done: { label: '完成', tone: 'ok' },
  failed: { label: '失败', tone: 'bad' },
  canceled: { label: '已取消', tone: 'off' },
}

export function runStatusOf(status: string) {
  return RUN_STATUS[status as RunStatus] ?? { label: status, tone: 'off' as const }
}

// 行下面的说明：完成但有 error 是保留意见（灰），失败、取消是原因
export function runNote(r: Pick<TaskRun, 'status' | 'error'>): { text: string; tone: 'muted' | 'danger' } | null {
  const e = r.error.trim()
  if (!e || r.status === 'running' || r.status === 'pending' || r.status === 'waiting') return null
  if (r.status === 'done') return { text: '保留意见：' + e, tone: 'muted' }
  return { text: e, tone: r.status === 'failed' ? 'danger' : 'muted' }
}

/**
 * 被拒提示里的「建议放行：`规则`、`规则`。」（TSK-0499，后端 internal/runner denialReason 固定的格式），
 * 取出规则给「去设置放行」用；没有这一句回空数组
 */
export function allowRulesOf(error: string): string[] {
  const i = error.indexOf('建议放行：')
  if (i < 0) return []
  const tail = error.slice(i + '建议放行：'.length)
  const end = tail.indexOf('。')
  const part = end < 0 ? tail : tail.slice(0, end)
  const out: string[] = []
  for (const m of part.matchAll(/`([^`]+)`/g)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

/** 去设置「执行权限」并预填这些规则的地址 */
export function allowRulesLink(rules: readonly string[]): string {
  return '/settings/run-permissions?add=' + encodeURIComponent(rules.join('\n'))
}

// 附加说明在提示词的「本次执行的补充要求」一节（internal/runner 的 promptTemplate；交给工作台 Agent 的 agentPromptTemplate 后面接「怎么做」）
export function extraOf(prompt: string): string {
  const m = /## 本次执行的补充要求\n([\s\S]*?)\n\n## (?:约束|怎么做)/.exec(prompt)
  return m ? m[1].trim() : ''
}

export function duration(from: string, to: string | null, now: Date = new Date()): string {
  const s = Math.max(0, Math.round(((to ? new Date(to).getTime() : now.getTime()) - new Date(from).getTime()) / 1000))
  if (s < 60) return `${s} 秒`
  if (s < 3600) return `${Math.round(s / 60)} 分钟`
  return `${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分钟`
}

/** 执行器的名字（0049、TSK-0460）；老记录没有 harness 按 Claude Code 算 */
export function harnessLabel(h: TaskRun['harness']): string {
  if (h === 'agent') return '工作台 Agent'
  if (h === 'deepseek') return 'DeepSeek'
  return 'Claude Code'
}

/** 工作台 Agent 执行用的会话 id，「打开会话继续」用；别的执行器没有 */
export function agentSessionOf(r: Pick<TaskRun, 'harness' | 'harness_session'>): string {
  return r.harness === 'agent' ? (r.harness_session ?? '').trim() : ''
}

/** 确认卡片的状态说明；pending 时写到什么时候按拒绝处理 */
export function confirmStateText(state: ConfirmState, deadline: string, now: Date = new Date()): string {
  if (state === 'approved') return '已确认，执行了'
  if (state === 'rejected') return '已拒绝，没有执行'
  if (state === 'timeout') return '等待超时，按拒绝处理'
  if (!deadline) return '等你确认'
  const d = new Date(deadline)
  if (Number.isNaN(d.getTime())) return '等你确认'
  const mins = Math.max(0, Math.ceil((d.getTime() - now.getTime()) / 60000))
  return `等你确认，${mins} 分钟内没确认按拒绝处理`
}

/** 执行方式的名字（0048）；老记录没有 mode 按流式算 */
export function modeLabel(mode: TaskRun['mode'] | undefined): string {
  return mode === 'terminal' ? '终端' : '流式'
}

/** 终端执行「标记结束」的结果选项 */
export const FINISH_OPTIONS: { value: 'done' | 'failed' | 'canceled'; label: string }[] = [
  { value: 'done', label: '完成' },
  { value: 'failed', label: '失败' },
  { value: 'canceled', label: '取消' },
]
