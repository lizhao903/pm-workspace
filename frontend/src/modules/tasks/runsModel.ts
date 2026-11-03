// 执行记录的纯函数：事件折成显示块、落库输出解析成显示块、状态显示、附加说明、用时。
import type { RunEvent, RunStatus, TaskRun } from '../../core/data'

// 工具卡片的状态：pending 执行中，unknown 是落库输出里看不出结果（被取消时最后一个调用）
export type ToolState = 'pending' | 'ok' | 'failed' | 'unknown'

export type OutBlock =
  | { k: 'text'; text: string }
  | { k: 'tool'; id: string; name: string; detail: string; state: ToolState; error: string }

// 会改文件或跑命令的工具，圆点标橙
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash'])
export const isWriteTool = (name: string) => WRITE_TOOLS.has(name)

// foldEvents 把流事件折成显示块：delta 连续拼成一段，tool 和 tool_result 按 id 配成一张卡片。
// 只看 delta、tool、tool_result，其余事件（start、artifact、error、done）由调用方处理。
export function foldEvents(events: readonly RunEvent[]): OutBlock[] {
  const out: OutBlock[] = []
  const byId = new Map<string, Extract<OutBlock, { k: 'tool' }>>()
  for (const e of events) {
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
      } else {
        // 没等到开始事件的结果也显示出来，免得失败被吞掉
        out.push({ k: 'tool', id: e.id, name: e.name, detail: '', state: e.ok ? 'ok' : 'failed', error: e.error })
      }
    }
  }
  return out
}

// 落库输出的格式见 internal/runner 的 render：正文原样，工具调用一行「[工具] 名 · 摘要」，
// 失败的结果一行「[工具失败] 名 · 原因」，成功的结果不写。
const TOOL_LINE = /^\[工具\] (.+?)(?: · (.*))?$/
const FAIL_LINE = /^\[工具失败\] (.*?)(?: · (.*))?$/

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
  for (const line of output.split('\n')) {
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
  if (!e || r.status === 'running' || r.status === 'pending') return null
  if (r.status === 'done') return { text: '保留意见：' + e, tone: 'muted' }
  return { text: e, tone: r.status === 'failed' ? 'danger' : 'muted' }
}

// 附加说明在提示词的「本次执行的补充要求」一节（internal/runner 的 promptTemplate）
export function extraOf(prompt: string): string {
  const m = /## 本次执行的补充要求\n([\s\S]*?)\n\n## 约束/.exec(prompt)
  return m ? m[1].trim() : ''
}

export function duration(from: string, to: string | null, now: Date = new Date()): string {
  const s = Math.max(0, Math.round(((to ? new Date(to).getTime() : now.getTime()) - new Date(from).getTime()) / 1000))
  if (s < 60) return `${s} 秒`
  if (s < 3600) return `${Math.round(s / 60)} 分钟`
  return `${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分钟`
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
