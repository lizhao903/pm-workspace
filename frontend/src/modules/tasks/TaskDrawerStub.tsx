// 任务抽屉的占位：先只读地显示几项字段。新建、编辑、改状态在 DEV-07b，进展时间线在 DEV-08a。
import type { CSSProperties } from 'react'
import { localDay, type DictItem, type ObjectStatus, type WorkObject } from '../../core/api'
import { Drawer, EmptyState, Pill } from '../../core/ui'

export function TaskDrawerStub({ open, task, statuses, priorities, onClose }: {
  open: boolean
  /** null 表示新建 */
  task: WorkObject | null
  statuses: ObjectStatus[]
  priorities: DictItem[]
  onClose: () => void
}) {
  if (!task) {
    return (
      <Drawer open={open} onClose={onClose} kicker="新建任务" aria-label="新建任务">
        <EmptyState compact title="新建任务还没接上" desc="新建、编辑和改状态在下一步（DEV-07b）接入" />
      </Drawer>
    )
  }
  const st = statuses.find((s) => s.key === task.status)
  const pr = priorities.find((p) => p.key === task.priority)
  return (
    <Drawer open={open} onClose={onClose} kicker={task.ref} aria-label={`${task.ref} ${task.title}`}>
      <div className="task-stub">
        <h2 className="task-stub-title">{task.title}</h2>
        <dl className="task-stub-fields">
          <dt>状态</dt>
          <dd><Pill label={st?.label ?? task.status} color={st?.color} /></dd>
          <dt>优先级</dt>
          <dd>
            {task.priority
              ? <span className="prio" style={{ '--c': pr?.color || 'var(--faint)' } as CSSProperties}>{pr?.label ?? task.priority}</span>
              : '-'}
          </dd>
          <dt>负责人</dt>
          <dd>{task.owner_name || task.owner || '未分配'}</dd>
          <dt>截止</dt>
          <dd>{task.due_at ? localDay(new Date(task.due_at)) : '-'}</dd>
          {task.project_title && <><dt>项目</dt><dd>{task.project_title}</dd></>}
        </dl>
        {task.body && <div className="task-stub-body">{task.body}</div>}
        <div className="task-stub-note">编辑、改状态和进展时间线还在开发中</div>
      </div>
    </Drawer>
  )
}
