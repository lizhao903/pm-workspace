// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 视频列表（SPEC-videos-1、2）：全部视频按系列分组，有搜索或筛选时换成平铺表；待我处理、单集、某个系列都是平铺表。
// 阶段分布条按阶段筛；项目筛选可搜索；平铺表可按集数或更新排序。
// 系列详情（SPEC-videos-6，VID-01d）：共用部分、待同步的集、加入已有视频、编排集数（失焦或回车才改，重复的标红）、系列设置
import { useMemo, useState, type ReactNode } from 'react'
import { errorText, projectView, useCreateVideo, usePatchSeries, usePatchVideo, type Video, type VideoSeries } from '../../core/data'
import { Button, IconSearch, PageTitle, SearchSelect, cls } from '../../core/ui'
import { dupEpisodes } from './artifactModel'
import { SeriesSettingsDrawer } from './SeriesSettingsDrawer'
import {
  PEEK, STAGES, filterVideos, groupBySeries, isFinished, isSingle, needsMe, newRoot, nextEpisode, peek, seriesLine, sortVideos, stageIndex,
  timeAgo, videoState, type Sort, type StageFilter,
} from './model'
import type { ListView } from './routes'
import { IconPlus, OrientTag, StageBar, StageDist, VideoStatePill, VideosTabs, type ModuleTab } from './parts'

export function ListPage({ view, videos, series, projects, onOpen, onView, onModuleTab }: {
  view: ListView
  videos: Video[]
  series: VideoSeries[]
  projects: ReturnType<typeof projectView>[]
  onOpen: (id: string) => void
  onView: (v: ListView) => void
  onModuleTab: (t: ModuleTab) => void
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
  const patchVideo = usePatchVideo()
  const patchSeries = usePatchSeries()
  const [editing, setEditing] = useState(false)
  const [settings, setSettings] = useState(false)

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
  const tab: ModuleTab = view.kind === 'review' ? 'review' : view.kind === 'series' ? 'series' : 'all'
  const stale = new Set(sr?.stale ?? [])
  const staleEps = sortVideos(scope.filter((v) => stale.has(v.id)), 'episode')
  const edit = !!sr && editing
  const dup = edit ? dupEpisodes(scope) : new Set<number>()
  const freeOptions = useMemo(() => sortVideos(videos.filter((v) => isSingle(v, series)), 'updated')
    .map((v) => ({ value: v.id, label: v.title || '未命名视频', hint: videoState(v).label, keywords: v.root })), [videos, series])
  const writeErr = patchVideo.error ?? patchSeries.error

  const unsync = (ids: string[]) => {
    if (!sr) return
    patchVideo.reset()
    patchSeries.mutate({ id: sr.id, patch: { stale: sr.stale.filter((x) => !ids.includes(x)) } })
  }
  const setVideo = (id: string, p: Parameters<typeof patchVideo.mutate>[0]['patch']) => {
    patchSeries.reset()
    patchVideo.mutate({ id, patch: p })
  }
  const addEpisode = (id: string) => { if (sr && id) setVideo(id, { series_id: sr.id, episode: nextEp }) }
  // 移出：后端换系列时把待同步一起清掉
  const removeEpisode = (id: string) => setVideo(id, { series_id: null, episode: null })
  const setEpisode = (v: Video, raw: string) => {
    const n = Math.floor(Number(raw))
    if (raw.trim() && n >= 1 && n <= 9999 && n !== v.episode) setVideo(v.id, { episode: n })
  }

  const newVideo = () => {
    if (create.isPending) return
    const inSeries = view.kind === 'series' && sr
    create.mutate({
      title: inSeries ? `第 ${nextEp} 集：` : '新视频', orientations: ['landscape'], root: newRoot(videos), chapters: 3,
      ...(inSeries ? { series_id: sr.id, episode: nextEp } : {}),
    }, { onSuccess: (v) => onOpen(v.id) })
  }

  const row = (v: Video, showSeries: boolean) => {
    const pn = projName(v.project_id)
    const meta = showSeries || !!pn
    return (
      <Row key={v.id} edit={edit} className={cls('vd-row', !meta && 'vd-row-1', edit && 'vd-row-edit')} onClick={() => onOpen(v.id)}>
        {edit ? (
          <span className="vd-ep">
            {/* 失焦或回车才改，免得边输边重新排序 */}
            <input key={v.episode ?? ''} className={cls('vd-ep-input', v.episode !== undefined && dup.has(v.episode) && 'bad')} type="number" min={1}
              defaultValue={v.episode ?? ''} aria-label={`${v.title || '未命名视频'} 的集数`}
              onBlur={(e) => setEpisode(v, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
          </span>
        ) : <span className="vd-ep">{v.episode ? `${v.episode}` : '-'}</span>}
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
        {edit
          ? <span><Button size="sm" variant="danger-ghost" disabled={patchVideo.isPending} onClick={() => removeEpisode(v.id)}>移出</Button></span>
          : <span className="vd-muted">{timeAgo(v.updated_at)}</span>}
      </Row>
    )
  }
  const head = (
    <div className={cls('vd-row vd-th', edit && 'vd-row-edit')} aria-hidden="true">
      <span>集</span><span>视频</span><span>比例</span><span>进度</span><span>状态</span><span>{edit ? '' : '更新'}</span>
    </div>
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
        : view.kind === 'series' ? ['这个系列还没有集', `新建第 ${nextEp} 集，或者用「加入已有视频」把单集归进来`]
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
      <PageTitle parent={view.kind === 'series' ? <button type="button" className="vd-crumb" onClick={() => onModuleTab('series')}>系列</button> : '视频'}
        count={scope.length} desc={desc} actions={(
          <>
            {sr && <Button variant="outline" onClick={() => setSettings(true)}>系列设置</Button>}
            <Button variant="primary" onClick={newVideo} disabled={create.isPending}><IconPlus />{view.kind === 'series' ? `新建第 ${nextEp} 集` : '新建视频'}</Button>
          </>
        )}>{title}</PageTitle>
      <VideosTabs active={tab} videos={videos} onSelect={onModuleTab} />
      {create.isError && <div className="vd-err" role="alert">视频没建成：{errorText(create.error)}</div>}
      {writeErr && <div className="vd-err" role="alert">没改成：{errorText(writeErr)}</div>}

      {sr && (
        <section className="vd-sr-top" aria-label="共用部分">
          <div className="vd-sr-shared">
            {([['开场', sr.intro], ['收尾', sr.outro], ['模板', sr.template]] as const).map(([k, x]) => (
              <span key={k}><span className="vd-muted">{k}</span><span className={cls('ellipsis vd-mono', !x && 'vd-faint')}>{x || '未设置'}</span></span>
            ))}
            <button type="button" className="vd-link" onClick={() => setSettings(true)}>修改</button>
          </div>
          {staleEps.length > 0 && (
            <div className="vd-sr-stale" aria-label="待同步">
              <div className="vd-sr-stale-head">
                <span className="vd-stale-tag">{staleEps.length} 集待同步</span>
                <span className="vd-muted">共用部分改过，这几集要重新录屏渲染</span>
                <span className="spacer" />
                {staleEps.length > 1 && (
                  <Button size="sm" disabled={patchSeries.isPending} onClick={() => unsync(staleEps.map((v) => v.id))}>全部标记已同步</Button>
                )}
              </div>
              {staleEps.map((v) => (
                <div key={v.id} className="vd-sr-stale-row">
                  <span className="vd-ep">{v.episode ?? '-'}</span>
                  <span className="ellipsis vd-sr-stale-title">{v.title || '未命名视频'}</span>
                  <VideoStatePill v={v} />
                  <span className="vd-sr-stale-acts">
                    <Button size="sm" disabled={patchSeries.isPending} onClick={() => unsync([v.id])}>标记已同步</Button>
                    <Button size="sm" onClick={() => onOpen(v.id)}>去这一集</Button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {scope.length > 0 && view.kind !== 'review' && <StageDist videos={scope} value={stage} onChange={setStage} />}

      {(scope.length > 0 || !!sr) && (
        <div className="vd-toolbar">
          {scope.length > 0 && (
            <label className="search vd-search">
              <IconSearch />
              <input type="search" aria-label="搜索视频" placeholder={view.kind === 'series' ? '搜标题或集数' : '搜标题、目录'} value={q}
                onChange={(e) => setQ(e.target.value)} />
            </label>
          )}
          {view.kind !== 'series' && (
            <SearchSelect value={proj} onChange={setProj} noneLabel="全部项目" placeholder="全部项目" searchPlaceholder="搜项目" aria-label="按项目筛选"
              missingLabel={() => '已删除的项目'} options={[...projects.map((p) => ({ value: p.id, label: p.name })), { value: '-', label: '不属于项目' }]} />
          )}
          <span className="spacer" />
          {sr && (
            <SearchSelect value="" placeholder="加入已有视频" searchPlaceholder="搜标题或目录" align="end" aria-label="加入已有视频"
              disabled={!freeOptions.length || patchVideo.isPending}
              title={freeOptions.length ? `从 ${freeOptions.length} 个未归入系列的视频里选，排在第 ${nextEp} 集` : '没有未归入系列的视频'}
              options={freeOptions} emptyText="没有未归入系列的视频" onChange={addEpisode} />
          )}
          {sr && scope.length > 0 && (
            <button type="button" aria-pressed={edit} className={cls('chip', edit && 'chip-on')}
              onClick={() => { if (!edit) setSort('episode'); setEditing(!edit) }}>{edit ? '完成编排' : '编排集数'}</button>
          )}
          {!grouped && !edit && scope.length > 0 && (
            <div className="vd-sort" role="group" aria-label="排序">
              <button type="button" aria-pressed={sort === 'episode'} className={cls(sort === 'episode' && 'on')} onClick={() => setSort('episode')}>按集数</button>
              <button type="button" aria-pressed={sort === 'updated'} className={cls(sort === 'updated' && 'on')} onClick={() => setSort('updated')}>按更新</button>
            </div>
          )}
        </div>
      )}

      {edit && dup.size > 0 && <div className="vd-err" role="alert">有几集集数重复了，改一下</div>}

      {body}

      {sr && settings && (
        <SeriesSettingsDrawer key={sr.id} series={sr} videos={videos} onClose={() => setSettings(false)} onDeleted={() => onModuleTab('series')} />
      )}
    </div>
  )
}

/** 表格的一行：平时整行是按钮，编排时里面有输入框和「移出」，换成 div */
function Row({ edit, className, onClick, children }: { edit: boolean; className: string; onClick: () => void; children: ReactNode }) {
  if (edit) return <div className={className}>{children}</div>
  return <button type="button" className={className} onClick={onClick}>{children}</button>
}
