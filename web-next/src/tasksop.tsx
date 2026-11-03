// 任务详情里的「SOP 执行」（SOP-06，SPEC-sop-13）：关联到这条任务的执行（在这里发起的、Agent 处理任务时用 run_sop 发起的），
// 「执行 SOP」选流程后打开发起执行抽屉，按开始节点的输入字段从任务预填；点一行去 SOP 运行页，「返回」回到这条任务。
// 正式前端在 frontend/src/plugins/sop/ObjectRuns.tsx（经 core/plugin 的对象区块登记）
import { RUN_STATUS, sourceText, focusIndex, isFinished, needsMe, runStatus, type Json, type Sop, type SopField, type SopRun } from './sopflow'
import { SearchSelect } from './searchselect'
import type { Task } from './taskdata'
import { timeAgo } from './ui'

type Slot = 'title' | 'body' | 'owner' | 'priority' | 'due' | 'ref' | 'status' | 'acceptance' | 'id'
const SLOTS: { slot: Slot; keys: string[]; words: string[] }[] = [
  { slot: 'id', keys: ['task_id', 'object_id'], words: [] },
  { slot: 'ref', keys: ['task_ref'], words: ['编号'] },
  { slot: 'acceptance', keys: ['acceptance', 'criteria'], words: ['验收'] },
  { slot: 'owner', keys: ['owner', 'owner_name', 'assignee'], words: ['负责人', '处理人', '指派'] },
  { slot: 'priority', keys: ['priority', 'prio'], words: ['优先级'] },
  { slot: 'due', keys: ['due', 'due_at', 'due_date', 'deadline'], words: ['截止', '到期', '期限'] },
  { slot: 'status', keys: ['status', 'state'], words: ['状态'] },
  { slot: 'title', keys: ['title', 'subject', 'topic', 'name', 'task', 'summary'], words: ['标题', '主题', '名称', '事项', '任务'] },
  { slot: 'body', keys: ['body', 'content', 'desc', 'description', 'detail', 'details', 'text', 'note', 'notes', 'requirement'],
    words: ['正文', '内容', '描述', '说明', '详情', '需求', '背景'] },
]
const slotOf = (f: SopField): Slot | null =>
  SLOTS.find((s) => s.keys.includes(f.key.toLowerCase()))?.slot ?? SLOTS.find((s) => s.words.some((w) => f.label.includes(w)))?.slot ?? null

function taskValue(slot: Slot, t: Task): string {
  switch (slot) {
    case 'id': return t.id
    case 'ref': return t.ref
    case 'title': return t.title
    case 'body': return t.desc
    case 'owner': return t.assignee
    case 'priority': return t.priority
    case 'due': return t.due ?? ''
    case 'status': return t.status
    case 'acceptance': return t.acceptance ?? ''
  }
}

/** 同正式前端 taskModel.taskPrefill：每项只填第一个认出的字段；正文没对上时填进第一个没认出的多行文本，标题没对上时并进正文那一格开头 */
export function taskPrefill(sop: Sop, t: Task): Json {
  const out: Json = {}
  const used = new Set<Slot>()
  let bodyField: SopField | undefined
  for (const f of sop.fields) {
    const s = slotOf(f)
    if (!s || used.has(s)) continue
    used.add(s)
    if (s === 'body') bodyField = f
    let v = taskValue(s, t)
    if (f.type === 'select') v = f.options?.find((o) => o.value === v || o.label === v)?.value ?? ''
    if (v) out[f.key] = v
  }
  if (!bodyField) {
    bodyField = sop.fields.find((f) => f.type === 'textarea' && !(f.key in out) && !slotOf(f))
    if (bodyField && t.desc) out[bodyField.key] = t.desc
  }
  if (!used.has('title') && bodyField && t.title) {
    const b = typeof out[bodyField.key] === 'string' ? (out[bodyField.key] as string) : ''
    out[bodyField.key] = b ? `${t.title}\n\n${b}` : t.title
  }
  return out
}

/** 「已完成/共 N 步」加停在哪一步；全部完成「N 步全部完成」 */
export function objectRunProgress(r: SopRun) {
  const st = runStatus(r)
  const walked = r.steps.filter((x) => x.status !== 'bypassed')
  const doneN = walked.filter((x) => isFinished(x.status)).length
  if (st === 'done') return `${doneN} 步全部完成`
  const head = `${doneN}/${walked.length} 步`
  const i = focusIndex(r)
  const s = r.steps[i]
  const name = r.sop.steps[i]?.name ?? s?.key
  if (!s || st === 'stopped') return head
  if (s.status === 'failed') return `${head} · 「${name}」失败`
  if (needsMe(s.status)) return `${head} · 停在「${name}」${s.status === 'paused' ? '确认输入' : '等你处理'}`
  if (s.status === 'running') return `${head} · 正在「${name}」`
  return head
}

export function TaskSopBlock({ task, runs, sops, onStart, onOpenRun, focus }: {
  task: Task
  runs: SopRun[]
  sops: Sop[]
  onStart: (sopId: string) => void
  onOpenRun: (runId: string) => void
  /** 从运行页返回、别处跳过来时要定位的那次执行：高亮（SPEC-tasks-4.39） */
  focus?: string
}) {
  const mine = runs.filter((r) => r.object_id === task.id).sort((a, b) => b.started_at - a.started_at)
  return (
    <section className="dev-sec task-sop">
      <div className="task-sop-head">
        <span className="field-group-title">SOP 执行<span className="field-hint">在这里发起的、Agent 处理这条任务时发起的</span></span>
        <span className="spacer" />
        <SearchSelect value="" placeholder="执行 SOP" searchPlaceholder="搜流程名" align="end" active={false} aria-label="执行 SOP"
          options={sops.map((s) => ({ value: s.id, label: s.name, hint: `${s.steps.length} 步` }))} onChange={(id) => { if (id) onStart(id) }} />
      </div>
      {!mine.length && <div className="mount-empty">还没有执行过 SOP</div>}
      {mine.length > 0 && (
        <div className="task-sop-list">
          {mine.map((r) => {
            const st = RUN_STATUS[runStatus(r)]
            return (
              <button key={r.id} className={r.id === focus ? 'task-sop-run lit' : 'task-sop-run'} onClick={() => onOpenRun(r.id)} title="打开这次执行，逐步查看">
                <span className="task-sop-name">
                  <span className="ellipsis" title={r.title}>{r.sop.name}</span>
                  <span className="list-sub ellipsis">{[sourceText(r), objectRunProgress(r)].filter(Boolean).join(' · ')}</span>
                </span>
                <span className="steps-bar task-sop-bar">{r.steps.map((x) => <span key={x.key} className={`seg-${x.status}`} />)}</span>
                <span className="pill" style={{ '--c': st.color } as React.CSSProperties}><span className="pill-dot" />{st.label}</span>
                <span className="list-sub task-sop-at">{timeAgo(new Date(r.started_at).toISOString())}开始</span>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
