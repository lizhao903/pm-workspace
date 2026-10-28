// 任务抽屉的执行记录（DEV-08c，SPEC-tasks-5.12 到 5.17）：列表、展开看完整输出、取消运行中的执行。
import { useMemo, useState } from 'react'
import type { TaskRun, WorkObject } from '../../core/api'
import { runFinished, useCancelRun, useTaskRun, useTaskRuns } from '../../core/api/taskRuns'
import { Button, ErrorState, IconChevronRight, LoadingState, cls } from '../../core/ui'
import { timeAgo } from './model'
import { useLiveRun, useLiveRuns, type LiveRun } from './runLive'
import { RunOutput, RunStream } from './RunStream'
import { duration, extraOf, parseOutput, runNote, runStatusOf } from './runsModel'
import './runs.css'

export function RunsBlock({ task }: { task: WorkObject }) {
  const q = useTaskRuns(task.id)
  const live = useLiveRuns()
  // 本页刚发起、列表还没刷到的那条先摆在最上面
  const pending = useMemo(
    () => live.filter((l) => l.objectId === task.id && l.phase !== 'failed' && l.phase !== 'done' && !q.data?.some((r) => r.id === l.runId)),
    [live, task.id, q.data],
  )
  const failedStarts = live.filter((l) => l.objectId === task.id && l.phase === 'failed' && !l.runId)
  const rows = q.data ?? []
  return (
    <section className="dev-slot" data-slot="runs" data-task={task.id} aria-label="执行记录">
      <div className="dev-slot-head">
        <span className="field-group-title">执行记录</span>
        <span className="run-hint">从这里交给 Claude Code 的每一次执行，最近的在前</span>
      </div>
      {q.isPending && <LoadingState />}
      {q.isError && <ErrorState compact error={q.error} onRetry={() => q.refetch()} />}
      {failedStarts.map((l) => <div key={l.key} className="run-note run-note-danger" role="alert">没能开始执行：{l.errors.join('；')}</div>)}
      {q.isSuccess && !rows.length && !pending.length && <div className="dev-slot-empty">还没有执行过</div>}
      {(pending.length > 0 || rows.length > 0) && (
        <div className="run-list">
          {pending.map((l) => <StartingRow key={l.key} live={l} />)}
          {rows.map((r) => <RunRow key={r.id} run={r} />)}
        </div>
      )}
    </section>
  )
}

function StatusTag({ status }: { status: string }) {
  const s = runStatusOf(status)
  return <span className={cls('run-st', 'run-st-' + s.tone)}>{s.label}</span>
}

function StartingRow({ live }: { live: LiveRun }) {
  return (
    <div className="run-item open">
      <div className="run-head">
        <StatusTag status="running" />
        <span className="run-extra">正在启动</span>
      </div>
      <div className="run-body"><RunStream events={live.events} live /></div>
    </div>
  )
}

function RunRow({ run }: { run: TaskRun }) {
  const finished = runFinished(run)
  // 看着它跑完的不收起来
  const [open, setOpen] = useState(() => !finished)
  // 运行中的一直展开
  const expanded = !finished || open
  const live = useLiveRun(run.id)
  const detail = useTaskRun(run.id, expanded && finished && !live)
  const cancel = useCancelRun()
  const r = detail.data && runFinished(detail.data) ? detail.data : run
  const note = runNote(r)
  const extra = extraOf(run.prompt)
  const blocks = useMemo(() => parseOutput(r.output, r.status), [r.output, r.status])
  const streaming = !!live && live.phase === 'streaming'
  return (
    <div className={cls('run-item', expanded && 'open')} data-run={run.id} data-status={r.status}>
      <button type="button" className="run-head" onClick={() => setOpen(!open)} aria-expanded={expanded}
        title={finished ? (open ? '收起' : '展开看完整输出') : undefined}>
        <span className={cls('run-chev', expanded && 'open')}><IconChevronRight /></span>
        <StatusTag status={r.status} />
        <span className={cls('run-extra', !extra && 'none')} title={extra || undefined}>{extra || '没有附加说明'}</span>
        <span className="spacer" />
        <span className="run-at">{timeAgo(run.started_at)} · {duration(run.started_at, r.finished_at)}</span>
      </button>
      {note && <div className={cls('run-note', 'run-note-' + note.tone)}>{note.text}</div>}
      {expanded && (
        <div className="run-body">
          <div className="run-meta">{r.workdir} · 记录 {run.id.slice(-8)}{finished ? ` · exit ${r.exit_code}` : ''}</div>
          {live
            ? <RunStream events={live.events} live={streaming && !finished} />
            : !finished
              ? <div className="run-out-empty">这次执行不是从本页发起的，输出在执行结束后才能看到</div>
              : detail.isError
                ? <ErrorState compact title="完整输出加载失败" error={detail.error} onRetry={() => detail.refetch()} />
                : <RunOutput blocks={blocks} />}
          {!finished && (
            <div className="run-actions">
              <Button variant="danger" size="sm" disabled={cancel.isPending || cancel.isSuccess} onClick={() => cancel.mutate(run.id)}>
                {cancel.isPending || cancel.isSuccess ? '正在取消' : '取消执行'}
              </Button>
              {cancel.isError && <span className="run-note-danger" role="alert">取消失败：{cancel.error.message}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
