// 任务标签（SPEC-projects-7）：按 project_id 列出这个项目的任务。任务抽屉和待验收确认经 core/plugin 的「打开对象」
// 拿任务模块登记的那一份，插件不 import 任务模块；在这里新建的任务预填所属项目。
import { Suspense, useMemo, useState } from 'react'
import { errorText, localDay, useAllObjects, useDictItems, useObjectTypes, useSetStatus, type WorkObject } from '../../core/data'
import { useObjectDrawer } from '../../core/plugin'
import { Button, EmptyState, ErrorState, LoadingState, Pill, PrioTag, cls } from '../../core/ui'
import { doneStatus, isOpenStatus, reopenStatus, sortByPriority } from './model'

const PRIORITY_DICT = 'priority'
const REVIEW = 'review'
const TASK = 'task'
const HINT = '在这里新建的任务会自动归到这个项目；其他任务在任务详情里也能改所属项目'

/** 打开的抽屉：objectId 为 null 是新建 */
type TaskOpen = { objectId: string | null } | null

export function TasksTab({ projectId }: { projectId: string }) {
  const types = useObjectTypes()
  const prios = useDictItems(PRIORITY_DICT)
  const tasks = useAllObjects({ type: [TASK], project: projectId })
  const setStatus = useSetStatus()
  const ext = useObjectDrawer(TASK)
  const [all, setAll] = useState(false)
  const [open, onOpen] = useState<TaskOpen>(null)
  const [approving, setApproving] = useState<string | null>(null)
  const [err, setErr] = useState('')

  const statuses = useMemo(() => types.data?.find((t) => t.id === TASK)?.statuses ?? [], [types.data])
  const mine = tasks.data?.data ?? []
  const openN = mine.filter((t) => isOpenStatus(statuses, t.status)).length
  const rows = useMemo(
    () => sortByPriority((tasks.data?.data ?? []).filter((t) => all || isOpenStatus(statuses, t.status)), prios.data ?? []),
    [tasks.data, all, statuses, prios.data],
  )
  const done = doneStatus(statuses)
  const reopen = reopenStatus(statuses)
  const label = (k: string) => statuses.find((s) => s.key === k)?.label ?? k

  // 完成圆圈：已完成的改回待办；待验收的先确认（等于验收通过）；其余标完成。不打开抽屉
  const toggle = (t: WorkObject) => {
    setErr('')
    if (t.status === REVIEW) { setApproving(t.id); return }
    const to = t.status === done ? reopen : done
    if (!to) return
    setStatus.mutate({ id: t.id, status: to }, { onError: (e) => setErr(`${t.ref} 没改成：${errorText(e)}`) })
  }

  const Drawer = ext?.drawer
  const Approve = ext?.approve
  const head = (
    <div className="pj-tab-head">
      <div className="pj-seg" role="group" aria-label="任务范围">
        <button type="button" className={cls(!all && 'on')} aria-pressed={!all} onClick={() => setAll(false)}>未完成<span className="pj-seg-n">{openN}</span></button>
        <button type="button" className={cls(all && 'on')} aria-pressed={all} onClick={() => setAll(true)}>全部<span className="pj-seg-n">{mine.length}</span></button>
      </div>
      <span className="spacer" />
      <Button variant="primary" disabled={!Drawer} title={Drawer ? undefined : '任务模块没有加载'} onClick={() => onOpen({ objectId: null })}>新建任务</Button>
    </div>
  )

  let body
  if (tasks.isError) body = <ErrorState title="任务没加载出来" error={errorText(tasks.error)} onRetry={() => void tasks.refetch()} />
  else if (tasks.isPending || types.isPending) body = <LoadingState />
  else if (!rows.length) {
    body = all
      ? <EmptyState title="这个项目还没有任务" desc={HINT} action={Drawer && <Button variant="primary" onClick={() => onOpen({ objectId: null })}>新建任务</Button>} />
      : <EmptyState title="没有未完成的任务" desc={HINT} action={<Button onClick={() => setAll(true)}>看全部</Button>} />
  } else {
    body = (
      <div className="pj-table" role="list" aria-label="项目任务">
        {rows.map((t) => {
          const isDone = t.status === done
          const tip = isDone ? `标为${label(reopen ?? 'todo')}` : t.status === REVIEW ? '验收通过' : `标为${label(done ?? 'done')}`
          const pr = prios.data?.find((p) => p.key === t.priority)
          const st = statuses.find((s) => s.key === t.status)
          return (
            <div key={t.id} role="listitem" className={cls('pj-task', !isOpenStatus(statuses, t.status) && 'is-done')}
              tabIndex={Drawer ? 0 : undefined} aria-label={`${t.ref} ${t.title}`}
              onClick={() => Drawer && onOpen({ objectId: t.id })}
              onKeyDown={(e) => { if (Drawer && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen({ objectId: t.id }) } }}>
              <button type="button" className={cls('pj-check', isDone && 'on')} title={tip} aria-label={`${tip}：${t.ref}`}
                disabled={t.status === REVIEW && !Approve}
                onClick={(e) => { e.stopPropagation(); toggle(t) }} onKeyDown={(e) => e.stopPropagation()} />
              <PrioTag p={t.priority || '-'} item={pr} />
              <span className="pj-ref">{t.ref}</span>
              <span className="ellipsis pj-task-title">{t.title}</span>
              <span className="pj-muted pj-task-owner">{t.owner_name || '未分配'}</span>
              <span className="pj-muted pj-task-due">{t.due_at ? localDay(new Date(t.due_at)) : '-'}</span>
              <Pill label={st?.label ?? t.status} color={st?.color} />
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="pj-tab">
      {head}
      {err && <div className="pj-err" role="alert">{err}</div>}
      {body}
      <Suspense fallback={null}>
        {open && Drawer && (
          <Drawer key={open.objectId ?? 'new'} objectId={open.objectId} init={{ project_id: projectId }} onClose={() => onOpen(null)} />
        )}
        {approving && Approve && (
          <Approve objectId={approving} onClose={() => setApproving(null)} onOpen={() => { onOpen({ objectId: approving }); setApproving(null) }} />
        )}
      </Suspense>
    </div>
  )
}
