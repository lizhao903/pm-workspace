// 视频页的路由：子路径和列表视图互转
import type { DetailTab } from './Detail'

export type ListView = { kind: 'all' } | { kind: 'review' } | { kind: 'single' } | { kind: 'series'; id: string }

/** 系列列表（SPEC-videos-5），单独一页 */
type SeriesList = { kind: 'series-list' }

/** 选题库、素材收件箱（VID-08c），选题抽屉用 ?t=<选题 id> 打开 */
type TopicPages = { kind: 'topics' } | { kind: 'clips' }

type Route = { kind: 'list'; view: ListView } | SeriesList | TopicPages | { kind: 'video'; id: string; tab: DetailTab } | { kind: 'bad' }

export function routeOf(rest: string): Route {
  const seg = rest.split('/').filter(Boolean).map(decodeURIComponent)
  if (!seg.length) return { kind: 'list', view: { kind: 'all' } }
  if (seg.length === 1 && (seg[0] === 'review' || seg[0] === 'single')) return { kind: 'list', view: { kind: seg[0] } }
  if (seg.length === 1 && seg[0] === 'series') return { kind: 'series-list' }
  if (seg.length === 1 && (seg[0] === 'topics' || seg[0] === 'clips')) return { kind: seg[0] }
  if (seg.length === 2 && seg[0] === 'series') return { kind: 'list', view: { kind: 'series', id: seg[1] } }
  if (seg[0] === 'v' && seg.length === 2) return { kind: 'video', id: seg[1], tab: 'flow' }
  if (seg[0] === 'v' && seg.length === 3 && (seg[2] === 'settings' || seg[2] === 'artifacts')) return { kind: 'video', id: seg[1], tab: seg[2] }
  return { kind: 'bad' }
}

export const viewPath = (v: ListView) => (v.kind === 'all' ? '' : v.kind === 'series' ? `/series/${encodeURIComponent(v.id)}` : `/${v.kind}`)
/** 详情标签的子路径 */
export const tabPath = (t: DetailTab) => (t === 'flow' ? '' : `/${t}`)

export const viewKey = (v: ListView) => (v.kind === 'series' ? `series:${v.id}` : v.kind)

