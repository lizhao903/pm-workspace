// 视频列表（SPEC-videos-1、2）：全部视频按系列分组，有搜索或筛选时换成平铺表；待我处理、单集、某个系列都是平铺表。
// 阶段分布条按阶段筛；项目筛选可搜索；平铺表可按集数或更新排序。系列的详情页（共用部分、编排集数）是 VID-01d，这里先只列这个系列的集
import { useMemo, useState } from 'react'
import { errorText, projectView, useCreateVideo, type Video, type VideoSeries } from '../../core/data'
import { Button, IconSearch, PageTitle, SearchSelect, cls } from '../../core/ui'
import {
  PEEK, STAGES, filterVideos, groupBySeries, isFinished, isSingle, needsMe, newRoot, nextEpisode, peek, seriesLine, sortVideos, stageIndex,
  timeAgo, type Sort, type StageFilter,
} from './model'
import type { ListView } from './routes'
import { IconPlus, OrientTag, StageBar, StageDist, VideoStatePill, VideosTabs, type ModuleTab } from './parts'

export function ListPage({ view, videos, series, projects, onOpen, onView }: {
  view: ListView
  videos: Video[]
  series: VideoSeries[]
  projects: ReturnType<typeof projectView>[]
  onOpen: (id: string) => void
  onView: (v: ListView) => void
}) {
  const sr = view.kind === 'series' ? series.find((s) => s.id === view.id) : undefined
  const scope = view.kind === 'series' ? videos.filter((v) => v.series_id === view.id)
    : view.kind === 'single' ? videos.filter((v) => isSingle(v, series))
      : view.kind === 'review' ? videos.filter(needsMe)
        : videos
  const [stage, setStage] = useState<StageFilter>('')
  const [proj, setProj] = useState('')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<Sort>(view.kind === 'series' ? 'episode' : 'updated')
  const create = useCreateVideo()

  const projName = (id?: string) => (id ? projects.find((p) => p.id === id)?.name ?? '已删除的项目' : '')
  const filtered = !!(stage || proj || q.trim())
  const rows = sortVideos(filterVideos(scope, { stage, project: proj, q }), sort)
  const grouped = view.kind === 'all' && !filtered
  const groups = useMemo(() => groupBySeries(videos, series), [videos, series])
  const nextEp = view.kind === 'series' ? nextEpisode(videos, view.id) : 0

  const title = view.kind === 'series' ? sr?.name ?? '已删除的系列' : view.kind === 'single' ? '单集' : view.kind === 'review' ? '待我处理' : '全部视频'
  const desc = view.kind === 'series' ? sr?.desc || '多集共用开场、收尾和模板'
    : view.kind === 'review' ? '停在检查点上等你确认，或者被退回要改的'
      : view.kind === 'single' ? '不属于任何系列的视频' : '按系列分组；点系列看全部集数'
  const tab: ModuleTab = view.kind === 'review' ? 'review' : 'all'

  const newVideo = () => {
    if (create.isPending) return
    const inSeries = view.kind === 'series' && sr
    create.mutate({
      title: '新视频', orientations: ['landscape'], root: newRoot(videos), chapters: 3,
      ...(inSeries ? { series_id: sr.id, episode: nextEp } : {}),
    }, { onSuccess: (v) => onOpen(v.id) })
  }

  const row = (v: Video, showSeries: boolean) => {
    const pn = projName(v.project_id)
    const meta = showSeries || !!pn
    return (
      <button key={v.id} type="button" className={cls('vd-row', !meta && 'vd-row-1')} onClick={() => onOpen(v.id)}>
        <span className="vd-ep">{v.episode ? `${v.episode}` : '-'}</span>
        <span className="vd-main">
          <span className="vd-title"><span className="ellipsis">{v.title || '未命名视频'}</span>
            {sr?.stale.includes(v.id) && <span className="vd-stale-tag" title="系列的开场、收尾或模板改过，这集要重新录屏渲染">待同步</span>}
          </span>
          {meta ? (
            <span className="vd-meta">
              {showSeries && <span className="ellipsis">{seriesLine(v, series)}</span>}
              {pn && <span className="ellipsis vd-wide">{pn}</span>}
              <span className="vd-narrow-xs"><StageBar v={v} /></span>
            </span>
          ) : <span className="vd-meta vd-narrow-xs"><StageBar v={v} /></span>}
        </span>
        <span className="vd-orient-cell">
          {v.orientations.length ? v.orientations.map((o) => <OrientTag key={o} o={o} />) : <span className="faint">未定</span>}
        </span>
        <span className="vd-prog"><StageBar v={v} /><span className="vd-muted">{stageIndex(v.stage) + 1}/{STAGES.length}</span></span>
        <span><VideoStatePill v={v} /></span>
        <span className="vd-muted">{timeAgo(v.updated_at)}</span>
      </button>
    )
  }
  const head = (
    <div className="vd-row vd-th" aria-hidden="true"><span>集</span><span>视频</span><span>比例</span><span>进度</span><span>状态</span><span>更新</span></div>
  )

  let body
  if (grouped && groups.length) {
    body = (
      <div className="vd-groups">
        {groups.map((g) => {
          const open = () => onView(g.seriesId ? { kind: 'series', id: g.seriesId } : { kind: 'single' })
          const waiting = g.videos.filter(needsMe).length
          return (
            <section key={g.key} className="vd-group" aria-label={g.name}>
              <div className="vd-group-head">
                <button type="button" className="vd-group-name" onClick={open}>{g.name}</button>
                <span className="vd-muted">{g.videos.length} 集 · 已完成 {g.videos.filter(isFinished).length}{waiting ? ` · ${waiting} 集待处理` : ''}</span>
                <span className="vd-group-bar"><StageDist videos={g.videos} value="" onChange={open} compact /></span>
                <span className="spacer" />
                {g.videos.length > PEEK && <Button size="sm" onClick={open}>查看全部 {g.videos.length} 集</Button>}
              </div>
              <div className="vd-table">{peek(g.videos).map((v) => row(v, false))}</div>
            </section>
          )
        })}
      </div>
    )
  } else if (!rows.length) {
    const [t, d] = filtered ? ['没有匹配的视频', '换个筛选条件试试']
      : view.kind === 'review' ? ['没有等你处理的视频', '检查点都确认过了']
        : view.kind === 'series' ? ['这个系列还没有集', `新建第 ${nextEp} 集`]
          : ['还没有视频', '把一篇文章或口播稿做成网页演示，再录成视频']
    body = (
      <div className="empty">
        <div className="empty-title">{t}</div>
        <div className="empty-desc">{d}</div>
        {!filtered && view.kind !== 'review' && <Button variant="primary" onClick={newVideo} disabled={create.isPending}>新建视频</Button>}
      </div>
    )
  } else {
    body = <div className="vd-table">{head}{rows.map((v) => row(v, view.kind !== 'series'))}</div>
  }

  return (
    <div className="vd-page">
      <PageTitle parent={view.kind === 'series' ? '系列' : '视频'} count={scope.length} desc={desc} actions={
        <Button variant="primary" onClick={newVideo} disabled={create.isPending}><IconPlus />{view.kind === 'series' ? `新建第 ${nextEp} 集` : '新建视频'}</Button>
      }>{title}</PageTitle>
      <VideosTabs active={tab} videos={videos} onSelect={(t) => onView({ kind: t })} />
      {create.isError && <div className="vd-err" role="alert">视频没建成：{errorText(create.error)}</div>}

      {scope.length > 0 && view.kind !== 'review' && <StageDist videos={scope} value={stage} onChange={setStage} />}

      {scope.length > 0 && (
        <div className="vd-toolbar">
          <label className="search vd-search">
            <IconSearch />
            <input type="search" aria-label="搜索视频" placeholder={view.kind === 'series' ? '搜标题或集数' : '搜标题、目录'} value={q}
              onChange={(e) => setQ(e.target.value)} />
          </label>
          {view.kind !== 'series' && (
            <SearchSelect value={proj} onChange={setProj} noneLabel="全部项目" placeholder="全部项目" searchPlaceholder="搜项目" aria-label="按项目筛选"
              missingLabel={() => '已删除的项目'} options={[...projects.map((p) => ({ value: p.id, label: p.name })), { value: '-', label: '不属于项目' }]} />
          )}
          <span className="spacer" />
          {!grouped && (
            <div className="vd-sort" role="group" aria-label="排序">
              <button type="button" aria-pressed={sort === 'episode'} className={cls(sort === 'episode' && 'on')} onClick={() => setSort('episode')}>按集数</button>
              <button type="button" aria-pressed={sort === 'updated'} className={cls(sort === 'updated' && 'on')} onClick={() => setSort('updated')}>按更新</button>
            </div>
          )}
        </div>
      )}

      {body}
    </div>
  )
}
