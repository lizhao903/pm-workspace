// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置里的「运行异常」（INC-01b），照原型 web-next/src/incidents.tsx IncidentsPage（SPEC-settings-18）：
// 按状态、级别、模块筛，同模块同指纹前缀到 5 条合并成一行，点行开抽屉（SPEC-settings-19）。
// 顶栏右边是「自动巡检」：有没有动作为「运行异常巡检」的定时任务，没有时一键按默认建一条。
import { Fragment, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import {
  INCIDENT_STATUS, QueryState, errorText, useCreateSchedule, useIncidents, useObject, useObjectTypes, useSchedules,
  type Incident,
} from '../../../core/data'
import { Button, EmptyState, IconChevronRight, IconClose, IconSearch, PageTitle, Pill, cls } from '../../../core/ui'
import { describeRule, doneKey, fullRule } from '../../tasks'
import { timeAgo } from '../providers/model'
import { IncidentDrawer } from './IncidentDrawer'
import {
  HOT, LEVEL_FILTERS, LEVEL_LABEL, PAGE, STATUS_FILTERS, defaultSweepInput, entriesOf, filterIncidents, findSweep, headCount, matchStatus,
  modulesOf, sweepOf, sweepText, type LevelFilter, type StatusFilter,
} from './model'
import './incidents.css'

const DESC = '系统运行中出的问题，同一个问题合并记次数；能转成研发任务去优化'
const EMPTY_DESC = '连接器、模型服务商、Webhook、SOP、原型和页面本身出的问题都会记在这里'
const ago = (iso: string) => timeAgo(Date.parse(iso))

/** 已转任务的行在状态后面写任务编号，任务完成了再加「已完成」；后端带了 task_ref 就不再回查任务 */
function TaskRef({ x, done }: { x: Incident; done?: string }) {
  const t = useObject(x.task_ref ? null : x.task_id)
  const ref = x.task_ref || t.data?.ref
  if (!ref) return null
  const finished = x.task_ref ? x.task_done : !!done && t.data?.status === done
  return <span className="inc-ref">{ref}{finished && ' 已完成'}</span>
}

/** 顶栏「自动巡检」（INC-01b）：有巡检定时任务时写规则和条件、去定时任务页改；没有时一键开启 */
function SweepBar() {
  const q = useSchedules()
  const create = useCreateSchedule()
  if (!q.data) return null
  const s = findSweep(q.data)
  const a = s && sweepOf(s)
  if (s && a) {
    const rule = describeRule(fullRule(s.rule))
    return (
      <span className="inc-sweep" data-testid="incident-sweep">
        <span className={cls('inc-sweep-dot', s.enabled && 'on')} aria-hidden="true" />
        <span className="ellipsis">自动巡检：{s.enabled ? `${rule}，${sweepText(a)}` : '已停用'}</span>
        <Link className="inc-link" to={`/tasks/schedules?open=${encodeURIComponent(s.id)}`}>去定时任务改</Link>
      </span>
    )
  }
  return (
    <span className="inc-sweep" data-testid="incident-sweep">
      {create.isError && <span className="inc-err" role="alert">没开成：{errorText(create.error)}</span>}
      <Button size="sm" disabled={create.isPending} title="建一条定时任务：每天 9:00 把未处理的错误各建一条任务交给 Claude Code 修，可以去定时任务页改"
        onClick={() => create.mutate(defaultSweepInput())}>{create.isPending ? '开启中' : '开启自动巡检'}</Button>
    </span>
  )
}

export function IncidentsSection() {
  const q = useIncidents()
  const types = useObjectTypes()
  const done = doneKey(types.data?.find((t) => t.id === 'task')?.statuses ?? [])
  const [st, setSt] = useState<StatusFilter>('open')
  const [level, setLevel] = useState<LevelFilter>('')
  const [mod, setMod] = useState('')
  const [kw, setKw] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [openGroups, setOpenGroups] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)

  // ?open=<id>：今日待办、「出错了」页的链接打开那一条；用过就从地址里去掉
  const [search, setSearch] = useSearchParams()
  const openParam = search.get('open')
  const [usedOpen, setUsedOpen] = useState<string | null>(null)
  if (!openParam && usedOpen) setUsedOpen(null)
  if (openParam && openParam !== usedOpen) {
    setUsedOpen(openParam)
    setSelected(openParam)
  }
  useEffect(() => {
    if (!openParam) return
    setSearch((p) => { const n = new URLSearchParams(p); n.delete('open'); return n }, { replace: true })
  }, [openParam, setSearch])

  // 改筛选回到 50 行（SPEC-settings-18.9）
  const filter = (f: () => void) => { f(); setLimit(PAGE) }
  const list = q.data ?? []
  const open = selected ? list.find((x) => x.id === selected) : undefined

  const row = (x: Incident, child?: boolean) => (
    <div key={x.id} role="button" tabIndex={0} data-incident={x.id}
      className={cls('inc-row', child && 'inc-child', selected === x.id && 'sel', x.status !== 'open' && 'is-done')}
      onClick={() => setSelected(x.id)} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) setSelected(x.id) }}>
      <span className={cls('inc-level', `il-${x.level}`)} title={LEVEL_LABEL[x.level]} aria-label={LEVEL_LABEL[x.level]} />
      <span className="inc-main">
        <span className="inc-title ellipsis">{x.title}</span>
        <span className="inc-desc ellipsis">{x.message}</span>
      </span>
      <span><span className="tag">{x.module}</span></span>
      <span className={cls('inc-count', x.count >= HOT && 'hot')}>{x.count}</span>
      <span className="inc-muted">{ago(x.last_at)}</span>
      <span className="inc-st">
        <Pill {...INCIDENT_STATUS[x.status]} />
        {x.task_id && <TaskRef x={x} done={done} />}
      </span>
    </div>
  )

  return (
    <div className="page inc-page">
      <PageTitle parent="设置" count={q.data ? headCount(list) : undefined} desc={DESC} actions={<SweepBar />}>运行异常</PageTitle>
      <QueryState query={q}>
        {(all) => {
          const rows = filterIncidents(all, { status: st, level, module: mod, q: kw })
          const entries = entriesOf(rows, !!kw.trim())
          const shown = entries.slice(0, limit)
          const mods = modulesOf(all)
          return (
            <>
              <div className="inc-toolbar">
                <div className="inc-seg" role="group" aria-label="状态">
                  {STATUS_FILTERS.map(([k, l]) => (
                    <button key={k} type="button" className={cls(st === k && 'on')} aria-pressed={st === k} onClick={() => filter(() => setSt(k))}>
                      {l}<span className="seg-n">{all.filter((x) => matchStatus(x, k)).length}</span>
                    </button>
                  ))}
                </div>
                <div className="inc-seg" role="group" aria-label="级别">
                  {LEVEL_FILTERS.map(([k, l]) => (
                    <button key={k} type="button" className={cls(level === k && 'on')} aria-pressed={level === k} onClick={() => filter(() => setLevel(k))}>{l}</button>
                  ))}
                </div>
                <select className={cls('inc-select', mod && 'on')} aria-label="模块" value={mod} onChange={(e) => filter(() => setMod(e.target.value))}>
                  <option value="">全部模块</option>
                  {mods.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <div className="search">
                  <IconSearch />
                  <input type="search" placeholder="搜异常标题和描述" aria-label="搜索异常" value={kw} onChange={(e) => filter(() => setKw(e.target.value))}
                    onKeyDown={(e) => { if (e.key === 'Escape' && kw) { e.preventDefault(); filter(() => setKw('')) } }} />
                  {kw && <button type="button" className="search-clear" aria-label="清空" title="清空" onClick={() => filter(() => setKw(''))}><IconClose size={10} /></button>}
                </div>
              </div>
              {!rows.length ? (
                <EmptyState title={st === 'open' && !level && !mod && !kw.trim() ? '没有未处理的异常' : '没有匹配的异常'} desc={EMPTY_DESC} />
              ) : (
                <div className="inc-table">
                  <div className="inc-row inc-th"><span /><span>异常</span><span>模块</span><span>次数</span><span>最近一次</span><span>状态</span></div>
                  {shown.map((e) => {
                    if (e.kind === 'one') return row(e.x)
                    const g = e
                    const isOpen = openGroups.includes(g.key) || g.xs.some((x) => x.id === selected)
                    const first = g.xs[0]
                    const n = g.xs.filter((x) => x.status === 'open').length
                    const toggle = () => setOpenGroups((xs) => (xs.includes(g.key) ? xs.filter((y) => y !== g.key) : [...xs, g.key]))
                    return (
                      <Fragment key={g.key}>
                        <div role="button" tabIndex={0} aria-expanded={isOpen} className={cls('inc-row inc-group', isOpen && 'open')} title={isOpen ? '收起' : '展开这一组'}
                          onClick={toggle} onKeyDown={(ev) => { if (ev.key === 'Enter' && ev.target === ev.currentTarget) toggle() }}>
                          <span className={cls('inc-level', `il-${g.xs.some((x) => x.level === 'error') ? 'error' : 'warn'}`)} />
                          <span className="inc-main">
                            <span className="inc-title">
                              <span className={cls('inc-chev', isOpen && 'open')}><IconChevronRight /></span>
                              <span className="ellipsis">{first.module} · {g.xs.length} 条</span>
                            </span>
                            <span className="inc-desc ellipsis">最近：{first.title}</span>
                          </span>
                          <span><span className="tag">{first.module}</span></span>
                          <span className="inc-count hot">{g.xs.reduce((s, x) => s + x.count, 0)}</span>
                          <span className="inc-muted">{ago(first.last_at)}</span>
                          <span className="inc-st inc-muted">{n ? `${n} 条未处理` : `${g.xs.length} 条`}</span>
                        </div>
                        {isOpen && g.xs.map((x) => row(x, true))}
                      </Fragment>
                    )
                  })}
                  {entries.length > limit && (
                    <button type="button" className="inc-more" onClick={() => setLimit(limit + PAGE)}>显示更多（还有 {entries.length - limit} 条）</button>
                  )}
                </div>
              )}
            </>
          )
        }}
      </QueryState>
      {open && <IncidentDrawer key={open.id} incident={open} doneStatus={done} onClose={() => setSelected(null)} />}
    </div>
  )
}
