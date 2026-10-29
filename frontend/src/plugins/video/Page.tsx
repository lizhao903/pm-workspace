// 视频插件的页面（VID-01c，SPEC-videos-1、2、10、13）：没有二级菜单，顶栏下面一排标签（全部视频、待我处理）。
// 路由挂在 videos/* 下：/videos 全部视频，/videos/review 待我处理，/videos/single 单集，/videos/series/<id> 某个系列的集，
// /videos/v/<id> 视频详情的制作流程，/videos/v/<id>/settings 设置。打开详情时把来处的标签记在 location.state，标签栏高亮它。
// VID-01d 加了 /videos/series 系列列表、/videos/v/<id>/artifacts 产出物（?a=<产出物 id> 打开抽屉）；从系列来的详情高亮「系列」。
// 选题、素材收件箱、发布记录是后面的任务，到时再加标签
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { ErrorState, LoadingState, PageTitle } from '../../core/ui'
import { errorText, isApiError, projectView, useProjects, useVideo, useVideoSeries, useVideos } from '../../core/data'
import { Detail } from './Detail'
import { ListPage } from './ListPage'
import type { ModuleTab } from './parts'
import { routeOf, tabPath, viewKey, viewPath, type ListView } from './routes'
import { SeriesPage } from './SeriesPage'
import './video.css'

type BackState = { from?: ModuleTab }

export default function Page() {
  const rest = useParams()['*'] ?? ''
  const { pathname, state } = useLocation()
  const navigate = useNavigate()
  const [search, setSearch] = useSearchParams()
  const root = pathname.slice(0, pathname.length - rest.length).replace(/\/+$/, '')
  const route = routeOf(rest)
  const videos = useVideos()
  const series = useVideoSeries()
  const projects = useProjects()
  const video = useVideo(route.kind === 'video' ? route.id : null)

  if (route.kind === 'bad') return <Navigate to={root} replace />

  const from: ModuleTab = (state as BackState | null)?.from ?? 'all'
  const go = (to: string, st?: BackState, replace?: boolean) => navigate(`${root}${to}`, { state: st, replace })
  const onView = (v: ListView) => go(viewPath(v))
  const openVideo = (id: string, tab: ModuleTab) => go(`/v/${encodeURIComponent(id)}`, { from: tab })
  const openSeries = (id: string) => onView({ kind: 'series', id })
  const onModuleTab = (t: ModuleTab) => (t === 'series' ? go('/series') : onView({ kind: t }))

  const list = videos.data ?? []
  const seriesList = series.data ?? []
  const projectList = (projects.data?.data ?? []).map(projectView)

  if (videos.isPending || series.isPending) return <section><PageTitle>视频</PageTitle><LoadingState /></section>
  if (videos.isError || series.isError) {
    return (
      <section>
        <PageTitle>视频</PageTitle>
        <ErrorState title="视频没加载出来" error={errorText(videos.error ?? series.error)}
          onRetry={() => { void videos.refetch(); void series.refetch() }} />
      </section>
    )
  }

  if (route.kind === 'series-list') {
    return <SeriesPage series={seriesList} videos={list} onOpenSeries={openSeries} onModuleTab={onModuleTab} />
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
    if (video.isPending) return <section><PageTitle parent="视频">视频</PageTitle><LoadingState /></section>
    return (
      <section>
        <PageTitle parent="视频">{gone ? '视频不存在' : '视频'}</PageTitle>
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
      openArt={route.tab === 'artifacts' ? search.get('a') : null}
      onOpenArt={(id) => setSearch(id ? { a: id } : {}, { replace: true, state: { from } })}
      onModuleTab={onModuleTab} onOpenSeries={openSeries} onDeleted={() => go('', undefined, true)} />
  )
}
