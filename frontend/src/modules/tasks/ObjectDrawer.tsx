// 给插件和别的模块用的任务抽屉、待验收确认（PJ-01d）：经 core/plugin 的「打开对象」登记，按 id 打开。
// 状态、优先级、项目列表在这里自己取，调用方只给 id 和新建时的预填。
import { useState } from 'react'
import type { ObjectApproveProps, ObjectDrawerProps } from '../../core/plugin'
import { useAllObjects, useApprove, useDictItems, useObject, useObjectTypes } from '../../core/data'
import { ApproveDialog } from './ApproveDialog'
import { doneKey } from './model'
import { TaskDrawer } from './TaskDrawer'
import './tasks.css'

const PRIORITY_DICT = 'priority'

function useTaskMeta() {
  const types = useObjectTypes()
  const prios = useDictItems(PRIORITY_DICT)
  const statuses = types.data?.find((t) => t.id === 'task')?.statuses ?? []
  return { ready: !!types.data && !!prios.data, statuses, priorities: prios.data ?? [] }
}

export default function ObjectDrawer({ objectId, init, onClose }: ObjectDrawerProps) {
  // 新建成功后切到新建出来的那条
  const [id, setId] = useState(objectId)
  const meta = useTaskMeta()
  const projects = useAllObjects({ type: ['project'], sort: 'title' })
  const task = useObject(id)
  if (!meta.ready || !projects.data || (id && !task.data && !task.isError)) return null
  // 打开时就取不到（已经删了）：不弹抽屉
  if (id && !task.data) return null
  return (
    <TaskDrawer key={id ?? 'new'} task={id ? task.data! : null} statuses={meta.statuses} priorities={meta.priorities}
      projects={projects.data.data} init={init} onClose={onClose} onCreated={(t) => setId(t.id)} />
  )
}

export function ObjectApprove({ objectId, onOpen, onClose }: ObjectApproveProps) {
  const meta = useTaskMeta()
  const task = useObject(objectId)
  const approve = useApprove()
  if (!meta.ready || !task.data) return null
  const done = doneKey(meta.statuses)
  return (
    <ApproveDialog task={task.data} busy={approve.isPending} error={approve.isError ? approve.error.message : undefined}
      onCancel={onClose} onOpen={onOpen}
      onApprove={() => { if (done) approve.mutate({ id: objectId, status: done }, { onSuccess: onClose }) }} />
  )
}
