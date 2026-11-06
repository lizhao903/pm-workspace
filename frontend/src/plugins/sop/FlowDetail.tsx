// 流程详情（SPEC-sop-5）：流程图、输入、最近执行；从这里执行、编辑、复制、删除。
// 复制（SPEC-sop-5.16）：新建一条同样的流程，名字加「副本」，放进同一个文件夹（TSK-0482），建好进它的编排页；内置流程要改就走这里
// 删除确认是标题行里的确认条：还有执行没走完时只能「知道了」（后端同样 409 拦着）；手机宽度下换行，按钮始终可见（SPEC-sop-0.1）
import { useState } from 'react'
import { errorText, useDeleteSopFlow, useSaveSopFlow, useSopFlow, useSopFolders, type SopFlow, type SopIssue, type SopRunBrief, type SopStepDef } from '../../core/data'
import { Button, EmptyState, PageTitle } from '../../core/ui'
import { FlowGraph, FlowLegend } from './FlowGraph'
import { UNCATEGORIZED, folderOf, isManualDecide, isPendingRun } from './model'
import { IconPlay, RunHead, RunRow } from './parts'
import { IMBar } from './IMBar'
import { ScheduleBar } from './ScheduleBar'
import { useSourceText } from './source'
import { imDraftOf } from './imtrigger'
import { needsText } from './scope'
import { IMExplainPanel, SkipList } from './Debug'

const RECENT = 10
const ISSUES_SHOWN = 6

/** 按现在的保存校验查出的问题（TSK-0490）：旧流程照常打开、执行，这里提示下次保存前要改的；刚保存完是保存回来的警告 */
function IssuesBar({ issues, steps, onEdit }: { issues: readonly SopIssue[]; steps: readonly SopStepDef[]; onEdit: () => void }) {
  if (!issues.length) return null
  const errs = issues.filter((x) => x.level !== 'warning').length
  const warns = issues.length - errs
  const at = (x: SopIssue) => (x.step !== undefined && steps[x.step] ? `第 ${x.step + 1} 步 ` : '')
  return (
    <div className={errs ? 'sop-issues-bar bad' : 'sop-issues-bar'} role="note" aria-label="保存校验">
      <div className="sop-issues-head">
        <span>保存校验：{[errs && `${errs} 处必须改`, warns && `${warns} 处注意`].filter(Boolean).join('，')}
          {errs > 0 ? '。照常能执行，下次保存前要改掉「必须改」的' : '。能存、能执行，多半不是想要的'}</span>
        <span className="spacer" />
        <Button size="sm" onClick={onEdit}>到编辑里改</Button>
      </div>
      <ul>
        {issues.slice(0, ISSUES_SHOWN).map((x, i) => <li key={i} className={x.level === 'warning' ? 'warn' : 'error'}>{at(x)}{x.text}</li>)}
        {issues.length > ISSUES_SHOWN && <li className="faint">还有 {issues.length - ISSUES_SHOWN} 处，到编辑里看</li>}
      </ul>
    </div>
  )
}

export function FlowDetail({ flow, runs, branching, needs = [], trigger, onStart, onOpenRun, onEdit, onAllRuns, onDeleted, onCopied, now }: {
  flow: SopFlow
  runs: readonly SopRunBrief[]
  branching: (d: SopStepDef) => boolean
  /** 要的、当前工作台没开的模块名 */
  needs?: readonly string[]
  /** 触发方式的显示名 */
  trigger: (t: string) => string
  onStart: () => void
  onOpenRun: (id: string) => void
  onEdit: () => void
  onAllRuns: () => void
  onDeleted: () => void
  onCopied: (f: SopFlow) => void
  now: number
}) {
  const [confirm, setConfirm] = useState(false)
  // 模拟 IM 触发（TSK-0491）：打开时可带一条消息（从「最近未发起」点「模拟」进来）
  const [explain, setExplain] = useState<{ msg?: string; n: number } | null>(null)
  // 列表里的流程不带 issues，单取一条（TSK-0490）
  const full = useSopFlow(flow.id)
  const sourceOf = useSourceText()
  const del = useDeleteSopFlow()
  const save = useSaveSopFlow()
  // 所在文件夹（TSK-0482）：概要里写一句，复制时副本放进同一个文件夹
  const folders = useSopFolders()
  const fid = folderOf(flow, folders.data ?? [])
  const folderName = folders.data?.find((f) => f.id === fid)?.name
  const mine = runs.filter((r) => r.flow_id === flow.id).sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
  // 已重跑过的失败执行算处理完了（同后端删流程前的检查）
  const live = mine.filter((r) => r.status === 'running' || isPendingRun(r)).length
  const block = live ? `还有 ${live} 次执行没走完（执行中、等人处理或失败待重试），先处理完或停掉` : ''
  const reviews = flow.steps.filter((s) => s.kind === 'review' || isManualDecide(s)).length
  const decides = flow.steps.filter(branching).length

  const remove = () => del.mutate(flow.id, { onSuccess: onDeleted })
  const copy = () => save.mutate(
    // 定时的副本带上同样的规则但先停用，免得复制出来就和原流程同一时刻各跑一次（TSK-0463）
    // IM 触发的副本带上同样的过滤条件，排在最后、不拦截，免得复制出来就把原流程的消息截走（TSK-0481）
    { draft: { name: `${flow.name} 副本`, desc: flow.desc, trigger: flow.trigger, fields: flow.fields, steps: flow.steps, layout: flow.layout,
      ...(flow.schedule ? { sched: { rule: flow.schedule.rule, enabled: false } } : {}),
      im: { ...imDraftOf(flow), stop: false }, folder_id: fid } },
    { onSuccess: onCopied },
  )
  const confirmText = del.isError ? `删除失败：${errorText(del.error)}` : block ? `不能删除：${block}` : '删除后已有的执行记录保留'

  return (
    <div className="sop-page">
      <PageTitle parent="SOP" desc={flow.desc} actions={!confirm && <>
        <Button variant="danger-ghost" onClick={() => { del.reset(); setConfirm(true) }}>删除</Button>
        <Button variant="ghost" disabled={save.isPending} onClick={copy}>{save.isPending ? '复制中' : '复制'}</Button>
        {flow.trigger === 'im' && <Button variant="ghost" onClick={() => setExplain({ n: Date.now() })}>模拟 IM 触发</Button>}
        <Button variant="outline" onClick={onEdit}>编辑</Button>
        <Button variant="primary" onClick={onStart}><IconPlay />执行</Button>
      </>}>{flow.name}</PageTitle>
      {save.isError && !confirm && (
        <div className="sop-confirm" role="alert">
          <span className="danger-text">复制失败：{errorText(save.error)}</span>
          <span className="spacer" />
          <Button onClick={() => save.reset()}>知道了</Button>
        </div>
      )}
      {confirm && (
        <div className="sop-confirm" role="alert">
          <span className="danger-text">{confirmText}</span>
          <span className="spacer" />
          <Button onClick={() => setConfirm(false)}>{block ? '知道了' : '取消'}</Button>
          {!block && <Button variant="danger" disabled={del.isPending} onClick={remove}>删除</Button>}
        </div>
      )}
      <div className="sop-facts">
        {(folders.data?.length ?? 0) > 0 && <span>文件夹：{folderName ?? UNCATEGORIZED}</span>}
        <span>触发：{trigger(flow.trigger)}</span>
        <span>{flow.steps.length} 个步骤</span>
        <span>{decides} 个分支节点</span>
        <span>{reviews} 个需要人处理的节点</span>
        {needs.length > 0 && <span className="sop-need-text" title="这个工作台没开这个模块，执行时可能选不到要的数据">{needsText(needs)}</span>}
      </div>
      <IssuesBar issues={full.data?.issues ?? []} steps={flow.steps} onEdit={onEdit} />
      <ScheduleBar flow={flow} now={now} className="sop-detail-sched" />
      <IMBar flow={flow} className="sop-detail-sched" />
      {explain && <IMExplainPanel key={explain.n} flowId={flow.id} initial={explain.msg} onClose={() => setExplain(null)} />}

      <div className="sop-section-label">流程</div>
      <div className="sop-flow-card"><FlowGraph flow={flow} branching={branching} /></div>
      <FlowLegend />

      <div className="sop-section-label">输入</div>
      <div className="sop-fields">
        {flow.fields.length ? flow.fields.map((f) => <span key={f.key} className="tag">{f.label}{f.required ? '（必填）' : ''}</span>)
          : <span className="sop-muted">没有输入字段</span>}
      </div>

      {(flow.trigger === 'im' || flow.trigger === 'schedule') && (
        <>
          <div className="sop-section-label">最近未发起<span className="sop-section-hint">自动触发没有发起执行的原因</span></div>
          <SkipList flowId={flow.id} onExplain={flow.trigger === 'im' ? (msg) => setExplain({ msg, n: Date.now() }) : undefined} />
        </>
      )}

      <div className="sop-section-label">最近执行{mine.length > 0 && <span className="sop-section-hint">共 {mine.length} 次</span>}</div>
      {!mine.length ? (
        <EmptyState compact title="没有执行记录" desc="点右上「执行」跑一次" />
      ) : (
        <div className="sop-run-table">
          <RunHead />
          {mine.slice(0, RECENT).map((r) => <RunRow key={r.id} r={r} onOpen={onOpenRun} showFlow={false} now={now} source={sourceOf(r)} />)}
          {mine.length > RECENT && (
            <button type="button" className="list-seg-more" onClick={onAllRuns}>在执行记录里看全部 {mine.length} 次</button>
          )}
        </div>
      )}
    </div>
  )
}
