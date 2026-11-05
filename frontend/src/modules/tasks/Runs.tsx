// 任务抽屉的执行记录（DEV-08c，SPEC-tasks-5.12 到 5.17）：列表、展开看完整输出、取消运行中的执行。
// 每条标方式（0048）：流式的照旧；终端的进程不归工作台管，结论由终端里的 Claude Code 经 MCP 回写，
// 进行中时给一个「标记结束」兜底（选完成、失败或取消，写一句结论）。
// 任务详情分标签后这块在「执行记录」标签里；地址带 ?run=<id> 时那一条展开、高亮并滚到可见处。
// 每条标执行器（TSK-0460）：交给工作台 Agent 的执行在等确认时状态是「等待确认」，本页发起的流里有确认卡片可以直接点；
// 有会话的给「打开会话继续」，去会话页接着聊（续跑在「交给工作台 Agent」弹窗里勾）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import {
  decideRunCall, errorText, runFinished, useCancelRun, useFinishRun, useTaskRun, useTaskRuns, type FinishRunInput, type TaskRun, type WorkObject,
} from '../../core/data'
import { Button, ConfirmDialog, ErrorState, Field, IconChevronRight, LoadingState, Markdown, Select, Textarea, cls } from '../../core/ui'
import { timeAgo } from './model'
import { useLiveRun, useLiveRuns, type LiveRun } from './runLive'
import { RunOutput, RunStream, type DecideProps } from './RunStream'
import { FINISH_OPTIONS, agentSessionOf, duration, extraOf, harnessLabel, modeLabel, parseOutput, runNote, runStatusOf } from './runsModel'
import './runs.css'

export function RunsBlock({ task, focus }: {
  task: WorkObject
  /** 要定位的执行 id */
  focus?: string
}) {
  const q = useTaskRuns(task.id)
  const live = useLiveRuns()
  // 本页刚发起、列表还没刷到的那条先摆在最上面
  const pending = useMemo(
    () => live.filter((l) => l.objectId === task.id && l.phase !== 'failed' && l.phase !== 'done' && !q.data?.some((r) => r.id === l.runId)),
    [live, task.id, q.data],
  )
  const failedStarts = live.filter((l) => l.objectId === task.id && l.phase === 'failed' && !l.runId)
  const rows = q.data ?? []
  const lit = focus && rows.some((r) => r.id === focus) ? focus : undefined
  // 那一条出现后滚过去一次
  const ref = useRef<HTMLElement>(null)
  const scrolled = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!lit || scrolled.current === lit) return
    const el = Array.from(ref.current?.querySelectorAll<HTMLElement>('[data-run]') ?? []).find((x) => x.dataset.run === lit)
    if (!el) return
    scrolled.current = lit
    el.scrollIntoView?.({ block: 'center' })
  }, [lit])
  return (
    <section className="dev-slot" data-slot="runs" data-task={task.id} aria-label="执行记录" ref={ref}>
      <div className="dev-slot-head">
        <span className="field-group-title">执行记录</span>
        <span className="run-hint">从这里交给 Claude Code 或工作台 Agent 的每一次执行，最近的在前</span>
      </div>
      {q.isPending && <LoadingState />}
      {q.isError && <ErrorState compact error={q.error} onRetry={() => q.refetch()} />}
      {failedStarts.map((l) => <div key={l.key} className="run-note run-note-danger" role="alert">没能开始执行：{l.errors.join('；')}</div>)}
      {q.isSuccess && !rows.length && !pending.length && <div className="dev-slot-empty">还没有执行过</div>}
      {(pending.length > 0 || rows.length > 0) && (
        <div className="run-list">
          {pending.map((l) => <StartingRow key={l.key} live={l} />)}
          {rows.map((r) => <RunRow key={r.id} run={r} lit={r.id === lit} />)}
        </div>
      )}
    </section>
  )
}

function StatusTag({ status, label }: { status: string; label?: string }) {
  const s = runStatusOf(status)
  return <span className={cls('run-st', 'run-st-' + s.tone)}>{label ?? s.label}</span>
}

function StartingRow({ live }: { live: LiveRun }) {
  const decide = useDecide(live.objectId, live.sessionId ?? '')
  return (
    <div className="run-item open">
      <div className="run-head">
        <StatusTag status="running" />
        <span className="run-extra">正在启动</span>
      </div>
      <div className="run-body"><RunStream events={live.events} live follow decide={decide} /></div>
    </div>
  )
}

function RunRow({ run, lit }: { run: TaskRun; lit: boolean }) {
  return run.mode === 'terminal' ? <TerminalRunRow run={run} lit={lit} /> : <StreamRunRow run={run} lit={lit} />
}

function ModeTag({ mode }: { mode: TaskRun['mode'] }) {
  return <span className={cls('run-mode', mode === 'terminal' && 'term')}>{modeLabel(mode)}</span>
}

// 执行器：Claude Code 是老默认，不标；工作台 Agent、DeepSeek 标出来
function HarnessTag({ harness }: { harness: TaskRun['harness'] }) {
  if (!harness || harness === 'claude') return null
  return <span className={cls('run-mode', harness === 'agent' && 'agent')} data-harness={harness}>{harnessLabel(harness)}</span>
}

const sessionHref = (id: string) => `/conversations?s=${encodeURIComponent(id)}`

// 本页流里的确认卡片：点了走数据层，过程在执行自己的流里接着出
function useDecide(objectId: string, sessionId: string): DecideProps {
  const [deciding, setDeciding] = useState('')
  const [error, setError] = useState('')
  return {
    deciding, error,
    onDecide: (id, approve) => {
      setDeciding(id)
      setError('')
      decideRunCall(id, approve, objectId, sessionId || undefined)
        .catch((e: unknown) => setError(`没提交上：${errorText(e)}`))
        .finally(() => setDeciding(''))
    },
  }
}

// 终端执行：输出就是回写的结论摘要；进行中时可以手动标记结束
function TerminalRunRow({ run, lit }: { run: TaskRun; lit: boolean }) {
  const finished = runFinished(run)
  const [open, setOpen] = useState(() => !finished || lit)
  const expanded = !finished || open
  const [asking, setAsking] = useState(false)
  const note = runNote(run)
  const extra = extraOf(run.prompt)
  return (
    <div className={cls('run-item', expanded && 'open', lit && 'lit')} data-run={run.id} data-status={run.status} data-mode="terminal" aria-current={lit || undefined}>
      <button type="button" className="run-head" onClick={() => setOpen(!open)} aria-expanded={expanded}
        title={finished ? (open ? '收起' : '展开看结论') : undefined}>
        <span className={cls('run-chev', expanded && 'open')}><IconChevronRight /></span>
        <StatusTag status={run.status} label={finished ? undefined : '进行中'} />
        <ModeTag mode="terminal" />
        <span className={cls('run-extra', !extra && 'none')} title={extra || undefined}>{extra || '没有附加说明'}</span>
        <span className="spacer" />
        <span className="run-at">{timeAgo(run.started_at)} · {duration(run.started_at, run.finished_at)}</span>
      </button>
      {note && <div className={cls('run-note', 'run-note-' + note.tone)}>{note.text}</div>}
      {expanded && (
        <div className="run-body">
          <div className="run-meta">{run.workdir} · 记录 {run.id.slice(-8)} · 在终端里执行</div>
          {finished
            ? <Markdown source={run.output} empty="没有回写结论" />
            : <div className="run-out-empty">在终端里执行中：开始时间是发起时，结束和结论由终端里的 Claude Code 经工作台 MCP 回写。它没回写就关掉了的话，在这里标记结束</div>}
          {!finished && (
            <div className="run-actions">
              <Button variant="outline" size="sm" onClick={() => setAsking(true)}>标记结束</Button>
            </div>
          )}
        </div>
      )}
      {asking && <FinishDialog run={run} onClose={() => setAsking(false)} />}
    </div>
  )
}

function FinishDialog({ run, onClose }: { run: TaskRun; onClose: () => void }) {
  const finish = useFinishRun(run.object_id)
  const [status, setStatus] = useState<FinishRunInput['status']>('done')
  const [summary, setSummary] = useState('')
  return (
    <ConfirmDialog open title="标记结束" confirmLabel={finish.isPending ? '正在保存' : '标记结束'} busy={finish.isPending}
      onCancel={onClose}
      onConfirm={() => finish.mutate({ id: run.id, body: { status, summary: summary.trim() } }, { onSuccess: onClose })}>
      <div className="run-finish">
        <span>终端里的 Claude Code 没回写时，手动给这次执行收尾。终端标签不受影响，需要的话自己关。</span>
        <Field label="结果">
          <Select aria-label="结果" value={status} options={FINISH_OPTIONS} onValueChange={(v) => setStatus(v as FinishRunInput['status'])} />
        </Field>
        <Field label="结论摘要">
          <Textarea rows={3} value={summary} placeholder="可选：做了什么、产出在哪、还剩什么" onChange={(e) => setSummary(e.target.value)} />
        </Field>
        {finish.isError && <span className="run-note-danger" role="alert">没标记上：{errorText(finish.error)}</span>}
      </div>
    </ConfirmDialog>
  )
}

function StreamRunRow({ run, lit }: { run: TaskRun; lit: boolean }) {
  const finished = runFinished(run)
  // 看着它跑完的不收起来；跳过来定位的展开
  const [open, setOpen] = useState(() => !finished || lit)
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
  const session = agentSessionOf(r) || (run.harness === 'agent' ? live?.sessionId ?? '' : '')
  const decide = useDecide(run.object_id, session)
  return (
    <div className={cls('run-item', expanded && 'open', lit && 'lit')} data-run={run.id} data-status={r.status} aria-current={lit || undefined}>
      <button type="button" className="run-head" onClick={() => setOpen(!open)} aria-expanded={expanded}
        title={finished ? (open ? '收起' : '展开看完整输出') : undefined}>
        <span className={cls('run-chev', expanded && 'open')}><IconChevronRight /></span>
        <StatusTag status={r.status} />
        <HarnessTag harness={run.harness} />
        <ModeTag mode="stream" />
        <span className={cls('run-extra', !extra && 'none')} title={extra || undefined}>{extra || '没有附加说明'}</span>
        <span className="spacer" />
        <span className="run-at">{timeAgo(run.started_at)} · {duration(run.started_at, r.finished_at)}</span>
      </button>
      {note && <div className={cls('run-note', 'run-note-' + note.tone)}>{note.text}</div>}
      {expanded && (
        <div className="run-body">
          <div className="run-meta">{r.workdir || '没有工作目录'} · 记录 {run.id.slice(-8)}{finished ? ` · exit ${r.exit_code}` : ''}</div>
          {live
            ? <RunStream events={live.events} live={streaming && !finished} follow decide={decide} />
            : !finished
              ? <div className="run-out-empty">
                {r.status === 'waiting'
                  ? '在等你确认一个写操作。这次执行不是从本页发起的，到它的会话里确认或拒绝'
                  : '这次执行不是从本页发起的，输出在执行结束后才能看到'}
              </div>
              : detail.isError
                ? <ErrorState compact title="完整输出加载失败" error={detail.error} onRetry={() => detail.refetch()} />
                : <RunOutput blocks={blocks} />}
          {(!finished || session) && (
            <div className="run-actions">
              {!finished && (
                <Button variant="danger" size="sm" disabled={cancel.isPending || cancel.isSuccess} onClick={() => cancel.mutate(run.id)}>
                  {cancel.isPending || cancel.isSuccess ? '正在取消' : '取消执行'}
                </Button>
              )}
              {session && (
                <Link className="run-link" to={sessionHref(session)}>{finished ? '打开会话继续' : '打开会话'}</Link>
              )}
              {cancel.isError && <span className="run-note-danger" role="alert">取消失败：{errorText(cancel.error)}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
