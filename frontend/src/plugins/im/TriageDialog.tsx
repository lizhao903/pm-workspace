// 批量分诊：挑一个分诊流程，给要分诊的每条消息发起一次执行（输入 {message_id}），走 SOP 的批量发起接口。
// 流程列表：触发方式是 IM 的在前，再列输入字段里有 message_id 的其他流程，默认第一个。
// 这条流程对这条消息已有执行（任意状态）的默认跳过；勾「已跑过的也重跑」就都发起。
// 消息抽屉、组抽屉「分诊建议」一节的「发起分诊」也用它（from=drawer）：只带这条或这一组，标题「发起分诊」。
// 自动分批（TSK-0492）：超过一次批量发起的上限（SOP_BATCH_MAX，200）按每批 200 条依次发起（triageBatch），
// 对话框里显示第 k/n 批、已发起、跳过、失败；发起中「取消」换成「停止」（这批回来后不再发下一批，已发起的保留）。
// 只有一批且全部发起成时照旧直接关掉；多批、有失败或停止了的留在对话框里汇总，失败的和没发出去的能重试。
// 总数超过 TRIAGE_TOTAL_MAX（1000）不发起，让人先缩小范围。
import { useEffect, useRef, useState } from 'react'
import { SOP_BATCH_MAX, errorText, triageFlows, useSopFlows, useStartSopBatch, type ImMessage, type SopBatchResult, type SopInputRun } from '../../core/data'
import { Checkbox, ConfirmDialog, Field, Select } from '../../core/ui'
import { TRIAGE_TOTAL_MAX, batchCount, failReasons, progressResult, runTriageBatches, type TriageProgress } from './triageBatch'
import { alreadyRun } from './triageModel'

/** 失败原因最多列几种 */
const REASONS_SHOWN = 3

export function TriageDialog({ targets, from, over, runs, onCancel, onDone }: {
  targets: readonly ImMessage[]
  /** picked 勾选的；filter 当前筛选结果全部；drawer 抽屉里的这条或这一组 */
  from: 'picked' | 'filter' | 'drawer'
  /** 超过总上限（TRIAGE_TOTAL_MAX）：不发起，提示先缩小范围 */
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
  // 这一轮（第一次发起或一次重试）的进度，null 是还没发起；prev 是之前几轮已发起、跳过的，汇总时加上
  const [cur, setCur] = useState<TriageProgress | null>(null)
  const [prev, setPrev] = useState<Rounds>({ started: [], skipped: [] })
  const [stopping, setStopping] = useState(false)
  const stopRef = useRef(false)
  // 关掉对话框（换页、Esc 在发完之后）时不再发下一批
  useEffect(() => () => { stopRef.current = true }, [])

  const ids = targets.map((m) => m.id)
  const ran = flowId ? alreadyRun(runs, flowId, ids) : 0
  const batches = batchCount(ids.length, SOP_BATCH_MAX)
  const scope = from === 'picked' ? `勾选的 ${targets.length} 条消息`
    : from === 'drawer' ? (targets.length === 1 ? '这条消息' : `这组 ${targets.length} 条消息`)
      : `当前筛选结果全部 ${targets.length} 条消息`
  const running = !!cur && !cur.finished
  const n = rerun ? targets.length : Math.max(0, targets.length - ran)
  // 发起前：超上限、没目标、没流程、全会跳过（发起 0 次）都不能点
  const blocked = running || (!cur && (over || !targets.length || !flowId || n === 0))
  const finished = !!cur?.finished
  const retryIds = finished ? [...cur.failed.map((f) => f.id), ...cur.rest] : []

  const launch = async (todo: string[]) => {
    stopRef.current = false
    setStopping(false)
    const first = !cur
    const base = sumRounds(prev, cur)
    setPrev(base)
    const skipExistingKey = rerun ? undefined : 'message_id'
    const p = await runTriageBatches(todo, SOP_BATCH_MAX,
      (part) => start.mutateAsync({ flowId, inputs: part.map((id) => ({ message_id: id })), skipExistingKey }),
      { shouldStop: () => stopRef.current, onProgress: setCur, errorText })
    // 一批就发完、没失败、没停：照旧直接关掉，标题行报结果
    if (first && p.batches <= 1 && !p.failed.length && !p.stopped) onDone(progressResult(p))
  }

  const finish = () => {
    if (!cur) return onCancel()
    onDone(progressResult({ ...cur, ...sumRounds(prev, cur) }))
  }

  const confirm = () => {
    if (running) return
    if (!finished) {
      if (blocked) return
      void launch(ids)
      return
    }
    if (retryIds.length) void launch(retryIds)
    else finish()
  }

  // 发起中「取消」是停止；发完了是关闭（带上汇总）
  const cancel = () => {
    if (running) { stopRef.current = true; setStopping(true); return }
    if (finished) finish()
    else onCancel()
  }

  const confirmLabel = running ? (stopping ? '停止中…' : '发起中…')
    : finished ? (retryIds.length ? retryLabel(cur) : '完成')
      : `发起 ${n} 次${batches > 1 ? `，分 ${batches} 批` : ''}`
  const cancelLabel = running ? '停止' : finished ? '关闭' : '取消'

  return (
    <ConfirmDialog open title={from === 'drawer' ? '发起分诊' : '批量分诊'} confirmLabel={confirmLabel} cancelLabel={cancelLabel}
      busy={blocked || (running && stopping)} onConfirm={confirm} onCancel={cancel}>
      <div className="im-totask">
        <div className="im-muted">给{scope}各发起一次流程，输入是消息编号；进度在「处理队列」里看</div>
        {over && <div className="im-err" role="alert">一次最多分诊 {TRIAGE_TOTAL_MAX} 条，现在有 {targets.length} 条。先勾选，或用状态、渠道、群组、搜索缩小范围</div>}
        {!cur && (
          <>
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
            {!over && batches > 1 && (
              <div className="im-muted">超过一次 {SOP_BATCH_MAX} 条的上限，按每批 {SOP_BATCH_MAX} 条分 {batches} 批依次发起；中途可以停止，已发起的保留</div>
            )}
          </>
        )}
        {cur && <TriageProgressView p={cur} prev={prev} total={targets.length} running={running} stopping={stopping} again={prev.started.length + prev.skipped.length > 0 || cur.total < targets.length} />}
      </div>
    </ConfirmDialog>
  )
}

type Rounds = { started: string[]; skipped: string[] }

/** 之前几轮加上这一轮的已发起、跳过 */
const sumRounds = (prev: Rounds, cur: TriageProgress | null): Rounds =>
  (cur ? { started: [...prev.started, ...cur.started], skipped: [...prev.skipped, ...cur.skipped] } : prev)

function retryLabel(p: TriageProgress) {
  const f = p.failed.length
  const r = p.rest.length
  if (f && r) return `重试失败的 ${f} 条并继续 ${r} 条`
  return f ? `重试失败的 ${f} 条` : `继续发起剩下的 ${r} 条`
}

/** 进度：第 k/n 批、进度条、已发起、跳过、失败；发完了加汇总和失败原因 */
function TriageProgressView({ p, prev, total, running, stopping, again }: {
  p: TriageProgress; prev: Rounds; total: number; running: boolean; stopping: boolean
  /** 重试、继续的那一轮：批数按这一轮算，说「补发的」 */
  again: boolean
}) {
  const started = prev.started.length + p.started.length
  const skipped = prev.skipped.length + p.skipped.length
  const pct = p.batches ? Math.round((p.batch / p.batches) * 100) : 100
  const reasons = failReasons(p.failed)
  const head = running
    ? (stopping ? `第 ${Math.min(p.batch + 1, p.batches)}/${p.batches} 批发起中，这批回来后停止` : `第 ${Math.min(p.batch + 1, p.batches)}/${p.batches} 批发起中`)
    : p.stopped ? `已停止：发完 ${p.batch}/${p.batches} 批，剩 ${p.rest.length} 条没发起`
      : again ? `补发的 ${p.batches} 批都发完了` : `${p.batches} 批都发完了`
  return (
    <div className="im-tri-prog" aria-live="polite">
      <div className="im-tri-prog-head">{head}</div>
      <div className="im-tri-bar" role="progressbar" aria-label="分批进度" aria-valuemin={0} aria-valuemax={p.batches} aria-valuenow={p.batch}>
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="im-tri-counts">
        <span>已发起 <b>{started}</b></span>
        <span>跳过 <b>{skipped}</b></span>
        <span className={p.failed.length ? 'bad' : undefined}>失败 <b>{p.failed.length}</b></span>
        <span className="im-muted">共 {total} 条</span>
      </div>
      {!running && reasons.length > 0 && (
        <ul className="im-tri-fails" aria-label="失败原因">
          {reasons.slice(0, REASONS_SHOWN).map((r) => <li key={r.error}>{r.n} 条：{r.error}</li>)}
          {reasons.length > REASONS_SHOWN && <li>还有 {reasons.length - REASONS_SHOWN} 种原因</li>}
        </ul>
      )}
      {!running && skipped > 0 && <div className="im-muted">跳过的是这条流程已经跑过的消息</div>}
    </div>
  )
}
