import { useEffect, useRef, useState } from 'react'
import './devloop.css'
import {
  ARTIFACT_GROUPS, PROGRESS_LABEL, parseArtifact, runScript, seedArtifacts, seedProgress, seedRuns, stepRun,
  type RunEvent, type Task, type TaskArtifact, type TaskProgress, type TaskRun, type TaskStatus,
} from './taskdata'
import { useEnumView } from './enumdata'
import { useOpenUrl } from './openurl'
import { cls, timeAgo } from './ui'

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
    // 允许写入的执行做完，Claude Code 会经 MCP 回写进展和产出物
    if (!r.allow_writes || r.status !== 'done') return
    const files = r.events.flatMap((e) => (e.type === 'tool' && e.name === 'Edit' ? [e.detail] : []))
    const at = new Date().toISOString()
    setProgress((xs) => [...xs, { id: newId('pg'), task_id: r.task_id, kind: 'note', text: '执行完成：改了文件，测试通过。', commits: [], files, actor_name: 'claude-code', session_id: r.session_id, source: 'agent', at }])
    setArtifacts((xs) => [...xs, ...files.map((f) => ({ id: newId('af'), task_id: r.task_id, note: '执行时改动的文件', path: `${r.workdir}/${f}`, rel_path: f, source: 'run' as const, at }))])
  }
  const running = runs.some((r) => r.status === 'running')
  useEffect(() => {
    if (!running) return
    const h = window.setInterval(() => {
      const ending = runsRef.current.filter((r) => r.status === 'running' && r.pending.length <= 1)
      setRuns((xs) => xs.map((r) => stepRun(r)))
      for (const r of ending) finishRef.current(stepRun(r))
    }, 450)
    return () => window.clearInterval(h)
  }, [running])

  const add = (task_id: string, p: Pick<TaskProgress, 'kind' | 'text'> & Partial<TaskProgress>) =>
    setProgress((xs) => [...xs, { id: newId('pg'), task_id, commits: [], files: [], actor_name: '我', source: 'ui', at: new Date().toISOString(), ...p }])

  return {
    progress, artifacts, runs,
    append: (task_id: string, text: string) => add(task_id, { kind: 'note', text }),
    /** 验收通过记 done；退回记 todo（退回到 doing 会被领取规则当成仍被占用，别的会话领不到） */
    review: (task_id: string, ok: boolean, comment: string) => {
      const status: TaskStatus = ok ? 'done' : 'todo'
      add(task_id, { kind: 'note', text: ok ? `验收通过${comment.trim() ? `：${comment.trim()}` : ''}` : `退回：${comment.trim()}`, status })
      patchTask(task_id, { status })
    },
    addArtifact: (task_id: string, a: Pick<TaskArtifact, 'note' | 'url' | 'path'>) =>
      setArtifacts((xs) => [...xs, { id: newId('af'), task_id, source: 'manual', at: new Date().toISOString(), ...a }]),
    start: (task: Task, o: { workdir: string; allow_writes: boolean; extra_prompt: string }) => {
      const sid = newSession()
      const files = progress.filter((p) => p.task_id === task.id).flatMap((p) => p.files)
      const at = new Date().toISOString()
      setRuns((xs) => [{ id: newId('run'), task_id: task.id, status: 'running', session_id: sid, started_at: at, events: [], pending: runScript(task, o.allow_writes, o.extra_prompt, files), ...o }, ...xs])
      // 允许写入时 Claude Code 先领取任务
      if (o.allow_writes) {
        add(task.id, { kind: 'claim', text: '领取了任务', status: 'doing', actor_name: 'claude-code', session_id: sid, source: 'agent' })
        patchTask(task.id, { status: 'doing', assignee: 'Claude Code' })
      }
    },
    cancel: (id: string) => setRuns((xs) => xs.map((r) => (r.id === id && r.status === 'running' ? { ...r, status: 'cancelled', pending: [], error: '已取消', ended_at: new Date().toISOString() } : r))),
  }
}
export type DevLoop = ReturnType<typeof useDevLoop>

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

export function DevFields({ d, onChange, inheritDir, onRun, runningId }: {
  d: DevDraft; onChange: (p: DevDraft) => void
  /** 所属项目的根目录，任务没设工作目录时继承 */
  inheritDir?: string
  /** 只有已存在的任务能交给 Claude Code */
  onRun?: () => void
  runningId?: string
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
          ? <button className="act" onClick={() => document.getElementById(`run-${runningId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })}><span className="proto-light pl-running" />查看运行中</button>
          : <button className="act act-primary" onClick={onRun}>交给 Claude Code</button>)}
      </div>
      <label className="field">
        <span className="field-label">验收标准</span>
        <textarea rows={4} className="mono-area" value={d.acceptance ?? ''} placeholder={'- [ ] 一条一行，写成能检查的样子'} onChange={(e) => onChange({ acceptance: e.target.value || undefined })} />
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
  running: { label: '运行中', tone: 'run' }, done: { label: '完成', tone: 'ok' }, failed: { label: '失败', tone: 'bad' }, cancelled: { label: '已取消', tone: 'off' },
}
const dur = (a: string, b?: string) => {
  const s = Math.max(0, Math.round(((b ? new Date(b).getTime() : Date.now()) - new Date(a).getTime()) / 1000))
  return s < 60 ? `${s} 秒` : `${Math.round(s / 60)} 分钟`
}

/** 流式输出：正文连续拼，工具调用和结果按 id 配成一张卡片 */
export function RunOutput({ events, live }: { events: RunEvent[]; live: boolean }) {
  const blocks: ({ k: 'text'; text: string } | { k: 'tool'; id: string; name: string; detail: string; ok?: boolean; error?: string })[] = []
  for (const e of events) {
    const last = blocks[blocks.length - 1]
    if (e.type === 'delta') { if (last?.k === 'text') last.text += e.text; else blocks.push({ k: 'text', text: e.text }) }
    else if (e.type === 'tool') blocks.push({ k: 'tool', id: e.id, name: e.name, detail: e.detail })
    else { const t = blocks.find((b) => b.k === 'tool' && b.id === e.id); if (t && t.k === 'tool') { t.ok = e.ok; t.error = e.error } }
  }
  return (
    <div className="dev-out">
      {blocks.map((b, i) => b.k === 'text'
        ? <div key={i} className="dev-out-text pre-line">{b.text}</div>
        : (
          <div key={i} className={cls('call-card dev-tool', b.ok === false && 'dev-tool-bad')}>
            <div className="call-head">
              <span className={cls('call-dot', ['Edit', 'Write', 'Bash'].includes(b.name) && 'write')} />
              <span className="call-name">{b.name}<span className="mono list-sub"> {b.detail}</span></span>
              <span className="call-state">{b.ok === undefined ? '执行中' : b.ok ? '成功' : '失败'}</span>
            </div>
            {b.error && <div className="call-body"><span className="danger-text">{b.error}</span></div>}
          </div>
        ))}
      {live && <span className="dev-caret" aria-label="输出中" />}
    </div>
  )
}

export function RunsBlock({ runs, onCancel }: { runs: TaskRun[]; onCancel: (id: string) => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const xs = [...runs].sort((a, b) => b.started_at.localeCompare(a.started_at))
  return (
    <section className="dev-sec">
      <div className="field-group-title">执行记录<span className="field-hint">从这里交给 Claude Code 的每一次执行，最近的在前</span></div>
      {!xs.length && <div className="mount-empty">还没有执行过</div>}
      {xs.map((r) => {
        const s = RUN_STATUS[r.status]
        const expanded = r.status === 'running' || open === r.id
        return (
          <div key={r.id} id={`run-${r.id}`} className={cls('dev-run', expanded && 'open')}>
            <button className="dev-run-head" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={expanded}>
              <span className={cls('dev-run-st', `st-${s.tone}`)}>{s.label}</span>
              <span className={cls('src-tag', r.allow_writes && 'dev-write')}>{r.allow_writes ? '允许写入' : '只读'}</span>
              <span className="ellipsis list-sub">{r.extra_prompt || '没有附加说明'}</span>
              <span className="spacer" />
              <span className="list-sub dev-run-at">{timeAgo(r.started_at)} · {dur(r.started_at, r.ended_at)}</span>
            </button>
            {r.error && r.status !== 'running' && <div className={cls('dev-run-note', r.status === 'failed' ? 'danger-text' : 'muted')}>{r.status === 'done' ? `保留意见：${r.error}` : r.error}</div>}
            {expanded && (
              <div className="dev-run-body">
                <div className="list-sub mono">{r.workdir} · 会话 {short(r.session_id)}{r.exit_code !== undefined ? ` · exit ${r.exit_code}` : ''}</div>
                <RunOutput events={r.events} live={r.status === 'running'} />
                {r.status === 'running' && <div className="act-row"><button className="act act-danger" onClick={() => onCancel(r.id)}>取消执行</button></div>}
              </div>
            )}
          </div>
        )
      })}
    </section>
  )
}

/* ---------- 交给 Claude Code ---------- */

export function RunDialog({ task, inheritDir, onStart, onClose }: {
  task: Task; inheritDir?: string
  onStart: (o: { workdir: string; allow_writes: boolean; extra_prompt: string }) => void
  onClose: () => void
}) {
  const [dir, setDir] = useState(task.workdir ?? inheritDir ?? '')
  const [allow, setAllow] = useState(false)
  const [asking, setAsking] = useState(false)
  const [extra, setExtra] = useState('')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  // 原型只校验写法；正式产品用 POST /api/agent/workdir/check
  const dirErr = !dir.trim() ? '选一个工作目录，任务和所属项目都没设' : !dir.trim().startsWith('/') ? '要写本机绝对路径' : ''
  return (
    <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="qs" role="dialog" aria-label="交给 Claude Code">
        <div className="qs-head">
          <b>交给 Claude Code</b>
          <span className="list-sub">{task.ref} {task.title}</span>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">{closeIcon}</button>
        </div>
        <label className="field">
          <span className="field-label">工作目录</span>
          <input className={cls('mono-input', dirErr && 'bad')} value={dir} onChange={(e) => setDir(e.target.value)} />
          {dirErr ? <span className="field-err">{dirErr}</span> : <span className="list-sub">{task.workdir ? '任务上设的' : inheritDir && dir === inheritDir ? '继承自所属项目' : '这次执行用的目录'}</span>}
        </label>
        <div className="dev-perm">
          <label className="check check-lg">
            <input type="checkbox" checked={allow} onChange={(e) => { if (e.target.checked) setAsking(true); else setAllow(false) }} />
            允许写入
          </label>
          <span className="list-sub">{allow ? '会以 acceptEdits 权限模式运行：可以直接改工作目录里的文件' : '默认只读：只跑一遍看它打算怎么做，不改文件'}</span>
          {asking && (
            <div className="dev-perm-ask">
              <span>允许写入后，Claude Code 可以不经确认直接改「{dir || '工作目录'}」里的文件。其他需要权限的操作仍会被挡下，任何情况下都不会跳过权限确认。</span>
              <div className="act-row">
                <button className="act act-warn" onClick={() => { setAllow(true); setAsking(false) }}>确认允许写入</button>
                <button className="act act-quiet" onClick={() => setAsking(false)}>算了，只读</button>
              </div>
            </div>
          )}
        </div>
        <label className="field">
          <span className="field-label">附加说明</span>
          <textarea className="qs-input" rows={3} value={extra} placeholder="可选：这次要特别注意的事，会接在任务内容后面发给 Claude Code" onChange={(e) => setExtra(e.target.value)} />
        </label>
        <div className="qs-foot">
          <span className="list-sub">执行过程会流式显示在任务的执行记录里</span>
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={!!dirErr || asking} onClick={() => onStart({ workdir: dir.trim(), allow_writes: allow, extra_prompt: extra.trim() })}>{allow ? '开始执行（允许写入）' : '开始执行（只读）'}</button>
        </div>
      </div>
    </div>
  )
}
