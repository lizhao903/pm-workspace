// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 流程的定时一行（TSK-0463，SPEC-sop-2.12、SPEC-sop-5.18）：规则、下次执行、启停开关；在定时任务页删掉后显示「定时，未配置」。
// 开关改的是随流程管理的那条定时任务（PATCH /api/schedules/{id}），和定时任务页同一条
import { useState } from 'react'
import { errorText, usePatchSchedule, type SopFlow } from '../../core/data'
import { Switch, cls } from '../../core/ui'
import { scheduleStateOf } from './schedule'

export function ScheduleBar({ flow, now, className }: { flow: Pick<SopFlow, 'trigger' | 'schedule' | 'name'>; now: number; className?: string }) {
  const patch = usePatchSchedule()
  // 点了开关先翻过去，等流程重新取回来（定时任务改了会刷流程）对上了再用后端的值；失败弹回
  const [want, setWant] = useState<boolean | null>(null)
  const st = scheduleStateOf(flow, new Date(now))
  if (want !== null && st.kind === 'set' && st.enabled === want) setWant(null)
  if (st.kind === 'none') return null
  if (st.kind === 'unset') {
    return (
      <div className={cls('sop-sched', 'unset', className)} role="status">
        <span className="sop-sched-text">定时，未配置：到点不会执行，到编辑里设好时间</span>
      </div>
    )
  }
  const s = flow.schedule!
  const on = want ?? st.enabled
  return (
    <div className={cls('sop-sched', !st.enabled && 'off', className)}>
      <span className="sop-sched-text">
        <span>定时 · {st.rule}</span>
        <span className={cls(st.enabled && 'sop-sched-next')}>{st.next}</span>
        {patch.isError && <span className="danger-text">没能{st.enabled ? '停用' : '启用'}：{errorText(patch.error)}</span>}
      </span>
      <Switch checked={on} disabled={patch.isPending} aria-label={`定时执行「${flow.name}」`} title={on ? '停用定时' : '启用定时'}
        onCheckedChange={(v) => { setWant(v); patch.mutate({ id: s.id, patch: { enabled: v } }, { onError: () => setWant(null) }) }} />
    </div>
  )
}
