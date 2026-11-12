// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 选题抽屉（照原型 topics.tsx 的 TopicDrawer）：标题、状态、放弃原因、计划开做、角度、受众、打分、系列、标签、平台、大纲、关联素材；
// 原型边改边存，这里和视频插件别的抽屉一样改草稿、点「保存」才写，关掉时有未保存提示。取消关联素材、立项、删除是单独的写操作
import { useState } from 'react'
import {
  errorText, useDeleteTopic, useMakeTopic, usePatchTopic, type Video, type VideoClip, type VideoSeries, type VideoTopic, type VideoTopicScore,
} from '../../core/data'
import { Button, ConfirmDialog, Drawer, Field, IconButton, Input, SearchSelect, Textarea, cls } from '../../core/ui'
import { KindTag, PriorityBadge } from './topicParts'
import {
  PLATFORMS, SCORE_LABEL, TOPIC_FLOW, TOPIC_STATUS, draftOf, makeBlock, parseTags, topicPatch, topicPriority, type TopicDraft,
} from './topicModel'

export function TopicDrawer({ topic: t, clips, series, video, onClose, onOpenVideo }: {
  topic: VideoTopic
  clips: VideoClip[]
  series: VideoSeries[]
  video?: Video
  onClose: () => void
  onOpenVideo: (id: string) => void
}) {
  const patch = usePatchTopic()
  const make = useMakeTopic()
  const del = useDeleteTopic()
  const [d, setD] = useState<TopicDraft>(() => draftOf(t))
  const [tagText, setTagText] = useState(() => t.tags.join('，'))
  const [confirmDel, setConfirmDel] = useState(false)
  const [saved, setSaved] = useState(false)

  const draft = { ...d, tags: parseTags(tagText) }
  const changes = topicPatch(t, draft)
  const dirty = Object.keys(changes).length > 0
  const busy = patch.isPending || make.isPending || del.isPending
  const failed = patch.error ?? make.error ?? del.error
  const mine = t.clip_ids.map((id) => clips.find((c) => c.id === id)).filter((c): c is VideoClip => !!c)
  const block = makeBlock({ title: draft.title, status: draft.status, video_id: t.video_id })

  const set = (x: Partial<TopicDraft>) => { setSaved(false); setD({ ...d, ...x }) }
  const setScore = (k: keyof VideoTopicScore, n: number) => set({ score: { ...d.score, [k]: n } })
  const togglePlat = (k: (typeof PLATFORMS)[number]['key']) => set({ platforms: d.platforms.includes(k) ? d.platforms.filter((x) => x !== k) : [...d.platforms, k] })
  const reset = (x: VideoTopic) => { setD(draftOf(x)); setTagText(x.tags.join('，')) }
  const clear = () => { patch.reset(); make.reset(); del.reset() }

  const save = (then?: (x: VideoTopic) => void) => {
    if (busy) return
    clear()
    if (!dirty) { then?.(t); return }
    patch.mutate({ id: t.id, patch: changes }, { onSuccess: (x) => { reset(x); setSaved(true); then?.(x) } })
  }
  // 立项前先把改的存上：标题、平台这些会带进生成的视频
  const onMake = () => save((x) => make.mutate({ id: x.id }, { onSuccess: (r) => onOpenVideo(r.video.id) }))
  const unlink = (cid: string) => {
    if (busy) return
    clear()
    patch.mutate({ id: t.id, patch: { clip_ids: t.clip_ids.filter((x) => x !== cid) } })
  }
  const onDelete = () => {
    if (busy) return
    clear()
    del.mutate(t.id, { onSuccess: () => { setConfirmDel(false); onClose() }, onError: () => setConfirmDel(false) })
  }

  return (
    <Drawer open onClose={onClose} kicker="选题" aria-label={t.title || '未命名选题'} className="vd-drawer"
      headActions={<PriorityBadge score={d.score} />}
      dirty={dirty} dirtyMessage="关闭后，这次改的选题内容不会保存。"
      footer={(requestClose) => (
        <>
          <Button size="sm" variant="danger-ghost" disabled={busy} onClick={() => setConfirmDel(true)}>删除</Button>
          <span className="spacer" />
          {saved && !dirty && <span className="tp-saved" role="status">已保存</span>}
          <Button onClick={requestClose}>关闭</Button>
          <Button variant="outline" disabled={busy || !dirty} onClick={() => save()}>保存</Button>
          {video
            ? <Button variant="outline" onClick={() => onOpenVideo(video.id)}>打开视频</Button>
            : <Button variant="primary" disabled={busy || !!block} title={block || '生成一集视频，从内容编写开始'} onClick={onMake}>立项做成视频</Button>}
        </>
      )}>
      <form className="tp-form" onSubmit={(e) => { e.preventDefault(); save() }}>
        {failed && <div className="vd-err" role="alert">{errorText(failed)}</div>}
        <Field label="标题">
          <Input value={d.title} placeholder="这一期讲什么" autoFocus={!t.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field label="状态" wrap={false}>
          <div className="tp-status-row" role="group" aria-label="状态">
            {TOPIC_FLOW.map((s) => (
              <button key={s} type="button" aria-pressed={d.status === s} className={cls('chip', d.status === s && 'chip-on')}
                disabled={s === 'made' && !t.video_id} title={s === 'made' && !t.video_id ? '立项后自动变成已做成' : TOPIC_STATUS[s].desc}
                onClick={() => set({ status: s })}>{TOPIC_STATUS[s].label}</button>
            ))}
          </div>
        </Field>
        {d.status === 'dropped' && (
          <Field label="放弃原因">
            <Input value={d.drop_reason} maxLength={500} placeholder="以后回看时知道为什么没做" onChange={(e) => set({ drop_reason: e.target.value })} />
          </Field>
        )}
        {d.status === 'scheduled' && (
          <Field label="计划开做">
            <Input type="date" value={d.planned} onChange={(e) => set({ planned: e.target.value })} />
          </Field>
        )}
        <Field label="切入角度">
          <Textarea rows={2} value={d.angle} maxLength={1000} placeholder="同一个题，从哪个角度讲和别人不一样" onChange={(e) => set({ angle: e.target.value })} />
        </Field>
        <Field label="目标受众">
          <Input value={d.audience} maxLength={500} placeholder="讲给谁听" onChange={(e) => set({ audience: e.target.value })} />
        </Field>

        <Field label={<>打分<span className="vd-hint">优先级 {topicPriority(d.score).toFixed(1)} / 10</span></>} wrap={false}>
          {(Object.keys(SCORE_LABEL) as (keyof VideoTopicScore)[]).map((k) => (
            <div key={k} className="tp-score">
              <span className="tp-score-label">{SCORE_LABEL[k].label}<span className="tp-muted">{SCORE_LABEL[k].hint}</span></span>
              <span className="tp-dots" role="group" aria-label={SCORE_LABEL[k].label}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} type="button" className={cls('tp-dot', n <= d.score[k] && 'on', k === 'effort' && 'cost')}
                    aria-pressed={n === d.score[k]} aria-label={`${SCORE_LABEL[k].label} ${n}`} onClick={() => setScore(k, n)} />
                ))}
              </span>
            </div>
          ))}
        </Field>

        <div className="field-row">
          <Field label="系列" wrap={false}>
            <SearchSelect variant="field" value={d.series_id} onChange={(v) => set({ series_id: v })} noneLabel="不属于系列" placeholder="不属于系列"
              searchPlaceholder="搜系列" aria-label="系列" missingLabel={() => '已删除的系列'} options={series.map((s) => ({ value: s.id, label: s.name }))} />
          </Field>
          <Field label="标签" hint="逗号分隔，第一个是方向">
            <Input value={tagText} placeholder="比如：AI，单期" onChange={(e) => { setSaved(false); setTagText(e.target.value) }} />
          </Field>
        </div>
        <Field label="发哪些平台" wrap={false}>
          <div className="tp-status-row" role="group" aria-label="发哪些平台">
            {PLATFORMS.map((p) => (
              <button key={p.key} type="button" aria-pressed={d.platforms.includes(p.key)} className={cls('chip', d.platforms.includes(p.key) && 'chip-on')}
                onClick={() => togglePlat(p.key)}>{p.label}</button>
            ))}
          </div>
        </Field>
        <Field label="大纲草稿">
          <Textarea rows={8} className="vd-mono" value={d.outline} maxLength={20000} placeholder={'1. 开场问题\n2. 主体\n3. 结论'}
            onChange={(e) => set({ outline: e.target.value })} />
        </Field>

        <Field label={<>关联素材 {mine.length}<span className="vd-hint">在素材收件箱里把素材归到这个选题</span></>} wrap={false}>
          {mine.length ? (
            <div className="tp-clip-list">
              {mine.map((c) => (
                <div key={c.id} className="tp-clip-mini">
                  <KindTag k={c.kind} /><span className="ellipsis">{c.title}</span><span className="spacer" /><span className="tp-muted">{c.source}</span>
                  <IconButton size="sm" label={`取消关联 ${c.title}`} disabled={busy} onClick={() => unlink(c.id)}>
                    <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                  </IconButton>
                </div>
              ))}
            </div>
          ) : <div className="tp-empty-line">还没有关联素材</div>}
        </Field>
        {video && <div className="tp-video-line">已立项：<button type="button" className="vd-link ellipsis" onClick={() => onOpenVideo(video.id)}>{video.title}</button></div>}
        {t.video_id && !video && <div className="tp-video-line">已立项的视频没加载出来，或者已经删除</div>}
        <button type="submit" hidden />
      </form>

      <ConfirmDialog open={confirmDel} danger title={`删除选题「${t.title || '未命名选题'}」？`} confirmLabel="删除" busy={busy}
        impacts={['删除后不能恢复', mine.length ? `${mine.length} 条关联素材保留，只解除关联` : '没有关联素材', ...(t.video_id ? ['立项生成的视频保留'] : [])]}
        onCancel={() => setConfirmDel(false)} onConfirm={onDelete} />
    </Drawer>
  )
}
