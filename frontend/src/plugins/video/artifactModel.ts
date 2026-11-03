// 产出物和系列的纯函数（VID-01d）：类型、状态、封面比例、默认名称路径、时长、预览地址、来源跳转、系列待同步。
// 类型、状态、封面比例是插件自己的约定，没有字典接口，同原型 web-next/src/videodata.ts 的 ARTIFACT_KIND、ARTIFACT_STATUS、COVER_RATIO，
// 后端 internal/plugins/video/data.go 同一份，加值两边一起加
import type {
  Video, VideoArtifact, VideoArtifactKind, VideoArtifactSource, VideoArtifactStatus, VideoCoverRatio, VideoOrientation, VideoSeries, VideoStageKey,
} from '../../core/data'
import { ORIENT } from './model'

export const ARTIFACT_KIND: Record<VideoArtifactKind, { label: string; stage: VideoStageKey; perVariant: boolean }> = {
  article: { label: '原文', stage: 'script', perVariant: false },
  script: { label: '口播稿', stage: 'script', perVariant: true },
  outline: { label: '大纲', stage: 'script', perVariant: true },
  presentation: { label: '演示工程', stage: 'web', perVariant: true },
  audio: { label: '音频', stage: 'audio', perVariant: false },
  video: { label: '视频', stage: 'record', perVariant: true },
  subtitle: { label: '字幕', stage: 'record', perVariant: true },
  cover: { label: '封面', stage: 'distribution', perVariant: true },
  description: { label: '简介', stage: 'distribution', perVariant: true },
  chapters: { label: '章节时间轴', stage: 'distribution', perVariant: true },
}
export const KINDS = Object.keys(ARTIFACT_KIND) as VideoArtifactKind[]

export const ARTIFACT_STATUS: Record<VideoArtifactStatus, { label: string; color: string }> = {
  draft: { label: '草稿', color: 'var(--faint)' },
  review: { label: '待验收', color: 'var(--warn)' },
  final: { label: '已定稿', color: 'var(--ok)' },
  published: { label: '已发布', color: 'var(--accent)' },
}
export const STATUSES = Object.keys(ARTIFACT_STATUS) as VideoArtifactStatus[]

export const SOURCE_LABEL: Record<VideoArtifactSource['type'], string> = { manual: '手动', sop: 'SOP', agent: 'Agent', skill: '技能' }

/** 封面每种封面比例几个版本 */
export const COVER_OPTIONS = 5

export const COVER_RATIO: Record<VideoCoverRatio, { label: string; w: number; h: number }> = {
  '16x9': { label: '16:9', w: 16, h: 9 },
  '4x3': { label: '4:3', w: 4, h: 3 },
  '9x16': { label: '9:16', w: 9, h: 16 },
  '3x4': { label: '3:4', w: 3, h: 4 },
  '1x1': { label: '1:1', w: 1, h: 1 },
}
/** 每个方向默认出哪几种封面比例；第一个和舞台同比例 */
export const DEFAULT_COVER_RATIOS: Record<VideoOrientation, VideoCoverRatio[]> = {
  landscape: ['16x9', '4x3'],
  portrait: ['9x16', '3x4', '1x1'],
  square: ['1x1', '4x3'],
}
export const defaultRatio = (o?: VideoOrientation): VideoCoverRatio => DEFAULT_COVER_RATIOS[o ?? 'landscape'][0]
/** 封面的比例：没记 ratio 的按方向的默认算 */
export const coverRatioOf = (a: { ratio?: VideoCoverRatio; variant?: VideoOrientation }): VideoCoverRatio => a.ratio ?? defaultRatio(a.variant)
export const ratioText = (r: VideoCoverRatio) => COVER_RATIO[r].label
/** 这个方向下要显示的封面比例：默认的几种，加上已经登记过的 */
export const coverRatios = (o: VideoOrientation, xs: VideoArtifact[]) => [...new Set([...DEFAULT_COVER_RATIOS[o], ...xs.map(coverRatioOf)])]

export const isPicked = (a: VideoArtifact) => !!a.picked

const ratioSlug = (o: VideoOrientation) => ORIENT[o].ratio.replace(':', 'x')

/** 默认名称：封面 n、成片，其余是类型名 */
export const defaultName = (kind: VideoArtifactKind, option?: number) =>
  (kind === 'cover' ? `封面 ${option ?? 1}` : kind === 'video' ? '成片' : ARTIFACT_KIND[kind].label)

/** 默认路径，同 SPEC-videos-11.9 */
export function defaultPath(kind: VideoArtifactKind, v: Video, variant?: VideoOrientation, option?: number, ratio?: VideoCoverRatio) {
  const base = v.root.split('/').filter(Boolean).pop() || 'video'
  switch (kind) {
    case 'presentation': return `presentation-${variant ?? 'landscape'}`
    case 'audio': return 'audio/'
    case 'video': return `out/${base}-${ratioSlug(variant ?? 'landscape')}.mp4`
    case 'subtitle': return `subtitle/${base}-${ratioSlug(variant ?? 'landscape')}.srt`
    case 'cover': return `cover/${ratio ?? defaultRatio(variant)}-${option ?? 1}.png`
    default: return ARTIFACT_KIND[kind].perVariant ? `${kind}-${variant ?? 'landscape'}.md` : `${kind}.md`
  }
}

/** 同一方向、同一封面比例里第一个空着的版本，满了给最后一个 */
export function freeOption(xs: VideoArtifact[], variant?: VideoOrientation, ratio?: VideoCoverRatio) {
  const r = ratio ?? defaultRatio(variant)
  for (let o = 1; o <= COVER_OPTIONS; o += 1) {
    if (!xs.some((a) => a.kind === 'cover' && a.variant === variant && coverRatioOf(a) === r && a.option === o)) return o
  }
  return COVER_OPTIONS
}

export const fmtDuration = (s?: number) =>
  (s === undefined ? '' : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`)

/** mm:ss 或秒数；格式不对返回 undefined（不存） */
export function parseDuration(s: string) {
  const t = s.trim()
  if (/^\d+:\d{1,2}$/.test(t)) {
    const [m, x] = t.split(':').map(Number)
    return x < 60 ? m * 60 + x : undefined
  }
  if (/^\d+$/.test(t)) return Number(t)
  return undefined
}

export const fullPath = (v: Video, a: { path: string }) => (v.root ? `${v.root.replace(/\/+$/, '')}/${a.path}` : a.path)

// 演示工程自己的预览服务端口，同原型 previewUrl；别和项目原型的端口撞上
export const PREVIEW_ORIGIN = 'http://127.0.0.1:7801'
export const canPreview = (a: VideoArtifact) => a.kind === 'presentation' || a.kind === 'video' || a.kind === 'cover' || a.kind === 'audio'
export const previewUrl = (v: Video, a: VideoArtifact) => `${PREVIEW_ORIGIN}/${fullPath(v, a).split('/').map(encodeURIComponent).join('/')}`
export const previewTitle = (v: Video, a: VideoArtifact) => `${v.title} · ${a.name}${a.variant ? `（${ORIENT[a.variant].label}）` : ''}`

export const sourceText = (s: VideoArtifactSource) => `${SOURCE_LABEL[s.type] ?? s.type} · ${s.label}`

/** 来源能跳去哪：Agent 的运行在会话的执行记录里定位，只有会话的打开会话；SOP 打开那次执行 */
export function sourceLink(s: VideoArtifactSource): { to: string; label: string } | null {
  if (s.type === 'agent') {
    if (s.run_id) return { to: `/conversations/runs?run=${encodeURIComponent(s.run_id)}`, label: '查看这次运行' }
    if (s.session_id) return { to: `/conversations?s=${encodeURIComponent(s.session_id)}`, label: '打开会话' }
  }
  if (s.type === 'sop' && s.run_id) return { to: `/sop/runs/${encodeURIComponent(s.run_id)}`, label: '查看这次执行' }
  return null
}

/** 登记表单的草稿（原型 NewArt） */
export type NewArt = {
  kind: VideoArtifactKind
  variant?: VideoOrientation
  ratio?: VideoCoverRatio
  option?: number
  name: string
  path: string
  duration: string
  /** 路径手动改过，再改类型、比例不覆盖 */
  touched: boolean
}

/** 新的登记草稿：类型、方向、封面比例、版本都能预填 */
export function newDraft(v: Video, xs: VideoArtifact[], kind: VideoArtifactKind, variant?: VideoOrientation, option?: number, ratio?: VideoCoverRatio): NewArt {
  const vr = ARTIFACT_KIND[kind].perVariant ? variant ?? v.orientations[0] ?? 'landscape' : undefined
  const rt = kind === 'cover' ? ratio ?? defaultRatio(vr) : undefined
  const op = kind === 'cover' ? option ?? freeOption(xs, vr, rt) : undefined
  return { kind, variant: vr, ratio: rt, option: op, name: defaultName(kind, op), path: defaultPath(kind, v, vr, op, rt), duration: '', touched: false }
}

/** 改类型、比例、版本时名称和路径跟着重算（SPEC-videos-11.6、11.7、11.16） */
export function patchDraft(d0: NewArt, x: Partial<NewArt>, v: Video, xs: VideoArtifact[]): NewArt {
  const d = { ...d0, ...x }
  if (x.kind) d.variant = ARTIFACT_KIND[d.kind].perVariant ? d.variant ?? v.orientations[0] ?? 'landscape' : undefined
  if (d.kind !== 'cover') {
    d.ratio = undefined
    d.option = undefined
  } else {
    // 换了方向，封面比例回到这个方向的默认（原来的还能选就保留）；换方向或封面比例，版本跳到第一个空位
    if (x.kind || x.variant) {
      const opts = DEFAULT_COVER_RATIOS[d.variant ?? 'landscape']
      d.ratio = x.ratio ?? (d.ratio && opts.includes(d.ratio) ? d.ratio : opts[0])
    }
    if (x.kind || x.variant || x.ratio) d.option = x.option ?? freeOption(xs, d.variant, d.ratio)
  }
  if (x.kind || x.option !== undefined || x.ratio) d.name = defaultName(d.kind, d.option)
  if (!d.touched && (x.kind || x.variant || x.ratio || x.option !== undefined)) d.path = defaultPath(d.kind, v, d.variant, d.option, d.ratio)
  return d
}

/** 新建时的类型：当前阶段的第一个类型 */
export const kindForStage = (stage: VideoStageKey): VideoArtifactKind => KINDS.find((k) => ARTIFACT_KIND[k].stage === stage) ?? 'script'

/** 一个类型块里要分的栏：这集的比例加上已有产出物用到的 */
export const variantCols = (v: Video, items: VideoArtifact[]) =>
  (['landscape', 'portrait', 'square'] as VideoOrientation[]).filter((o) => v.orientations.includes(o) || items.some((a) => a.variant === o))

/* ---------- 系列 ---------- */

export const SHARED: { key: 'intro' | 'outro' | 'template'; label: string; ph: string }[] = [
  { key: 'intro', label: '共用开场', ph: '比如 shared/intro.tsx（5 秒标志动画）' },
  { key: 'outro', label: '共用收尾', ph: '比如 shared/outro.tsx（关注引导 + 下集预告）' },
  { key: 'template', label: '共用模板', ph: '比如 templates/theme（主题、字体、配色）' },
]

export type SeriesDraft = { name: string; desc: string; intro: string; outro: string; template: string }
export const seriesDraftOf = (s: VideoSeries | null): SeriesDraft =>
  ({ name: s?.name ?? '', desc: s?.desc ?? '', intro: s?.intro ?? '', outro: s?.outro ?? '', template: s?.template ?? '' })
export const cleanSeries = (d: SeriesDraft): SeriesDraft =>
  ({ name: d.name.trim(), desc: d.desc.trim(), intro: d.intro.trim(), outro: d.outro.trim(), template: d.template.trim() })

/** 改过的共用部分 */
export const changedShared = (s: VideoSeries, d: SeriesDraft) => SHARED.filter((f) => d[f.key].trim() !== s[f.key].trim())

/** 影响范围确认后的 stale：勾上的加进去（不重复），没勾的原来在里面也去掉（SPEC-videos-6.14） */
export function staleAfter(stale: string[], eps: string[], picked: string[]) {
  const base = stale.filter((id) => !eps.includes(id))
  return [...base, ...eps.filter((id) => picked.includes(id))]
}

/** 编排时重复的集数 */
export function dupEpisodes(videos: Video[]) {
  const seen = new Set<number>()
  const dup = new Set<number>()
  for (const v of videos) {
    if (v.episode === undefined) continue
    if (seen.has(v.episode)) dup.add(v.episode)
    seen.add(v.episode)
  }
  return dup
}

export const episodesOf = (s: VideoSeries, videos: Video[]) =>
  videos.filter((v) => v.series_id === s.id).sort((a, b) => (a.episode ?? 9999) - (b.episode ?? 9999) || a.created_at.localeCompare(b.created_at))
