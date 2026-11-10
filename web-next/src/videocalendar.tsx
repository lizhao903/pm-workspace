// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useMemo, useState, type ReactNode } from 'react'
import {
  DEAL_STATUS, LATE_DAYS, PLATFORMS, PUBLISH_STATUS, STAGES, calendarItems, daysBetween, isBehind, localYmd, videoState,
  type CalendarItem, type Deal, type Publish, type Video,
} from './videodata'
import { PageTitle } from './topbar'
import { cls } from './ui'
import './videocalendar.css'

// 视频 > 日历：月、周两种视图，格子里是发布（计划、已定时、已发布、失败）、计划首发日和商单交付截止
// 计划中、已定时的发布和没完成的首发日能拖到别的日子；已定时的发布改了日期，它的定时任务跟着改（App 里按发布记录同步）

type Mode = 'month' | 'week'
const WEEK_HEAD = ['一', '二', '三', '四', '五', '六', '日']
/** 月视图一格最多露几条，多的折成「+N」 */
const CELL_PEEK = 3
const KIND_LABEL: Record<CalendarItem['kind'], string> = { publish: '发布', target: '计划首发', deal_deadline: '商单交付' }

const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
/** 这一周的周一 */
const mondayOf = (d: Date) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 6) % 7)) }
const fromYmd = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }
const hm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
const keyOf = (x: CalendarItem) => `${x.kind}:${x.ref_id}`
/** 同一天里：失败的、落后的排前面，发布按时间 */
const rank = (x: CalendarItem) => (x.tone === 'danger' ? 0 : x.kind === 'deal_deadline' ? 1 : x.kind === 'target' ? 2 : 3)
const sortDay = (xs: CalendarItem[]) => [...xs].sort((a, b) => rank(a) - rank(b) || (a.at ?? '').localeCompare(b.at ?? ''))
/** 发布按状态上色，商单交付用已签约的蓝，首发日不上色（按 tone 走样式） */
const colorOf = (x: CalendarItem) => (x.kind === 'publish' ? PUBLISH_STATUS[x.status!].color : x.kind === 'deal_deadline' ? DEAL_STATUS.signed.color : undefined)

export function CalendarPage({ videos, publishes, deals, tabs, onMovePublish, onMoveTarget, onOpenVideo, onOpenPublish, onOpenDeal }: {
  videos: Video[]
  publishes: Publish[]
  deals: Deal[]
  /** 模块标签栏 */
  tabs?: ReactNode
  /** 把计划中、已定时的发布挪到另一天，时刻不变 */
  onMovePublish: (id: string, date: string) => void
  /** 改计划首发日 */
  onMoveTarget: (videoId: string, date: string) => void
  onOpenVideo: (id: string) => void
  onOpenPublish: (p: Publish) => void
  onOpenDeal?: (id: string) => void
}) {
  const today = localYmd(new Date())
  const [mode, setMode] = useState<Mode>('month')
  // 当前看的月或周里的任一天
  const [anchor, setAnchor] = useState(() => new Date())
  const [day, setDay] = useState(today)
  const [sel, setSel] = useState<string | null>(null)
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [moved, setMoved] = useState<string | null>(null)

  const items = useMemo(() => calendarItems(videos, publishes, deals, today), [videos, publishes, deals, today])
  const byDay = useMemo(() => {
    const m = new Map<string, CalendarItem[]>()
    for (const x of items) m.set(x.date, [...(m.get(x.date) ?? []), x])
    return m
  }, [items])

  // 要画的日子：月视图从本月 1 号所在周的周一画到月底所在周的周日；周视图就是这一周
  const days = useMemo(() => {
    if (mode === 'week') return Array.from({ length: 7 }, (_, i) => addDays(mondayOf(anchor), i))
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)
    const start = mondayOf(first)
    const n = Math.ceil((daysBetween(localYmd(start), localYmd(last)) + 1) / 7) * 7
    return Array.from({ length: n }, (_, i) => addDays(start, i))
  }, [mode, anchor])
  const inRange = (d: Date) => mode === 'week' || d.getMonth() === anchor.getMonth()
  const shown = days.filter(inRange).flatMap((d) => byDay.get(localYmd(d)) ?? [])
  const pubs = shown.filter((x) => x.kind === 'publish')
  const behind = videos.filter((v) => isBehind(v, today))

  const title = mode === 'month'
    ? `${anchor.getFullYear()} 年 ${anchor.getMonth() + 1} 月`
    : (() => { const a = days[0]; const b = days[6]; return `${a.getMonth() + 1} 月 ${a.getDate()} 日 - ${b.getMonth() + 1} 月 ${b.getDate()} 日` })()
  const step = (n: number) => setAnchor((d) => (mode === 'month' ? new Date(d.getFullYear(), d.getMonth() + n, 1) : addDays(d, n * 7)))
  const goToday = () => { setAnchor(new Date()); setDay(today); setSel(null) }

  const current = sel ? items.find((x) => keyOf(x) === sel) : undefined
  const move = (x: CalendarItem, date: string) => {
    if (!x.movable || x.date === date) return
    if (x.kind === 'publish') onMovePublish(x.ref_id, date)
    else if (x.kind === 'target') onMoveTarget(x.ref_id, date)
    setMoved(keyOf(x)); setSel(keyOf(x)); setDay(date)
  }
  const drop = (date: string) => {
    const x = drag ? items.find((i) => keyOf(i) === drag) : undefined
    setDrag(null); setOver(null)
    if (x) move(x, date)
  }

  const chip = (x: CalendarItem, full: boolean) => {
    const pl = x.platform ? PLATFORMS.find((p) => p.key === x.platform) : undefined
    const color = colorOf(x)
    const tip = `${KIND_LABEL[x.kind]}${pl ? ` · ${pl.label}` : ''}${x.at ? ` ${hm(x.at)}` : ''}：${x.label}${x.status ? `（${PUBLISH_STATUS[x.status].label}）` : ''}${x.kind === 'target' && x.tone === 'danger' ? '，进度落后' : ''}${x.movable ? '；可以拖到别的日子' : ''}`
    return (
      <button key={keyOf(x)} type="button" draggable={x.movable} title={tip}
        className={cls('vcal-chip', `vcal-k-${x.kind}`, `vcal-t-${x.tone}`, sel === keyOf(x) && 'on', drag === keyOf(x) && 'dragging', x.movable && 'movable')}
        style={color ? ({ '--c': color } as React.CSSProperties) : undefined}
        onClick={(e) => { e.stopPropagation(); setSel(keyOf(x)); setDay(x.date) }}
        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', keyOf(x)); setDrag(keyOf(x)) }}
        onDragEnd={() => { setDrag(null); setOver(null) }}>
        <i className="vcal-chip-mark" style={pl ? ({ '--p': pl.color } as React.CSSProperties) : undefined} />
        {full && x.at && <span className="vcal-chip-time">{hm(x.at)}</span>}
        {x.kind === 'target' && <span className="vcal-chip-k">首发</span>}
        {x.kind === 'deal_deadline' && <span className="vcal-chip-k">交付</span>}
        <span className="vcal-chip-label">{x.label}</span>
      </button>
    )
  }

  const cell = (d: Date) => {
    const k = localYmd(d)
    const xs = sortDay(byDay.get(k) ?? [])
    const peek = mode === 'month' ? xs.slice(0, CELL_PEEK) : xs
    return (
      <div key={k} role="gridcell" aria-label={`${d.getMonth() + 1} 月 ${d.getDate()} 日，${xs.length} 条`} data-date={k}
        className={cls('vcal-cell', !inRange(d) && 'out', k === today && 'today', k < today && 'past', day === k && !sel && 'on', over === k && 'over')}
        onClick={() => { setDay(k); setSel(null) }}
        onDragOver={(e) => { if (!drag) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== k) setOver(k) }}
        onDragLeave={() => { if (over === k) setOver(null) }}
        onDrop={(e) => { e.preventDefault(); drop(k) }}>
        <div className="vcal-date">
          {mode === 'week' && <span className="vcal-wd">周{WEEK_HEAD[(d.getDay() + 6) % 7]}</span>}
          <span className="vcal-dn">{d.getDate() === 1 && mode === 'month' ? `${d.getMonth() + 1}/1` : d.getDate()}</span>
          {xs.length > 0 && <span className="vcal-dots" aria-hidden>{xs.slice(0, 4).map((x) => <i key={keyOf(x)} className={`vcal-t-${x.tone}`} style={x.tone !== 'danger' && colorOf(x) ? { background: colorOf(x) } : undefined} />)}</span>}
        </div>
        <div className="vcal-items">
          {peek.map((x) => chip(x, mode === 'week'))}
          {xs.length > peek.length && (
            <button type="button" className="vcal-more" onClick={(e) => { e.stopPropagation(); setAnchor(d); setMode('week'); setDay(k); setSel(null) }}>+{xs.length - peek.length} 条</button>
          )}
        </div>
      </div>
    )
  }

  // 下面的详情：选中一条看这一条，否则看选中那天的全部
  const dayItems = sortDay(byDay.get(day) ?? [])
  const detail = () => {
    if (!current) {
      const d = fromYmd(day)
      return (
        <>
          <div className="vcal-panel-head">
            <span className="field-group-title">{d.getMonth() + 1} 月 {d.getDate()} 日 周{WEEK_HEAD[(d.getDay() + 6) % 7]}{day === today && '（今天）'}</span>
            <span className="list-sub">{dayItems.length ? `${dayItems.length} 条` : '这天空着'}</span>
          </div>
          {dayItems.length ? (
            <div className="vcal-day-list">{dayItems.map((x) => chip(x, true))}</div>
          ) : <div className="mount-empty">没有排发布，也没有首发日；把别的日子的发布拖过来，或者去发布记录新建</div>}
        </>
      )
    }
    const v = current.video_id ? videos.find((x) => x.id === current.video_id) : undefined
    const p = current.kind === 'publish' ? publishes.find((x) => x.id === current.ref_id) : undefined
    const deal = current.kind === 'deal_deadline' ? deals.find((x) => x.id === current.ref_id) : undefined
    const pl = current.platform ? PLATFORMS.find((x) => x.key === current.platform) : undefined
    const left = daysBetween(today, current.date)
    const late = v && isBehind(v, today)
    return (
      <>
        <div className="vcal-panel-head">
          <span className={cls('vcal-kind', `vcal-t-${current.tone}`)}>{KIND_LABEL[current.kind]}</span>
          <span className="vcal-panel-title ellipsis" title={current.label}>{current.label}</span>
          <span className="spacer" />
          <button className="act act-quiet" onClick={() => setSel(null)}>看这一天</button>
        </div>
        {moved === sel && <div className="vcal-moved">已改到 {current.date}{current.kind === 'publish' && current.status === 'scheduled' ? '，定时任务跟着改了' : ''}</div>}
        <dl className="vcal-meta">
          <dt>日期</dt>
          <dd>
            {current.movable ? (
              <input type="date" value={current.date} aria-label="改日期" onChange={(e) => e.target.value && move(current, e.target.value)} />
            ) : current.date}
            {current.at && <span className="list-sub"> {hm(current.at)}</span>}
            <span className="list-sub">{left === 0 ? ' 今天' : left > 0 ? ` ${left} 天后` : ` ${-left} 天前`}</span>
          </dd>
          {p && <><dt>平台</dt><dd>{pl?.label ?? p.platform} · <span style={{ color: PUBLISH_STATUS[p.status].color }}>{PUBLISH_STATUS[p.status].label}</span></dd></>}
          {p?.error && <><dt>失败原因</dt><dd className="danger-text">{p.error}</dd></>}
          {v && <><dt>视频</dt><dd>{v.title}</dd><dt>进度</dt><dd>{videoState(v).label}{v.target_date && current.kind === 'publish' ? `，计划首发 ${v.target_date}` : ''}</dd></>}
          {deal && <><dt>商单</dt><dd>{deal.brand} · {DEAL_STATUS[deal.status].label}</dd></>}
        </dl>
        {late && (
          <div className="banner banner-warn vcal-late">
            离计划首发 {v!.target_date} {daysBetween(today, v!.target_date!) < 0 ? '已经过了' : `只剩 ${daysBetween(today, v!.target_date!)} 天`}，{v!.stage === 'ch1' ? '第一章还在等验收' : `第一章验收还没过，现在在「${STAGES.find((s) => s.key === v!.stage)!.label}」`}
          </div>
        )}
        {!current.movable && current.kind === 'publish' && <div className="list-sub">{current.status === 'published' ? '已经发出去了，日期不能改' : '发布失败的要先在发布记录里重试，再排日子'}</div>}
        <div className="act-row">
          {v && <button className="act" onClick={() => onOpenVideo(v.id)}>打开视频</button>}
          {p && <button className="act" onClick={() => onOpenPublish(p)}>看发布记录</button>}
          {deal && onOpenDeal && <button className="act" onClick={() => onOpenDeal(deal.id)}>打开商单</button>}
        </div>
      </>
    )
  }

  return (
    <div className="page page-fill">
      <PageTitle parent="视频" desc={`这周发什么、来不来得及：发布排期、计划首发日和商单交付；离首发 ${LATE_DAYS} 天内还没过第一章验收的标红，拖动改日期`}>日历</PageTitle>
      {tabs}
      <div className="toolbar vcal-bar">
        <div className="seg">
          <button className={cls(mode === 'month' && 'on')} onClick={() => setMode('month')}>月</button>
          <button className={cls(mode === 'week' && 'on')} onClick={() => { setMode('week'); setAnchor(fromYmd(day)) }}>周</button>
        </div>
        <button className="icon-btn" title={mode === 'month' ? '上个月' : '上一周'} aria-label={mode === 'month' ? '上个月' : '上一周'} onClick={() => step(-1)}>
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="m10 3-5 5 5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <span className="vcal-title">{title}</span>
        <button className="icon-btn" title={mode === 'month' ? '下个月' : '下一周'} aria-label={mode === 'month' ? '下个月' : '下一周'} onClick={() => step(1)}>
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <button className="btn btn-outline vcal-today" onClick={goToday}>今天</button>
        <span className="spacer" />
        <span className="vcal-sum">
          <span>发布 <b>{pubs.length}</b></span>
          <span>已定时 <b>{pubs.filter((x) => x.status === 'scheduled').length}</b></span>
          {pubs.some((x) => x.status === 'failed') && <span className="danger-text">失败 <b>{pubs.filter((x) => x.status === 'failed').length}</b></span>}
          <span>首发 <b>{shown.filter((x) => x.kind === 'target').length}</b></span>
          {behind.length > 0 && <span className="danger-text" title={behind.map((v) => v.title).join('、')}>进度落后 <b>{behind.length}</b> 集</span>}
        </span>
      </div>
      <div className="vcal-legend">
        {(['planned', 'scheduled', 'published', 'failed'] as const).map((k) => <span key={k}><i style={{ '--c': PUBLISH_STATUS[k].color } as React.CSSProperties} />{PUBLISH_STATUS[k].label}</span>)}
        <span><i className="vcal-lg-target" />计划首发</span>
        <span><i className="vcal-lg-late" />进度落后</span>
        <span><i className="vcal-lg-deal" />商单交付</span>
      </div>

      <div className={cls('vcal', `vcal-${mode}`)} role="grid" aria-label={title}>
        <div className="vcal-head" role="row">{WEEK_HEAD.map((w) => <span key={w} role="columnheader">{w}</span>)}</div>
        <div className="vcal-grid" role="rowgroup">{days.map(cell)}</div>
      </div>

      <section className="vcal-panel" aria-live="polite">{detail()}</section>
    </div>
  )
}
