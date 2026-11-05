import { useEffect, useRef, useState } from 'react'
import './devloop.css'
import {
  ARTIFACT_GROUPS, PROGRESS_LABEL, agentAfterDecision, agentRunScript, parseArtifact, runScript, seedArtifacts, seedProgress, seedRuns, stepRun,
  type RunEvent, type RunHarness, type Task, type TaskArtifact, type TaskProgress, type TaskRun, type TaskStatus,
} from './taskdata'
import { useEnumView } from './enumdata'
import { useOpenUrl } from './openurl'
import { GrowArea, cls, timeAgo } from './ui'
import { buildPrompt, type HandoffMode, type ProjectContext } from './handoff'
import { useRunPresets, type RunPreset } from './runpresets'
import type { Agent } from './agentdata'
import type { ModelConf, Provider } from './modeldata'

// 开发任务闭环：交给 Claude Code 做，它领取、记进展、登记产出、提交验收；你在任务抽屉里验收通过或退回
// 时序见 web-next/docs/dev-plan.md 4.0，字段见 docs/api-contract.md 进展与领取、输出产物、任务执行

const newId = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const newSession = () => [8, 4, 4, 4, 12].map((n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')).join('-')
const actorLabel = (a: string) => (a === 'claude-code' ? 'Claude Code' : a)
const short = (sid: string) => sid.slice(0, 8)

/** 开发闭环的数据和操作；App 里调一次，结果传给任务抽屉、列表和今日 */
export function useDevLoop(patchTask: (id: string, p: Partial<Task>) => void) {
  const [progress, setProgress] = useState(seedProgress)
  const [artifacts, setArtifacts] = useState(seedArtifacts)
  const [runs, setRuns] = useState(seedRuns)
  const runsRef = useRef(runs)
  runsRef.current = runs
  const finishRef = useRef<(r: TaskRun) => void>(() => {})
  finishRef.current = (r) => {
    // 工作台 Agent 执行收尾（SPEC-tasks-5.35）：完成记结论、失败记原因，写成任务的一条进展
    if (r.harness === 'agent') {
      if (r.status !== 'done' && r.status !== 'failed') return
      const last = [...r.events].reverse().find((e) => e.type === 'delta')
      const text = last?.type === 'delta' ? last.text.replace(/^结论：/, '') : '（Agent 没有写结论）'
      const at = new Date().toISOString()
      setProgress((xs) => [...xs, {
        id: newId('pg'), task_id: r.task_id, kind: 'note', commits: [], files: [], actor_name: 'agent', session_id: r.agent_session ?? '', source: 'agent', at,
        text: r.status === 'done' ? `工作台 Agent「${r.agent_name ?? ''}」执行完成（执行记录 ${r.id.slice(-8)}）：\n\n${text}` : `工作台 Agent「${r.agent_name ?? ''}」执行失败（执行记录 ${r.id.slice(-8)}）：${r.error ?? ''}`,
      }])
      return
    }
    // 允许写入的执行做完，Claude Code 会经 MCP 回写进展和产出物
    if (!r.allow_writes || r.status !== 'done') return
    const files = r.events.flatMap((e) => (e.type === 'tool' && e.name === 'Edit' ? [e.detail] : []))
    const at = new Date().toISOString()
    setProgress((xs) => [...xs, { id: newId('pg'), task_id: r.task_id, kind: 'note', text: '执行完成：改了文件，测试通过。', commits: [], files, actor_name: 'claude-code', session_id: r.session_id, source: 'agent', at }])
    setArtifacts((xs) => [...xs, ...files.map((f) => ({ id: newId('af'), task_id: r.task_id, note: '执行时改动的文件', path: `${r.workdir}/${f}`, rel_path: f, source: 'run' as const, at }))])
  }
  // 只推进流式执行；终端执行等 MCP 回写或手动标记结束
  const running = runs.some((r) => r.status === 'running' && r.mode !== 'terminal')
  useEffect(() => {
    if (!running) return
    const h = window.setInterval(() => {
      const ending = runsRef.current.filter((r) => r.status === 'running' && r.mode !== 'terminal' && r.pending.length <= 1)
      setRuns((xs) => xs.map((r) => withDeadline(stepRun(r))))
      for (const r of ending) finishRef.current(stepRun(r))
    }, 450)
    return () => window.clearInterval(h)
  }, [running])

  // 工作台 Agent 停下等确认（SPEC-tasks-5.34）：到时间没人决定按拒绝处理
  const decide = (id: string, approved: boolean, reason: 'user' | 'timeout' = 'user') => {
    const r = runsRef.current.find((x) => x.id === id)
    if (!r || r.status !== 'waiting') return
    if (approved) patchTask(r.task_id, { status: 'review' })
    setRuns((xs) => xs.map((x) => (x.id === id && x.status === 'waiting'
      ? { ...x, status: 'running', pending: agentAfterDecision({ ref: x.task_ref ?? '' }, approved, reason) } : x)))
  }
  const decideRef = useRef(decide)
  decideRef.current = decide
  const waitKey = runs.filter((r) => r.status === 'waiting').map((r) => r.id).join(',')
  useEffect(() => {
    const hs = runsRef.current.filter((r) => r.status === 'waiting').map((r) => {
      const c = [...r.events].reverse().find((e) => e.type === 'confirm')
      const left = c?.type === 'confirm' && c.deadline ? new Date(c.deadline).getTime() - Date.now() : 0
      return window.setTimeout(() => decideRef.current(r.id, false, 'timeout'), Math.max(0, left))
    })
    return () => hs.forEach((h) => window.clearTimeout(h))
  }, [waitKey])

  const add = (task_id: string, p: Pick<TaskProgress, 'kind' | 'text'> & Partial<TaskProgress>) =>
    setProgress((xs) => [...xs, { id: newId('pg'), task_id, commits: [], files: [], actor_name: '我', source: 'ui', at: new Date().toISOString(), ...p }])

  return {
    progress, artifacts, runs, decide,
    /** 工作台 Agent 执行建好会话后记到执行记录上（正式产品 harness_session） */
    bindSession: (id: string, sid: string) => setRuns((xs) => xs.map((r) => (r.id === id ? { ...r, agent_session: sid } : r))),
    append: (task_id: string, text: string) => add(task_id, { kind: 'note', text }),
    /** 验收通过记 done；退回记 todo（退回到 doing 会被领取规则当成仍被占用，别的会话领不到） */
    review: (task_id: string, ok: boolean, comment: string) => {
      const status: TaskStatus = ok ? 'done' : 'todo'
      add(task_id, { kind: 'note', text: ok ? `验收通过${comment.trim() ? `：${comment.trim()}` : ''}` : `退回：${comment.trim()}`, status })
      patchTask(task_id, { status })
    },
    addArtifact: (task_id: string, a: Pick<TaskArtifact, 'note' | 'url' | 'path'>) =>
      setArtifacts((xs) => [...xs, { id: newId('af'), task_id, source: 'manual', at: new Date().toISOString(), ...a }]),
    /** 发起一次执行，返回执行 id。终端方式只记一条进行中的执行（开始时间 = 发起时），过程在终端里 */
    start: (task: Task, o: RunStart): string => {
      const sid = newSession()
      const id = newId('run')
      const at = new Date().toISOString()
      // 交出去就算开工（SPEC-tasks-6.17）：流式、终端都把任务改成进行中，已完成、已取消的不动
      if (task.status !== 'doing' && task.status !== 'done' && task.status !== 'cancelled') patchTask(task.id, { status: 'doing' })
      // 交给工作台 Agent（SPEC-tasks-6.20）：没有进程，不领取；要确认的写操作停下等
      if (o.harness === 'agent') {
        setRuns((xs) => [{
          id, task_id: task.id, task_ref: task.ref, status: 'running', harness: 'agent', mode: 'stream', session_id: sid, started_at: at, events: [],
          pending: agentRunScript(task, !!o.read_only, o.extra_prompt, !!o.resume), workdir: o.workdir, allow_writes: false, extra_prompt: o.extra_prompt,
          agent_id: o.agent_id, agent_name: o.agent_name, model: o.model, agent_session: o.agent_session, confirm_wait: o.confirm_wait ?? 10,
        }, ...xs])
        return id
      }
      if (o.mode === 'terminal') {
        setRuns((xs) => [{ id, task_id: task.id, status: 'running', session_id: sid, started_at: at, events: [], pending: [], ...o, allow_writes: false, mode: 'terminal' }, ...xs])
        return id
      }
      const files = progress.filter((p) => p.task_id === task.id).flatMap((p) => p.files)
      setRuns((xs) => [{ id, task_id: task.id, status: 'running', session_id: sid, started_at: at, events: [], pending: runScript(task, o.allow_writes, o.extra_prompt, files), ...o, mode: 'stream' }, ...xs])
      // 允许写入时 Claude Code 先领取任务
      if (o.allow_writes) {
        add(task.id, { kind: 'claim', text: '领取了任务', status: 'doing', actor_name: 'claude-code', session_id: sid, source: 'agent' })
        patchTask(task.id, { status: 'doing', assignee: 'Claude Code' })
      }
      return id
    },
    /** 终端执行收尾：终端里的 claude 经 MCP pmw_finish_run 回写，或者用户手动「标记结束」；已经结束的不再改 */
    finish: (id: string, status: 'done' | 'failed' | 'cancelled', summary: string) => setRuns((xs) => xs.map((r) => (r.id === id && r.status === 'running'
      ? { ...r, status, summary: summary.trim() || undefined, ended_at: new Date().toISOString() } : r))),
    // 等确认时取消：待确认的写操作一并拒掉（SPEC-tasks-5.34）
    cancel: (id: string) => setRuns((xs) => xs.map((r) => ((r.id === id && (r.status === 'running' || r.status === 'waiting')) ? { ...r, status: 'cancelled', pending: [], error: '已取消', ended_at: new Date().toISOString() } : r))),
  }
}
export type DevLoop = ReturnType<typeof useDevLoop>

/** RunDialog 交给工作台 Agent 要用的数据（SPEC-tasks-6.20 到 6.23） */
export interface AgentRunOptions {
  agents: Agent[]
  /** 场景「执行任务」选的，没有用第一个启用的 */
  defaultAgentId?: string
  providers: Provider[]
  models: ModelConf[]
  /** 这条任务上一次工作台 Agent 执行的会话；没有时「接着上次的会话」置灰 */
  lastSession?: { id: string; agent_id?: string; agent_name?: string }
}

/** 发起一次执行的参数；harness=agent 时后面几项才有用（SPEC-tasks-6.20 到 6.24） */
export interface RunStart {
  workdir: string; allow_writes: boolean; extra_prompt: string; mode?: HandoffMode; preset?: RunPreset
  harness?: RunHarness
  agent_id?: string; agent_name?: string; provider_id?: string; model?: string
  /** 只读角色：只给读的工具 */
  read_only?: boolean
  /** 接着上次的会话（resume_session），agent_session 是要续的那个 */
  resume?: boolean; agent_session?: string
  confirm_wait?: number
}

/** 刚停下等确认的执行补上截止时间（等待从这一刻算） */
function withDeadline(r: TaskRun): TaskRun {
  if (r.status !== 'waiting') return r
  const i = r.events.length - 1
  const e = r.events[i]
  if (e?.type !== 'confirm' || e.deadline) return r
  const events = [...r.events]
  events[i] = { ...e, deadline: new Date(Date.now() + (r.confirm_wait ?? 10) * 60000).toISOString() }
  return { ...r, events }
}

/** 算不算开发任务：填了开发字段，或者已经有进展、产出、执行记录 */
export const isDevTask = (t: Task, dev: DevLoop) => !!(t.acceptance || t.workdir || t.repo)
  || dev.progress.some((p) => p.task_id === t.id) || dev.runs.some((r) => r.task_id === t.id) || dev.artifacts.some((a) => a.task_id === t.id)

/** 验收标准 Markdown 清单拆成条目 */
const checklist = (md: string) => md.split('\n').map((l) => /^\s*-\s*\[( |x)\]\s*(.+)$/i.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => ({ done: m[1].toLowerCase() === 'x', text: m[2] }))

const closeIcon = <svg viewBox="0 0 16 16" width="12" height="12"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>

/* ---------- 待验收 ---------- */

export function ReviewBar({ task, progress, onReview }: { task: Task; progress: TaskProgress[]; onReview: (ok: boolean, comment: string) => void }) {
  const [mode, setMode] = useState<'' | 'pass' | 'back'>('')
  const [text, setText] = useState('')
  const [tried, setTried] = useState(false)
  const [ticks, setTicks] = useState<Set<number>>(new Set())
  const last = [...progress].reverse().find((p) => p.kind === 'review')
  const items = checklist(task.acceptance ?? '')
  const submit = () => {
    setTried(true)
    if (mode === 'back' && !text.trim()) return
    onReview(mode === 'pass', text)
  }
  return (
    <div className="dev-reviewbar">
      <div className="src-card-head">
        <span className="field-group-title">等你验收</span>
        <span className="muted">{last ? `${actorLabel(last.actor_name)}${last.session_id ? ` · 会话 ${short(last.session_id)}` : ''} · ${timeAgo(last.at)}提交` : '状态是待验收'}</span>
      </div>
      {last && <div className="dev-review-text pre-line">{last.text}</div>}
      {items.length > 0 && (
        <div className="dev-check-list">
          <span className="list-sub">对照验收标准（勾选只为自己核对，不保存）</span>
          {items.map((x, i) => (
            <label key={i} className="check"><input type="checkbox" checked={ticks.has(i)} onChange={() => setTicks((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n })} />{x.text}</label>
          ))}
        </div>
      )}
      {mode ? (
        <div className="dev-review-form">
          <textarea rows={3} value={text} autoFocus className={cls(tried && mode === 'back' && !text.trim() && 'bad')} onChange={(e) => setText(e.target.value)}
            placeholder={mode === 'pass' ? '意见（可选）' : '哪里没过、要怎么改，Claude Code 下次领取时会读到'} />
          {tried && mode === 'back' && !text.trim() && <span className="field-err">写一下退回原因</span>}
          <div className="act-row">
            <button className={cls('act', mode === 'pass' ? 'act-primary' : 'act-warn')} disabled={mode === 'back' && !text.trim()} onClick={submit}>{mode === 'pass' ? '确认验收通过' : '确认退回'}</button>
            <button className="act act-quiet" onClick={() => { setMode(''); setTried(false) }}>取消</button>
            <span className="list-sub">{mode === 'pass' ? '状态改为已完成，记一条「验收通过」的进展' : '状态回到待办，别的会话可以重新领取'}</span>
          </div>
        </div>
      ) : (
        <div className="act-row">
          <button className="act act-primary" onClick={() => setMode('pass')}>验收通过</button>
          <button className="act act-warn" onClick={() => setMode('back')}>退回</button>
        </div>
      )}
    </div>
  )
}

/** 列表、今日里点待验收任务的完成圆圈：先确认，等于验收通过 */
export function ApproveConfirm({ task, onApprove, onOpen, onClose }: { task: Task; onApprove: () => void; onOpen: () => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }} onClick={(e) => e.stopPropagation()}>
      <div className="qs dev-confirm" role="dialog" aria-label="验收通过">
        <div className="qs-head"><b>验收通过 {task.ref}？</b></div>
        <div className="list-sub">「{task.title}」会改为已完成，并记一条「验收通过」的进展。要写意见或退回，打开任务处理。</div>
        <div className="act-row dev-confirm-foot">
          <button className="act act-quiet" onClick={onClose}>取消</button>
          <span className="spacer" />
          <button className="act" onClick={onOpen}>打开任务</button>
          <button className="act act-primary" autoFocus onClick={onApprove}>验收通过</button>
        </div>
      </div>
    </div>
  )
}

/* ---------- 开发字段 ---------- */

export interface DevDraft { acceptance?: string; workdir?: string; repo?: string }

export function DevFields({ d, onChange, inheritDir, onRun, runningId, onShowRun }: {
  d: DevDraft; onChange: (p: DevDraft) => void
  /** 所属项目的根目录，任务没设工作目录时继承 */
  inheritDir?: string
  /** 只有已存在的任务能交给 Claude Code */
  onRun?: () => void
  runningId?: string
  /** 「查看运行中」：执行记录在另一个标签里，由抽屉切过去并定位（SPEC-tasks-4.39） */
  onShowRun?: (runId: string) => void
}) {
  const filled = !!(d.acceptance || d.workdir || d.repo)
  const [open, setOpen] = useState(filled || !!onRun)
  if (!open) return <button className="act act-quiet dev-open" onClick={() => setOpen(true)}>+ 开发信息：验收标准、工作目录，交给 Claude Code 做</button>
  return (
    <div className="field-group">
      <div className="mount-head">
        <span className="field-group-title">开发</span>
        <span className="spacer" />
        {onRun && (runningId
          ? <button className="act" onClick={() => (onShowRun ? onShowRun(runningId) : document.getElementById(`run-${runningId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))}><span className="proto-light pl-running" />查看运行中</button>
          : <button className="act act-primary" onClick={onRun}>交给 Claude Code</button>)}
      </div>
      <label className="field">
        <span className="field-label">验收标准</span>
        <GrowArea rows={4} className="mono-area" value={d.acceptance ?? ''} placeholder={'- [ ] 一条一行，写成能检查的样子'} onChange={(e) => onChange({ acceptance: e.target.value || undefined })} />
      </label>
      <div className="field-row">
        <label className="field">
          <span className="field-label">工作目录</span>
          <input className="mono-input" value={d.workdir ?? ''} placeholder={inheritDir ? `继承自项目：${inheritDir}` : '本机绝对路径'} onChange={(e) => onChange({ workdir: e.target.value || undefined })} />
          {!d.workdir && inheritDir && <span className="list-sub">没设时用所属项目的目录</span>}
        </label>
        <label className="field">
          <span className="field-label">关联仓库</span>
          <input className="mono-input" value={d.repo ?? ''} placeholder="远端地址或本机路径，只放一个" onChange={(e) => onChange({ repo: e.target.value || undefined })} />
        </label>
      </div>
    </div>
  )
}

/* ---------- 进展 ---------- */

/** 相邻、同一会话的进展归成一组；界面上的操作单独成组 */
function groupBySession(xs: TaskProgress[]) {
  const out: { sid?: string; actor: string; items: TaskProgress[] }[] = []
  for (const p of xs) {
    const g = out[out.length - 1]
    if (g && g.sid === p.session_id && g.actor === p.actor_name) g.items.push(p)
    else out.push({ sid: p.session_id, actor: p.actor_name, items: [p] })
  }
  return out
}

function SessionId({ sid }: { sid: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button className="dev-sid mono" title={`复制会话 id，可以 claude --resume ${sid} 接着做`} onClick={() => { navigator.clipboard?.writeText(sid); setCopied(true) }}>
      {copied ? `已复制，claude --resume ${short(sid)}…` : `会话 ${short(sid)}`}
    </button>
  )
}

export function ProgressBlock({ items, onAppend }: { items: TaskProgress[]; onAppend: (text: string) => void }) {
  const statusEnum = useEnumView('task_status')
  const [text, setText] = useState('')
  const xs = [...items].sort((a, b) => a.at.localeCompare(b.at))
  const groups = groupBySession(xs)
  const send = () => { if (text.trim()) { onAppend(text.trim()); setText('') } }
  return (
    <section className="dev-sec">
      <div className="field-group-title">进展<span className="field-hint">按会话分组，标出是 Claude Code 哪次会话写的</span></div>
      {!xs.length && <div className="mount-empty">还没有进展</div>}
      {groups.map((g, i) => (
        <div key={i} className={cls('dev-group', !g.sid && 'dev-group-ui')}>
          <div className="dev-group-head">
            <span className={cls('dev-who', g.actor === 'claude-code' && 'cc')}>{actorLabel(g.actor)}</span>
            {g.sid ? <SessionId sid={g.sid} /> : <span className="list-sub">界面操作</span>}
            <span className="spacer" />
            <span className="list-sub">{g.items.length > 1 ? `${timeAgo(g.items[0].at)} 到 ${timeAgo(g.items[g.items.length - 1].at)}` : timeAgo(g.items[0].at)}</span>
          </div>
          <div className="dev-timeline">
            {g.items.map((p) => (
              <div key={p.id} className={cls('dev-item', `dev-${p.kind}`)}>
                <span className="dev-dot" />
                <div className="dev-item-body">
                  <div className="dev-item-head">
                    <span className="dev-kind">{PROGRESS_LABEL[p.kind]}</span>
                    {p.status && <span className="list-sub">状态改为{statusEnum.label(p.status)}</span>}
                    <span className="spacer" />
                    <span className="list-sub">{timeAgo(p.at)}</span>
                  </div>
                  <div className="dev-text pre-line">{p.text}</div>
                  {(p.commits.length > 0 || p.files.length > 0) && (
                    <div className="tags">
                      {p.commits.map((c) => <span key={c} className="tag mono" title="提交">{c.slice(0, 7)}</span>)}
                      {p.files.map((f) => <span key={f} className="tag mono" title="文件">{f}</span>)}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="dev-append">
        <textarea rows={2} value={text} placeholder="追加一条进展" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() } }} />
        <button className="act" disabled={!text.trim()} onClick={send}>追加进展</button>
      </div>
    </section>
  )
}

/* ---------- 产出物 ---------- */

const SOURCE_LABEL: Record<TaskArtifact['source'], string> = { manual: '手动登记', agent: 'Agent', run: '执行扫描', mcp: 'MCP 回写' }

export function ArtifactsBlock({ items, onAdd }: { items: TaskArtifact[]; onAdd: (a: Pick<TaskArtifact, 'note' | 'url' | 'path'>) => void }) {
  const openUrl = useOpenUrl()
  const [adding, setAdding] = useState(false)
  const [loc, setLoc] = useState('')
  const [note, setNote] = useState('')
  const [copied, setCopied] = useState('')
  const parsed = items.map((a) => ({ a, p: parseArtifact(a.note) }))
  const groups = ARTIFACT_GROUPS.map((g) => ({ ...g, xs: parsed.filter((x) => x.p.kind === g.key) })).filter((g) => g.xs.length)
  const isUrl = /^https?:\/\//.test(loc.trim())
  const locBad = !!loc.trim() && !isUrl && !loc.trim().startsWith('/')
  const save = () => {
    if (!loc.trim() || locBad) return
    onAdd({ note: note.trim(), ...(isUrl ? { url: loc.trim() } : { path: loc.trim() }) })
    setLoc(''); setNote(''); setAdding(false)
  }
  return (
    <section className="dev-sec">
      <div className="mount-head">
        <div className="field-group-title">产出物<span className="field-hint">提交、分支、PR、文件</span></div>
        <span className="spacer" />
        {!adding && <button className="act act-quiet" onClick={() => setAdding(true)}>登记产出物</button>}
      </div>
      {!items.length && !adding && <div className="mount-empty">还没有产出物</div>}
      {groups.map((g) => (
        <div key={g.key} className="dev-art-group">
          <div className="ability-group-name">{g.label}<span className="seg-n"> {g.xs.length}</span></div>
          {g.xs.map(({ a, p }) => (
            <div key={a.id} className="dev-art">
              <span className="dev-art-main">
                {p.kind === 'commit' && <span className="mono dev-sha">{p.sha?.slice(0, 7)}</span>}
                {(p.kind === 'branch' || p.kind === 'pr' || (p.kind === 'commit' && p.branch)) && <span className="tag mono">{p.branch}</span>}
                {a.url
                  ? <a className="ellipsis dev-art-link" href={a.url} onClick={(e) => { e.preventDefault(); openUrl(a.url!, p.text || a.url) }}>{p.text || a.url}</a>
                  : <span className="ellipsis">{p.kind === 'file' ? (a.rel_path ?? a.path) : p.text}</span>}
                {p.kind === 'file' && p.text && <span className="list-sub ellipsis">{p.text}</span>}
              </span>
              <span className="src-tag">{SOURCE_LABEL[a.source]}</span>
              {a.path && !a.url && <button className="act act-quiet" title={a.path} onClick={() => { navigator.clipboard?.writeText(a.path!); setCopied(a.id) }}>{copied === a.id ? '已复制' : '复制路径'}</button>}
              <span className="list-sub dev-art-at">{timeAgo(a.at)}</span>
            </div>
          ))}
        </div>
      ))}
      {adding && (
        <div className="dev-append dev-art-form">
          <input className="mono-input" value={loc} autoFocus placeholder="链接或本机绝对路径" onChange={(e) => setLoc(e.target.value)} />
          <input value={note} placeholder="备注；提交写成 [commit] sha=… branch=…" onChange={(e) => setNote(e.target.value)} />
          {locBad && <span className="field-err">链接以 http 开头，路径要写绝对路径</span>}
          <div className="act-row">
            <button className="act act-primary" disabled={!loc.trim() || locBad} onClick={save}>登记</button>
            <button className="act act-quiet" onClick={() => { setAdding(false); setLoc(''); setNote('') }}>取消</button>
          </div>
        </div>
      )}
    </section>
  )
}

/* ---------- 执行记录 ---------- */

const RUN_STATUS: Record<TaskRun['status'], { label: string; tone: string }> = {
  running: { label: '运行中', tone: 'run' }, waiting: { label: '等待确认', tone: 'warn' }, done: { label: '完成', tone: 'ok' }, failed: { label: '失败', tone: 'bad' }, cancelled: { label: '已取消', tone: 'off' },
}
const dur = (a: string, b?: string) => {
  const s = Math.max(0, Math.round(((b ? new Date(b).getTime() : Date.now()) - new Date(a).getTime()) / 1000))
  return s < 60 ? `${s} 秒` : `${Math.round(s / 60)} 分钟`
}

type OutBlock = { k: 'text'; text: string }
  | { k: 'tool'; id: string; name: string; detail: string; ok?: boolean; error?: string; summary?: string }
  | { k: 'confirm'; id: string; name: string; summary: string; deadline: string; decided?: { approved: boolean; reason: 'user' | 'timeout' } }

const hhmm = (iso: string) => (iso ? new Date(iso).toTimeString().slice(0, 5) : '')

/**
 * 流式输出：正文连续拼，工具调用和结果按 id 配成一张卡片。
 * 工作台 Agent 的确认卡片（SPEC-tasks-5.34）：等着时有确认、拒绝和超时时间，决定后写「已确认 / 已拒绝 / 等待超时，按拒绝处理」
 */
export function RunOutput({ events, live, onDecide }: { events: RunEvent[]; live: boolean; onDecide?: (approved: boolean) => void }) {
  const blocks: OutBlock[] = []
  for (const e of events) {
    const last = blocks[blocks.length - 1]
    if (e.type === 'delta') { if (last?.k === 'text') last.text += e.text; else blocks.push({ k: 'text', text: e.text }) }
    else if (e.type === 'tool') blocks.push({ k: 'tool', id: e.id, name: e.name, detail: e.detail })
    else if (e.type === 'confirm') blocks.push({ k: 'confirm', id: e.id, name: e.name, summary: e.summary, deadline: e.deadline })
    else if (e.type === 'decision') { const c = blocks.find((b) => b.k === 'confirm' && b.id === e.id); if (c?.k === 'confirm') c.decided = { approved: e.approved, reason: e.reason } }
    else { const t = blocks.find((b) => b.k === 'tool' && b.id === e.id); if (t?.k === 'tool') { t.ok = e.ok; t.error = e.error; t.summary = e.summary } }
  }
  return (
    <div className="dev-out">
      {blocks.map((b, i) => b.k === 'text'
        ? <div key={i} className="dev-out-text pre-line">{b.text}</div>
        : b.k === 'confirm' ? (
          <div key={i} className="call-card dev-tool dev-confirm">
            <div className="call-head">
              <span className="call-dot write" />
              <span className="call-name">等你确认<span className="list-sub"> {b.summary}</span></span>
              <span className="call-state">{!b.decided ? '等待确认' : b.decided.approved ? '已确认' : b.decided.reason === 'timeout' ? '等待超时，按拒绝处理' : '已拒绝'}</span>
            </div>
            {!b.decided && (
              <div className="call-body act-row">
                <button className="act act-primary" disabled={!onDecide} onClick={() => onDecide?.(true)}>确认</button>
                <button className="act act-quiet" disabled={!onDecide} onClick={() => onDecide?.(false)}>拒绝</button>
                <span className="list-sub">{b.deadline ? `${hhmm(b.deadline)} 前没人决定按拒绝处理` : ''}；在会话里点也一样</span>
              </div>
            )}
          </div>
        ) : (
          <div key={i} className={cls('call-card dev-tool', b.ok === false && 'dev-tool-bad')}>
            <div className="call-head">
              <span className={cls('call-dot', ['Edit', 'Write', 'Bash'].includes(b.name) && 'write')} />
              <span className="call-name">{b.name}<span className="mono list-sub"> {b.detail}</span></span>
              <span className="call-state">{b.ok === undefined ? '执行中' : b.ok ? '成功' : '失败'}</span>
            </div>
            {b.error && <div className="call-body"><span className="danger-text">{b.error}</span></div>}
            {!b.error && b.summary && <div className="call-body list-sub">{b.summary}</div>}
          </div>
        ))}
      {live && <span className="dev-caret" aria-label="输出中" />}
    </div>
  )
}

const FINISH_OPTS: { key: 'done' | 'failed' | 'cancelled'; label: string }[] = [
  { key: 'done', label: '完成' }, { key: 'failed', label: '失败' }, { key: 'cancelled', label: '取消' },
]

/** 终端执行的兜底收尾：选结果、写结论摘要（可空） */
function FinishRunDialog({ onFinish, onClose }: { onFinish: (status: 'done' | 'failed' | 'cancelled', summary: string) => void; onClose: () => void }) {
  const [st, setSt] = useState<'done' | 'failed' | 'cancelled'>('done')
  const [summary, setSummary] = useState('')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="qs dev-finish" role="dialog" aria-label="标记结束">
        <div className="qs-head">
          <b>标记结束</b>
          <span className="list-sub">终端里的 Claude Code 没有回写结果时，手动给这次执行收尾</span>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">{closeIcon}</button>
        </div>
        <div className="field">
          <span className="field-label">结果</span>
          <div className="seg">{FINISH_OPTS.map((o) => <button key={o.key} className={cls(st === o.key && 'on')} onClick={() => setSt(o.key)}>{o.label}</button>)}</div>
        </div>
        <label className="field">
          <span className="field-label">结论摘要</span>
          <textarea className="qs-input" rows={3} value={summary} autoFocus placeholder="可选：做了什么、产出在哪、还剩什么没做" onChange={(e) => setSummary(e.target.value)} />
        </label>
        <div className="qs-foot">
          <span className="list-sub">只改执行记录，终端标签不会被关掉</span>
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={() => onFinish(st, summary)}>确认</button>
        </div>
      </div>
    </div>
  )
}

export function RunsBlock({ runs, onCancel, onFinish, focus, onDecide, onOpenSession, agentName }: {
  runs: TaskRun[]; onCancel: (id: string) => void
  /** 工作台 Agent 停下等确认时确认 / 拒绝（SPEC-tasks-5.34） */
  onDecide?: (id: string, approved: boolean) => void
  /** 工作台 Agent 执行结束后「打开会话继续」（SPEC-tasks-5.36） */
  onOpenSession?: (sessionId: string) => void
  /** Agent 现在的名字，删了回 undefined */
  agentName?: (id: string) => string | undefined
  /** 终端执行的手动收尾（SPEC-tasks-5.31） */
  onFinish?: (id: string, status: 'done' | 'failed' | 'cancelled', summary: string) => void
  /** 从别处跳过来定位的那一条：展开、高亮、滚到可见处（SPEC-tasks-4.39） */
  focus?: string
}) {
  const [open, setOpen] = useState<string | null>(focus ?? null)
  useEffect(() => {
    if (focus) document.getElementById(`run-${focus}`)?.scrollIntoView({ block: 'center' })
  }, [focus])
  const [finishing, setFinishing] = useState<string | null>(null)
  const xs = [...runs].sort((a, b) => b.started_at.localeCompare(a.started_at))
  return (
    <section className="dev-sec">
      <div className="field-group-title">执行记录<span className="field-hint">从这里交给 Claude Code 或工作台 Agent 的每一次执行，最近的在前</span></div>
      {!xs.length && <div className="mount-empty">还没有执行过</div>}
      {xs.map((r) => {
        const s = RUN_STATUS[r.status]
        const term = r.mode === 'terminal'
        const ag = r.harness === 'agent'
        const live = r.status === 'running' || r.status === 'waiting'
        const expanded = live || open === r.id
        return (
          <div key={r.id} id={`run-${r.id}`} className={cls('dev-run', expanded && 'open', focus === r.id && 'lit')}>
            <button className="dev-run-head" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={expanded}>
              <span className={cls('dev-run-st', `st-${s.tone}`)}>{term && r.status === 'running' ? '进行中' : s.label}</span>
              <span className={cls('src-tag', ag && 'dev-agent')}>{ag ? '工作台 Agent' : 'Claude Code'}</span>
              {!ag && <span className={cls('src-tag', term && 'dev-term')}>{term ? '终端' : '流式'}</span>}
              {!term && !ag && <span className={cls('src-tag', r.allow_writes && 'dev-write')}>{r.allow_writes ? '允许写入' : '只读'}</span>}
              <span className="ellipsis list-sub">{r.extra_prompt || '没有附加说明'}</span>
              <span className="spacer" />
              <span className="list-sub dev-run-at">{timeAgo(r.started_at)} · {dur(r.started_at, r.ended_at)}</span>
            </button>
            {r.summary && r.status !== 'running' && <div className="dev-run-note pre-line">结论：{r.summary}</div>}
            {r.error && r.status !== 'running' && <div className={cls('dev-run-note', r.status === 'failed' ? 'danger-text' : 'muted')}>{r.status === 'done' ? `保留意见：${r.error}` : r.error}</div>}
            {expanded && (
              <div className="dev-run-body">
                <div className="list-sub mono">{ag
                  ? `${(r.agent_id && agentName?.(r.agent_id)) ?? r.agent_name ?? '已删除的 Agent'} · ${r.model ?? ''}${r.workdir ? ` · 产物目录 ${r.workdir}` : ''}${r.agent_session ? ` · 会话 ${short(r.agent_session)}` : ''}`
                  : `${r.workdir}${term ? '' : ` · 会话 ${short(r.session_id)}`}${r.exit_code !== undefined ? ` · exit ${r.exit_code}` : ''}`}</div>
                {term
                  ? <div className="list-sub">在终端里交互执行，过程看终端标签。结束和结论由终端里的 Claude Code 经工作台 MCP（pmw_finish_run）回写{r.status === 'running' ? '；它没回写时用「标记结束」收尾' : ''}。</div>
                  : <RunOutput events={r.events} live={r.status === 'running'} onDecide={r.status === 'waiting' && onDecide ? (ok) => onDecide(r.id, ok) : undefined} />}
                {live && (
                  <div className="act-row">
                    {term
                      ? <button className="act" onClick={() => setFinishing(r.id)} disabled={!onFinish}>标记结束</button>
                      : <button className="act act-danger" onClick={() => onCancel(r.id)}>取消执行</button>}
                  </div>
                )}
                {ag && !live && r.agent_session && onOpenSession && (
                  <div className="act-row">
                    <button className="act" onClick={() => onOpenSession(r.agent_session!)}>打开会话继续</button>
                    <span className="list-sub">在会话里接着追问；要它再动手，从「交给…」勾「接着上次的会话」续跑</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
      {finishing && onFinish && (
        <FinishRunDialog onClose={() => setFinishing(null)} onFinish={(st, summary) => { onFinish(finishing, st, summary); setFinishing(null) }} />
      )}
    </section>
  )
}

/* ---------- 交给 Claude Code ---------- */

const TERMINAL_OFF = '终端插件没启用，到 设置 > 插件 里启用后可用'

export function RunDialog({ task, inheritDir, project, terminalOn, onStart, onClose, onManagePresets, agentRun }: {
  task: Task; inheritDir?: string
  /** 任务所属项目的上下文，提示词里的「所属项目」一节 */
  project?: ProjectContext
  /** 终端插件在跑：「切换到终端」才能选 */
  terminalOn: boolean
  onStart: (o: RunStart) => void
  onClose: () => void
  /** 「管理角色」：去设置 > 角色 */
  onManagePresets?: () => void
  /** 交给工作台 Agent 要用的（SPEC-tasks-6.20）：没给就只有 Claude Code */
  agentRun?: AgentRunOptions
}) {
  const [dir, setDir] = useState(task.workdir ?? inheritDir ?? '')
  const [harness, setHarness] = useState<RunHarness>('claude')
  const [mode, setMode] = useState<HandoffMode>('stream')
  // null 是没动过勾选：跟着角色走（AUTO-03）
  const [allowChoice, setAllowChoice] = useState<boolean | null>(null)
  const [asking, setAsking] = useState(false)
  const [extra, setExtra] = useState('')
  const [preview, setPreview] = useState(false)
  // 角色（SPEC-tasks-6.18，AUTO-03）：打开时选上标了默认的那个，没有默认为「不用」
  const presets = useRunPresets()
  const [presetId, setPresetId] = useState(() => presets.find((p) => p.default)?.id ?? '')
  const preset = presets.find((p) => p.id === presetId)
  // 只读角色锁成只读；允许改文件的角色默认勾上、可取消；没选角色默认只读
  const allowLocked = preset?.permission === 'read_only'
  const allow = allowLocked ? false : allowChoice ?? !!preset
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  // 原型只校验写法；正式产品用 POST /api/agent/workdir/check
  const ag = harness === 'agent'
  // 工作台 Agent 的工作目录可选，只当 write_file 的产物目录（SPEC-tasks-6.20）
  const dirErr = ag ? (dir.trim() && !dir.trim().startsWith('/') ? '要写本机绝对路径' : '')
    : !dir.trim() ? '选一个工作目录，任务和所属项目都没设' : !dir.trim().startsWith('/') ? '要写本机绝对路径' : ''
  const term = !ag && mode === 'terminal'
  const prompt = buildPrompt({ task, workdir: dir.trim(), extra, mode, project, preset })
  // 工作台 Agent：Agent、服务商、模型（SPEC-tasks-6.21、6.22）、续跑（6.23）
  const enabledAgents = agentRun?.agents.filter((a) => a.enabled) ?? []
  const [agentId, setAgentId] = useState(agentRun?.defaultAgentId ?? '')
  const agent = enabledAgents.find((a) => a.id === agentId)
  const agentModel = agentRun?.models.find((m) => m.id === agent?.model)
  const [providerChoice, setProviderChoice] = useState<string | null>(null)
  const [modelChoice, setModelChoice] = useState<string | null>(null)
  const providerId = providerChoice ?? agentModel?.provider_id ?? agentRun?.providers[0]?.id ?? ''
  const providerModels = agentRun?.models.filter((m) => m.provider_id === providerId && m.enabled) ?? []
  const modelId = modelChoice ?? (agentModel?.provider_id === providerId ? agentModel.id : providerModels[0]?.id ?? '')
  const [resume, setResume] = useState(false)
  const canResume = !!agentRun?.lastSession
  const agentErr = ag && !agent ? '没有可用的 Agent：先到「Agent」里建一个并启用' : ag && !modelId ? '这个服务商还没有启用的模型' : ''
  const agentPrompt = [
    resume ? '接着上次的执行继续处理这条任务。先用 get_object 看看任务现在的状态和最近的进展，从没做完的地方接着做。'
      : '这条任务从「产品工作台」交给你执行。你手里是工作台的工具：读任务和关联对象、搜知识库、记进展、改状态和字段、建子任务、按授权写文件、发起 SOP。',
    `\n## 任务\n编号：${task.ref}\n标题：${task.title}`,
    task.desc ? `\n## 任务描述\n${task.desc}` : '',
    task.acceptance ? `\n## 验收标准\n${task.acceptance}` : '',
    project ? `\n## 所属项目\n名称：${project.name}` : '',
    preset ? `\n## 执行要求（${preset.scene}）\n${preset.content}${preset.permission === 'read_only' ? '\n\n这个角色只读：这次只给你开了读的工具，不要尝试改任何东西，结论写在回复里。' : ''}` : '',
    extra.trim() ? `\n## 本次执行的补充要求\n${extra.trim()}` : '',
    `\n## 怎么做\n- 先用 get_object 读这条任务（${task.ref}），关联的对象需要时也读一下。\n- 做完一个关键步骤用 append_progress 记一句进展；拆子任务用 create_object 并带 parent_ref=${task.ref}。\n- 任务真的做完了，用 update_object 改成完成。\n- 这次没有人在旁边回答问题：不能向用户提问，拿不准的写进结论。\n- 有些写操作要用户确认，提出后会停下等；被拒绝了就换办法或收尾。${dir.trim() ? `\n- write_file 写进 ${dir.trim()}，只用相对路径。` : ''}`,
    '\n## 结束时\n最后用一段话写结论：做了什么、改了哪些对象、产出在哪、还剩什么没做。这段会原样记成这条任务的进展。',
  ].filter(Boolean).join('\n')
  const title = ag ? '交给工作台 Agent' : '交给 Claude Code'
  return (
    <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="qs" role="dialog" aria-label={title}>
        <div className="qs-head">
          <b>{title}</b>
          <span className="list-sub">{task.ref} {task.title}</span>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">{closeIcon}</button>
        </div>
        {agentRun && (
          <div className="field">
            <span className="field-label">交给谁</span>
            <div className="seg seg-full" role="radiogroup" aria-label="交给谁">
              <button role="radio" aria-checked={!ag} className={cls(!ag && 'on')} onClick={() => setHarness('claude')}>Claude Code</button>
              <button role="radio" aria-checked={ag} className={cls(ag && 'on')} onClick={() => { setHarness('agent'); setAsking(false) }}>工作台 Agent</button>
            </div>
            <span className="list-sub">{ag ? '工作台自己的 Agent 用它的工具处理这条任务：读任务和关联、记进展、改状态、拆子任务；要确认的写操作会停下等你。改代码的任务仍建议交给 Claude Code'
              : '本机 Claude Code 在工作目录里干活，能改文件、跑命令'}</span>
          </div>
        )}
        {ag && agentRun && (
          <>
            <div className="field">
              <label className="field-label" htmlFor="ho-agent">Agent</label>
              <select id="ho-agent" className="select" value={agentId} onChange={(e) => { setAgentId(e.target.value); setProviderChoice(null); setModelChoice(null) }}>
                {!agent && <option value="">选一个 Agent</option>}
                {enabledAgents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.id === agentRun.defaultAgentId ? '（默认）' : ''}</option>)}
              </select>
              <span className="list-sub">{agent ? `${agent.desc}。工具授权按这个 Agent 的「工具与权限」，要确认的照旧要确认` : '默认用「Agent > 场景默认 Agent」里「执行任务」选的'}</span>
            </div>
            <div className="field">
              <span className="field-label">服务商和模型</span>
              <div className="act-row">
                <select className="select" aria-label="服务商" value={providerId} onChange={(e) => { setProviderChoice(e.target.value); setModelChoice(null) }}>
                  {agentRun.providers.map((p) => <option key={p.id} value={p.id} disabled={!p.enabled}>{p.name}{p.status === 'error' ? '（连接异常）' : ''}</option>)}
                </select>
                <select className="select" aria-label="模型" value={modelId} onChange={(e) => setModelChoice(e.target.value)}>
                  {providerModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              <span className="list-sub">{providerChoice === null && modelChoice === null ? '默认取 Agent 设置的；只改这一次，不改 Agent' : '只改这一次，不改 Agent'}</span>
            </div>
          </>
        )}
        {!ag && <div className="field">
          <span className="field-label">执行方式</span>
          <div className="seg seg-full" role="radiogroup" aria-label="执行方式">
            <button role="radio" aria-checked={!term} className={cls(!term && 'on')} onClick={() => setMode('stream')}>流式执行</button>
            <button role="radio" aria-checked={term} className={cls(term && 'on')} disabled={!terminalOn} title={terminalOn ? undefined : TERMINAL_OFF}
              onClick={() => { setMode('terminal'); setAsking(false) }}>切换到终端</button>
          </div>
          <span className="list-sub">{!terminalOn ? TERMINAL_OFF
            : term ? '在终端里新开一个标签，按设置里的「Claude Code 启动命令」开一个交互式会话；它经工作台 MCP 回写进展和结论'
              : '在工作台里直接跑，实时输出显示在任务的执行记录里'}</span>
        </div>}
        <label className="field">
          <span className="field-label">{ag ? '产物目录（可选）' : '工作目录'}</span>
          <input className={cls('mono-input', dirErr && 'bad')} value={dir} onChange={(e) => setDir(e.target.value)} />
          {dirErr ? <span className="field-err">{dirErr}</span>
            : ag ? <span className="list-sub">{dir.trim() ? 'Agent 写文件（write_file）写在这里' : '不填 Agent 就不能写文件，其他工具照常用'}</span>
              : <span className="list-sub">{task.workdir ? '任务上设的' : inheritDir && dir === inheritDir ? '继承自所属项目' : '这次执行用的目录'}{term ? '，终端标签开在这里' : ''}</span>}
        </label>
        <div className="field">
          <div className="act-row">
            <label className="field-label" htmlFor="ho-preset">角色</label>
            <span className="spacer" />
            {onManagePresets && <button className="link-btn" onClick={onManagePresets}>管理角色</button>}
          </div>
          <select id="ho-preset" className="select" value={presetId} onChange={(e) => { setPresetId(e.target.value); setAllowChoice(null) }}>
            <option value="">不用</option>
            {presets.map((p) => <option key={p.id} value={p.id}>{p.scene}{p.permission === 'read_only' ? '（只读）' : ''}{p.default ? '（默认）' : ''}</option>)}
          </select>
          <span className="list-sub">{preset ? preset.content : '不带角色的执行要求，只按任务内容和附加说明执行'}</span>
          {ag && allowLocked && <span className="list-sub">只读角色：这次只给 Agent 开读的工具，不改任何东西</span>}
          {preset?.output && <span className="list-sub">输出要求：{preset.output}</span>}
          {term && allowLocked && <span className="list-sub">终端方式的权限由启动命令决定：只读角色只在提示词里写明不改文件</span>}
        </div>
        {!term && !ag && (
          <div className="dev-perm">
            <label className="check check-lg">
              <input type="checkbox" checked={allow} disabled={allowLocked} onChange={(e) => { if (e.target.checked) setAsking(true); else setAllowChoice(false) }} />
              允许写入
            </label>
            <span className="list-sub">{allowLocked ? `角色「${preset?.scene ?? ''}」只读：只跑一遍给结论，不改文件`
              : allow ? `会以 acceptEdits 权限模式运行：可以直接改工作目录里的文件${preset && allowChoice === null ? `（按角色「${preset.scene}」）` : ''}`
                : '默认只读：只跑一遍看它打算怎么做，不改文件'}</span>
            {asking && (
              <div className="dev-perm-ask">
                <span>允许写入后，Claude Code 可以不经确认直接改「{dir || '工作目录'}」里的文件。其他需要权限的操作仍会被挡下，任何情况下都不会跳过权限确认。</span>
                <div className="act-row">
                  <button className="act act-warn" onClick={() => { setAllowChoice(true); setAsking(false) }}>确认允许写入</button>
                  <button className="act act-quiet" onClick={() => setAsking(false)}>算了，只读</button>
                </div>
              </div>
            )}
          </div>
        )}
        <label className="field">
          <span className="field-label">附加说明</span>
          <textarea className="qs-input" rows={3} value={extra} placeholder={`可选：这次要特别注意的事，会接在任务内容后面发给${ag ? ' Agent' : ' Claude Code'}`} onChange={(e) => setExtra(e.target.value)} />
        </label>
        {ag && (
          <div className="dev-perm">
            <label className="check check-lg">
              <input type="checkbox" checked={resume && canResume} disabled={!canResume} onChange={(e) => setResume(e.target.checked)} />
              接着上次的会话
            </label>
            <span className="list-sub">{canResume ? '续用上次执行的 Agent 会话，带上之前的上下文；Agent 用上次那个' : '这条任务还没交给工作台 Agent 执行过，没有可续的会话'}</span>
          </div>
        )}
        <div className="dev-preview">
          <button className="link-btn" aria-expanded={preview} onClick={() => setPreview(!preview)}>{preview ? '收起提示词预览' : '提示词预览'}</button>
          {!preview && <span className="list-sub">{project ? `带上所属项目「${project.name}」的文档和原型位置` : '任务没挂在项目下，不带项目信息'}</span>}
          {preview && <pre className="dev-preview-body mono">{ag ? agentPrompt : prompt}</pre>}
        </div>
        {agentErr && <span className="field-err">{agentErr}</span>}
        <div className="qs-foot">
          <span className="list-sub">{ag ? '过程流式显示在执行记录里，同时建一个 Agent 会话；默认最多 30 步、10 分钟，等确认 10 分钟没人决定按拒绝'
            : term ? '会跳到终端页，执行记录里记一条进行中的终端执行' : '执行过程会流式显示在任务的执行记录里'}</span>
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          {ag ? (
            <button className="btn btn-primary" disabled={!!dirErr || !!agentErr}
              onClick={() => onStart({
                workdir: dir.trim(), allow_writes: false, extra_prompt: extra.trim(), mode: 'stream', preset, harness: 'agent',
                agent_id: resume && agentRun?.lastSession ? agentRun.lastSession.agent_id : agent?.id,
                agent_name: resume && agentRun?.lastSession ? agentRun.lastSession.agent_name : agent?.name,
                provider_id: providerId, model: modelId, read_only: allowLocked, resume: resume && canResume, agent_session: resume ? agentRun?.lastSession?.id : undefined,
              })}>
              {resume && canResume ? '接着上次执行' : '开始执行'}
            </button>
          ) : (
            <button className="btn btn-primary" disabled={!!dirErr || (!term && asking) || (term && !terminalOn)}
              onClick={() => onStart({ workdir: dir.trim(), allow_writes: !term && allow, extra_prompt: extra.trim(), mode, preset })}>
              {term ? '在终端中打开' : allow ? '开始执行（允许写入）' : '开始执行（只读）'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
