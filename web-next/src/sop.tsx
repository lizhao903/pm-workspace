import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { PageTitle } from './topbar'
import {
  GOVERNANCE_MAX, MODEL_CONCURRENCY_MAX, RERUN_MAX, RUN_STATUS, SOPS, depsOf, emptyIM, imFilterText, isHeld, flowChanged, sourceText, focusIndex, isFinished, isClaudeKind, isManualDecide, isModelKind, isProviderWait, isQueued, needsMe, ranks,
  RERUN_REASON_RELAUNCHED, runShow, runStatus, stepLook,
  isStoppable,
  SOP_FOLDERS, UNCATEGORIZED, addFolder, folderNameError, folderOf, moveSops, newSopFolder, removeFolder, renameFolder,
  type Governance, type Json, type RerunAction, type RerunResult, type RunAction, type RunStep, type Sop, type SopRun,
} from './sopflow'
import { KindTag, isBranching } from './nodetypes'
import { Subnav } from './subnav'
import { cls, timeAgo } from './ui'
import { SearchSelect } from './searchselect'
import { useEnum } from './enumdata'
import { ListSegHead, ListSegMore } from './tasks'
import { describeRule, flowSchedule, nextRun, whenText, type Schedule } from './scheduledata'
import type { TodayItem } from './today'

/**
 * 定时触发（TSK-0463）：触发方式「定时」的规则在随流程管理的定时任务里。App 把定时任务列表和启停放进这个上下文，
 * 流程库卡片、流程详情显示规则、下次执行和启停开关；和定时任务页改的是同一条
 */
export const SopSchedules = createContext<{ list: Schedule[]; toggle: (id: string, on: boolean) => void }>({ list: [], toggle: () => {} })

/** 流程的定时一行：规则、下次执行、启停；定时但没有那条定时任务（在定时任务页删了）是「定时，未配置」 */
function SchedLine({ sop, className }: { sop: Sop; className: string }) {
  const { list, toggle } = useContext(SopSchedules)
  if (sop.trigger !== 'schedule') return null
  const sc = flowSchedule(list, sop.id)
  if (!sc) return <div className={cls('sop-sched unset', className)}>定时，未配置：到点不会执行，到编辑里设好时间</div>
  const next = sc.enabled ? nextRun(sc.rule) : null
  return (
    <div className={cls('sop-sched', !sc.enabled && 'off', className)}>
      <span className="sop-sched-text">
        <span>定时 · {describeRule(sc.rule)}</span>
        <span className={cls(sc.enabled && 'sop-sched-next')}>{sc.enabled ? (next ? `下次 ${whenText(next)}` : '不会再执行') : '已停用'}</span>
      </span>
      <span className="switch-line" title={sc.enabled ? '停用定时' : '启用定时'}>
        <input type="checkbox" aria-label={`定时执行「${sop.name}」`} checked={sc.enabled} onChange={(e) => toggle(sc.id, e.target.checked)} /><span className="switch" />
      </span>
    </div>
  )
}

/** 流程的 IM 触发一行（TSK-0481，SPEC-sop-2.14、5.18）：第几个判断、过滤条件、拦截标记；不是 IM 触发不显示 */
function IMLine({ sop, className }: { sop: Sop; className: string }) {
  if (sop.trigger !== 'im') return null
  const im = sop.im ?? emptyIM()
  return (
    <div className={cls('sop-sched sop-im-line', className)}>
      <span className="sop-sched-text">
        <span className="sop-sched-next">第 {im.order || '?'} 个</span>
        <span>{imFilterText(im)}</span>
      </span>
      {im.stop && <span className="sop-im-stop" title="这条流程接住的消息，排在后面的 IM 流程不再处理">拦截后续</span>}
    </div>
  )
}

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
// 已重跑过的失败执行不算（SPEC-sop-4.21）
const isPending = (r: SopRun) => ['waiting', 'failed'].includes(runShow(r))

/**
 * waitingN：「待我处理」的数字，App 传今日「待我处理」组的条数（等人的步骤 + 没被步骤覆盖的阶段任务），两边一致（TSK-0486）；
 * 不传时按执行算
 */
export function SopNav({ sops, runs, view, onSelect, onNew, waitingN }: {
  sops: Sop[]; runs: SopRun[]; view: SopView; onSelect: (v: SopView) => void; onNew: () => void; waitingN?: number
}) {
  const waiting = waitingN ?? runs.filter(isPending).length
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
  const st = runShow(r)
  return (
    <button className="run-row" onClick={() => onOpen(r.id)}>
      <span className="run-name">
        <span className="ellipsis" title={r.title}>{r.title}</span>
        {(() => {
          // 流程名、来源（SOP-06）、逐步确认
          const sub = [showSop ? r.sop.name : '', sourceText(r), r.step_through ? '逐步确认' : ''].filter(Boolean).join(' · ')
          return sub && <span className="run-sop ellipsis">{sub}</span>
        })()}
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

const ORDER = { waiting: 0, failed: 1, running: 2, done: 3, stopped: 4, relaunched: 5 }
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

export function SopRunsPage({ runs, view, onOpen, sops, sop, onOpenSop, onNew, onRerun, onStop, stageItems, onSopsChange }: {
  runs: SopRun[]; view: 'runs' | 'waiting' | 'library'; onOpen: (id: string) => void
  /** 待我处理里「停在等人阶段的任务」一组：今日「待我处理」组的阶段那几条（TSK-0486），点了去任务的流水线 */
  stageItems?: TodayItem[]
  /** 失败页批量重跑（SPEC-sop-4.13~4.19），回各几条 */
  onRerun?: (ids: string[], action: RerunAction) => RerunResult
  /** 批量停止（TSK-0717，SPEC-sop-4.23~4.27）：勾选的、单条的、「停止全部运行中」都走它，回停了、跳过各几条 */
  onStop?: (ids: string[]) => RerunResult
  /** 流程库（view = library）用的全部 SOP；不传用 sopflow 里的 SOPS（App 增删时会同步它） */
  sops?: Sop[]
  /** 打开时预先按这个 SOP 筛（从流程详情「在执行记录里看全部」跳过来） */
  sop?: string
  /** 流程库点卡片打开流程详情 */
  onOpenSop?: (id: string) => void
  onNew?: () => void
  /** 流程库里改了文件夹（建、改名、删、移流程，TSK-0482）：App 按 SOPS 重新取一份 */
  onSopsChange?: () => void
}) {
  if (view === 'library') return <SopLibraryPage sops={sops ?? SOPS} runs={runs} onOpen={onOpenSop} onNew={onNew} onChange={onSopsChange} />
  return <RunList runs={runs} view={view} onOpen={onOpen} sops={sops ?? SOPS} initialSop={sop} onRerun={onRerun} onStop={onStop} stageItems={view === 'waiting' ? stageItems : undefined} />
}

/** 两种重跑的说明，确认框里二选一 */
const RERUN_OPTIONS: { key: RerunAction; label: string; desc: string }[] = [
  { key: 'retry', label: '重试失败的步骤', desc: '在原执行里从失败的那一步接着跑，已完成的步骤不重做；沿用发起时的流程版本，流程后来改过的地方不生效' },
  { key: 'relaunch', label: '按最新流程重新发起', desc: '用原来的输入、流程现在的定义新起一条执行，从头跑；原失败执行标成「已重跑」，移出「失败」，在「全部」里能点到新执行。子流程里失败的会重新发起它所在的整条顶层执行，同一条只发起一次，已重跑过的不再重复发起' },
]

function rerunNote(action: RerunAction, r: RerunResult) {
  const parts = [action === 'retry' ? `重试了 ${r.done.length} 条` : `新发起 ${r.done.length} 条`]
  if (r.skipped.length) parts.push(`跳过 ${r.skipped.length} 条`)
  if (r.failed.length) parts.push(`失败 ${r.failed.length} 条`)
  let text = parts.join('、')
  if (r.done.length) text += '。要调模型的步骤按同时调模型的上限排队，排到了自动开始'
  const why = [...new Set([...r.failed.map((x) => x.error), ...r.skipped.map((x) => x.reason)])].slice(0, 2)
  if (why.length) text += `。原因：${why.join('；')}`
  // 重复点击被挡掉的（已重跑过）不标红（SPEC-sop-4.22）
  const repeatOnly = r.skipped.length > 0 && r.skipped.every((x) => x.reason === RERUN_REASON_RELAUNCHED)
  return { text, bad: r.failed.length > 0 || (!r.done.length && !repeatOnly) }
}

/** 批量重跑确认框：流程发起后改过的有一条就默认「按最新流程」，否则默认「重试」 */
function RerunDialog({ runs, onCancel, onConfirm }: { runs: SopRun[]; onCancel: () => void; onConfirm: (a: RerunAction) => void }) {
  const stale = runs.filter(flowChanged).length
  const [action, setAction] = useState<RerunAction>(stale ? 'relaunch' : 'retry')
  return (
    <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="qs" role="dialog" aria-label="批量重跑">
        <div className="qs-head"><b>批量重跑 {runs.length} 条失败的执行</b></div>
        <div className="rerun-opts" role="radiogroup" aria-label="重跑方式">
          {RERUN_OPTIONS.map((o) => (
            <label key={o.key} className={cls('rerun-opt', action === o.key && 'on')}>
              <input type="radio" name="rerun" checked={action === o.key} onChange={() => setAction(o.key)} />
              <span><b>{o.label}</b><span className="list-sub">{o.desc}</span></span>
            </label>
          ))}
        </div>
        <div className="list-sub">
          {stale ? `其中 ${stale} 条的流程在发起后改过，照旧版本重试多半还会原样失败，所以默认按最新流程重新发起` : '这些执行的流程发起后都没改过，默认在原执行里重试，不重做已完成的步骤'}
        </div>
        <div className="list-sub">要调模型的步骤按同时调模型的上限排队，排到了自动开始</div>
        <div className="act-row">
          <span className="spacer" />
          <button className="act act-quiet" onClick={onCancel}>取消</button>
          <button className="act act-primary" autoFocus onClick={() => onConfirm(action)}>{action === 'retry' ? `重试 ${runs.length} 条` : '重新发起'}</button>
        </div>
      </div>
    </div>
  )
}

/** 停止的结果一句话（SPEC-sop-4.26）：停了几条、跳过几条；已建出的任务不撤回 */
function stopNote(r: RerunResult) {
  if (!r.done.length && !r.skipped.length && !r.failed.length) return { text: '没有运行中的执行要停', bad: false }
  const parts = [`已停止 ${r.done.length} 条`]
  if (r.skipped.length) parts.push(`跳过 ${r.skipped.length} 条（已结束或已停止）`)
  return { text: parts.join('，') + '。已建出的任务不会撤回', bad: false }
}

/**
 * 停止确认框（TSK-0717，SPEC-sop-4.24）：单条、勾选的、「停止全部运行中」（选了流程只停这条流程的）共用，
 * 写明停几条、停了会怎样、什么不撤回。正式产品「停止全部运行中」的条数由后端 dry_run 数（含列表没加载的）
 */
function StopDialog({ title, what, n, onCancel, onConfirm }: { title: string; what?: string; n: number; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="qs" role="dialog" aria-label={title}>
        <div className="qs-head"><b>{title}</b></div>
        {what && <div className="stop-what">{what}</div>}
        <div className="list-sub">停止后执行标为「已终止」：排队等模型的步骤立即出队，正在调模型的请求会取消，等你处理的步骤不再等。</div>
        <div className="list-sub">已经建出的任务、写出的文档、发出的消息不会撤回；停止后不能接着跑，要重来得重新发起。</div>
        <div className="act-row">
          <span className="spacer" />
          <button className="act act-quiet" onClick={onCancel}>取消</button>
          <button className="act act-danger" autoFocus disabled={!n} onClick={onConfirm}>{n ? `停止 ${n} 条` : '没有要停的'}</button>
        </div>
      </div>
    </div>
  )
}

function RunList({ runs, view, onOpen, sops, initialSop, onRerun, onStop, stageItems }: {
  runs: SopRun[]; view: 'runs' | 'waiting'; onOpen: (id: string) => void; sops?: Sop[]; initialSop?: string
  onRerun?: (ids: string[], action: RerunAction) => RerunResult
  onStop?: (ids: string[]) => RerunResult
  stageItems?: TodayItem[]
}) {
  const [st, setSt] = useState<'' | 'running' | 'waiting' | 'done' | 'failed'>('')
  const [sopF, setSopF] = useState(initialSop ?? '')
  const [q, setQ] = useState('')
  const [closed, setClosed] = useState<Set<DaySeg | 'stage'>>(new Set())
  const [more, setMore] = useState<Partial<Record<DaySeg, number>>>({})
  // 失败页多选批量重跑
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  // 停止确认框：ids 是要停的；all 为真是「停止全部运行中」
  const [stopping, setStopping] = useState<{ ids: string[]; title: string; what?: string } | null>(null)
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null)
  const kw = q.trim().toLowerCase()
  useEffect(() => { setMore({}) }, [st, sopF, kw])
  useEffect(() => { setSel(new Set()) }, [st])
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
  // 按显示状态筛：已重跑的失败执行不在「失败」里，只在「全部」里（SPEC-sop-4.21）
  const rows = base.filter((r) => !st || runShow(r) === st)
    .sort((a, b) => ORDER[runShow(a)] - ORDER[runShow(b)] || b.started_at - a.started_at)
  const segOf = daySegOf()
  const segs = DAY_SEGS.map((s) => ({ ...s, xs: rows.filter((r) => segOf(r.started_at) === s.key) })).filter((s) => s.xs.length)
  const toggle = (k: DaySeg | 'stage') => setClosed((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const filtered = !!(st || sopF || kw)
  // 待我处理：执行下面一组「停在等人阶段的任务」（TSK-0486，同今日阶段那几条）；按流程筛选时不出现，搜索按编号和标题
  const stage = view === 'waiting' && !sopF ? (stageItems ?? []).filter((x) => !kw || x.title.toLowerCase().includes(kw)) : []
  // 「失败」分段多选重跑；「执行中」「待我处理」分段和待我处理页多选停止，只有能停的行能勾（SPEC-sop-4.23）
  const pickMode: 'rerun' | 'stop' | null = view === 'runs' && st === 'failed' && onRerun ? 'rerun'
    : onStop && (st === 'running' || st === 'waiting' || view === 'waiting') ? 'stop' : null
  const pickable = (r: SopRun) => pickMode === 'rerun' || (pickMode === 'stop' && isStoppable(r))
  const ordered = segs.flatMap((s) => s.xs).filter(pickable)
  const picking = ordered.length > 0
  const picked = picking ? ordered.filter((r) => sel.has(r.id)) : []
  const allN = Math.min(ordered.length, RERUN_MAX)
  const allPicked = picked.length > 0 && picked.length >= allN
  const pickAll = () => setSel(new Set(ordered.slice(0, RERUN_MAX).map((r) => r.id)))
  const togglePick = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  // 失败行右边的「重试」（SPEC-sop-4.20）：流程发起后改过就按最新流程重跑，否则在原执行里重试；有失败行时每行留一格对齐
  // 已重跑的行同一格放「新执行」
  const hasFailed = (!!onRerun && rows.some((r) => runShow(r) === 'failed' || runShow(r) === 'relaunched')) || (!!onStop && rows.some(isStoppable))
  // 「停止全部运行中」：选了流程只停这条流程的（不看状态分段和搜索），正式产品按条件 POST /api/sop/runs/stop
  const allLive = runs.filter((r) => isStoppable(r) && (!sopF || r.sop_id === sopF))
  const sopName = sopF ? sopOptions.find((o) => o.value === sopF)?.label ?? '这条流程' : ''
  const doStop = (ids: string[]) => {
    const r = onStop!(ids)
    setStopping(null)
    setSel(new Set())
    setNote(stopNote(r))
  }
  const retryOne = (r: SopRun) => {
    const a: RerunAction = flowChanged(r) ? 'relaunch' : 'retry'
    setNote(rerunNote(a, onRerun!([r.id], a)))
  }
  const rowOf = (r: SopRun) => {
    if (!picking && !hasFailed) return <RunRow key={r.id} r={r} onOpen={onOpen} showSop />
    const a = flowChanged(r) ? '重跑' : '重试'
    return (
      <div key={r.id} className={cls('run-pick', !picking && 'run-nopick', sel.has(r.id) && 'picked')}>
        {picking && (pickable(r)
          ? <input type="checkbox" className="run-pick-box" checked={sel.has(r.id)} aria-label={`选中 ${r.title}`} onChange={() => togglePick(r.id)} />
          : <span className="run-pick-box run-pick-none" aria-hidden="true" />)}
        <RunRow r={r} onOpen={onOpen} showSop />
        {hasFailed && (
          <span className="run-act">
            {onStop && isStoppable(r) && (
              <button className="act act-danger-quiet" aria-label={`停止 ${r.title}`} title="停止这条执行：排队的步骤出队，正在调模型的请求取消，已建出的任务不撤回"
                onClick={() => setStopping({ ids: [r.id], title: '停止这条执行', what: r.title })}>停止</button>
            )}
            {runShow(r) === 'failed' && (
              <button className="act" aria-label={`${a} ${r.title}`} onClick={() => retryOne(r)}
                title={a === '重试' ? '在原执行里从失败的那一步接着跑，已完成的步骤不重做' : '流程发起后改过：用原来的输入按流程现在的定义新起一条执行，原执行标成「已重跑」移出失败'}>{a}</button>
            )}
            {runShow(r) === 'relaunched' && (
              <button className="act act-quiet" aria-label={`看 ${r.title} 重跑出来的新执行`} title="这条失败的执行已按最新流程重跑，打开重跑出来的新执行"
                onClick={() => onOpen(r.relaunched_to!)}>新执行</button>
            )}
          </span>
        )}
      </div>
    )
  }
  return (
    <div className="page page-fill">
      <PageTitle parent="SOP" count={rows.length + stage.length} desc={view === 'waiting' ? '这些执行停下来等你：检查输出、确认输入，或处理失败的步骤' : '每一步都留着输入和输出，点进去可以逐步查看'}>{view === 'waiting' ? '待我处理' : '执行记录'}</PageTitle>
      <div className="toolbar">
        {view === 'runs' && (
          <div className="seg">
            {([['', '全部'], ['running', '执行中'], ['waiting', '待我处理'], ['failed', '失败'], ['done', '已完成']] as const).map(([k, l]) => (
              <button key={k} className={cls(st === k && 'on')} onClick={() => setSt(k)}>
                {l}<span className="seg-n">{k ? base.filter((r) => runShow(r) === k).length : base.length}</span>
              </button>
            ))}
          </div>
        )}
        <SearchSelect value={sopF} onChange={setSopF} noneLabel="全部流程" searchPlaceholder="搜流程" options={sopOptions} missingLabel={() => '已删除的流程'} />
        <span className="spacer" />
        {onStop && allLive.length > 0 && (
          <button className="act act-danger-quiet" title={sopF ? '停止这条流程全部执行中、等你处理的执行' : '停止全部执行中、等你处理的执行'}
            onClick={() => setStopping({ ids: allLive.map((r) => r.id), title: `停止${sopF ? `流程「${sopName}」` : '全部流程'}运行中的执行`,
              what: `${sopF ? `流程「${sopName}」` : '全部流程'}现在有 ${allLive.length} 条执行中或等你处理的执行，会全部停止` })}>停止全部运行中</button>
        )}
        <div className="search">
          <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder="搜索执行标题、流程名" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {note && (
        <div className={cls('rerun-note', note.bad && 'bad')} role="status">
          <span>{note.text}</span>
          <button className="act act-quiet" onClick={() => setNote(null)}>知道了</button>
        </div>
      )}
      {!rows.length && !stage.length ? (
        <div className="empty">
          <div className="empty-title">{filtered ? '没有匹配的执行记录' : view === 'waiting' ? '没有等你处理的执行' : '没有执行记录'}</div>
          <div className="list-sub">{filtered ? '换个筛选条件试试' : view === 'waiting' ? '检查点都处理完了' : '从流程库里选一个标准流程开始执行'}</div>
        </div>
      ) : (
        <div className="run-table">
          {picking || hasFailed ? (
            <div className={cls('run-pick run-pick-th', !picking && 'run-nopick')}>
              {picking && (
                <input type="checkbox" className="run-pick-box" checked={allPicked} aria-label={`全选当前筛选结果${pickMode === 'stop' ? '里能停的' : ''}（最多 ${RERUN_MAX} 条）`}
                  ref={(el) => { if (el) el.indeterminate = picked.length > 0 && !allPicked }}
                  onChange={() => (allPicked ? setSel(new Set()) : pickAll())} />
              )}
              <RunHead />
              {hasFailed && <span className="run-act" />}
            </div>
          ) : <RunHead />}
          {segs.map((s) => {
            const open = !closed.has(s.key)
            const n = PAGE + (more[s.key] ?? 0)
            return (
              <div key={s.key} role="group" aria-label={s.label}>
                <ListSegHead label={s.label} n={s.xs.length} open={open} onToggle={() => toggle(s.key)} />
                {open && s.xs.slice(0, n).map(rowOf)}
                {open && <ListSegMore n={s.xs.length - n} onMore={() => setMore((m) => ({ ...m, [s.key]: (m[s.key] ?? 0) + 100 }))} />}
              </div>
            )
          })}
          {stage.length > 0 && (
            <div role="group" aria-label="停在等人阶段的任务">
              <ListSegHead label="停在等人阶段的任务" n={stage.length} open={!closed.has('stage')} onToggle={() => toggle('stage')} />
              {!closed.has('stage') && stage.map((x) => {
                // 列同执行行：任务、阶段、动作、更新时间；sub 是「阶段 · 等什么」
                const [stg, why] = x.sub.split(' · ')
                const row = (
                  <button key={x.id} className="run-row" title={`${x.action}：打开任务的流水线`} onClick={x.onClick}>
                    <span className="run-name">
                      <span className="ellipsis" title={x.title}>{x.title}</span>
                      <span className="run-sop ellipsis">任务 · {why ?? ''}</span>
                    </span>
                    <span><Pill label={stg} color={x.tone === 'danger' ? '#c0352b' : '#b0570b'} /></span>
                    <span className="run-muted">{x.action}</span>
                    <span className="run-muted">{x.at ? timeAgo(x.at) : ''}</span>
                    <span className="run-muted" />
                  </button>
                )
                return hasFailed ? <div key={x.id} className="run-pick run-nopick">{row}<span className="run-act" /></div> : row
              })}
            </div>
          )}
        </div>
      )}
      {picked.length > 0 && (
        <div className="run-bulk" role="toolbar" aria-label={pickMode === 'stop' ? '批量停止' : '批量重跑'}>
          <b>已选 {picked.length} 条</b>
          {picked.length < allN && <button className="act act-quiet" onClick={pickAll}>全选当前筛选结果 {allN} 条</button>}
          {ordered.length > RERUN_MAX && picked.length >= RERUN_MAX && (
            <span className="list-sub" role="note">当前筛选结果有 {ordered.length} 条，一次最多{pickMode === 'stop' ? '停止' : '重跑'} {RERUN_MAX} 条，已选列表里的前 {RERUN_MAX} 条</span>
          )}
          <span className="spacer" />
          {pickMode === 'stop'
            ? <button className="act act-danger" onClick={() => setStopping({ ids: picked.slice(0, RERUN_MAX).map((x) => x.id), title: `停止勾选的 ${Math.min(picked.length, RERUN_MAX)} 条执行` })}>批量停止</button>
            : <button className="act act-primary" onClick={() => setConfirming(true)}>批量重跑</button>}
          <button className="act act-quiet" onClick={() => setSel(new Set())}>取消选择</button>
        </div>
      )}
      {stopping && onStop && (
        <StopDialog title={stopping.title} what={stopping.what} n={stopping.ids.length} onCancel={() => setStopping(null)} onConfirm={() => doStop(stopping.ids)} />
      )}
      {confirming && onRerun && (
        <RerunDialog runs={picked.slice(0, RERUN_MAX)} onCancel={() => setConfirming(false)}
          onConfirm={(a) => {
            const r = onRerun(picked.slice(0, RERUN_MAX).map((x) => x.id), a)
            setConfirming(false)
            setSel(new Set())
            setNote(rerunNote(a, r))
          }} />
      )}
    </div>
  )
}

/* ---------- 流程库 ---------- */

type LibFilter = '' | 'pending' | 'never'

/**
 * 流程库（SPEC-sop-2）。文件夹（TSK-0482，SPEC-sop-2.15 到 2.22）：只有一级；顶部一行文件夹筛选，写法同文档顶栏的分类筛选
 * （fchip「名字 + 数量」，点选、再点回到全部）；「+」新建、选中一个文件夹后铅笔进行内改名 / 删除（同交易自选组的组管理）；
 * 删非空文件夹先确认，里面的流程回「未分类」；搜索不分文件夹；卡片右下角的文件夹名点开移到别的文件夹
 */
function SopLibraryPage({ sops, runs, onOpen, onNew, onChange }: { sops: Sop[]; runs: SopRun[]; onOpen?: (id: string) => void; onNew?: () => void; onChange?: () => void }) {
  const [q, setQ] = useState('')
  const [f, setF] = useState<LibFilter>('')
  // 文件夹筛选：'' 全部，'none' 未分类，其余是文件夹 id
  const [folder, setFolder] = useState('')
  const [, setTick] = useState(0)
  const changed = () => { setTick((n) => n + 1); onChange?.() }
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
  const folders = SOP_FOLDERS
  const cur = folders.find((x) => x.id === folder)
  const key = folder && folder !== 'none' && !cur ? '' : folder
  const inFolder = (s: Sop, k: string) => !k || (k === 'none' ? !folderOf(s) : folderOf(s) === k)
  const nameOf = (s: Sop) => folders.find((x) => x.id === folderOf(s))?.name ?? ''
  const pass = (s: Sop, k: LibFilter) => !k || (k === 'pending' ? (stat.get(s.id)?.pending ?? 0) > 0 : !last.has(s.id))
  const kw = q.trim().toLowerCase()
  const triggers = useEnum('sop_trigger')
  // 有待处理的在前，其余按最近执行时间，没执行过的按名字排在最后；搜索时不看文件夹，文件夹名也能搜到
  const rows = sops.filter((s) => pass(s, f) && (kw ? `${s.name} ${s.desc} ${triggerLabel(triggers, s.trigger)} ${nameOf(s)}`.toLowerCase().includes(kw) : inFolder(s, key)))
    .sort((a, b) => Number((stat.get(b.id)?.pending ?? 0) > 0) - Number((stat.get(a.id)?.pending ?? 0) > 0) || (last.get(b.id) ?? 0) - (last.get(a.id) ?? 0) || a.name.localeCompare(b.name))
  const newHere = () => { newSopFolder.id = cur?.id ?? null; onNew?.() }
  return (
    <div className="page page-fill">
      <PageTitle parent="SOP" count={sops.length} desc="全部标准流程；有执行停下来等你的排在前面" actions={onNew && (
        <button className="btn btn-primary" onClick={newHere}>
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          新建 SOP
        </button>
      )}>流程库</PageTitle>
      <div className="toolbar">
        <div className="seg">
          {([['', '全部'], ['pending', '有待处理'], ['never', '没执行过']] as [LibFilter, string][]).map(([k, l]) => (
            <button key={k} className={cls(f === k && 'on')} onClick={() => setF(k)}>{l}<span className="seg-n">{sops.filter((s) => pass(s, k) && (!!kw || inFolder(s, key))).length}</span></button>
          ))}
        </div>
        <span className="spacer" />
        <div className="search">
          <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder="搜索流程名、说明、触发方式、文件夹" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <FolderBar sops={sops} current={key} searching={!!kw} onPick={setFolder} onChange={changed} />
      {!rows.length ? (
        <div className="empty">
          <div className="empty-title">{kw || f ? '没有匹配的流程' : key ? '这个文件夹里还没有流程' : '还没有标准流程'}</div>
          <div className="list-sub">{kw || f ? '换个筛选条件试试' : key ? '在别的文件夹的卡片上点文件夹名移过来，或在这里新建' : '把反复做的事情编排成 SOP，每次按同样的步骤执行'}</div>
        </div>
      ) : (
        <div className="sop-lib-grid">
          {rows.map((s) => {
            const x = stat.get(s.id)
            const at = last.get(s.id)
            const fid = folderOf(s)
            // 定时触发的卡片下面接一行规则、下次执行和启停（TSK-0463）；开关不能放进按钮里，挂在卡片外面。移到文件夹（TSK-0482）同理
            return (
              <div key={s.id} className="sop-lib-cell">
              <div className="sop-lib-main">
              <button className={cls('sop-lib-card', folders.length > 0 && 'with-folder')} disabled={!onOpen} onClick={() => onOpen?.(s.id)}>
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
              {folders.length > 0 && (
                <SearchSelect variant="plain" className={cls('sop-lib-move', !fid && 'none')} value={fid ?? ''} noneLabel={UNCATEGORIZED} placeholder={UNCATEGORIZED}
                  searchPlaceholder="搜文件夹" align="end" aria-label={`「${s.name}」移到文件夹`} title="移到文件夹"
                  options={folders.map((d) => ({ value: d.id, label: d.name }))}
                  onChange={(v) => { if ((v || null) !== fid) { moveSops([s.id], v || null); changed() } }} />
              )}
              </div>
              <SchedLine sop={s} className="sop-lib-sched" />
              <IMLine sop={s} className="sop-lib-sched" />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 文件夹一行（SPEC-sop-2.15 到 2.19）：全部、各文件夹、未分类（各带数量，按全部流程算），后面是新建和改名 / 删除当前文件夹 */
function FolderBar({ sops, current, searching, onPick, onChange }: { sops: Sop[]; current: string; searching: boolean; onPick: (k: string) => void; onChange: () => void }) {
  const [edit, setEdit] = useState<{ id: string; name: string } | null>(null)
  const [ask, setAsk] = useState(false)
  const folders = SOP_FOLDERS
  const cur = folders.find((x) => x.id === current)
  const count = (k: string) => sops.filter((s) => (k === 'none' ? !folderOf(s) : folderOf(s) === k)).length
  const issue = edit ? folderNameError(edit.name, edit.id === 'new' ? undefined : edit.id) : ''
  const commit = () => {
    if (!edit || issue) return
    if (edit.id === 'new') onPick(addFolder(edit.name).id)
    else renameFolder(edit.id, edit.name)
    setEdit(null)
    onChange()
  }
  const remove = () => {
    if (!cur) return
    removeFolder(cur.id)
    setAsk(false); setEdit(null); onPick(''); onChange()
  }
  const plus = <svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
  return (
    <>
      <div className={cls('sop-folders', searching && 'searching')} role="group" aria-label="按文件夹筛选">
        {folders.length > 0 && (
          <>
            <button className={cls('fchip', !current && 'on')} onClick={() => onPick('')}>全部<span className="seg-n">{sops.length}</span></button>
            {[...folders.map((x) => ({ key: x.id, label: x.name })), { key: 'none', label: UNCATEGORIZED }].map((c) => (
              <button key={c.key} className={cls('fchip', current === c.key && 'on')} title={c.key === 'none' ? '没放进文件夹的流程' : c.label}
                onClick={() => onPick(current === c.key ? '' : c.key)}>
                <span className="sop-folder-name">{c.label}</span><span className="seg-n">{count(c.key)}</span>
              </button>
            ))}
          </>
        )}
        <button className="icon-btn icon-btn-sm" title="新建文件夹" aria-label="新建文件夹" onClick={() => { setAsk(false); setEdit({ id: 'new', name: '' }) }}>{plus}</button>
        {!folders.length && <button className="sop-folder-hint" onClick={() => setEdit({ id: 'new', name: '' })}>新建文件夹，给流程分类</button>}
        {cur && (
          <button className="icon-btn icon-btn-sm" title={`改名或删除「${cur.name}」`} aria-label={`改名或删除「${cur.name}」`} onClick={() => { setAsk(false); setEdit({ id: cur.id, name: cur.name }) }}>
            <svg viewBox="0 0 16 16" width="12" height="12"><path d="M3 13h2.5L13 5.5 10.5 3 3 10.5V13Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
          </button>
        )}
        {searching && folders.length > 0 && <span className="sop-folder-note">搜索时在全部文件夹里找</span>}
      </div>
      {edit && !ask && (
        <div className="sop-folder-edit">
          <input autoFocus value={edit.name} placeholder="文件夹名称" aria-label="文件夹名称" onChange={(e) => setEdit({ ...edit, name: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEdit(null) }} />
          <button className="btn btn-primary btn-sm" disabled={!!issue} onClick={commit}>{edit.id === 'new' ? '新建' : '保存'}</button>
          {edit.id !== 'new' && cur && <button className="btn btn-ghost btn-sm danger-text" onClick={() => (count(cur.id) ? setAsk(true) : remove())}>删除文件夹</button>}
          <button className="btn btn-ghost btn-sm" onClick={() => setEdit(null)}>取消</button>
          {edit.name.trim() && issue && <span className="sop-folder-err">{issue}</span>}
        </div>
      )}
      {/* 删非空文件夹先确认（SPEC-sop-2.18）；正式产品是确认弹窗 */}
      {ask && cur && (
        <div className="sop-folder-edit sop-folder-ask" role="alertdialog" aria-label={`删除文件夹「${cur.name}」？`}>
          <span><b>删除文件夹「{cur.name}」？</b>里面的 {count(cur.id)} 个流程移到「{UNCATEGORIZED}」，流程本身不删、不改。</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setAsk(false)}>取消</button>
          <button className="btn btn-danger btn-sm" onClick={remove}>删除文件夹</button>
        </div>
      )}
    </>
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
        {/* 所在文件夹（TSK-0482，SPEC-sop-5.19）：有文件夹时才写 */}
        {SOP_FOLDERS.length > 0 && <span>文件夹：{SOP_FOLDERS.find((x) => x.id === folderOf(sop))?.name ?? UNCATEGORIZED}</span>}
        <span>触发：{triggerLabel(triggers, sop.trigger)}</span>
        <span>{sop.steps.length} 个步骤</span>
        <span>{decides} 个分支节点</span>
        <span>{reviews} 个需要人处理的节点</span>
      </div>
      <SchedLine sop={sop} className="sop-detail-sched" />
      <IMLine sop={sop} className="sop-detail-sched" />

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

export function SopStartDrawer({ sop, initial, object, onClose, onStart }: {
  sop: Sop
  initial?: Json
  /** 在任务上发起（SOP-06）：抽屉上写明关联的任务，输入已按任务字段预填 */
  object?: { ref: string; title: string }
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
          {object && <div className="sop-start-object">关联任务 {object.ref} {object.title}，输入已按任务字段预填，可以改</div>}
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
                <span className={cls('fnode-st', `fst-${rs.status}`, isQueued(rs) && 'fst-queued')}>
                  {rs.status === 'running' && !isQueued(rs) && !isProviderWait(rs) && <span className="spinner spinner-xs" />}
                  {route ? `走「${route}」` : stepLook(rs).label}
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

function Inspector({ run, index, onAct, onOpenSettings }: { run: SopRun; index: number; onAct: (a: RunAction) => void; onOpenSettings?: () => void }) {
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
          <Pill {...stepLook(step)} />
          {step.edited && <span className="edited-tag">{{ input: '输入被人工修改', output: '输出被人工修改', route: '分支由人选择' }[step.edited]}</span>}
          {!!step.round && <span className="edited-tag">第 {step.round} 轮</span>}
        </div>
        <div className="insp-desc">
          {def.desc}
          {deps.length > 1 && <> · 汇合 {deps.map((k) => sop.steps.find((x) => x.key === k)!.name).join('、')}</>}
          {branchOf && <> · 属于「{branchOf.name}」的「{branchLabel}」分支</>}
        </div>
      </div>

      {step.rework_reason && (
        <div className="insp-route">
          <span className="insp-route-k">第 {step.round} 轮</span>被退回重做<span className="insp-route-why">{step.rework_reason}</span>
        </div>
      )}
      {def.kind === 'loopback' && !!step.loops && (
        <div className="insp-route">
          <span className="insp-route-k">已退回</span>{step.loops} 轮<span className="insp-route-why">最多 {def.config?.max_rounds || 3} 轮，退回「{sop.steps.find((x) => x.key === def.config?.target)?.name ?? def.config?.target}」</span>
        </div>
      )}
      {step.claude && (
        <div className="insp-route">
          <span className="insp-route-k">Claude Code</span>执行 {step.claude.run_id}
          <span className="insp-route-why">{step.claude.task_id ? `执行记录留在任务 ${step.claude.task_id} 上，正式产品里点这里跳到任务抽屉的这次执行` : `目录 ${step.claude.workdir ?? ''}`}</span>
        </div>
      )}
      {routeLabel && (
        <div className="insp-route">
          <span className="insp-route-k">判断结果</span>走「{routeLabel}」分支<span className="insp-route-why">{step.route_reason}</span>
        </div>
      )}
      {step.status === 'bypassed' && (
        <div className="insp-banner muted">这一步所在的分支没被选中，没有执行，也没有输入输出。</div>
      )}
      {!run.stopped && isHeld(step) && (
        <div className="insp-banner danger">
          <b>超出上限，已暂停</b>{step.hold!.reason}。放行只放这一次，之后的执行照样按上限拦；要长期放宽到设置里调高上限。
          <div className="act-row">
            <button className="act act-primary" onClick={() => onAct({ kind: 'confirm-input', step: index })}>放行这一次</button>
            <button className="act act-quiet" onClick={() => onAct({ kind: 'skip', step: index })}>跳过这一步</button>
            {onOpenSettings && <button className="act act-quiet" onClick={onOpenSettings}>调整上限</button>}
          </div>
        </div>
      )}
      {!run.stopped && step.status === 'paused' && !isHeld(step) && (
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
          {/* 已按最新流程重跑过的不能再重试、跳过（SPEC-sop-7.43） */}
          {run.relaunched_to ? <div>这次执行已按最新流程重跑，不能再重试或跳过，到新执行里处理</div> : (
            <div className="act-row">
              <button className="act act-primary" onClick={() => onAct({ kind: 'retry', step: index })}>重试</button>
              <button className="act act-quiet" onClick={() => onAct({ kind: 'skip', step: index })}>跳过这一步</button>
            </div>
          )}
        </div>
      )}
      {isProviderWait(step) && (
        <div className="insp-banner warn">
          <div><b>等服务商恢复</b>服务商「{step.provider_wait!.provider}」不可用（{step.provider_wait!.reason}），这一步已挂起，
            {new Date(step.provider_wait!.retry_at).toLocaleTimeString('zh-CN', { hour12: false })} 自动重跑，服务商恢复后会接着跑这条执行，不新建执行。最多等到执行发起后 24 小时，过了才标失败。</div>
        </div>
      )}
      {isQueued(step) && (
        <div className="insp-banner muted">
          {step.queue!.slot === 'claude_code' ? <>
            <div><b>排队中</b>在等 Claude Code 名额，前面还有 {step.queue!.ahead} 个。同时跑的 Claude Code 步骤数有上限，多出来的按先来后到排队，排到了自动发起。</div>
            {onOpenSettings && <div className="act-row"><button className="act act-quiet" onClick={onOpenSettings}>调整同时跑的 Claude Code 步骤数</button></div>}
          </> : <>
            <div><b>排队中</b>在等模型名额，前面还有 {step.queue!.ahead} 个。同时调模型的步骤数有上限，多出来的按先来后到排队，排到了自动开始。</div>
            {onOpenSettings && <div className="act-row"><button className="act act-quiet" onClick={onOpenSettings}>调整同时调模型的步骤数</button></div>}
          </>}
        </div>
      )}
      {step.status === 'running' && !isQueued(step) && !isProviderWait(step) && (
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

export function SopRunView({ run, onBack, onAct, onRerun, onOpenSettings, onOpenRun }: {
  run: SopRun
  onBack: () => void
  onAct: (a: RunAction) => void
  onRerun: () => void
  /** 排队中的步骤带「调整同时调模型的步骤数」，去设置 > SOP 编排（SOP-07） */
  onOpenSettings?: () => void
  /** 批量重跑新发起的执行点「重跑自原执行」打开原执行（SPEC-sop-7.40） */
  onOpenRun?: (id: string) => void
}) {
  const sop = run.sop
  const st = runShow(run)
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
            {sourceText(run) && <span>来源：{sourceText(run)}</span>}
            {run.source === 'manual' && run.source_ref && onOpenRun && <button className="run-origin" onClick={() => onOpenRun(run.source_ref!)}>重跑自原执行</button>}
            {run.relaunched_to && onOpenRun && <button className="run-origin" onClick={() => onOpenRun(run.relaunched_to!)}>已重跑，看新执行</button>}
            <span>开始于 {timeAgo(iso(run.started_at))}</span>
            <span>{ended ? '共' : '已'}用时 {runDur(run)}</span>
            {waiting > 1 && <span className="run-head-warn">{waiting} 个步骤等你处理</span>}
          </div>
        </div>
      </div>
      <div className="run-flow">
        <FlowGraph sop={sop} run={run} selected={index} onSelect={(i) => setPicked(i === focus ? null : i)} />
      </div>
      <Inspector key={index} run={run} index={index} onAct={act} onOpenSettings={onOpenSettings} />
    </div>
  )
}

/* ---------- 设置 > SOP 编排（SOP-07）：同时调模型的步骤数 ---------- */

/**
 * 整个 SOP 跨所有执行同时调模型的步骤数，1..16，默认 2；改了立即生效：调大马上放排队的进来，调小时正在调的不打断。
 * 正式产品存在插件设置里（GET / PATCH /api/sop/settings），超出范围显示后端 400 的原因
 */
export function SopSettingsPage({ value, runs, onSave, gov, onSaveGov }: {
  value: number; runs: SopRun[]; onSave: (n: number) => void
  /** 流水线治理（AUTO-12，SPEC-sop-15） */
  gov: Governance; onSaveGov: (p: Partial<Governance>) => void
}) {
  const [txt, setTxt] = useState(String(value))
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const n = Number(txt)
  const bad = !/^\d+$/.test(txt.trim()) ? '填 1 到 16 的整数' : n < 1 || n > MODEL_CONCURRENCY_MAX ? `同时调模型的步骤数要在 1 到 ${MODEL_CONCURRENCY_MAX} 之间` : null
  const save = () => {
    if (bad) { setNote({ ok: false, text: `没保存：${bad}` }); return }
    if (n === value) return
    onSave(n)
    setNote({ ok: true, text: `已保存：最多同时 ${n} 个步骤调模型，立即生效` })
  }
  let running = 0
  let queued = 0
  let cRunning = 0
  let cQueued = 0
  for (const r of runs) {
    if (r.stopped) continue
    r.steps.forEach((s, i) => {
      if (s.status !== 'running') return
      if (isClaudeKind(r.sop.steps[i].kind)) {
        if (s.queue) cQueued++
        else if (s.cgated) cRunning++
        return
      }
      if (!isModelKind(r.sop.steps[i].kind)) return
      if (s.queue) queued++
      else running++
    })
  }
  return (
    <div className="sop-settings">
      <div className="sop-settings-title">执行并发</div>
      <div className="field">
        <span className="field-label">同时调模型的步骤数</span>
        <div className="sop-settings-row">
          <input type="number" min={1} max={MODEL_CONCURRENCY_MAX} step={1} inputMode="numeric" aria-label="同时调模型的步骤数" className={cls(note && !note.ok && 'bad')}
            value={txt} onChange={(e) => { setTxt(e.target.value); setNote(null) }} onKeyDown={(e) => e.key === 'Enter' && save()} />
          <span className="muted">个</span>
          <button className="btn btn-outline" disabled={txt.trim() === String(value)} onClick={save}>保存</button>
        </div>
        {note ? <span className={note.ok ? 'ok-text' : 'field-err'}>{note.text}</span>
          : <span className="field-hint-line">本机推理慢时调小，消息多时多出来的步骤排队。AI、提取、分类、逐项处理、Agent 节点算在内，跨所有执行一起算；改了立即生效，调小时正在调的不打断</span>}
      </div>
      <div className="sop-settings-now muted">此刻 {running} 个步骤在调模型{queued ? `，${queued} 个在排队` : '，没有排队的'}</div>

      <div className="sop-settings-title">流水线治理</div>
      <GovField label="同时跑的 Claude Code 步骤数" unit="个" min={1} max={GOVERNANCE_MAX.claude_concurrency} value={gov.claude_concurrency}
        hint="跨所有执行一起算，多出来的 Claude Code 步骤排队，排到了自动发起；改了立即生效，调小时正在跑的不打断"
        saved={(v) => `已保存：最多同时 ${v} 个 Claude Code 步骤，立即生效`} onSave={(v) => onSaveGov({ claude_concurrency: v })} />
      <div className="sop-settings-now muted">此刻 {cRunning} 个 Claude Code 步骤在跑{cQueued ? `，${cQueued} 个在排队` : '，没有排队的'}</div>
      <GovField label="每个需求最多跑 Claude Code 的次数" unit="次" min={0} max={GOVERNANCE_MAX.task_max_claude_runs} value={gov.task_max_claude_runs}
        hint="按步骤关联的任务累计，重试、评审退回、测试退回的每一轮都算；没关联任务的按同一次流水线算。到了上限，下一次发起前这一步暂停，发通知等你放行。0 是不限"
        saved={(v) => `已保存：每个需求最多 ${v === 0 ? '不限' : `${v} 次`}`} onSave={(v) => onSaveGov({ task_max_claude_runs: v })} />
      <GovField label="每个需求 Claude Code 累计时长上限" unit="分钟" min={0} max={GOVERNANCE_MAX.task_max_claude_minutes} value={gov.task_max_claude_minutes}
        hint="同一个需求历次 Claude Code 跑的时间加起来（在跑的算到现在）。到了上限，下一次发起前暂停；正在跑的那次不打断，它有自己的超时。0 是不限"
        saved={(v) => `已保存：每个需求累计最多 ${v === 0 ? '不限' : `${v} 分钟`}`} onSave={(v) => onSaveGov({ task_max_claude_minutes: v })} />
      <div className="muted">token 上限暂不支持：Claude Code 的执行记录里没有 token 用量，目前只按次数和时长控制。</div>
    </div>
  )
}

/** 流水线治理的一项整数设置（SPEC-sop-15.2 到 15.4）：min 为 0 的项 0 是不限 */
function GovField({ label, unit, min, max, value, hint, saved, onSave }: {
  label: string; unit: string; min: number; max: number; value: number; hint: string; saved: (v: number) => string; onSave: (v: number) => void
}) {
  const [txt, setTxt] = useState(String(value))
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const n = Number(txt)
  const bad = !/^\d+$/.test(txt.trim()) || n < min || n > max ? (min === 0 ? `填 0 到 ${max} 的整数，0 是不限` : `填 ${min} 到 ${max} 的整数`) : null
  const save = () => {
    if (bad) { setNote({ ok: false, text: `没保存：${bad}` }); return }
    if (n === value) return
    onSave(n)
    setNote({ ok: true, text: saved(n) })
  }
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="sop-settings-row">
        <input type="number" min={min} max={max} step={1} inputMode="numeric" aria-label={label} className={cls(note && !note.ok && 'bad')}
          value={txt} onChange={(e) => { setTxt(e.target.value); setNote(null) }} onKeyDown={(e) => e.key === 'Enter' && save()} />
        <span className="muted">{unit}</span>
        <button className="btn btn-outline" disabled={txt.trim() === String(value)} onClick={save}>保存</button>
      </div>
      {note ? <span className={note.ok ? 'ok-text' : 'field-err'}>{note.text}</span> : <span className="field-hint-line">{hint}</span>}
    </div>
  )
}
