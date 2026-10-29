import { useEffect, useMemo, useRef, useState } from 'react'
import { PageTitle } from './topbar'
import {
  RUN_STATUS, SOPS, STEP_STATUS, depsOf, focusIndex, isFinished, isManualDecide, needsMe, ranks, runStatus,
  type Json, type RunAction, type RunStep, type Sop, type SopRun,
} from './sopflow'
import { KindTag, isBranching } from './nodetypes'
import { Subnav } from './subnav'
import { cls, timeAgo } from './ui'
import { SearchSelect } from './searchselect'
import { useEnum } from './enumdata'
import { ListSegHead, ListSegMore } from './tasks'

/** SOP 页的二级菜单 key；library：流程库（全部 SOP 的卡片列表） */
export type SopView = 'runs' | 'waiting' | 'library' | `sop:${string}` | `edit:${string}`

const iso = (t: number) => new Date(t).toISOString()
const dur = (ms: number) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : ms < 3600000 ? `${Math.round(ms / 60000)} 分钟` : `${(ms / 3600000).toFixed(1)} 小时`)
const runDur = (r: SopRun) => dur((r.ended_at ?? Date.now()) - r.started_at)
const clock = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false })

function Pill({ label, color }: { label: string; color: string }) {
  return <span className="pill" style={{ '--c': color } as React.CSSProperties}><span className="pill-dot" />{label}</span>
}


/** 每个 SOP 最近一次执行的开始时间 */
const lastRunAt = (runs: SopRun[]) => {
  const m = new Map<string, number>()
  for (const r of runs) if (r.started_at > (m.get(r.sop_id) ?? 0)) m.set(r.sop_id, r.started_at)
  return m
}
const isPending = (r: SopRun) => ['waiting', 'failed'].includes(runStatus(r))

export function SopNav({ sops, runs, view, onSelect, onNew }: { sops: Sop[]; runs: SopRun[]; view: SopView; onSelect: (v: SopView) => void; onNew: () => void }) {
  const waiting = runs.filter(isPending).length
  // 菜单只放最近执行过的 5 个流程，完整列表在「流程库」里
  const last = useMemo(() => lastRunAt(runs), [runs])
  const recent = sops.filter((s) => last.has(s.id)).sort((a, b) => last.get(b.id)! - last.get(a.id)!).slice(0, 5)
  const active: SopView = view.startsWith('sop:') && !recent.some((s) => view === `sop:${s.id}`) ? 'library' : view
  return (
    <Subnav title="SOP" active={active} onSelect={onSelect} items={[
      { key: 'runs' as SopView, label: '执行记录', group: '视图' },
      { key: 'waiting' as SopView, label: '待我处理', alert: waiting, desc: '待检查、待确认、失败', group: '视图' },
      { key: 'library' as SopView, label: '流程库', desc: `${sops.length} 个标准流程`, group: '视图' },
      ...recent.map((s) => ({ key: `sop:${s.id}` as SopView, label: s.name, desc: `${timeAgo(iso(last.get(s.id)!))}执行`, group: '最近用过' })),
    ]}>
      <button className="subnav-new" onClick={onNew}>
        <svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        新建 SOP
      </button>
    </Subnav>
  )
}

/* ---------- 执行记录列表 ---------- */

function Progress({ run }: { run: SopRun }) {
  const sop = run.sop
  const st = runStatus(run)
  const running = run.steps.filter((x) => x.status === 'running').length
  const walked = run.steps.filter((x) => x.status !== 'bypassed')
  const doneN = walked.filter((x) => isFinished(x.status)).length
  const text = st === 'done' ? `${doneN} 步全部完成`
    : running > 1 && st === 'running' ? `${running} 路并行执行中`
      : `${doneN}/${walked.length} ${sop.steps[focusIndex(run)].name}`
  return (
    <div className="run-progress">
      <div className="steps-bar">
        {run.steps.map((x) => <span key={x.key} className={`seg-${x.status}`} />)}
      </div>
      <span className="run-progress-text ellipsis">{text}</span>
    </div>
  )
}

function RunRow({ r, onOpen, showSop }: { r: SopRun; onOpen: (id: string) => void; showSop: boolean }) {
  const st = runStatus(r)
  return (
    <button className="run-row" onClick={() => onOpen(r.id)}>
      <span className="run-name">
        <span className="ellipsis" title={r.title}>{r.title}</span>
        {showSop && <span className="run-sop ellipsis">{r.sop.name}{r.step_through ? ' · 逐步确认' : ''}</span>}
      </span>
      <span><Pill {...RUN_STATUS[st]} /></span>
      <Progress run={r} />
      <span className="run-muted">{timeAgo(iso(r.started_at))}</span>
      <span className="run-muted">{runDur(r)}</span>
    </button>
  )
}

const RunHead = () => (
  <div className="run-row run-th">
    <span>执行</span><span>状态</span><span>进度</span><span>开始</span><span>耗时</span>
  </div>
)

function RunRows({ runs, onOpen, showSop = true }: { runs: SopRun[]; onOpen: (id: string) => void; showSop?: boolean }) {
  if (!runs.length) return <div className="empty"><div className="empty-title">没有执行记录</div><div className="list-sub">从流程库里选一个标准流程开始执行</div></div>
  return (
    <div className="run-table">
      <RunHead />
      {runs.map((r) => <RunRow key={r.id} r={r} onOpen={onOpen} showSop={showSop} />)}
    </div>
  )
}

const ORDER = { waiting: 0, failed: 1, running: 2, done: 3, stopped: 4 }
const PAGE = 30

/** 按开始日期分段：今天 / 昨天 / 本周 / 更早 */
type DaySeg = 'today' | 'yesterday' | 'week' | 'older'
const DAY_SEGS: { key: DaySeg; label: string }[] = [{ key: 'today', label: '今天' }, { key: 'yesterday', label: '昨天' }, { key: 'week', label: '本周更早' }, { key: 'older', label: '更早' }]
function daySegOf() {
  const d0 = new Date(); d0.setHours(0, 0, 0, 0)
  const today = d0.getTime()
  const yesterday = today - 86400000
  // 周一算一周的第一天
  const week = today - ((d0.getDay() + 6) % 7) * 86400000
  return (t: number): DaySeg => (t >= today ? 'today' : t >= yesterday ? 'yesterday' : t >= week ? 'week' : 'older')
}

export function SopRunsPage({ runs, view, onOpen, sops, sop, onOpenSop, onNew }: {
  runs: SopRun[]; view: 'runs' | 'waiting' | 'library'; onOpen: (id: string) => void
  /** 流程库（view = library）用的全部 SOP；不传用 sopflow 里的 SOPS（App 增删时会同步它） */
  sops?: Sop[]
  /** 打开时预先按这个 SOP 筛（从流程详情「在执行记录里看全部」跳过来） */
  sop?: string
  /** 流程库点卡片打开流程详情 */
  onOpenSop?: (id: string) => void
  onNew?: () => void
}) {
  if (view === 'library') return <SopLibraryPage sops={sops ?? SOPS} runs={runs} onOpen={onOpenSop} onNew={onNew} />
  return <RunList runs={runs} view={view} onOpen={onOpen} sops={sops ?? SOPS} initialSop={sop} />
}

function RunList({ runs, view, onOpen, sops, initialSop }: { runs: SopRun[]; view: 'runs' | 'waiting'; onOpen: (id: string) => void; sops?: Sop[]; initialSop?: string }) {
  const [st, setSt] = useState<'' | 'running' | 'waiting' | 'done' | 'failed'>('')
  const [sopF, setSopF] = useState(initialSop ?? '')
  const [q, setQ] = useState('')
  const [closed, setClosed] = useState<Set<DaySeg>>(new Set())
  const [more, setMore] = useState<Partial<Record<DaySeg, number>>>({})
  const kw = q.trim().toLowerCase()
  useEffect(() => { setMore({}) }, [st, sopF, kw])
  // 流程筛选的选项：传了 sops 用它，否则按执行记录里出现过的流程
  const sopOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of sops ?? []) m.set(s.id, s.name)
    for (const r of runs) if (!m.has(r.sop_id)) m.set(r.sop_id, r.sop.name)
    const n = new Map<string, number>()
    for (const r of runs) n.set(r.sop_id, (n.get(r.sop_id) ?? 0) + 1)
    return [...m].map(([value, label]) => ({ value, label, hint: `${n.get(value) ?? 0} 次` }))
  }, [sops, runs])
  const base = (view === 'waiting' ? runs.filter(isPending) : runs).filter((r) => (!sopF || r.sop_id === sopF) && (!kw || `${r.title} ${r.sop.name}`.toLowerCase().includes(kw)))
  const rows = base.filter((r) => !st || runStatus(r) === st)
    .sort((a, b) => ORDER[runStatus(a)] - ORDER[runStatus(b)] || b.started_at - a.started_at)
  const segOf = daySegOf()
  const segs = DAY_SEGS.map((s) => ({ ...s, xs: rows.filter((r) => segOf(r.started_at) === s.key) })).filter((s) => s.xs.length)
  const toggle = (k: DaySeg) => setClosed((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const filtered = !!(st || sopF || kw)
  return (
    <div className="page page-fill">
      <PageTitle parent="SOP" count={rows.length} desc={view === 'waiting' ? '这些执行停下来等你：检查输出、确认输入，或处理失败的步骤' : '每一步都留着输入和输出，点进去可以逐步查看'}>{view === 'waiting' ? '待我处理' : '执行记录'}</PageTitle>
      <div className="toolbar">
        {view === 'runs' && (
          <div className="seg">
            {([['', '全部'], ['running', '执行中'], ['waiting', '待我处理'], ['failed', '失败'], ['done', '已完成']] as const).map(([k, l]) => (
              <button key={k} className={cls(st === k && 'on')} onClick={() => setSt(k)}>
                {l}<span className="seg-n">{k ? base.filter((r) => runStatus(r) === k).length : base.length}</span>
              </button>
            ))}
          </div>
        )}
        <SearchSelect value={sopF} onChange={setSopF} noneLabel="全部流程" searchPlaceholder="搜流程" options={sopOptions} missingLabel={() => '已删除的流程'} />
        <span className="spacer" />
        <div className="search">
          <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder="搜索执行标题、流程名" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {!rows.length ? (
        <div className="empty">
          <div className="empty-title">{filtered ? '没有匹配的执行记录' : view === 'waiting' ? '没有等你处理的执行' : '没有执行记录'}</div>
          <div className="list-sub">{filtered ? '换个筛选条件试试' : view === 'waiting' ? '检查点都处理完了' : '从流程库里选一个标准流程开始执行'}</div>
        </div>
      ) : (
        <div className="run-table">
          <RunHead />
          {segs.map((s) => {
            const open = !closed.has(s.key)
            const n = PAGE + (more[s.key] ?? 0)
            return (
              <div key={s.key} role="group" aria-label={s.label}>
                <ListSegHead label={s.label} n={s.xs.length} open={open} onToggle={() => toggle(s.key)} />
                {open && s.xs.slice(0, n).map((r) => <RunRow key={r.id} r={r} onOpen={onOpen} showSop />)}
                {open && <ListSegMore n={s.xs.length - n} onMore={() => setMore((m) => ({ ...m, [s.key]: (m[s.key] ?? 0) + 100 }))} />}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ---------- 流程库 ---------- */

type LibFilter = '' | 'pending' | 'never'

function SopLibraryPage({ sops, runs, onOpen, onNew }: { sops: Sop[]; runs: SopRun[]; onOpen?: (id: string) => void; onNew?: () => void }) {
  const [q, setQ] = useState('')
  const [f, setF] = useState<LibFilter>('')
  const last = useMemo(() => lastRunAt(runs), [runs])
  const stat = useMemo(() => {
    const m = new Map<string, { n: number; pending: number }>()
    for (const r of runs) {
      const x = m.get(r.sop_id) ?? { n: 0, pending: 0 }
      x.n += 1
      if (isPending(r)) x.pending += 1
      m.set(r.sop_id, x)
    }
    return m
  }, [runs])
  const pass = (s: Sop, k: LibFilter) => !k || (k === 'pending' ? (stat.get(s.id)?.pending ?? 0) > 0 : !last.has(s.id))
  const kw = q.trim().toLowerCase()
  const triggers = useEnum('sop_trigger')
  // 有待处理的在前，其余按最近执行时间，没执行过的按名字排在最后
  const rows = sops.filter((s) => pass(s, f) && (!kw || `${s.name} ${s.desc} ${triggerLabel(triggers, s.trigger)}`.toLowerCase().includes(kw)))
    .sort((a, b) => Number((stat.get(b.id)?.pending ?? 0) > 0) - Number((stat.get(a.id)?.pending ?? 0) > 0) || (last.get(b.id) ?? 0) - (last.get(a.id) ?? 0) || a.name.localeCompare(b.name))
  return (
    <div className="page page-fill">
      <PageTitle parent="SOP" count={sops.length} desc="全部标准流程；有执行停下来等你的排在前面" actions={onNew && (
        <button className="btn btn-primary" onClick={onNew}>
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          新建 SOP
        </button>
      )}>流程库</PageTitle>
      <div className="toolbar">
        <div className="seg">
          {([['', '全部'], ['pending', '有待处理'], ['never', '没执行过']] as [LibFilter, string][]).map(([k, l]) => (
            <button key={k} className={cls(f === k && 'on')} onClick={() => setF(k)}>{l}<span className="seg-n">{sops.filter((s) => pass(s, k)).length}</span></button>
          ))}
        </div>
        <span className="spacer" />
        <div className="search">
          <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder="搜索流程名、说明、触发方式" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {!rows.length ? (
        <div className="empty">
          <div className="empty-title">{kw || f ? '没有匹配的流程' : '还没有标准流程'}</div>
          <div className="list-sub">{kw || f ? '换个筛选条件试试' : '把反复做的事情编排成 SOP，每次按同样的步骤执行'}</div>
        </div>
      ) : (
        <div className="sop-lib-grid">
          {rows.map((s) => {
            const x = stat.get(s.id)
            const at = last.get(s.id)
            return (
              <button key={s.id} className="sop-lib-card" disabled={!onOpen} onClick={() => onOpen?.(s.id)}>
                <span className="sop-lib-head">
                  <span className="sop-lib-name ellipsis" title={s.name}>{s.name}</span>
                  {!!x?.pending && <span className="sop-lib-pending">{x.pending} 个待处理</span>}
                </span>
                <span className="sop-lib-desc" title={s.desc}>{s.desc || '没有说明'}</span>
                <span className="sop-lib-meta">
                  <span>{s.steps.length} 步</span>
                  <span>{x ? `执行 ${x.n} 次` : '没执行过'}</span>
                  {at && <span>{timeAgo(iso(at))}执行</span>}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ---------- 流程详情 ---------- */

/** 触发方式存 sop_trigger 枚举的 key；枚举里找不到时原样显示 */
export const triggerLabel = (items: { key: string; label: string }[], key: string) => items.find((i) => i.key === key)?.label ?? key

export function SopDetailPage({ sop, runs, onStart, onOpen, onEdit, onDelete, delPlan, onAllRuns }: {
  sop: Sop; runs: SopRun[]; onStart: () => void; onOpen: (id: string) => void; onEdit: () => void
  onDelete?: () => void
  /** 删除前算出的影响；block 有值时不能删 */
  delPlan?: { block?: string; impact: string[] }
  /** 跳执行记录页并按这个流程筛；不传时在本页展开全部 */
  onAllRuns?: () => void
}) {
  const [confirmDel, setConfirmDel] = useState(false)
  const [allRuns, setAllRuns] = useState(false)
  const mine = runs.filter((r) => r.sop_id === sop.id).sort((a, b) => b.started_at - a.started_at)
  const reviews = sop.steps.filter((s) => s.kind === 'review' || isManualDecide(s)).length
  const decides = sop.steps.filter((s) => isBranching(s.kind)).length
  const RECENT = 10
  const triggers = useEnum('sop_trigger')
  const delText = delPlan?.block ? `不能删除：${delPlan.block}` : delPlan?.impact.length ? `删除后${delPlan.impact.join('；')}` : '删除后不能恢复'
  const delActs = <>
    <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>{delPlan?.block ? '知道了' : '取消'}</button>
    {!delPlan?.block && <button className="btn btn-danger" onClick={onDelete}>删除</button>}
  </>
  return (
    <div className="page page-fill">
      <PageTitle parent="SOP" desc={sop.desc} actions={<>
        {onDelete && (confirmDel ? (
          <span className="sop-del-top"><span className="danger-text">{delText}</span>{delActs}</span>
        ) : <button className="btn btn-ghost btn-danger-ghost" onClick={() => setConfirmDel(true)}>删除</button>)}
        <button className="btn btn-outline" onClick={onEdit}>编辑</button>
        <button className="btn btn-primary" onClick={onStart}>
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M4.5 3v10l8-5Z" fill="currentColor" /></svg>
          执行
        </button>
      </>}>{sop.name}</PageTitle>
      {/* 窄屏时确认条从标题行挪到这里，文字换行，按钮不会被挤出去 */}
      {confirmDel && <div className="sop-del-bar" role="alert"><span className="danger-text">{delText}</span><span className="act-row">{delActs}</span></div>}
      <div className="sop-facts sop-facts-top">
        <span>触发：{triggerLabel(triggers, sop.trigger)}</span>
        <span>{sop.steps.length} 个步骤</span>
        <span>{decides} 个分支节点</span>
        <span>{reviews} 个需要人处理的节点</span>
      </div>

      <div className="section-label">流程</div>
      <div className="flow-card"><FlowGraph sop={sop} /></div>
      <FlowLegend />

      <div className="section-label">输入</div>
      <div className="sop-fields">
        {sop.fields.map((f) => <span key={f.key} className="tag">{f.label}{f.required ? '（必填）' : ''}</span>)}
      </div>

      <div className="section-label">最近执行{mine.length > 0 && <span className="field-hint">共 {mine.length} 次</span>}</div>
      <RunRows runs={allRuns ? mine : mine.slice(0, RECENT)} onOpen={onOpen} showSop={false} />
      {!allRuns && mine.length > RECENT && (
        <button className="list-seg-more list-seg-more-out" onClick={() => (onAllRuns ? onAllRuns() : setAllRuns(true))}>
          {onAllRuns ? `在执行记录里看全部 ${mine.length} 次` : `显示全部 ${mine.length} 次`}
        </button>
      )}
    </div>
  )
}

/* ---------- 发起执行 ---------- */

export function SopStartDrawer({ sop, initial, onClose, onStart }: {
  sop: Sop
  initial?: Json
  onClose: () => void
  onStart: (input: Json, stepThrough: boolean) => void
}) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(sop.fields.map((f) => [f.key, String(initial?.[f.key] ?? f.default ?? '')])))
  const [stepThrough, setStepThrough] = useState(false)
  const [tried, setTried] = useState(false)
  const missing = sop.fields.filter((f) => f.required && !vals[f.key]?.trim())
  const start = () => { setTried(true); if (!missing.length) onStart(vals, stepThrough) }
  return (
    <aside className="drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">执行 SOP</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="drawer-body form">
        <div>
          <h2 className="sop-start-title">{sop.name}</h2>
          <div className="list-sub">{sop.desc}</div>
        </div>
        {sop.fields.map((f) => {
          const bad = tried && missing.includes(f)
          return (
            <label key={f.key} className="field">
              <span className="field-label">{f.label}{f.required && <em>*</em>}</span>
              {f.type === 'textarea' ? (
                <textarea rows={5} value={vals[f.key]} placeholder={f.placeholder} className={cls(bad && 'bad')} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
              ) : f.type === 'select' ? (
                <select value={vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}>
                  {f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : (
                <input value={vals[f.key]} placeholder={f.placeholder} className={cls(bad && 'bad')} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
              )}
              {bad && <span className="field-err">必填</span>}
            </label>
          )
        })}
        <div className="field-group">
          <label className="check check-lg">
            <input type="checkbox" checked={stepThrough} onChange={(e) => setStepThrough(e.target.checked)} />
            逐步确认
          </label>
          <div className="list-sub">每一步执行前都停下来，让你检查、修改这一步的输入。不勾的话只在人工检查步骤停下。执行中也可以随时切换。</div>
        </div>
        <div className="section-label">将依次执行</div>
        <ol className="sop-mini-flow">
          {sop.steps.map((s) => <li key={s.key}>{s.name}<KindTag kind={s.kind} /></li>)}
        </ol>
      </div>
      <div className="drawer-foot">
        <div className="spacer" />
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
        <button className="btn btn-primary" onClick={start}>开始执行</button>
      </div>
    </aside>
  )
}

/* ---------- 流程图 ---------- */

// 按依赖分列：同一列里的步骤互不依赖，可以同时跑；判断后的分支也落在同一列，连线上写分支名
const W = 184
const H = 74
const COL_GAP = 64
const ROW_GAP = 14
const PAD = 12
const TOP = 22

export function FlowGraph({ sop, run, selected, onSelect }: {
  sop: Sop
  run?: SopRun
  selected?: number
  onSelect?: (i: number) => void
}) {
  const rk = ranks(sop)
  const cols: number[][] = []
  rk.forEach((r, i) => { (cols[r] ??= []).push(i) })
  const maxRows = Math.max(...cols.map((c) => c.length))
  const pos = sop.steps.map((_, i) => {
    const col = cols[rk[i]]
    const off = ((maxRows - col.length) * (H + ROW_GAP)) / 2
    return { x: PAD + rk[i] * (W + COL_GAP), y: TOP + PAD + off + col.indexOf(i) * (H + ROW_GAP) }
  })
  const width = PAD * 2 + cols.length * W + (cols.length - 1) * COL_GAP
  const height = TOP + PAD * 2 + maxRows * H + (maxRows - 1) * ROW_GAP
  const idx = new Map(sop.steps.map((x, i) => [x.key, i]))
  const st = (i: number) => run?.steps[i].status
  // 图比视口宽时，选中的步骤可能在右边看不见，切过去时滚到它
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (selected === undefined) return
    boxRef.current?.querySelector('.fnode.sel')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [selected])

  const edges = sop.steps.flatMap((def, i) => depsOf(sop, i).map((k) => {
    const j = idx.get(k)!
    const from = { x: pos[j].x + W, y: pos[j].y + H / 2 }
    const to = { x: pos[i].x, y: pos[i].y + H / 2 }
    const mid = (from.x + to.x) / 2
    const label = def.branch?.of === k ? sop.steps[j].cases?.find((c) => c.key === def.branch!.case)?.label : undefined
    const off = st(i) === 'bypassed' || st(j) === 'bypassed'
    const on = !off && run && isFinished(st(j)!) && st(i) !== 'pending'
    return { id: `${k}-${def.key}`, d: `M${from.x},${from.y} C${mid},${from.y} ${mid},${to.y} ${to.x - 2},${to.y}`, label, lx: mid, ly: (from.y + to.y) / 2, off, on }
  }))

  return (
    <div className="flow-scroll">
      <div className="flow" ref={boxRef} style={{ width, height }}>
        <svg className="flow-edges" width={width} height={height} aria-hidden>
          <defs>
            <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 8,4 0,8Z" className="arr" /></marker>
            <marker id="arr-on" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 8,4 0,8Z" className="arr arr-on" /></marker>
          </defs>
          {edges.map((e) => <path key={e.id} d={e.d} className={cls('edge', e.on && 'edge-on', e.off && 'edge-off')} markerEnd={`url(#${e.on ? 'arr-on' : 'arr'})`} />)}
        </svg>
        {edges.filter((e) => e.label).map((e) => (
          <span key={`l-${e.id}`} className={cls('edge-label', e.off && 'off')} style={{ left: e.lx, top: e.ly }}>{e.label}</span>
        ))}
        {cols.map((col, c) => col.length > 1 && col.some((i) => !sop.steps[i].branch) && (
          <span key={`p${c}`} className="flow-par" style={{ left: pos[col[0]].x, top: pos[col[0]].y - 20 }}>并行 {col.length} 路</span>
        ))}
        {sop.steps.map((def, i) => {
          const rs = run?.steps[i]
          const deps = depsOf(sop, i).length
          const route = rs?.route && def.cases?.find((c) => c.key === rs.route)?.label
          return (
            <button key={def.key} className={cls('fnode', `fn-${rs?.status ?? 'idle'}`, `fk-${def.kind}`, selected === i && 'sel', !onSelect && 'static')}
              style={{ left: pos[i].x, top: pos[i].y, width: W, height: H }} onClick={() => onSelect?.(i)} tabIndex={onSelect ? 0 : -1}>
              <span className="fnode-top">
                <KindTag kind={def.kind} />
                {deps > 1 && <span className="fnode-join">汇合 {deps} 路</span>}
                {rs?.edited && <span className="edited-dot" title={{ input: '输入被人工修改', output: '输出被人工修改', route: '分支由人选择' }[rs.edited]}>人</span>}
              </span>
              <span className="fnode-name ellipsis">{def.name}</span>
              {rs ? (
                <span className={`fnode-st fst-${rs.status}`}>
                  {rs.status === 'running' && <span className="spinner spinner-xs" />}
                  {route ? `走「${route}」` : STEP_STATUS[rs.status].label}
                </span>
              ) : (
                <span className="fnode-st">{isBranching(def.kind) ? (def.kind === 'classifier' ? 'AI 分类' : isManualDecide(def) ? '人工判断' : '按规则判断') : `约 ${Math.max(1, Math.round(def.ms / 1000))} 秒`}</span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function FlowLegend() {
  return (
    <div className="flow-legend">
      <span>同一列的步骤并行执行</span>
      <span>汇合：等前面几路都完成才开始</span>
      <span>判断：只走选中的分支，另一支标为「未走此分支」</span>
    </div>
  )
}

/* ---------- 单次执行：流程图 + 输入输出检查 ---------- */

/** 字段视图：短文本直接显示，长文本保留换行，数组和对象缩进成 JSON */
export function DataView({ data }: { data: Json }) {
  const keys = Object.keys(data)
  if (!keys.length) return <div className="io-empty">空</div>
  return (
    <dl className="io-fields">
      {keys.map((k) => {
        const v = data[k]
        const simple = v === null || ['string', 'number', 'boolean'].includes(typeof v)
        return (
          <div key={k} className="io-field">
            <dt>{k}</dt>
            <dd>{simple ? <span className="io-text">{String(v) || <span className="io-empty">空</span>}</span> : <pre className="io-json">{JSON.stringify(v, null, 2)}</pre>}</dd>
          </div>
        )
      })}
    </dl>
  )
}

type Tab = 'input' | 'output' | 'log'

function Inspector({ run, index, onAct }: { run: SopRun; index: number; onAct: (a: RunAction) => void }) {
  const sop = run.sop
  const def = sop.steps[index]
  const step: RunStep = run.steps[index]
  const manualDecide = isManualDecide(def)
  const defaultTab: Tab = step.status === 'paused' || step.status === 'failed' || step.status === 'running' || (manualDecide && step.status === 'review') ? 'input' : step.output ? 'output' : 'input'
  const [tab, setTab] = useState<Tab>(defaultTab)
  const [raw, setRaw] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)

  // 步骤状态变了，回到这个状态最该看的那一栏，丢掉没提交的修改
  useEffect(() => { setTab(defaultTab); setEditing(false); setErr(''); setCopied(false) }, [step.status])

  const data = tab === 'input' ? step.input : tab === 'output' ? step.output : undefined
  const editable = (tab === 'input' && step.status === 'paused') || (tab === 'output' && step.status === 'review' && !manualDecide)
  const deps = depsOf(sop, index)
  const upstream = deps.map((k) => sop.steps.find((x) => x.key === k)!).filter((_, n) => run.steps.find((x) => x.key === deps[n])?.status !== 'bypassed')

  const beginEdit = () => { setDraft(JSON.stringify(data ?? {}, null, 2)); setErr(''); setEditing(true) }
  const parsed = (): Json | null => {
    try {
      const v = JSON.parse(draft)
      if (!v || typeof v !== 'object' || Array.isArray(v)) { setErr('需要是一个 JSON 对象，形如 { "字段": 值 }'); return null }
      return v as Json
    } catch (e) { setErr(`JSON 格式不对：${(e as Error).message}`); return null }
  }
  const submit = () => {
    const v = parsed()
    if (!v) return
    onAct(step.status === 'paused' ? { kind: 'confirm-input', step: index, input: v } : { kind: 'approve', step: index, output: v })
  }
  const copy = () => navigator.clipboard?.writeText(JSON.stringify(data ?? {}, null, 2)).then(() => setCopied(true), () => {})

  const ended = run.stopped || runStatus(run) === 'done'
  const routeLabel = step.route && def.cases?.find((c) => c.key === step.route)?.label
  const branchOf = def.branch && sop.steps.find((x) => x.key === def.branch!.of)
  const branchLabel = branchOf?.cases?.find((c) => c.key === def.branch!.case)?.label

  return (
    <section className="inspector">
      <div className="insp-head">
        <div className="insp-title">
          <span className="insp-n">步骤 {index + 1}</span>
          <h2>{def.name}</h2>
          <KindTag kind={def.kind} />
          <Pill {...STEP_STATUS[step.status]} />
          {step.edited && <span className="edited-tag">{{ input: '输入被人工修改', output: '输出被人工修改', route: '分支由人选择' }[step.edited]}</span>}
        </div>
        <div className="insp-desc">
          {def.desc}
          {deps.length > 1 && <> · 汇合 {deps.map((k) => sop.steps.find((x) => x.key === k)!.name).join('、')}</>}
          {branchOf && <> · 属于「{branchOf.name}」的「{branchLabel}」分支</>}
        </div>
      </div>

      {routeLabel && (
        <div className="insp-route">
          <span className="insp-route-k">判断结果</span>走「{routeLabel}」分支<span className="insp-route-why">{step.route_reason}</span>
        </div>
      )}
      {step.status === 'bypassed' && (
        <div className="insp-banner muted">这一步所在的分支没被选中，没有执行，也没有输入输出。</div>
      )}
      {!run.stopped && step.status === 'paused' && (
        <div className="insp-banner warn">
          <b>执行前暂停</b>这一步要用下面的输入执行。检查一下，有问题可以直接改。
          <div className="act-row">
            {editing ? <>
              <button className="act act-primary" onClick={submit}>用修改后的输入执行</button>
              <button className="act" onClick={() => setEditing(false)}>取消修改</button>
            </> : <>
              <button className="act act-primary" onClick={() => onAct({ kind: 'confirm-input', step: index })}>确认并执行</button>
              <button className="act" onClick={() => { setTab('input'); beginEdit() }}>修改输入</button>
              {!isBranching(def.kind) && <button className="act act-quiet" onClick={() => onAct({ kind: 'skip', step: index })}>跳过这一步</button>}
            </>}
          </div>
        </div>
      )}
      {!run.stopped && step.status === 'review' && manualDecide && (
        <div className="insp-banner warn">
          <b>需要你判断</b>看过下面的输入，选这次走哪个分支。没选中的分支不会执行。
          <div className="act-row">
            {def.cases!.map((c, n) => (
              <button key={c.key} className={cls('act', n === 0 && 'act-primary')} onClick={() => onAct({ kind: 'route', step: index, route: c.key })}>走「{c.label}」</button>
            ))}
          </div>
        </div>
      )}
      {!run.stopped && step.status === 'review' && !manualDecide && (
        <div className="insp-banner warn">
          <b>需要你检查</b>确认下面的输出没问题再放行，下游会直接拿它当输入。
          <div className="act-row">
            {editing ? <>
              <button className="act act-primary" onClick={submit}>保存修改并放行</button>
              <button className="act" onClick={() => setEditing(false)}>取消修改</button>
            </> : <>
              <button className="act act-primary" onClick={() => onAct({ kind: 'approve', step: index })}>通过，继续执行</button>
              <button className="act" onClick={() => { setTab('output'); beginEdit() }}>修改输出</button>
              {upstream.length > 0 && (
                <button className="act act-quiet" onClick={() => onAct({ kind: 'rework', step: index })}>
                  退回{upstream.length > 1 ? `上游 ${upstream.length} 步` : `「${upstream[0].name}」`}重做
                </button>
              )}
            </>}
          </div>
        </div>
      )}
      {!run.stopped && step.status === 'failed' && (
        <div className="insp-banner danger">
          <b>执行失败</b>{step.error}
          <div className="act-row">
            <button className="act act-primary" onClick={() => onAct({ kind: 'retry', step: index })}>重试</button>
            <button className="act act-quiet" onClick={() => onAct({ kind: 'skip', step: index })}>跳过这一步</button>
          </div>
        </div>
      )}
      {step.status === 'running' && (
        <div className="insp-banner info">
          <span className="spinner" />正在执行{def.kind === 'ai' ? '，AI 生成中' : ''}…
          <div className="run-bar"><span style={{ width: `${Math.min(100, ((Date.now() - (step.started_at ?? Date.now())) / def.ms) * 100)}%` }} /></div>
        </div>
      )}

      {step.status !== 'bypassed' && <>
        <div className="insp-tabs">
          <div className="seg seg-sm">
            {(['input', 'output', 'log'] as Tab[]).map((t) => (
              <button key={t} className={cls(tab === t && 'on')} onClick={() => { setTab(t); setEditing(false) }}>
                {{ input: '输入', output: '输出', log: '日志' }[t]}
                {t === 'log' && <span className="seg-n">{step.log.length}</span>}
              </button>
            ))}
          </div>
          {tab === 'input' && deps.length > 1 && step.input && <span className="insp-note">汇合输入按上游步骤分组</span>}
          <span className="spacer" />
          {tab !== 'log' && data && !editing && <>
            <button className="act act-quiet" onClick={() => setRaw(!raw)}>{raw ? '字段视图' : 'JSON'}</button>
            <button className="act act-quiet" onClick={copy}>{copied ? '已复制' : '复制'}</button>
            {editable && !ended && <button className="act" onClick={beginEdit}>修改</button>}
          </>}
        </div>

        <div className="insp-body">
          {tab === 'log' ? (
            step.log.length ? (
              <ol className="io-log">
                {step.log.map((l, i) => <li key={i}><time>{clock(l.at)}</time>{l.text}</li>)}
              </ol>
            ) : <div className="io-empty">还没有日志</div>
          ) : editing ? (
            <div className="io-edit">
              <textarea spellCheck={false} value={draft} onChange={(e) => { setDraft(e.target.value); setErr('') }} />
              {err ? <div className="field-err">{err}</div> : <div className="field-hint-line">改的是 JSON；提交后这一步会标为「人工修改」，执行记录里留痕</div>}
            </div>
          ) : !data ? (
            <div className="io-empty">
              {tab === 'input' ? (deps.length > 1 ? '等汇合的几路上游都完成后，这里会出现它们的输出' : '还没执行到这一步，上游完成后这里会出现它的输入')
                : step.status === 'running' ? '执行完才有输出'
                  : step.status === 'failed' ? '执行失败，没有输出' : '还没有输出'}
            </div>
          ) : raw ? <pre className="io-json io-json-full">{JSON.stringify(data, null, 2)}</pre> : <DataView data={data} />}
        </div>
      </>}
      {(step.started_at || step.attempts > 1) && (
        <div className="insp-foot">
          {step.started_at && <span>开始 {clock(step.started_at)}</span>}
          {step.ended_at && step.started_at && <span>用时 {dur(step.ended_at - step.started_at)}</span>}
          {step.attempts > 1 && <span>执行了 {step.attempts} 次</span>}
        </div>
      )}
    </section>
  )
}

export function SopRunView({ run, onBack, onAct, onRerun }: {
  run: SopRun
  onBack: () => void
  onAct: (a: RunAction) => void
  onRerun: () => void
}) {
  const sop = run.sop
  const st = runStatus(run)
  const focus = focusIndex(run)
  // 没手动点过就跟着需要处理 / 正在执行的步骤走；点过别的步骤就停在那，给个「回到当前步骤」
  const [picked, setPicked] = useState<number | null>(null)
  const index = picked ?? focus
  const act = (a: RunAction) => { setPicked(null); onAct(a) }
  const ended = st === 'done' || st === 'stopped'
  const waiting = run.steps.filter((x) => needsMe(x.status)).length

  return (
    <div className="run-view">
      <div className="run-head">
        <button className="btn btn-ghost run-back" onClick={onBack}>
          <svg viewBox="0 0 16 16" width="13" height="13"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          返回
        </button>
        <div className="run-head-text">
          <PageTitle parent={sop.name} actions={<>
          {picked !== null && picked !== focus && !ended && <button className="act act-quiet" onClick={() => setPicked(null)}>回到当前步骤</button>}
          {!ended && (
            <label className="check" title="每一步执行前停下来，确认输入后再跑">
              <input type="checkbox" checked={run.step_through} onChange={(e) => onAct({ kind: 'step-through', on: e.target.checked })} />
              逐步确认
            </label>
          )}
          {!ended && <button className="act" onClick={() => onAct({ kind: 'stop' })}>终止执行</button>}
          {ended && <button className="act act-primary" onClick={onRerun}>用同样的输入再执行</button>}
          </>}>{run.title}</PageTitle>
          <div className="run-head-meta">
            <Pill {...RUN_STATUS[st]} />
            <span>{sop.name}</span>
            <span>开始于 {timeAgo(iso(run.started_at))}</span>
            <span>{ended ? '共' : '已'}用时 {runDur(run)}</span>
            {waiting > 1 && <span className="run-head-warn">{waiting} 个步骤等你处理</span>}
          </div>
        </div>
      </div>
      <div className="run-flow">
        <FlowGraph sop={sop} run={run} selected={index} onSelect={(i) => setPicked(i === focus ? null : i)} />
      </div>
      <Inspector key={index} run={run} index={index} onAct={act} />
    </div>
  )
}
