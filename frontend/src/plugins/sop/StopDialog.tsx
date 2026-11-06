// 执行记录的停止确认框（TSK-0717）：勾选的、单条的按 id 停（batch-actions 的 stop），
// 「停止全部运行中」按条件停（POST /api/sop/runs/stop，按当前流程筛选时只停这条流程的），先 dry_run 数出将停止几条。
// 照失败页批量重跑（RerunDialog）的样子，结果一行提示留在列表上
import { useRef } from 'react'
import { SOP_BATCH_MAX, errorText, useSopStopPreview, useStopSopRuns, useStopSopWhere, type SopRunBrief, type SopStopScope } from '../../core/data'
import { ConfirmDialog } from '../../core/ui'
import { STOP_EFFECT, STOP_NO_UNDO, stopIdsNote, stopWhereNote } from './stop'

export type StopTarget =
  | { kind: 'ids'; runs: readonly SopRunBrief[] }
  /** label 是范围的说法：「全部流程」或「流程「X」」 */
  | { kind: 'where'; scope: SopStopScope; label: string }

export function StopDialog({ target, onCancel, onDone }: {
  target: StopTarget
  onCancel: () => void
  onDone: (note: { text: string; bad: boolean }) => void
}) {
  const byIds = useStopSopRuns()
  const byWhere = useStopSopWhere()
  const preview = useSopStopPreview(target.kind === 'where' ? target.scope : null)
  const pending = byIds.isPending || byWhere.isPending
  const n = target.kind === 'ids' ? target.runs.length : preview.data?.matched ?? 0
  const counting = target.kind === 'where' && preview.isPending
  const sent = useRef(false)

  const submit = () => {
    if (sent.current || pending || counting || !n) return
    sent.current = true
    const again = () => { sent.current = false }
    if (target.kind === 'ids') {
      byIds.mutate(target.runs.slice(0, SOP_BATCH_MAX).map((r) => r.id), { onSuccess: (r) => onDone(stopIdsNote(r)), onError: again })
    } else {
      byWhere.mutate(target.scope, { onSuccess: (r) => onDone(stopWhereNote(r)), onError: again })
    }
  }

  const err = byIds.error ?? byWhere.error ?? (target.kind === 'where' ? preview.error : null)
  const title = target.kind === 'ids'
    ? (n === 1 ? '停止这条执行' : `停止勾选的 ${n} 条执行`)
    : `停止${target.label}运行中的执行`
  const label = pending ? '停止中…' : counting ? '正在数…' : n ? `停止 ${n} 条` : '没有要停的'
  return (
    <ConfirmDialog open danger title={title} confirmLabel={label} busy={pending || counting || !n} onConfirm={submit} onCancel={onCancel}>
      <div className="sop-rerun">
        {target.kind === 'ids' && n === 1 && <div className="sop-stop-what ellipsis" title={target.runs[0].title}>{target.runs[0].title}</div>}
        {target.kind === 'where' && (
          <div className="sop-stop-what">
            {counting ? '正在数运行中的执行…' : `${target.label}现在有 ${n} 条执行中或等你处理的执行，会全部停止`}
            {preview.data && preview.data.matched > 0 && preview.data.summary.waiting > 0 && `（其中 ${preview.data.summary.waiting} 条在等你处理）`}
          </div>
        )}
        <div className="sop-rerun-hint">{STOP_EFFECT}</div>
        <div className="sop-rerun-hint">{STOP_NO_UNDO}</div>
        {err ? <div className="sop-act-error sop-rerun-err" role="alert">没停成：{errorText(err)}</div> : null}
      </div>
    </ConfirmDialog>
  )
}
