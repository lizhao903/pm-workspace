// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 知识库详情的「文档」标签（SPEC-settings-11.4 到 11.19、11.24 到 11.29）：未收进来的提示、筛选、文档表、加文档表单。
import { useMemo, useState } from 'react'
import {
  errorText, useAddKbDocs, useAllObjects, useKbMissing, usePatchKbDoc, useRemoveKbDoc, type KbAddInput, type KbDoc, type KnowledgeBase,
  type WorkObject,
} from '../../../core/data'
import { Button, cls, EmptyState, Input, Pill, SearchSelect, Textarea } from '../../../core/ui'
import {
  ago, DOC_FILTERS, docRef, docStatus, fileBase64, hit, inFilter, KB_DOC_SOURCE, originLabel, searchable, UPLOAD_ACCEPT, UPLOAD_EXT, UPLOAD_MAX,
  type DocFilter,
} from './model'
import { KbSearchBox } from './parts'

export function KbDocs({ kb, docs, busy, adding, onAdding, onRead, onReindex }: {
  kb: KnowledgeBase
  docs: KbDoc[]
  busy: string[]
  adding: boolean
  onAdding: (v: boolean) => void
  onRead: (id: string) => void
  onReindex: (ids: string[]) => void
}) {
  const [filter, setFilter] = useState<DocFilter>('')
  const [q, setQ] = useState('')
  const [confirmRm, setConfirmRm] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const libQ = useAllObjects({ type: ['doc'] })
  const library = useMemo(() => libQ.data?.data ?? [], [libQ.data])
  const missingQ = useKbMissing(kb.id, kb.settings.auto_sync)
  const missing = kb.settings.auto_sync ? missingQ.data ?? [] : []
  const add = useAddKbDocs()
  const patch = usePatchKbDoc()
  const remove = useRemoveKbDoc()

  const rows = docs.filter((d) => inFilter(d, filter) && hit(`${d.title} ${docRef(d)} ${d.text}`, q))
  const inLib = new Set(docs.filter((d) => d.source.type === 'library').map((d) => d.source.ref ?? ''))
  const scope = searchable(docs)
  const catOf = (ref?: string) => library.find((o) => o.id === ref)?.category_name || '未分类'

  const collect = () => {
    setError(null)
    add.mutate({ id: kb.id, input: { type: 'library', refs: missing.map((m) => m.id) } }, {
      onError: (e) => setError(`收进来失败：${errorText(e)}`),
    })
  }
  const toggleExcluded = (d: KbDoc) => {
    setError(null)
    patch.mutate({ id: kb.id, docId: d.id, patch: { excluded: !d.excluded } }, { onError: (e) => setError(errorText(e)) })
  }
  const removeDoc = (d: KbDoc) => {
    setError(null)
    remove.mutate({ id: kb.id, docId: d.id }, {
      onSuccess: () => setConfirmRm(null),
      onError: (e) => setError(`移除失败：${errorText(e)}`),
    })
  }

  return (
    <>
      {adding && <KbAddForm kb={kb} library={library} libLoaded={!!libQ.data} inLib={inLib} onClose={() => onAdding(false)} />}
      {missing.length > 0 && (
        <div className="kbx-alert kbx-alert-info">
          <span><b>来源分类里有 {missing.length} 篇还没收进来</b>{missing.slice(0, 3).map((c) => c.title).join('、')}{missing.length > 3 ? ' 等' : ''}</span>
          <Button size="sm" disabled={add.isPending} onClick={collect}>收进来</Button>
        </div>
      )}
      {error && <div className="kbx-alert kbx-alert-bad" role="alert">{error}</div>}
      <div className="kb-toolbar">
        <div className="kb-seg" role="group" aria-label="按状态筛">
          {DOC_FILTERS.map(([k, l]) => (
            <button key={k} type="button" className={cls(filter === k && 'on')} aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {l}<span className="seg-n">{docs.filter((d) => inFilter(d, k)).length}</span>
            </button>
          ))}
        </div>
        <KbSearchBox value={q} onChange={setQ} placeholder="搜标题、路径、正文" />
        <span className="spacer" />
        <span className="kb-muted">参与检索 {scope.length} 篇 · {scope.reduce((n, d) => n + d.chunks, 0)} 段</span>
      </div>
      {!docs.length && !adding && (
        <EmptyState title="知识库里还没有文档" desc="从「文档」里挑、上传文件、填网址，或者直接写一篇笔记"
          action={<Button variant="primary" onClick={() => onAdding(true)}>加文档</Button>} />
      )}
      {docs.length > 0 && !rows.length && <EmptyState title="没有匹配的文档" desc="换个筛选或关键词试试" />}
      {rows.length > 0 && (
        <div className="kbx-table" role="table" aria-label="文档">
          <div className="kbx-row kbx-th" role="row">
            <span role="columnheader">文档</span><span role="columnheader">来源</span><span role="columnheader">段数</span>
            <span role="columnheader">状态</span><span role="columnheader">更新</span><span role="columnheader" aria-label="操作" />
          </div>
          {rows.map((d) => {
            const running = busy.includes(d.id)
            const st = docStatus(d, running)
            return (
              <div key={d.id} role="row" className={cls('kbx-row', d.excluded && 'kbx-off')} data-doc={d.id}>
                <span className="kbx-main" role="cell">
                  <button type="button" className="kbx-title ellipsis" onClick={() => onRead(d.id)} title={d.title}>{d.title}</button>
                  {d.status === 'failed' && d.error ? <span className="kbx-err">{d.error}</span>
                    : <span className="kbx-ref ellipsis" title={docRef(d) || undefined}>
                      {d.source.type === 'library' ? `分类：${catOf(d.source.ref)}` : docRef(d) || `${Array.from(d.text).length} 字`}
                    </span>}
                </span>
                <span role="cell"><span className="tag">{KB_DOC_SOURCE[d.source.type] ?? d.source.type}</span>
                  {originLabel(d) && <span className="tag" title="同步加进来的：以项目资料为准，移除或改了下次同步会恢复">{originLabel(d)}</span>}</span>
                <span role="cell" className="kb-muted">{d.status === 'failed' ? '-' : d.chunks}</span>
                <span role="cell" className="kbx-state">
                  <Pill label={st.label} color={st.color} />
                  {d.excluded && <span className="tag">已排除</span>}
                </span>
                <span role="cell" className="kb-muted">{ago(d.updated_at)}</span>
                <span role="cell" className="kbx-ops">
                  {confirmRm === d.id ? (
                    <>
                      <Button size="sm" variant="danger" disabled={remove.isPending} onClick={() => removeDoc(d)}>确认移除</Button>
                      <Button size="sm" onClick={() => setConfirmRm(null)}>取消</Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" disabled={running} onClick={() => onReindex([d.id])}>
                        {running ? '索引中' : d.status === 'pending' ? '开始索引' : '重新索引'}
                      </Button>
                      <Button size="sm" title={d.excluded ? '恢复后重新参与检索' : '资料留着，暂时不参与检索'} onClick={() => toggleExcluded(d)}>
                        {d.excluded ? '恢复' : '排除'}
                      </Button>
                      <Button size="sm" onClick={() => setConfirmRm(d.id)}>移除</Button>
                    </>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

type AddKind = 'library' | 'upload' | 'link' | 'note'
const ADD_KINDS: { key: AddKind; label: string }[] = [
  { key: 'library', label: '从「文档」挑' }, { key: 'upload', label: '上传文件' }, { key: 'link', label: '网页链接' }, { key: 'note', label: '写笔记' },
]
const URL_RE = /^https?:\/\/\S+\.\S+/

function KbAddForm({ kb, library, libLoaded, inLib, onClose }: {
  kb: KnowledgeBase
  library: WorkObject[]
  libLoaded: boolean
  inLib: Set<string>
  onClose: () => void
}) {
  const add = useAddKbDocs()
  const [kind, setKind] = useState<AddKind>('library')
  const [picked, setPicked] = useState<string[]>([])
  const [files, setFiles] = useState<File[]>([])
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [tried, setTried] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const badUrl = !URL_RE.test(url.trim())
  const options = useMemo(() => [...library]
    .sort((a, b) => (a.category_name ?? '').localeCompare(b.category_name ?? ''))
    .map((o) => ({
      value: o.id, label: o.title, group: o.category_name || '未分类', keywords: o.tags.join(' '),
      hint: inLib.has(o.id) ? '已在库里' : undefined, disabled: inLib.has(o.id),
    })), [library, inLib])

  const switchKind = (k: AddKind) => { setKind(k); setTried(false); setError(null); setTitle(''); setText('') }

  async function submit() {
    setTried(true)
    setError(null)
    let inputs: KbAddInput[] = []
    if (kind === 'library') {
      if (!picked.length) return
      inputs = [{ type: 'library', refs: picked }]
    }
    if (kind === 'upload') {
      if (!files.length) return
      const bad = files.find((f) => !UPLOAD_EXT.test(f.name))
      if (bad) { setError(`「${bad.name}」的格式收不了，只收 .md、.markdown、.txt、.csv、.pdf、.docx`); return }
      const big = files.find((f) => f.size > UPLOAD_MAX)
      if (big) { setError(`「${big.name}」超过 1MB，拆小一点再传`); return }
      inputs = await Promise.all(files.map(async (f) => ({ type: 'upload' as const, ref: f.name, data: await fileBase64(f) })))
    }
    if (kind === 'link') {
      if (badUrl) return
      inputs = [{ type: 'link', ref: url.trim(), title: title.trim() || undefined, text: text.trim() || undefined }]
    }
    if (kind === 'note') {
      if (!title.trim() || !text.trim()) return
      inputs = [{ type: 'note', title: title.trim(), text: text.trim() }]
    }
    // 上传多个文件是一篇一个请求；有一篇失败就停下，前面成功的已经收进来了
    setSending(true)
    try {
      for (const input of inputs) await add.mutateAsync({ id: kb.id, input })
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="kbx-add" aria-label="加文档" role="group">
      <div className="kb-seg" role="group" aria-label="来源">
        {ADD_KINDS.map((k) => (
          <button key={k.key} type="button" className={cls(kind === k.key && 'on')} aria-pressed={kind === k.key} onClick={() => switchKind(k.key)}>{k.label}</button>
        ))}
      </div>
      {kind === 'library' && (
        <>
          <SearchSelect multiple variant="field" value={picked} onChange={setPicked} placeholder="选一篇或几篇文档" searchPlaceholder="搜文档标题、标签"
            options={options} emptyText={libLoaded ? '「文档」里还没有文档' : '加载中'} missingLabel={() => '已删除的文档'} />
          {tried && !picked.length && <span className="field-err">至少选一篇</span>}
        </>
      )}
      {kind === 'upload' && (
        <>
          <div className="kbx-add-line">
            <label className="btn btn-outline btn-sm kbx-file">选文件
              <input type="file" multiple hidden accept={UPLOAD_ACCEPT} onChange={(e) => setFiles([...(e.target.files ?? [])])} />
            </label>
            <span className="field-hint-line">{files.length ? files.map((f) => f.name).join('、') : '支持 .md、.txt、.csv，.pdf 和 .docx 要带可提取的文字'}</span>
          </div>
          {tried && !files.length && <span className="field-err">先选文件</span>}
        </>
      )}
      {kind === 'link' && (
        <>
          <Input className="kb-mono" value={url} invalid={tried && badUrl} placeholder="https://..." aria-label="网址" onChange={(e) => setUrl(e.target.value)} />
          <Input value={title} placeholder="标题（留空用网址）" aria-label="标题" onChange={(e) => setTitle(e.target.value)} />
          <Textarea rows={3} value={text} aria-label="正文摘录" placeholder="正文摘录（可选）：要登录才能看的页面抓不到正文，把关键段落贴在这里"
            onChange={(e) => setText(e.target.value)} />
          <span className="field-hint-line">不会联网抓取：检索只用这里贴的正文，没贴正文这篇会索引失败</span>
          {tried && badUrl && <span className="field-err">填一个 http 或 https 开头的网址</span>}
        </>
      )}
      {kind === 'note' && (
        <>
          <Input value={title} invalid={tried && !title.trim()} aria-label="标题" placeholder="标题，比如：远川演示前要确认的事" onChange={(e) => setTitle(e.target.value)} />
          <Textarea rows={5} value={text} invalid={tried && !text.trim()} aria-label="正文" placeholder="直接写；保存后会切段、索引" onChange={(e) => setText(e.target.value)} />
          {tried && (!title.trim() || !text.trim()) && <span className="field-err">标题和正文都要填</span>}
        </>
      )}
      {error && <span className="field-err" role="alert">{error}</span>}
      <div className="kbx-add-line">
        <Button variant="primary" size="sm" disabled={sending} onClick={() => void submit()}>{sending ? '加进去中' : '加进知识库'}</Button>
        <Button size="sm" onClick={onClose}>取消</Button>
      </div>
    </div>
  )
}
