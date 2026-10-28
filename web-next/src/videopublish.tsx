import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { SearchSelect } from './searchselect'
import {
  ORIENT, PLATFORMS, PUBLISH_STATUS, STAGES, stageIndex, videoState,
  type Artifact, type Metrics, type Orientation, type PlatformKey, type Publish, type PublishStatus, type Series, type Video,
} from './videodata'
import { PageTitle } from './topbar'
import { cls, timeAgo } from './ui'
import './videopublish.css'

// 视频模块：系列管理（共用开场、收尾、模板，改了要标出受影响的集）和发布记录（按平台发、回填数据）

const Pill = ({ label, color }: { label: string; color: string }) => <span className="pill" style={{ '--c': color } as React.CSSProperties}><span className="pill-dot" />{label}</span>
const num = (n: number | undefined) => (n ?? 0).toLocaleString('zh-CN')
const platOf = (k: PlatformKey) => PLATFORMS.find((p) => p.key === k)!
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

/** 封面缩略色块：按比例画，色调跟着第几个版本走 */
export function CoverSwatch({ variant, option, size = 'md', on, onClick, title }: {
  variant: Orientation; option?: number; size?: 'sm' | 'md'; on?: boolean; onClick?: () => void; title?: string
}) {
  const o = ORIENT[variant]
  const style = { aspectRatio: `${o.w} / ${o.h}`, '--h': ((option ?? 0) * 67 + 200) % 360 } as React.CSSProperties
  const body = <span className="vp-cover-n">{option ?? '-'}</span>
  if (onClick) return <button type="button" className={cls('vp-cover', `vp-cover-${size}`, on && 'on')} style={style} onClick={onClick} title={title}>{body}</button>
  return <span className={cls('vp-cover', `vp-cover-${size}`)} style={style} title={title}>{body}</span>
}

/** 制作进度：8 个阶段一格一格，当前阶段高亮 */
function StageBar({ v }: { v: Video }) {
  const st = videoState(v)
  const cur = stageIndex(v.stage)
  const done = st.tone === 'ok'
  return (
    <span className="vp-stage" title={`${STAGES[cur].label}（${cur + 1}/${STAGES.length}）`}>
      <span className="vp-stage-bar">
        {STAGES.map((s, i) => <i key={s.key} className={cls((i < cur || done) && 'done', i === cur && !done && 'cur', i === cur && st.tone === 'warn' && 'warn')} />)}
      </span>
      <span className={cls('vp-stage-label', `vp-tone-${st.tone}`)}>{st.label}</span>
    </span>
  )
}

/* ---------- 系列 ---------- */

const SHARED: { key: 'intro' | 'outro' | 'template'; label: string; ph: string }[] = [
  { key: 'intro', label: '共用开场', ph: '比如 shared/intro.tsx（5 秒标志动画）' },
  { key: 'outro', label: '共用收尾', ph: '比如 shared/outro.tsx（关注引导 + 下集预告）' },
  { key: 'template', label: '共用模板', ph: '比如 templates/theme（主题、字体、配色）' },
]

/** 发布记录按视频分组时，每组先露几条；一次渲染多少个视频组 */
const PEEK = 3
const GROUPS = 30
/** 系列卡片上露几集；待同步的排前面，其余点开系列在抽屉里看 */
const CARD_EPS = 5
/** 选视频的下拉：标题 + 当前阶段，按更新时间倒序 */
const videoOptions = (xs: Video[]) => [...xs].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  .map((v) => ({ value: v.id, label: v.title || '未命名视频', hint: videoState(v).label, keywords: v.root }))
const episodesOf = (s: Series, videos: Video[]) => videos.filter((v) => v.series_id === s.id).sort((a, b) => (a.episode ?? 999) - (b.episode ?? 999))

export function SeriesPage({ series, videos, artifacts, onSeries, onVideos, onOpenVideo }: {
  series: Series[]; videos: Video[]; artifacts: Artifact[]
  onSeries: (fn: (xs: Series[]) => Series[]) => void
  onVideos: (fn: (xs: Video[]) => Video[]) => void
  onOpenVideo: (id: string) => void
}) {
  const [open, setOpen] = useState<string | null>(null)
  const current = open && open !== 'new' ? series.find((s) => s.id === open) ?? null : null
  const unsync = (s: Series, id: string) => onSeries((xs) => xs.map((x) => (x.id === s.id ? { ...x, stale: x.stale.filter((y) => y !== id) } : x)))
  const staleTotal = series.reduce((n, s) => n + episodesOf(s, videos).filter((v) => s.stale.includes(v.id)).length, 0)

  return (
    <div className="page page-fill">
      <PageTitle count={series.length} desc="多集共用开场、收尾和模板；改了共用部分会标出哪几集要重新录屏渲染"
        actions={<button className="btn btn-primary" onClick={() => setOpen('new')}><PlusIcon />新建系列</button>}>系列</PageTitle>
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
            const stale = eps.filter((v) => s.stale.includes(v.id))
            const peek = eps.length > CARD_EPS ? [...stale, ...eps.filter((v) => !s.stale.includes(v.id))].slice(0, CARD_EPS).sort((a, b) => (a.episode ?? 999) - (b.episode ?? 999)) : eps
            return (
              <div key={s.id} className={cls('vp-series', open === s.id && 'sel')} onClick={() => setOpen(s.id)}>
                <div className="vp-series-head">
                  <span className="vp-series-name ellipsis">{s.name}</span>
                  <span className="tag">{eps.length} 集</span>
                  {stale.length > 0 && <span className="vp-stale">{stale.length} 集待同步</span>}
                </div>
                {s.desc && <div className="vp-series-desc">{s.desc}</div>}
                <dl className="vp-shared">
                  {SHARED.map((f) => <div key={f.key}><dt>{f.label.replace('共用', '')}</dt><dd className={cls('ellipsis', !s[f.key] && 'faint')}>{s[f.key] || '未设置'}</dd></div>)}
                </dl>
                {eps.length ? (
                  <div className="vp-eps">
                    {peek.map((v) => (
                      <div key={v.id} className="vp-ep">
                        <span className="vp-ep-no">{v.episode ?? '-'}</span>
                        <span className="vp-ep-main">
                          <span className="vp-ep-title">
                            <span className="ellipsis">{v.title}</span>
                            {s.stale.includes(v.id) && <span className="vp-stale">待同步</span>}
                          </span>
                          <StageBar v={v} />
                        </span>
                        {s.stale.includes(v.id) && (
                          <span className="vp-ep-acts" onClick={(e) => e.stopPropagation()}>
                            <button className="act act-quiet" onClick={() => unsync(s, v.id)}>标记已同步</button>
                            <button className="act act-quiet" onClick={() => onOpenVideo(v.id)}>去这一集</button>
                          </span>
                        )}
                      </div>
                    ))}
                    {eps.length > peek.length && <div className="vp-eps-more">还有 {eps.length - peek.length} 集，点开系列看全部</div>}
                  </div>
                ) : <div className="mount-empty">还没有归入的集，点开系列把视频加进来</div>}
              </div>
            )
          })}
        </div>
      )}
      {open && (open === 'new' || current) && (
        <SeriesDrawer key={open} series={current} videos={videos} artifacts={artifacts}
          onClose={() => setOpen(null)}
          onCreate={(s) => { onSeries((xs) => [...xs, s]); setOpen(s.id) }}
          onSave={(s) => { onSeries((xs) => xs.map((x) => (x.id === s.id ? s : x))); setOpen(null) }}
          onSeries={onSeries} onVideos={onVideos} onOpenVideo={onOpenVideo} />
      )}
    </div>
  )
}

function SeriesDrawer({ series, videos, artifacts, onClose, onCreate, onSave, onSeries, onVideos, onOpenVideo }: {
  series: Series | null; videos: Video[]; artifacts: Artifact[]
  onClose: () => void
  onCreate: (s: Series) => void
  onSave: (s: Series) => void
  onSeries: (fn: (xs: Series[]) => Series[]) => void
  onVideos: (fn: (xs: Video[]) => Video[]) => void
  onOpenVideo: (id: string) => void
}) {
  const creating = !series
  const [d, setD] = useState<Series>(() => series ?? { id: newId('sr'), name: '', desc: '', intro: '', outro: '', template: '', stale: [] })
  const [tried, setTried] = useState(false)
  // 影响范围确认：要标记的集
  const [confirm, setConfirm] = useState<string[] | null>(null)
  const [adding, setAdding] = useState('')
  useEsc(() => (confirm ? setConfirm(null) : onClose()))

  const eps = series ? episodesOf(series, videos) : []
  const free = videos.filter((v) => !v.series_id)
  const freeOptions = useMemo(() => videoOptions(videos.filter((v) => !v.series_id)), [videos])
  const changed = series ? SHARED.filter((f) => d[f.key].trim() !== series[f.key].trim()) : []
  const coverCount = (v: Video) => artifacts.filter((a) => a.video_id === v.id && a.kind === 'cover').length

  const save = () => {
    setTried(true)
    if (!d.name.trim()) return
    const next = { ...d, name: d.name.trim(), intro: d.intro.trim(), outro: d.outro.trim(), template: d.template.trim() }
    if (creating) { onCreate(next); return }
    if (changed.length && eps.length) { setConfirm(eps.map((v) => v.id)); return }
    onSave({ ...next, stale: series!.stale })
  }
  const confirmSave = () => {
    const picked = confirm ?? []
    const base = series!.stale.filter((id) => !picked.includes(id))
    onSave({ ...d, name: d.name.trim(), intro: d.intro.trim(), outro: d.outro.trim(), template: d.template.trim(), stale: [...base, ...picked] })
  }

  const setEpisode = (id: string, n: number) => onVideos((xs) => xs.map((v) => (v.id === id ? { ...v, episode: n } : v)))
  const addVideo = () => {
    if (!adding || !series) return
    const n = Math.max(0, ...eps.map((v) => v.episode ?? 0)) + 1
    onVideos((xs) => xs.map((v) => (v.id === adding ? { ...v, series_id: series.id, episode: n } : v)))
    setAdding('')
  }
  const removeVideo = (id: string) => {
    onVideos((xs) => xs.map((v) => (v.id === id ? { ...v, series_id: undefined, episode: undefined } : v)))
    if (series) onSeries((xs) => xs.map((x) => (x.id === series.id ? { ...x, stale: x.stale.filter((y) => y !== id) } : x)))
  }
  const unsync = (id: string) => series && onSeries((xs) => xs.map((x) => (x.id === series.id ? { ...x, stale: x.stale.filter((y) => y !== id) } : x)))
  // 同号的集提示一下
  const dup = new Set(eps.map((v) => v.episode).filter((n, i, arr) => n !== undefined && arr.indexOf(n) !== i))

  return (
    <aside className="drawer vp-drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">{creating ? '新建系列' : '系列'}</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)"><CloseIcon /></button>
      </div>
      <div className="drawer-body form">
        <label className="field">
          <span className="field-label">名称<em>*</em></span>
          <input value={d.name} autoFocus={creating} className={cls(tried && !d.name.trim() && 'bad')} placeholder="比如：一人之下 10 分钟上手" onChange={(e) => setD({ ...d, name: e.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">说明</span>
          <textarea rows={2} value={d.desc} placeholder="这个系列讲什么、出哪几个比例、发哪些平台" onChange={(e) => setD({ ...d, desc: e.target.value })} />
        </label>
        <section className="field-group">
          <div className="field-group-title">共用部分<span className="field-hint">改了任一项，保存时会让你确认哪几集要重新录屏渲染</span></div>
          {SHARED.map((f) => (
            <label key={f.key} className="field">
              <span className="field-label">{f.label}{series && d[f.key].trim() !== series[f.key].trim() && <span className="vp-changed">已改</span>}</span>
              <input className="mono" value={d[f.key]} placeholder={f.ph} onChange={(e) => setD({ ...d, [f.key]: e.target.value })} />
            </label>
          ))}
        </section>

        {series ? (
          <section className="field-group">
            <div className="field-group-title">各集<span className="field-hint">集数、加入、移出立即生效，不用点保存</span></div>
            {eps.length ? (
              <div className="vp-ep-list">
                {eps.map((v) => {
                  const stale = series.stale.includes(v.id)
                  return (
                    <div key={v.id} className={cls('vp-ep-edit', stale && 'is-stale')}>
                      <label className="vp-ep-num" title="第几集">
                        <span>第</span>
                        <input type="number" min={1} value={v.episode ?? ''} className={cls(dup.has(v.episode) && 'bad')}
                          onChange={(e) => { const n = Number(e.target.value); if (n >= 1) setEpisode(v.id, Math.floor(n)) }} />
                        <span>集</span>
                      </label>
                      <span className="vp-ep-main">
                        <span className="vp-ep-title">
                          <span className="ellipsis">{v.title}</span>
                          {stale && <span className="vp-stale">待同步</span>}
                        </span>
                        <span className="vp-ep-sub">
                          <StageBar v={v} />
                          <span className="faint">{v.orientations.map((o) => ORIENT[o].label).join(' / ')} · 封面 {coverCount(v)} 张</span>
                        </span>
                      </span>
                      <span className="vp-ep-acts">
                        {stale && <button className="act act-quiet" onClick={() => unsync(v.id)}>标记已同步</button>}
                        <button className="act act-quiet" onClick={() => onOpenVideo(v.id)}>去这一集</button>
                        <button className="act act-quiet btn-danger-ghost" onClick={() => removeVideo(v.id)}>移出</button>
                      </span>
                    </div>
                  )
                })}
              </div>
            ) : <div className="mount-empty">还没有归入的集</div>}
            {dup.size > 0 && <div className="field-err">有几集集数重复了，改一下</div>}
            <div className="vp-add">
              <SearchSelect variant="field" className="vp-add-select" value={adding} placeholder={free.length ? `选一个未归入系列的视频（${free.length} 个）` : '没有未归入系列的视频'}
                searchPlaceholder="搜标题或目录" options={freeOptions} emptyText="没有未归入系列的视频" disabled={!free.length}
                onChange={(v) => setAdding(v)} />
              <button className="act" disabled={!adding} onClick={addVideo}>加入系列</button>
            </div>
          </section>
        ) : <div className="mount-empty">建好系列后可以把视频加进来</div>}
      </div>
      <div className="drawer-foot">
        <div className="spacer" />
        {tried && !d.name.trim() && <span className="field-err">名称必填</span>}
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
        <button className="btn btn-primary" onClick={save}>{creating ? '创建' : '保存'}</button>
      </div>

      {confirm && (
        <div className="vp-modal-mask" onClick={() => setConfirm(null)}>
          <div className="vp-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="vp-modal-title">影响范围</div>
            <div className="list-sub">改了{changed.map((f) => f.label).join('、')}。下面这些集需要重新录屏渲染，勾上的会标为「待同步」。</div>
            <div className="vp-modal-list">
              {eps.map((v) => (
                <label key={v.id} className="vp-check-row">
                  <input type="checkbox" checked={confirm.includes(v.id)}
                    onChange={(e) => setConfirm(e.target.checked ? [...confirm, v.id] : confirm.filter((x) => x !== v.id))} />
                  <span className="vp-ep-no">{v.episode ?? '-'}</span>
                  <span className="ellipsis">{v.title}</span>
                  <span className="spacer" />
                  <span className={cls('vp-stage-label', `vp-tone-${videoState(v).tone}`)}>{videoState(v).label}</span>
                </label>
              ))}
            </div>
            <div className="vp-modal-foot">
              <button className="act act-quiet" onClick={() => setConfirm(confirm.length === eps.length ? [] : eps.map((v) => v.id))}>{confirm.length === eps.length ? '全不选' : '全选'}</button>
              <div className="spacer" />
              <button className="btn btn-ghost" onClick={() => setConfirm(null)}>返回修改</button>
              <button className="btn btn-primary" onClick={confirmSave}>{confirm.length ? `保存并标记 ${confirm.length} 集` : '只保存'}</button>
            </div>
          </div>
        </div>
      )}
    </aside>
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

export function PublishPage({ publishes, videos, artifacts, videoId, onPublishes, onOpenVideo, onOpenUrl, onClearFilter, channels, onConnect }: {
  publishes: Publish[]; videos: Video[]; artifacts: Artifact[]
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
  const pubsRef = useRef(publishes)
  useEffect(() => { pubsRef.current = publishes })

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
      <div key={p.id} className={cls('vp-row', open === p.id && 'sel')} onClick={() => setOpen(p.id)}>
      <span className="task-main">
        <span className="task-title"><span className="ellipsis">{p.title || '未填标题'}</span></span>
        <span className="task-meta"><span className="ellipsis">{titleOf(p.video_id)}</span></span>
      </span>
      <span><PlatformTag k={p.platform} /></span>
      <span className="vp-var">
        <span className="tag">{ORIENT[p.variant].label}</span>
        {cv ? <CoverSwatch variant={p.variant} option={cv.option} size="sm" title={cv.name} /> : <span className="faint">无封面</span>}
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
        actions={<button className="btn btn-primary" onClick={() => setOpen('new')}><PlusIcon />新建发布</button>}>发布记录</PageTitle>

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
          onClose={() => setOpen(null)} onOpenVideo={onOpenVideo} onOpenUrl={onOpenUrl}
          onRetry={() => retry(current.id)} onPublishNow={() => { update(current.id, { status: 'planned', scheduled_at: undefined }); runPublish(current.id) }}
          onMetrics={(m) => update(current.id, { metrics: m })}
          onDelete={() => { onPublishes((xs) => xs.filter((x) => x.id !== current.id)); setOpen(null) }} />
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
  useEsc(onClose)

  const video = videos.find((v) => v.id === vid)
  const vOptions = useMemo(() => videoOptions(videos), [videos])
  const platform = platOf(plat)
  const covers = artifacts.filter((a) => a.video_id === vid && a.kind === 'cover' && a.variant === variant).sort((a, b) => (a.option ?? 0) - (b.option ?? 0))
  const descArt = artifacts.filter((a) => a.video_id === vid && a.kind === 'description').sort((a, b) => b.version - a.version)[0]
  const missPrefer = video && !video.orientations.includes(platform.prefer)

  const changeVideo = (id: string) => {
    const v = videos.find((x) => x.id === id)
    if (!title.trim() || title === video?.title) setTitle(v?.title ?? '')
    setVid(id); setVariant(pickVariant(v, plat)); setCover(undefined); setDescHint('')
  }
  const changePlat = (k: PlatformKey) => { setPlat(k); setVariant(pickVariant(video, k)); setCover(undefined) }
  const fillDesc = () => {
    if (!descArt) { setDescHint('这集还没有简介产出物，先在分发包阶段出简介，或者直接手写'); return }
    setDesc(`${video?.title ?? ''}\n\n（取自简介产出物 ${descArt.path}，第 ${descArt.version} 版，${descArt.status === 'final' || descArt.status === 'published' ? '已定稿' : '还没定稿'}）`)
    setDescHint('')
  }

  const when = new Date(at)
  const errors = [
    !video && '先选一个视频',
    !title.trim() && '标题必填',
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
          <span className="field-label">封面<span className="field-hint">{ORIENT[variant].label}封面产出物，共 {covers.length} 个版本</span></span>
          {covers.length ? (
            <div className="vp-covers">
              {covers.map((a) => (
                <span key={a.id} className="vp-cover-opt">
                  <CoverSwatch variant={variant} option={a.option} on={cover === a.id} title={`${a.name} · ${a.path}`} onClick={() => setCover(cover === a.id ? undefined : a.id)} />
                  <span className={cls('vp-cover-cap', a.status === 'published' && 'used')}>{a.status === 'published' ? '用过' : `版本 ${a.option ?? '-'}`}</span>
                </span>
              ))}
            </div>
          ) : <div className="mount-empty">这集还没有{ORIENT[variant].label}封面，先在分发包阶段出封面；不选也能发</div>}
        </div>

        <label className="field">
          <span className="field-label">标题<em>*</em></span>
          <input value={title} className={cls(tried && !title.trim() && 'bad')} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label vp-label-row">
            <span>简介</span><span className="spacer" />
            <button type="button" className="act act-quiet" onClick={fillDesc}>从简介产出物带入</button>
          </span>
          <textarea rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="平台显示的简介" />
          {descHint && <span className="vp-hint">{descHint}</span>}
        </label>

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
        {tried && errors.length > 0 && <span className="field-err">{errors[0]}</span>}
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={!videos.length} onClick={submit}>{!auto ? '登记发布记录' : mode === 'now' ? '立即发布' : '定时发布'}</button>
      </div>
    </aside>
  )
}

function PublishDrawer({ p, video, cover, sending, onClose, onOpenVideo, onOpenUrl, onRetry, onPublishNow, onMetrics, onDelete }: {
  p: Publish; video: Video | undefined; cover: Artifact | undefined; sending: boolean
  onClose: () => void
  onOpenVideo: (id: string) => void
  onOpenUrl: (url: string, title: string) => void
  onRetry: () => void
  onPublishNow: () => void
  onMetrics: (m: Metrics) => void
  onDelete: () => void
}) {
  const [fill, setFill] = useState<Record<MetricKey, string> | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)
  useEsc(onClose)
  const plat = platOf(p.platform)

  const startFill = () => setFill({
    views: String(p.metrics?.views ?? 0), likes: String(p.metrics?.likes ?? 0), comments: String(p.metrics?.comments ?? 0), shares: String(p.metrics?.shares ?? 0),
  })
  const bad = (s: string) => !/^\d+$/.test(s.trim())
  const saveFill = () => {
    if (!fill || METRICS.some((m) => bad(fill[m.key]))) return
    onMetrics({ views: Number(fill.views), likes: Number(fill.likes), comments: Number(fill.comments), shares: Number(fill.shares), updated_at: new Date().toISOString() })
    setFill(null)
  }
  // 模拟拉取：在现有数字上随机涨一点
  const pull = () => {
    const m = p.metrics ?? { views: 0, likes: 0, comments: 0, shares: 0, updated_at: '' }
    const grow = (n: number, base: number, rate: number) => n + Math.round(base * Math.random() + n * rate * Math.random())
    onMetrics({ views: grow(m.views, 300, 0.2), likes: grow(m.likes, 25, 0.15), comments: grow(m.comments, 4, 0.12), shares: grow(m.shares, 3, 0.12), updated_at: new Date().toISOString() })
  }

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

        <dl className="props vp-props">
          <dt>视频</dt>
          <dd>{video ? <button className="link-btn ellipsis" onClick={() => onOpenVideo(video.id)}>{video.title}</button> : <span className="faint">已删除的视频</span>}</dd>
          <dt>平台</dt><dd>{plat.label}<span className="faint">（偏好{ORIENT[plat.prefer].label}）</span></dd>
          <dt>比例</dt>
          <dd>{ORIENT[p.variant].label} {ORIENT[p.variant].ratio}{p.variant !== plat.prefer && <span className="vp-hint-inline">平台建议{ORIENT[plat.prefer].label}</span>}</dd>
          <dt>封面</dt>
          <dd>{cover ? <><CoverSwatch variant={cover.variant ?? p.variant} option={cover.option} size="sm" /><span className="mono ellipsis">{cover.path}</span></> : <span className="faint">没有选封面</span>}</dd>
          {p.scheduled_at && <><dt>定时</dt><dd>{new Date(p.scheduled_at).toLocaleString('zh-CN')}</dd></>}
          {p.published_at && <><dt>发布于</dt><dd>{new Date(p.published_at).toLocaleString('zh-CN')}<span className="faint">（{timeAgo(p.published_at)}）</span></dd></>}
          <dt>链接</dt>
          <dd>{p.url ? <span className="mono ellipsis" title={p.url}>{p.url}</span> : <span className="faint">{p.status === 'published' ? '没有记链接' : '发布后生成'}</span>}</dd>
        </dl>

        <section className="field-group">
          <div className="field-group-title">简介</div>
          {p.desc ? <div className="vp-desc">{p.desc}</div> : <div className="faint">没有填简介</div>}
        </section>

        {p.status === 'published' && (
          <section className="field-group">
            <div className="vp-compare-head">
              <span className="field-group-title">数据<span className="field-hint">{p.metrics?.updated_at ? `${timeAgo(p.metrics.updated_at)}更新` : '还没回填'}</span></span>
              <span className="spacer" />
              {!fill && <><button className="act act-quiet" onClick={pull}>模拟拉取数据</button><button className="act" onClick={startFill}>回填数据</button></>}
            </div>
            {fill ? (
              <>
                <div className="vp-metric-form">
                  {METRICS.map((m) => (
                    <label key={m.key} className="field">
                      <span className="field-label">{m.label}</span>
                      <input inputMode="numeric" value={fill[m.key]} className={cls(bad(fill[m.key]) && 'bad')} onChange={(e) => setFill({ ...fill, [m.key]: e.target.value })} />
                    </label>
                  ))}
                </div>
                <div className="act-row">
                  <button className="act act-primary" disabled={METRICS.some((m) => bad(fill[m.key]))} onClick={saveFill}>保存</button>
                  <button className="act act-quiet" onClick={() => setFill(null)}>取消</button>
                  {METRICS.some((m) => bad(fill[m.key])) && <span className="field-err">只能填非负整数</span>}
                </div>
              </>
            ) : (
              <div className="vp-metric-grid">
                {METRICS.map((m) => <div key={m.key} className="vp-metric"><span className="stat-label">{m.label}</span><span className="vp-metric-v">{p.metrics ? num(p.metrics[m.key]) : '-'}</span></div>)}
              </div>
            )}
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