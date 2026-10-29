// 选题和素材箱的纯函数和常量（VID-08c）。选题状态、素材类型、平台是插件自己的约定，后端 internal/plugins/video/topics.go 同一份，
// 没有字典接口，两边同序，加值两边一起加（同原型 web-next/src/topicdata.ts 的 TOPIC_STATUS、CLIP_KIND、topicPriority）
import type { VideoClip, VideoClipKind, VideoPlatform, VideoTopic, VideoTopicScore, VideoTopicStatus } from '../../core/data'

export const TOPIC_FLOW: VideoTopicStatus[] = ['idea', 'research', 'ready', 'scheduled', 'made', 'dropped']
/** 颜色是 CSS 值：tokens 里有的用 tokens，没有的用 topics.css 里的插件变量 */
export const TOPIC_STATUS: Record<VideoTopicStatus, { label: string; color: string; desc: string }> = {
  idea: { label: '想法', color: 'var(--faint)', desc: '先记下来，还没细想' },
  research: { label: '调研中', color: 'var(--accent)', desc: '在找资料、看竞品、想切入角度' },
  ready: { label: '可开拍', color: 'var(--ok)', desc: '角度和大纲想清楚了，随时能立项' },
  scheduled: { label: '已排期', color: 'var(--tp-violet)', desc: '定了哪天做、哪天发' },
  made: { label: '已做成', color: 'var(--tp-teal)', desc: '已经立项成视频' },
  dropped: { label: '放弃', color: 'var(--danger)', desc: '不做了，留着备查' },
}

export const CLIP_KINDS: VideoClipKind[] = ['link', 'note', 'trend', 'comment', 'competitor', 'im']
export const CLIP_KIND: Record<VideoClipKind, { label: string; color: string }> = {
  link: { label: '链接', color: 'var(--accent)' },
  note: { label: '笔记', color: 'var(--muted)' },
  trend: { label: '热榜', color: 'var(--tp-orange)' },
  comment: { label: '评论', color: 'var(--tp-teal)' },
  competitor: { label: '竞品', color: 'var(--tp-violet)' },
  im: { label: 'IM 消息', color: 'var(--ok)' },
}

export const PLATFORMS: { key: VideoPlatform; label: string }[] = [
  { key: 'bilibili', label: 'B 站' }, { key: 'youtube', label: 'YouTube' }, { key: 'douyin', label: '抖音' },
  { key: 'channels', label: '视频号' }, { key: 'xiaohongshu', label: '小红书' },
]

export const SCORE_LABEL: Record<keyof VideoTopicScore, { label: string; hint: string }> = {
  demand: { label: '需求度', hint: '有多少人想看' },
  fit: { label: '契合度', hint: '和账号定位合不合' },
  effort: { label: '制作成本', hint: '越高越难做' },
}

/** 优先级分：需求和契合越高越好，成本越高越扣分；满分 10 */
export const topicPriority = (s: VideoTopicScore) => Math.round(((s.demand * 0.45 + s.fit * 0.35 + (6 - s.effort) * 0.2) / 5) * 100) / 10
export const prioTone = (p: number) => (p >= 8 ? 'hi' : p >= 6 ? 'mid' : 'lo')

/** 方向：标签的第一项（导入的选题表按方向分页，放在第一个标签） */
export const directionOf = (t: VideoTopic) => t.tags[0] ?? ''

/** 方向及条数，按条数多到少 */
export function directions(topics: VideoTopic[]) {
  const n = new Map<string, number>()
  for (const t of topics) { const d = directionOf(t); if (d) n.set(d, (n.get(d) ?? 0) + 1) }
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN')).map(([name, count]) => ({ name, count }))
}

export type TopicFilter = { q: string; dir: string; series: string; status: '' | VideoTopicStatus }

/** 搜标题、角度、受众、标签；方向 '-' 是没有标签的，系列 '-' 是不属于系列的；按优先级高到低，同分按更新 */
export function filterTopics(topics: VideoTopic[], f: TopicFilter) {
  const kws = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return topics.filter((t) => {
    if (f.status && t.status !== f.status) return false
    if (f.dir && (f.dir === '-' ? !!directionOf(t) : directionOf(t) !== f.dir)) return false
    if (f.series && (f.series === '-' ? !!t.series_id : t.series_id !== f.series)) return false
    if (!kws.length) return true
    const text = `${t.title} ${t.angle} ${t.audience} ${t.tags.join(' ')}`.toLowerCase()
    return kws.every((k) => text.includes(k))
  }).sort((a, b) => topicPriority(b.score) - topicPriority(a.score) || b.updated_at.localeCompare(a.updated_at))
}

/** 进行中的选题：素材只能并入这些 */
export const isOpenTopic = (t: VideoTopic) => t.status !== 'made' && t.status !== 'dropped'

/** 立项前的检查，能立项回空串 */
export function makeBlock(t: Pick<VideoTopic, 'title' | 'status' | 'video_id'>) {
  if (t.video_id) return '这个选题已经立项了'
  if (t.status === 'dropped') return '已放弃的选题不能立项'
  if (!t.title.trim()) return '先写标题'
  return ''
}

export type ClipBox = 'todo' | 'starred' | 'all'
export const inBox = (c: VideoClip, b: ClipBox) => (b === 'all' ? true : b === 'todo' ? !c.triaged : c.starred)

/** 搜标题、内容、来源、标签；保持后端的倒序 */
export function filterClips(clips: VideoClip[], f: { box: ClipBox; kind: '' | VideoClipKind; q: string }) {
  const kws = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return clips.filter((c) => inBox(c, f.box) && (!f.kind || c.kind === f.kind)
    && kws.every((k) => `${c.title} ${c.content} ${c.source} ${c.tags.join(' ')}`.toLowerCase().includes(k)))
}

/** 收进来的日子：今天 / 昨天 / 本周 / 更早 */
export function dayGroup(iso: string, now = new Date()) {
  const d = Date.parse(iso)
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (d >= day0) return '今天'
  if (d >= day0 - 86400000) return '昨天'
  return d >= day0 - ((now.getDay() + 6) % 7) * 86400000 ? '本周' : '更早'
}

/** 粘贴一行：像网址就当链接，否则当笔记；标题由后端按规则取 */
export function pastedClip(raw: string): { kind: VideoClipKind; content?: string; url?: string } | null {
  const t = raw.trim()
  if (!t) return null
  return /^https?:\/\/\S+$/.test(t) ? { kind: 'link', url: t } : { kind: 'note', content: t }
}

/** 标签输入：逗号分隔 */
export const parseTags = (s: string) => s.split(/[,，]/).map((x) => x.trim()).filter(Boolean)

/** 手动收的评论、热榜：一行一条，行尾的数字当点赞数或热度（「……  326」「…… 2.1万」） */
export function parseLines(raw: string): { text: string; heat?: number }[] {
  return raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^(.*?)[\s,，]+(\d+(?:\.\d+)?)(万|w|W|k|K)?$/)
    if (!m || !m[1].trim()) return { text: l }
    const mul = m[3] === '万' || m[3] === 'w' || m[3] === 'W' ? 10000 : m[3] ? 1000 : 1
    return { text: m[1].trim(), heat: Math.round(Number(m[2]) * mul) }
  })
}

/** 抽屉草稿：可编辑的字段 */
export type TopicDraft = Pick<VideoTopic, 'title' | 'angle' | 'audience' | 'status' | 'score' | 'tags' | 'platforms' | 'outline'> & {
  series_id: string
  /** YYYY-MM-DD */
  planned: string
  drop_reason: string
}

export const draftOf = (t: VideoTopic): TopicDraft => ({
  title: t.title, angle: t.angle, audience: t.audience, status: t.status, score: { ...t.score }, tags: [...t.tags], platforms: [...t.platforms],
  outline: t.outline, series_id: t.series_id ?? '', planned: t.planned_at ? localDate(t.planned_at) : '', drop_reason: t.drop_reason ?? '',
})

function localDate(iso: string) {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 草稿和原选题比，只挑改动的字段 */
export function topicPatch(t: VideoTopic, d: TopicDraft) {
  const o = draftOf(t)
  const p: Record<string, unknown> = {}
  for (const k of ['title', 'angle', 'audience', 'status', 'outline'] as const) if (d[k] !== o[k]) p[k] = d[k]
  if (JSON.stringify(d.score) !== JSON.stringify(o.score)) p.score = d.score
  if (JSON.stringify(d.tags) !== JSON.stringify(o.tags)) p.tags = d.tags
  if (JSON.stringify(d.platforms) !== JSON.stringify(o.platforms)) p.platforms = PLATFORMS.map((x) => x.key).filter((k) => d.platforms.includes(k))
  if (d.series_id !== o.series_id) p.series_id = d.series_id || null
  if (d.planned !== o.planned) p.planned_at = d.planned ? new Date(`${d.planned}T00:00:00`).toISOString() : null
  if (d.drop_reason !== o.drop_reason) p.drop_reason = d.drop_reason.trim() ? d.drop_reason : null
  return p
}
