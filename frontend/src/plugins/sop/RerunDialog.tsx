// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 失败执行批量重跑的确认框：两种做法二选一并说明区别，默认按 rerun.ts 的 defaultRerun。照 IM 批量分诊（TriageDialog）的样子
import { useRef, useState } from 'react'
import { errorText, useRerunSopRuns, type SopFlow, type SopRerunAction, type SopRerunResult, type SopRunBrief } from '../../core/data'
import { ConfirmDialog, cls } from '../../core/ui'
import { RERUN_OPTIONS, defaultRerun, staleRuns } from './rerun'

export function RerunDialog({ runs, flows, onCancel, onDone }: {
  /** 勾选的失败执行，已按上限截好 */
  runs: readonly SopRunBrief[]
  flows: readonly SopFlow[]
  onCancel: () => void
  onDone: (action: SopRerunAction, r: SopRerunResult) => void
}) {
  const stale = staleRuns(runs, flows).length
  const [action, setAction] = useState<SopRerunAction>(() => defaultRerun(stale))
  const rerun = useRerunSopRuns()
  const subs = runs.filter((r) => r.parent_run_id).length

  // 防连点：isPending 要等下一次渲染才变，确认按钮连点两下的第二下靠 ref 挡掉（后端另有幂等，重复的跳过）
  const sent = useRef(false)
  const submit = () => {
    if (sent.current || rerun.isPending || !runs.length) return
    sent.current = true
    rerun.mutate({ runIds: runs.map((r) => r.id), action }, {
      onSuccess: (r) => onDone(action, r),
      onError: () => { sent.current = false },
    })
  }

  return (
    <ConfirmDialog open title={`批量重跑 ${runs.length} 条失败的执行`} busy={rerun.isPending || !runs.length}
      confirmLabel={rerun.isPending ? '重跑中…' : action === 'retry' ? `重试 ${runs.length} 条` : '重新发起'}
      onConfirm={submit} onCancel={onCancel}>
      <div className="sop-rerun">
        <div className="sop-rerun-opts" role="radiogroup" aria-label="重跑方式">
          {RERUN_OPTIONS.map((o) => (
            <label key={o.key} className={cls('sop-rerun-opt', action === o.key && 'on')}>
              <input type="radio" name="sop-rerun" value={o.key} checked={action === o.key} onChange={() => setAction(o.key)} />
              <span>
                <b>{o.label}</b>
                <span className="sop-rerun-desc">{o.desc}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="sop-rerun-hint">
          {stale > 0
            ? `其中 ${stale} 条的流程在发起后改过，照旧版本重试多半还会原样失败，所以默认按最新流程重新发起`
            : '这些执行的流程发起后都没改过，默认在原执行里重试，不重做已完成的步骤'}
          {action === 'relaunch' && subs > 0 && `；${subs} 条是子流程的执行，会重新发起它所在的顶层执行`}
        </div>
        <div className="sop-rerun-hint">要调模型的步骤按同时调模型的上限排队，排到了自动开始</div>
        {rerun.isError && <div className="sop-act-error sop-rerun-err" role="alert">没重跑成：{errorText(rerun.error)}</div>}
      </div>
    </ConfirmDialog>
  )
}
