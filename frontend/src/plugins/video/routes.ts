// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 视频页的路由：子路径和列表视图互转
import type { DetailTab } from './Detail'

export type ListView = { kind: 'all' } | { kind: 'review' } | { kind: 'single' } | { kind: 'series'; id: string }

/** 系列列表（SPEC-videos-5），单独一页 */
type SeriesList = { kind: 'series-list' }

/** 选题库、素材收件箱（VID-08c），选题抽屉用 ?t=<选题 id> 打开 */
type TopicPages = { kind: 'topics' } | { kind: 'clips' }

/** 发布记录（VID-05c）：?video= 只看一集，?p= 发布抽屉，?t= 封面测试抽屉 */
type PublishPage = { kind: 'publishes' }

/** 内容日历（VID-06d）：?m=week 周视图，?d= 看的那天，?p= 发布抽屉 */
type CalendarPage = { kind: 'calendar' }

/** B 站组件（TSK-0455）：?c= 连接器，?v=dm 私信，?t= 对方 UID */
type BiliPage = { kind: 'bilibili' }

type Route = { kind: 'list'; view: ListView } | SeriesList | TopicPages | PublishPage | CalendarPage | BiliPage | { kind: 'video'; id: string; tab: DetailTab } | { kind: 'bad' }

export function routeOf(rest: string): Route {
  const seg = rest.split('/').filter(Boolean).map(decodeURIComponent)
  if (!seg.length) return { kind: 'list', view: { kind: 'all' } }
  if (seg.length === 1 && (seg[0] === 'review' || seg[0] === 'single')) return { kind: 'list', view: { kind: seg[0] } }
  if (seg.length === 1 && seg[0] === 'series') return { kind: 'series-list' }
  if (seg.length === 1 && (seg[0] === 'topics' || seg[0] === 'clips')) return { kind: seg[0] }
  if (seg.length === 1 && seg[0] === 'publishes') return { kind: 'publishes' }
  if (seg.length === 1 && seg[0] === 'calendar') return { kind: 'calendar' }
  if (seg.length === 1 && seg[0] === 'bilibili') return { kind: 'bilibili' }
  if (seg.length === 2 && seg[0] === 'series') return { kind: 'list', view: { kind: 'series', id: seg[1] } }
  if (seg[0] === 'v' && seg.length === 2) return { kind: 'video', id: seg[1], tab: 'flow' }
  if (seg[0] === 'v' && seg.length === 3 && (seg[2] === 'settings' || seg[2] === 'artifacts')) return { kind: 'video', id: seg[1], tab: seg[2] }
  return { kind: 'bad' }
}

export const viewPath = (v: ListView) => (v.kind === 'all' ? '' : v.kind === 'series' ? `/series/${encodeURIComponent(v.id)}` : `/${v.kind}`)
/** 详情标签的子路径 */
export const tabPath = (t: DetailTab) => (t === 'flow' ? '' : `/${t}`)

export const viewKey = (v: ListView) => (v.kind === 'series' ? `series:${v.id}` : v.kind)

