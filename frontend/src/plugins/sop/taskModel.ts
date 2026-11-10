// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 任务详情里的 SOP（SOP-06）：发起时把任务的字段预填进流程开始节点的输入，执行行的进度文字。纯函数，测试在 taskModel.test.ts
import { PROP_ACCEPTANCE, type SopField, type SopFlow, type SopJson, type SopRunBrief, type WorkObject } from '../../core/data'
import { isFinished, needsMe } from './model'

/** 任务的一项能填进哪些输入字段：key 精确匹配（不分大小写），或字段名含这些词 */
type Slot = 'title' | 'body' | 'owner' | 'priority' | 'due' | 'ref' | 'status' | 'project' | 'acceptance' | 'id'
const SLOTS: { slot: Slot; keys: string[]; words: string[] }[] = [
  { slot: 'id', keys: ['task_id', 'object_id'], words: [] },
  // ref 这个 key 常是「参考链接」，不按 key 认，只认 task_ref 和字段名里的「编号」
  { slot: 'ref', keys: ['task_ref'], words: ['编号'] },
  { slot: 'acceptance', keys: ['acceptance', 'criteria'], words: ['验收'] },
  { slot: 'owner', keys: ['owner', 'owner_name', 'assignee'], words: ['负责人', '处理人', '指派'] },
  { slot: 'priority', keys: ['priority', 'prio'], words: ['优先级'] },
  { slot: 'due', keys: ['due', 'due_at', 'due_date', 'deadline'], words: ['截止', '到期', '期限'] },
  { slot: 'status', keys: ['status', 'state'], words: ['状态'] },
  { slot: 'project', keys: ['project', 'project_name', 'project_title'], words: ['项目'] },
  { slot: 'title', keys: ['title', 'subject', 'topic', 'name', 'task', 'summary'], words: ['标题', '主题', '名称', '事项', '任务'] },
  { slot: 'body', keys: ['body', 'content', 'desc', 'description', 'detail', 'details', 'text', 'note', 'notes', 'requirement'],
    words: ['正文', '内容', '描述', '说明', '详情', '需求', '背景'] },
]

function slotOf(f: SopField): Slot | null {
  const k = f.key.toLowerCase()
  const byKey = SLOTS.find((s) => s.keys.includes(k))
  if (byKey) return byKey.slot
  return SLOTS.find((s) => s.words.some((w) => f.label.includes(w)))?.slot ?? null
}

const pad = (n: number) => String(n).padStart(2, '0')
/** 截止时间：本地时间，零点只写日期 */
export function dueText(iso: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return d.getHours() || d.getMinutes() ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}` : day
}

function taskValue(slot: Slot, t: WorkObject, statusLabel?: (key: string) => string | undefined): string {
  switch (slot) {
    case 'id': return t.id
    case 'ref': return t.ref
    case 'title': return t.title
    case 'body': return t.body
    case 'owner': return t.owner_name ?? t.owner ?? ''
    case 'priority': return t.priority
    case 'due': return dueText(t.due_at)
    case 'status': return statusLabel?.(t.status) ?? t.status
    case 'project': return t.project_title ?? ''
    case 'acceptance': return typeof t.props?.[PROP_ACCEPTANCE] === 'string' ? (t.props[PROP_ACCEPTANCE] as string) : ''
  }
}

/** 下拉字段只认选项里有的值（按值或显示名）；对不上返回空串，留默认 */
function fit(f: SopField, v: string) {
  if (f.type !== 'select') return v
  const o = (f.options ?? []).find((x) => x.value === v || x.label === v)
  return o ? o.value : ''
}

/**
 * 在任务上执行 SOP 时的预填：按开始节点输入字段的 key 和名字认出标题、正文、负责人、优先级、截止时间、编号、状态、所属项目、验收标准；
 * 每项只填第一个认出的字段，任务上是空的不填（留流程默认值）。
 * 正文没对上字段时填进第一个没被占的多行文本；标题没对上字段时并进正文那一格的开头，免得发起后看不出是哪条任务。
 */
export function taskPrefill(flow: Pick<SopFlow, 'fields'>, task: WorkObject, statusLabel?: (key: string) => string | undefined): SopJson {
  const out: SopJson = {}
  const used = new Set<Slot>()
  let bodyField: SopField | undefined
  for (const f of flow.fields) {
    const s = slotOf(f)
    if (!s || used.has(s)) continue
    used.add(s)
    if (s === 'body') bodyField = f
    const v = fit(f, taskValue(s, task, statusLabel))
    if (v) out[f.key] = v
  }
  if (!bodyField) {
    bodyField = flow.fields.find((f) => f.type === 'textarea' && !(f.key in out) && !slotOf(f))
    if (bodyField && task.body) out[bodyField.key] = task.body
  }
  if (!used.has('title') && bodyField && task.title) {
    const b = typeof out[bodyField.key] === 'string' ? (out[bodyField.key] as string) : ''
    out[bodyField.key] = b ? `${task.title}\n\n${b}` : task.title
  }
  return out
}

/**
 * 任务详情里执行行的进度：全部完成「N 步全部完成」；其余「已完成/共 N 步」加上停在哪一步——
 * 等人处理的写「停在「步骤名」」，失败的写「「步骤名」失败」，执行中的写「正在「步骤名」」；没走的分支不算步数
 */
export function objectRunProgress(r: SopRunBrief) {
  const walked = r.steps.filter((x) => x.status !== 'bypassed')
  const doneN = walked.filter((x) => isFinished(x.status)).length
  if (r.status === 'done') return `${doneN} 步全部完成`
  const head = `${doneN}/${walked.length} 步`
  const s = r.steps[r.focus]
  if (!s || r.status === 'stopped') return head
  if (s.status === 'failed') return `${head} · 「${s.name}」失败`
  if (needsMe(s.status)) return `${head} · 停在「${s.name}」${s.status === 'paused' ? '确认输入' : '等你处理'}`
  if (s.status === 'running') return `${head} · 正在「${s.name}」`
  return head
}

/** 任务详情里只列顶层执行：子流程的执行收在父执行的运行页里；父执行不在列表里的子执行照样列出 */
export function topRuns<T extends Pick<SopRunBrief, 'id' | 'parent_run_id'>>(runs: readonly T[]): T[] {
  const ids = new Set(runs.map((r) => r.id))
  return runs.filter((r) => !r.parent_run_id || !ids.has(r.parent_run_id))
}

/** 任务详情地址上定位某次执行的参数：从运行页返回、别处跳过来都带它，宿主据此切到 SOP 标签 */
export const FOCUS_PARAM = 'sop_run'

/**
 * 去运行页后「返回」的地址：回到这条任务的 SOP 标签并定位到刚才那次执行。
 * back 是宿主给的 returnTo（含 ?t= 重新打开任务）或当前地址
 */
export function backToRun(back: string, runId: string): string {
  const i = back.indexOf('?')
  const path = i < 0 ? back : back.slice(0, i)
  const q = new URLSearchParams(i < 0 ? '' : back.slice(i + 1))
  q.set('tab', 'sop')
  q.set(FOCUS_PARAM, runId)
  return `${path}?${q.toString()}`
}

/** 要定位的执行落在哪一行：子流程的执行收在父执行那一行里 */
export function focusRow(runs: readonly Pick<SopRunBrief, 'id' | 'parent_run_id'>[], rows: readonly { id: string }[], focus: string | undefined): string | undefined {
  if (!focus) return undefined
  let cur = runs.find((r) => r.id === focus)
  const seen = new Set<string>()
  while (cur && !rows.some((r) => r.id === cur!.id) && cur.parent_run_id && !seen.has(cur.id)) {
    seen.add(cur.id)
    const pid: string = cur.parent_run_id
    cur = runs.find((r) => r.id === pid)
  }
  return cur && rows.some((r) => r.id === cur!.id) ? cur.id : undefined
}
