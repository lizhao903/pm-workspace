// 批量分诊：挑一个分诊流程，给要分诊的每条消息发起一次执行（输入 {message_id}），走 SOP 的批量发起接口。
// 流程列表：触发方式是 IM 的在前，再列输入字段里有 message_id 的其他流程，默认第一个。
// 这条流程对这条消息已有执行（任意状态）的默认跳过；勾「已跑过的也重跑」就都发起。
// 消息抽屉、组抽屉「分诊建议」一节的「发起分诊」也用它（from=drawer）：只带这条或这一组，标题「发起分诊」。
import { useState } from 'react'
import { SOP_BATCH_MAX, errorText, triageFlows, useSopFlows, useStartSopBatch, type ImMessage, type SopBatchResult, type SopInputRun } from '../../core/data'
import { Checkbox, ConfirmDialog, Field, Select } from '../../core/ui'
import { alreadyRun } from './triageModel'

export function TriageDialog({ targets, from, over, runs, onCancel, onDone }: {
  targets: readonly ImMessage[]
  /** picked 勾选的；filter 当前筛选结果全部；drawer 抽屉里的这条或这一组 */
  from: 'picked' | 'filter' | 'drawer'
  /** 超过上限：不发起，提示先缩小范围 */
  over: boolean
  /** 已有的分诊执行，预估会跳过几条 */
  runs: readonly SopInputRun[]
  onCancel: () => void
  onDone: (r: SopBatchResult) => void
}) {
  const flows = useSopFlows()
  const start = useStartSopBatch()
  const list = triageFlows(flows.data ?? [])
  const [pick, setPick] = useState('')
  const flowId = pick || list[0]?.id || ''
  const [rerun, setRerun] = useState(false)
  const ids = targets.map((m) => m.id)
  const ran = flowId ? alreadyRun(runs, flowId, ids) : 0
  const scope = from === 'picked' ? `勾选的 ${targets.length} 条消息`
    : from === 'drawer' ? (targets.length === 1 ? '这条消息' : `这组 ${targets.length} 条消息`)
      : `当前筛选结果全部 ${targets.length} 条消息`
  const blocked = over || !targets.length || !flowId || start.isPending

  const submit = () => {
    if (blocked) return
    start.mutate({ flowId, inputs: ids.map((id) => ({ message_id: id })), skipExistingKey: rerun ? undefined : 'message_id' }, { onSuccess: onDone })
  }

  return (
    <ConfirmDialog open title={from === 'drawer' ? '发起分诊' : '批量分诊'} confirmLabel={start.isPending ? '发起中…' : `发起 ${rerun ? targets.length : Math.max(0, targets.length - ran)} 次`}
      busy={blocked} onConfirm={submit} onCancel={onCancel}>
      <div className="im-totask">
        <div className="im-muted">给{scope}各发起一次流程，输入是消息编号；进度在「处理队列」里看</div>
        {over && <div className="im-err" role="alert">一次最多分诊 {SOP_BATCH_MAX} 条，现在有 {targets.length} 条。先勾选，或用状态、渠道、群组、搜索缩小范围</div>}
        <Field label="分诊流程" required>
          {flows.isError ? <div className="im-err" role="alert">流程没加载出来：{errorText(flows.error)}</div>
            : flows.isPending ? <div className="im-muted">加载中</div>
              : list.length ? (
                <Select aria-label="分诊流程" value={flowId} onValueChange={setPick}
                  options={list.map((f) => ({ value: f.id, label: f.trigger === 'im' ? `${f.name}（来消息自动跑）` : f.name }))} />
              ) : <div className="im-muted">还没有能分诊消息的流程：在 SOP 里建一条触发方式是 IM 的流程，或输入字段里有 message_id 的流程</div>}
        </Field>
        <Checkbox checked={rerun} onCheckedChange={setRerun}>已跑过的也重跑</Checkbox>
        {!rerun && ran > 0 && <div className="im-muted">其中 {ran} 条已经用这个流程跑过，会跳过</div>}
        {start.isError && <div className="im-err" role="alert">没发起成：{errorText(start.error)}</div>}
      </div>
    </ConfirmDialog>
  )
}

