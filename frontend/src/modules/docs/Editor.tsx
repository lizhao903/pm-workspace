// 文档的新建和编辑（SPEC-library-1.40 到 1.50，C-03）：在阅读区位置换成编辑区，标题、分类、正文；正文的编辑和预览切换照任务抽屉的描述。
// 已有文档以打开那一刻的值为基准，保存只传改过的字段，后端逐字段记修订。是否有没保存的改动报给页面，离开前由页面确认。
import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import { errorText, isApiError, useCreateObject, usePatchObject, type Category, type WorkObject } from '../../core/data'
import { Button, Input, Markdown, Select, Textarea, cls } from '../../core/ui'
import { categoryOptions, docPatch, draftOfObject, sameDocDraft, type DocDraft } from './model'

/** 新建时的来源：手动（契约「任务来源」） */
const MANUAL = 'manual'

function saveError(e: unknown) {
  return isApiError(e, 'not_found') ? '这篇文档已经不在了' : errorText(e)
}

export function DocEditor({ doc, cats, defaultCat, onSaved, onCancel, onDirty }: {
  /** null 表示新建 */
  doc: WorkObject | null
  cats: Category[]
  /** 新建时的默认分类 */
  defaultCat: string
  onSaved: (id: string) => void
  /** 页面决定要不要先确认 */
  onCancel: () => void
  onDirty: (dirty: boolean) => void
}) {
  const [base] = useState<DocDraft>(() => (doc ? draftOfObject(doc) : { title: '', category: defaultCat, body: '' }))
  const [d, setD] = useState<DocDraft>(base)
  const [preview, setPreview] = useState(false)
  const [tried, setTried] = useState(false)
  const [error, setError] = useState('')
  const create = useCreateObject()
  const save = usePatchObject()
  const busy = create.isPending || save.isPending
  const bodyId = useId()

  const dirty = !sameDocDraft(d, base)
  const titleBad = tried && !d.title.trim()
  const set = (p: Partial<DocDraft>) => setD((x) => ({ ...x, ...p }))

  useEffect(() => {
    onDirty(dirty)
  }, [dirty, onDirty])
  useEffect(() => () => onDirty(false), [onDirty])

  const submit = async () => {
    if (busy) return
    setTried(true)
    if (!d.title.trim()) return
    setError('')
    try {
      if (!doc) {
        const o = await create.mutateAsync({ type_id: 'doc', title: d.title.trim(), body: d.body, category_id: d.category || null, source: MANUAL })
        onSaved(o.id)
      } else {
        const patch = docPatch(base, d)
        if (Object.keys(patch).length) await save.mutateAsync({ id: doc.id, patch })
        onSaved(doc.id)
      }
    } catch (e) {
      setError(`没保存上：${saveError(e)}`)
    }
  }

  // Ctrl / Cmd + S 保存（SPEC-library-1.45）
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="lib-reader">
      <div className="reader-grid">
        <form className="reader lib-editor" aria-label={doc ? `编辑「${doc.title}」` : '新建文档'} onKeyDown={onKey}
          onSubmit={(e) => { e.preventDefault(); void submit() }}>
          <div className="reader-toolbar">
            <span className="lib-cat">{doc ? '编辑文档' : '新建文档'}</span>
            <span className="spacer" />
            <Button type="button" onClick={onCancel} disabled={busy}>取消</Button>
            <Button type="submit" variant="primary" disabled={busy}>{busy ? '正在保存…' : '保存'}</Button>
          </div>
          {error && <div className="lib-file-note lib-file-err" role="alert">{error}</div>}
          <div className="lib-editor-head">
            <Input aria-label="标题" className="lib-editor-title" placeholder="标题" value={d.title} invalid={titleBad}
              autoFocus={!doc} onChange={(e) => set({ title: e.target.value })} />
            <Select aria-label="分类" className="lib-editor-cat" value={d.category} options={categoryOptions(cats)}
              onValueChange={(category) => set({ category })} />
          </div>
          {titleBad && <div className="lib-editor-bad" role="alert">标题不能空</div>}
          <div className="lib-editor-body">
            <div className="md-head">
              <label className="field-label" htmlFor={bodyId}>正文</label>
              <span className="spacer" />
              <div className="seg seg-sm" role="group" aria-label="正文的显示方式">
                <button type="button" className={cls(!preview && 'on')} aria-pressed={!preview} onClick={() => setPreview(false)}>编辑</button>
                <button type="button" className={cls(preview && 'on')} aria-pressed={preview} onClick={() => setPreview(true)}>预览</button>
              </div>
            </div>
            {preview
              ? <div className="lib-editor-preview"><Markdown source={d.body} top={2} empty="还没有写" /></div>
              : <Textarea id={bodyId} rows={22} className="lib-editor-text" value={d.body} autoFocus={!!doc}
                  placeholder="支持 # 标题、- 列表、1. 有序列表、> 引用、``` 代码块、**粗体**、`行内代码`"
                  onChange={(e) => set({ body: e.target.value })} />}
          </div>
        </form>
      </div>
    </div>
  )
}
