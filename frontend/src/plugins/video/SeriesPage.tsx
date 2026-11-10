// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 系列列表（SPEC-videos-5）：一个系列一张卡片，只看整体进度；点卡片进系列详情（/videos/series/<id>）。
// 右上「新建系列」开系列设置抽屉，建好打开它的详情
import { useState } from 'react'
import type { Video, VideoSeries } from '../../core/data'
import { Button, PageTitle, cls } from '../../core/ui'
import { episodesOf } from './artifactModel'
import { isFinished, needsMe } from './model'
import { IconPlus, StageDist, VideosTabs, type ModuleTab } from './parts'
import { SeriesSettingsDrawer } from './SeriesSettingsDrawer'

export function SeriesPage({ series, videos, onOpenSeries, onModuleTab }: {
  series: VideoSeries[]
  videos: Video[]
  onOpenSeries: (id: string) => void
  onModuleTab: (t: ModuleTab) => void
}) {
  const [creating, setCreating] = useState(false)
  const staleTotal = series.reduce((n, s) => n + episodesOf(s, videos).filter((v) => s.stale.includes(v.id)).length, 0)

  return (
    <div className="vd-page">
      <PageTitle parent="视频" count={series.length} desc="多集共用开场、收尾和模板；点系列看各集、改共用部分"
        actions={<Button variant="primary" onClick={() => setCreating(true)}><IconPlus />新建系列</Button>}>系列</PageTitle>
      <VideosTabs active="series" videos={videos} onSelect={onModuleTab} />
      {staleTotal > 0 && <div className="vd-banner" role="status">有 {staleTotal} 集改过共用部分还没同步，需要重新录屏渲染</div>}
      {!series.length ? (
        <div className="empty">
          <div className="empty-title">还没有系列</div>
          <div className="empty-desc">把同一主题的几集归成一个系列，共用开场、收尾和模板，批量改版时能看出影响哪几集</div>
          <Button variant="primary" onClick={() => setCreating(true)}>新建系列</Button>
        </div>
      ) : (
        <div className="vd-series-grid">
          {series.map((s) => {
            const eps = episodesOf(s, videos)
            const stale = eps.filter((v) => s.stale.includes(v.id)).length
            const wait = eps.filter(needsMe).length
            return (
              <div key={s.id} role="button" tabIndex={0} className="vd-series" aria-label={s.name} onClick={() => onOpenSeries(s.id)}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpenSeries(s.id) } }}>
                <div className="vd-series-head">
                  <span className="vd-series-name ellipsis">{s.name}</span>
                  <span className="vd-otag">{eps.length} 集</span>
                </div>
                <div className={cls('vd-series-desc', !s.desc && 'vd-faint')}>{s.desc || '还没写说明'}</div>
                {eps.length ? (
                  <div className="vd-series-prog">
                    <div className="vd-series-stats">
                      <span>已完成 <b>{eps.filter(isFinished).length}</b> / {eps.length} 集</span>
                      {wait > 0 && <span className="vd-warn-text">{wait} 集待处理</span>}
                      {stale > 0 && <span className="vd-stale-tag">{stale} 集待同步</span>}
                    </div>
                    {/* 分布条只看不筛，点哪都进详情 */}
                    <StageDist videos={eps} value="" onChange={() => onOpenSeries(s.id)} still />
                  </div>
                ) : <div className="vd-col-empty">还没有归入的集，点开系列新建一集或把视频加进来</div>}
              </div>
            )
          })}
        </div>
      )}
      {creating && (
        <SeriesSettingsDrawer series={null} videos={videos} onClose={() => setCreating(false)} onCreated={(s) => onOpenSeries(s.id)} />
      )}
    </div>
  )
}
