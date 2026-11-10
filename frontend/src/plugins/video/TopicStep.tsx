// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 制作流程的选题一步（VID-09b，SPEC-videos-10.26 到 10.30、10.43）：挂了选题显示要点，点标题打开选题抽屉（复用 VID-08c 的 TopicDrawer）；
// 没挂的从选题库挑一个或新建一个；挂了的右上角能换。两边的回写（选题的 video_id、状态，视频的标题、比例）由后端 PUT /topic 做
import { useMemo, useState } from 'react'
import {
  errorText, useCreateTopic, usePutVideoTopic, type Video, type VideoClip, type VideoSeries, type VideoTopic,
} from '../../core/data'
import { Button, SearchSelect, cls } from '../../core/ui'
import { TopicDrawer } from './TopicDrawer'
import { PriorityBadge, StatusPill } from './topicParts'
import { TOPIC_STATUS, topicPriority } from './topicModel'
import { newTopicTitle, outlineItems, pickableTopic } from './scriptModel'
import './topics.css'

export function TopicStep({ v, topics, clips, series, drawerOpen, onDrawer }: {
  v: Video
  /** 还没取回来时是 undefined */
  topics: VideoTopic[] | undefined
  clips: VideoClip[]
  series: VideoSeries[]
  drawerOpen: boolean
  onDrawer: (open: boolean) => void
}) {
  const put = usePutVideoTopic()
  const create = useCreateTopic()
  const [picked, setPicked] = useState('')
  const busy = put.isPending || create.isPending
  const err = put.error ?? create.error
  const topic = v.topic_id ? topics?.find((t) => t.id === v.topic_id) : undefined

  const options = useMemo(() => (topics ?? []).filter(pickableTopic)
    .sort((a, b) => topicPriority(b.score) - topicPriority(a.score) || b.updated_at.localeCompare(a.updated_at))
    .map((t) => ({ value: t.id, label: t.title || '未命名选题', hint: `${TOPIC_STATUS[t.status].label} · ${topicPriority(t.score).toFixed(1)}`,
      keywords: `${t.angle} ${t.tags.join(' ')}` })), [topics])

  const link = (id: string) => {
    if (!id || busy) return
    create.reset()
    setPicked(id)
    put.mutate({ id: v.id, topicId: id }, { onSettled: () => setPicked('') })
  }
  // 新建：标题取本集标题，系列同本集，三项打分 3；建好挂上再打开抽屉接着写
  const onNew = () => {
    if (busy) return
    put.reset()
    create.mutate({ title: newTopicTitle(v), series_id: v.series_id ?? null, score: { demand: 3, fit: 3, effort: 3 } }, {
      onSuccess: (t) => put.mutate({ id: v.id, topicId: t.id }, { onSuccess: () => onDrawer(true) }),
    })
  }

  const picker = (label: string) => (
    <SearchSelect value={picked} placeholder={label} searchPlaceholder="搜标题、角度、标签" disabled={!topics || !options.length || busy}
      title={!topics ? '选题库还没加载出来' : options.length ? `从 ${options.length} 个还没立项的选题里选，按优先级排` : '选题库里没有还没立项的选题'}
      emptyText="没有还没立项的选题" aria-label={label} options={options} onChange={link} menuWidth={380} align={topic ? 'end' : 'start'} />
  )

  const drawer = drawerOpen && topic && (
    <TopicDrawer key={topic.id} topic={topic} clips={clips} series={series} video={v} onClose={() => onDrawer(false)} onOpenVideo={() => onDrawer(false)} />
  )

  if (!topic) {
    return (
      <div className="vd-topic vd-topic-none" aria-label="选题">
        <span className="vd-muted vd-wrap">
          {!topics && v.topic_id ? '选题加载中…'
            : v.topic_id ? '原来的选题已经删掉了，重新挑一个' : '这一集还没挂选题：讲什么、讲给谁、从哪个角度讲，先在选题里想清楚'}
        </span>
        {err && <div className="vd-err" role="alert">{errorText(err)}</div>}
        <div className="vd-act-row">
          {picker('从选题库选一个')}
          <Button size="sm" variant="outline" disabled={busy} onClick={onNew}>{create.isPending ? '新建中…' : '新建选题'}</Button>
        </div>
      </div>
    )
  }

  const outline = outlineItems(topic.outline)
  return (
    <div className="vd-topic" aria-label="选题">
      <div className="vd-topic-head">
        <button type="button" className="vd-topic-title" title="打开选题" onClick={() => onDrawer(true)}>{topic.title || '未命名选题'}</button>
        <PriorityBadge score={topic.score} />
        <StatusPill s={topic.status} />
        <span className="spacer" />
        {picker('换一个')}
      </div>
      {err && <div className="vd-err" role="alert">{errorText(err)}</div>}
      <dl className="vd-topic-props">
        <dt>角度</dt><dd className={cls(!topic.angle && 'vd-faint')}>{topic.angle || '还没写'}</dd>
        <dt>受众</dt><dd className={cls(!topic.audience && 'vd-faint')}>{topic.audience || '还没写'}</dd>
        <dt>打分</dt><dd>需求 {topic.score.demand} · 契合 {topic.score.fit} · 成本 {topic.score.effort}</dd>
        <dt>大纲</dt>
        <dd>
          {outline.length ? <ol className="vd-topic-outline">{outline.map((l, i) => <li key={i}>{l}</li>)}</ol> : (
            <span className="vd-faint">还没写大纲，按大纲起草要先补上。<button type="button" className="vd-link" onClick={() => onDrawer(true)}>去补</button></span>
          )}
        </dd>
      </dl>
      {drawer}
    </div>
  )
}
