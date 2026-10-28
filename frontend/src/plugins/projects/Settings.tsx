// 设置（SPEC-projects-13）：名称、标志、说明、状态、本地项目目录、关联目录、删除项目。边改边保存，没有「保存」按钮：
// 输入停手片刻存一次，选图标、底色、状态、删关联目录这类一下就定的立即存；离开页面时没存的也存掉。
// 本地项目目录存在对象的 workdir 列上，任务没设工作目录时执行就用它（后端 ResolveWorkdir 向上继承）。
import { useEffect, useRef, useState } from 'react'
import { PROJECT_TYPE, errorText, useDeleteObject, useObjectTypes, useObjects, useSaveProject, type WorkObject } from '../../core/data'
import { Button, IconButton, IconClose, Select } from '../../core/ui'
import { MarkEditor, ProjectMarkView } from './Mark'
import { colorOf, diffForm, formOf, markText, type Form } from './model'
import { PathInput } from './PathInput'

/** 输入停手多久保存 */
const SAVE_DELAY = 500

export function Settings({ project, onDeleted }: { project: WorkObject; onDeleted: () => void }) {
  const id = project.id
  const types = useObjectTypes()
  const statuses = types.data?.find((t) => t.id === PROJECT_TYPE)?.statuses ?? []
  const save = useSaveProject()
  const del = useDeleteObject()
  const taskTotal = useObjects({ type: ['task'], project: id, limit: 1 })
  const [form, setForm] = useState(() => formOf(project))
  // 名称清空时只改输入框、不存，离开输入框时恢复成原来的名字（SPEC-projects-13.14）
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)
  const saved = useRef(formOf(project))
  const pending = useRef<Form | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const f = pending.current
    pending.current = null
    if (!f) return
    const { patch, props } = diffForm(f, saved.current)
    if (!Object.keys(patch).length && !Object.keys(props).length) return
    const prev = saved.current
    // 先记成已存，连着改不会重复发同一处；失败时退回，重试再发
    saved.current = { ...f, name: patch.title ?? prev.name }
    save.mutate({ id, patch, props }, { onError: () => { saved.current = prev } })
  }
  const flushRef = useRef(flush)
  useEffect(() => { flushRef.current = flush })
  // 离开设置标签（切标签、回列表）时把没存的存掉
  useEffect(() => () => flushRef.current(), [])

  const update = (x: Partial<Form>, delay = SAVE_DELAY) => {
    const next = { ...form, ...x }
    setForm(next)
    pending.current = next
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => flushRef.current(), delay)
  }
  const retry = () => { pending.current = form; flush() }

  const n = taskTotal.data?.total ?? 0
  const impact = n ? `；${n} 个任务还挂在这个项目下，记录保留` : ''
  const doDelete = () => {
    if (timer.current) clearTimeout(timer.current)
    pending.current = null
    // 用 mutateAsync：删完刷新会先让详情页换成「不存在」把本组件卸掉，mutate 上挂的回调就不会再调
    del.mutateAsync(id).then(onDeleted, () => { /* 错误在下面红字显示 */ })
  }
  const view = { id, name: form.name, color: form.color, mark: form.mark }

  return (
    <div className="pj-settings">
      <div className="pj-save-state" aria-live="polite">
        {save.isError ? (
          <span className="field-err" role="alert">没保存上：{errorText(save.error)} <button type="button" className="pj-link" onClick={retry}>重试</button></span>
        ) : save.isPending ? <span className="pj-muted">保存中</span> : save.isSuccess ? <span className="pj-muted">已保存</span> : null}
      </div>

      <section className="pj-block" aria-label="基本信息">
        <h2 className="pj-sec-title">基本信息</h2>
        <div className="pj-name-row">
          <MarkEditor mark={form.mark} color={colorOf(view)} textPlaceholder={markText({ name: form.name, mark: { text: '' } })}
            onMark={(mark) => update({ mark }, 0)} onColor={(color) => update({ color }, 0)}>
            <ProjectMarkView p={view} size={48} />
          </MarkEditor>
          <label className="field pj-grow">
            <span className="field-label">名称</span>
            <input className={nameDraft !== null ? 'input bad' : 'input'} value={nameDraft ?? form.name} aria-invalid={nameDraft !== null || undefined}
              onChange={(e) => {
                const v = e.target.value
                if (v.trim()) { setNameDraft(null); update({ name: v }) } else setNameDraft(v)
              }}
              onBlur={() => setNameDraft(null)} />
            {nameDraft !== null && <span className="field-err">名称必填；不填的话离开输入框时恢复成「{form.name}」</span>}
          </label>
          {statuses.length > 0 && (
            <label className="field pj-status">
              <span className="field-label">状态</span>
              <Select value={form.status} options={statuses.map((s) => ({ value: s.key, label: s.label }))} onValueChange={(status) => update({ status }, 0)} />
            </label>
          )}
        </div>
        <label className="field">
          <span className="field-label">说明</span>
          <input className="input" value={form.desc} placeholder="一句话说明这个项目" onChange={(e) => update({ desc: e.target.value })} />
        </label>
      </section>

      <section className="pj-block" aria-label="本地项目目录">
        <h2 className="pj-sec-title">本地项目目录<span className="pj-hint">原型、文件类材料和文档的路径都相对它；任务没设工作目录时用它</span></h2>
        <PathInput label="本地项目目录" check value={form.root} placeholder="/Users/me/projects/xxx" onChange={(root) => update({ root })} />
      </section>

      <section className="pj-block" aria-label="关联目录">
        <div className="pj-block-head">
          <h2 className="pj-sec-title">关联目录<span className="pj-hint">和这个项目相关、但不在项目目录里的地方：设计稿、客户资料、别的仓库</span></h2>
          <Button size="sm" variant="outline" onClick={() => update({ related: [...form.related, { path: '', label: '' }] }, 0)}>加一个</Button>
        </div>
        {form.related.map((r, i) => (
          <div key={i} className="pj-related-row">
            <input className="input" value={r.label} placeholder="名称" aria-label={`关联目录 ${i + 1} 名称`}
              onChange={(e) => update({ related: form.related.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)) })} />
            <PathInput label={`关联目录 ${i + 1} 路径`} value={r.path} placeholder="/Volumes/..."
              onChange={(v) => update({ related: form.related.map((y, j) => (j === i ? { ...y, path: v } : y)) })} />
            <IconButton label="删除这个关联目录" onClick={() => update({ related: form.related.filter((_, j) => j !== i) }, 0)}><IconClose size={11} /></IconButton>
          </div>
        ))}
        {!form.related.length && <div className="pj-block-empty">没有关联目录</div>}
      </section>

      <section className="pj-block pj-danger" aria-label="删除项目">
        <h2 className="pj-sec-title">删除项目</h2>
        {confirmDel ? (
          <div className="pj-act-row">
            <span className="pj-danger-text">只删项目记录，本地目录和文件不动；项目进回收站，可以恢复{impact}</span>
            <Button size="sm" onClick={() => setConfirmDel(false)} disabled={del.isPending}>取消</Button>
            <Button size="sm" variant="danger" onClick={doDelete} disabled={del.isPending}>删除</Button>
          </div>
        ) : (
          <div className="pj-act-row">
            <span className="pj-muted">本地目录和文件不会被删</span>
            <Button size="sm" variant="danger-ghost" onClick={() => { del.reset(); setConfirmDel(true) }}>删除项目</Button>
          </div>
        )}
        {del.isError && <span className="field-err" role="alert">没删成：{errorText(del.error)}</span>}
      </section>
    </div>
  )
}
