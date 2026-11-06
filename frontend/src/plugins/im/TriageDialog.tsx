// 批量分诊：挑一个分诊流程，给要分诊的每条消息发起一次执行（输入 {message_id}），走 SOP 的批量发起接口。
// 流程列表：触发方式是 IM 的在前，再列输入字段里有 message_id 的其他流程，默认第一个。
// 这条流程对这条消息已有执行（任意状态）的默认跳过；勾「已跑过的也重跑」就都发起。
// 消息抽屉、组抽屉「分诊建议」一节的「发起分诊」也用它（from=drawer）：只带这条或这一组，标题「发起分诊」。
// 自动分批（TSK-0492）：超过一次批量发起的上限（SOP_BATCH_MAX，200）按每批 200 条依次发起（triageBatch），
// 对话框里显示第 k/n 批、已发起、跳过、失败；发起中「取消」换成「停止」（这批回来后不再发下一批，已发起的保留）。
// 发起后留在对话框里（TSK-0717 起，之前一批发完就关掉）：汇总已发起、跳过、失败，失败的和没发出去的能重试。
// 总数超过 TRIAGE_TOTAL_MAX（1000）不发起，让人先缩小范围。
// 立即停止（TSK-0717，SPEC-messages-1.66）：每次打开对话框生成一个批次（newSopBatchId），分几批、重试都带它；
// 发起中和发完之后都能「立即停止」：按批次停掉这次分诊已发起的全部执行（排队的出队、正在调模型的取消），
// 正在发的那批里还没建的后端不再建，之后的批不再发；已建出的任务不撤回。
// 发起后每 3 秒按批次数一次这些执行现在的状态（执行中、等你处理、已完成、失败、已停止），停完显示停了多少、完成多少。
import { useEffect, useRef, useState } from 'react'
import {
  SOP_BATCH_MAX, errorText, newSopBatchId, triageFlows, useSopFlows, useSopStopPreview, useStartSopBatch, useStopSopWhere,
  type ImMessage, type SopBatchResult, type SopInputRun, type SopRunStatusCounts, type SopStopResult,
} from '../../core/data'
import { Button, Checkbox, ConfirmDialog, Field, Select } from '../../core/ui'
import { TRIAGE_TOTAL_MAX, batchCount, failReasons, progressResult, runTriageBatches, type TriageProgress } from './triageBatch'
import { alreadyRun } from './triageModel'

/** 失败原因最多列几种 */
const REASONS_SHOWN = 3
/** 发起后多久数一次这批执行的状态 */
const RUNS_POLL_MS = 3000

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
  // 这次分诊的批次：分几批、重试都带同一个，立即停止按它停
  const [batchId] = useState(newSopBatchId)
  const halt = useStopSopWhere()
  const [halted, setHalted] = useState<SopStopResult | null>(null)
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
  // 立即停止过的不再给重试、继续：批次停了，再发也不会发起
  const retryIds = finished && !halted && !halt.isPending ? [...cur.failed.map((f) => f.id), ...cur.rest] : []
  const launched = prev.started.length + (cur?.started.length ?? 0)
  // 发起过就按批次数这批执行现在的状态；立即停止后数字以停止的结果为准，之后接着数
  const batchRuns = useSopStopPreview(launched > 0 ? { batch_id: batchId } : null, { refetchInterval: RUNS_POLL_MS })
  const counts = batchRuns.data?.summary ?? halted?.summary ?? null
  const live = counts ? counts.running + counts.waiting : launched

  const stopNow = () => {
    if (halt.isPending) return
    stopRef.current = true
    setStopping(true)
    halt.mutate({ batch_id: batchId }, { onSuccess: setHalted })
  }

  const launch = async (todo: string[]) => {
    stopRef.current = false
    setStopping(false)
    const first = !cur
    const base = sumRounds(prev, cur)
    setPrev(base)
    const skipExistingKey = rerun ? undefined : 'message_id'
    const p = await runTriageBatches(todo, SOP_BATCH_MAX,
      (part) => start.mutateAsync({ flowId, inputs: part.map((id) => ({ message_id: id })), skipExistingKey, batchId }),
      { shouldStop: () => stopRef.current, onProgress: setCur, errorText })
    // 一条都没发起（全跳过）就直接关掉，标题行报结果；发起了的留着，能看进度、能立即停止
    if (first && p.batches <= 1 && !p.failed.length && !p.stopped && !p.started.length) onDone(progressResult(p))
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

  // 发起中「取消」是不再发下一批（已发起的照跑）；发完了是关闭（带上汇总）
  const cancel = () => {
    if (running) { stopRef.current = true; setStopping(true); return }
    if (finished) finish()
    else onCancel()
  }

  const confirmLabel = running ? (stopping ? (halt.isPending || halted ? '停止中…' : '这批回来后停止') : '发起中…')
    : finished ? (retryIds.length ? retryLabel(cur) : '完成')
      : `发起 ${n} 次${batches > 1 ? `，分 ${batches} 批` : ''}`
  const cancelLabel = running ? '不再发下一批' : finished ? '关闭' : '取消'

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
        {cur && <TriageProgressView p={cur} prev={prev} total={targets.length} running={running} stopping={stopping} halting={halt.isPending || !!halted} again={prev.started.length + prev.skipped.length > 0 || cur.total < targets.length} />}
        {cur && (launched > 0 || running) && (
          <BatchRunsView counts={counts} halted={halted} halting={halt.isPending} live={live} running={running}
            error={halt.isError ? errorText(halt.error) : ''} onStop={stopNow} />
        )}
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

/**
 * 这次分诊发起的执行现在怎样（按批次数）和「立即停止」：发起中、发完了都能点，停掉已发起的全部执行，
 * 停完写停了多少、已完成多少；已建出的任务不撤回
 */
function BatchRunsView({ counts, halted, halting, live, running, error, onStop }: {
  counts: SopRunStatusCounts | null
  halted: SopStopResult | null
  halting: boolean
  /** 还在跑（执行中加等你处理）的条数，没数出来前按已发起的算 */
  live: number
  running: boolean
  error: string
  onStop: () => void
}) {
  const canStop = !halting && (running || live > 0)
  return (
    <div className="im-tri-runs" aria-live="polite">
      {counts && (
        <div className="im-tri-counts" aria-label="这次分诊的执行">
          <span>执行中 <b>{counts.running}</b></span>
          <span>等你处理 <b>{counts.waiting}</b></span>
          <span>已完成 <b>{counts.done}</b></span>
          <span className={counts.failed ? 'bad' : undefined}>失败 <b>{counts.failed}</b></span>
          <span>已停止 <b>{counts.stopped}</b></span>
        </div>
      )}
      {halted && (
        <div className="im-tri-halted" role="status">
          已立即停止：停了 {halted.stopped.length} 条{counts ? `，已完成 ${counts.done} 条` : ''}
          {halted.failed.length > 0 && `，${halted.failed.length} 条没停成：${halted.failed[0].error}`}。已建出的任务不会撤回
        </div>
      )}
      {error && <div className="im-err" role="alert">没停成：{error}</div>}
      {(canStop || halting) && (
        <div className="im-tri-stop">
          <Button variant="danger" size="sm" disabled={!canStop} onClick={onStop}>{halting ? '停止中…' : '立即停止'}</Button>
          <span className="im-muted">停掉这次分诊已发起的全部执行{running ? '，后面的批也不再发' : ''}；已建出的任务不撤回</span>
        </div>
      )}
    </div>
  )
}

/** 进度：第 k/n 批、进度条、已发起、跳过、失败；发完了加汇总和失败原因 */
function TriageProgressView({ p, prev, total, running, stopping, halting, again }: {
  p: TriageProgress; prev: Rounds; total: number; running: boolean; stopping: boolean
  /** 点了立即停止 */
  halting: boolean
  /** 重试、继续的那一轮：批数按这一轮算，说「补发的」 */
  again: boolean
}) {
  const started = prev.started.length + p.started.length
  const skipped = prev.skipped.length + p.skipped.length
  const pct = p.batches ? Math.round((p.batch / p.batches) * 100) : 100
  const reasons = failReasons(p.failed)
  const head = running
    ? (stopping ? `第 ${Math.min(p.batch + 1, p.batches)}/${p.batches} 批发起中，${halting ? '已立即停止，这批没建的不再建' : '这批回来后不再发下一批'}` : `第 ${Math.min(p.batch + 1, p.batches)}/${p.batches} 批发起中`)
    : p.stopped ? `已停止：发完 ${p.batch}/${p.batches} 批，剩 ${p.rest.length} 条没发起`
      : again ? `补发的 ${p.batches} 批都发完了` : `${p.batches} 批都发完了`
  return (
    <div className="im-tri-prog" aria-live="polite">
      <div className="im-tri-prog-head">{head}</div>
      <div className="im-tri-bar" role="progressbar" aria-label="分批进度" aria-valuemin={0} aria-valuemax={p.batches} aria-valuenow={p.batch}>
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="im-tri-counts" aria-label="发起情况">
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
