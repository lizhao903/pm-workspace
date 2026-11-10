// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SearchSelect } from './searchselect'
import {
  ACCOUNT_ROLE, COVER_RATIO, ORIENT, PLATFORMS, PLATFORM_RULES, PUBLISH_STATUS, SNAPSHOT_DAYS, checkPublish, coverRatioOf, dayAfter, videoState,
  type Artifact, type CoverRatio, type CoverTest, type MetricSnapshot, type Metrics, type Orientation, type PlatformKey, type Publish, type PublishStatus, type Series, type Video,
} from './videodata'
import { CoverTestDrawer, CoverTestSection, accountOf, accountsOf, grownMetrics, pct, snapshotOf, usePubStore, pubStore } from './covertest'
import { PageTitle } from './topbar'
import { SeriesSettingsDrawer, StageDist, isFinished, needsMe } from './videos'
import { cls, timeAgo } from './ui'
import './videopublish.css'

// 视频模块：系列列表（点进去是系列详情，在 videos.tsx 的 sr: 视图）和发布记录（按平台发、回填数据）

const Pill = ({ label, color }: { label: string; color: string }) => <span className="pill" style={{ '--c': color } as React.CSSProperties}><span className="pill-dot" />{label}</span>
const num = (n: number | undefined) => (n ?? 0).toLocaleString('zh-CN')
const platOf = (k: PlatformKey) => PLATFORMS.find((p) => p.key === k)!
const ratiosText = (rs: CoverRatio[]) => rs.map((r) => COVER_RATIO[r].label).join('、')
/** 一集某个方向下平台收的封面，推荐的比例排前面 */
const coversFor = (arts: Artifact[], videoId: string, variant: Orientation, k: PlatformKey) => {
  const rs = platOf(k).cover
  return arts.filter((a) => a.video_id === videoId && a.kind === 'cover' && a.variant === variant && rs.includes(coverRatioOf(a)))
    .sort((a, b) => rs.indexOf(coverRatioOf(a)) - rs.indexOf(coverRatioOf(b)) || (a.option ?? 0) - (b.option ?? 0))
}
/** 平台收不收这张封面；不收就返回失败原因 */
const coverError = (k: PlatformKey, cover?: Artifact) => {
  const p = platOf(k)
  if (!cover || p.cover.includes(coverRatioOf(cover))) return ''
  return `封面比例不符合要求：${p.label}要 ${p.cover.map((r) => COVER_RATIO[r].label).join(' 或 ')}，这次用的是 ${COVER_RATIO[coverRatioOf(cover)].label}`
}
const fmtTime = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const CloseIcon = () => <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
const PlusIcon = () => <svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>

/** 抽屉里按 Esc：有确认框先关确认框，没有就关抽屉 */
function useEsc(fn: () => void) {
  const ref = useRef(fn)
  useEffect(() => { ref.current = fn })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') ref.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export const PlatformTag = ({ k }: { k: PlatformKey }) => {
  const p = platOf(k)
  return <span className="vp-plat" style={{ '--c': p.color } as React.CSSProperties}><i />{p.label}</span>
}

/** 封面缩略色块：按封面比例画，色调跟着第几个版本走 */
export function CoverSwatch({ ratio, option, size = 'md', on, onClick, title }: {
  ratio: CoverRatio; option?: number; size?: 'sm' | 'md'; on?: boolean; onClick?: () => void; title?: string
}) {
  const o = COVER_RATIO[ratio]
  const style = { aspectRatio: `${o.w} / ${o.h}`, '--h': ((option ?? 0) * 67 + 200) % 360 } as React.CSSProperties
  const body = <span className="vp-cover-n">{option ?? '-'}</span>
  if (onClick) return <button type="button" className={cls('vp-cover', `vp-cover-${size}`, on && 'on')} style={style} onClick={onClick} title={title}>{body}</button>
  return <span className={cls('vp-cover', `vp-cover-${size}`)} style={style} title={title}>{body}</span>
}

/* ---------- 系列 ---------- */

/** 发布记录按视频分组时，每组先露几条；一次渲染多少个视频组 */
const PEEK = 3
const GROUPS = 30
/** 选视频的下拉：标题 + 当前阶段，按更新时间倒序 */
const videoOptions = (xs: Video[]) => [...xs].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  .map((v) => ({ value: v.id, label: v.title || '未命名视频', hint: videoState(v).label, keywords: v.root }))
const episodesOf = (s: Series, videos: Video[]) => videos.filter((v) => v.series_id === s.id)

/** 系列列表：一个系列一张卡片，只看整体进度；点卡片进系列详情，各集、共用部分、系列设置都在详情里 */
export function SeriesPage({ series, videos, onSeries, onOpenSeries, tabs }: {
  series: Series[]; videos: Video[]
  /** 旧接线还在传，列表页用不到 */
  artifacts?: Artifact[]
  onSeries: (fn: (xs: Series[]) => Series[]) => void
  /** 旧接线还在传，加集移出挪到系列详情了 */
  onVideos?: (fn: (xs: Video[]) => Video[]) => void
  onOpenVideo?: (id: string) => void
  /** 打开系列详情（sr:<id>）；不传时点卡片打开系列设置 */
  onOpenSeries?: (id: string) => void
  /** 模块标签栏，放在顶栏下面 */
  tabs?: ReactNode
}) {
  const [open, setOpen] = useState<string | null>(null)
  const current = open && open !== 'new' ? series.find((s) => s.id === open) ?? null : null
  const staleTotal = series.reduce((n, s) => n + episodesOf(s, videos).filter((v) => s.stale.includes(v.id)).length, 0)
  const enter = (id: string) => (onOpenSeries ? onOpenSeries(id) : setOpen(id))

  return (
    <div className="page page-fill">
      <PageTitle parent="视频" count={series.length} desc="多集共用开场、收尾和模板；点系列看各集、改共用部分"
        actions={<button className="btn btn-primary" onClick={() => setOpen('new')}><PlusIcon />新建系列</button>}>系列</PageTitle>
      {tabs}
      {staleTotal > 0 && <div className="banner banner-warn vp-banner"><span>有 {staleTotal} 集改过共用部分还没同步，需要重新录屏渲染</span></div>}
      {!series.length ? (
        <div className="empty">
          <div className="empty-title">还没有系列</div>
          <div className="list-sub">把同一主题的几集归成一个系列，共用开场、收尾和模板，批量改版时能看出影响哪几集</div>
          <button className="btn btn-primary" onClick={() => setOpen('new')}>新建系列</button>
        </div>
      ) : (
        <div className="vp-series-grid">
          {series.map((s) => {
            const eps = episodesOf(s, videos)
            const stale = eps.filter((v) => s.stale.includes(v.id)).length
            const done = eps.filter(isFinished).length
            const wait = eps.filter(needsMe).length
            return (
              <div key={s.id} role="button" tabIndex={0} className="vp-series" onClick={() => enter(s.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enter(s.id) } }}>
                <div className="vp-series-head">
                  <span className="vp-series-name ellipsis">{s.name}</span>
                  <span className="tag">{eps.length} 集</span>
                </div>
                <div className={cls('vp-series-desc', !s.desc && 'faint')}>{s.desc || '还没写说明'}</div>
                {eps.length ? (
                  <div className="vp-series-prog">
                    <div className="vp-series-stats">
                      <span>已完成 <b>{done}</b> / {eps.length} 集</span>
                      {wait > 0 && <span className="vp-tone-warn">{wait} 集待处理</span>}
                      {stale > 0 && <span className="vp-stale">{stale} 集待同步</span>}
                    </div>
                    {/* 分布条只看不筛，点哪都进详情 */}
                    <StageDist videos={eps} value="" onChange={() => {}} />
                  </div>
                ) : <div className="mount-empty">还没有归入的集，点开系列新建一集或把视频加进来</div>}
              </div>
            )
          })}
        </div>
      )}
      {open && (open === 'new' || current) && (
        <SeriesSettingsDrawer key={open} series={current} videos={videos}
          onClose={() => setOpen(null)}
          onSave={(s) => {
            if (current) onSeries((xs) => xs.map((x) => (x.id === s.id ? s : x)))
            else { onSeries((xs) => [...xs, s]); onOpenSeries?.(s.id) }
            setOpen(null)
          }} />
      )}
    </div>
  )
}

/* ---------- 发布记录 ---------- */

type MetricKey = 'views' | 'likes' | 'comments' | 'shares'
const METRICS: { key: MetricKey; label: string }[] = [
  { key: 'views', label: '播放' }, { key: 'likes', label: '点赞' }, { key: 'comments', label: '评论' }, { key: 'shares', label: '转发' },
]
const fakeUrl = (p: PlatformKey) => {
  const r = Math.random().toString(36).slice(2, 10)
  return {
    bilibili: `https://www.bilibili.com/video/BV1${r}`,
    youtube: `https://www.youtube.com/watch?v=${r}`,
    douyin: `https://www.douyin.com/video/7${Date.now()}`,
    channels: `https://channels.weixin.qq.com/web/pages/feed?id=${r}`,
    xiaohongshu: `https://www.xiaohongshu.com/explore/${r}`,
  }[p]
}
/** datetime-local 要的本地时间格式 */
const toLocalInput = (d: Date) => {
  const z = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`
}
const tomorrow10 = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return toLocalInput(d) }

/** 平台的接入情况：ok 已接入能自动发；manual 已接入但平台不开放发布接口；error 接入异常；none 没接入 */
export type ChannelState = { state: 'ok' | 'manual' | 'error' | 'none'; name?: string; error?: string }

export function PublishPage({ publishes, videos, artifacts, videoId, onPublishes, onArtifacts, onOpenVideo, onOpenUrl, onClearFilter, channels, onConnect, tabs }: {
  /** 模块标签栏，放在顶栏下面 */
  tabs?: ReactNode
  publishes: Publish[]; videos: Video[]; artifacts: Artifact[]
  /** 封面 A/B 判定后改封面（胜者设为主封面、其余归档）；不传时只记在测试上 */
  onArtifacts?: (fn: (xs: Artifact[]) => Artifact[]) => void
  /** 各平台连接器的接入情况，决定能不能自动发布 */
  channels: Record<PlatformKey, ChannelState>
  /** 去设置里接入（或修复）某个平台的连接器 */
  onConnect: (k: PlatformKey) => void
  /** 只看某一集；不传就是全部 */
  videoId?: string
  onPublishes: (fn: (xs: Publish[]) => Publish[]) => void
  onOpenVideo: (id: string) => void
  /** 在内置浏览器里打开发布链接 */
  onOpenUrl: (url: string, title: string) => void
  onClearFilter: () => void
}) {
  const [plat, setPlat] = useState<PlatformKey | ''>('')
  const [st, setSt] = useState<PublishStatus | ''>('')
  const [open, setOpen] = useState<string | null>(null)
  const [metric, setMetric] = useState<MetricKey>('views')
  const [q, setQ] = useState('')
  /** 展开看全部的视频组 */
  const [openV, setOpenV] = useState<string[]>([])
  const [glimit, setGlimit] = useState(GROUPS)
  // 正在模拟发布的记录
  const [busy, setBusy] = useState<string[]>([])
  /** 打开的封面测试：测试 id，或 new 新建；和发布抽屉二选一 */
  const [testOpen, setTestOpen] = useState<string | null>(null)
  const { snapshots, tests } = usePubStore()
  const openPub = (id: string | null) => { setTestOpen(null); setOpen(id) }
  const openTest = (id: string | null) => { setOpen(null); setTestOpen(id) }
  const testOfPub = (id: string): CoverTest | undefined => tests.find((t) => t.arms.some((a) => a.publish_id === id))
  const pubsRef = useRef(publishes)
  const artsRef = useRef(artifacts)
  useEffect(() => { pubsRef.current = publishes; artsRef.current = artifacts })

  const titleOf = (id: string) => videos.find((v) => v.id === id)?.title ?? '已删除的视频'
  const video = videoId ? videos.find((v) => v.id === videoId) : undefined
  const base = videoId ? publishes.filter((p) => p.video_id === videoId) : publishes
  const kw = q.trim().toLowerCase()
  const rows = base
    .filter((p) => (!plat || p.platform === plat) && (!st || p.status === st) && (!kw || `${p.title} ${titleOf(p.video_id)}`.toLowerCase().includes(kw)))
    .sort((a, b) => (b.published_at ?? b.scheduled_at ?? '').localeCompare(a.published_at ?? a.scheduled_at ?? ''))
  const published = base.filter((p) => p.status === 'published')
  const sum = (k: MetricKey) => published.reduce((n, p) => n + (p.metrics?.[k] ?? 0), 0)
  const failed = base.filter((p) => p.status === 'failed').length
  const coverOf = (p: Publish) => (p.cover_id ? artifacts.find((a) => a.id === p.cover_id) : undefined)

  // 模拟发布：1.2 秒后变成已发布；到点时从 ref 拿最新记录，期间被删了或状态变了就不动
  const runPublish = (id: string) => {
    setBusy((xs) => (xs.includes(id) ? xs : [...xs, id]))
    window.setTimeout(() => {
      setBusy((xs) => xs.filter((x) => x !== id))
      const cur = pubsRef.current.find((x) => x.id === id)
      if (!cur || cur.status !== 'planned') return
      // 平台按封面比例把关：不收的比例直接打回
      const err = coverError(cur.platform, cur.cover_id ? artsRef.current.find((a) => a.id === cur.cover_id) : undefined)
      if (err) { onPublishes((xs) => xs.map((x) => (x.id === id ? { ...x, status: 'failed', error: err } : x))); return }
      const done = { status: 'published' as const, published_at: new Date().toISOString(), url: fakeUrl(cur.platform), error: undefined,
        metrics: { views: 0, likes: 0, comments: 0, shares: 0, updated_at: new Date().toISOString() } }
      onPublishes((xs) => xs.map((x) => (x.id === id ? { ...x, ...done } : x)))
    }, 1200)
  }
  const update = (id: string, patch: Partial<Publish>) => onPublishes((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)))
  const retry = (id: string) => { update(id, { status: 'planned', error: undefined, scheduled_at: undefined }); runPublish(id) }

  const byPlat = PLATFORMS.map((p) => {
    const xs = published.filter((x) => x.platform === p.key)
    return { p, has: base.some((x) => x.platform === p.key), n: xs.length, v: xs.reduce((n, x) => n + (x.metrics?.[metric] ?? 0), 0) }
  }).filter((x) => x.has)
  const max = Math.max(1, ...byPlat.map((x) => x.v))
  const current = open && open !== 'new' ? publishes.find((p) => p.id === open) : undefined
  const row = (p: Publish) => {
    const cv = coverOf(p)
    const sending = busy.includes(p.id)
    return (
      <div key={p.id} className={cls('vp-row', open === p.id && 'sel')} onClick={() => openPub(p.id)}>
      <span className="task-main">
        <span className="task-title"><span className="ellipsis">{p.title || '未填标题'}</span></span>
        <span className="task-meta"><span className="ellipsis">{titleOf(p.video_id)}</span></span>
      </span>
      <span><PlatformTag k={p.platform} /></span>
      <span className="vp-var">
        <span className="tag">{ORIENT[p.variant].label}</span>
        {cv ? <CoverSwatch ratio={coverRatioOf(cv)} option={cv.option} size="sm" title={`${cv.name} · ${COVER_RATIO[coverRatioOf(cv)].label}`} /> : <span className="faint">无封面</span>}
      </span>
      <span>{sending ? <Pill label="发布中…" color={PUBLISH_STATUS.scheduled.color} /> : <Pill {...PUBLISH_STATUS[p.status]} />}</span>
      <span className="run-muted vp-time">
        {p.status === 'published' && p.published_at ? fmtTime(p.published_at)
          : p.status === 'scheduled' && p.scheduled_at ? `定时 ${fmtTime(p.scheduled_at)}`
            : p.status === 'failed' ? <span className="danger-text ellipsis" title={p.error}>{p.error ?? '失败'}</span> : '-'}
      </span>
      <span className="vp-met">
        {METRICS.map((m) => <span key={m.key}><em>{m.label}</em>{p.metrics ? num(p.metrics[m.key]) : '-'}</span>)}
      </span>
      </div>
    )
  }
  // 全部发布记录按视频分组：组的先后跟着组里最新的一条，每组先露几条，失败的排前面
  const groups = (() => {
    const by = new Map<string, Publish[]>()
    rows.forEach((p) => by.set(p.video_id, [...(by.get(p.video_id) ?? []), p]))
    return [...by].map(([id, xs]) => ({ id, xs }))
  })()
  const peekOf = (xs: Publish[]) => [...xs.filter((p) => p.status === 'failed'), ...xs.filter((p) => p.status !== 'failed')].slice(0, PEEK)

  return (
    <div className="page page-fill">
      <PageTitle count={base.length} desc="每个平台发了哪个比例、哪张封面，发出去以后回填播放数据"
        actions={<button className="btn btn-primary" onClick={() => openPub('new')}><PlusIcon />新建发布</button>}>发布记录</PageTitle>
      {tabs}

      {videoId && (
        <div className="vp-only">
          <span className="vp-only-k">只看：</span>
          <button className="link-btn ellipsis" onClick={() => onOpenVideo(videoId)}>{video?.title ?? '已删除的视频'}</button>
          <span className="spacer" />
          <button className="act act-quiet" onClick={onClearFilter}>清除，看全部</button>
        </div>
      )}

      <div className="stats">
        <div className="stat"><div className="stat-label">已发布</div><div className="stat-value">{num(published.length)}</div></div>
        <div className="stat"><div className="stat-label">总播放</div><div className="stat-value">{num(sum('views'))}</div></div>
        <div className="stat"><div className="stat-label">总点赞</div><div className="stat-value">{num(sum('likes'))}</div></div>
        <div className="stat"><div className="stat-label">发布失败</div><div className={cls('stat-value', failed > 0 && 'stat-danger')}>{num(failed)}</div></div>
      </div>

      {videoId && (
        <section className="hook-sec vp-compare">
          <div className="vp-compare-head">
            <span className="field-group-title">按平台对比</span>
            <span className="spacer" />
            <div className="seg seg-sm">
              {METRICS.map((m) => <button key={m.key} className={cls(metric === m.key && 'on')} onClick={() => setMetric(m.key)}>{m.label}</button>)}
            </div>
          </div>
          {byPlat.length ? (
            <div className="vp-bars">
              {byPlat.map(({ p, n, v }) => (
                <div key={p.key} className="vp-bar-row">
                  <span className="vp-bar-label"><PlatformTag k={p.key} /></span>
                  <span className="vp-bar-track">
                    {n ? <span className="vp-bar" style={{ width: `${Math.max(2, (v / max) * 100)}%`, '--c': p.color } as React.CSSProperties} /> : <span className="faint vp-bar-none">还没发出去</span>}
                  </span>
                  <span className="vp-bar-val">{n ? num(v) : '-'}</span>
                </div>
              ))}
            </div>
          ) : <div className="mount-empty">这一集还没有发布记录</div>}
        </section>
      )}

      <CoverTestSection tests={tests} videos={videos} artifacts={artifacts} publishes={publishes} videoId={videoId} onOpen={openTest} onNew={() => openTest('new')} />

      <div className="toolbar vp-filters">
        <div className="search search-sm vp-search">
          <svg viewBox="0 0 16 16" width="13" height="13"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder={videoId ? '搜发布标题' : '搜发布标题或视频'} value={q} onChange={(e) => { setQ(e.target.value); setGlimit(GROUPS) }} />
        </div>
        <div className="vp-chips">
          <button className={cls('chip', !plat && 'chip-on')} onClick={() => setPlat('')}>全部平台</button>
          {PLATFORMS.map((p) => <button key={p.key} className={cls('chip', plat === p.key && 'chip-on')} onClick={() => setPlat(plat === p.key ? '' : p.key)}>{p.label}<span className="seg-n">{base.filter((x) => x.platform === p.key).length}</span></button>)}
        </div>
        <div className="vp-chips">
          <button className={cls('chip', !st && 'chip-on')} onClick={() => setSt('')}>全部状态</button>
          {(Object.keys(PUBLISH_STATUS) as PublishStatus[]).map((k) => <button key={k} className={cls('chip', st === k && 'chip-on')} onClick={() => setSt(st === k ? '' : k)}>{PUBLISH_STATUS[k].label}<span className="seg-n">{base.filter((x) => x.status === k).length}</span></button>)}
        </div>
      </div>

      {!rows.length ? (
        <div className="empty">
          <div className="empty-title">{plat || st || kw ? '没有匹配的发布记录' : '还没有发布记录'}</div>
          <div className="list-sub">点右上角「新建发布」，选视频、平台、比例和封面</div>
        </div>
      ) : (
        <div className="task-table vp-table">
          <div className="vp-row task-th"><span>视频</span><span>平台</span><span>比例 / 封面</span><span>状态</span><span>时间</span><span className="vp-met vp-met-th">{METRICS.map((m) => <span key={m.key}>{m.label}</span>)}</span></div>
          {videoId ? rows.map(row) : groups.slice(0, glimit).map((g) => {
            const all = openV.includes(g.id) || g.xs.length <= PEEK
            const fail = g.xs.filter((p) => p.status === 'failed').length
            return (
              <Fragment key={g.id}>
                <div className="vp-group-row">
                  <button className="link-btn ellipsis vp-group-title" title={titleOf(g.id)} onClick={() => onOpenVideo(g.id)}>{titleOf(g.id)}</button>
                  <span className="vp-group-plats">{[...new Set(g.xs.map((p) => p.platform))].map((k) => <PlatformTag key={k} k={k} />)}</span>
                  {fail > 0 && <span className="danger-text vp-group-n">{fail} 条失败</span>}
                  <span className="spacer" />
                  <span className="run-muted vp-group-n">{g.xs.length} 条</span>
                  {g.xs.length > PEEK && <button className="act act-quiet" onClick={() => setOpenV(all ? openV.filter((x) => x !== g.id) : [...openV, g.id])}>{all ? '收起' : `查看全部 ${g.xs.length} 条`}</button>}
                </div>
                {(all ? g.xs : peekOf(g.xs)).map(row)}
              </Fragment>
            )
          })}
          {!videoId && groups.length > glimit && <button className="vp-more" onClick={() => setGlimit(glimit + GROUPS)}>显示更多视频（还有 {groups.length - glimit} 个）</button>}
        </div>
      )}

      {open === 'new' && (
        <NewPublishDrawer key="new" videos={videos} artifacts={artifacts} defaultVideo={videoId} channels={channels} onConnect={onConnect} onClose={() => setOpen(null)}
          onCreate={(p, now) => { onPublishes((xs) => [p, ...xs]); setOpen(p.id); if (now) runPublish(p.id) }} />
      )}
      {current && (
        <PublishDrawer key={current.id} p={current} video={videos.find((v) => v.id === current.video_id)} cover={coverOf(current)} sending={busy.includes(current.id)}
          covers={coversFor(artifacts, current.video_id, current.variant, current.platform)}
          onCover={(id) => update(current.id, { cover_id: id })}
          onClose={() => setOpen(null)} onOpenVideo={onOpenVideo} onOpenUrl={onOpenUrl}
          onRetry={() => retry(current.id)} onPublishNow={() => { update(current.id, { status: 'planned', scheduled_at: undefined }); runPublish(current.id) }}
          snapshots={snapshots.filter((s) => s.publish_id === current.id)} test={testOfPub(current.id)} onOpenTest={openTest}
          onMetrics={(m, source) => { pubStore.addSnapshot(snapshotOf(current, m, source)); update(current.id, { metrics: m }) }}
          onDelete={() => { onPublishes((xs) => xs.filter((x) => x.id !== current.id)); setOpen(null) }} />
      )}
      {testOpen && (testOpen === 'new' || tests.some((t) => t.id === testOpen)) && (
        <CoverTestDrawer key={testOpen} test={tests.find((t) => t.id === testOpen)} videos={videos} artifacts={artifacts} publishes={publishes} defaultVideo={videoId}
          onClose={() => setTestOpen(null)} onCreated={openTest} onPublishes={onPublishes} onArtifacts={onArtifacts} onOpenPublish={(id) => openPub(id)} />
      )}
    </div>
  )
}

function NewPublishDrawer({ videos, artifacts, defaultVideo, channels, onConnect, onClose, onCreate }: {
  videos: Video[]; artifacts: Artifact[]; defaultVideo?: string
  channels: Record<PlatformKey, ChannelState>; onConnect: (k: PlatformKey) => void
  onClose: () => void
  onCreate: (p: Publish, now: boolean) => void
}) {
  const pickVariant = (v: Video | undefined, k: PlatformKey): Orientation => {
    const prefer = platOf(k).prefer
    return v?.orientations.includes(prefer) ? prefer : v?.orientations[0] ?? prefer
  }
  const firstVideo = videos.find((v) => v.id === defaultVideo) ?? videos[0]
  const [vid, setVid] = useState(firstVideo?.id ?? '')
  const [plat, setPlat] = useState<PlatformKey>('bilibili')
  const [variant, setVariant] = useState<Orientation>(() => pickVariant(firstVideo, 'bilibili'))
  const [cover, setCover] = useState<string | undefined>(undefined)
  const [title, setTitle] = useState(firstVideo?.title ?? '')
  const [desc, setDesc] = useState('')
  const [mode, setMode] = useState<'now' | 'later'>('now')
  const [at, setAt] = useState(tomorrow10)
  const [tried, setTried] = useState(false)
  const [descHint, setDescHint] = useState('')
  const mainOf = (k: PlatformKey) => (accountsOf(k).find((a) => a.role === 'main') ?? accountsOf(k)[0])?.id
  const [account, setAccount] = useState<string | undefined>(() => mainOf('bilibili'))
  const [tagText, setTagText] = useState('')
  const [category, setCategory] = useState('')
  const [collection, setCollection] = useState('')
  useEsc(onClose)

  const video = videos.find((v) => v.id === vid)
  const vOptions = useMemo(() => videoOptions(videos), [videos])
  const platform = platOf(plat)
  const covers = coversFor(artifacts, vid, variant, plat)
  const descArt = artifacts.filter((a) => a.video_id === vid && a.kind === 'description').sort((a, b) => b.version - a.version)[0]
  const missPrefer = video && !video.orientations.includes(platform.prefer)

  const changeVideo = (id: string) => {
    const v = videos.find((x) => x.id === id)
    if (!title.trim() || title === video?.title) setTitle(v?.title ?? '')
    setVid(id); setVariant(pickVariant(v, plat)); setCover(undefined); setDescHint('')
  }
  const changePlat = (k: PlatformKey) => { setPlat(k); setVariant(pickVariant(video, k)); setCover(undefined); setAccount(mainOf(k)); setCategory('') }
  const fillDesc = () => {
    if (!descArt) { setDescHint('这集还没有简介产出物，先在分发包阶段出简介，或者直接手写'); return }
    setDesc(`${video?.title ?? ''}\n\n（取自简介产出物 ${descArt.path}，第 ${descArt.version} 版，${descArt.status === 'final' || descArt.status === 'published' ? '已定稿' : '还没定稿'}）`)
    setDescHint('')
  }

  // 平台规则校验：有一项不过就不让发
  const rule = PLATFORM_RULES[plat]
  const tags = [...new Set(tagText.split(/[,，、\s#]+/).map((x) => x.trim()).filter(Boolean))]
  const coverArt = cover ? artifacts.find((a) => a.id === cover) : undefined
  const duration = artifacts.find((a) => a.video_id === vid && a.kind === 'video' && a.variant === variant)?.duration
  const checks = checkPublish(plat, { title, desc, tags, cover: coverArt && coverRatioOf(coverArt), duration })
  const failed = checks.filter((c) => !c.ok)
  const titleLen = [...title.trim()].length
  const accounts = accountsOf(plat)

  const when = new Date(at)
  const errors = [
    !video && '先选一个视频',
    !title.trim() && '标题必填',
    ...failed.map((c) => c.text),
    mode === 'later' && (Number.isNaN(when.getTime()) ? '选一个定时时间' : when.getTime() <= Date.now() ? '定时时间要晚于现在' : ''),
  ].filter(Boolean) as string[]
  const chan = channels[plat]
  const auto = chan.state === 'ok'
  const submit = () => {
    setTried(true)
    if (errors.length) return
    const p: Publish = {
      id: newId('pb'), video_id: vid, platform: plat, variant, cover_id: cover, title: title.trim(), desc: desc.trim(),
      status: auto && mode === 'later' ? 'scheduled' : 'planned', scheduled_at: mode === 'later' ? when.toISOString() : undefined,
      account_id: account, tags: tags.length ? tags : undefined, category: category || undefined, collection: collection.trim() || undefined, checks,
    }
    // 不能自动发的只登记成「计划中」，发完回来填链接
    onCreate(p, auto && mode === 'now')
  }

  return (
    <aside className="drawer vp-drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">新建发布</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)"><CloseIcon /></button>
      </div>
      <div className="drawer-body form">
        <label className="field">
          <span className="field-label">视频<em>*</em></span>
          <SearchSelect variant="field" value={vid} placeholder={videos.length ? '选一个视频' : '还没有视频'} searchPlaceholder="搜标题或目录"
            options={vOptions} emptyText="还没有视频" missingLabel={() => '已删除的视频'} disabled={!videos.length}
            onChange={(v) => { if (v) changeVideo(v) }} />
          {video && <span className="field-hint-line">出了 {video.orientations.map((o) => ORIENT[o].label).join('、')}，现在在「{videoState(video).label}」</span>}
        </label>

        <div className="field">
          <span className="field-label">平台</span>
          <div className="vp-chips">
            {PLATFORMS.map((p) => (
              <button key={p.key} type="button" className={cls('chip vp-plat-chip', plat === p.key && 'chip-on')} style={{ '--c': p.color } as React.CSSProperties} onClick={() => changePlat(p.key)}>
                <i />{p.label}<span className="seg-n">偏好{ORIENT[p.prefer].label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field-label">账号<span className="field-hint">封面 A/B 用小号各发一版</span></span>
          {accounts.length ? (
            <div className="vp-chips">
              {accounts.map((a) => (
                <button key={a.id} type="button" className={cls('chip', account === a.id && 'chip-on')} onClick={() => setAccount(a.id)}>
                  {a.handle}<span className="seg-n">{ACCOUNT_ROLE[a.role].label}</span>
                </button>
              ))}
            </div>
          ) : <div className="mount-empty">还没有{platform.label}账号，这条记录先不挂账号；接入连接器后账号会出现在这里</div>}
        </div>

        <div className="field">
          <span className="field-label">画面比例<span className="field-hint">只能选这集做了的比例</span></span>
          <div className="seg seg-full">
            {(Object.keys(ORIENT) as Orientation[]).map((o) => {
              const has = !!video?.orientations.includes(o)
              return (
                <button key={o} disabled={!has} className={cls(variant === o && 'on')} title={has ? undefined : '这集没做这个比例'} onClick={() => { setVariant(o); setCover(undefined) }}>
                  {ORIENT[o].label} {ORIENT[o].ratio}{o === platform.prefer && <span className="seg-n">推荐</span>}
                </button>
              )
            })}
          </div>
          {missPrefer && <div className="vp-hint">这集没出{ORIENT[platform.prefer].label}版，{platform.label}建议{ORIENT[platform.prefer].label}</div>}
        </div>
        {/* 平台接入情况：没接入或不开放发布接口的，只能登记，发完再回填链接和数据 */}
        {chan.state !== 'ok' && (
          <div className="vp-hint vp-conn">
            <span>{chan.state === 'none' ? `还没接入${platform.label}，只能登记发布记录，不能自动上传和拉数据。`
              : chan.state === 'error' ? `${chan.name ?? platform.label}连接异常：${chan.error ?? '请重新授权'}。修好之前只能登记。`
                : `${platform.label}不开放发布接口，请在 App 或创作者中心发布后回来填链接；数据会自动拉取。`}</span>
            {chan.state !== 'manual' && <button className="link-btn" onClick={() => onConnect(plat)}>{chan.state === 'none' ? '去接入' : '去修复'}</button>}
          </div>
        )}

        <div className="field">
          <span className="field-label">封面<span className="field-hint">{platform.label}收 {ratiosText(platform.cover)} 的封面；这集{ORIENT[variant].label}有 {covers.length} 张</span></span>
          {covers.length ? (
            <div className="vp-covers">
              {covers.map((a) => (
                <span key={a.id} className="vp-cover-opt">
                  <CoverSwatch ratio={coverRatioOf(a)} option={a.option} on={cover === a.id} title={`${a.name} · ${COVER_RATIO[coverRatioOf(a)].label} · ${a.path}`} onClick={() => setCover(cover === a.id ? undefined : a.id)} />
                  <span className={cls('vp-cover-cap', a.status === 'published' && 'used')}>{COVER_RATIO[coverRatioOf(a)].label} · {a.status === 'published' ? '用过' : `版本 ${a.option ?? '-'}`}</span>
                </span>
              ))}
            </div>
          ) : <div className="mount-empty">这集还没有 {ratiosText(platform.cover)} 的{ORIENT[variant].label}封面，先在分发包阶段出封面；不选也能发</div>}
        </div>

        <label className="field">
          <span className="field-label">标题<em>*</em><span className={cls('field-hint', titleLen > rule.title_max && 'danger-text')}>{titleLen} / {rule.title_max} 字</span></span>
          <input value={title} className={cls(((tried && !title.trim()) || titleLen > rule.title_max) && 'bad')} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label vp-label-row">
            <span>简介</span><span className="spacer" />
            <button type="button" className="act act-quiet" onClick={fillDesc}>从简介产出物带入</button>
          </span>
          <textarea rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="平台显示的简介" />
          {descHint && <span className="vp-hint">{descHint}</span>}
        </label>
        <label className="field">
          <span className="field-label">标签<span className="field-hint">逗号或空格分开，{platform.label}最多 {rule.tags_max} 个</span></span>
          <input value={tagText} className={cls(tags.length > rule.tags_max && 'bad')} onChange={(e) => setTagText(e.target.value)} placeholder="效率工具，待办" />
        </label>
        <div className="vp-form-2">
          {rule.categories && (
            <label className="field">
              <span className="field-label">分区</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">不选</option>
                {rule.categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          )}
          <label className="field">
            <span className="field-label">合集</span>
            <input value={collection} onChange={(e) => setCollection(e.target.value)} placeholder={video?.series_id ? '比如系列名' : '可空'} />
          </label>
        </div>

        <div className="field">
          <span className="field-label">发布前校验<span className="field-hint">按{platform.label}的规则；有一项不过不能发</span></span>
          <ul className="vp-checks">
            {checks.map((c) => <li key={c.key} className={cls(!c.ok && 'bad')}><span className="vp-check-mark">{c.ok ? '通过' : '不通过'}</span>{c.text}</li>)}
          </ul>
        </div>

        <div className="field">
          <span className="field-label">什么时候发</span>
          <div className="seg seg-full">
            <button className={cls(mode === 'now' && 'on')} onClick={() => setMode('now')}>立即发布</button>
            <button className={cls(mode === 'later' && 'on')} onClick={() => setMode('later')}>定时发布</button>
          </div>
          {mode === 'later' && <input type="datetime-local" className="vp-dt" value={at} onChange={(e) => setAt(e.target.value)} />}
        </div>
      </div>
      <div className="drawer-foot">
        <div className="spacer" />
        {(tried || failed.length > 0) && errors.length > 0 && <span className="field-err">{errors[0]}</span>}
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={!videos.length || failed.length > 0} title={failed[0]?.text} onClick={submit}>{!auto ? '登记发布记录' : mode === 'now' ? '立即发布' : '定时发布'}</button>
      </div>
    </aside>
  )
}

/** 扩展指标：平台不给的留空，界面上不显示那一格 */
type ExtKey = 'impressions' | 'ctr' | 'avg_watch_sec' | 'completion' | 'favorites' | 'coins' | 'followers_gained'
const EXT: { key: ExtKey; label: string; kind: 'int' | 'pct' | 'sec' }[] = [
  { key: 'impressions', label: '曝光', kind: 'int' }, { key: 'ctr', label: '点击率', kind: 'pct' }, { key: 'avg_watch_sec', label: '平均观看', kind: 'sec' },
  { key: 'completion', label: '完播率', kind: 'pct' }, { key: 'favorites', label: '收藏', kind: 'int' }, { key: 'coins', label: '投币', kind: 'int' },
  { key: 'followers_gained', label: '涨粉', kind: 'int' },
]
const fmtExt = (kind: 'int' | 'pct' | 'sec', v: number | undefined) => (v == null ? '-' : kind === 'pct' ? pct(v) : kind === 'sec' ? `${Math.floor(v / 60)} 分 ${v % 60} 秒` : num(v))
/** 曲线能切的指标 */
type CurveKey = 'views' | 'impressions' | 'ctr' | 'completion'
const CURVE: { key: CurveKey; label: string; ratio?: boolean }[] = [
  { key: 'views', label: '播放' }, { key: 'impressions', label: '曝光' }, { key: 'ctr', label: '点击率', ratio: true }, { key: 'completion', label: '完播率', ratio: true },
]
/** 同一天有几条快照时取最后一条 */
const lastPerDay = (xs: MetricSnapshot[]) => {
  const by = new Map<number, MetricSnapshot>()
  xs.forEach((s) => by.set(s.day, s))
  return [...by.values()].sort((a, b) => a.day - b.day)
}

/** 按天曲线：横轴按对数排，D1、D3、D7、D30 等距一些 */
function MetricCurve({ snaps, k, today }: { snaps: MetricSnapshot[]; k: CurveKey; today: number }) {
  const ratio = CURVE.find((c) => c.key === k)?.ratio
  const pts = snaps.filter((s) => s[k] != null).map((s) => ({ d: s.day, v: s[k] as number }))
  const maxD = Math.max(30, ...pts.map((p) => p.d))
  // 位置都按百分比算：线画在拉伸的 svg 里，点、数字、刻度用 HTML 叠上去，窄屏不会缩成看不清
  const x = (d: number) => 2 + (Math.log(d) / Math.log(maxD)) * 95
  const maxV = Math.max(ratio ? 0.01 : 1, ...pts.map((p) => p.v)) * 1.15
  const y = (v: number) => 8 + (1 - v / maxV) * 90
  const fmt = (v: number) => (ratio ? pct(v) : num(v))
  const last = pts[pts.length - 1]
  return (
    <div className="vp-curve" role="img" aria-label={`按天曲线：${CURVE.find((c) => c.key === k)?.label}`}>
      <div className="vp-curve-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {SNAPSHOT_DAYS.map((d) => <line key={d} x1={x(d)} x2={x(d)} y1={0} y2={100} vectorEffect="non-scaling-stroke" className={cls('vp-curve-grid', d > today && 'future')} />)}
          {pts.length > 1 && <polyline points={pts.map((p) => `${x(p.d)},${y(p.v)}`).join(' ')} vectorEffect="non-scaling-stroke" className="vp-curve-line" />}
        </svg>
        {pts.map((p) => <span key={p.d} className={cls('vp-curve-dot', SNAPSHOT_DAYS.includes(p.d) && 'key')} style={{ left: `${x(p.d)}%`, top: `${y(p.v)}%` }} title={`第 ${p.d} 天：${fmt(p.v)}`} />)}
        {last && <span className="vp-curve-val" style={{ right: `${100 - x(last.d)}%`, top: `${y(last.v)}%` }}>{fmt(last.v)}</span>}
      </div>
      <div className="vp-curve-ticks">
        {SNAPSHOT_DAYS.map((d) => <span key={d} className={cls(d > today && 'future')} style={{ left: `${x(d)}%` }}>D{d}</span>)}
      </div>
    </div>
  )
}

function PublishDrawer({ p, video, cover, covers, sending, snapshots, test, onClose, onOpenVideo, onOpenUrl, onRetry, onPublishNow, onMetrics, onCover, onDelete, onOpenTest }: {
  p: Publish; video: Video | undefined; cover: Artifact | undefined; sending: boolean
  /** 这条发布能换的封面：同方向、平台收的比例 */
  covers: Artifact[]
  /** 这条发布的按天快照 */
  snapshots: MetricSnapshot[]
  /** 这条发布在哪个封面测试里 */
  test?: CoverTest
  onCover: (id: string | undefined) => void
  onClose: () => void
  onOpenVideo: (id: string) => void
  onOpenUrl: (url: string, title: string) => void
  onRetry: () => void
  onPublishNow: () => void
  /** 回填或拉取：存一条快照，再把最新数据写回发布 */
  onMetrics: (m: Metrics, source: MetricSnapshot['source']) => void
  onDelete: () => void
  onOpenTest: (id: string) => void
}) {
  const [fill, setFill] = useState<Record<MetricKey | ExtKey, string> | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)
  const [curve, setCurve] = useState<CurveKey>('views')
  const [history, setHistory] = useState(false)
  useEsc(onClose)
  const plat = platOf(p.platform)
  const account = accountOf(p.account_id)
  const today = p.published_at ? dayAfter(p.published_at) : 0
  const snaps = lastPerDay(snapshots)
  const latest = snaps[snaps.length - 1]
  const curves = CURVE.filter((c) => snaps.some((s) => s[c.key] != null))
  const exts = EXT.filter((e) => p.metrics?.[e.key] != null)

  // 百分比的格子填 0 到 100，存成 0 到 1；平均观看填秒
  const toText = (kind: 'int' | 'pct' | 'sec', v: number | undefined) => (v == null ? '' : kind === 'pct' ? String(+(v * 100).toFixed(2)) : String(v))
  const startFill = () => {
    const m = p.metrics
    setFill({
      views: String(m?.views ?? 0), likes: String(m?.likes ?? 0), comments: String(m?.comments ?? 0), shares: String(m?.shares ?? 0),
      ...Object.fromEntries(EXT.map((e) => [e.key, toText(e.kind, m?.[e.key])])),
    } as Record<MetricKey | ExtKey, string>)
  }
  const bad = (s: string) => !/^\d+$/.test(s.trim())
  const badExt = (kind: 'int' | 'pct' | 'sec', s: string) => {
    const t = s.trim()
    if (!t) return false
    if (kind === 'pct') return !/^\d+(\.\d+)?$/.test(t) || Number(t) > 100
    return !/^\d+$/.test(t)
  }
  const fillBad = !!fill && (METRICS.some((m) => bad(fill[m.key])) || EXT.some((e) => badExt(e.kind, fill[e.key])))
  const saveFill = () => {
    if (!fill || fillBad) return
    const ext = Object.fromEntries(EXT.map((e) => {
      const t = fill[e.key].trim()
      return [e.key, t ? (e.kind === 'pct' ? Number(t) / 100 : Number(t)) : undefined]
    })) as Partial<Metrics>
    onMetrics({ views: Number(fill.views), likes: Number(fill.likes), comments: Number(fill.comments), shares: Number(fill.shares), ...ext, updated_at: new Date().toISOString() }, 'manual')
    setFill(null)
  }
  // 模拟拉取：在现有数字上随机涨一点，存一条连接器快照
  const pull = () => onMetrics(grownMetrics(p.metrics), 'connector')

  return (
    <aside className="drawer vp-drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">发布记录</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)"><CloseIcon /></button>
      </div>
      <div className="drawer-body form">
        <div className="vp-pub-head">
          <div className="profile-text">
            <h2 className="vp-pub-title">{p.title || '未填标题'}</h2>
            <div className="vp-pub-sub">
              <PlatformTag k={p.platform} />
              {sending ? <Pill label="发布中…" color={PUBLISH_STATUS.scheduled.color} /> : <Pill {...PUBLISH_STATUS[p.status]} />}
            </div>
          </div>
        </div>

        {p.status === 'failed' && (
          <div className="detail-alert">
            <span><b>发布失败</b>{p.error ?? '平台没有返回原因'}</span>
            <button className="act" disabled={sending} onClick={onRetry}>重试</button>
          </div>
        )}
        {/* 没发出去之前都能换封面；只列平台收的比例 */}
        {(p.status === 'failed' || p.status === 'planned' || p.status === 'scheduled') && !sending && (
          <div className="field">
            <span className="field-label">换封面<span className="field-hint">{plat.label}收 {ratiosText(plat.cover)}，推荐 {COVER_RATIO[plat.cover[0]].label}</span></span>
            {covers.length ? (
              <div className="vp-covers">
                {covers.map((a) => (
                  <span key={a.id} className="vp-cover-opt">
                    <CoverSwatch ratio={coverRatioOf(a)} option={a.option} on={cover?.id === a.id} title={`${a.name} · ${COVER_RATIO[coverRatioOf(a)].label} · ${a.path}`} onClick={() => onCover(cover?.id === a.id ? undefined : a.id)} />
                    <span className="vp-cover-cap">{COVER_RATIO[coverRatioOf(a)].label} · 版本 {a.option ?? '-'}</span>
                  </span>
                ))}
              </div>
            ) : <div className="mount-empty">这集还没有 {ratiosText(plat.cover)} 的{ORIENT[p.variant].label}封面，去视频的产出物里登记一张</div>}
          </div>
        )}

        <dl className="props vp-props">
          <dt>视频</dt>
          <dd>{video ? <button className="link-btn ellipsis" onClick={() => onOpenVideo(video.id)}>{video.title}</button> : <span className="faint">已删除的视频</span>}</dd>
          <dt>平台</dt><dd>{plat.label}<span className="faint">（偏好{ORIENT[plat.prefer].label}）</span></dd>
          <dt>账号</dt>
          <dd>{account ? <>{account.handle}<span className="tag">{ACCOUNT_ROLE[account.role].label}</span>{!account.connector_id && <span className="faint">手动登记，数据要回填</span>}</> : <span className="faint">没挂账号</span>}</dd>
          <dt>比例</dt>
          <dd>{ORIENT[p.variant].label} {ORIENT[p.variant].ratio}{p.variant !== plat.prefer && <span className="vp-hint-inline">平台建议{ORIENT[plat.prefer].label}</span>}</dd>
          <dt>封面</dt>
          <dd>{cover ? <><CoverSwatch ratio={coverRatioOf(cover)} option={cover.option} size="sm" /><span className="mono ellipsis">{cover.path}</span>
            {!plat.cover.includes(coverRatioOf(cover)) && <span className="vp-hint-inline">{plat.label}不收 {COVER_RATIO[coverRatioOf(cover)].label}</span>}</> : <span className="faint">没有选封面</span>}</dd>
          {test && <><dt>封面 A/B</dt><dd><button className="link-btn" onClick={() => onOpenTest(test.id)}>{test.status === 'running' ? '在测试里，进行中' : test.status === 'decided' ? (test.winner_id === p.cover_id ? '测试胜出的一版' : '测试里输掉的一版') : '测试已结束，没有结论'}</button></dd></>}
          {p.tags?.length ? <><dt>标签</dt><dd className="vp-tags">{p.tags.map((t) => <span key={t} className="tag">{t}</span>)}</dd></> : null}
          {p.category && <><dt>分区</dt><dd>{p.category}</dd></>}
          {p.collection && <><dt>合集</dt><dd>{p.collection}</dd></>}
          {p.scheduled_at && <><dt>定时</dt><dd>{new Date(p.scheduled_at).toLocaleString('zh-CN')}</dd></>}
          {p.published_at && <><dt>发布于</dt><dd>{new Date(p.published_at).toLocaleString('zh-CN')}<span className="faint">（{timeAgo(p.published_at)}）</span></dd></>}
          <dt>链接</dt>
          <dd>{p.url ? <span className="mono ellipsis" title={p.url}>{p.url}</span> : <span className="faint">{p.status === 'published' ? '没有记链接' : '发布后生成'}</span>}</dd>
          {p.checks && <><dt>发布前校验</dt><dd>{p.checks.every((c) => c.ok) ? <span>{p.checks.length} 项全部通过</span> : <span className="danger-text">{p.checks.filter((c) => !c.ok).map((c) => c.text).join('；')}</span>}</dd></>}
        </dl>

        <section className="field-group">
          <div className="field-group-title">简介</div>
          {p.desc ? <div className="vp-desc">{p.desc}</div> : <div className="faint">没有填简介</div>}
        </section>

        {p.status === 'published' && (
          <section className="field-group">
            <div className="vp-compare-head">
              <span className="field-group-title">数据<span className="field-hint">{p.metrics?.updated_at ? `${timeAgo(p.metrics.updated_at)}更新，发布后第 ${today} 天` : '还没回填'}</span></span>
              <span className="spacer" />
              {!fill && <><button className="act act-quiet" onClick={pull}>模拟拉取数据</button><button className="act" onClick={startFill}>回填数据</button></>}
            </div>
            {fill ? (
              <>
                <div className="vp-hint vp-hint-info">记为发布后第 {today} 天，存一条新快照，之前的快照不覆盖</div>
                <div className="vp-metric-form">
                  {METRICS.map((m) => (
                    <label key={m.key} className="field">
                      <span className="field-label">{m.label}</span>
                      <input inputMode="numeric" value={fill[m.key]} className={cls(bad(fill[m.key]) && 'bad')} onChange={(e) => setFill({ ...fill, [m.key]: e.target.value })} />
                    </label>
                  ))}
                  {EXT.map((e) => (
                    <label key={e.key} className="field">
                      <span className="field-label">{e.label}<span className="field-hint">{e.kind === 'pct' ? '%' : e.kind === 'sec' ? '秒' : '可空'}</span></span>
                      <input inputMode="decimal" value={fill[e.key]} className={cls(badExt(e.kind, fill[e.key]) && 'bad')} onChange={(ev) => setFill({ ...fill, [e.key]: ev.target.value })} />
                    </label>
                  ))}
                </div>
                <div className="act-row">
                  <button className="act act-primary" disabled={fillBad} onClick={saveFill}>保存</button>
                  <button className="act act-quiet" onClick={() => setFill(null)}>取消</button>
                  {fillBad && <span className="field-err">播放、点赞、评论、转发只能填非负整数；百分比填 0 到 100；平台不给的留空</span>}
                </div>
              </>
            ) : (
              <>
                <div className="vp-metric-grid">
                  {METRICS.map((m) => <div key={m.key} className="vp-metric"><span className="stat-label">{m.label}</span><span className="vp-metric-v">{p.metrics ? num(p.metrics[m.key]) : '-'}</span></div>)}
                  {exts.map((e) => <div key={e.key} className="vp-metric"><span className="stat-label">{e.label}</span><span className="vp-metric-v">{fmtExt(e.kind, p.metrics?.[e.key])}</span></div>)}
                </div>
              </>
            )}
          </section>
        )}

        {p.status === 'published' && !fill && (
          <section className="field-group">
            <div className="vp-compare-head">
              <span className="field-group-title">按天曲线<span className="field-hint">{snaps.length ? `${snapshots.length} 条快照，最新是第 ${latest.day} 天；同一天取最后一条` : '还没有快照'}</span></span>
              <span className="spacer" />
              {curves.length > 1 && (
                <div className="seg seg-sm">
                  {curves.map((c) => <button key={c.key} className={cls(curve === c.key && 'on')} onClick={() => setCurve(c.key)}>{c.label}</button>)}
                </div>
              )}
            </div>
            {snaps.length ? (
              <>
                <MetricCurve snaps={snaps} k={curves.some((c) => c.key === curve) ? curve : 'views'} today={today} />
                <div className="vp-days">
                  <span className="vp-days-row vp-days-th"><span />{SNAPSHOT_DAYS.map((d) => <span key={d}>D{d}</span>)}<span>最新</span></span>
                  {curves.map((c) => (
                    <span key={c.key} className="vp-days-row">
                      <span className="faint">{c.label}</span>
                      {SNAPSHOT_DAYS.map((d) => {
                        const s = snaps.find((x) => x.day === d)
                        const v = s?.[c.key]
                        return <span key={d} className={cls(!s && 'faint')}>{d > today ? '未到' : v == null ? '-' : c.ratio ? pct(v) : num(v)}</span>
                      })}
                      <span>{latest[c.key] == null ? '-' : c.ratio ? pct(latest[c.key]) : num(latest[c.key])}</span>
                    </span>
                  ))}
                </div>
                <button className="act act-quiet vp-hist-toggle" onClick={() => setHistory(!history)}>{history ? '收起快照' : `看全部 ${snapshots.length} 条快照`}</button>
                {history && (
                  <div className="vp-hist">
                    {[...snapshots].reverse().map((s, i) => (
                      <span key={`${s.updated_at}-${i}`} className="vp-hist-row">
                        <span>第 {s.day} 天</span>
                        <span className="faint">{s.source === 'manual' ? '手动回填' : '连接器拉取'}</span>
                        <span>播放 {num(s.views)}</span>
                        <span>{s.ctr != null ? `点击率 ${pct(s.ctr)}` : ''}</span>
                        <span className="faint">{fmtTime(s.updated_at)}</span>
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : <div className="mount-empty">拉取或回填一次就有第一条快照；之后每次都存一条，不覆盖</div>}
          </section>
        )}
      </div>
      <div className="drawer-foot">
        {confirmDel ? (
          <>
            <span className="danger-text">只删这条记录，平台上已发的内容不受影响</span>
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>取消</button>
            <button className="btn btn-danger" onClick={onDelete}>删除</button>
          </>
        ) : (
          <>
            <button className="btn btn-ghost btn-danger-ghost" onClick={() => setConfirmDel(true)}>删除</button>
            <div className="spacer" />
            {p.status === 'failed' && <button className="btn btn-primary" disabled={sending} onClick={onRetry}>重试</button>}
            {(p.status === 'scheduled' || (p.status === 'planned' && !sending)) && <button className="btn btn-outline" onClick={onPublishNow}>改为立即发布</button>}
            {p.status === 'published' && <button className="btn btn-primary" disabled={!p.url} title={p.url ? undefined : '没有记链接'} onClick={() => p.url && onOpenUrl(p.url, p.title)}>打开链接</button>}
          </>
        )}
      </div>
    </aside>
  )
}

import { newId } from './ids'