// 设置（SPEC-projects-13）：名称、标志、说明、状态、本地项目目录、关联目录、删除项目。边改边保存，没有「保存」按钮：
// 输入停手片刻存一次，选图标、底色、状态、删关联目录这类一下就定的立即存；离开页面时没存的也存掉。
// 本地项目目录存在对象的 workdir 列上，任务没设工作目录时执行就用它（后端 ResolveWorkdir 向上继承）。
// 文档目录（TSK-0718）存在 props.docs_dir：相对项目目录或绝对路径，写法和控件同本地项目目录；文档标签列它下面的文件。
// 「显示哪些标签」（SPEC-projects-13.19、13.20）：勾掉的标签存进 props.tabs_hidden，详情页不显示；概览、设置一直显示（设置里才开得回来）。
// 同一块里拖动或上移、下移调标签先后，存进 props.tabs_order；概览固定第一、设置固定最后（见 TabPicks）。
// 刚从列表新建、名称还是「新项目」就离开（切标签、回列表、换模块）时，用路由的 useBlocker 拦下来问要不要删（C-05）。
import { useEffect, useRef, useState } from 'react'
import { useBlocker, useLocation, useNavigate } from 'react-router'
import { PROJECT_TYPE, errorText, useDeleteObject, useObjectTypes, useObjects, useSaveProject, type WorkObject } from '../../core/data'
import { useProjectTabs } from '../../core/plugin'
import { Button, IconButton, IconClose, Select } from '../../core/ui'
import { MarkEditor, ProjectMarkView } from './Mark'
import { NEW_PROJECT_NAME, colorOf, diffForm, docsDirAbs, docsDirPick, formOf, isFresh, markText, unmarkFresh, withPluginTabs, type Form } from './model'
import { PathInput } from './PathInput'
import { TabPicks } from './TabPicks'

/** 输入停手多久保存 */
const SAVE_DELAY = 500

export function Settings({ project, onDeleted }: { project: WorkObject; onDeleted: () => void }) {
  const id = project.id
  const types = useObjectTypes()
  const statuses = types.data?.find((t) => t.id === PROJECT_TYPE)?.statuses ?? []
  const save = useSaveProject()
  const del = useDeleteObject()
  const taskTotal = useObjects({ type: ['task'], project: id, limit: 1 })
  const allTabs = withPluginTabs(useProjectTabs())
  const [form, setForm] = useState(() => formOf(project))
  // 名称清空时只改输入框、不存，离开输入框时恢复成原来的名字（SPEC-projects-13.14）
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)
  const saved = useRef(formOf(project))
  const pending = useRef<Form | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { pathname } = useLocation()
  const navigate = useNavigate()
  // 刚新建的项目名称没改过就离开时问一声；挂上时看一次，选了「留着」或删掉、自己删项目时不再拦
  const [fresh] = useState(() => isFresh(id))
  const leaving = useRef(false)
  const emptyRef = useRef(false)
  const empty = fresh && form.name.trim() === NEW_PROJECT_NAME
  useEffect(() => { emptyRef.current = empty }, [empty])
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    !leaving.current && emptyRef.current && currentLocation.pathname !== nextLocation.pathname)
  const askRef = useRef<HTMLElement>(null)
  const blocked = blocker.state === 'blocked'
  useEffect(() => { if (blocked) askRef.current?.scrollIntoView?.({ block: 'nearest' }) }, [blocked])
  const nameRef = useRef<HTMLInputElement>(null)

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
    leaving.current = true
    // 用 mutateAsync：删完刷新会先让详情页换成「不存在」把本组件卸掉，mutate 上挂的回调就不会再调
    del.mutateAsync(id).then(() => { unmarkFresh(id); onDeleted() }, () => { leaving.current = false /* 错误在下面红字显示 */ })
  }
  // 空项目离开时的三个选择（C-05）。删要等接口和刷新，期间详情页可能先换成「不存在」把本组件卸掉，
  // 所以先放开拦截、记下要去哪，删完自己走：还在本项目里就回列表，否则去原本要去的地方
  const base = pathname.replace(/\/settings\/?$/, '')
  const [target, setTarget] = useState<string | null>(null)
  const asking = blocked || target !== null
  const dropEmpty = () => {
    if (timer.current) clearTimeout(timer.current)
    pending.current = null
    const loc = blocker.location
    const to = target ?? (loc ? `${loc.pathname}${loc.search}${loc.hash}` : base)
    if (blocker.state === 'blocked') blocker.reset()
    setTarget(to)
    leaving.current = true
    del.mutateAsync(id).then(() => {
      unmarkFresh(id)
      const path = to.split(/[?#]/)[0]
      if (path === base || path.startsWith(`${base}/`)) onDeleted()
      else void navigate(to)
    }, () => { leaving.current = false })
  }
  const keepEmpty = () => {
    unmarkFresh(id)
    leaving.current = true
    if (blocker.state === 'blocked') blocker.proceed()
    else if (target !== null) void navigate(target)
  }
  const editName = () => {
    if (blocker.state === 'blocked') blocker.reset()
    setTarget(null)
    nameRef.current?.focus()
  }
  const view = { id, name: form.name, color: form.color, mark: form.mark }

  return (
    <div className="pj-settings">
      {asking && (
        <section ref={askRef} className="pj-block pj-danger" role="alertdialog" aria-label="空项目">
          <div className="pj-act-row">
            <span className="pj-danger-text">这个项目还是空的（名称还是「{NEW_PROJECT_NAME}」），要删掉吗？删了进回收站，可以恢复</span>
            <Button size="sm" onClick={editName} disabled={del.isPending}>继续编辑</Button>
            <Button size="sm" onClick={keepEmpty} disabled={del.isPending}>留着</Button>
            <Button size="sm" variant="danger" onClick={dropEmpty} disabled={del.isPending}>删掉</Button>
          </div>
          {del.isError && <span className="field-err" role="alert">没删成：{errorText(del.error)}</span>}
        </section>
      )}
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
            <input ref={nameRef} className={nameDraft !== null ? 'input bad' : 'input'} value={nameDraft ?? form.name} aria-invalid={nameDraft !== null || undefined}
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

      <section className="pj-block" aria-label="文档目录">
        <h2 className="pj-sec-title">文档目录<span className="pj-hint">文档标签列出这里的文档文件（md、docx、pdf 等）；执行任务时告诉 Agent 文档写在这里。相对本地项目目录，也可以填绝对路径</span></h2>
        <PathInput label="文档目录" check value={form.docsDir} placeholder={form.root.trim() ? 'docs' : '/Users/me/projects/xxx/docs'}
          checkAs={(v) => docsDirAbs(v, form.root)} start={docsDirAbs(form.docsDir, form.root) || form.root.trim()}
          pickAs={(dir) => docsDirPick(dir, form.root)} onChange={(docsDir) => update({ docsDir })} />
        {form.docsDir.trim() && !form.docsDir.trim().replace(/^file:\/\//, '').startsWith('/') && !form.root.trim() && (
          <span className="field-err">这是相对路径，要先填上面的本地项目目录，或者改填绝对路径</span>
        )}
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

      <section className="pj-block" aria-label="显示的标签">
        <h2 className="pj-sec-title">显示哪些标签<span className="pj-hint">不勾的标签在这个项目的详情页里不显示，数据不动；拖动或用上移、下移调整顺序；概览和设置一直显示、固定一头一尾</span></h2>
        <TabPicks tabs={allTabs} hidden={form.hidden} order={form.order}
          onHidden={(hidden) => update({ hidden }, 0)} onOrder={(order) => update({ order }, 0)} />
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
            <Button size="sm" variant="outline" className="pj-del-btn" onClick={() => { del.reset(); setConfirmDel(true) }}>删除项目</Button>
          </div>
        )}
        {del.isError && <span className="field-err" role="alert">没删成：{errorText(del.error)}</span>}
      </section>
    </div>
  )
}
