// 任务抽屉（SPEC-tasks-4、DEV-07b）：新建、查看、编辑、删除。
// 已有任务以打开那一刻的值为基准：保存只传改过的字段，props 由接口层读回最新的再合并；未保存的改动关闭前先确认。
import { useId, useState, type CSSProperties, type ReactNode } from 'react'
import { isApiError, type DictItem, type ObjectStatus, type WorkObject } from '../../core/api'
import {
  useArtifactCount, useCreateObject, useDeleteObject, useObject, useSaveObject, useStakeholders,
} from '../../core/api/taskEdit'
import {
  Button, ConfirmDialog, Drawer, EmptyState, Field, Input, SearchSelect, Textarea, cls, type SearchOption,
} from '../../core/ui'
import { DevSlots } from './DevSlots'
import { buildCreate, buildSave, draftOf, emptyDraft, sameDraft, type TaskDraft } from './draft'
import { Markdown } from './Markdown'
import { REVIEW, timeAgo } from './model'
import { ReviewBar } from './ReviewBar'
import { WorkdirField } from './WorkdirField'

export function TaskDrawer({ task, statuses, priorities, projects, onClose, onCreated }: {
  /** null 表示新建 */
  task: WorkObject | null
  statuses: ObjectStatus[]
  priorities: DictItem[]
  /** type=project 的对象，选所属项目、算继承的工作目录 */
  projects: WorkObject[]
  onClose: () => void
  /** 新建成功后切到这条任务 */
  onCreated: (t: WorkObject) => void
}) {
  const creating = !task
  // 基准：已有任务取打开时的值，新建取默认值；之后不跟着刷新，免得把别人刚改的值当成自己的改动
  const [base, setBase] = useState<TaskDraft>(() => (task ? draftOf(task) : emptyDraft(statuses, priorities)))
  const [d, setD] = useState<TaskDraft>(base)
  const [tried, setTried] = useState(false)
  const [devOpen, setDevOpen] = useState(!creating)
  const [askDelete, setAskDelete] = useState(false)
  const [error, setError] = useState('')

  const people = useStakeholders()
  const live = useObject(task?.id ?? null)
  const artifactN = useArtifactCount(askDelete && task ? task.id : null)
  const create = useCreateObject()
  const save = useSaveObject()
  const del = useDeleteObject()
  const busy = create.isPending || save.isPending || del.isPending

  const dirty = !sameDraft(d, base)
  const set = (p: Partial<TaskDraft>) => setD((x) => ({ ...x, ...p }))
  const titleBad = tried && !d.title.trim()

  const deleted = !!task && (!!live.data?.deleted_at || isApiError(live.error, 'not_found'))
  const reviewing = !!task && (live.data?.status ?? task.status) === REVIEW
  // 验收或退回后状态在后端已改，基准和表单一起跟上，不算未保存的改动
  const reviewed = (status: string) => {
    setBase((b) => ({ ...b, status }))
    setD((x) => ({ ...x, status }))
  }

  const submit = async () => {
    setTried(true)
    if (!d.title.trim()) return
    setError('')
    try {
      if (!task) {
        onCreated(await create.mutateAsync(buildCreate(d)))
      } else {
        await save.mutateAsync(buildSave(task, d))
        onClose()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const remove = async () => {
    if (!task) return
    try {
      await del.mutateAsync(task.id)
      setAskDelete(false)
      onClose()
    } catch (e) {
      setAskDelete(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const statusOpts = withCurrent(statuses.map((s) => ({ key: s.key, label: s.label, title: undefined as string | undefined })), d.status)
  const prioOpts = withCurrent(
    priorities.filter((p) => !p.archived_at || p.key === d.priority).map((p) => ({ key: p.key, label: p.label, title: p.description || undefined })),
    d.priority,
  )
  const peopleOpts: SearchOption[] = (people.data ?? []).map((s) => ({ value: s.id, label: s.name, hint: s.role || undefined, keywords: s.email }))
  const nameOf = (id: string) =>
    task?.owner_id === id ? task.owner_name : task?.participants.find((p) => p.id === id)?.name
  const projectOpts: SearchOption[] = projects.map((p) => ({ value: p.id, label: p.title, hint: p.ref }))
  const project = projects.find((p) => p.id === d.project_id)
  const inherit = project?.workdir ? { project: project.title, dir: project.workdir } : undefined

  const impacts: ReactNode[] = []
  if (task?.link_count) impacts.push(`${task.link_count} 条关联保留，恢复后照常可见`)
  if (artifactN.data) impacts.push(`${artifactN.data} 个产出物的登记保留`)
  if (task?.participants.length) impacts.push(`${task.participants.length} 位参与人的手上不再算这条任务`)
  if (task?.owner_id) impacts.push(`负责人「${task.owner_name ?? ''}」手上不再算这条任务`)

  let body
  if (deleted) {
    body = <EmptyState title="这条任务已删除" desc="它已经在回收站里，可以从回收站恢复" />
  } else {
    body = (
      <div className="form task-form">
        {task && reviewing && <ReviewBar task={task} statuses={statuses} onReviewed={reviewed} />}
        <Field label="标题" required error={titleBad ? '必填' : undefined}>
          <Input value={d.title} autoFocus={creating} invalid={titleBad} placeholder="要做的事"
            onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <MdField label="正文" value={d.body} rows={5} placeholder="支持 Markdown" onChange={(v) => set({ body: v })} />
        <Field label="状态" wrap={false}>
          <SegPick label="状态" options={statusOpts} value={d.status} onChange={(v) => set({ status: v })} />
        </Field>
        <Field label="优先级" wrap={false}>
          <SegPick label="优先级" options={prioOpts} value={d.priority} onChange={(v) => set({ priority: v })}
            color={(k) => priorities.find((p) => p.key === k)?.color} />
        </Field>
        <div className="field-row">
          <Field label="负责人" wrap={false}
            hint={!d.owner_id && task && !task.owner_id && task.owner ? `原来记的是「${task.owner}」，选一位干系人替换` : undefined}>
            <SearchSelect variant="field" aria-label="负责人" value={d.owner_id} noneLabel="未分配" placeholder="未分配"
              searchPlaceholder="搜干系人" options={peopleOpts} emptyText={people.isPending ? '加载中' : '名册里还没有人'}
              missingLabel={(id) => nameOf(id) ?? '已归档的干系人'} onChange={(v) => set({ owner_id: v })} />
          </Field>
          <Field label="截止日期">
            <Input type="date" value={d.due} onChange={(e) => set({ due: e.target.value })} />
          </Field>
        </div>
        <Field label="参与人" wrap={false}>
          <SearchSelect variant="field" multiple aria-label="参与人" value={d.participant_ids} placeholder="没有参与人"
            searchPlaceholder="搜干系人" options={peopleOpts} missingLabel={(id) => nameOf(id) ?? '已归档的干系人'}
            onChange={(v) => set({ participant_ids: v })} />
        </Field>
        <Field label="所属项目" wrap={false}>
          <SearchSelect variant="field" aria-label="所属项目" value={d.project_id} noneLabel="不属于项目" placeholder="不属于项目"
            searchPlaceholder="搜项目" options={projectOpts} missingLabel={() => task?.project_title ?? '已删除的项目'}
            onChange={(v) => set({ project_id: v })} />
        </Field>
        {devOpen ? (
          <div className="field-group">
            <div className="mount-head"><span className="field-group-title">开发</span></div>
            <MdField label="验收标准" value={d.acceptance} rows={4} mono placeholder="- [ ] 一条一行，写成能检查的样子"
              onChange={(v) => set({ acceptance: v })} />
            <div className="field-row">
              <WorkdirField value={d.workdir} onChange={(v) => set({ workdir: v })} inherit={inherit} />
              <Field label="关联仓库">
                <Input className="mono-input" value={d.repo} placeholder="远端地址或本机路径，只放一个"
                  onChange={(e) => set({ repo: e.target.value })} />
              </Field>
            </div>
          </div>
        ) : (
          <button type="button" className="dev-open" onClick={() => setDevOpen(true)}>+ 开发信息：验收标准、工作目录，交给 Claude Code 做</button>
        )}
        {task && <div className="task-times">{timeAgo(task.created_at)}创建 · {timeAgo(task.updated_at)}更新</div>}
        {task && <DevSlots task={task} />}
      </div>
    )
  }

  return (
    <>
      <Drawer open onClose={onClose} dirty={dirty && !deleted} kicker={task ? task.ref : '新建任务'}
        aria-label={task ? `${task.ref} ${task.title}` : '新建任务'}
        dirtyMessage="有未保存的修改，关闭后会丢掉。"
        footer={(requestClose) => deleted ? (
          <><span className="spacer" /><Button onClick={onClose}>关闭</Button></>
        ) : (
          <>
            {task && <Button variant="danger-ghost" disabled={busy} onClick={() => setAskDelete(true)}>删除任务</Button>}
            <span className="spacer" />
            {error && <span className="field-err task-save-err" role="alert">没保存成功：{error}</span>}
            <Button onClick={requestClose}>取消</Button>
            <Button variant="primary" disabled={busy} onClick={() => void submit()}>{creating ? '创建任务' : '保存'}</Button>
          </>
        )}>
        {body}
      </Drawer>
      {task && (
        <ConfirmDialog open={askDelete} danger title={`删除 ${task.ref}？`} confirmLabel="删除" busy={del.isPending}
          impacts={impacts} onCancel={() => setAskDelete(false)} onConfirm={() => void remove()}>
          「{task.title}」会移到回收站，可以从回收站恢复。
        </ConfirmDialog>
      )}
    </>
  )
}

type SegOption = { key: string; label: string; title?: string }

/** 当前值已被停用或删除时仍留在选项里 */
function withCurrent(opts: SegOption[], cur: string): SegOption[] {
  return !cur || opts.some((o) => o.key === cur) ? opts : [...opts, { key: cur, label: cur, title: '已停用的取值' }]
}

function SegPick({ label, options, value, onChange, color }: {
  label: string
  options: SegOption[]
  value: string
  onChange: (v: string) => void
  color?: (key: string) => string | undefined
}) {
  return (
    <div className="seg seg-full" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.key} type="button" role="radio" aria-checked={value === o.key} title={o.title}
          className={cls(value === o.key && 'on')} onClick={() => onChange(o.key)}
          style={color ? { '--c': color(o.key) || 'var(--faint)' } as CSSProperties : undefined}>
          {color && <span className="seg-dot" aria-hidden="true" />}{o.label}
        </button>
      ))}
    </div>
  )
}

/** Markdown 输入：编辑和预览切换 */
function MdField({ label, value, onChange, rows, mono, placeholder }: {
  label: string
  value: string
  onChange: (v: string) => void
  rows: number
  mono?: boolean
  placeholder?: string
}) {
  const [preview, setPreview] = useState(false)
  const id = useId()
  return (
    <div className="field">
      <div className="md-head">
        <label className="field-label" htmlFor={id}>{label}</label>
        <span className="spacer" />
        <div className="seg seg-sm" role="group" aria-label={`${label}的显示方式`}>
          <button type="button" className={cls(!preview && 'on')} aria-pressed={!preview} onClick={() => setPreview(false)}>编辑</button>
          <button type="button" className={cls(preview && 'on')} aria-pressed={preview} onClick={() => setPreview(true)}>预览</button>
        </div>
      </div>
      {preview
        ? <div className="md-preview"><Markdown source={value} empty="还没有写" /></div>
        : <Textarea id={id} rows={rows} className={cls(mono && 'mono-area')} value={value} placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)} />}
    </div>
  )
}
