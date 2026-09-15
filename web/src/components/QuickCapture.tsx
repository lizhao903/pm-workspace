// 快速捕获：对标 GTD 的三秒录入，提交后弹窗不关、清空标题继续录。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspace } from '../hooks/workspace'
import {
  Button, CategoryPicker, Field, Modal, PRIORITIES, Select, TagChip, TextArea, TextInput,
  useCategoryTree,
} from './ui'
import '../views.css'

const LAST_TYPE_KEY = 'pm.quick-capture.last-type'

export default function QuickCapture() {
  const { quickCaptureOpen, setQuickCaptureOpen } = useWorkspace()
  if (!quickCaptureOpen) return null
  return <Capture onClose={() => setQuickCaptureOpen(false)} />
}

function Capture({ onClose }: { onClose: () => void }) {
  const { types, nav, createObject } = useWorkspace()

  const [typeId, setTypeId] = useState<string>('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [priority, setPriority] = useState('')
  const [due, setDue] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justCreated, setJustCreated] = useState<string | null>(null)

  const titleRef = useRef<HTMLInputElement | null>(null)
  const categories = useCategoryTree(typeId)

  // 默认类型：上次用过的 > 当前导航类型 > 第一个类型
  useEffect(() => {
    if (typeId || types.length === 0) return
    const last = window.localStorage.getItem(LAST_TYPE_KEY)
    const fallback = types.find((t) => t.id === nav.typeId)?.id ?? types[0].id
    setTypeId(last && types.some((t) => t.id === last) ? last : fallback)
  }, [typeId, types, nav.typeId])

  useEffect(() => { titleRef.current?.focus() }, [])

  const pickType = useCallback((id: string) => {
    setTypeId(id)
    setCategoryId(null) // 分类挂在类型下，换类型必须清空
    window.localStorage.setItem(LAST_TYPE_KEY, id)
  }, [])

  const addTag = () => {
    const v = tagInput.trim()
    if (!v || tags.includes(v)) { setTagInput(''); return }
    setTags([...tags, v])
    setTagInput('')
  }

  const canSubmit = useMemo(() => title.trim() !== '' && typeId !== '' && !busy, [title, typeId, busy])

  const submit = useCallback(async () => {
    if (title.trim() === '' || !typeId || busy) return
    setBusy(true); setError(null)
    try {
      const created = await createObject({
        type_id: typeId,
        title: title.trim(),
        body: body.trim() || undefined,
        category_id: categoryId,
        priority: priority || undefined,
        due_at: due ? new Date(`${due}T23:59:59`).toISOString() : null,
        tags: tags.length > 0 ? tags : undefined,
        // 没指定分类就丢进收件箱，后面再归类
        source: categoryId ? undefined : 'inbox',
      })
      setJustCreated(created.ref)
      setTitle(''); setBody(''); setTagInput('')
      titleRef.current?.focus()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [title, typeId, busy, body, categoryId, priority, due, tags, createObject])

  return (
    <Modal
      open
      title="快速捕获"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <span className="faint v-qc-hint">
            {justCreated ? `已创建 ${justCreated}` : <>按 <span className="kbd">Cmd</span>+<span className="kbd">Enter</span> 提交，<span className="kbd">Esc</span> 关闭</>}
          </span>
          <div className="v-toolbar-spacer" />
          <Button onClick={onClose} disabled={busy}>关闭</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? '创建中…' : '创建'}
          </Button>
        </>
      }
    >
      <div
        className="v-qc"
        role="presentation"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void submit() }
        }}
      >
        {error ? <div className="error-banner">{error}</div> : null}

        <div className="seg v-qc-types">
          {types.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`seg-item ${t.id === typeId ? 'seg-item-active' : ''}`.trim()}
              onClick={() => pickType(t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>

        <Field label="标题" htmlFor="qc-title">
          <TextInput
            id="qc-title"
            ref={titleRef}
            value={title}
            placeholder="想到什么先记下来…"
            onValueChange={(v) => { setTitle(v); if (justCreated) setJustCreated(null) }}
          />
        </Field>

        <div className="form-row">
          <Field label="分类" htmlFor="qc-cat">
            <CategoryPicker id="qc-cat" categories={categories} value={categoryId} onChange={setCategoryId} />
          </Field>
          <Field label="优先级" htmlFor="qc-pri">
            <Select
              id="qc-pri"
              value={priority}
              onValueChange={setPriority}
              options={[{ value: '', label: '未设置' }, ...PRIORITIES.map((p) => ({ value: p, label: p }))]}
            />
          </Field>
        </div>

        <Field label="到期" htmlFor="qc-due">
          <input id="qc-due" type="date" className="input" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>

        <Field label="标签">
          <div className="v-tag-list">
            {tags.map((t) => <TagChip key={t} name={t} onRemove={() => setTags(tags.filter((x) => x !== t))} />)}
          </div>
          <TextInput
            value={tagInput}
            placeholder="回车添加标签"
            onValueChange={setTagInput}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
          />
        </Field>

        <Field label="正文（可选）">
          <TextArea rows={3} value={body} onValueChange={setBody} placeholder="补充背景、链接、原文…" />
        </Field>
      </div>
    </Modal>
  )
}
