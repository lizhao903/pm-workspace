// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 选题库（VID-08c，照原型 web-next/src/topics.tsx 的 TopicsPage）：看板按状态分列，表格按优先级排；按方向（标签第一项）、系列筛，搜标题、角度、标签。
// 抽屉用 ?t=<选题 id> 打开，刷新还在；看板 / 表格、方向、状态也记在地址上（view、dir、st）
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { errorText, useCreateTopic, type Video, type VideoClip, type VideoSeries, type VideoTopic, type VideoTopicStatus } from '../../core/data'
import { Button, IconSearch, PageTitle, SearchSelect, cls } from '../../core/ui'
import { timeAgo } from './model'
import { IconPlus, VideosTabs, type ModuleTab } from './parts'
import { PriorityBadge, StatusPill } from './topicParts'
import { TopicDrawer } from './TopicDrawer'
import { TOPIC_FLOW, TOPIC_STATUS, directionOf, directions, filterTopics } from './topicModel'
import './topics.css'

/** 看板每列先露几张，表格一次渲染多少条 */
const COL_PEEK = 8
const PAGE = 50

export function TopicsPage({ topics, clips, series, videos, onModuleTab, onOpenVideo }: {
  topics: VideoTopic[]
  clips: VideoClip[]
  series: VideoSeries[]
  videos: Video[]
  onModuleTab: (t: ModuleTab) => void
  onOpenVideo: (id: string) => void
}) {
  const [search, setSearch] = useSearchParams()
  const view = search.get('view') === 'table' ? 'table' : 'board'
  const dir = search.get('dir') ?? ''
  const stRaw = search.get('st') ?? ''
  const st = (TOPIC_FLOW as string[]).includes(stRaw) ? stRaw as VideoTopicStatus : ''
  const open = search.get('t')
  const [q, setQ] = useState('')
  const [sr, setSr] = useState('')
  const [showDropped, setShowDropped] = useState(false)
  const [openCols, setOpenCols] = useState<VideoTopicStatus[]>([])
  const [limit, setLimit] = useState(PAGE)
  const create = useCreateTopic()

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(search)
    if (v) next.set(k, v); else next.delete(k)
    setSearch(next, { replace: k !== 't' })
    setLimit(PAGE)
  }
  const dirs = useMemo(() => directions(topics), [topics])
  const rows = filterTopics(topics, { q, dir, series: sr, status: view === 'table' ? st : '' })
  const cols = TOPIC_FLOW.filter((s) => s !== 'dropped' || showDropped)
  const seriesName = (id?: string) => (id ? series.find((s) => s.id === id)?.name ?? '已删除的系列' : '')
  const cur = open ? topics.find((t) => t.id === open) : undefined

  const newTopic = () => {
    if (create.isPending) return
    create.mutate({}, { onSuccess: (t) => setParam('t', t.id) })
  }

  const card = (t: VideoTopic) => (
    <button key={t.id} type="button" className="tp-card" onClick={() => setParam('t', t.id)}>
      <span className="tp-card-top"><b className="tp-card-title">{t.title || '未命名选题'}</b><PriorityBadge score={t.score} /></span>
      {t.angle && <span className="tp-card-angle">{t.angle}</span>}
      <span className="tp-card-meta">
        {directionOf(t) && <span className="tag">{directionOf(t)}</span>}
        {t.series_id && <span className="tag">{seriesName(t.series_id)}</span>}
        {t.clip_ids.length > 0 && <span className="tp-muted">{t.clip_ids.length} 条素材</span>}
        {t.planned_at && <span className="tp-muted">{new Date(t.planned_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} 开做</span>}
        {t.video_id && <span className="tp-muted">已立项</span>}
      </span>
    </button>
  )

  let body
  if (!topics.length) {
    body = (
      <div className="empty">
        <div className="empty-title">还没有选题</div>
        <div className="empty-desc">先去素材收件箱收点东西，或者直接新建一个</div>
        <Button variant="primary" onClick={newTopic} disabled={create.isPending}>新建选题</Button>
      </div>
    )
  } else if (view === 'board') {
    body = (
      <div className="tp-board">
        {cols.map((s) => {
          const xs = rows.filter((t) => t.status === s)
          // 每列按优先级露前几张；已做成、已放弃的往往最多，也最不用看
          const all = openCols.includes(s)
          return (
            <section key={s} className="tp-col" aria-label={TOPIC_STATUS[s].label}>
              <div className="tp-col-head"><StatusPill s={s} /><span className="tp-muted">{xs.length}</span></div>
              <div className="tp-col-body">
                {(all ? xs : xs.slice(0, COL_PEEK)).map(card)}
                {!xs.length && <div className="tp-col-empty">{TOPIC_STATUS[s].desc}</div>}
                {xs.length > COL_PEEK && (
                  <button type="button" className="tp-col-more" onClick={() => setOpenCols(all ? openCols.filter((x) => x !== s) : [...openCols, s])}>
                    {all ? '收起' : `还有 ${xs.length - COL_PEEK} 个`}
                  </button>
                )}
              </div>
            </section>
          )
        })}
      </div>
    )
  } else {
    body = (
      <div className="tp-table">
        <div className="tp-row tp-th" aria-hidden="true"><span>优先级</span><span>选题</span><span>方向</span><span>系列</span><span>素材</span><span>状态</span><span>更新</span></div>
        {rows.slice(0, limit).map((t) => (
          <button key={t.id} type="button" className="tp-row" onClick={() => setParam('t', t.id)}>
            <span><PriorityBadge score={t.score} /></span>
            <span className="tp-row-main">
              <span className="tp-row-title ellipsis">{t.title || '未命名选题'}</span>
              {t.angle && <span className="tp-row-sub ellipsis">{t.angle}</span>}
            </span>
            <span className="ellipsis tp-muted">{directionOf(t) || '-'}</span>
            <span className="ellipsis tp-muted">{seriesName(t.series_id) || '-'}</span>
            <span className="tp-muted">{t.clip_ids.length}</span>
            <span><StatusPill s={t.status} /></span>
            <span className="tp-muted">{timeAgo(t.updated_at)}</span>
          </button>
        ))}
        {!rows.length && <div className="empty empty-compact"><div className="empty-desc">没有匹配的选题</div></div>}
        {rows.length > limit && <button type="button" className="tp-more" onClick={() => setLimit(limit + PAGE)}>显示更多（还有 {rows.length - limit} 条）</button>}
      </div>
    )
  }

  return (
    <div className="vd-page">
      <PageTitle parent="视频" count={topics.length} desc="从收集的素材里挑题、打分、想清楚角度，可开拍了就立项成视频"
        actions={<Button variant="primary" onClick={newTopic} disabled={create.isPending}><IconPlus />新建选题</Button>}>选题</PageTitle>
      <VideosTabs active="topics" videos={videos} onSelect={onModuleTab} />
      {create.isError && <div className="vd-err" role="alert">选题没建成：{errorText(create.error)}</div>}

      {topics.length > 0 && (
        <div className="vd-toolbar">
          <label className="search vd-search">
            <IconSearch />
            <input type="search" aria-label="搜索选题" placeholder="搜标题、角度、标签" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE) }} />
          </label>
          <SearchSelect value={dir} onChange={(v) => setParam('dir', v)} noneLabel="全部方向" placeholder="全部方向" searchPlaceholder="搜方向"
            aria-label="按方向筛选" active={!!dir} missingLabel={(v) => v}
            options={[...dirs.map((d) => ({ value: d.name, label: d.name, hint: String(d.count) })), { value: '-', label: '没有方向' }]} />
          {view === 'table' && (
            <SearchSelect value={st} onChange={(v) => setParam('st', v)} noneLabel="全部状态" placeholder="全部状态" searchPlaceholder="搜状态"
              aria-label="按状态筛选" active={!!st}
              options={TOPIC_FLOW.map((s) => ({ value: s, label: TOPIC_STATUS[s].label, hint: String(topics.filter((t) => t.status === s).length) }))} />
          )}
          {series.length > 0 && (
            <SearchSelect value={sr} onChange={(v) => { setSr(v); setLimit(PAGE) }} noneLabel="全部系列" placeholder="全部系列" searchPlaceholder="搜系列"
              aria-label="按系列筛选" active={!!sr} missingLabel={() => '已删除的系列'}
              options={[...series.map((s) => ({ value: s.id, label: s.name })), { value: '-', label: '不属于系列' }]} />
          )}
          <span className="spacer" />
          {view === 'board' && (
            <button type="button" aria-pressed={showDropped} className={cls('chip', showDropped && 'chip-on')} onClick={() => setShowDropped(!showDropped)}>显示已放弃</button>
          )}
          <div className="vd-sort" role="group" aria-label="视图">
            <button type="button" aria-pressed={view === 'board'} className={cls(view === 'board' && 'on')} onClick={() => setParam('view', '')}>看板</button>
            <button type="button" aria-pressed={view === 'table'} className={cls(view === 'table' && 'on')} onClick={() => setParam('view', 'table')}>表格</button>
          </div>
        </div>
      )}

      {body}

      {cur && (
        <TopicDrawer key={cur.id} topic={cur} clips={clips} series={series} video={videos.find((v) => v.id === cur.video_id)}
          onClose={() => setParam('t', '')} onOpenVideo={onOpenVideo} />
      )}
      {open && !cur && <div className="vd-err" role="alert">这个选题不存在或已经删除 <button type="button" className="vd-link" onClick={() => setParam('t', '')}>关掉</button></div>}
    </div>
  )
}
