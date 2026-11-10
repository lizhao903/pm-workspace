// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 任务抽屉（SPEC-tasks-4、DEV-07b）：新建、查看、编辑、删除。
// 已有任务以打开那一刻的值为基准：保存只传改过的字段，props 由接口层读回最新的再合并；未保存的改动关闭前先确认。
// 已有任务分成标签（SPEC-tasks-4.35 到 4.41）：基础信息、开发任务、插件登记的标签（SOP）、执行记录，当前标签记在地址 ?tab= 上，
// ?run= / ?sop_run= 定位到某次执行时自动切到那个标签。归类和显示条件在 drawerTabs.ts。
// 待验收时验收是主要动作（PR-07，product-review A-04、C-02）：默认停在「开发任务」，顶上是等你验收栏，再是改动、产出物、进展，开发字段在最后。
// 新建不分标签：基础字段加可展开的开发字段。
import { useId, useState, type CSSProperties, type ReactNode } from 'react'
import {
  errorText, isApiError, useAgents, useArtifactCount, useCreateObject, useDeleteObject, useObject, usePatchObject, useProgress, useStakeholders,
  useTaskRuns, type DictItem, type ObjectStatus, type WorkObject,
} from '../../core/data'
import {
  Button, ConfirmDialog, Drawer, EmptyState, Field, Input, SearchSelect, Tag, Tags, Textarea, cls, type SearchOption,
} from '../../core/ui'
import { ObjectSectionBadge, ObjectSections } from '../../core/shell/extensionHosts'
import { DevSlots, RunsSlot } from './DevSlots'
import { FOCUS_PARAM, HOST_TABS, RUN_PARAM, currentTab, isDevTask, useTaskTabParams, visibleTabs, wantedTab, type HostTab } from './drawerTabs'
import { HandOffButton } from './HandOff'
import { AiBadge } from './OwnerMark'
import { runningOf } from './handoffModel'
import { buildCreate, buildSave, draftOf, emptyDraft, sameDraft, type TaskDraft } from './draft'
import { Markdown } from './Markdown'
import { REVIEW, prioText, timeAgo } from './model'
import { ReviewBar } from './ReviewBar'
import { useLiveRuns } from './runLive'
import { TaskReminders } from './TaskReminders'
import { WorkdirField } from './WorkdirField'

export function TaskDrawer({ task, statuses, priorities, projects, init, returnTo, onClose, onCreated }: {
  /** null 表示新建 */
  task: WorkObject | null
  statuses: ObjectStatus[]
  priorities: DictItem[]
  /** type=project 的对象，选所属项目、算继承的工作目录 */
  projects: WorkObject[]
  /** 新建时预填的字段（项目里新建任务带上所属项目） */
  init?: Partial<TaskDraft>
  /** 插件区块离开抽屉（去 SOP 运行页）后返回的地址，能重新打开这条任务；不给时插件区块退回当前地址 */
  returnTo?: string
  onClose: () => void
  /** 新建成功后切到这条任务 */
  onCreated: (t: WorkObject) => void
}) {
  const creating = !task
  // 基准：已有任务取打开时的值，新建取默认值；之后不跟着刷新，免得把别人刚改的值当成自己的改动
  const [base, setBase] = useState<TaskDraft>(() => (task ? draftOf(task) : { ...emptyDraft(statuses, priorities), ...init }))
  const [d, setD] = useState<TaskDraft>(base)
  const [tried, setTried] = useState(false)
  // 新建时展开开发字段；已有任务上是基础信息里点了「设为开发任务」
  const [devOpen, setDevOpen] = useState(false)
  const [askDelete, setAskDelete] = useState(false)
  const [error, setError] = useState('')

  const people = useStakeholders()
  const agentList = useAgents()
  const live = useObject(task?.id ?? null)
  const artifactN = useArtifactCount(task?.id ?? null)
  const progress = useProgress(task?.id ?? null)
  const runs = useTaskRuns(task?.id ?? '')
  const liveRuns = useLiveRuns()
  const create = useCreateObject()
  const save = usePatchObject()
  const del = useDeleteObject()
  const busy = create.isPending || save.isPending || del.isPending

  const dirty = !sameDraft(d, base)
  const set = (p: Partial<TaskDraft>) => setD((x) => ({ ...x, ...p }))
  const titleBad = tried && !d.title.trim()

  const deleted = !!task && (!!live.data?.deleted_at || isApiError(live.error, 'not_found'))
  const reviewing = !!task && (live.data?.status ?? task.status) === REVIEW
  // 打开时的默认标签：待验收的先看开发任务（验收栏在那里）；验收完状态变了也不跳走
  const [fallbackTab] = useState<HostTab>(() => (reviewing ? 'dev' : 'info'))
  // 验收或退回后状态在后端已改，基准和表单一起跟上，不算未保存的改动
  const reviewed = (status: string) => {
    setBase((b) => ({ ...b, status }))
    setD((x) => ({ ...x, status }))
  }

  // 标签：地址要的、这条任务该有的
  const tabs = useTaskTabParams(task?.type_id ?? 'task')
  const want = wantedTab(tabs.params, tabs.refs)
  const runRows = task ? runs.data ?? [] : []
  const dev = isDevTask({
    acceptance: d.acceptance, workdir: d.workdir, repo: d.repo, opened: devOpen, reviewing,
    progress: progress.data?.length ?? 0, artifacts: artifactN.data ?? 0, runs: runRows.length,
  })
  const visible = visibleTabs(dev, tabs.refs, want)
  const tab = currentTab(want, visible, fallbackTab)
  const plugTab = tabs.plugins.find((p) => p.tab.key === tab)?.tab
  const runFocus = tabs.params.get(RUN_PARAM) || undefined
  const plugFocus = plugTab?.focusParam ? tabs.params.get(plugTab.focusParam) || undefined : undefined
  const running = task ? runningOf(task.id, runs.data, liveRuns) : undefined

  // 关抽屉时把标签参数一起去掉，下次打开别的任务从默认标签开始
  const close = () => {
    tabs.clear()
    onClose()
  }

  const submit = async () => {
    setTried(true)
    if (!d.title.trim()) {
      if (task) tabs.select('info')
      return
    }
    setError('')
    try {
      if (!task) {
        onCreated(await create.mutateAsync(buildCreate(d)))
      } else {
        await save.mutateAsync(buildSave(task, d))
        close()
      }
    } catch (e) {
      setError(errorText(e))
    }
  }
  const remove = async () => {
    if (!task) return
    try {
      await del.mutateAsync(task.id)
      setAskDelete(false)
      close()
    } catch (e) {
      setAskDelete(false)
      setError(errorText(e))
    }
  }

  const statusOpts = withCurrent(statuses.map((s) => ({ key: s.key, label: s.label, title: undefined as string | undefined })), d.status)
  const prioOpts = withCurrent(
    priorities.filter((p) => !p.archived_at || p.key === d.priority).map((p) => ({ key: p.key, label: prioText(p.key, p), title: p.description || undefined })),
    d.priority,
  )
  // AI 成员（TSK-0500）在选项旁标「Agent」/「CLI」；选它只是记录负责人，不发起执行
  const peopleOpts: SearchOption[] = (people.data ?? []).map((s) => ({
    value: s.id, label: s.name, keywords: s.ai_kind ? `${s.email} AI` : s.email,
    hint: s.ai_kind === 'agent' ? 'Agent' : s.ai_kind === 'cli' ? 'CLI' : s.role || undefined,
  }))
  const nameOf = (id: string) =>
    task?.owner_id === id ? task.owner_name : task?.participants.find((p) => p.id === id)?.name
  const ownerSh = (people.data ?? []).find((s) => s.id === d.owner_id)
  const ownerAI = ownerSh?.ai_kind || (task && task.owner_id === d.owner_id ? task.owner_ai_kind : undefined)
  const ownerRef = ownerSh?.ai_ref || (task && task.owner_id === d.owner_id ? task.owner_ai_ref : undefined)
  const ownerName = ownerSh?.name ?? (d.owner_id ? nameOf(d.owner_id) : undefined) ?? ''
  const ownerLook = ownerAI === 'agent' && ownerRef ? agentList.data?.find((a) => a.id === ownerRef) : undefined
  const projectOpts: SearchOption[] = projects.map((p) => ({ value: p.id, label: p.title, hint: p.ref }))
  const project = projects.find((p) => p.id === d.project_id)
  const inherit = project?.workdir ? { project: project.title, dir: project.workdir } : undefined

  const impacts: ReactNode[] = []
  if (task?.link_count) impacts.push(`${task.link_count} 条关联保留，恢复后照常可见`)
  if (askDelete && artifactN.data) impacts.push(`${artifactN.data} 个产出物的登记保留`)
  if (task?.participants.length) impacts.push(`${task.participants.length} 位参与人的手上不再算这条任务`)
  if (task?.owner_id) impacts.push(`负责人「${task.owner_name ?? ''}」手上不再算这条任务`)

  const fields = (
    <>
      <Field label="标题" required error={titleBad ? '必填' : undefined}>
        <Input value={d.title} autoFocus={creating} invalid={titleBad} placeholder="要做的事"
          onChange={(e) => set({ title: e.target.value })} />
      </Field>
      <MdField label="正文" value={d.body} rows={6} placeholder="支持 Markdown" defaultPreview={reviewing}
        onChange={(v) => set({ body: v })} />
      <Field label="状态" wrap={false}>
        <SegPick label="状态" options={statusOpts} value={d.status} onChange={(v) => set({ status: v })} />
      </Field>
      <Field label="优先级" wrap={false}>
        <SegPick label="优先级" options={prioOpts} value={d.priority} onChange={(v) => set({ priority: v })}
          color={(k) => priorities.find((p) => p.key === k)?.color} />
      </Field>
      <div className="field-row">
        <Field label={<>负责人{d.owner_id && ownerAI && <AiBadge kind={ownerAI} name={ownerName} look={ownerLook} />}</>} wrap={false}
          hint={!d.owner_id && task && !task.owner_id && task.owner ? `原来记的是「${task.owner}」，选一位干系人替换`
            : d.owner_id && ownerAI ? '在这里选 Agent / CLI 只是记录负责人，不会发起执行；要它干活用开发任务里的「交给…」' : undefined}>
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
      {task && task.tags.length > 0 && (
        <Field label="标签" wrap={false}>
          <Tags>{task.tags.map((t) => <Tag key={t}>{t}</Tag>)}</Tags>
        </Field>
      )}
    </>
  )
  const devFields = (
    <div className="field-group" role="group" aria-label="开发">
      <div className="mount-head">
        <span className="field-group-title">开发</span>
        <span className="spacer" />
        {task && (
          <HandOffButton task={task} workdir={d.workdir} inherit={inherit}
            onShowRun={(runId) => tabs.select('runs', runId ? { [RUN_PARAM]: runId } : undefined)} />
        )}
      </div>
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
  )
  const times = task && <div className="task-times">{timeAgo(task.created_at)}创建 · {timeAgo(task.updated_at)}更新</div>

  let body
  if (deleted) {
    body = <EmptyState title="这条任务已删除" desc="它已经在回收站里，可以从回收站恢复" />
  } else if (!task) {
    body = (
      <div className="form task-form">
        {fields}
        {devOpen ? devFields : (
          <button type="button" className="dev-open" onClick={() => setDevOpen(true)}>+ 开发信息：验收标准、工作目录，交给 Claude Code 做</button>
        )}
      </div>
    )
  } else {
    const label = (k: string) => HOST_TABS[k as HostTab] ?? tabs.plugins.find((p) => p.tab.key === k)?.tab.label ?? k
    let panel
    if (tab === 'dev') {
      panel = (
        <>
          {reviewing && <ReviewBar task={task} statuses={statuses} acceptance={base.acceptance} onReviewed={reviewed} />}
          {!reviewing && devFields}
          <DevSlots task={task} reviewing={reviewing} focus={tabs.params.get(FOCUS_PARAM) || undefined} />
          {reviewing && devFields}
        </>
      )
    } else if (tab === 'runs') {
      panel = <RunsSlot task={task} focus={runFocus} />
    } else if (plugTab) {
      panel = <ObjectSections object={task} returnTo={returnTo} focus={plugFocus} tab={plugTab.key} />
    } else {
      panel = (
        <>
          {fields}
          <TaskReminders task={task} />
          <ObjectSections object={task} returnTo={returnTo} tab={null} />
          {!dev && (
            <button type="button" className="dev-open" onClick={() => { setDevOpen(true); tabs.select('dev') }}>
              + 设为开发任务：验收标准、工作目录，交给 Claude Code 做
            </button>
          )}
          {times}
        </>
      )
    }
    body = (
      <div className="task-detail">
        <div className="tk-title">{d.title.trim() || base.title || task.title}</div>
        <div className="tk-tabs" role="tablist" aria-label="任务详情">
          {visible.map((k) => {
            const p = tabs.plugins.find((x) => x.tab.key === k)?.tab
            return (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={cls(tab === k && 'on')}
                onClick={() => tabs.select(k)}>
                {label(k)}
                {k === 'dev' && reviewing && <span className="side-dot tab-dot" title="等你验收" />}
                {k === 'runs' && runRows.length > 0 && <span className="seg-n" title={`${runRows.length} 次执行`}>{runRows.length}</span>}
                {k === 'runs' && running !== undefined && <span className="tab-light" title="有执行在跑" />}
                {p?.badge && <ObjectSectionBadge badge={p.badge} object={task} />}
              </button>
            )
          })}
        </div>
        <div role="tabpanel" aria-label={label(tab)} className="form task-form" data-tab={tab}>
          {panel}
        </div>
      </div>
    )
  }

  return (
    <>
      <Drawer open onClose={close} dirty={dirty && !deleted} kicker={task ? task.ref : '新建任务'}
        aria-label={task ? `${task.ref} ${task.title}` : '新建任务'}
        dirtyMessage="有未保存的修改，关闭后会丢掉。"
        footer={(requestClose) => deleted ? (
          <><span className="spacer" /><Button onClick={close}>关闭</Button></>
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

/** Markdown 输入：编辑和预览切换；编辑框高度随内容撑开 */
function MdField({ label, value, onChange, rows, mono, placeholder, defaultPreview }: {
  label: string
  value: string
  onChange: (v: string) => void
  rows: number
  mono?: boolean
  placeholder?: string
  /** 打开时先显示预览 */
  defaultPreview?: boolean
}) {
  const [preview, setPreview] = useState(!!defaultPreview)
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
      {/* 编辑框随内容撑开、不出内部滚动条，rows 是最小高度；预览也完整显示，不截高度 */}
      {preview
        ? <div className="md-preview md-full"><Markdown source={value} empty="还没有写" /></div>
        : <Textarea id={id} rows={rows} autoGrow className={cls(mono && 'mono-area')} value={value} placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)} />}
    </div>
  )
}
