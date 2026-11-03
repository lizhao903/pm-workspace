// 阅读视图（SPEC-settings-11.20 到 11.23、11.28）：按段显示正文，标出和下一段重叠的字；笔记可以直接改。
// 笔记改了先存在草稿里，停笔约 0.9 秒提交一次（后端改了标题、正文当场重新索引），「改完了」时还有没提交的就立即提交。
import { useEffect, useMemo, useRef, useState } from 'react'
import { errorText, usePatchKbDoc, useRemoveKbDoc, type KbDoc, type KnowledgeBase } from '../../../core/data'
import { Button, cls, Pill } from '../../../core/ui'
import { ago, codepoints, docRef, docStatus, KB_DOC_SOURCE, KB_DOC_STATUS, splitChunks, type Chunk } from './model'

const EDIT_DEBOUNCE_MS = 900

/** 全文按段显示：每段前面标第几段；和下一段重叠的那几个字单独标出来 */
function ChunkedText({ text, chunks, focus, flashAt }: { text: string; chunks: Chunk[]; focus?: number; flashAt: number }) {
  const refs = useRef<(HTMLDivElement | null)[]>([])
  const cps = useMemo(() => codepoints(text), [text])
  const slice = (a: number, b: number) => cps.slice(a, b).join('')
  useEffect(() => {
    if (focus === undefined) return
    refs.current[focus]?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  }, [focus, flashAt])
  return (
    <div className="kbx-text">
      {chunks.map((c, i) => {
        const from = i ? Math.max(chunks[i - 1].end, c.start) : 0
        const next = chunks[i + 1]
        const ov = next && next.start < c.end ? Math.max(next.start, from) : c.end
        const lead = i && c.start < chunks[i - 1].end ? chunks[i - 1].end - c.start : 0
        return (
          <div key={focus === i ? `${i}-${flashAt}` : i} ref={(el) => { refs.current[i] = el }} data-chunk={i}
            className={cls('kbx-chunk', i % 2 === 1 && 'alt', focus === i && 'focus')}>
            <span className="kbx-chunk-tag">第 {i + 1} 段 · {c.end - c.start} 字{lead > 0 && ` · 开头 ${lead} 字和上一段重叠`}</span>
            <div className="kbx-chunk-body">
              {slice(from, ov)}
              {ov < c.end && <mark className="kbx-overlap" title="这几个字同时属于下一段">{slice(ov, c.end)}</mark>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function KbReader({ kb, doc, busy, focus, flashAt, onBack, onReindex, onRemoved }: {
  kb: KnowledgeBase
  doc: KbDoc
  busy: boolean
  focus?: number
  flashAt: number
  onBack: () => void
  onReindex: () => void
  onRemoved: () => void
}) {
  const patch = usePatchKbDoc()
  const remove = useRemoveKbDoc()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ title: doc.title, text: doc.text })
  const [confirmRm, setConfirmRm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isNote = doc.source.type === 'note'
  const { chunk_size: size, overlap } = kb.settings
  const text = editing ? draft.text : doc.text
  const chunks = useMemo(() => splitChunks(text, size, overlap), [text, size, overlap])
  const changed = editing && (draft.title !== doc.title || draft.text !== doc.text)
  const draftBad = !draft.title.trim() || !draft.text.trim()
  // 草稿没提交、正在提交，都算待索引
  const pendingEdit = changed || patch.isPending

  const save = () => {
    if (!changed || draftBad) return
    // 上一次还没回来：过一会儿再试，免得最后几个字没提交
    if (patch.isPending) { window.setTimeout(() => saveRef.current(), EDIT_DEBOUNCE_MS); return }
    setError(null)
    patch.mutate({ id: kb.id, docId: doc.id, patch: { title: draft.title.trim(), text: draft.text } }, { onError: (e) => setError(errorText(e)) })
  }
  const saveRef = useRef(save)
  useEffect(() => { saveRef.current = save })
  useEffect(() => {
    if (!changed || draftBad) return
    const t = window.setTimeout(() => saveRef.current(), EDIT_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [changed, draftBad, draft.title, draft.text])

  const toggleEdit = () => {
    if (editing) save()
    else setDraft({ title: doc.title, text: doc.text })
    setEditing(!editing)
  }
  const toggleExcluded = () => {
    setError(null)
    patch.mutate({ id: kb.id, docId: doc.id, patch: { excluded: !doc.excluded } }, { onError: (e) => setError(errorText(e)) })
  }
  const doRemove = () => {
    setError(null)
    // 移除后文档列表一刷阅读视图就卸了，用 mutateAsync 保证 onRemoved 会来
    remove.mutateAsync({ id: kb.id, docId: doc.id }).then(onRemoved, (e: unknown) => setError(`移除失败：${errorText(e)}`))
  }

  const st = pendingEdit ? KB_DOC_STATUS.pending : docStatus(doc, busy)
  return (
    <div className="kbx-reader">
      <div className="kbx-reader-bar">
        <button type="button" className="kb-link" onClick={onBack}>返回文档列表</button>
        <span className="spacer" />
        {isNote && <Button size="sm" variant={editing ? 'primary' : 'outline'} disabled={editing && draftBad} onClick={toggleEdit}>{editing ? '改完了' : '编辑笔记'}</Button>}
        <Button size="sm" variant="outline" disabled={busy || editing} onClick={onReindex}>{busy ? '索引中' : doc.status === 'pending' ? '开始索引' : '重新索引'}</Button>
        <Button size="sm" variant="outline" onClick={toggleExcluded}>{doc.excluded ? '恢复参与检索' : '排除'}</Button>
        {confirmRm
          ? <Button size="sm" variant="danger" disabled={remove.isPending} onClick={doRemove}>确认移除</Button>
          : <Button size="sm" onClick={() => setConfirmRm(true)}>移除</Button>}
      </div>
      <div className="kbx-reader-head">
        {editing
          ? <input className={cls('kbx-title-input', !draft.title.trim() && 'bad')} value={draft.title} aria-label="标题" onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          : <h2 className="kbx-reader-title">{doc.title}</h2>}
        <div className="kbx-reader-meta">
          <span className="tag">{KB_DOC_SOURCE[doc.source.type] ?? doc.source.type}</span>
          {docRef(doc) && <code className="ellipsis" title={docRef(doc)}>{docRef(doc)}</code>}
          <Pill label={st.label} color={st.color} />
          {doc.excluded && <span className="tag">已排除</span>}
          <span className="kb-muted">{ago(doc.updated_at)}更新</span>
        </div>
        {error && <div className="kbx-alert kbx-alert-bad" role="alert">{error}</div>}
        {doc.status === 'failed' && doc.error && !pendingEdit && <div className="kbx-alert kbx-alert-bad"><span><b>索引失败</b>{doc.error}</span></div>}
        {doc.excluded && <div className="kbx-alert kbx-alert-info"><span>这篇暂时不参与检索，资料还留着；点「恢复参与检索」放回去</span></div>}
        {text.trim() && (
          <div className="kbx-reader-sum">
            按每段 {size} 字、重叠 {overlap} 字切成 <b>{chunks.length}</b> 段
            {doc.status === 'indexed' && !pendingEdit && doc.chunks !== chunks.length && (
              <span className="kbx-warn"> · 上次索引是 {doc.chunks} 段，重新索引后按新的切分</span>
            )}
          </div>
        )}
      </div>
      {editing ? (
        <textarea className={cls('kbx-editor', !draft.text.trim() && 'bad')} value={draft.text} aria-label="正文" onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
      ) : doc.text.trim() ? <ChunkedText text={doc.text} chunks={chunks} focus={focus} flashAt={flashAt} />
        : <div className="kbx-none">没有可显示的正文{doc.source.type === 'link' ? '：网页没抓到内容' : doc.source.type === 'upload' ? '：文件里没提取到文字' : ''}</div>}
      {editing && (
        <div className="field-hint-line kbx-edit-hint">
          {draftBad ? '标题和正文都要填' : pendingEdit ? '停笔一会儿就会重新索引' : '已按最新内容索引'}
        </div>
      )}
    </div>
  )
}
