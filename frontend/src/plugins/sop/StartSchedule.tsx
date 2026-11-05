// 开始节点的「定时」（TSK-0463，SPEC-sop-9.3）：触发方式选「定时」后在这里配时间规则，复用定时任务的规则编辑（core/ui ScheduleRuleFields），
// 下面是接下来 5 次；保存流程时规则写进随流程管理的定时任务，定时任务页看到、改到的是同一条。
// 没有那一条（在定时任务页删掉了）时是「定时，未配置」，点「设定时间」从每天 09:00 开始配。
import { useState } from 'react'
import type { SopField, SopScheduleDraft } from '../../core/data'
import { Button, ScheduleRuleFields, Switch, useRuleCheck } from '../../core/ui'
import { defaultSched, fieldsWithoutDefault } from './schedule'

const PREVIEW_COUNT = 5

export function StartSchedule({ sched, fields, onChange }: {
  sched?: SopScheduleDraft
  fields: readonly SopField[]
  onChange: (s: SopScheduleDraft) => void
}) {
  const [now] = useState(() => new Date())
  if (!sched) {
    return (
      <div className="sop-start-sched unset" role="status">
        <span>定时，未配置：随流程管理的定时任务不在了（可能在定时任务页删掉了），到点不会执行。</span>
        <Button size="sm" onClick={() => onChange(defaultSched(now))}>设定时间</Button>
      </div>
    )
  }
  return <Configured sched={sched} fields={fields} now={now} onChange={onChange} />
}

function Configured({ sched, fields, now, onChange }: { sched: SopScheduleDraft; fields: readonly SopField[]; now: Date; onChange: (s: SopScheduleDraft) => void }) {
  const check = useRuleCheck(sched.rule, { now, count: PREVIEW_COUNT })
  const missing = fieldsWithoutDefault(fields)
  return (
    <div className="sop-start-sched">
      <ScheduleRuleFields compact rule={sched.rule} check={check} now={now} onChange={(rule) => onChange({ ...sched, rule })} />
      <Switch checked={sched.enabled} onCheckedChange={(enabled) => onChange({ ...sched, enabled })}>
        <span className="sop-muted">{sched.enabled ? '到点自动执行' : '已停用：保存后不会自动执行'}</span>
      </Switch>
      {missing.length > 0 && (
        <div className="sop-start-sched-warn" role="note">
          定时执行时不填输入：{missing.map((x) => `「${x}」`).join('、')}是必填又没有默认值，到点会执行失败。给它们填默认值，或改成不必填
        </div>
      )}
      <div className="sop-muted">保存后在「定时任务」里也能看到这一条，两边改的是同一条</div>
    </div>
  )
}
