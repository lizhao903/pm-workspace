// 流程详情（SPEC-sop-5）：流程图、输入、最近执行；从这里执行、编辑、删除。
// 删除确认是标题行里的确认条：还有执行没走完时只能「知道了」（后端同样 409 拦着）；手机宽度下换行，按钮始终可见（SPEC-sop-0.1）
import { useState } from 'react'
import { errorText, useDeleteSopFlow, type SopFlow, type SopRunBrief, type SopStepDef } from '../../core/data'
import { Button, EmptyState, PageTitle } from '../../core/ui'
import { FlowGraph, FlowLegend } from './FlowGraph'
import { isManualDecide } from './model'
import { IconPlay, RunHead, RunRow } from './parts'

const RECENT = 10

export function FlowDetail({ flow, runs, branching, onStart, onOpenRun, onEdit, onAllRuns, onDeleted, now }: {
  flow: SopFlow
  runs: readonly SopRunBrief[]
  branching: (d: SopStepDef) => boolean
  onStart: () => void
  onOpenRun: (id: string) => void
  onEdit: () => void
  onAllRuns: () => void
  onDeleted: () => void
  now: number
}) {
  const [confirm, setConfirm] = useState(false)
  const del = useDeleteSopFlow()
  const mine = runs.filter((r) => r.flow_id === flow.id).sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
  const live = mine.filter((r) => r.status === 'running' || r.status === 'waiting' || r.status === 'failed').length
  const block = live ? `还有 ${live} 次执行没走完（执行中、等人处理或失败待重试），先处理完或停掉` : ''
  const reviews = flow.steps.filter((s) => s.kind === 'review' || isManualDecide(s)).length
  const decides = flow.steps.filter(branching).length

  const remove = () => del.mutate(flow.id, { onSuccess: onDeleted })
  const confirmText = del.isError ? `删除失败：${errorText(del.error)}` : block ? `不能删除：${block}` : '删除后已有的执行记录保留'

  return (
    <div className="sop-page">
      <PageTitle parent="SOP" desc={flow.desc} actions={!confirm && <>
        <Button variant="danger-ghost" onClick={() => { del.reset(); setConfirm(true) }}>删除</Button>
        <Button variant="outline" onClick={onEdit}>编辑</Button>
        <Button variant="primary" onClick={onStart}><IconPlay />执行</Button>
      </>}>{flow.name}</PageTitle>
      {confirm && (
        <div className="sop-confirm" role="alert">
          <span className="danger-text">{confirmText}</span>
          <span className="spacer" />
          <Button onClick={() => setConfirm(false)}>{block ? '知道了' : '取消'}</Button>
          {!block && <Button variant="danger" disabled={del.isPending} onClick={remove}>删除</Button>}
        </div>
      )}
      <div className="sop-facts">
        <span>触发：{flow.trigger || '手动'}</span>
        <span>{flow.steps.length} 个步骤</span>
        <span>{decides} 个分支节点</span>
        <span>{reviews} 个需要人处理的节点</span>
      </div>

      <div className="sop-section-label">流程</div>
      <div className="sop-flow-card"><FlowGraph flow={flow} branching={branching} /></div>
      <FlowLegend />

      <div className="sop-section-label">输入</div>
      <div className="sop-fields">
        {flow.fields.length ? flow.fields.map((f) => <span key={f.key} className="tag">{f.label}{f.required ? '（必填）' : ''}</span>)
          : <span className="sop-muted">没有输入字段</span>}
      </div>

      <div className="sop-section-label">最近执行{mine.length > 0 && <span className="sop-section-hint">共 {mine.length} 次</span>}</div>
      {!mine.length ? (
        <EmptyState compact title="没有执行记录" desc="从流程库里选一个标准流程开始执行" />
      ) : (
        <div className="sop-run-table">
          <RunHead />
          {mine.slice(0, RECENT).map((r) => <RunRow key={r.id} r={r} onOpen={onOpenRun} showFlow={false} now={now} />)}
          {mine.length > RECENT && (
            <button type="button" className="list-seg-more" onClick={onAllRuns}>在执行记录里看全部 {mine.length} 次</button>
          )}
        </div>
      )}
    </div>
  )
}
