// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 任务详情「工作区」下的「最近一次测试」（AUTO-08，SPEC-tasks-4.63 起）：状态、各步结果（退出码、用时、输出尾部）、报告链接、截图；
// 跑着时有「停止」，没在跑、工作区在用、档案里有测试命令时有「运行测试」。测试在后端跑：构建 → 起测试环境 → 测试 → 冒烟，跑完回收环境；
// 研发 pipeline 要求保留时（AUTO-09，SPEC-tasks-4.76）测试环境留给人工验收：显示「测试环境保留到 X，可访问」和「回收」按钮。
import { useState } from 'react'
import {
  ENV_RELEASE_LABEL, STEP_STATUS_LABEL, TEST_STATUS_LABEL, durationText, errorText, testReportUrl, testShotUrl, testSummary, testTone,
  useProjectProfile, useReleaseTestEnv, useStartTestRun, useStopTestRun, useTaskTestRuns, type TestRun, type TestStep,
} from '../../core/data'
import { Button, cls } from '../../core/ui'

/** 跑着时多久取一次（事件流也会推，这是兜底） */
const RUNNING_POLL_MS = 2_000
/** 档案里这几条命令测试会跑 */
const RUNNABLE = ['build', 'test_env', 'test', 'smoke'] as const

const when = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function TestRunBlock({ taskId, projectId, canRun, poll }: { taskId: string; projectId: string; canRun: boolean; poll: number | false }) {
  const runs = useTaskTestRuns(taskId, {
    refetchInterval: (rows) => (rows?.[0]?.status === 'running' ? RUNNING_POLL_MS : poll),
  })
  const profile = useProjectProfile(projectId)
  const start = useStartTestRun(taskId)
  const [err, setErr] = useState('')
  const last = runs.data?.[0]
  if (runs.isPending || runs.isError) return null
  if (!last && !canRun) return null
  const cmds = profile.data?.commands ?? {}
  const runnable = RUNNABLE.some((k) => cmds[k]?.command)
  const running = last?.status === 'running'
  const run = () => {
    setErr('')
    start.mutate(undefined, { onError: (e) => setErr(errorText(e)) })
  }
  return (
    <div className="wtt" role="group" aria-label="最近一次测试" data-section="test-run">
      <div className="wtt-head">
        <span className="wtt-title">最近一次测试</span>
        {last && <span className={cls('wtt-badge', testTone(last.status))}>{TEST_STATUS_LABEL[last.status]}</span>}
        {last && <span className="wt-muted">{when(last.started_at)}{last.source === 'sop' ? '，SOP 发起' : ''}</span>}
        <span className="wtt-actions">
          {last?.report_path && !running && (
            <a className="wtt-link" href={testReportUrl(last.id)} target="_blank" rel="noreferrer">看报告</a>
          )}
          {running && last && <StopButton id={last.id} onError={setErr} />}
          {!running && canRun && runnable && (
            <Button size="sm" variant="outline" disabled={start.isPending} onClick={run}>{start.isPending ? '起测试中…' : last ? '再跑一次' : '运行测试'}</Button>
          )}
        </span>
      </div>
      {!last && (
        <span className="wt-muted">
          {runnable ? '还没跑过：按项目档案的命令构建、起测试环境、跑测试和冒烟，跑完写报告、回收环境'
            : profile.data ? '项目档案里还没填构建、测试、起测试环境或冒烟命令，到项目的档案里填' : ''}
        </span>
      )}
      {last && <TestRunBody r={last} />}
      {err && <div className="wt-err" role="alert">{running ? '没停下：' : '测试没起来：'}{err}</div>}
    </div>
  )
}

function StopButton({ id, onError }: { id: string; onError: (s: string) => void }) {
  const stop = useStopTestRun()
  return (
    <Button size="sm" variant="danger" disabled={stop.isPending}
      onClick={() => { onError(''); stop.mutate(id, { onError: (e) => onError(errorText(e)) }) }}>
      {stop.isPending ? '停止中…' : '停止'}
    </Button>
  )
}

function TestRunBody({ r }: { r: TestRun }) {
  const tone = testTone(r.status)
  return (
    <>
      <div className={cls('wtt-summary', tone)} role={tone === 'bad' ? 'alert' : undefined}>{testSummary(r)}</div>
      <ol className="wtt-steps">
        {r.steps.map((s) => <StepRow key={s.key} s={s} />)}
      </ol>
      {r.url && <EnvLine r={r} />}
      {r.junit && r.junit.failed.length > 0 && (
        <div className="wtt-failed">
          <span className="wt-muted">没通过的用例：</span>
          <ul>{r.junit.failed.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      )}
      {r.shots.length > 0 && (
        <div className="wtt-shots">
          <span className="wt-muted">截图 {r.shots.length} 张：</span>
          {r.shots.map((n) => <a key={n} className="wtt-link" href={testShotUrl(r.id, n)} target="_blank" rel="noreferrer">{n}</a>)}
        </div>
      )}
    </>
  )
}

/** 测试环境一行：在跑时可点；保留中写保留到什么时候、可点、能手动回收；其余写已回收（保留过的带原因） */
function EnvLine({ r }: { r: TestRun }) {
  const release = useReleaseTestEnv()
  const [err, setErr] = useState('')
  const link = <a className="wtt-link" href={r.url} target="_blank" rel="noreferrer">{r.url}</a>
  if (r.env_state === 'kept') {
    return (
      <div className="wtt-env kept" role="status" aria-label="保留的测试环境">
        <span>测试环境保留到 {r.env_keep_until ? when(r.env_keep_until) : '验收结束'}，可访问：{link}</span>
        <span className="wt-muted">验收结束或到点自动回收</span>
        <Button size="sm" variant="outline" disabled={release.isPending}
          onClick={() => { setErr(''); release.mutate(r.id, { onError: (e) => setErr(errorText(e)) }) }}>
          {release.isPending ? '回收中…' : '回收'}
        </Button>
        {err && <div className="wt-err" role="alert">没回收：{err}</div>}
      </div>
    )
  }
  const why = r.env_state === 'released' && r.env_release_reason ? `（已回收：${ENV_RELEASE_LABEL[r.env_release_reason]}）` : '（已回收）'
  return (
    <div className="wt-muted">
      测试环境 {r.status === 'running' ? link : <code>{r.url}</code>}
      {r.status === 'running' ? '（跑完自动回收）' : why}
    </div>
  )
}

function StepRow({ s }: { s: TestStep }) {
  const tone = testTone(s.status)
  const ran = !!s.started_at
  const bits = [
    s.exit_code !== null ? `退出码 ${s.exit_code}` : '',
    ran && s.status !== 'running' ? durationText(s.duration_ms) : '',
    s.timed_out ? '超时' : '',
  ].filter(Boolean)
  return (
    <li className="wtt-step">
      <div className="wtt-step-line">
        <span className="wtt-step-label">{s.label}</span>
        <span className={cls('wtt-step-state', tone)}>{STEP_STATUS_LABEL[s.status]}</span>
        {bits.length > 0 && <span className="wt-muted">{bits.join('，')}</span>}
        <code className="wtt-cmd" title={s.command}>{s.command}</code>
      </div>
      {s.error && s.status !== 'passed' && <div className={cls('wtt-step-err', tone)}>{s.error}</div>}
      {s.ready && s.status === 'running' && <div className="wt-muted">等就绪：{s.ready}</div>}
      {s.output && (
        <details className="wtt-out">
          <summary>输出尾部</summary>
          <pre>{s.output}</pre>
        </details>
      )}
    </li>
  )
}
