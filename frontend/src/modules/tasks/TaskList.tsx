// 任务列表（SPEC-tasks-2）：状态分段按钮筛选、按截止日分段可折叠、每段先露 30 条。
// 只管展示和本地筛选，数据由 Page 从接口层取好传进来。
import { useMemo, useState, type CSSProperties } from 'react'
import { localDay, type DictItem, type ObjectStatus, type WorkObject } from '../../core/data'
import {
  Button, EmptyState, ErrorState, IconClose, IconSearch, ListSegHead, ListSegMore, LoadingState, PageTitle, Pill,
  SearchSelect, cls,
} from '../../core/ui'
import {
  ALL, MORE_STEP, OPEN, PAGE, REVIEW, dueText, isOverdue, matchStatus, prioText, priorityRank, segment, sortTasks, statusButtons,
  terminalOf, timeAgo, type DueSeg, type StatusFilter,
} from './model'
import { SOURCE_VIEW, isSourceKind, type SourceKind } from './sourceModel'
import { SourceTag } from './SourceTag'

/** 全部任务、逾期，加五个来源视图（SPEC-tasks-3） */
export type TaskView = 'all' | 'overdue' | SourceKind

const TITLE: Record<'all' | 'overdue', string> = { all: '全部任务', overdue: '逾期任务' }
const DESC: Record<'all' | 'overdue', string> = {
  all: '人工创建、IM 消息转来、Webhook 推来的任务都在这里，按截止日分段',
  overdue: '过了截止日还没完成的任务，最早到期的在前',
}
// 项目筛选里「不属于项目」的值
const NO_PROJECT = '-'

export function TaskList({
  view, tasks, loading, error, onRetry, statuses, priorities, projects,
  status, onStatus, search, onSearch, q, selected, drawerOpen, onOpen, onNew, onToggleDone, now: nowProp, hookName = noHook, onGoHooks,
}: {
  view: TaskView
  tasks: WorkObject[]
  loading?: boolean
  error?: unknown
  onRetry?: () => void
  statuses: ObjectStatus[]
  priorities: DictItem[]
  projects: { id: string; title: string }[]
  status: StatusFilter
  onStatus: (f: StatusFilter) => void
  /** 搜索框里的字 */
  search: string
  onSearch: (v: string) => void
  /** 已经发给后端的搜索词（防抖后） */
  q: string
  selected: string | null
  /** 抽屉开着：列表窄时改成窄列（标题两行，不显示来源、负责人、截止） */
  drawerOpen?: boolean
  onOpen: (t: WorkObject) => void
  onNew: () => void
  /** 点完成圆圈：未完成的标为完成、已完成的改回待办、待验收的先确认（由上层处理） */
  onToggleDone?: (t: WorkObject) => void
  /** 测试里固定「今天」 */
  now?: Date
  /** 来源标签上的 Webhook 名；undefined 是还没取到，null 是已删除 */
  hookName?: (id: string) => string | null | undefined
  /** Webhook 来源视图空状态里的「Webhook 接入」 */
  onGoHooks?: () => void
}) {
  // 「今天」取页面打开那一刻，渲染里不直接 new Date()
  const [opened] = useState(() => new Date())
  const now = nowProp ?? opened
  const [prio, setPrio] = useState('')
  const [proj, setProj] = useState('')
  const [closed, setClosed] = useState<Set<DueSeg>>(() => new Set())
  // 各段多露的条数；换了视图或筛选条件（sig 变了）就作废，重新只露 30 条
  const sig = [view, status, prio, proj, q].join('\n')
  const [more, setMore] = useState<{ sig: string; n: Partial<Record<DueSeg, number>> }>({ sig, n: {} })
  const extra = more.sig === sig ? more.n : {}

  const terminal = useMemo(() => terminalOf(statuses), [statuses])
  const rank = useMemo(() => priorityRank(priorities), [priorities])
  const today = localDay(now)
  const statusOf = (k: string) => statuses.find((s) => s.key === k)
  const prioOf = (k: string) => priorities.find((p) => p.key === k)
  const projName = (t: WorkObject) => t.project_title || projects.find((p) => p.id === t.project_id)?.title

  const base = tasks.filter((t) => !proj || (proj === NO_PROJECT ? !t.project_id : t.project_id === proj))
  const rows = sortTasks(base.filter((t) => matchStatus(t, status, terminal) && (!prio || t.priority === prio)), rank)
  const segs = segment(rows, terminal, now)
  const { head, rest } = statusButtons(statuses)
  const countOf = (f: StatusFilter) => base.filter((t) => matchStatus(t, f, terminal)).length
  const showCounts = !loading && !error

  const toggle = (k: DueSeg) => {
    const n = new Set(closed)
    if (n.has(k)) n.delete(k)
    else n.add(k)
    setClosed(n)
  }
  const showMore = (k: DueSeg) => setMore({ sig, n: { ...extra, [k]: (extra[k] ?? 0) + MORE_STEP } })
  const clearFilters = () => { setPrio(''); setProj(''); onSearch('') }

  const row = (t: WorkObject) => {
    const st = statusOf(t.status)
    const pr = prioOf(t.priority)
    const overdue = isOverdue(t, terminal, today)
    const done = terminal(t.status)
    const pname = projName(t)
    return (
      <div key={t.id} role="button" tabIndex={0} aria-label={`${t.ref} ${t.title}`}
        className={cls('task-row', selected === t.id && 'sel', done && 'is-done')}
        onClick={() => onOpen(t)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(t) } }}>
        {/* 完成圆圈：点它不打开抽屉 */}
        <button type="button" className={cls('task-check', done && 'on')} disabled={!onToggleDone}
          title={checkTip(t.status, done)} aria-label={`${checkTip(t.status, done)}：${t.ref}`}
          onClick={(e) => { e.stopPropagation(); onToggleDone?.(t) }}
          onKeyDown={(e) => e.stopPropagation()}>{done && <CheckMark />}</button>
        <span className="task-main">
          <span className="task-title"><span className="task-ref">{t.ref}</span><span className="ellipsis">{t.title}</span></span>
          <span className="task-meta">
            <SourceTag task={t} hookName={hookName} />
            {t.project_id && <span className="src-tag src-proj" title={pname}>{pname ?? '已删除的项目'}</span>}
            <span>{timeAgo(t.created_at, now)}创建</span>
          </span>
        </span>
        <span>
          {t.priority && (
            <span className="prio" title={pr?.description || undefined} style={{ '--c': pr?.color || 'var(--faint)' } as CSSProperties}>
              {prioText(t.priority, pr)}
            </span>
          )}
        </span>
        <span className="ellipsis run-muted">{t.owner_name || t.owner || '未分配'}</span>
        <span className={cls('run-muted', overdue && 'danger-text')}>{dueText(t, today)}{overdue ? ' 逾期' : ''}</span>
        <span><Pill label={st?.label ?? t.status} color={st?.color} /></span>
      </div>
    )
  }

  const filtered = !!(q || prio || proj)
  let body
  if (error) body = <ErrorState error={error} onRetry={onRetry} />
  else if (loading) body = <LoadingState />
  else if (rows.length === 0) {
    if (filtered) {
      body = <EmptyState title="没有匹配的任务" action={<Button variant="outline" onClick={clearFilters}>清掉筛选条件</Button>} />
    } else if (base.length > 0 && status !== ALL) {
      body = status === OPEN
        ? <EmptyState title="没有未完成的任务" action={<Button variant="outline" onClick={() => onStatus(ALL)}>看全部</Button>} />
        : <EmptyState title="没有处于该状态的任务" action={<Button variant="outline" onClick={() => onStatus(OPEN)}>切回「未完成」</Button>} />
    } else if (view === 'overdue') {
      body = <EmptyState title="没有逾期的任务" desc="截止日都还没到，或者已经做完了" />
    } else if (isSourceKind(view)) {
      // 来源视图各有各的空状态（SPEC-tasks-3.5 到 3.7）；在这里新建的是人工任务，只有人工创建给「新建任务」
      const action = view === 'manual' ? <Button variant="outline" onClick={onNew}>新建任务</Button>
        : view === 'webhook' && onGoHooks ? <Button variant="outline" onClick={onGoHooks}>Webhook 接入</Button> : undefined
      body = <EmptyState title="这里还没有任务" desc={SOURCE_VIEW[view].empty} action={action} />
    } else {
      body = <EmptyState title="这里还没有任务" desc="点右上角新建一个" />
    }
  } else {
    body = (
      <div className={cls('task-table', drawerOpen && 'task-table-docked')}>
        <div className="task-row task-th" aria-hidden="true"><span /><span>任务</span><span>优先级</span><span>负责人</span><span>截止</span><span>状态</span></div>
        {segs.map((s) => {
          const open = !closed.has(s.key)
          const n = PAGE + (extra[s.key] ?? 0)
          return (
            <div key={s.key} role="group" aria-label={s.label}>
              <ListSegHead label={s.label} n={s.rows.length} open={open} onToggle={() => toggle(s.key)} tone={s.key === 'overdue' ? 'danger' : undefined} />
              {open && s.rows.slice(0, n).map(row)}
              {open && <ListSegMore n={s.rows.length - n} onMore={() => showMore(s.key)} />}
            </div>
          )
        })}
      </div>
    )
  }

  const filters: [StatusFilter, string][] = [[OPEN, '未完成'], ...head.map((s): [string, string] => [s.key, s.label]), [ALL, '全部']]
  return (
    <div className="tasks-page">
      <PageTitle parent="任务" count={showCounts ? rows.length : undefined} desc={isSourceKind(view) ? SOURCE_VIEW[view].desc : DESC[view]}
        actions={<Button variant="primary" onClick={onNew}><PlusMark />新建任务</Button>}>
        {isSourceKind(view) ? SOURCE_VIEW[view].title : TITLE[view]}
      </PageTitle>
      <div className="toolbar">
        <div className="seg" role="group" aria-label="状态">
          {filters.map(([k, l]) => (
            <button key={k} type="button" className={cls(status === k && 'on')} aria-pressed={status === k} onClick={() => onStatus(k)}>
              {l}{showCounts && <span className="seg-n">{countOf(k)}</span>}
            </button>
          ))}
        </div>
        {rest.length > 0 && (
          <SearchSelect value={rest.some((s) => s.key === status) ? status : ''} placeholder="更多状态" searchPlaceholder="搜状态"
            aria-label="更多状态"
            options={rest.map((s) => ({ value: s.key, label: s.label, hint: showCounts ? String(countOf(s.key)) : undefined }))}
            onChange={(v) => onStatus(v || OPEN)} />
        )}
        <div className={cls('chip chip-select', prio && 'chip-on')}>
          <select value={prio} aria-label="优先级" onChange={(e) => setPrio(e.target.value)}>
            <option value="">全部优先级</option>
            {priorities.filter((p) => !p.archived_at || p.key === prio).map((p) => <option key={p.key} value={p.key}>{prioText(p.key, p)}</option>)}
          </select>
        </div>
        <SearchSelect value={proj} onChange={setProj} noneLabel="全部项目" placeholder="全部项目" searchPlaceholder="搜项目" aria-label="项目"
          options={[...projects.map((p) => ({ value: p.id, label: p.title })), { value: NO_PROJECT, label: '不属于项目' }]}
          missingLabel={() => '已删除的项目'} />
        <span className="spacer" />
        <div className="search">
          <IconSearch />
          <input type="search" placeholder="搜索标题、描述、编号" aria-label="搜索任务" value={search}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && search) { e.preventDefault(); onSearch('') } }} />
          {search && <button type="button" className="search-clear" aria-label="清空" title="清空" onClick={() => onSearch('')}><IconClose size={10} /></button>}
        </div>
      </div>
      {body}
    </div>
  )
}

const noHook = () => undefined

// 待验收的点了是验收通过（SPEC-tasks-2.11、5.27）
function checkTip(status: string, done: boolean) {
  if (status === REVIEW) return '验收通过'
  return done ? '标为待办' : '标为已完成'
}

function CheckMark() {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function PlusMark() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}
