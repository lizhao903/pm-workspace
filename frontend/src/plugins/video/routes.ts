// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 视频页的路由：子路径和列表视图互转。
// SPEC-videos-0.1：视频插件登记三个一级模块，同一个页面组件按挂在哪个模块下决定显示哪些标签：
//   做视频 /videos：全部视频（模块根）、/review 待我处理、/series 系列、/series/<id>、/single、/v/<id> 某一集
//   素材收集 /video_clips：素材收件箱（模块根）、/topics 选题
//   发布与数据 /video_publish：发布记录（模块根）、/calendar 日历、/bilibili B 站数据
// 原来都在 /videos 下：/videos/clips、/videos/topics、/videos/publishes、/videos/calendar、/videos/bilibili 重定向到新位置，查询串照带，书签不失效。
import type { DetailTab } from './Detail'

export type VideoModule = 'videos' | 'video_clips' | 'video_publish'
export const VIDEO_MODULES: readonly VideoModule[] = ['videos', 'video_clips', 'video_publish']
/** 模块名，也是页面标题的上级（SPEC-videos-0.3） */
export const VIDEO_MODULE_LABEL: Record<VideoModule, string> = { videos: '做视频', video_clips: '素材收集', video_publish: '发布与数据' }

/** 模块标签栏的标签 */
export type ModuleTab = 'all' | 'review' | 'calendar' | 'topics' | 'clips' | 'series' | 'publishes' | 'bilibili'

/** 每个标签在哪个模块、模块里的子路径；模块里的首个标签就是模块根（从菜单点进来落在它上面） */
const TAB_AT: Record<ModuleTab, readonly [VideoModule, string]> = {
  all: ['videos', ''], review: ['videos', '/review'], series: ['videos', '/series'],
  clips: ['video_clips', ''], topics: ['video_clips', '/topics'],
  publishes: ['video_publish', ''], calendar: ['video_publish', '/calendar'], bilibili: ['video_publish', '/bilibili'],
}

/** 标签归哪个模块（同原型 videoModuleOf） */
export const tabModule = (t: ModuleTab): VideoModule => TAB_AT[t][0]

/** 标签的地址 */
export const tabHref = (t: ModuleTab) => `/${TAB_AT[t][0]}${TAB_AT[t][1]}`

/** 模块挂的路径就是模块 id；不认识的算做视频 */
export function moduleOfRoot(root: string): VideoModule {
  const last = root.split('/').filter(Boolean).pop() ?? ''
  return (VIDEO_MODULES as readonly string[]).includes(last) ? (last as VideoModule) : 'videos'
}

// 原来 /videos 下、现在搬到别的模块的子页面
const MOVED: Record<string, ModuleTab> = { clips: 'clips', topics: 'topics', publishes: 'publishes', calendar: 'calendar', bilibili: 'bilibili' }

/**
 * 视频页内部按原来 /videos 下的子路径写跳转（'/topics?t=…'、'/v/<id>'、''），这里换成新地址：
 * 搬走的子页面落到它所在的模块，其余留在做视频
 */
export function videoHref(to: string): string {
  const q = to.search(/[?#]/)
  const path = q < 0 ? to : to.slice(0, q)
  const tail = q < 0 ? '' : to.slice(q)
  const seg = path.split('/').filter(Boolean)
  if (seg.length === 1 && MOVED[seg[0]]) return tabHref(MOVED[seg[0]]) + tail
  return `/videos${path}${tail}`
}

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

/** 旧地址：换到新位置（to 不带查询串，跳转时照带原来的） */
type Moved = { kind: 'moved'; to: string }

type Route = { kind: 'list'; view: ListView } | SeriesList | TopicPages | PublishPage | CalendarPage | BiliPage | Moved
  | { kind: 'video'; id: string; tab: DetailTab } | { kind: 'bad' }

/** rest 是模块路径后面的部分；mod 是挂在哪个模块下 */
export function routeOf(rest: string, mod: VideoModule = 'videos'): Route {
  const seg = rest.split('/').filter(Boolean).map(decodeURIComponent)
  if (mod === 'video_clips') {
    if (!seg.length) return { kind: 'clips' }
    if (seg.length === 1 && seg[0] === 'topics') return { kind: 'topics' }
    return { kind: 'bad' }
  }
  if (mod === 'video_publish') {
    if (!seg.length) return { kind: 'publishes' }
    if (seg.length === 1 && (seg[0] === 'calendar' || seg[0] === 'bilibili')) return { kind: seg[0] }
    return { kind: 'bad' }
  }
  if (!seg.length) return { kind: 'list', view: { kind: 'all' } }
  if (seg.length === 1 && MOVED[seg[0]]) return { kind: 'moved', to: tabHref(MOVED[seg[0]]) }
  if (seg.length === 1 && (seg[0] === 'review' || seg[0] === 'single')) return { kind: 'list', view: { kind: seg[0] } }
  if (seg.length === 1 && seg[0] === 'series') return { kind: 'series-list' }
  if (seg.length === 2 && seg[0] === 'series') return { kind: 'list', view: { kind: 'series', id: seg[1] } }
  if (seg[0] === 'v' && seg.length === 2) return { kind: 'video', id: seg[1], tab: 'flow' }
  if (seg[0] === 'v' && seg.length === 3 && (seg[2] === 'settings' || seg[2] === 'artifacts')) return { kind: 'video', id: seg[1], tab: seg[2] }
  return { kind: 'bad' }
}

export const viewPath = (v: ListView) => (v.kind === 'all' ? '' : v.kind === 'series' ? `/series/${encodeURIComponent(v.id)}` : `/${v.kind}`)
/** 详情标签的子路径 */
export const tabPath = (t: DetailTab) => (t === 'flow' ? '' : `/${t}`)

export const viewKey = (v: ListView) => (v.kind === 'series' ? `series:${v.id}` : v.kind)
