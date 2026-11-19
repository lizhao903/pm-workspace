// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 视频插件的页面（VID-01c，SPEC-videos-1、2、10、13）：没有二级菜单，顶栏下面一排标签（全部视频、待我处理）。
// 路由挂在 videos/* 下：/videos 全部视频，/videos/review 待我处理，/videos/single 单集，/videos/series/<id> 某个系列的集，
// /videos/v/<id> 视频详情的制作流程，/videos/v/<id>/settings 设置。打开详情时把来处的标签记在 location.state，标签栏高亮它。
// VID-01d 加了 /videos/series 系列列表、/videos/v/<id>/artifacts 产出物（?a=<产出物 id> 打开抽屉）；从系列来的详情高亮「系列」。
// VID-02b：制作流程里也列产出物，同样用 ?a= 打开抽屉。
// VID-08c 加了 /videos/topics 选题（?t=<选题 id> 打开抽屉）、/videos/clips 素材收件箱。
// VID-05c 加了 /videos/publishes 发布记录（?video= 只看一集，?p= 发布抽屉，?t= 封面测试抽屉）
// VID-06d 加了 /videos/calendar 内容日历（?m=week 周视图，?d= 看的那天，?p= 发布抽屉）
// TSK-0455 加了 /videos/bilibili B 站组件（?c= 连接器，?v=dm 私信，?t= 对方 UID）
// SPEC-videos-0.1 拆成三个一级模块，三个模块都挂这一个页面，按挂在哪个模块下（路径）决定显示哪些页面和标签，地址见 routes.ts：
// 素材收件箱、选题搬到 /video_clips，发布记录、日历、B 站数据搬到 /video_publish，原来的地址重定向过去；数据和查询缓存三个模块共用。
// 跳到别的模块的页面时地址换到那个模块下，一级菜单跟着切：从发布记录、日历、选题打开某一集落到做视频，某一集里点「发布记录」落到发布与数据。
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { ErrorState, LoadingState, PageTitle } from '../../core/ui'
import { errorText, isApiError, projectView, useProjects, useVideo, useVideoClips, useVideoSeries, useVideoTopics, useVideos } from '../../core/data'
import { BiliPage } from './BiliPage'
import { CalendarPage } from './CalendarPage'
import { ClipsPage } from './ClipsPage'
import { Detail } from './Detail'
import { ListPage } from './ListPage'
import type { ModuleTab } from './parts'
import { moduleOfRoot, routeOf, tabHref, tabModule, tabPath, videoHref, viewKey, viewPath, VIDEO_MODULE_LABEL, type ListView } from './routes'
import { PublishPage } from './PublishPage'
import { SeriesPage } from './SeriesPage'
import { TopicsPage } from './TopicsPage'
import './video.css'

type BackState = { from?: ModuleTab }

export default function Page() {
  const rest = useParams()['*'] ?? ''
  const { pathname, search: query, state } = useLocation()
  const navigate = useNavigate()
  const [search, setSearch] = useSearchParams()
  const root = pathname.slice(0, pathname.length - rest.length).replace(/\/+$/, '')
  const mod = moduleOfRoot(root)
  const parent = VIDEO_MODULE_LABEL[mod]
  const route = routeOf(rest, mod)
  const videos = useVideos()
  const series = useVideoSeries()
  const projects = useProjects()
  const video = useVideo(route.kind === 'video' ? route.id : null)
  const topics = useVideoTopics()
  const clips = useVideoClips()

  if (route.kind === 'bad') return <Navigate to={root} replace />
  // 旧地址（原来 /videos 下的素材、选题、发布记录、日历、B 站）换到新模块，查询串照带
  if (route.kind === 'moved') return <Navigate to={route.to + query} replace state={state} />
  // 今日「视频发布失败」「视频待发布」给的是 /videos/v/<id>?p=<发布 id>：打开发布与数据里这条发布记录的抽屉
  const pub = route.kind === 'video' ? search.get('p') : null
  if (route.kind === 'video' && pub) return <Navigate to={`${tabHref('publishes')}?${new URLSearchParams({ video: route.id, p: pub })}`} replace />

  // 某一集属于做视频：从别的模块（发布记录、日历、选题）点进来的，标签栏高亮「全部视频」
  const back = (state as BackState | null)?.from
  const from: ModuleTab = back && tabModule(back) === 'videos' ? back : 'all'
  const go = (to: string, st?: BackState, replace?: boolean) => navigate(videoHref(to), { state: st, replace })
  const onView = (v: ListView) => go(viewPath(v))
  const openVideo = (id: string, tab: ModuleTab) => go(`/v/${encodeURIComponent(id)}`, { from: tab })
  const openSeries = (id: string) => onView({ kind: 'series', id })
  const onModuleTab = (t: ModuleTab) => navigate(tabHref(t))

  const list = videos.data ?? []
  const seriesList = series.data ?? []
  const projectList = (projects.data?.data ?? []).map(projectView)

  if (videos.isPending || series.isPending) return <section><PageTitle>{parent}</PageTitle><LoadingState /></section>
  if (videos.isError || series.isError) {
    return (
      <section>
        <PageTitle>{parent}</PageTitle>
        <ErrorState title="视频没加载出来" error={errorText(videos.error ?? series.error)}
          onRetry={() => { void videos.refetch(); void series.refetch() }} />
      </section>
    )
  }

  if (route.kind === 'series-list') {
    return <SeriesPage series={seriesList} videos={list} onOpenSeries={openSeries} onModuleTab={onModuleTab} />
  }

  if (route.kind === 'calendar') {
    return <CalendarPage videos={list} onModuleTab={onModuleTab} onOpenVideo={(id) => openVideo(id, 'calendar')}
      onOpenTest={(id) => go(`/publishes?t=${encodeURIComponent(id)}`)} />
  }

  if (route.kind === 'bilibili') return <BiliPage videos={list} onModuleTab={onModuleTab} />

  if (route.kind === 'publishes') {
    return <PublishPage videos={list} onModuleTab={onModuleTab} onOpenVideo={(id) => openVideo(id, 'publishes')} />
  }

  if (route.kind === 'topics' || route.kind === 'clips') {
    const label = route.kind === 'topics' ? '选题' : '素材收件箱'
    if (topics.isPending || clips.isPending) return <section><PageTitle parent={parent}>{label}</PageTitle><LoadingState /></section>
    if (topics.isError || clips.isError) {
      return (
        <section>
          <PageTitle parent={parent}>{label}</PageTitle>
          <ErrorState title={`${label}没加载出来`} error={errorText(topics.error ?? clips.error)}
            onRetry={() => { void topics.refetch(); void clips.refetch() }} />
        </section>
      )
    }
    if (route.kind === 'topics') {
      return <TopicsPage topics={topics.data} clips={clips.data} series={seriesList} videos={list} onModuleTab={onModuleTab}
        onOpenVideo={(id) => openVideo(id, 'topics')} />
    }
    return <ClipsPage clips={clips.data} topics={topics.data} videos={list} onModuleTab={onModuleTab}
      onOpenTopic={(id) => go(`/topics?t=${encodeURIComponent(id)}`)} />
  }

  if (route.kind === 'list') {
    const tab: ModuleTab = route.view.kind === 'review' ? 'review' : route.view.kind === 'series' ? 'series' : 'all'
    return (
      <ListPage key={viewKey(route.view)} view={route.view} videos={list} series={seriesList} projects={projectList}
        onOpen={(id) => openVideo(id, tab)} onView={onView} onModuleTab={onModuleTab} />
    )
  }

  // 列表里有就先用列表的，单个视频取回来再换上
  const gone = isApiError(video.error, 'not_found')
  const v = gone ? undefined : video.data ?? list.find((x) => x.id === route.id)
  if (!v) {
    if (video.isPending) return <section><PageTitle parent={parent}>视频</PageTitle><LoadingState /></section>
    return (
      <section>
        <PageTitle parent={parent}>{gone ? '视频不存在' : '视频'}</PageTitle>
        {gone
          ? <div className="empty"><div className="empty-title">这个视频已经删除</div><div className="empty-desc">切到别的标签看看</div></div>
          : <ErrorState title="视频没加载出来" error={errorText(video.error)} onRetry={() => void video.refetch()} />}
        <div className="vd-back"><button type="button" className="vd-link" onClick={() => go('')}>回到全部视频</button></div>
      </section>
    )
  }
  return (
    <Detail key={v.id} video={v} videos={list} series={seriesList} projects={projectList} tab={route.tab} from={from}
      onTab={(t) => go(`/v/${encodeURIComponent(v.id)}${tabPath(t)}`, { from }, true)}
      openArt={route.tab !== 'settings' ? search.get('a') : null}
      onOpenArt={(id) => setSearch(id ? { a: id } : {}, { replace: true, state: { from } })}
      onModuleTab={onModuleTab} onOpenSeries={openSeries} onOpenPublishes={(id) => go(`/publishes?video=${encodeURIComponent(id)}`)}
      onDeleted={() => go('', undefined, true)} />
  )
}
