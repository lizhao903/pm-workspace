import './videos.css'
import { useEffect, useState } from 'react'
import { SearchSelect } from './searchselect'
import { Subnav } from './subnav'
import { PageTitle } from './topbar'
import { cls, timeAgo } from './ui'
import {
  ARTIFACT_KIND, ARTIFACT_STATUS, ORIENT, STAGES, stageIndex, videoState,
  type Artifact, type ArtifactKind, type ArtifactStatus, type Checkpoint, type CheckpointState, type Orientation, type Series, type StageKey, type Video,
} from './videodata'
import { newId } from './ids'

// 视频：按 web-video-presentation 的流程管一集视频——阶段时间线、检查点、产出物（带比例、版本、验收）、设置
// 数据约定在 videodata.ts；这里只读它的类型和常量

export type VideoView = 'all' | 'review' | 'single' | `sr:${string}` | `video:${string}` | 'series' | 'publish' | 'topics' | 'clips'

const Pill = ({ label, color }: { label: string; color: string }) => <span className="pill" style={{ '--c': color } as React.CSSProperties}><span className="pill-dot" />{label}</span>
const now = () => new Date().toISOString()
const KINDS = Object.keys(ARTIFACT_KIND) as ArtifactKind[]
const ORIENTS = Object.keys(ORIENT) as Orientation[]
const TONE_COLOR = { ok: 'var(--ok)', warn: 'var(--warn)', info: 'var(--accent)', muted: 'var(--faint)' }
const SOURCE_LABEL: Record<Artifact['source']['type'], string> = { manual: '手动', sop: 'SOP', agent: 'Agent', skill: '技能' }
const COVER_HUE = [24, 205, 145, 275, 340]
/** 每个比例出几版封面 */
const COVER_OPTIONS = 5

const orientText = (o: Orientation) => `${ORIENT[o].label} ${ORIENT[o].ratio}`
const ratioSlug = (o: Orientation) => ORIENT[o].ratio.replace(':', 'x')
const fmtDuration = (s?: number) => (s === undefined ? '' : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`)
const parseDuration = (s: string) => {
  const t = s.trim()
  if (/^\d+:\d{1,2}$/.test(t)) { const [m, x] = t.split(':').map(Number); return m * 60 + x }
  if (/^\d+$/.test(t)) return Number(t)
  return undefined
}
const cpOf = (v: Video, k: StageKey) => v.checkpoints.find((c) => c.stage === k)
const isFinished = (v: Video) => v.stage === 'distribution' && cpOf(v, 'distribution')?.state === 'passed'
/** 规划检查通过后比例锁定：每个比例是一个独立的演示工程，换比例等于重做 */
const orientLocked = (v: Video) => cpOf(v, 'plan')?.state === 'passed'
// 演示工程自己的预览服务端口；别和项目原型的端口撞上，不然内置浏览器会把它当成那个原型
const previewUrl = (v: Video, a: Artifact) => `http://127.0.0.1:7801/${v.root}/${a.path}`
const previewTitle = (v: Video, a: Artifact) => `${v.title} · ${a.name}${a.variant ? `（${ORIENT[a.variant].label}）` : ''}`

// 「选用」哪张封面：videodata 的 Artifact 还没有这个字段，先挂一个可选的 picked；没标过的，已发布的那张算选用
type Picked = Artifact
const isPicked = (a: Artifact) => (a as Picked).picked ?? a.status === 'published'

function stepState(v: Video, i: number): 'done' | 'current' | 'todo' {
  const cur = stageIndex(v.stage)
  if (isFinished(v) || i < cur) return 'done'
  return i === cur ? 'current' : 'todo'
}

function seriesLine(v: Video, series: Series[]) {
  const s = series.find((x) => x.id === v.series_id)
  if (!s) return '单集'
  return v.episode ? `${s.name} · 第 ${v.episode} 集` : s.name
}

function defaultPath(kind: ArtifactKind, v: Video, variant?: Orientation, option?: number) {
  const base = v.root.split('/').filter(Boolean).pop() || 'video'
  switch (kind) {
    case 'presentation': return `presentation-${variant ?? 'landscape'}`
    case 'audio': return 'audio/'
    case 'video': return `out/${base}-${ratioSlug(variant ?? 'landscape')}.mp4`
    case 'cover': return `cover/${ratioSlug(variant ?? 'landscape')}-${option ?? 1}.png`
    default: return `${kind}.md`
  }
}
const defaultName = (kind: ArtifactKind, option?: number) => (kind === 'cover' ? `封面 ${option ?? 1}` : kind === 'video' ? '成片' : ARTIFACT_KIND[kind].label)

/** 阶段进度：8 段小条，做完的绿、当前的蓝（卡在检查点上的橙） */
export function StageBar({ v }: { v: Video }) {
  const st = videoState(v)
  return (
    <span className="vd-bar" title={`${stageIndex(v.stage) + 1} / ${STAGES.length} · ${st.label}`}>
      {STAGES.map((s, i) => {
        const x = stepState(v, i)
        return <i key={s.key} className={cls('vd-seg', x === 'done' && 'vd-seg-done', x === 'current' && (st.tone === 'warn' ? 'vd-seg-warn' : 'vd-seg-cur'))} />
      })}
    </span>
  )
}

export const VideoStatePill = ({ v }: { v: Video }) => { const s = videoState(v); return <Pill label={s.label} color={TONE_COLOR[s.tone]} /> }

const OrientShape = ({ o }: { o: Orientation }) => <i className="vd-shape" style={{ aspectRatio: `${ORIENT[o].w} / ${ORIENT[o].h}` }} />

/* ---------- 二级菜单 ---------- */

/** 等我动手的：停在检查点上待确认，或者被退回待修改 */
const needsMe = (v: Video) => videoState(v).tone === 'warn'

// 菜单只放视图和系列，单集不进菜单：一个系列几十集时菜单会被撑得没法用，集数在系列页的表里看
// 系列多了也只放几个：有待处理的、当前打开的、最近更新的，全部系列在「系列管理」里
const MENU_SERIES = 6
export function VideosNav({ videos, series, view, onSelect, onNew, pendingClips = 0 }: { videos: Video[]; series: Series[]; view: VideoView; onSelect: (v: VideoView) => void; onNew: () => void; pendingClips?: number }) {
  const single = videos.filter((v) => !series.some((s) => s.id === v.series_id))
  const review = videos.filter(needsMe).length
  // 打开某一集时，高亮它所在的系列
  const cur = view.startsWith('video:') ? videos.find((v) => v.id === view.slice(6)) : undefined
  const active: VideoView = cur ? (series.some((s) => s.id === cur.series_id) ? `sr:${cur.series_id}` : 'single') : view
  const desc = (xs: Video[]) => {
    const w = xs.filter(needsMe).length
    return `${xs.length} 集${w ? ` · ${w} 集待处理` : ''}`
  }
  const latest = (id: string) => videos.reduce((m, v) => (v.series_id === id && v.updated_at > m ? v.updated_at : m), '')
  const menuSeries = series.length <= MENU_SERIES + 1 ? series : (() => {
    const rank = [...series].sort((a, b) => Number(`sr:${b.id}` === active) - Number(`sr:${a.id}` === active)
      || Number(videos.some((v) => v.series_id === b.id && needsMe(v))) - Number(videos.some((v) => v.series_id === a.id && needsMe(v)))
      || latest(b.id).localeCompare(latest(a.id)))
    const keep = new Set(rank.slice(0, MENU_SERIES).map((s) => s.id))
    return series.filter((s) => keep.has(s.id))
  })()
  return (
    <Subnav title="视频" active={active} onSelect={onSelect} items={[
      { key: 'all' as VideoView, label: '全部视频', group: '视图' },
      { key: 'review' as VideoView, label: '待我处理', desc: review ? `${review} 集停在检查点或被退回` : '没有要处理的', alert: review, group: '视图' },
      { key: 'publish' as VideoView, label: '发布记录', group: '视图' },
      { key: 'series' as VideoView, label: '系列管理', desc: series.length > menuSeries.length ? `全部 ${series.length} 个系列` : '共用开场收尾、集数编排', group: '视图' },
      { key: 'topics' as VideoView, label: '选题', desc: '打分排优先级，可开拍了就立项', group: '策划' },
      { key: 'clips' as VideoView, label: '素材收件箱', desc: pendingClips ? `${pendingClips} 条待整理` : '评论、热榜、竞品、想法', alert: pendingClips, group: '策划' },
      ...menuSeries.map((s) => {
        const xs = videos.filter((v) => v.series_id === s.id)
        return { key: `sr:${s.id}` as VideoView, label: s.name, desc: desc(xs), group: '系列', alert: xs.filter(needsMe).length }
      }),
      ...(single.length ? [{ key: 'single' as VideoView, label: '单集', desc: desc(single), group: '系列', alert: single.filter(needsMe).length }] : []),
    ]}>
      <button className="subnav-new" onClick={onNew}>
        <svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        新建视频
      </button>
    </Subnav>
  )
}

/* ---------- 列表：全部 / 待处理 / 某个系列 / 单集 ---------- */

type StageFilter = '' | StageKey | 'done'
const stageOf = (v: Video): StageFilter => (isFinished(v) ? 'done' : v.stage)

/** 阶段分布条：一眼看出这批视频卡在哪；点一段按这个阶段筛 */
function StageDist({ videos, value, onChange }: { videos: Video[]; value: StageFilter; onChange: (s: StageFilter) => void }) {
  const keys: StageFilter[] = [...STAGES.map((s) => s.key), 'done']
  const n = (k: StageFilter) => videos.filter((v) => stageOf(v) === k).length
  const warn = (k: StageFilter) => videos.some((v) => stageOf(v) === k && needsMe(v))
  const label = (k: StageFilter) => (k === 'done' ? '已完成' : STAGES.find((s) => s.key === k)!.label)
  const total = videos.length || 1
  return (
    <div className="vd-dist">
      <div className="vd-dist-bar">
        {keys.filter((k) => n(k)).map((k) => (
          <button key={k} className={cls('vd-dist-seg', `vd-ds-${k === 'done' ? 'done' : warn(k) ? 'warn' : 'cur'}`, value === k && 'on')}
            style={{ flexGrow: n(k) / total }} title={`${label(k)} ${n(k)} 集`} onClick={() => onChange(value === k ? '' : k)} />
        ))}
      </div>
      <div className="vd-dist-legend">
        {keys.map((k) => n(k) > 0 && (
          <button key={k} className={cls('vd-dist-chip', value === k && 'on', warn(k) && 'warn')} onClick={() => onChange(value === k ? '' : k)}>
            {label(k)}<b>{n(k)}</b>
          </button>
        ))}
        {value && <button className="link-btn" onClick={() => onChange('')}>清除</button>}
      </div>
    </div>
  )
}

export function VideosListPage({ view, videos, artifacts, series, projects, onOpen, onNew, onView }: {
  view: VideoView
  videos: Video[]; artifacts: Artifact[]; series: Series[]; projects: { id: string; name: string }[]
  onOpen: (id: string) => void
  /** 在某个系列里新建：带上系列和下一集的集数 */
  onNew: (seriesId?: string) => void
  onView: (v: VideoView) => void
}) {
  const sr = view.startsWith('sr:') ? series.find((s) => s.id === view.slice(3)) : undefined
  const scope = sr ? videos.filter((v) => v.series_id === sr.id)
    : view === 'single' ? videos.filter((v) => !series.some((s) => s.id === v.series_id))
      : view === 'review' ? videos.filter(needsMe)
        : videos
  const [stage, setStage] = useState<StageFilter>('')
  const [proj, setProj] = useState('')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<'episode' | 'updated'>(sr ? 'episode' : 'updated')
  // 切到别的系列时筛选清空
  useEffect(() => { setStage(''); setQ(''); setProj(''); setSort(view.startsWith('sr:') ? 'episode' : 'updated') }, [view])
  const kw = q.trim().toLowerCase()
  const projName = (id?: string) => (id ? projects.find((p) => p.id === id)?.name ?? '已删除的项目' : '')
  const rows = scope.filter((v) => (!stage || stageOf(v) === stage) && (!proj || (proj === '-' ? !v.project_id : v.project_id === proj))
    && (!kw || `${v.title}${v.root}${v.episode ?? ''}`.toLowerCase().includes(kw)))
    .sort(sort === 'episode' ? (a, b) => (a.episode ?? 9999) - (b.episode ?? 9999) || a.created_at.localeCompare(b.created_at) : (a, b) => b.updated_at.localeCompare(a.updated_at))
  const filtered = !!(stage || proj || kw)
  // 全部视频、没筛选时按系列分组，每组只露几集，长系列点进去看
  const grouped = view === 'all' && !filtered
  const title = sr ? sr.name : view === 'single' ? '单集' : view === 'review' ? '待我处理' : '全部视频'
  const desc = sr ? sr.desc : view === 'review' ? '停在检查点上等你确认，或者被退回要改的' : view === 'single' ? '不属于任何系列的视频' : '按系列分组；点系列看全部集数'
  const stale = new Set(sr?.stale ?? [])
  const nextEp = sr ? Math.max(0, ...scope.map((v) => v.episode ?? 0)) + 1 : 0

  const Row = ({ v, showSeries }: { v: Video; showSeries: boolean }) => {
    const arts = artifacts.filter((a) => a.video_id === v.id).length
    // 第二行只放有信息的：所属系列（跨系列列表里）、项目、产出物数；都没有就单行，长系列一屏能看更多集
    const meta = showSeries || !!projName(v.project_id) || arts > 0
    return (
    <div className={cls('vd-row', !meta && 'vd-row-1')} onClick={() => onOpen(v.id)}>
      <span className="vd-ep">{v.episode ? `${v.episode}` : '-'}</span>
      <span className="task-main">
        <span className="task-title"><span className="ellipsis">{v.title || '未命名视频'}</span>{stale.has(v.id) && <span className="vd-stale-tag" title="系列的开场、收尾或模板改过，这集要重新录屏渲染">待同步</span>}</span>
        {!meta && <span className="task-meta vd-narrow-xs"><StageBar v={v} /></span>}
        {meta && (
          <span className="task-meta">
            {showSeries && <span className="ellipsis">{seriesLine(v, series)}</span>}
            {projName(v.project_id) && <span className="ellipsis vd-wide">{projName(v.project_id)}</span>}
            <span className="vd-narrow-xs"><StageBar v={v} /></span>
            {arts > 0 && <span className="vd-wide">{arts} 个产出物</span>}
          </span>
        )}
      </span>
      <span className="vd-orient-cell">
        {v.orientations.length ? v.orientations.map((o) => <span key={o} className="vd-otag" title={orientText(o)}><OrientShape o={o} />{ORIENT[o].ratio}</span>) : <span className="faint">未定</span>}
      </span>
      <span className="vd-prog"><StageBar v={v} /><span className="run-muted">{stageIndex(v.stage) + 1}/{STAGES.length}</span></span>
      <span><VideoStatePill v={v} /></span>
      <span className="run-muted">{timeAgo(v.updated_at)}</span>
    </div>
    )
  }
  const Head = () => <div className="vd-row task-th"><span>集</span><span>视频</span><span>比例</span><span>进度</span><span>状态</span><span>更新</span></div>

  // 分组时每组先露「等我处理的」，再按更新时间补满
  const PEEK = 4
  const peek = (xs: Video[]) => [...xs].sort((a, b) => Number(needsMe(b)) - Number(needsMe(a)) || b.updated_at.localeCompare(a.updated_at)).slice(0, PEEK)
  const groups = [
    ...series.map((s) => ({ key: `sr:${s.id}` as VideoView, name: s.name, xs: videos.filter((v) => v.series_id === s.id) })),
    { key: 'single' as VideoView, name: '单集', xs: videos.filter((v) => !series.some((s) => s.id === v.series_id)) },
  ].filter((g) => g.xs.length)

  return (
    <div className="page page-fill">
      <PageTitle parent="视频" count={scope.length} desc={desc} actions={<>
        {sr && <button className="btn btn-outline" onClick={() => onView('series')}>系列设置</button>}
        <button className="btn btn-primary" onClick={() => onNew(sr?.id)}>
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          {sr ? `新建第 ${nextEp} 集` : '新建视频'}
        </button>
      </>}>{title}</PageTitle>

      {sr && (sr.intro || sr.outro || sr.template) && (
        <div className="vd-sr-shared">
          <span><span className="run-muted">开场</span>{sr.intro || '无'}</span>
          <span><span className="run-muted">收尾</span>{sr.outro || '无'}</span>
          <span><span className="run-muted">模板</span>{sr.template || '无'}</span>
          {sr.stale.length > 0 && <span className="vd-stale-tag">{sr.stale.length} 集待同步</span>}
        </div>
      )}

      {scope.length > 0 && view !== 'review' && <StageDist videos={scope} value={stage} onChange={setStage} />}

      <div className="toolbar">
        <div className="search vd-search">
          <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder={sr ? '搜标题或集数' : '搜标题、目录'} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {!sr && (
          <SearchSelect value={proj} onChange={setProj} noneLabel="全部项目" searchPlaceholder="搜项目" missingLabel={() => '已删除的项目'}
            options={[...projects.map((p) => ({ value: p.id, label: p.name })), { value: '-', label: '不属于项目' }]} />
        )}
        <span className="spacer" />
        {!grouped && (
          <div className="seg seg-sm">
            <button className={cls(sort === 'episode' && 'on')} onClick={() => setSort('episode')}>按集数</button>
            <button className={cls(sort === 'updated' && 'on')} onClick={() => setSort('updated')}>按更新</button>
          </div>
        )}
      </div>

      {grouped ? (
        <div className="vd-groups">
          {groups.map((g) => (
            <section key={g.key} className="vd-group">
              <div className="vd-group-head">
                <button className="vd-group-name" onClick={() => onView(g.key)}>{g.name}</button>
                <span className="run-muted">{g.xs.length} 集 · 已完成 {g.xs.filter(isFinished).length}{g.xs.some(needsMe) ? ` · ${g.xs.filter(needsMe).length} 集待处理` : ''}</span>
                <span className="vd-group-bar"><StageDist videos={g.xs} value="" onChange={() => onView(g.key)} /></span>
                <span className="spacer" />
                {g.xs.length > PEEK && <button className="act act-quiet" onClick={() => onView(g.key)}>查看全部 {g.xs.length} 集</button>}
              </div>
              <div className="task-table">
                {peek(g.xs).map((v) => <Row key={v.id} v={v} showSeries={false} />)}
              </div>
            </section>
          ))}
        </div>
      ) : !rows.length ? (
        <div className="empty">
          <div className="empty-title">{filtered ? '没有匹配的视频' : view === 'review' ? '没有等你处理的视频' : '还没有视频'}</div>
          <div className="list-sub">{filtered ? '换个筛选条件试试' : view === 'review' ? '检查点都确认过了' : '把一篇文章或口播稿做成网页演示，再录成视频'}</div>
        </div>
      ) : (
        <div className="task-table">
          <Head />
          {rows.map((v) => <Row key={v.id} v={v} showSeries={!sr} />)}
        </div>
      )}
    </div>
  )
}

/* ---------- 详情 ---------- */

type DetailTab = 'flow' | 'artifacts' | 'settings'
const TABS: { key: DetailTab; label: string }[] = [{ key: 'flow', label: '制作流程' }, { key: 'artifacts', label: '产出物' }, { key: 'settings', label: '设置' }]

interface NewArt { kind: ArtifactKind; variant?: Orientation; option?: number; name: string; path: string; duration: string; touched: boolean }

export function VideoDetail({ video, artifacts, series, projects, publishCount, onChange, onArtifacts, onOpenSeries, onOpenPublish, onPreview, onDelete }: {
  video: Video; artifacts: Artifact[]; series: Series[]; projects: { id: string; name: string }[]; publishCount: number
  onChange: (v: Video) => void
  onArtifacts: (fn: (xs: Artifact[]) => Artifact[]) => void
  onOpenSeries: (id: string) => void
  onOpenPublish: (videoId: string) => void
  /** 在内置浏览器里预览：演示工程、视频、封面 */
  onPreview: (url: string, title: string) => void
  onDelete: () => void
}) {
  const v = video
  const [tab, setTab] = useState<DetailTab>('flow')
  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState<NewArt | null>(null)
  const [rejecting, setRejecting] = useState<StageKey | null>(null)
  const [note, setNote] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  const mine = artifacts.filter((a) => a.video_id === v.id)
  const sr = series.find((s) => s.id === v.series_id)
  const proj = projects.find((p) => p.id === v.project_id)
  const opened = mine.find((a) => a.id === openId)
  const locked = orientLocked(v)

  const set = (x: Partial<Video>) => onChange({ ...v, ...x, updated_at: now() })
  const touch = () => onChange({ ...v, updated_at: now() })
  const updArt = (id: string, fn: (a: Artifact) => Artifact) => { onArtifacts((xs) => xs.map((x) => (x.id === id ? fn(x) : x))); touch() }
  const preview = (a: Artifact) => onPreview(previewUrl(v, a), previewTitle(v, a))

  const decide = (k: StageKey, state: CheckpointState, why?: string) => {
    const i = stageIndex(k)
    // 退回不往前走，停在检查点上等修改；最后一步通过后也停在分发包，状态算「已完成」
    const next = state === 'rejected' || i === STAGES.length - 1 ? k : STAGES[i + 1].key
    const cp: Checkpoint = { stage: k, state, at: now(), note: why?.trim() || undefined }
    const cps = v.checkpoints.some((c) => c.stage === k) ? v.checkpoints.map((c) => (c.stage === k ? cp : c)) : [...v.checkpoints, cp]
    set({ stage: next, checkpoints: cps })
    setRejecting(null); setNote('')
  }
  const advance = (k: StageKey) => { const i = stageIndex(k); if (i < STAGES.length - 1) set({ stage: STAGES[i + 1].key }) }

  const freeOption = (variant?: Orientation) => {
    for (let o = 1; o <= COVER_OPTIONS; o += 1) if (!mine.some((a) => a.kind === 'cover' && a.variant === variant && a.option === o)) return o
    return COVER_OPTIONS
  }
  const startNew = (kind: ArtifactKind, variant?: Orientation, option?: number) => {
    const per = ARTIFACT_KIND[kind].perVariant
    const vr = per ? variant ?? v.orientations[0] ?? 'landscape' : undefined
    const op = kind === 'cover' ? option ?? freeOption(vr) : undefined
    setDraft({ kind, variant: vr, option: op, name: defaultName(kind, op), path: defaultPath(kind, v, vr, op), duration: '', touched: false })
    setTab('artifacts')
  }
  // 改类型、比例、版本号时，名称和路径跟着变；手动改过路径就不再覆盖
  const patchDraft = (x: Partial<NewArt>) => {
    if (!draft) return
    const d = { ...draft, ...x }
    if (x.kind) {
      d.variant = ARTIFACT_KIND[d.kind].perVariant ? d.variant ?? v.orientations[0] ?? 'landscape' : undefined
      d.option = d.kind === 'cover' ? d.option ?? freeOption(d.variant) : undefined
    }
    if (x.kind || x.option !== undefined) d.name = defaultName(d.kind, d.option)
    if (!d.touched && (x.kind || x.variant || x.option !== undefined)) d.path = defaultPath(d.kind, v, d.variant, d.option)
    setDraft(d)
  }
  const addArt = () => {
    if (!draft) return
    const a: Artifact = {
      id: newId('af'), video_id: v.id, kind: draft.kind, name: draft.name.trim() || defaultName(draft.kind, draft.option), path: draft.path.trim(),
      variant: draft.variant, option: draft.option, version: 1, status: 'draft',
      duration: draft.kind === 'audio' || draft.kind === 'video' ? parseDuration(draft.duration) : undefined,
      source: { type: 'manual', label: '手动登记' }, reviews: [], created_at: now(),
    }
    onArtifacts((xs) => [...xs, a]); touch()
    setDraft(null)
  }
  const pickCover = (a: Artifact) => {
    const on = !isPicked(a)
    onArtifacts((xs) => xs.map((x) => (x.video_id === a.video_id && x.kind === 'cover' && x.variant === a.variant ? { ...x, picked: x.id === a.id ? on : false } : x)))
    touch()
  }

  const actions = (
    <>
      {publishCount > 0 && <button className="btn btn-outline" onClick={() => onOpenPublish(v.id)}>发布记录<span className="seg-n">{publishCount}</span></button>}
      {tab === 'artifacts' && <button className="btn btn-primary" onClick={() => startNew(KINDS.find((k) => ARTIFACT_KIND[k].stage === v.stage) ?? 'script')}>新增产出物</button>}
      {tab === 'flow' && sr && <button className="btn btn-outline" onClick={() => onOpenSeries(sr.id)}>查看系列</button>}
    </>
  )
  const descText = [seriesLine(v, series), proj?.name, v.orientations.map((o) => ORIENT[o].ratio).join(' / ') || '比例未定', videoState(v).label].filter(Boolean).join(' · ')

  const artLine = (a: Artifact) => (
    <div key={a.id} className={cls('vd-art-line', openId === a.id && 'sel')} onClick={() => setOpenId(a.id)}>
      <span className="tag">{ARTIFACT_KIND[a.kind].label}</span>
      <span className="ellipsis vd-art-name">{a.name}</span>
      {a.variant && <span className="vd-otag"><OrientShape o={a.variant} />{ORIENT[a.variant].ratio}</span>}
      <span className="vd-ver">v{a.version}</span>
      <Pill {...ARTIFACT_STATUS[a.status]} />
      {(a.kind === 'presentation' || a.kind === 'video' || a.kind === 'cover') && <button className="act act-quiet" onClick={(e) => { e.stopPropagation(); preview(a) }}>预览</button>}
    </div>
  )

  return (
    <div className="page page-fill project-page vd-page">
      <PageTitle parent={sr ? <button className="vd-crumb" onClick={() => onOpenSeries(sr.id)}>{sr.name}</button> : '视频'} desc={descText} actions={actions}>{v.title || '未命名视频'}</PageTitle>
      <div className="project-tabs np-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={cls(tab === t.key && 'on')} onClick={() => setTab(t.key)}>
            {t.label}
            {t.key === 'artifacts' && <span className="seg-n">{mine.length}</span>}
            {t.key === 'flow' && videoState(v).tone === 'warn' && <span className="side-dot" />}
          </button>
        ))}
      </div>

      {tab === 'flow' && (
        <ol className="vd-flow">
          {STAGES.map((s, i) => {
            const state = stepState(v, i)
            const cp = s.checkpoint ? cpOf(v, s.key) : undefined
            const items = mine.filter((a) => ARTIFACT_KIND[a.kind].stage === s.key)
            const cur = state === 'current' && !isFinished(v)
            const firstKind = KINDS.find((k) => ARTIFACT_KIND[k].stage === s.key)
            const pres = mine.filter((a) => a.kind === 'presentation')
            return (
              <li key={s.key} className={cls('vd-step', `vd-step-${state}`, s.checkpoint && 'vd-step-cp', cur && (cp?.state === 'pending' || cp?.state === 'rejected') && 'vd-step-wait')}>
                <span className="vd-dot">
                  {state === 'done'
                    ? <svg viewBox="0 0 16 16" width="11" height="11"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    : i + 1}
                </span>
                <div className="vd-step-body">
                  <div className="vd-step-head">
                    <b>{s.label}</b>
                    {s.checkpoint && <span className="vd-cp-tag">检查点</span>}
                    {cur && <span className="vd-now">当前</span>}
                    <span className="spacer" />
                    {cp?.state === 'passed' && <span className="vd-cp-res ok">已通过{cp.at && ` · ${timeAgo(cp.at)}`}</span>}
                    {cp?.state === 'skipped' && <span className="vd-cp-res">已跳过{s.key === 'audio' && '，不合成音频'}{cp.at && ` · ${timeAgo(cp.at)}`}</span>}
                    {cp?.state === 'rejected' && <span className="vd-cp-res warn">已退回{cp.at && ` · ${timeAgo(cp.at)}`}</span>}
                  </div>
                  <div className="list-sub">{s.desc}</div>
                  {cp?.note && cp.state !== 'rejected' && <div className="vd-cp-note">意见：{cp.note}</div>}

                  {s.key === 'plan' && (
                    <div className="vd-plan">
                      <div className="field-label">画面比例{locked ? <span className="field-hint">已锁定</span> : <span className="field-hint">可多选，每个比例是一个独立的演示工程</span>}</div>
                      <div className="vd-orients">
                        {ORIENTS.map((o) => {
                          const on = v.orientations.includes(o)
                          if (locked && !on) return null
                          return (
                            <button key={o} className={cls('chip vd-orient', on && 'chip-on', locked && 'vd-orient-locked')} disabled={locked}
                              onClick={() => set({ orientations: on ? v.orientations.filter((x) => x !== o) : ORIENTS.filter((x) => x === o || v.orientations.includes(x)) })}>
                              <OrientShape o={o} />{orientText(o)}
                            </button>
                          )
                        })}
                      </div>
                      {locked && <div className="list-sub">比例定了不能改，要换比例得新开工程</div>}
                    </div>
                  )}

                  {s.key === 'ch1' && (cur || pres.length > 0) && (
                    <div className="vd-sub">
                      <div className="field-group-title">要验收的演示工程<span className="field-hint">第 1 章是后面所有章节的样板，按比例逐个看</span></div>
                      {pres.length ? pres.map(artLine) : <div className="mount-empty">还没登记演示工程。<button className="link-btn" onClick={() => startNew('presentation')}>去登记</button></div>}
                    </div>
                  )}

                  {items.length > 0 && <div className="vd-sub">{items.map(artLine)}</div>}
                  {cur && !items.length && firstKind && !s.checkpoint && (
                    <div className="mount-empty">这一步还没登记产出物。<button className="link-btn" onClick={() => startNew(firstKind)}>登记一个</button></div>
                  )}

                  {cur && s.checkpoint && cp?.state !== 'passed' && cp?.state !== 'skipped' && (
                    <div className="vd-cp-box">
                      {cp?.state === 'rejected' && <div className="vd-cp-reject">退回意见：{cp.note || '没写意见'}</div>}
                      {rejecting === s.key ? (
                        <>
                          <textarea rows={3} autoFocus value={note} placeholder="哪里不行、要怎么改" onChange={(e) => setNote(e.target.value)} />
                          <div className="act-row">
                            <button className="act act-danger" disabled={!note.trim()} onClick={() => decide(s.key, 'rejected', note)}>确认退回</button>
                            <button className="act act-quiet" onClick={() => { setRejecting(null); setNote('') }}>取消</button>
                            {!note.trim() && <span className="list-sub">退回要写意见</span>}
                          </div>
                        </>
                      ) : (
                        <div className="act-row">
                          <button className="act act-primary" disabled={s.key === 'plan' && !v.orientations.length} title={s.key === 'plan' && !v.orientations.length ? '先选至少一个画面比例' : undefined}
                            onClick={() => decide(s.key, 'passed')}>{cp?.state === 'rejected' ? '改好了，通过' : '通过'}</button>
                          <button className="act" onClick={() => { setRejecting(s.key); setNote('') }}>{cp?.state === 'rejected' ? '再次退回' : '退回'}</button>
                          {s.key === 'audio' && <button className="act act-quiet" onClick={() => decide(s.key, 'skipped')}>跳过（不合成音频）</button>}
                          {s.key === 'plan' && <span className="list-sub">通过后比例锁定</span>}
                        </div>
                      )}
                    </div>
                  )}
                  {cur && !s.checkpoint && i < STAGES.length - 1 && (
                    <div className="act-row vd-adv"><button className="act act-primary" onClick={() => advance(s.key)}>这一步做完了，进入「{STAGES[i + 1].label}」</button></div>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}

      {tab === 'artifacts' && (
        <div className="vd-arts">
          {draft && (
            <div className="inline-form">
              <div className="field-row">
                <label className="field"><span className="field-label">类型</span>
                  <select value={draft.kind} onChange={(e) => patchDraft({ kind: e.target.value as ArtifactKind })}>
                    {KINDS.map((k) => <option key={k} value={k}>{ARTIFACT_KIND[k].label}（{STAGES[stageIndex(ARTIFACT_KIND[k].stage)].label}）</option>)}
                  </select>
                </label>
                {ARTIFACT_KIND[draft.kind].perVariant && (
                  <div className="field"><span className="field-label">比例</span>
                    <div className="seg seg-sm">
                      {(v.orientations.length ? v.orientations : ORIENTS).map((o) => <button key={o} className={cls(draft.variant === o && 'on')} onClick={() => patchDraft({ variant: o, option: draft.kind === 'cover' ? freeOption(o) : undefined })}>{orientText(o)}</button>)}
                    </div>
                  </div>
                )}
              </div>
              {!v.orientations.length && ARTIFACT_KIND[draft.kind].perVariant && <span className="list-sub">还没定画面比例，先在规划检查里选好</span>}
              <div className="field-row">
                <label className="field"><span className="field-label">名称</span><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
                {draft.kind === 'cover' ? (
                  <label className="field"><span className="field-label">第几版</span>
                    <select value={draft.option} onChange={(e) => patchDraft({ option: Number(e.target.value) })}>
                      {Array.from({ length: COVER_OPTIONS }, (_, k) => k + 1).map((o) => <option key={o} value={o}>第 {o} 版</option>)}
                    </select>
                  </label>
                ) : (draft.kind === 'audio' || draft.kind === 'video') ? (
                  <label className="field"><span className="field-label">时长<span className="field-hint">mm:ss，可不填</span></span><input value={draft.duration} placeholder="10:02" onChange={(e) => setDraft({ ...draft, duration: e.target.value })} /></label>
                ) : <span />}
              </div>
              <label className="field"><span className="field-label">路径<span className="field-hint">相对视频目录 {v.root || '（未设置）'}</span></span>
                <input className="mono" value={draft.path} onChange={(e) => setDraft({ ...draft, path: e.target.value, touched: true })} />
              </label>
              <div className="act-row">
                <button className="act act-primary" disabled={!draft.path.trim() || (ARTIFACT_KIND[draft.kind].perVariant && !draft.variant)} onClick={addArt}>登记</button>
                <button className="act act-quiet" onClick={() => setDraft(null)}>取消</button>
                <span className="list-sub">登记后是草稿，验收通过才算定稿</span>
              </div>
            </div>
          )}
          {!mine.length && !draft && (
            <div className="empty"><div className="empty-title">还没有产出物</div><div className="list-sub">文稿、演示工程、音频、成片、封面、简介、章节时间轴都登记在这里</div>
              <button className="btn btn-primary" onClick={() => startNew('script')}>新增产出物</button></div>
          )}
          {KINDS.map((k) => {
            const items = mine.filter((a) => a.kind === k)
            if (!items.length) return null
            const K = ARTIFACT_KIND[k]
            const variants = K.perVariant ? ORIENTS.filter((o) => v.orientations.includes(o) || items.some((a) => a.variant === o)) : []
            return (
              <section key={k} className="hook-sec">
                <div className="mount-head">
                  <div className="field-group-title">{K.label}<span className="field-hint">{STAGES[stageIndex(K.stage)].label} · {items.length} 个</span></div>
                  <button className="act act-quiet" onClick={() => startNew(k)}>加一个</button>
                </div>
                {!K.perVariant ? (
                  <div className="vd-list">{items.map((a) => <ArtRow key={a.id} a={a} v={v} sel={openId === a.id} onOpen={() => setOpenId(a.id)} />)}</div>
                ) : (
                  <div className="vd-cols">
                    {variants.map((o) => {
                      const xs = items.filter((a) => a.variant === o).sort((a, b) => (a.option ?? 0) - (b.option ?? 0))
                      return (
                        <div key={o} className="vd-col">
                          <div className="vd-col-head"><OrientShape o={o} />{orientText(o)}{!v.orientations.includes(o) && <span className="faint">（不在本工程比例里）</span>}</div>
                          {k === 'cover' ? (
                            <div className="vd-covers">
                              {Array.from({ length: Math.max(COVER_OPTIONS, ...xs.map((a) => a.option ?? 0)) }, (_, j) => j + 1).map((op) => {
                                const a = xs.find((x) => x.option === op)
                                return a ? (
                                  <button key={op} className={cls('vd-cover', openId === a.id && 'sel', isPicked(a) && 'picked')} title={`${a.name} · ${ARTIFACT_STATUS[a.status].label}`} onClick={() => setOpenId(a.id)}>
                                    <CoverThumb o={o} op={op} />
                                    <span className="vd-cover-foot"><i className="pill-dot" style={{ '--c': ARTIFACT_STATUS[a.status].color } as React.CSSProperties} />{isPicked(a) ? '选用' : `v${a.version}`}</span>
                                  </button>
                                ) : (
                                  <button key={op} className="vd-cover vd-cover-miss" title={`还没有第 ${op} 版，点一下登记`} onClick={() => startNew('cover', o, op)}>
                                    <span className="vd-thumb vd-thumb-miss" style={{ aspectRatio: `${ORIENT[o].w} / ${ORIENT[o].h}` }}>{op}</span>
                                    <span className="vd-cover-foot faint">缺</span>
                                  </button>
                                )
                              })}
                            </div>
                          ) : xs.length ? (
                            <div className="vd-list">{xs.map((a) => <ArtRow key={a.id} a={a} v={v} sel={openId === a.id} onOpen={() => setOpenId(a.id)} />)}</div>
                          ) : <div className="mount-empty">这个比例还没有{K.label}。<button className="link-btn" onClick={() => startNew(k, o)}>登记</button></div>}
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>
            )
          })}
          {mine.length > 0 && <div className="list-sub vd-arts-hint">没出现的类型说明还没登记，点右上角「新增产出物」</div>}
        </div>
      )}

      {tab === 'settings' && (
        <div className="form proj-settings">
          <section className="hook-sec">
            <div className="field-group-title">基本信息</div>
            <label className="field"><span className="field-label">标题</span><input value={v.title} placeholder="比如：第 4 集：知识库怎么喂" onChange={(e) => set({ title: e.target.value })} /></label>
            <div className="field-row">
              <label className="field"><span className="field-label">所属项目</span>
                <SearchSelect variant="field" value={v.project_id ?? ''} noneLabel="不属于项目" searchPlaceholder="搜项目" missingLabel={() => '已删除的项目'}
                  options={projects.map((p) => ({ value: p.id, label: p.name }))} onChange={(x) => set({ project_id: x || undefined })} />
              </label>
              <label className="field"><span className="field-label">章节数</span>
                <input type="number" min={1} value={v.chapters} onChange={(e) => set({ chapters: Math.max(1, Number(e.target.value) || 1) })} />
              </label>
            </div>
            <div className="field-row">
              <label className="field"><span className="field-label">系列<span className="field-hint">同系列共用开场、收尾和模板</span></span>
                <select value={v.series_id ?? ''} onChange={(e) => set({ series_id: e.target.value || undefined, episode: e.target.value ? v.episode ?? 1 : undefined })}>
                  <option value="">单集（不属于系列）</option>
                  {series.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label className="field"><span className="field-label">第几集</span>
                <input type="number" min={1} disabled={!v.series_id} value={v.episode ?? ''} onChange={(e) => set({ episode: e.target.value ? Math.max(1, Number(e.target.value)) : undefined })} />
              </label>
            </div>
          </section>
          <section className="hook-sec">
            <div className="field-group-title">视频目录<span className="field-hint">文稿、演示工程、音频、成片、封面的路径都相对它</span></div>
            <label className="field"><input className="mono" value={v.root} placeholder="videos/ep04-kb" onChange={(e) => set({ root: e.target.value })} /></label>
          </section>
          <section className="hook-sec">
            <div className="field-group-title">画面比例{locked && <span className="field-hint">已锁定</span>}</div>
            <div className="vd-orients">
              {v.orientations.length ? v.orientations.map((o) => <span key={o} className="vd-otag vd-otag-lg"><OrientShape o={o} />{orientText(o)}</span>) : <span className="faint">还没定</span>}
            </div>
            <div className="list-sub">{locked ? '比例定了不能改，要换比例得新开工程' : '在「制作流程」的规划检查里选，通过后锁定'}</div>
          </section>
          <section className="hook-sec danger-zone">
            <div className="field-group-title">删除视频</div>
            {confirmDel ? (
              <div className="act-row">
                <span className="danger-text">会一起删掉 {mine.length} 条产出物记录，视频目录里的文件不动</span>
                <button className="act act-quiet" onClick={() => setConfirmDel(false)}>取消</button>
                <button className="act btn-danger" onClick={() => { onArtifacts((xs) => xs.filter((x) => x.video_id !== v.id)); onDelete() }}>删除</button>
              </div>
            ) : <div className="act-row"><span className="list-sub">只删记录，本地文件不会被删</span><button className="act btn-danger-ghost" onClick={() => setConfirmDel(true)}>删除视频</button></div>}
          </section>
        </div>
      )}

      {opened && (
        <ArtifactDrawer key={opened.id} a={opened} v={v} onClose={() => setOpenId(null)}
          onUpdate={(fn) => updArt(opened.id, fn)}
          onPick={() => pickCover(opened)}
          onPreview={() => preview(opened)}
          onRemove={() => { onArtifacts((xs) => xs.filter((x) => x.id !== opened.id)); touch(); setOpenId(null) }} />
      )}
    </div>
  )
}

const CoverThumb = ({ o, op, big }: { o: Orientation; op: number; big?: boolean }) => (
  <span className={cls('vd-thumb', big && 'vd-thumb-big')} style={{ aspectRatio: `${ORIENT[o].w} / ${ORIENT[o].h}`, '--h': COVER_HUE[(op - 1) % COVER_HUE.length] } as React.CSSProperties}>{op}</span>
)

function ArtRow({ a, v, sel, onOpen }: { a: Artifact; v: Video; sel: boolean; onOpen: () => void }) {
  return (
    <div className={cls('vd-art-row', sel && 'sel')} onClick={onOpen}>
      <span className="vd-art-main">
        <span className="ellipsis vd-art-name">{a.name}</span>
        <code className="ellipsis vd-path" title={`${v.root}/${a.path}`}>{v.root ? `${v.root}/` : ''}{a.path}</code>
      </span>
      <span className="vd-art-meta">
        <span className="vd-ver">v{a.version}</span>
        <Pill {...ARTIFACT_STATUS[a.status]} />
        <span className="src-tag" title={a.source.label}>{SOURCE_LABEL[a.source.type]} · {a.source.label}</span>
        {a.duration !== undefined && <span className="vd-dur">{fmtDuration(a.duration)}</span>}
        {a.reviews.length > 0 && <span className="run-muted">验收 {a.reviews.length} 次</span>}
      </span>
    </div>
  )
}

/* ---------- 产出物抽屉 ---------- */

function ArtifactDrawer({ a, v, onClose, onUpdate, onPick, onPreview, onRemove }: {
  a: Artifact; v: Video
  onClose: () => void
  onUpdate: (fn: (a: Artifact) => Artifact) => void
  onPick: () => void
  onPreview: () => void
  onRemove: () => void
}) {
  const [cm, setCm] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const K = ARTIFACT_KIND[a.kind]
  const review = (ok: boolean) => {
    const r = { at: now(), ok, comment: cm.trim() || (ok ? '通过' : '') }
    // 通过算定稿；退回回到草稿，改完再提验收
    onUpdate((x) => ({ ...x, reviews: [...x.reviews, r], status: ok ? (x.status === 'published' ? 'published' : 'final') : 'draft' }))
    setCm('')
  }
  const canPreview = a.kind === 'presentation' || a.kind === 'video' || a.kind === 'cover' || a.kind === 'audio'
  return (
    <aside className="drawer vd-drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">{K.label}{a.variant && ` · ${orientText(a.variant)}`}{a.option && ` · 第 ${a.option} 版`}</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="drawer-body form">
        <div className="vd-dr-head">
          {a.kind === 'cover' && a.variant && <span className={cls('vd-dr-cover', a.variant === 'portrait' && 'tall')}><CoverThumb o={a.variant} op={a.option ?? 1} big /></span>}
          <div className="profile-text">
            <h2 className="vd-dr-title">{a.name}<span className="vd-ver">v{a.version}</span></h2>
            <div className="list-sub">{STAGES[stageIndex(K.stage)].label} · {timeAgo(a.created_at)}登记</div>
          </div>
          <Pill {...ARTIFACT_STATUS[a.status]} />
        </div>

        <dl className="props vd-props">
          <dt>完整路径</dt><dd><code className="vd-path">{v.root ? `${v.root}/` : ''}{a.path}</code></dd>
          <dt>来源</dt><dd>{SOURCE_LABEL[a.source.type]} · {a.source.label}</dd>
          {a.variant && <><dt>比例</dt><dd><span className="vd-otag"><OrientShape o={a.variant} />{orientText(a.variant)}</span></dd></>}
          {a.duration !== undefined && <><dt>时长</dt><dd className="vd-dur">{fmtDuration(a.duration)}</dd></>}
        </dl>

        <div className="field-row">
          <label className="field"><span className="field-label">名称</span><input value={a.name} onChange={(e) => onUpdate((x) => ({ ...x, name: e.target.value }))} /></label>
          <label className="field"><span className="field-label">路径<span className="field-hint">相对视频目录</span></span><input className="mono" value={a.path} onChange={(e) => onUpdate((x) => ({ ...x, path: e.target.value }))} /></label>
        </div>

        <div className="field">
          <span className="field-label">状态<span className="field-hint">草稿 → 待验收 → 已定稿 → 已发布</span></span>
          <div className="seg seg-full">
            {(Object.keys(ARTIFACT_STATUS) as ArtifactStatus[]).map((s) => <button key={s} className={cls(a.status === s && 'on')} onClick={() => onUpdate((x) => ({ ...x, status: s }))}>{ARTIFACT_STATUS[s].label}</button>)}
          </div>
        </div>

        {a.kind === 'cover' && (
          <div className="field">
            <span className="field-label">选用<span className="field-hint">同一比例只选一张，发布时默认用它</span></span>
            <div className="act-row">
              <button className={cls('act', !isPicked(a) && 'act-primary')} onClick={onPick}>{isPicked(a) ? '取消选用' : '选用这张'}</button>
              {isPicked(a) && <span className="vd-cp-res ok">已选用</span>}
            </div>
          </div>
        )}

        <section className="field-group">
          <div className="field-group-title">验收<span className="field-hint">退回要写意见；通过后状态变成已定稿</span></div>
          <textarea className="vd-textarea" rows={3} value={cm} placeholder="验收意见" onChange={(e) => setCm(e.target.value)} />
          <div className="act-row">
            <button className="act act-primary" onClick={() => review(true)}>通过</button>
            <button className="act act-danger" disabled={!cm.trim()} title={!cm.trim() ? '退回要写意见' : undefined} onClick={() => review(false)}>退回</button>
          </div>
          {a.reviews.length > 0 ? (
            <ul className="vd-reviews">
              {[...a.reviews].reverse().map((r, i) => (
                <li key={i}>
                  <span className={cls('vd-cp-res', r.ok ? 'ok' : 'warn')}>{r.ok ? '通过' : '退回'}</span>
                  <span className="vd-review-text">{r.comment || '没写意见'}</span>
                  <span className="run-muted" title={new Date(r.at).toLocaleString('zh-CN')}>{timeAgo(r.at)}</span>
                </li>
              ))}
            </ul>
          ) : <div className="mount-empty">还没验收过</div>}
        </section>
      </div>
      <div className="drawer-foot">
        {confirmDel ? (
          <>
            <span className="danger-text">只删记录，文件不动</span>
            <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>取消</button>
            <button className="btn btn-danger" onClick={onRemove}>删除</button>
          </>
        ) : <button className="btn btn-ghost" onClick={() => setConfirmDel(true)}>删除</button>}
        <div className="spacer" />
        <button className="btn btn-outline" title="版本号加一，状态回到草稿" onClick={() => onUpdate((x) => ({ ...x, version: x.version + 1, status: 'draft' }))}>升版本</button>
        {canPreview && <button className="btn btn-primary" onClick={onPreview}>预览</button>}
      </div>
    </aside>
  )
}
