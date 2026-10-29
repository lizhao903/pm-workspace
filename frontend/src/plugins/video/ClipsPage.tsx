// 素材收件箱（VID-08c，照原型 web-next/src/topics.tsx 的 ClipsPage）：粘贴链接或想法收进来，待整理 / 收藏 / 全部三栏，按收进来的日子分段；
// 每条可收藏、转为选题、归到进行中的选题、标为看过、删除。拉热榜、收评论还没接内容平台（VID-04 起），
// 「收集评论」「拉取热榜」先打开手动收集：一行一条贴进来，行尾的数字记成点赞数或热度
import { Fragment, useState, type CSSProperties } from 'react'
import {
  errorText, useClipToTopic, useCreateClip, useDeleteClip, useLinkClip, usePatchClip, type Video, type VideoClip, type VideoClipKind, type VideoTopic,
} from '../../core/data'
import { Button, ConfirmDialog, Field, IconSearch, Input, PageTitle, SearchSelect, Textarea, cls } from '../../core/ui'
import { timeAgo } from './model'
import { VideosTabs, type ModuleTab } from './parts'
import { KindTag } from './topicParts'
import { CLIP_KIND, CLIP_KINDS, TOPIC_STATUS, dayGroup, filterClips, inBox, isOpenTopic, parseLines, pastedClip, type ClipBox } from './topicModel'
import './topics.css'

const PAGE = 50
const BOXES: [ClipBox, string][] = [['todo', '待整理'], ['starred', '收藏'], ['all', '全部']]
type Collect = 'comment' | 'trend'
const COLLECT: Record<Collect, { title: string; ph: string; source: string; sourcePh: string }> = {
  comment: { title: '收集评论', ph: '一行一条评论，行尾可以带点赞数，比如：\n能讲讲 Cursor 和 Claude Code 怎么选吗 326', source: '评论', sourcePh: '出自哪里，比如：B 站评论 · 第 3 集' },
  trend: { title: '拉取热榜', ph: '一行一条热榜词条，行尾可以带热度，比如：\nAI 编程助手对比 2.1万', source: '热榜', sourcePh: '哪个榜，比如：B 站热搜' },
}

export function ClipsPage({ clips, topics, videos, onModuleTab, onOpenTopic }: {
  clips: VideoClip[]
  topics: VideoTopic[]
  videos: Video[]
  onModuleTab: (t: ModuleTab) => void
  onOpenTopic: (id: string) => void
}) {
  const [box, setBox] = useState<ClipBox>('todo')
  const [kind, setKind] = useState<'' | VideoClipKind>('')
  const [q, setQ] = useState('')
  const [draft, setDraft] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [collect, setCollect] = useState<Collect | null>(null)
  const [note, setNote] = useState('')
  const [delId, setDelId] = useState<string | null>(null)
  const create = useCreateClip()
  const patch = usePatchClip()
  const toTopic = useClipToTopic()
  const link = useLinkClip()
  const del = useDeleteClip()
  const busy = patch.isPending || toTopic.isPending || link.isPending || del.isPending
  const failed = create.error ?? patch.error ?? toTopic.error ?? link.error ?? del.error

  const rows = filterClips(clips, { box, kind, q })
  const open = topics.filter(isOpenTopic)
  const topicOptions = open.map((t) => ({ value: t.id, label: t.title || '未命名选题', hint: TOPIC_STATUS[t.status].label, keywords: t.tags.join(' ') }))
  const n = (b: ClipBox) => clips.filter((c) => inBox(c, b)).length
  const clear = () => { create.reset(); patch.reset(); toTopic.reset(); link.reset(); del.reset() }
  const pick = (f: () => void) => { f(); setLimit(PAGE) }

  const add = () => {
    const body = pastedClip(draft)
    if (!body || create.isPending) return
    clear()
    create.mutate(body, { onSuccess: () => { setDraft(''); setNote('') } })
  }
  const onToTopic = (c: VideoClip) => {
    if (busy) return
    clear()
    toTopic.mutate({ id: c.id }, { onSuccess: (r) => onOpenTopic(r.topic.id) })
  }
  const onLink = (c: VideoClip, topicId: string) => {
    if (!topicId || busy) return
    clear()
    link.mutate({ id: c.id, topicId })
  }
  const onPatch = (c: VideoClip, p: { starred?: boolean; triaged?: boolean }) => {
    if (busy) return
    clear()
    patch.mutate({ id: c.id, patch: p })
  }
  const onDelete = () => {
    if (!delId || busy) return
    clear()
    del.mutate(delId, { onSettled: () => setDelId(null) })
  }
  const delClip = clips.find((c) => c.id === delId)

  return (
    <div className="vd-page">
      <PageTitle parent="视频" count={clips.length} desc="评论、热榜、竞品、聊天里冒出来的点子先收进来，再挑出值得做的变成选题" actions={(
        <>
          {note && <span className="tp-note" role="status">{note}</span>}
          <Button variant="outline" aria-pressed={collect === 'trend'} onClick={() => { setNote(''); setCollect(collect === 'trend' ? null : 'trend') }}>拉取热榜</Button>
          <Button variant="outline" aria-pressed={collect === 'comment'} onClick={() => { setNote(''); setCollect(collect === 'comment' ? null : 'comment') }}>收集评论</Button>
        </>
      )}>素材收件箱</PageTitle>
      <VideosTabs active="clips" videos={videos} onSelect={onModuleTab} />

      {collect && (
        <CollectForm key={collect} what={collect} onClose={() => setCollect(null)}
          onDone={(k) => { setCollect(null); setNote(`收进 ${k} 条${COLLECT[collect].source}`); setBox('todo'); setKind('') }} />
      )}

      <div className="tp-add">
        <input value={draft} aria-label="收进来" placeholder="粘贴链接，或者随手记一句想法，回车收进来" maxLength={5000}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) add() }} />
        <Button variant="primary" disabled={!draft.trim() || create.isPending} onClick={add}>收进来</Button>
      </div>
      {failed && <div className="vd-err" role="alert">没改成：{errorText(failed)}</div>}

      <div className="vd-toolbar">
        <div className="vd-sort" role="group" aria-label="收件箱">
          {BOXES.map(([k, l]) => (
            <button key={k} type="button" aria-pressed={box === k} className={cls(box === k && 'on')} onClick={() => pick(() => setBox(k))}>
              {l}<span className="seg-n"> {n(k)}</span>
            </button>
          ))}
        </div>
        <label className="search vd-search">
          <IconSearch />
          <input type="search" aria-label="搜索素材" placeholder="搜标题、内容、来源" value={q} onChange={(e) => pick(() => setQ(e.target.value))} />
        </label>
        <span className="spacer" />
        <div className="tp-kinds" role="group" aria-label="按类型筛选">
          <button type="button" aria-pressed={!kind} className={cls('tp-kind-btn', !kind && 'on')} onClick={() => pick(() => setKind(''))}>全部类型</button>
          {CLIP_KINDS.map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} className={cls('tp-kind-btn', kind === k && 'on')}
              style={{ '--c': CLIP_KIND[k].color } as CSSProperties} onClick={() => pick(() => setKind(kind === k ? '' : k))}>
              <i className="pill-dot" />{CLIP_KIND[k].label}
            </button>
          ))}
        </div>
      </div>

      {!rows.length ? (
        <div className="empty">
          <div className="empty-title">{q.trim() || kind ? '没有匹配的素材' : box === 'todo' ? '待整理的都处理完了' : '这里没有素材'}</div>
          <div className="empty-desc">{kind === 'comment' && !q.trim() ? '评论要等接上内容平台才能自动收，现在可以用「收集评论」手动贴进来' : '在上面粘贴链接，或者收集评论、热榜'}</div>
        </div>
      ) : (
        <div className="tp-clips">
          {rows.slice(0, limit).map((c, i) => {
            const day = dayGroup(c.created_at)
            const linked = c.topic_ids.map((id) => topics.find((t) => t.id === id)).filter((t): t is VideoTopic => !!t)
            const can = topicOptions.filter((o) => !c.topic_ids.includes(o.value))
            return (
              <Fragment key={c.id}>
                {day !== (i ? dayGroup(rows[i - 1].created_at) : '') && <div className="tp-day">{day}</div>}
                <article className={cls('tp-clip', !c.triaged && 'todo')} aria-label={c.title}>
                  <div className="tp-clip-top">
                    <KindTag k={c.kind} />
                    {c.url
                      ? <a className="ellipsis tp-clip-title" href={c.url} target="_blank" rel="noreferrer">{c.title}</a>
                      : <b className="ellipsis tp-clip-title">{c.title}</b>}
                    <span className="spacer" />
                    {c.heat !== undefined && <span className="tp-muted" title="热度、点赞或播放数">{c.heat.toLocaleString()}</span>}
                    <span className="tp-muted">{timeAgo(c.created_at)}</span>
                  </div>
                  {c.content && c.content !== c.title && <div className="tp-clip-text">{c.content}</div>}
                  <div className="tp-clip-foot">
                    <span className="tp-muted">{c.source}</span>
                    {linked.map((t) => (
                      <button key={t.id} type="button" className="tag tp-linked" onClick={() => onOpenTopic(t.id)}>
                        <span className="ellipsis">选题：{t.title || '未命名'}</span>
                      </button>
                    ))}
                    <span className="spacer" />
                    <button type="button" aria-pressed={c.starred} className={cls('tp-act tp-act-quiet', c.starred && 'on')} disabled={busy}
                      onClick={() => onPatch(c, { starred: !c.starred })}>{c.starred ? '已收藏' : '收藏'}</button>
                    <button type="button" className="tp-act" disabled={busy} onClick={() => onToTopic(c)}>转为选题</button>
                    <SearchSelect value="" placeholder="归到选题" searchPlaceholder={`搜选题，共 ${open.length} 个`} align="end" menuWidth={300}
                      aria-label={`把「${c.title}」归到选题`} disabled={!can.length || busy}
                      title={can.length ? undefined : open.length ? '已经归到所有进行中的选题了' : '没有进行中的选题'}
                      options={can} emptyText="没有进行中的选题" onChange={(v) => onLink(c, v)} />
                    {!c.triaged && <button type="button" className="tp-act tp-act-quiet" disabled={busy} onClick={() => onPatch(c, { triaged: true })}>看过了</button>}
                    <button type="button" className="tp-act tp-act-quiet tp-act-danger" disabled={busy} onClick={() => { clear(); setDelId(c.id) }}>删除</button>
                  </div>
                </article>
              </Fragment>
            )
          })}
          {rows.length > limit && <button type="button" className="tp-more" onClick={() => setLimit(limit + PAGE)}>显示更多（还有 {rows.length - limit} 条）</button>}
        </div>
      )}

      <ConfirmDialog open={!!delClip} danger title={`删除素材「${delClip?.title ?? ''}」？`} confirmLabel="删除" busy={del.isPending}
        impacts={[delClip?.topic_ids.length ? `从 ${delClip.topic_ids.length} 个选题里解除关联，选题保留` : '没有归到选题']}
        onCancel={() => setDelId(null)} onConfirm={onDelete} />
    </div>
  )
}

/** 手动收集评论、热榜：一行一条，出处填一次，逐条登记 */
function CollectForm({ what, onClose, onDone }: { what: Collect; onClose: () => void; onDone: (n: number) => void }) {
  const cfg = COLLECT[what]
  const create = useCreateClip()
  const [text, setText] = useState('')
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const lines = parseLines(text)

  const submit = async () => {
    if (!lines.length || busy) return
    setBusy(true)
    setErr('')
    let n = 0
    try {
      for (const l of lines) {
        await create.mutateAsync({ kind: what, content: l.text, source: source.trim() || cfg.source, ...(l.heat !== undefined ? { heat: l.heat } : {}) })
        n++
      }
      onDone(n)
    } catch (e) {
      setErr(`收进 ${n} 条后出错：${errorText(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="tp-collect" aria-label={cfg.title}>
      <div className="tp-collect-head">{cfg.title}<span className="vd-hint">还没接上内容平台，先手动贴进来，收进来的都在「待整理」</span></div>
      <Field label={what === 'comment' ? '评论' : '词条'}>
        <Textarea rows={4} autoFocus value={text} placeholder={cfg.ph} onChange={(e) => setText(e.target.value)} />
      </Field>
      <Field label="来源">
        <Input value={source} maxLength={200} placeholder={cfg.sourcePh} onChange={(e) => setSource(e.target.value)} />
      </Field>
      {err && <div className="vd-err" role="alert">{err}</div>}
      <div className="tp-collect-foot">
        <span className="tp-muted">{lines.length ? `${lines.length} 条` : ''}</span>
        <span className="spacer" />
        <Button onClick={onClose} disabled={busy}>取消</Button>
        <Button variant="primary" disabled={!lines.length || busy} onClick={() => void submit()}>{busy ? '收进来中' : lines.length ? `收进 ${lines.length} 条` : '收进来'}</Button>
      </div>
    </section>
  )
}
