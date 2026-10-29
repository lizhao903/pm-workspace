// 视频插件的纯函数：阶段、比例常量和视频状态。阶段、比例是插件自己的约定，后端 internal/plugins/video/data.go 同一份，
// 没有字典接口，两边同序，加值两边一起加（同原型 web-next/src/videodata.ts 的 STAGES、ORIENT、videoState）
import type { Video, VideoCheckpoint, VideoCheckpointStage, VideoOrientation, VideoSeries, VideoStageKey } from '../../core/data'

export type Stage = { key: VideoStageKey; label: string; checkpoint: boolean; desc: string }

export const STAGES: Stage[] = [
  { key: 'script', label: '内容编写', checkpoint: false, desc: '口播稿、大纲，一次产出' },
  { key: 'plan', label: '规划检查', checkpoint: true, desc: '对齐稿子、大纲、主题、素材、开发方式和画面比例；比例定了就不能改' },
  { key: 'web', label: '网页开发', checkpoint: false, desc: '按比例搭演示工程，第 1 章完整做出来' },
  { key: 'ch1', label: '第一章验收', checkpoint: true, desc: '第 1 章是后面所有章节的样板，必须验收' },
  { key: 'chapters', label: '其余章节', checkpoint: false, desc: '第 2 到 N 章：逐章、顺序或并行开发' },
  { key: 'audio', label: '音频合成', checkpoint: true, desc: '决定要不要合成口播音频，按章节出音频' },
  { key: 'record', label: '录屏渲染', checkpoint: false, desc: '程序化录屏，合成 mp4' },
  { key: 'distribution', label: '分发包', checkpoint: true, desc: '封面（每个比例 5 个版本）、简介、章节时间轴' },
]

export const ORIENTS: VideoOrientation[] = ['landscape', 'portrait', 'square']
export const ORIENT: Record<VideoOrientation, { label: string; ratio: string; w: number; h: number }> = {
  landscape: { label: '横屏', ratio: '16:9', w: 16, h: 9 },
  portrait: { label: '竖屏', ratio: '9:16', w: 9, h: 16 },
  square: { label: '方形', ratio: '1:1', w: 1, h: 1 },
}
export const orientText = (o: VideoOrientation) => `${ORIENT[o].label} ${ORIENT[o].ratio}`

export const stageIndex = (k: VideoStageKey) => STAGES.findIndex((s) => s.key === k)
export const stageLabel = (k: StageFilter) => (k === 'done' ? '已完成' : STAGES.find((s) => s.key === k)?.label ?? k)

export const cpOf = (v: Video, k: VideoStageKey): VideoCheckpoint | undefined => v.checkpoints.find((c) => c.stage === k)
export const isFinished = (v: Video) => v.stage === 'distribution' && cpOf(v, 'distribution')?.state === 'passed'
/** 规划检查通过后比例锁定：每个比例是一个独立的演示工程，换比例等于重做 */
export const orientLocked = (v: Video) => cpOf(v, 'plan')?.state === 'passed'

export type Tone = 'ok' | 'warn' | 'info'
export const TONE_COLOR: Record<Tone, string> = { ok: 'var(--ok)', warn: 'var(--warn)', info: 'var(--accent)' }

/** 视频状态：已完成 / 待某检查点 / 退回修改 / 当前阶段名 */
export function videoState(v: Video): { label: string; tone: Tone } {
  if (isFinished(v)) return { label: '已完成', tone: 'ok' }
  const s = STAGES[stageIndex(v.stage)]
  if (!s) return { label: v.stage, tone: 'info' }
  if (s.checkpoint) {
    const cp = cpOf(v, s.key)
    if (!cp || cp.state === 'pending') return { label: `待${s.label}`, tone: 'warn' }
    if (cp.state === 'rejected') return { label: '退回修改', tone: 'warn' }
  }
  return { label: s.label, tone: 'info' }
}

/** 等我动手的：停在检查点上待确认，或者被退回待修改 */
export const needsMe = (v: Video) => videoState(v).tone === 'warn'

export function stepState(v: Video, i: number): 'done' | 'current' | 'todo' {
  const cur = stageIndex(v.stage)
  if (isFinished(v) || i < cur) return 'done'
  return i === cur ? 'current' : 'todo'
}

export type StageFilter = '' | VideoStageKey | 'done'
export const stageOf = (v: Video): StageFilter => (isFinished(v) ? 'done' : v.stage)
export const STAGE_FILTERS: StageFilter[] = [...STAGES.map((s) => s.key), 'done']

/** 列表筛选：阶段、项目（'-' 是不属于项目）、关键词（标题、目录、集数） */
export function filterVideos(xs: Video[], f: { stage: StageFilter; project: string; q: string }) {
  const kw = f.q.trim().toLowerCase()
  return xs.filter((v) => (!f.stage || stageOf(v) === f.stage)
    && (!f.project || (f.project === '-' ? !v.project_id : v.project_id === f.project))
    && (!kw || `${v.title}${v.root}${v.episode ?? ''}`.toLowerCase().includes(kw)))
}

export type Sort = 'episode' | 'updated'
export function sortVideos(xs: Video[], sort: Sort) {
  return [...xs].sort(sort === 'episode'
    ? (a, b) => (a.episode ?? 9999) - (b.episode ?? 9999) || a.created_at.localeCompare(b.created_at)
    : (a, b) => b.updated_at.localeCompare(a.updated_at))
}

/** 分组时每组先露的集数 */
export const PEEK = 4
/** 每组先露等我处理的，再按更新时间补满 */
export const peek = (xs: Video[]) => [...xs].sort((a, b) => Number(needsMe(b)) - Number(needsMe(a)) || b.updated_at.localeCompare(a.updated_at)).slice(0, PEEK)

export type Group = { key: string; seriesId?: string; name: string; videos: Video[] }
/** 按系列分组，单集放最后；系列里没有集的不出 */
export function groupBySeries(videos: Video[], series: VideoSeries[]): Group[] {
  const known = new Set(series.map((s) => s.id))
  return [
    ...series.map((s) => ({ key: s.id, seriesId: s.id, name: s.name, videos: videos.filter((v) => v.series_id === s.id) })),
    { key: '-', name: '单集', videos: videos.filter((v) => !v.series_id || !known.has(v.series_id)) },
  ].filter((g) => g.videos.length)
}

export const isSingle = (v: Video, series: VideoSeries[]) => !v.series_id || !series.some((s) => s.id === v.series_id)

export function seriesLine(v: Video, series: VideoSeries[]) {
  const s = series.find((x) => x.id === v.series_id)
  if (!s) return '单集'
  return v.episode ? `${s.name} · 第 ${v.episode} 集` : s.name
}

/** 系列里下一集的集数 */
export const nextEpisode = (videos: Video[], seriesId: string) => Math.max(0, ...videos.filter((v) => v.series_id === seriesId).map((v) => v.episode ?? 0)) + 1

/** 新建视频的默认目录：videos/new-<n>，和已有的不重 */
export function newRoot(videos: Video[]) {
  const used = new Set(videos.map((v) => v.root))
  let n = videos.length + 1
  while (used.has(`videos/new-${n}`)) n += 1
  return `videos/new-${n}`
}

/** 当前检查点：停在检查点上、还没通过或跳过 */
export function openCheckpoint(v: Video): VideoCheckpointStage | null {
  const s = STAGES[stageIndex(v.stage)]
  if (!s?.checkpoint || isFinished(v)) return null
  const st = cpOf(v, s.key)?.state
  return st === 'passed' || st === 'skipped' ? null : (s.key as VideoCheckpointStage)
}

/** 相对时间，同原型 ui.tsx 的 timeAgo */
export function timeAgo(iso: string, now = Date.now()) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const m = Math.round((now - t) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  if (m < 1440) return `${Math.floor(m / 60)} 小时前`
  if (m < 2880) return '昨天'
  return `${Math.floor(m / 1440)} 天前`
}
