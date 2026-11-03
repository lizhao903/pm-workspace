// 发布记录和封面 A/B 的纯函数（VID-05c）：平台颜色和推荐比例、状态、账号角色、测试方式、按平台规则校验、接入情况、回填表单。
// 状态、角色、测试方式是插件自己的约定，没有字典接口，同原型 web-next/src/videodata.ts 的 PUBLISH_STATUS、ACCOUNT_ROLE、COVER_TEST_MODE；
// 平台规则、收的封面比例从后端 GET /api/video/platforms 读
import type {
  VideoAccount, VideoAccountRole, VideoArtifact, VideoCoverRatio, VideoCoverTest, VideoCoverTestMode, VideoCoverTestStatus, VideoMetrics,
  VideoOrientation, VideoPlatform, VideoPlatformInfo, VideoPublish, VideoPublishCheck, VideoPublishRule, VideoPublishStatus,
} from '../../core/data'
import { COVER_RATIO, coverRatioOf } from './artifactModel'

/** 平台的品牌色和推荐的画面比例，顺序同后端 Platforms */
export const PLATFORM_META: Record<VideoPlatform, { label: string; color: string; prefer: VideoOrientation }> = {
  bilibili: { label: 'B 站', color: '#fb7299', prefer: 'landscape' },
  youtube: { label: 'YouTube', color: '#ff0033', prefer: 'landscape' },
  douyin: { label: '抖音', color: '#161823', prefer: 'portrait' },
  channels: { label: '视频号', color: '#07c160', prefer: 'portrait' },
  xiaohongshu: { label: '小红书', color: '#ff2442', prefer: 'portrait' },
}
export const PLATFORM_KEYS = Object.keys(PLATFORM_META) as VideoPlatform[]

export const PUBLISH_STATUS: Record<VideoPublishStatus, { label: string; color: string }> = {
  planned: { label: '计划中', color: 'var(--faint)' },
  scheduled: { label: '已定时', color: 'var(--accent)' },
  published: { label: '已发布', color: 'var(--ok)' },
  failed: { label: '发布失败', color: 'var(--danger)' },
}
export const PUBLISH_STATUSES = Object.keys(PUBLISH_STATUS) as VideoPublishStatus[]

export const ACCOUNT_ROLE: Record<VideoAccountRole, string> = { main: '主号', ab: 'A/B 小号', client: '客户号' }

export const COVER_TEST_MODE: Record<VideoCoverTestMode, { label: string; desc: string }> = {
  native: { label: '平台原生测试', desc: '同一条发布，平台轮换封面（YouTube 缩略图测试）' },
  accounts: { label: '小号分发', desc: '主号和 A/B 小号各发一版，每版一张封面' },
  utm: { label: '分链接', desc: '同一条发布，不同投放链接配不同封面' },
}
export const COVER_TEST_STATUS: Record<VideoCoverTestStatus, { label: string; color: string }> = {
  running: { label: '进行中', color: 'var(--accent)' },
  decided: { label: '已决出', color: 'var(--ok)' },
  inconclusive: { label: '没有结论', color: 'var(--faint)' },
}
/** 原生封面测试只有 YouTube 和 B 站有 */
export const nativeTestOk = (k: VideoPlatform) => k === 'youtube' || k === 'bilibili'
export const MAX_ARMS = 5

/** 发布详情曲线上标出的几天 */
export const SNAPSHOT_DAYS = [1, 3, 7, 30]
/** 发布后第几天：满一天算 1，不足一天也算 1（同后端） */
export const dayAfter = (from: string, at = new Date().toISOString()) => Math.max(1, Math.floor((Date.parse(at) - Date.parse(from)) / 86400000))

export const num = (n: number | undefined) => (n == null ? '-' : n.toLocaleString('zh-CN'))
export const pct = (x: number | undefined, d = 1) => (x == null ? '-' : `${(x * 100).toFixed(d)}%`)
export const wan = (n: number) => (n >= 10000 ? `${+(n / 10000).toFixed(1)} 万` : n.toLocaleString('zh-CN'))
export const ratiosText = (rs: VideoCoverRatio[], sep = '、') => rs.map((r) => COVER_RATIO[r].label).join(sep)
export const fmtTime = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

/** 标签：逗号、顿号、空格或 # 分开，去重保序 */
export const parseTags = (s: string) => [...new Set(s.split(/[,，、\s#]+/).map((x) => x.trim()).filter(Boolean))]

const len = (s: string) => [...s.trim()].length
/** 按平台规则校验一条待发布的内容，文案同后端 rules.go 和原型 checkPublish */
export function checkPublish(rule: VideoPublishRule, label: string, x: { title: string; desc: string; tags: string[]; cover?: VideoCoverRatio; duration?: number }): VideoPublishCheck[] {
  const t = len(x.title)
  const d = len(x.desc)
  const out: VideoPublishCheck[] = [
    { key: 'title', ok: t <= rule.title_max, text: t <= rule.title_max ? `标题 ${t} / ${rule.title_max} 字` : `标题超长：${label}最多 ${rule.title_max} 字，现在 ${t} 字` },
    { key: 'desc', ok: d <= rule.desc_max, text: d <= rule.desc_max ? `简介 ${d} / ${rule.desc_max} 字` : `简介超长：${label}最多 ${rule.desc_max} 字，现在 ${d} 字` },
    { key: 'tags', ok: x.tags.length <= rule.tags_max, text: x.tags.length <= rule.tags_max ? `标签 ${x.tags.length} / ${rule.tags_max} 个` : `标签太多：${label}最多 ${rule.tags_max} 个，现在 ${x.tags.length} 个` },
  ]
  if (!rule.allow_link) {
    const link = /https?:\/\/|www\./i.test(x.desc)
    out.push({ key: 'link', ok: !link, text: link ? `简介带外链：${label}不允许放链接` : '简介没有外链' })
  }
  if (x.cover) {
    const ok = rule.cover.includes(x.cover)
    out.push({ key: 'cover', ok, text: ok ? `封面 ${COVER_RATIO[x.cover].label} 符合要求` : `封面比例不对：${label}要 ${ratiosText(rule.cover, ' 或 ')}` })
  }
  if (rule.duration_max_sec && x.duration) {
    const ok = x.duration <= rule.duration_max_sec
    out.push({ key: 'duration', ok, text: ok ? `时长 ${Math.ceil(x.duration / 60)} 分钟，没超过 ${rule.duration_max_sec / 60} 分钟` : `时长超出：${label}最长 ${rule.duration_max_sec / 60} 分钟` })
  }
  return out
}

/**
 * 平台的接入情况：ok 接通了能自动投稿；manual 接了但平台没有投稿能力，发完回来填链接；error 连接异常；
 * none 没接入；register 平台没有连接器（视频号、小红书），只能登记、手填数据
 */
export type ChannelState = { state: 'ok' | 'manual' | 'error' | 'none' | 'register'; name?: string; error?: string }
export function channelOf(p: VideoPlatformInfo | undefined): ChannelState {
  if (!p?.tool) return { state: 'register' }
  const live = p.connectors.filter((c) => c.status === 'connected')
  if (!live.length) {
    const bad = p.connectors.find((c) => c.status === 'error')
    return bad ? { state: 'error', name: bad.name, error: bad.error } : { state: 'none' }
  }
  return p.caps.includes('upload') ? { state: 'ok', name: live[0].name } : { state: 'manual', name: live[0].name }
}
/** 能拉数据：平台有 metrics 能力且有接通的连接器 */
export const canSync = (p: VideoPlatformInfo | undefined) => !!p?.caps.includes('metrics') && p.connectors.some((c) => c.status === 'connected')

/** 一集某个方向下平台收的封面，推荐的比例排前面 */
export function coversFor(covers: VideoArtifact[], videoId: string, ratios: VideoCoverRatio[], variant?: VideoOrientation) {
  return covers.filter((a) => a.video_id === videoId && a.kind === 'cover' && (!variant || a.variant === variant) && ratios.includes(coverRatioOf(a)))
    .sort((a, b) => ratios.indexOf(coverRatioOf(a)) - ratios.indexOf(coverRatioOf(b)) || (a.option ?? 0) - (b.option ?? 0))
}

/** 平台的默认账号：主号，没有主号取第一个 */
export const mainAccount = (xs: VideoAccount[], k: VideoPlatform) => {
  const mine = xs.filter((a) => a.platform === k)
  return (mine.find((a) => a.role === 'main') ?? mine[0])?.id
}

/** 列表排序：发布时间或定时时间新的在前，都没有的按登记时间 */
export const pubTime = (p: VideoPublish) => p.published_at ?? p.scheduled_at ?? p.created_at
export const sortPublishes = (xs: VideoPublish[]) => [...xs].sort((a, b) => pubTime(b).localeCompare(pubTime(a)))

/** 按视频分组：组的先后跟着组里最新的一条 */
export function groupByVideo(rows: VideoPublish[]) {
  const by = new Map<string, VideoPublish[]>()
  rows.forEach((p) => by.set(p.video_id, [...(by.get(p.video_id) ?? []), p]))
  return [...by].map(([id, xs]) => ({ id, xs }))
}
/** 每组先露几条，失败的排前面 */
export const PEEK = 3
export const peekOf = (xs: VideoPublish[]) => [...xs.filter((p) => p.status === 'failed'), ...xs.filter((p) => p.status !== 'failed')].slice(0, PEEK)

/** 这条发布在哪个封面测试里 */
export const testOfPub = (tests: VideoCoverTest[], id: string) => tests.find((t) => t.arms.some((a) => a.publish_id === id))

/** datetime-local 要的本地时间格式 */
export const toLocalInput = (d: Date) => {
  const z = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`
}
/** datetime-local 的时间已经不晚于现在；格式不对算 false，另外提示 */
export const isPast = (local: string, now = Date.now()) => { const t = new Date(local).getTime(); return !Number.isNaN(t) && t <= now }
export const tomorrow10 = (now = new Date()) => { const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return toLocalInput(d) }

/* ---------- 回填数据 ---------- */

export type BaseKey = 'views' | 'likes' | 'comments' | 'shares'
export const BASE_METRICS: { key: BaseKey; label: string }[] = [
  { key: 'views', label: '播放' }, { key: 'likes', label: '点赞' }, { key: 'comments', label: '评论' }, { key: 'shares', label: '转发' },
]
export type ExtKey = 'impressions' | 'ctr' | 'avg_watch_sec' | 'completion' | 'favorites' | 'coins' | 'followers_gained'
export type ExtKind = 'int' | 'pct' | 'sec' | 'signed'
export const EXT_METRICS: { key: ExtKey; label: string; kind: ExtKind }[] = [
  { key: 'impressions', label: '曝光', kind: 'int' }, { key: 'ctr', label: '点击率', kind: 'pct' }, { key: 'avg_watch_sec', label: '平均观看', kind: 'sec' },
  { key: 'completion', label: '完播率', kind: 'pct' }, { key: 'favorites', label: '收藏', kind: 'int' }, { key: 'coins', label: '投币', kind: 'int' },
  { key: 'followers_gained', label: '涨粉', kind: 'signed' },
]
export const fmtExt = (kind: ExtKind, v: number | undefined) =>
  (v == null ? '-' : kind === 'pct' ? pct(v) : kind === 'sec' ? `${Math.floor(v / 60)} 分 ${Math.round(v % 60)} 秒` : num(v))

export type MetricFill = Record<BaseKey | ExtKey, string>
// 百分比的格子填 0 到 100，存成 0 到 1；平均观看填秒
const toText = (kind: ExtKind, v: number | undefined) => (v == null ? '' : kind === 'pct' ? String(+(v * 100).toFixed(2)) : String(v))
export function fillOf(m: VideoMetrics | undefined): MetricFill {
  const f = {} as MetricFill
  BASE_METRICS.forEach((b) => { f[b.key] = String(m?.[b.key] ?? 0) })
  EXT_METRICS.forEach((e) => { f[e.key] = toText(e.kind, m?.[e.key]) })
  return f
}
export const badBase = (s: string) => !/^\d+$/.test(s.trim())
export function badExt(kind: ExtKind, s: string) {
  const t = s.trim()
  if (!t) return false
  if (kind === 'pct') return !/^\d+(\.\d+)?$/.test(t) || Number(t) > 100
  if (kind === 'sec') return !/^\d+(\.\d+)?$/.test(t) || Number(t) > 86400
  if (kind === 'signed') return !/^-?\d+$/.test(t)
  return !/^\d+$/.test(t)
}
export const fillBad = (f: MetricFill) => BASE_METRICS.some((b) => badBase(f[b.key])) || EXT_METRICS.some((e) => badExt(e.kind, f[e.key]))
/** 回填表单换成要存的数据；平台不给的留空不传 */
export function fillToMetrics(f: MetricFill, at = new Date().toISOString()): VideoMetrics {
  const m: VideoMetrics = { views: Number(f.views), likes: Number(f.likes), comments: Number(f.comments), shares: Number(f.shares), updated_at: at }
  EXT_METRICS.forEach((e) => {
    const t = f[e.key].trim()
    if (t) m[e.key] = e.kind === 'pct' ? +(Number(t) / 100).toFixed(4) : Number(t)
  })
  return m
}

/* ---------- 封面 A/B ---------- */

/** 判定进度：小号分发的数后端从发布记录读，放在 state.arms */
export const armNums = (t: VideoCoverTest, coverId: string) => t.state.arms.find((a) => a.cover_id === coverId) ?? t.arms.find((a) => a.cover_id === coverId)

/** 原生测试回填各组数据：曝光填整数，点击率填 0 到 100 */
export const badArmImp = (s: string) => !!s.trim() && !/^\d+$/.test(s.trim())
export const badArmCtr = (s: string) => !!s.trim() && (!/^\d+(\.\d+)?$/.test(s.trim()) || Number(s.trim()) > 100)
