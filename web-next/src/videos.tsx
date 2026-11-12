// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import './videos.css'
import './videopublish.css'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SearchSelect } from './searchselect'
import { Subnav } from './subnav'
import { PageTitle } from './topbar'
import { cls, timeAgo } from './ui'
import {
  ARTIFACT_KIND, ARTIFACT_STATUS, COVER_RATIO, DEFAULT_COVER_RATIOS, ORIENT, PLATFORMS, SPEECH_RATE, STAGES, coverRatioOf, draftFromTopic, stageIndex, textStats, videoState,
  type Artifact, type ArtifactKind, type ArtifactStatus, type Checkpoint, type CheckpointState, type CoverRatio, type LastRun, type Orientation, type RunnerType,
  type ScriptText, type Series, type StageKey, type StageRunner, type TextKind, type Video,
} from './videodata'
import { TOPIC_STATUS, topicPriority, type Clip, type Topic } from './topicdata'
import { PriorityBadge, StatusPill, TopicDrawer } from './topics'
import { newId } from './ids'
import { SKILLS, seedAgents } from './agentdata'
import { SOPS } from './sopflow'
import { StoryboardDesk } from './storyboard'

// 视频：按 web-video-presentation 的流程管一集视频——阶段时间线、检查点、产出物（带比例、版本、验收）、设置
// 数据约定在 videodata.ts；这里只读它的类型和常量

export type VideoView = 'all' | 'review' | 'single' | `sr:${string}` | `video:${string}` | 'series' | 'publish' | 'topics' | 'clips' | 'calendar' | 'bilibili'

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
export const isFinished = (v: Video) => v.stage === 'distribution' && cpOf(v, 'distribution')?.state === 'passed'
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

function defaultPath(kind: ArtifactKind, v: Video, variant?: Orientation, option?: number, ratio?: CoverRatio) {
  const base = v.root.split('/').filter(Boolean).pop() || 'video'
  switch (kind) {
    case 'presentation': return `presentation-${variant ?? 'landscape'}`
    case 'audio': return 'audio/'
    case 'video': return `out/${base}-${ratioSlug(variant ?? 'landscape')}.mp4`
    case 'subtitle': return `subtitle/${base}-${ratioSlug(variant ?? 'landscape')}.srt`
    case 'cover': return `cover/${ratio ?? DEFAULT_COVER_RATIOS[variant ?? 'landscape'][0]}-${option ?? 1}.png`
    default: return ARTIFACT_KIND[kind].perVariant ? `${kind}-${variant ?? 'landscape'}.md` : `${kind}.md`
  }
}
/** 这个方向下要显示的封面比例：默认的几种，加上已经登记过的 */
const coverRatios = (o: Orientation, xs: Artifact[]) => [...new Set([...DEFAULT_COVER_RATIOS[o], ...xs.map(coverRatioOf)])]
const ratioText = (r: CoverRatio) => COVER_RATIO[r].label

/* ---------- 阶段执行器 ---------- */

const RUNNER_TYPE: Record<RunnerType, string> = { skill: '技能', sop: 'SOP', agent: 'Agent' }
/** 能配执行器的阶段：有产出物的阶段，加上「其余章节」（给演示工程升版本）；规划检查、第一章验收只有人能做 */
const RUNNABLE = STAGES.filter((s) => s.key === 'chapters' || Object.values(ARTIFACT_KIND).some((k) => k.stage === s.key)).map((s) => s.key)
const runnerChoices = (t: RunnerType) => (t === 'skill' ? SKILLS.map((x) => ({ id: x.id, name: x.name }))
  : t === 'sop' ? SOPS.map((x) => ({ id: x.id, name: x.name })) : seedAgents.map((x) => ({ id: x.id, name: x.name || '未命名 Agent' })))
const runnerName = (r: StageRunner) => runnerChoices(r.type).find((x) => x.id === r.ref_id)?.name
/** 每个阶段跑完登记哪些产出物；按比例区分的每个比例一份 */
const RUN_KINDS: Partial<Record<StageKey, ArtifactKind[]>> = {
  script: ['script', 'outline'], web: ['presentation'], chapters: ['presentation'], audio: ['audio'], record: ['video', 'subtitle'], distribution: ['description', 'chapters'],
}
const runName = (k: StageKey, kind: ArtifactKind, v: Video) => (kind === 'presentation' ? (k === 'web' ? '演示工程（第 1 章）' : '演示工程')
  : kind === 'audio' ? `口播音频（${v.chapters} 章）` : defaultName(kind))
/** 执行器跑之前能看出来的失败；原型里其余情况都算成功 */
function runError(v: Video, r: StageRunner, k: StageKey) {
  if (!runnerName(r)) return `找不到${RUNNER_TYPE[r.type]}「${r.ref_id}」，可能已经删掉了，换一个再跑`
  if ((RUN_KINDS[k] ?? []).some((x) => ARTIFACT_KIND[x].perVariant) && !v.orientations.length) return '还没定画面比例，先在规划检查里选好'
  return ''
}
const defaultName = (kind: ArtifactKind, option?: number) => (kind === 'cover' ? `封面 ${option ?? 1}` : kind === 'video' ? '成片' : ARTIFACT_KIND[kind].label)

/** 阶段进度：一个阶段一段小条，做完的绿、当前的蓝（卡在检查点上的橙） */
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
export const needsMe = (v: Video) => videoState(v).tone === 'warn'

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

/* ---------- 标签栏 ---------- */

type ModuleTab = 'all' | 'review' | 'calendar' | 'topics' | 'clips' | 'series' | 'publish' | 'bilibili'
const MODULE_TABS: { key: ModuleTab; label: string }[] = [
  { key: 'all', label: '全部视频' }, { key: 'review', label: '待我处理' }, { key: 'calendar', label: '日历' }, { key: 'topics', label: '选题' },
  { key: 'clips', label: '素材收件箱' }, { key: 'series', label: '系列' }, { key: 'publish', label: '发布记录' },
  // B 站组件（TSK-0455）：账户数据和私信，见 videobili.tsx
  { key: 'bilibili', label: 'B 站' },
]
const fromSeries = (v?: VideoView) => v === 'series' || !!v?.startsWith('sr:')
/** 视图落在哪个标签：系列详情算「系列」，单集列表算「全部视频」；打开某一集时看从哪进来的，从系列进的算「系列」，其余算「全部视频」 */
const tabOf = (view: VideoView, from?: VideoView): ModuleTab => {
  if (view.startsWith('video:')) return fromSeries(from) ? 'series' : 'all'
  if (view.startsWith('sr:')) return 'series'
  if (view === 'single') return 'all'
  return view as ModuleTab
}

/** 视频模块的标签栏：各视图页面在 PageTitle 下面渲染；待处理、未整理素材的数量标在标签上 */
export function VideosTabs({ view, from, videos, clips = [], onSelect }: {
  view: VideoView
  /** 打开某一集时，是从哪个视图点进来的 */
  from?: VideoView
  videos: Video[]
  clips?: { triaged?: boolean }[]
  onSelect: (v: VideoView) => void
}) {
  const active = tabOf(view, from)
  const review = videos.filter(needsMe).length
  const pending = clips.filter((c) => !c.triaged).length
  const badge: Partial<Record<ModuleTab, { n: number; title: string }>> = {
    review: { n: review, title: `${review} 集停在检查点或被退回` },
    clips: { n: pending, title: `${pending} 条素材待整理` },
  }
  return (
    <div className="np-tabs vd-mtabs" role="tablist">
      {MODULE_TABS.map((t) => {
        const b = badge[t.key]
        return (
          <button key={t.key} role="tab" aria-selected={active === t.key} className={cls(active === t.key && 'on')} title={b?.n ? b.title : undefined} onClick={() => onSelect(t.key)}>
            {t.label}
            {!!b?.n && <span className="vd-mtab-n">{b.n}</span>}
          </button>
        )
      })}
    </div>
  )
}

/* ---------- 列表：全部 / 待处理 / 系列详情 / 单集 ---------- */

type StageFilter = '' | StageKey | 'done'
const stageOf = (v: Video): StageFilter => (isFinished(v) ? 'done' : v.stage)

/** 阶段分布条：一眼看出这批视频卡在哪；点一段按这个阶段筛 */
export function StageDist({ videos, value, onChange }: { videos: Video[]; value: StageFilter; onChange: (s: StageFilter) => void }) {
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

export function VideosListPage({ view, videos, artifacts, series, projects, onOpen, onNew, onView, tabs, onSeries, onVideos }: {
  view: VideoView
  videos: Video[]; artifacts: Artifact[]; series: Series[]; projects: { id: string; name: string }[]
  onOpen: (id: string) => void
  /** 在某个系列里新建：带上系列和下一集的集数 */
  onNew: (seriesId?: string) => void
  onView: (v: VideoView) => void
  /** 模块标签栏，放在顶栏下面 */
  tabs?: ReactNode
  /** 系列详情：改设置、标记已同步；不传就只读 */
  onSeries?: (fn: (xs: Series[]) => Series[]) => void
  /** 系列详情：加集、移出、调集数；不传就只读 */
  onVideos?: (fn: (xs: Video[]) => Video[]) => void
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
  /** 系列详情：编排集数（改集数、移出） */
  const [editing, setEditing] = useState(false)
  const [settings, setSettings] = useState(false)
  // 切到别的系列时筛选清空
  useEffect(() => { setStage(''); setQ(''); setProj(''); setSort(view.startsWith('sr:') ? 'episode' : 'updated'); setEditing(false); setSettings(false) }, [view])
  const kw = q.trim().toLowerCase()
  const projName = (id?: string) => (id ? projects.find((p) => p.id === id)?.name ?? '已删除的项目' : '')
  const rows = scope.filter((v) => (!stage || stageOf(v) === stage) && (!proj || (proj === '-' ? !v.project_id : v.project_id === proj))
    && (!kw || `${v.title}${v.root}${v.episode ?? ''}`.toLowerCase().includes(kw)))
    .sort(sort === 'episode' ? (a, b) => (a.episode ?? 9999) - (b.episode ?? 9999) || a.created_at.localeCompare(b.created_at) : (a, b) => b.updated_at.localeCompare(a.updated_at))
  const filtered = !!(stage || proj || kw)
  // 全部视频、没筛选时按系列分组，每组只露几集，长系列点进去看
  const grouped = view === 'all' && !filtered
  const title = sr ? sr.name : view === 'single' ? '单集' : view === 'review' ? '待我处理' : '全部视频'
  const desc = sr ? sr.desc || '多集共用开场、收尾和模板' : view === 'review' ? '停在检查点上等你确认，或者被退回要改的' : view === 'single' ? '不属于任何系列的视频' : '按系列分组；点系列看全部集数'
  const stale = new Set(sr?.stale ?? [])
  const nextEp = sr ? Math.max(0, ...scope.map((v) => v.episode ?? 0)) + 1 : 0
  const staleEps = scope.filter((v) => stale.has(v.id)).sort((a, b) => (a.episode ?? 9999) - (b.episode ?? 9999))
  const canEdit = !!sr && !!onVideos
  const edit = canEdit && editing
  const freeOptions = useMemo(() => [...videos].filter((v) => !v.series_id).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map((v) => ({ value: v.id, label: v.title || '未命名视频', hint: videoState(v).label, keywords: v.root })), [videos])
  // 同号的集标红
  const dup = new Set(scope.map((v) => v.episode).filter((n, i, arr) => n !== undefined && arr.indexOf(n) !== i))

  const unsync = (ids: string[]) => sr && onSeries?.((xs) => xs.map((x) => (x.id === sr.id ? { ...x, stale: x.stale.filter((y) => !ids.includes(y)) } : x)))
  const addEpisode = (id: string) => sr && onVideos?.((xs) => xs.map((v) => (v.id === id ? { ...v, series_id: sr.id, episode: nextEp, updated_at: now() } : v)))
  const removeEpisode = (id: string) => {
    onVideos?.((xs) => xs.map((v) => (v.id === id ? { ...v, series_id: undefined, episode: undefined, updated_at: now() } : v)))
    unsync([id])
  }
  const setEpisode = (v: Video, raw: string) => {
    const n = Math.floor(Number(raw))
    if (n >= 1 && n !== v.episode) onVideos?.((xs) => xs.map((x) => (x.id === v.id ? { ...x, episode: n, updated_at: now() } : x)))
  }

  // 用函数而不是组件渲染行：组件每次渲染都是新的，编排时输入框会被重建、丢焦点
  const row = (v: Video, showSeries: boolean) => {
    const arts = artifacts.filter((a) => a.video_id === v.id).length
    // 第二行只放有信息的：所属系列（跨系列列表里）、项目、产出物数；都没有就单行，长系列一屏能看更多集
    const meta = showSeries || !!projName(v.project_id) || arts > 0
    return (
    <div key={v.id} className={cls('vd-row', !meta && 'vd-row-1', edit && 'vd-row-edit')} onClick={edit ? undefined : () => onOpen(v.id)}>
      {edit ? (
        <span className="vd-ep">
          {/* 失焦或回车才改，免得边输边重新排序 */}
          <input key={v.episode ?? ''} className={cls('vd-ep-input', dup.has(v.episode) && 'bad')} type="number" min={1} defaultValue={v.episode ?? ''} aria-label={`${v.title} 的集数`}
            onBlur={(e) => setEpisode(v, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
        </span>
      ) : <span className="vd-ep">{v.episode ? `${v.episode}` : '-'}</span>}
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
      {edit ? <span><button className="act act-quiet btn-danger-ghost" onClick={() => removeEpisode(v.id)}>移出</button></span> : <span className="run-muted">{timeAgo(v.updated_at)}</span>}
    </div>
    )
  }
  const head = <div className={cls('vd-row task-th', edit && 'vd-row-edit')}><span>集</span><span>视频</span><span>比例</span><span>进度</span><span>状态</span><span>{edit ? '' : '更新'}</span></div>

  // 分组时每组先露「等我处理的」，再按更新时间补满
  const PEEK = 4
  const peek = (xs: Video[]) => [...xs].sort((a, b) => Number(needsMe(b)) - Number(needsMe(a)) || b.updated_at.localeCompare(a.updated_at)).slice(0, PEEK)
  const groups = [
    ...series.map((s) => ({ key: `sr:${s.id}` as VideoView, name: s.name, xs: videos.filter((v) => v.series_id === s.id) })),
    { key: 'single' as VideoView, name: '单集', xs: videos.filter((v) => !series.some((s) => s.id === v.series_id)) },
  ].filter((g) => g.xs.length)

  return (
    <div className="page page-fill">
      <PageTitle parent={sr ? <button className="vd-crumb" onClick={() => onView('series')}>系列</button> : '视频'} count={scope.length} desc={desc} actions={<>
        {sr && onSeries && <button className="btn btn-outline" onClick={() => setSettings(true)}>系列设置</button>}
        <button className="btn btn-primary" onClick={() => onNew(sr?.id)}>
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          {sr ? `新建第 ${nextEp} 集` : '新建视频'}
        </button>
      </>}>{title}</PageTitle>
      {tabs}

      {sr && (
        <section className="vd-sr-top">
          <div className="vd-sr-shared">
            <span><span className="run-muted">开场</span><span className={cls('ellipsis', !sr.intro && 'faint')}>{sr.intro || '未设置'}</span></span>
            <span><span className="run-muted">收尾</span><span className={cls('ellipsis', !sr.outro && 'faint')}>{sr.outro || '未设置'}</span></span>
            <span><span className="run-muted">模板</span><span className={cls('ellipsis', !sr.template && 'faint')}>{sr.template || '未设置'}</span></span>
            {onSeries && <button className="link-btn" onClick={() => setSettings(true)}>修改</button>}
          </div>
          {staleEps.length > 0 && (
            <div className="vd-sr-stale">
              <div className="vd-sr-stale-head">
                <span className="vd-stale-tag">{staleEps.length} 集待同步</span>
                <span className="run-muted">共用部分改过，这几集要重新录屏渲染</span>
                <span className="spacer" />
                {onSeries && staleEps.length > 1 && <button className="act act-quiet" onClick={() => unsync(staleEps.map((v) => v.id))}>全部标记已同步</button>}
              </div>
              {staleEps.map((v) => (
                <div key={v.id} className="vd-sr-stale-row">
                  <span className="vd-ep">{v.episode ?? '-'}</span>
                  <span className="ellipsis vd-sr-stale-title">{v.title || '未命名视频'}</span>
                  <VideoStatePill v={v} />
                  <span className="vd-sr-stale-acts">
                    {onSeries && <button className="act act-quiet" onClick={() => unsync([v.id])}>标记已同步</button>}
                    <button className="act act-quiet" onClick={() => onOpen(v.id)}>去这一集</button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
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
        {canEdit && (
          <SearchSelect value="" placeholder="加入已有视频" searchPlaceholder="搜标题或目录" align="end" disabled={!freeOptions.length}
            title={freeOptions.length ? `从 ${freeOptions.length} 个未归入系列的视频里选，排在第 ${nextEp} 集` : '没有未归入系列的视频'}
            options={freeOptions} emptyText="没有未归入系列的视频" onChange={(id) => id && addEpisode(id)} />
        )}
        {canEdit && scope.length > 0 && (
          <button className={cls('chip', edit && 'chip-on')} onClick={() => { if (!edit) setSort('episode'); setEditing(!edit) }}>{edit ? '完成编排' : '编排集数'}</button>
        )}
        {!grouped && !edit && (
          <div className="seg seg-sm">
            <button className={cls(sort === 'episode' && 'on')} onClick={() => setSort('episode')}>按集数</button>
            <button className={cls(sort === 'updated' && 'on')} onClick={() => setSort('updated')}>按更新</button>
          </div>
        )}
      </div>
      {edit && dup.size > 0 && <div className="field-err vd-dup">有几集集数重复了，改一下</div>}

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
                {peek(g.xs).map((v) => row(v, false))}
              </div>
            </section>
          ))}
        </div>
      ) : !rows.length ? (
        <div className="empty">
          <div className="empty-title">{filtered ? '没有匹配的视频' : view === 'review' ? '没有等你处理的视频' : sr ? '这个系列还没有集' : '还没有视频'}</div>
          <div className="list-sub">{filtered ? '换个筛选条件试试' : view === 'review' ? '检查点都确认过了' : sr ? `新建第 ${nextEp} 集，或者用「加入已有视频」把单集归进来` : '把一篇文章或口播稿做成网页演示，再录成视频'}</div>
        </div>
      ) : (
        <div className="task-table">
          {head}
          {rows.map((v) => row(v, !sr))}
        </div>
      )}

      {sr && settings && onSeries && (
        <SeriesSettingsDrawer key={sr.id} series={sr} videos={videos} onClose={() => setSettings(false)}
          onSave={(s) => { onSeries((xs) => xs.map((x) => (x.id === s.id ? s : x))); setSettings(false) }} />
      )}
    </div>
  )
}

/* ---------- 系列设置 ---------- */

const SHARED: { key: 'intro' | 'outro' | 'template'; label: string; ph: string }[] = [
  { key: 'intro', label: '共用开场', ph: '比如 shared/intro.tsx（5 秒标志动画）' },
  { key: 'outro', label: '共用收尾', ph: '比如 shared/outro.tsx（关注引导 + 下集预告）' },
  { key: 'template', label: '共用模板', ph: '比如 templates/theme（主题、字体、配色）' },
]
const CloseIcon = () => <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>

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

/**
 * 系列设置：名称、说明、共用的开场收尾模板。series 不传是新建。
 * 改了共用部分保存前先确认影响范围，勾上的集标为「待同步」；加集、移出、调集数在系列详情的表格里做
 */
export function SeriesSettingsDrawer({ series, videos, onClose, onSave }: {
  series: Series | null; videos: Video[]
  onClose: () => void
  onSave: (s: Series) => void
}) {
  const creating = !series
  const [d, setD] = useState<Series>(() => series ?? { id: newId('sr'), name: '', desc: '', intro: '', outro: '', template: '', stale: [] })
  const [tried, setTried] = useState(false)
  // 影响范围确认：要标记的集
  const [confirm, setConfirm] = useState<string[] | null>(null)
  useEsc(() => (confirm ? setConfirm(null) : onClose()))

  const eps = series ? videos.filter((v) => v.series_id === series.id).sort((a, b) => (a.episode ?? 999) - (b.episode ?? 999)) : []
  const changed = series ? SHARED.filter((f) => d[f.key].trim() !== series[f.key].trim()) : []
  const clean = () => ({ ...d, name: d.name.trim(), desc: d.desc.trim(), intro: d.intro.trim(), outro: d.outro.trim(), template: d.template.trim() })

  const save = () => {
    setTried(true)
    if (!d.name.trim()) return
    if (creating) { onSave(clean()); return }
    if (changed.length && eps.length) { setConfirm(eps.map((v) => v.id)); return }
    onSave({ ...clean(), stale: series!.stale })
  }
  const confirmSave = () => {
    const picked = confirm ?? []
    const base = series!.stale.filter((id) => !picked.includes(id))
    onSave({ ...clean(), stale: [...base, ...picked] })
  }

  return (
    <aside className="drawer vp-drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">{creating ? '新建系列' : '系列设置'}</span>
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
          <div className="field-group-title">共用部分<span className="field-hint">{creating ? '各集录屏时套用' : `改了任一项，保存时会让你确认这 ${eps.length} 集里哪几集要重新录屏渲染`}</span></div>
          {SHARED.map((f) => (
            <label key={f.key} className="field">
              <span className="field-label">{f.label}{series && d[f.key].trim() !== series[f.key].trim() && <span className="vp-changed">已改</span>}</span>
              <input className="mono" value={d[f.key]} placeholder={f.ph} onChange={(e) => setD({ ...d, [f.key]: e.target.value })} />
            </label>
          ))}
        </section>
        {creating && <div className="mount-empty">建好后在系列详情里新建一集，或者把已有的视频加进来</div>}
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

/* ---------- 详情 ---------- */

type DetailTab = 'flow' | 'artifacts' | 'settings'
const TABS: { key: DetailTab; label: string }[] = [{ key: 'flow', label: '制作流程' }, { key: 'artifacts', label: '产出物' }, { key: 'settings', label: '设置' }]

interface NewArt { kind: ArtifactKind; variant?: Orientation; ratio?: CoverRatio; option?: number; name: string; path: string; duration: string; touched: boolean }

export function VideoDetail({ video, artifacts, series, projects, publishCount, topics, clips, texts, onChange, onArtifacts, onTopics, onClips, onTexts, onOpenSeries, onOpenPublish, onPreview, onDelete, tabs }: {
  video: Video; artifacts: Artifact[]; series: Series[]; projects: { id: string; name: string }[]; publishCount: number
  /** 选题一步：挑选题、新建选题、在抽屉里改 */
  topics: Topic[]; clips: Clip[]
  onTopics: (fn: (xs: Topic[]) => Topic[]) => void
  onClips: (fn: (xs: Clip[]) => Clip[]) => void
  /** 内容编写：文稿正文、草稿、执行器起草的初稿 */
  texts: ScriptText[]
  onTexts: (fn: (xs: ScriptText[]) => ScriptText[]) => void
  /** 模块标签栏，放在顶栏下面 */
  tabs?: ReactNode
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
  /** 正在配执行器的阶段和草稿 */
  const [runEdit, setRunEdit] = useState<{ stage: StageKey; r: StageRunner } | null>(null)
  const mine = artifacts.filter((a) => a.video_id === v.id)
  const topic = topics.find((t) => t.id === v.topic_id)
  const [topicOpen, setTopicOpen] = useState(false)
  /** 内容编写已经过了的集，要点开才显示编辑区 */
  const [deskOpen, setDeskOpen] = useState(false)
  // 执行器是异步跑完的，跑完时要拿最新的视频、产出物和选题，不能用发起时的
  const latest = useRef({ v, mine, topic })
  useEffect(() => { latest.current = { v, mine, topic } })
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

  // 封面版本号按「方向 + 封面比例」各自从 1 数到 5
  const freeOption = (variant?: Orientation, ratio?: CoverRatio) => {
    const r = ratio ?? DEFAULT_COVER_RATIOS[variant ?? 'landscape'][0]
    for (let o = 1; o <= COVER_OPTIONS; o += 1) if (!mine.some((a) => a.kind === 'cover' && a.variant === variant && coverRatioOf(a) === r && a.option === o)) return o
    return COVER_OPTIONS
  }
  const startNew = (kind: ArtifactKind, variant?: Orientation, option?: number, ratio?: CoverRatio) => {
    const per = ARTIFACT_KIND[kind].perVariant
    const vr = per ? variant ?? v.orientations[0] ?? 'landscape' : undefined
    const rt = kind === 'cover' ? ratio ?? DEFAULT_COVER_RATIOS[vr ?? 'landscape'][0] : undefined
    const op = kind === 'cover' ? option ?? freeOption(vr, rt) : undefined
    setDraft({ kind, variant: vr, ratio: rt, option: op, name: defaultName(kind, op), path: defaultPath(kind, v, vr, op, rt), duration: '', touched: false })
    setTab('artifacts')
  }
  // 改类型、比例、版本号时，名称和路径跟着变；手动改过路径就不再覆盖
  const patchDraft = (x: Partial<NewArt>) => {
    if (!draft) return
    const d = { ...draft, ...x }
    if (x.kind) d.variant = ARTIFACT_KIND[d.kind].perVariant ? d.variant ?? v.orientations[0] ?? 'landscape' : undefined
    if (d.kind !== 'cover') { d.ratio = undefined; d.option = undefined } else {
      // 换了方向，封面比例回到这个方向的默认；换了方向或封面比例，版本号重新找空位
      if (x.kind || x.variant) d.ratio = x.ratio ?? (d.ratio && DEFAULT_COVER_RATIOS[d.variant ?? 'landscape'].includes(d.ratio) ? d.ratio : DEFAULT_COVER_RATIOS[d.variant ?? 'landscape'][0])
      if (x.kind || x.variant || x.ratio) d.option = x.option ?? freeOption(d.variant, d.ratio)
    }
    if (x.kind || x.option !== undefined || x.ratio) d.name = defaultName(d.kind, d.option)
    if (!d.touched && (x.kind || x.variant || x.ratio || x.option !== undefined)) d.path = defaultPath(d.kind, v, d.variant, d.option, d.ratio)
    setDraft(d)
  }
  const addArt = () => {
    if (!draft) return
    const a: Artifact = {
      id: newId('af'), video_id: v.id, kind: draft.kind, name: draft.name.trim() || defaultName(draft.kind, draft.option), path: draft.path.trim(),
      variant: draft.variant, ratio: draft.ratio, option: draft.option, lang: draft.kind === 'subtitle' ? 'zh' : undefined, version: 1, status: 'draft',
      duration: draft.kind === 'audio' || draft.kind === 'video' ? parseDuration(draft.duration) : undefined,
      source: { type: 'manual', label: '手动登记' }, reviews: [], created_at: now(),
    }
    onArtifacts((xs) => [...xs, a]); touch()
    setDraft(null)
  }
  // 同一方向、同一封面比例里只选一张
  const pickCover = (a: Artifact) => {
    const on = !isPicked(a)
    const r = coverRatioOf(a)
    onArtifacts((xs) => xs.map((x) => (x.video_id === a.video_id && x.kind === 'cover' && x.variant === a.variant && coverRatioOf(x) === r ? { ...x, picked: x.id === a.id ? on : false } : x)))
    touch()
  }

  /* 执行器：配置、运行；跑完把产出物登记或升版成「待验收」，检查点仍由人确认 */
  const runnerOf = (k: StageKey) => v.runners?.find((r) => r.stage === k)
  const saveRunner = (r: StageRunner) => { set({ runners: [...(v.runners ?? []).filter((x) => x.stage !== r.stage), r] }); setRunEdit(null) }
  const removeRunner = (k: StageKey) => { set({ runners: (v.runners ?? []).filter((x) => x.stage !== k) }); setRunEdit(null) }
  const running = v.last_run?.status === 'running'
  const run = (k: StageKey) => {
    const r = runnerOf(k)
    if (!r || running) return
    const id = newId(r.type === 'sop' ? 'run' : 'ar')
    const start: LastRun = { type: r.type === 'sop' ? 'sop' : 'agent', id, stage: k, status: 'running', started_at: now() }
    set({ last_run: start })
    window.setTimeout(() => {
      const { v: cur, mine: arts } = latest.current
      // 期间又跑了一次或者被清掉了，这次的结果作废
      if (cur.last_run?.id !== id) return
      const err = runError(cur, r, k)
      if (err) { onChange({ ...cur, last_run: { ...start, status: 'failed', ended_at: now(), error: err }, updated_at: now() }); return }
      const source: Artifact['source'] = { type: r.type, label: runnerName(r) ?? r.ref_id }
      const bump: Record<string, string> = {}
      const add: Artifact[] = []
      for (const kind of RUN_KINDS[k] ?? []) {
        const variants: (Orientation | undefined)[] = ARTIFACT_KIND[kind].perVariant ? cur.orientations : [undefined]
        for (const o of variants) {
          const old = arts.filter((a) => a.kind === kind && a.variant === o).sort((a, b) => b.version - a.version)[0]
          if (old) bump[old.id] = runName(k, kind, cur)
          else add.push({ id: newId('af'), video_id: cur.id, kind, name: runName(k, kind, cur), path: defaultPath(kind, cur, o), variant: o, lang: kind === 'subtitle' ? 'zh' : undefined,
            version: 1, status: 'review', source, reviews: [], created_at: now() })
        }
      }
      const at = now()
      onArtifacts((xs) => [...xs.map((x) => (bump[x.id] ? { ...x, name: bump[x.id], version: x.version + 1, status: 'review' as const, source, created_at: at } : x)), ...add])
      onChange({ ...cur, last_run: { ...start, status: 'done', ended_at: at, artifact_ids: [...Object.keys(bump), ...add.map((a) => a.id)] }, updated_at: at })
    }, 1800)
  }

  /* 选题：挑一个、新建一个、换一个；选定的选题记下 video_id、改成已做成，换下来的回到可开拍 */
  const linkTopic = (t: Topic) => {
    const at = now()
    const prev = v.topic_id
    onTopics((xs) => xs.map((x) => (x.id === t.id ? { ...x, status: 'made' as const, video_id: v.id, updated_at: at }
      : x.id === prev ? { ...x, status: 'ready' as const, video_id: undefined, updated_at: at } : x)))
    // 标题还是默认的就用选题标题；比例还没锁定就按选题平台的推荐比例（同立项）
    const untitled = !v.title.trim() || v.title === '新视频' || /^第 \d+ 集：$/.test(v.title)
    const orients = [...new Set(t.platforms.map((k) => PLATFORMS.find((p) => p.key === k)!.prefer))]
    set({
      topic_id: t.id,
      title: untitled && t.title.trim() ? (v.episode ? `第 ${v.episode} 集：${t.title.trim()}` : t.title.trim()) : v.title,
      orientations: !locked && orients.length ? ORIENTS.filter((o) => orients.includes(o)) : v.orientations,
    })
  }
  const newTopic = () => {
    const at = now()
    const t: Topic = {
      id: newId('tp'), title: v.title.replace(/^第 \d+ 集：/, '').replace(/^新视频$/, '').trim(), angle: '', audience: '', status: 'made',
      score: { demand: 3, fit: 3, effort: 3 }, tags: [], series_id: v.series_id, platforms: [], outline: '', clip_ids: [], video_id: v.id, created_at: at, updated_at: at,
    }
    const prev = v.topic_id
    onTopics((xs) => [t, ...xs.map((x) => (x.id === prev ? { ...x, status: 'ready' as const, video_id: undefined, updated_at: at } : x))])
    set({ topic_id: t.id })
    setTopicOpen(true)
  }
  const topicOptions = useMemo(() => topics.filter((t) => !t.video_id && t.status !== 'dropped' && t.status !== 'made')
    .sort((a, b) => topicPriority(b.score) - topicPriority(a.score))
    .map((t) => ({ value: t.id, label: t.title || '未命名选题', hint: `${TOPIC_STATUS[t.status].label} · ${topicPriority(t.score).toFixed(1)}`, keywords: `${t.angle}${t.tags.join('')}` })), [topics])

  /* 内容编写：草稿边写边存；保存存成这一类产出物的下一版；交给验收把当前版标待验收 */
  const textKey = (x: ScriptText, kind: TextKind, variant?: Orientation) => x.video_id === v.id && x.kind === kind && x.variant === variant
  const latestArt = (kind: TextKind, variant?: Orientation) => mine.filter((a) => a.kind === kind && a.variant === variant).sort((a, b) => b.version - a.version)[0]
  const editText = (kind: TextKind, variant: Orientation | undefined, body: string) => {
    const art = latestArt(kind, variant)
    const saved = art && texts.find((x) => textKey(x, kind, variant) && !x.draft && x.version === art.version)
    const at = now()
    // 改回和已保存的一样，草稿就不留了
    onTexts((xs) => {
      const rest = xs.filter((x) => !(textKey(x, kind, variant) && x.draft === 'mine'))
      return body === (saved?.body ?? '') ? rest : [...rest, { video_id: v.id, kind, variant, draft: 'mine', body, saved_at: at }]
    })
  }
  const saveText = (kind: TextKind, variant: Orientation | undefined, body: string, status: ArtifactStatus, source: Artifact['source'] = { type: 'manual', label: '手写' }) => {
    const art = latestArt(kind, variant)
    const at = now()
    const version = (art?.version ?? 0) + 1
    if (art) onArtifacts((xs) => xs.map((x) => (x.id === art.id ? { ...x, version, status, source, created_at: at } : x)))
    else {
      const a: Artifact = { id: newId('af'), video_id: v.id, kind, name: defaultName(kind), path: defaultPath(kind, v, variant), variant, version, status, source, reviews: [], created_at: at }
      onArtifacts((xs) => [...xs, a])
    }
    onTexts((xs) => [...xs.filter((x) => !(textKey(x, kind, variant) && x.draft === 'mine')), { video_id: v.id, kind, variant, version, body, saved_at: at }])
    touch()
  }
  const submitText = (kind: TextKind, variant?: Orientation) => {
    const art = latestArt(kind, variant)
    if (art) updArt(art.id, (x) => ({ ...x, status: 'review' }))
  }
  const adopt = (p: ScriptText) => {
    saveText(p.kind, p.variant, p.body, 'draft', p.source)
    onTexts((xs) => xs.filter((x) => x !== p))
  }
  const discard = (ps: ScriptText[]) => onTexts((xs) => xs.filter((x) => !ps.includes(x)))
  /** 按选题大纲起草：交给内容编写的执行器（没配就用技能「网页演示做视频」），跑完出初稿，不直接改产出物 */
  const scriptRunner: StageRunner = runnerOf('script') ?? { stage: 'script', type: 'skill', ref_id: 'sk_video', prompt: '按 Phase 1 照选题的角度和大纲起草口播稿和大纲' }
  const draftRun = () => {
    if (running || !topic) return
    const r = scriptRunner
    const id = newId(r.type === 'sop' ? 'run' : 'ar')
    const start: LastRun = { type: r.type === 'sop' ? 'sop' : 'agent', id, stage: 'script', status: 'running', started_at: now() }
    set({ last_run: start })
    window.setTimeout(() => {
      const { v: cur, topic: tp } = latest.current
      if (cur.last_run?.id !== id) return
      const err = !tp ? '这一集的选题被换掉或删掉了，重新选好再起草'
        : runError(cur, r, 'script') || (!tp.outline.trim() ? `选题「${tp.title || '未命名选题'}」还没写大纲，Phase 1 要照大纲起草；先在选题里补上大纲再重试` : '')
      if (err || !tp) { onChange({ ...cur, last_run: { ...start, status: 'failed', ended_at: now(), error: err }, updated_at: now() }); return }
      const at = now()
      const source: Artifact['source'] = { type: r.type, label: runnerName(r) ?? r.ref_id }
      const os: Orientation[] = cur.orientations.length ? cur.orientations : ['landscape']
      const made: ScriptText[] = (['script', 'outline'] as const).flatMap((kind) => os.map((o): ScriptText => ({
        video_id: cur.id, kind, variant: o, draft: 'proposal', body: draftFromTopic(tp, kind, o, cur.chapters), source, saved_at: at,
      })))
      onTexts((xs) => [...xs.filter((x) => !(x.video_id === cur.id && x.draft === 'proposal')), ...made])
      onChange({ ...cur, last_run: { ...start, status: 'done', ended_at: at, artifact_ids: [] }, updated_at: at })
    }, 1800)
  }

  const actions = (
    <>
      {publishCount > 0 && <button className="btn btn-outline" onClick={() => onOpenPublish(v.id)}>发布记录<span className="seg-n">{publishCount}</span></button>}
      {tab === 'artifacts' && <button className="btn btn-primary" onClick={() => startNew(KINDS.find((k) => ARTIFACT_KIND[k].stage === v.stage) ?? 'script')}>新增产出物</button>}
      {tab === 'flow' && sr && <button className="btn btn-outline" onClick={() => onOpenSeries(sr.id)}>查看系列</button>}
    </>
  )
  // 一个阶段的执行器：配了就显示是谁、能不能跑、上次跑的结果；没配就给个入口
  const runnerBox = (k: StageKey, cur: boolean) => {
    const r = runnerOf(k)
    const last = v.last_run?.stage === k ? v.last_run : undefined
    const edit = runEdit?.stage === k ? runEdit.r : null
    if (edit) {
      const choices = runnerChoices(edit.type)
      return (
        <div className="vd-runner vd-runner-edit">
          <div className="field-row">
            <div className="field"><span className="field-label">交给谁跑</span>
              <div className="seg seg-sm">
                {(Object.keys(RUNNER_TYPE) as RunnerType[]).map((t) => (
                  <button key={t} className={cls(edit.type === t && 'on')} onClick={() => setRunEdit({ stage: k, r: { ...edit, type: t, ref_id: runnerChoices(t)[0]?.id ?? '' } })}>{RUNNER_TYPE[t]}</button>
                ))}
              </div>
            </div>
            <label className="field"><span className="field-label">{RUNNER_TYPE[edit.type]}</span>
              <select value={edit.ref_id} onChange={(e) => setRunEdit({ stage: k, r: { ...edit, ref_id: e.target.value } })}>
                {!choices.some((c) => c.id === edit.ref_id) && <option value={edit.ref_id}>{edit.ref_id ? '已删除的' + RUNNER_TYPE[edit.type] : '选一个'}</option>}
                {choices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          </div>
          <label className="field"><span className="field-label">交代给它的话<span className="field-hint">可不填</span></span>
            <input value={edit.prompt ?? ''} placeholder="比如：按 Phase 1 出横竖两套口播稿" onChange={(e) => setRunEdit({ stage: k, r: { ...edit, prompt: e.target.value } })} />
          </label>
          <div className="act-row">
            <button className="act act-primary" disabled={!choices.some((c) => c.id === edit.ref_id)} onClick={() => saveRunner({ ...edit, prompt: edit.prompt?.trim() || undefined })}>保存</button>
            <button className="act act-quiet" onClick={() => setRunEdit(null)}>取消</button>
            {r && <><span className="spacer" /><button className="act act-quiet btn-danger-ghost" onClick={() => removeRunner(k)}>不用执行器</button></>}
          </div>
        </div>
      )
    }
    if (!r) {
      return cur ? (
        <div className="vd-runner vd-runner-none">
          <span className="run-muted">{k === 'script' ? '没配执行器，按选题大纲起草时用技能「网页演示做视频」' : '没配执行器，产出物手动登记'}</span>
          <button className="link-btn" onClick={() => setRunEdit({ stage: k, r: { stage: k, type: 'skill', ref_id: 'sk_video' } })}>配执行器</button>
        </div>
      ) : null
    }
    const name = runnerName(r)
    const busy = last?.status === 'running'
    return (
      <div className={cls('vd-runner', last?.status === 'failed' && 'vd-runner-failed')}>
        <div className="vd-runner-head">
          <span className="vd-runner-type">{RUNNER_TYPE[r.type]}</span>
          <span className={cls('ellipsis vd-runner-name', !name && 'faint')} title={r.prompt}>{name ?? `已删除的${RUNNER_TYPE[r.type]}`}</span>
          {r.prompt && <span className="ellipsis run-muted vd-runner-prompt">{r.prompt}</span>}
          <span className="spacer" />
          {!busy && <button className="act act-quiet" onClick={() => setRunEdit({ stage: k, r })}>修改</button>}
          {/* 内容编写不在这里运行，在编辑区里「按选题大纲起草」 */}
          {cur && k !== 'script' && (
            <button className="act act-primary" disabled={running} title={running && !busy ? '另一个阶段正在跑，等它跑完' : undefined} onClick={() => run(k)}>
              {busy ? '运行中…' : last?.status === 'failed' ? '重试' : '运行'}
            </button>
          )}
        </div>
        {/* 内容编写的起草状态显示在编辑区里 */}
        {busy && k !== 'script' && <div className="vd-runner-state"><i className="vd-spin" />正在跑，开始于 {timeAgo(last.started_at)}；跑完产出物会进「待验收」</div>}
        {last?.status === 'failed' && k !== 'script' && <div className="vd-cp-reject">运行失败：{last.error ?? '没有返回原因'}{last.ended_at && ` · ${timeAgo(last.ended_at)}`}</div>}
        {last?.status === 'done' && k !== 'script' && (
          <div className="vd-runner-state ok">
            {timeAgo(last.ended_at ?? last.started_at)}跑完，{last.artifact_ids?.length ? `登记了 ${last.artifact_ids.length} 个产出物，待验收` : '没有新产出物'}
            {k !== 'web' && STAGES.find((x) => x.key === k)?.checkpoint && <span className="run-muted">；检查点还要你来确认</span>}
          </div>
        )}
      </div>
    )
  }
  // 选题一步：挂了选题显示它的要点，点了打开选题抽屉；没挂的给「从选题库选一个」「新建选题」
  const topicPicker = (label: string) => (
    <SearchSelect value="" placeholder={label} searchPlaceholder="搜标题、角度、标签" disabled={!topicOptions.length}
      title={topicOptions.length ? `从 ${topicOptions.length} 个还没立项的选题里选，按优先级排` : '选题库里没有还没立项的选题'}
      options={topicOptions} emptyText="没有还没立项的选题" onChange={(id) => { const t = topics.find((x) => x.id === id); if (t) linkTopic(t) }} />
  )
  const topicBox = () => {
    if (!topic) {
      return (
        <div className="vd-topic vd-topic-none">
          <span className="run-muted">{v.topic_id ? '原来的选题已经删掉了，重新挑一个' : '这一集还没挂选题：讲什么、讲给谁、从哪个角度讲，先在选题里想清楚'}</span>
          <div className="act-row">
            {topicPicker('从选题库选一个')}
            <button className="act" onClick={newTopic}>新建选题</button>
          </div>
        </div>
      )
    }
    const outline = topic.outline.split('\n').filter((l) => l.trim())
    return (
      <div className="vd-topic">
        <div className="vd-topic-head">
          <button className="vd-topic-title" onClick={() => setTopicOpen(true)} title="打开选题">{topic.title || '未命名选题'}</button>
          <PriorityBadge score={topic.score} />
          <StatusPill s={topic.status} />
          <span className="spacer" />
          {topicPicker('换一个')}
        </div>
        <dl className="props vd-topic-props">
          <dt>角度</dt><dd className={cls(!topic.angle && 'faint')}>{topic.angle || '还没写'}</dd>
          <dt>受众</dt><dd className={cls(!topic.audience && 'faint')}>{topic.audience || '还没写'}</dd>
          <dt>打分</dt><dd>需求 {topic.score.demand} · 契合 {topic.score.fit} · 成本 {topic.score.effort}</dd>
          <dt>大纲</dt><dd>{outline.length ? <ol className="vd-topic-outline">{outline.map((l, i) => <li key={i}>{l.replace(/^\s*(\d+[.、)]|[-*+])\s*/, '')}</li>)}</ol>
            : <span className="faint">还没写大纲，按大纲起草要先补上。<button className="link-btn" onClick={() => setTopicOpen(true)}>去补</button></span>}</dd>
        </dl>
      </div>
    )
  }
  // 规划检查要对齐的文稿：每个比例的口播稿、大纲当前是第几版、什么状态
  const planDocs = () => {
    const os = v.orientations.length ? v.orientations : ORIENTS.filter((o) => mine.some((a) => (a.kind === 'script' || a.kind === 'outline') && a.variant === o))
    const docs = (['article', 'script', 'outline'] as const).flatMap((k) => (k === 'article' ? [latestArt(k)] : os.map((o) => latestArt(k, o)))).filter((a): a is Artifact => !!a)
    const warns = [
      ...os.filter((o) => !latestArt('script', o)).map((o) => `${ORIENT[o].label}还没有口播稿`),
      ...docs.filter((a) => a.kind !== 'article' && a.status === 'draft').map((a) => `${a.variant ? ORIENT[a.variant].label : ''}${ARTIFACT_KIND[a.kind].label} v${a.version} 还是草稿，没交验收`),
      ...(texts.some((x) => x.video_id === v.id && x.draft === 'mine') ? ['内容编写里还有没保存的草稿，这里看到的是已保存的版本'] : []),
    ]
    return (
      <div className="vd-sub">
        <div className="field-group-title">要对齐的文稿<span className="field-hint">内容编写里保存的版本</span></div>
        {docs.length ? docs.map(artLine) : <div className="mount-empty">还没有文稿。<button className="link-btn" onClick={() => setDeskOpen(true)}>去内容编写</button></div>}
        {warns.map((w) => <div key={w} className="vd-plan-warn">{w}</div>)}
      </div>
    )
  }
  const descText = [seriesLine(v, series), proj?.name, v.orientations.map((o) => ORIENT[o].ratio).join(' / ') || '比例未定', videoState(v).label].filter(Boolean).join(' · ')

  const artLine = (a: Artifact) => (
    <div key={a.id} className={cls('vd-art-line', openId === a.id && 'sel')} onClick={() => setOpenId(a.id)}>
      <span className="tag">{ARTIFACT_KIND[a.kind].label}</span>
      <span className="ellipsis vd-art-name">{a.name}</span>
      {a.variant && <span className="vd-otag"><OrientShape o={a.variant} />{ORIENT[a.variant].ratio}</span>}
      {a.kind === 'cover' && <span className="vd-otag" title="封面比例">封面 {ratioText(coverRatioOf(a))}</span>}
      <span className="vd-ver">v{a.version}</span>
      <Pill {...ARTIFACT_STATUS[a.status]} />
      {(a.kind === 'presentation' || a.kind === 'video' || a.kind === 'cover') && <button className="act act-quiet" onClick={(e) => { e.stopPropagation(); preview(a) }}>预览</button>}
    </div>
  )

  return (
    <div className="page page-fill project-page vd-page">
      <PageTitle parent={sr ? <button className="vd-crumb" onClick={() => onOpenSeries(sr.id)}>{sr.name}</button> : '视频'} desc={descText} actions={actions}>{v.title || '未命名视频'}</PageTitle>
      {tabs}
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
            const desk = s.key === 'script' && (cur || deskOpen)
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

                  {s.key === 'topic' && topicBox()}

                  {s.key === 'plan' && planDocs()}
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

                  {items.length > 0 && !desk && <div className="vd-sub">{items.map(artLine)}</div>}
                  {s.key === 'script' && !desk && <div className="act-row"><button className="link-btn" onClick={() => setDeskOpen(true)}>打开编辑区改文稿</button></div>}
                  {RUNNABLE.includes(s.key) && !isFinished(v) && runnerBox(s.key, cur)}
                  {desk && (
                    <ScriptDesk v={v} mine={mine} texts={texts.filter((x) => x.video_id === v.id)} topic={topic} clips={clips} runner={scriptRunner} busy={running}
                      onDraft={draftRun} onEdit={editText} onSave={saveText} onSubmit={submitText} onAdopt={adopt} onDiscard={discard} onOpenArt={setOpenId}
                      onClose={cur ? undefined : () => setDeskOpen(false)} />
                  )}
                  {cur && !items.length && firstKind && !s.checkpoint && s.key !== 'script' && (
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
                  {cur && s.key === 'topic' && (
                    <div className="act-row vd-adv">
                      <button className="act act-primary" disabled={!topic} title={!topic ? '先选一个选题或新建一个' : undefined} onClick={() => advance('topic')}>确认选题，进入「{STAGES[i + 1].label}」</button>
                      {!topic && <span className="list-sub">先选一个选题或新建一个</span>}
                    </div>
                  )}
                  {cur && !s.checkpoint && s.key !== 'topic' && i < STAGES.length - 1 && (
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
                      {(v.orientations.length ? v.orientations : ORIENTS).map((o) => <button key={o} className={cls(draft.variant === o && 'on')} onClick={() => patchDraft({ variant: o })}>{orientText(o)}</button>)}
                    </div>
                  </div>
                )}
                {draft.kind === 'cover' && draft.variant && (
                  <div className="field"><span className="field-label">封面比例<span className="field-hint">平台各有要求，抖音要 3:4</span></span>
                    <div className="seg seg-sm">
                      {DEFAULT_COVER_RATIOS[draft.variant].map((r) => <button key={r} className={cls(draft.ratio === r && 'on')} onClick={() => patchDraft({ ratio: r })}>{ratioText(r)}</button>)}
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
                          {k === 'cover' ? coverRatios(o, xs).map((r) => {
                            const rs = xs.filter((a) => coverRatioOf(a) === r)
                            return (
                              <div key={r} className="vd-cover-group">
                                <div className="vd-cover-ratio">封面 {ratioText(r)}<span className="faint">{rs.length} / {COVER_OPTIONS}</span></div>
                                <div className="vd-covers">
                                  {Array.from({ length: Math.max(COVER_OPTIONS, ...rs.map((a) => a.option ?? 0)) }, (_, j) => j + 1).map((op) => {
                                    const a = rs.find((x) => x.option === op)
                                    return a ? (
                                      <button key={op} className={cls('vd-cover', openId === a.id && 'sel', isPicked(a) && 'picked')} title={`${a.name} · ${ratioText(r)} · ${ARTIFACT_STATUS[a.status].label}`} onClick={() => setOpenId(a.id)}>
                                        <CoverThumb r={r} op={op} />
                                        <span className="vd-cover-foot"><i className="pill-dot" style={{ '--c': ARTIFACT_STATUS[a.status].color } as React.CSSProperties} />{isPicked(a) ? '选用' : `v${a.version}`}</span>
                                      </button>
                                    ) : (
                                      <button key={op} className="vd-cover vd-cover-miss" title={`${ratioText(r)} 还没有第 ${op} 版，点一下登记`} aria-label={`登记 ${ratioText(r)} 封面第 ${op} 版`} onClick={() => startNew('cover', o, op, r)}>
                                        <span className="vd-thumb vd-thumb-miss" style={{ aspectRatio: `${COVER_RATIO[r].w} / ${COVER_RATIO[r].h}` }}>{op}</span>
                                        <span className="vd-cover-foot faint">缺</span>
                                      </button>
                                    )
                                  })}
                                </div>
                              </div>
                            )
                          }) : xs.length ? (
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

      {topicOpen && topic && (
        <TopicDrawer key={topic.id} t={topic} clips={clips} series={series} video={v}
          onClose={() => setTopicOpen(false)}
          onSave={(t) => onTopics((xs) => xs.map((x) => (x.id === t.id ? { ...t, updated_at: now() } : x)))}
          onDelete={() => {
            onClips((xs) => xs.map((c) => ({ ...c, topic_ids: c.topic_ids.filter((x) => x !== topic.id) })))
            onTopics((xs) => xs.filter((x) => x.id !== topic.id)); set({ topic_id: undefined }); setTopicOpen(false)
          }}
          onUnlinkClip={(cid) => {
            onTopics((xs) => xs.map((x) => (x.id === topic.id ? { ...x, clip_ids: x.clip_ids.filter((c) => c !== cid) } : x)))
            onClips((xs) => xs.map((c) => (c.id === cid ? { ...c, topic_ids: c.topic_ids.filter((x) => x !== topic.id) } : c)))
          }}
          onMake={() => setTopicOpen(false)} onOpenVideo={() => setTopicOpen(false)} />
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

const CoverThumb = ({ r, op, big }: { r: CoverRatio; op: number; big?: boolean }) => (
  <span className={cls('vd-thumb', big && 'vd-thumb-big')} style={{ aspectRatio: `${COVER_RATIO[r].w} / ${COVER_RATIO[r].h}`, '--h': COVER_HUE[(op - 1) % COVER_HUE.length] } as React.CSSProperties}>{op}</span>
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

/* ---------- 内容编写 ---------- */

const TEXT_LABEL: Record<TextKind, string> = { article: '原文', script: '口播稿', outline: '大纲' }
/** 口播时长：不到一分钟说秒，够一分钟说几分几秒 */
const speakText = (sec: number) => (sec < 60 ? `${Math.max(1, sec)} 秒` : `${Math.floor(sec / 60)} 分 ${String(sec % 60).padStart(2, '0')} 秒`)
const URL_RE = /^https?:\/\/[^\s/]+\S*$/

/** 一栏编辑器：显示当前版本的正文或没保存的草稿，字数和按语速估的时长；保存存成下一版，交给验收把当前版标待验收 */
function TextPane({ v, kind, variant, art, texts, head, onEdit, onSave, onSubmit, onOpenArt }: {
  v: Video; kind: TextKind; variant?: Orientation; art?: Artifact; texts: ScriptText[]
  /** 栏头左边：标签、比例切换 */
  head: ReactNode
  onEdit: (body: string) => void
  onSave: (body: string, status: ArtifactStatus) => void
  onSubmit: () => void
  onOpenArt: (id: string) => void
}) {
  const same = (x: ScriptText) => x.kind === kind && x.variant === variant
  const saved = art ? texts.find((x) => same(x) && !x.draft && x.version === art.version) : undefined
  const draft = texts.find((x) => same(x) && x.draft === 'mine')
  const body = draft?.body ?? saved?.body ?? ''
  const dirty = !!draft
  // 执行器或手动登记的版本，正文在视频目录的文件里，原型没有
  const missing = !!art && !saved
  const st = textStats(body)
  const empty = !body.trim() && !(missing && !dirty)
  const next = (art?.version ?? 0) + 1
  const submitLabel = dirty ? '保存并交验收' : art?.status === 'review' ? '已在待验收' : art?.status === 'final' || art?.status === 'published' ? '已定稿' : '交给验收'
  const submitOff = empty || (!dirty && (!art || art.status !== 'draft'))
  const sections = body.split('\n').filter((l) => /^#{1,3}\s/.test(l)).length
  return (
    <div className={cls('vd-pane', dirty && 'dirty')}>
      <div className="vd-pane-head">
        {head}
        <span className="spacer" />
        {art ? (
          <button className="vd-pane-art" title="打开产出物" onClick={() => onOpenArt(art.id)}><span className="vd-ver">v{art.version}</span><Pill {...ARTIFACT_STATUS[art.status]} /></button>
        ) : <span className="faint vd-pane-none">还没保存过</span>}
      </div>
      <textarea className="vd-editor" value={body} aria-label={`${TEXT_LABEL[kind]}${variant ? `（${ORIENT[variant].label}）` : ''}`}
        placeholder={missing ? `v${art!.version} 的正文在 ${v.root ? `${v.root}/` : ''}${art!.path}，原型里看不到；在这里写，保存后存成 v${next}`
          : kind === 'script' ? (variant === 'portrait' ? '## 第 1 屏\n竖版一屏一句，每屏 40 字以内' : '## 开场\n按章节写，一章一段') : kind === 'outline' ? '# 标题\n\n## 第 1 章 ……\n- 要点' : '粘贴原文，或者从上面的链接导入'}
        onChange={(e) => onEdit(e.target.value)} />
      <div className="vd-pane-foot">
        <span className="vd-pane-stat" title={kind === 'script' ? `按每分钟 ${SPEECH_RATE} 字估` : undefined}>
          {st.chars} 字{kind === 'script' && st.chars > 0 && ` · 约 ${speakText(st.seconds)}`}{kind === 'outline' && sections > 0 && ` · ${sections} 节`}
        </span>
        <span className="vd-pane-save">{dirty ? `草稿已自动保存 · ${timeAgo(draft.saved_at)}` : saved ? `v${saved.version} 已保存 · ${timeAgo(saved.saved_at)}` : ''}</span>
        <span className="spacer" />
        <button className="act" disabled={!dirty || !body.trim()} title={!dirty ? '没有改动' : !body.trim() ? '稿子是空的' : `存成 v${next}，状态是草稿`} onClick={() => onSave(body, 'draft')}>保存为 v{next}</button>
        <button className="act act-primary" disabled={submitOff} title={empty ? '稿子是空的，不能交验收' : !dirty && !art ? '先保存成版本' : undefined}
          onClick={() => (dirty ? onSave(body, 'review') : onSubmit())}>{submitLabel}</button>
      </div>
      {empty && art?.status !== 'review' && <div className="vd-pane-err">稿子是空的，写了才能交验收</div>}
    </div>
  )
}

/** 内容编写的编辑区：口播稿按比例分栏、大纲一栏、原文可选；按选题大纲起草出初稿，对比后采用或丢弃 */
function ScriptDesk({ v, mine, texts, topic, clips, runner, busy, onDraft, onEdit, onSave, onSubmit, onAdopt, onDiscard, onOpenArt, onClose }: {
  v: Video; mine: Artifact[]; texts: ScriptText[]; topic?: Topic; clips: Clip[]; runner: StageRunner
  /** 整集有执行器在跑 */
  busy: boolean
  onDraft: () => void
  onEdit: (kind: TextKind, variant: Orientation | undefined, body: string) => void
  onSave: (kind: TextKind, variant: Orientation | undefined, body: string, status: ArtifactStatus) => void
  onSubmit: (kind: TextKind, variant?: Orientation) => void
  onAdopt: (p: ScriptText) => void
  onDiscard: (ps: ScriptText[]) => void
  onOpenArt: (id: string) => void
  /** 内容编写已经过了，点开看的可以收起 */
  onClose?: () => void
}) {
  const os: Orientation[] = v.orientations.length ? v.orientations : ['landscape']
  const [ov, setOv] = useState<Orientation>(os[0])
  const outlineVariant = os.includes(ov) ? ov : os[0]
  const art = (kind: TextKind, variant?: Orientation) => mine.filter((a) => a.kind === kind && a.variant === variant).sort((a, b) => b.version - a.version)[0]
  const article = art('article')
  const [articleOpen, setArticleOpen] = useState(!!article || texts.some((x) => x.kind === 'article'))
  const [url, setUrl] = useState('')
  const [importing, setImporting] = useState(false)
  const [urlErr, setUrlErr] = useState('')
  const proposals = texts.filter((x) => x.draft === 'proposal')
  const drafting = v.last_run?.stage === 'script' && v.last_run.status === 'running'
  // 文稿、分镜两个视图（TSK-0456）
  const [view, setView] = useState<'text' | 'board'>('text')
  const links = topic ? clips.filter((c) => topic.clip_ids.includes(c.id) && c.url) : []
  const currentBody = (kind: TextKind, variant?: Orientation) => {
    const a = art(kind, variant)
    const d = texts.find((x) => x.kind === kind && x.variant === variant && x.draft === 'mine')
    const s = a && texts.find((x) => x.kind === kind && x.variant === variant && !x.draft && x.version === a.version)
    return { body: d?.body ?? s?.body ?? '', label: d ? '现在（没保存的草稿）' : a ? `现在（v${a.version}）` : '现在（还没写）', dirty: !!d }
  }
  const importUrl = () => {
    const u = url.trim()
    if (!URL_RE.test(u)) { setUrlErr('链接格式不对，要 http:// 或 https:// 开头'); return }
    setUrlErr(''); setImporting(true)
    window.setTimeout(() => {
      const host = u.replace(/^https?:\/\//, '').split('/')[0]
      onEdit('article', undefined, `> 来源：${u}\n\n（原型模拟导入：正式版用内置浏览器抓正文，去掉导航和广告）\n\n${host} 上这篇文章的正文会出现在这里，导入后可以直接改。`)
      setImporting(false); setUrl('')
    }, 900)
  }
  const pane = (kind: TextKind, variant: Orientation | undefined, head: ReactNode) => (
    <TextPane key={`${kind}-${variant ?? ''}`} v={v} kind={kind} variant={variant} art={art(kind, variant)} texts={texts} head={head}
      onEdit={(b) => onEdit(kind, variant, b)} onSave={(b, st) => onSave(kind, variant, b, st)} onSubmit={() => onSubmit(kind, variant)} onOpenArt={onOpenArt} />
  )
  const pLabel = (p: ScriptText) => `${p.variant && p.kind !== 'article' ? ORIENT[p.variant].label : ''}${TEXT_LABEL[p.kind]}`
  // 分镜按当前口播稿（第一个比例，含没保存的草稿）生成，没有口播稿用大纲
  const sbSource = (['script', 'outline'] as const).map((k) => ({ kind: k, version: art(k, os[0])?.version, body: currentBody(k, os[0]).body })).find((x) => x.body.trim())
  return (
    <div className="vd-desk">
      <div className="vd-desk-bar">
        <span className="seg seg-sm">
          <button className={cls(view === 'text' && 'on')} onClick={() => setView('text')}>文稿</button>
          <button className={cls(view === 'board' && 'on')} onClick={() => setView('board')}>分镜</button>
        </span>
        {view === 'board' && <span className="spacer" />}
        {view === 'board' && onClose && <button className="act act-quiet" onClick={onClose}>收起</button>}
        {view === 'text' && <>
        <span className="run-muted vd-desk-hint">{topic ? `可以照选题「${topic.title || '未命名选题'}」的角度和大纲起草，也可以直接写` : '先在「选题」一步挂上选题，才能按大纲起草；也可以直接写'}</span>
        <span className="spacer" />
        {onClose && <button className="act act-quiet" onClick={onClose}>收起</button>}
        <button className="act act-primary" disabled={!topic || busy} title={!topic ? '先选好选题' : busy && !drafting ? '另一个阶段正在跑，等它跑完' : `交给${RUNNER_TYPE[runner.type]}「${runnerName(runner) ?? runner.ref_id}」起草`} onClick={onDraft}>
          {drafting ? '起草中…' : proposals.length ? '重新起草' : v.last_run?.stage === 'script' && v.last_run.status === 'failed' ? '重试起草' : '按选题大纲起草'}
        </button>
        </>}
      </div>
      {view === 'board' && <StoryboardDesk v={v} source={sbSource} />}
      {view === 'text' && <>

      {drafting && <div className="vd-runner-state"><i className="vd-spin" />正在起草，开始于 {timeAgo(v.last_run!.started_at)}；跑完出初稿，对比后再决定用不用</div>}
      {v.last_run?.stage === 'script' && v.last_run.status === 'failed' && (
        <div className="vd-cp-reject">起草失败：{v.last_run.error ?? '没有返回原因'}{v.last_run.ended_at && ` · ${timeAgo(v.last_run.ended_at)}`}</div>
      )}
      {proposals.length > 0 && (
        <div className="vd-proposal">
          <div className="vd-proposal-head">
            <b>初稿 {proposals.length} 份</b>
            <span className="run-muted">{proposals[0].source ? `${SOURCE_LABEL[proposals[0].source.type]} · ${proposals[0].source.label}` : ''} · {timeAgo(proposals[0].saved_at)}起草；采用的存成新版本</span>
            <span className="spacer" />
            <button className="act act-primary" onClick={() => proposals.forEach(onAdopt)}>全部采用</button>
            <button className="act act-quiet" onClick={() => onDiscard(proposals)}>全部丢弃</button>
          </div>
          {proposals.map((p) => {
            const c = currentBody(p.kind, p.variant)
            return (
              <div key={`${p.kind}-${p.variant ?? ''}`} className="vd-cmp">
                <div className="vd-cmp-head">
                  <b>{pLabel(p)}</b>
                  {c.dirty && <span className="vd-plan-warn">采用后，没保存的改动会被初稿替换</span>}
                  <span className="spacer" />
                  <button className="act" onClick={() => onAdopt(p)}>采用</button>
                  <button className="act act-quiet" onClick={() => onDiscard([p])}>丢弃</button>
                </div>
                <div className="vd-cmp-cols">
                  <div className="vd-cmp-col"><div className="vd-cmp-label">{c.label}</div><div className={cls('vd-cmp-text', !c.body && 'faint')}>{c.body || '空'}</div></div>
                  <div className="vd-cmp-col"><div className="vd-cmp-label">初稿 · {textStats(p.body).chars} 字</div><div className="vd-cmp-text">{p.body}</div></div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="vd-desk-cols">
        {os.map((o) => pane('script', o, <span className="vd-pane-title"><OrientShape o={o} />{ORIENT[o].label}口播稿</span>))}
        {pane('outline', outlineVariant, (
          <span className="vd-pane-title">大纲
            {os.length > 1 && (
              <span className="seg seg-sm">
                {os.map((o) => <button key={o} className={cls(outlineVariant === o && 'on')} onClick={() => setOv(o)}>{ORIENT[o].label}</button>)}
              </span>
            )}
          </span>
        ))}
      </div>

      <section className="vd-article">
        <button className="vd-article-toggle" aria-expanded={articleOpen} onClick={() => setArticleOpen(!articleOpen)}>
          <svg viewBox="0 0 16 16" width="10" height="10" style={{ transform: articleOpen ? 'rotate(90deg)' : undefined }}><path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          原文<span className="run-muted">可选；有原文的按原文改写，口播稿和大纲各自存</span>
          {article && <span className="vd-ver">v{article.version}</span>}
        </button>
        {articleOpen && (
          <div className="vd-article-body">
            <div className="vd-import">
              <input className={cls('mono', urlErr && 'bad')} value={url} placeholder="https://… 从链接导入正文" disabled={importing}
                onChange={(e) => { setUrl(e.target.value); setUrlErr('') }} onKeyDown={(e) => { if (e.key === 'Enter') importUrl() }} />
              <button className="act" disabled={!url.trim() || importing} onClick={importUrl}>{importing ? '导入中…' : '导入'}</button>
            </div>
            {urlErr && <div className="field-err">{urlErr}</div>}
            {links.length > 0 && (
              <div className="vd-import-links"><span className="run-muted">选题素材里的链接</span>
                {links.map((c) => <button key={c.id} className="chip" title={c.url} onClick={() => { setUrl(c.url!); setUrlErr('') }}>{c.title}</button>)}
              </div>
            )}
            {pane('article', undefined, <span className="vd-pane-title">原文</span>)}
          </div>
        )}
      </section>
      </>}
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
        <span className="drawer-kicker">{K.label}{a.variant && ` · ${orientText(a.variant)}`}{a.kind === 'cover' && ` · 封面 ${ratioText(coverRatioOf(a))}`}{a.option && ` · 第 ${a.option} 版`}</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="drawer-body form">
        <div className="vd-dr-head">
          {a.kind === 'cover' && <span className={cls('vd-dr-cover', COVER_RATIO[coverRatioOf(a)].h > COVER_RATIO[coverRatioOf(a)].w && 'tall')}><CoverThumb r={coverRatioOf(a)} op={a.option ?? 1} big /></span>}
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
          {a.kind === 'cover' && <><dt>封面比例</dt><dd>{ratioText(coverRatioOf(a))}</dd></>}
          {a.lang && <><dt>语言</dt><dd>{a.lang === 'zh' ? '中文' : a.lang}</dd></>}
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
            <span className="field-label">选用<span className="field-hint">同一方向、同一封面比例只选一张，发布时默认用它</span></span>
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
