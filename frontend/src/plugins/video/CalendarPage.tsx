// 内容日历（VID-06d，SPEC-videos 日历一节，照原型 web-next/src/videocalendar.tsx）：月、周两种视图，格子里是发布（计划中、已定时、已发布、失败）、
// 计划首发日和商单交付截止。计划中、已定时的发布和没完成的首发日能拖到别的日子（发布改 scheduled_at、时刻不变，首发日改 target_date）；
// 离首发日不到 7 天还没过第一章验收的标红（后端算的 behind）。点一条在下面看详情，从详情打开发布抽屉（?p=）或视频详情。
// 地址上记着 ?m=week 周视图、?d=<看的那天>、?p=<发布 id>，刷新还在。到点发布后的状态变化由数据层接事件流和定时回查
import { useState, type CSSProperties } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import {
  errorText, usePatchPublish, usePatchVideo, useSubmitPublish, useVideoAccounts, useVideoCalendar, useVideoCoverTests, useVideoCovers, useVideoDeals,
  useVideoPlatforms, useVideoPublishes, type Video,
} from '../../core/data'
import { Button, ErrorState, IconButton, LoadingState, PageTitle, cls } from '../../core/ui'
import {
  CELL_PEEK, KIND_LABEL, WEEK_HEAD, chipTip, daysBetween, dealItems, fromYmd, gridDays, hm, isYmd, keyOf, moveError, movedAt, rangeTitle, sortDay,
  stepAnchor, weekdayOf, ymd, type CalItem, type CalMode,
} from './calendarModel'
import { DEAL_STATUS } from './dealModel'
import { STAGES, cpOf, videoState } from './model'
import { VideosTabs, type ModuleTab } from './parts'
import { PublishDrawer } from './PublishDrawer'
import { PLATFORM_META, PUBLISH_STATUS } from './publishModel'
import './publish.css'
import './calendar.css'

/** 发布按状态上色，商单交付用已签约的蓝，首发日不上色（按 tone 走样式） */
const colorOf = (x: CalItem) => (x.kind === 'publish' && x.status ? PUBLISH_STATUS[x.status].color : x.kind === 'deal_deadline' ? DEAL_STATUS.signed.color : undefined)

const IconPrev = () => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m10 3-5 5 5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
const IconNext = () => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>

export function CalendarPage({ videos, onModuleTab, onOpenVideo, onOpenTest }: {
  videos: Video[]
  onModuleTab: (t: ModuleTab) => void
  onOpenVideo: (id: string) => void
  /** 封面测试抽屉在发布记录页 */
  onOpenTest: (id: string) => void
}) {
  const [search, setSearch] = useSearchParams()
  const navigate = useNavigate()
  // 打开页面时的本地日期；后端回了 today 以后按后端的
  const [opened] = useState(() => new Date())
  const localToday = ymd(opened)
  const mode: CalMode = search.get('m') === 'week' ? 'week' : 'month'
  const anchorYmd = isYmd(search.get('d')) ? search.get('d')! : localToday
  const anchor = fromYmd(anchorYmd)
  const openP = search.get('p')

  const days = gridDays(mode, anchor)
  const from = ymd(days[0])
  const to = ymd(days[days.length - 1])
  const cal = useVideoCalendar({ from, to })
  const deals = useVideoDeals()
  const publishes = useVideoPublishes()
  const platforms = useVideoPlatforms()
  const accounts = useVideoAccounts()
  const covers = useVideoCovers()
  const tests = useVideoCoverTests()
  const patchPub = usePatchPublish()
  const patchVideo = usePatchVideo()
  const submit = useSubmitPublish()

  const [day, setDay] = useState(anchorYmd)
  const [sel, setSel] = useState<string | null>(null)
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  // 拖动后还没写回的新日期，按条目 key；写回并刷新后去掉
  const [pending, setPending] = useState<Record<string, string>>({})
  const [note, setNote] = useState<{ key: string; text: string; bad?: boolean } | null>(null)

  const setParams = (x: Record<string, string>, push = false) => {
    const next = new URLSearchParams(search)
    for (const [k, v] of Object.entries(x)) { if (v) next.set(k, v); else next.delete(k) }
    setSearch(next, { replace: !push })
  }
  const setMode = (m: CalMode, d?: string) => setParams({ m: m === 'week' ? 'week' : '', d: d ?? anchorYmd })
  const setAnchor = (d: Date) => setParams({ d: ymd(d) })
  const openPub = (id: string | null) => setParams({ p: id ?? '' }, !!id)

  const today = cal.data?.today || localToday
  const real: CalItem[] = [...(cal.data?.items ?? []), ...dealItems(deals.data ?? [], from, to, today)]
  const items = real.map((x) => (pending[keyOf(x)] ? { ...x, date: pending[keyOf(x)] } : x))
  const byDay = new Map<string, CalItem[]>()
  for (const x of items) byDay.set(x.date, [...(byDay.get(x.date) ?? []), x])

  const inRange = (d: Date) => mode === 'week' || d.getMonth() === anchor.getMonth()
  const shown = days.filter(inRange).flatMap((d) => byDay.get(ymd(d)) ?? [])
  const pubs = shown.filter((x) => x.kind === 'publish')
  // 全部视频里进度落后的（不只这个月），口径同后端：离首发不到 late_days 天、第一章验收没过
  const lateDays = cal.data?.late_days ?? 7
  const isLate = (v: Video) => !!v.target_date && cpOf(v, 'ch1')?.state !== 'passed' && daysBetween(today, v.target_date) <= lateDays
  const behind = videos.filter(isLate)
  const title = rangeTitle(mode, anchor, days)

  const move = (x: CalItem, date: string) => {
    if (x.date === date) return
    const k = keyOf(x)
    const bad = moveError(x, date)
    if (bad) { setNote({ key: k, text: bad, bad: true }); setSel(k); return }
    setPending({ ...pending, [k]: date })
    setSel(k)
    setDay(date)
    setNote(null)
    const done = {
      onSuccess: () => setNote({ key: k, text: `已改到 ${date}${x.kind === 'publish' && x.status === 'scheduled' ? `，到 ${date} ${hm(x.at!)} 自动发布` : ''}` }),
      onError: (e: unknown) => setNote({ key: k, text: `没改成：${errorText(e)}`, bad: true }),
      onSettled: () => setPending((p) => { const { [k]: _, ...rest } = p; return rest }),
    }
    if (x.kind === 'publish' && x.at) patchPub.mutate({ id: x.ref_id, patch: { scheduled_at: movedAt(x.at, date) } }, done)
    else if (x.kind === 'target') patchVideo.mutate({ id: x.ref_id, patch: { target_date: date } }, done)
  }
  const drop = (date: string) => {
    const x = drag ? items.find((i) => keyOf(i) === drag) : undefined
    setDrag(null)
    setOver(null)
    if (x) move(x, date)
  }
  const pick = (x: CalItem) => { setSel(keyOf(x)); setDay(x.date); if (note?.key !== keyOf(x)) setNote(null) }

  const chip = (x: CalItem, full: boolean) => {
    const k = keyOf(x)
    const pl = x.platform ? PLATFORM_META[x.platform] : undefined
    const color = colorOf(x)
    return (
      <button key={k} type="button" draggable={x.movable} title={chipTip(x, pl?.label, x.status ? PUBLISH_STATUS[x.status].label : undefined)}
        className={cls('vcal-chip', `vcal-k-${x.kind}`, `vcal-t-${x.tone}`, sel === k && 'on', drag === k && 'dragging', x.movable && 'movable', pending[k] && 'saving')}
        style={color ? ({ '--c': color } as CSSProperties) : undefined}
        onClick={(e) => { e.stopPropagation(); pick(x) }}
        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', k); setDrag(k) }}
        onDragEnd={() => { setDrag(null); setOver(null) }}>
        <i className="vcal-chip-mark" style={pl ? ({ '--p': pl.color } as CSSProperties) : undefined} />
        {full && x.at && <span className="vcal-chip-time">{hm(x.at)}</span>}
        {x.kind === 'target' && <span className="vcal-chip-k">首发</span>}
        {x.kind === 'deal_deadline' && <span className="vcal-chip-k">交付</span>}
        <span className="vcal-chip-label">{x.label}</span>
      </button>
    )
  }

  const cell = (d: Date) => {
    const k = ymd(d)
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
          {xs.length > 0 && (
            <span className="vcal-dots" aria-hidden="true">
              {xs.slice(0, 4).map((x) => <i key={keyOf(x)} className={`vcal-t-${x.tone}`} style={x.tone !== 'danger' && colorOf(x) ? { background: colorOf(x) } : undefined} />)}
            </span>
          )}
        </div>
        <div className="vcal-items">
          {peek.map((x) => chip(x, mode === 'week'))}
          {xs.length > peek.length && (
            <button type="button" className="vcal-more" onClick={(e) => { e.stopPropagation(); setMode('week', k); setDay(k); setSel(null) }}>+{xs.length - peek.length} 条</button>
          )}
        </div>
      </div>
    )
  }

  // 下面的详情：选中一条看这一条，否则看选中那天的全部
  const current = sel ? items.find((x) => keyOf(x) === sel) : undefined
  const detail = () => {
    if (!current) {
      const dayItems = sortDay(byDay.get(day) ?? [])
      const d = fromYmd(day)
      return (
        <>
          <div className="vcal-panel-head">
            <span className="vd-sec-title">{d.getMonth() + 1} 月 {d.getDate()} 日 周{weekdayOf(day)}{day === today && '（今天）'}</span>
            <span className="vd-muted">{dayItems.length ? `${dayItems.length} 条` : '这天空着'}</span>
          </div>
          {dayItems.length ? <div className="vcal-day-list">{dayItems.map((x) => chip(x, true))}</div>
            : <div className="vd-col-empty">没有排发布，也没有首发日；把别的日子的发布拖过来，或者去发布记录新建</div>}
        </>
      )
    }
    const v = current.video_id ? videos.find((x) => x.id === current.video_id) : undefined
    const p = current.kind === 'publish' ? publishes.data?.find((x) => x.id === current.ref_id) : undefined
    const deal = current.kind === 'deal_deadline' ? deals.data?.find((x) => x.id === current.ref_id) : undefined
    const pl = current.platform ? PLATFORM_META[current.platform] : undefined
    const left = daysBetween(today, current.date)
    const target = v?.target_date
    const late = current.kind === 'target' ? current.behind : !!v && isLate(v)
    const k = keyOf(current)
    return (
      <>
        <div className="vcal-panel-head">
          <span className={cls('vcal-kind', `vcal-t-${current.tone}`)}>{KIND_LABEL[current.kind]}</span>
          <span className="vcal-panel-title ellipsis" title={current.label}>{current.label}</span>
          <span className="spacer" />
          <Button size="sm" onClick={() => { setSel(null); setNote(null) }}>看这一天</Button>
        </div>
        {note?.key === k && <div className={cls('vcal-note', note.bad && 'bad')} role="status">{note.text}</div>}
        <dl className="vcal-meta">
          <dt>日期</dt>
          <dd>
            {current.movable ? (
              <input type="date" className="input" value={current.date} aria-label="改日期" disabled={!!pending[k]}
                onChange={(e) => { if (isYmd(e.target.value)) move(current, e.target.value) }} />
            ) : current.date}
            {current.at && <span className="vd-muted"> {hm(current.at)}</span>}
            <span className="vd-muted">{left === 0 ? ' 今天' : left > 0 ? ` ${left} 天后` : ` ${-left} 天前`}</span>
          </dd>
          {current.kind === 'publish' && current.status && (
            <><dt>平台</dt><dd>{pl?.label ?? current.platform} · <span style={{ color: PUBLISH_STATUS[current.status].color }}>{PUBLISH_STATUS[current.status].label}</span></dd></>
          )}
          {p?.error && <><dt>失败原因</dt><dd className="vd-danger-text">{p.error}</dd></>}
          {v && (
            <>
              <dt>视频</dt><dd>{v.title || '未命名视频'}</dd>
              <dt>进度</dt><dd>{videoState(v).label}{target && current.kind === 'publish' ? `，计划首发 ${target}` : ''}</dd>
            </>
          )}
          {deal && <><dt>商单</dt><dd>{deal.brand} · {DEAL_STATUS[deal.status].label}</dd></>}
        </dl>
        {late && v && target && (
          <div className="vcal-late" role="note">
            离计划首发 {target} {daysBetween(today, target) < 0 ? '已经过了' : `只剩 ${daysBetween(today, target)} 天`}，
            {v.stage === 'ch1' ? '第一章还在等验收' : `第一章验收还没过，现在在「${STAGES.find((s) => s.key === v.stage)?.label ?? v.stage}」`}
          </div>
        )}
        {!current.movable && current.kind === 'publish' && <div className="vd-muted">{moveError(current, current.date)}</div>}
        <div className="vcal-acts">
          {current.kind === 'publish' && <Button size="sm" variant="primary" onClick={() => openPub(current.ref_id)}>打开发布记录</Button>}
          {v && <Button size="sm" onClick={() => onOpenVideo(v.id)}>打开视频</Button>}
          {deal && <Button size="sm" onClick={() => void navigate(`/projects/${encodeURIComponent(deal.project_id)}/deals?deal=${encodeURIComponent(deal.id)}`)}>打开商单</Button>}
        </div>
      </>
    )
  }

  const plats = platforms.data ?? []
  const openRec = openP ? publishes.data?.find((x) => x.id === openP) : undefined
  const sendingId = submit.isPending ? submit.variables : undefined

  return (
    <div className="vd-page">
      <PageTitle parent="视频" desc={`这周发什么、来不来得及：发布排期、计划首发日和商单交付；离首发 ${lateDays} 天内还没过第一章验收的标红，拖动改日期`}>日历</PageTitle>
      <VideosTabs active="calendar" videos={videos} onSelect={onModuleTab} />
      <div className="vcal-bar">
        <div className="vd-sort" role="group" aria-label="视图">
          <button type="button" className={cls(mode === 'month' && 'on')} aria-pressed={mode === 'month'} onClick={() => setMode('month')}>月</button>
          <button type="button" className={cls(mode === 'week' && 'on')} aria-pressed={mode === 'week'} onClick={() => setMode('week', day)}>周</button>
        </div>
        <IconButton label={mode === 'month' ? '上个月' : '上一周'} onClick={() => setAnchor(stepAnchor(mode, anchor, -1))}><IconPrev /></IconButton>
        <span className="vcal-title">{title}</span>
        <IconButton label={mode === 'month' ? '下个月' : '下一周'} onClick={() => setAnchor(stepAnchor(mode, anchor, 1))}><IconNext /></IconButton>
        <Button size="sm" onClick={() => { setParams({ d: '' }); setDay(localToday); setSel(null) }}>今天</Button>
        <span className="spacer" />
        {cal.data && (
          <span className="vcal-sum">
            <span>发布 <b>{pubs.length}</b></span>
            <span>已定时 <b>{pubs.filter((x) => x.status === 'scheduled').length}</b></span>
            {pubs.some((x) => x.status === 'failed') && <span className="vd-danger-text">失败 <b>{pubs.filter((x) => x.status === 'failed').length}</b></span>}
            <span>首发 <b>{shown.filter((x) => x.kind === 'target').length}</b></span>
            {behind.length > 0 && <span className="vd-danger-text" title={behind.map((v) => v.title || '未命名视频').join('、')}>进度落后 <b>{behind.length}</b> 集</span>}
          </span>
        )}
      </div>
      <div className="vcal-legend" aria-hidden="true">
        {(['planned', 'scheduled', 'published', 'failed'] as const).map((k) => <span key={k}><i style={{ '--c': PUBLISH_STATUS[k].color } as CSSProperties} />{PUBLISH_STATUS[k].label}</span>)}
        <span><i className="vcal-lg-target" />计划首发</span>
        <span><i className="vcal-lg-late" />进度落后</span>
        <span><i className="vcal-lg-deal" />商单交付</span>
      </div>

      {cal.isPending ? <LoadingState /> : cal.isError ? (
        <ErrorState title="日历没加载出来" error={errorText(cal.error)} onRetry={() => void cal.refetch()} />
      ) : (
        <>
          <div className={cls('vcal', `vcal-${mode}`)} role="grid" aria-label={title}>
            <div className="vcal-head" role="row">{WEEK_HEAD.map((w) => <span key={w} role="columnheader">{w}</span>)}</div>
            <div className="vcal-grid" role="rowgroup">{days.map(cell)}</div>
          </div>
          <section className="vcal-panel" aria-label="详情" aria-live="polite">{detail()}</section>
        </>
      )}

      {openRec && (
        <PublishDrawer key={openRec.id} p={openRec} video={videos.find((v) => v.id === openRec.video_id)} platform={plats.find((x) => x.key === openRec.platform)}
          accounts={accounts.data ?? []} covers={covers.data ?? []} tests={tests.data ?? []}
          sending={sendingId === openRec.id} submitError={submit.variables === openRec.id ? submit.error : null}
          onSubmit={() => { submit.reset(); submit.mutate(openRec.id) }}
          onClose={() => openPub(null)} onOpenVideo={onOpenVideo}
          onOpenTest={onOpenTest}
          onOpenUrl={(url, t) => void navigate(`/browser?${new URLSearchParams({ open: url, title: t })}`)}
          onConnect={() => void navigate('/settings/connectors')} />
      )}
      {openP && publishes.data && !openRec && (
        <div className="vp-gone" role="status">这条发布记录已经删除了<Button size="sm" onClick={() => openPub(null)}>知道了</Button></div>
      )}
    </div>
  )
}
