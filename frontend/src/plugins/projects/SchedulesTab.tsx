// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 定时任务标签：属于这个项目的定时任务（schedules.project_id，0055）。
// 编辑和新建都去任务模块的定时任务页（/tasks/schedules），插件不 import 任务模块：
// 点一条 ?open=<id> 打开它，「新建定时任务」?project=<id>&new=1 打开新建抽屉并预填所属项目，「在定时任务页看」按这个项目筛。
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useProjectSchedules, type Schedule } from '../../core/data'
import { Button, EmptyState, ErrorState, LoadingState, cls, describeScheduleRule, fullScheduleRule, scheduleWhenText } from '../../core/ui'

const SCHEDULES_PATH = '/tasks/schedules'

export function SchedulesTab({ projectId }: { projectId: string }) {
  const navigate = useNavigate()
  const list = useProjectSchedules(projectId)
  // 「现在」取标签打开那一刻，渲染里不直接 new Date()
  const [now] = useState(() => new Date())
  const rows = list.data ?? []
  const q = (extra: Record<string, string>) => `${SCHEDULES_PATH}?${new URLSearchParams({ project: projectId, ...extra })}`
  const open = (s: Schedule) => navigate(q({ open: s.id }))

  const head = (
    <div className="pj-tab-head">
      <span className="pj-muted pj-wrap">归到这个项目的定时任务；动作是建任务时，建出来的任务也归到这个项目</span>
      <span className="spacer" />
      {rows.length > 0 && <Button variant="ghost" onClick={() => navigate(q({}))}>在定时任务页看</Button>}
      <Button variant="primary" onClick={() => navigate(q({ new: '1' }))}>新建定时任务</Button>
    </div>
  )

  let body
  if (list.isPending) body = <LoadingState />
  else if (list.isError) body = <ErrorState title="定时任务没加载出来" error={list.error} onRetry={() => void list.refetch()} />
  else if (!rows.length) body = <EmptyState title="这个项目还没有定时任务" desc="比如每周一 9 点建一条「整理周会议程」，或者每天早上拉一次项目代码" />
  else {
    body = (
      <div className="pj-table" role="table" aria-label="项目定时任务">
        {rows.map((s) => (
          <button key={s.id} type="button" role="row" className={cls('pj-sched', !s.enabled && 'is-off')} onClick={() => open(s)}>
            <span className="ellipsis" role="cell" title={s.name}>{s.name}</span>
            <span className="pj-muted ellipsis" role="cell">{describeScheduleRule(fullScheduleRule(s.rule, now))}</span>
            <span className="pj-muted" role="cell">{s.enabled ? scheduleWhenText(s.next_run_at, now) : '已停用'}</span>
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="pj-tab">
      {head}
      {body}
    </div>
  )
}
