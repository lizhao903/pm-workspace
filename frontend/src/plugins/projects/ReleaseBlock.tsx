// 任务详情「工作区」下的「最近一次发布」（AUTO-10，SPEC-tasks-4.77 到 4.81）：状态、版本、一句话摘要（等审批时写明审批前不动生产；回滚情况）、
// 各步按审批前 / 审批后分组（退出码、用时、输出尾部）、更新日志、报告链接；在跑时能停止，等审批时能作废（同一个停止接口）。
// 发布由 SOP「发布 pipeline」发起，上线审批走它的人工节点，这里不放「批准上线」。没有发布记录时整块不显示。
import { useState } from 'react'
import {
  RELEASE_PHASE_LABEL, RELEASE_STATUS_LABEL, STEP_STATUS_LABEL, durationText, errorText, releaseReportUrl, releaseSummary, releaseTone, testTone,
  useStopRelease, useTaskReleases, type Release, type ReleasePhase, type ReleaseStep,
} from '../../core/data'
import { Button, cls } from '../../core/ui'

/** 跑着时多久取一次（事件流也会推，这是兜底） */
const RUNNING_POLL_MS = 2_000

const when = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function ReleaseBlock({ taskId, poll }: { taskId: string; poll: number | false }) {
  const rows = useTaskReleases(taskId, {
    refetchInterval: (list) => (list?.[0]?.status === 'running' ? RUNNING_POLL_MS : poll),
  })
  const stop = useStopRelease()
  const [err, setErr] = useState('')
  const last = rows.data?.[0]
  if (!last) return null
  const running = last.status === 'running'
  const prepared = last.status === 'prepared'
  const tone = releaseTone(last.status)
  const doStop = () => {
    setErr('')
    stop.mutate(last.id, { onError: (e) => setErr(errorText(e)) })
  }
  return (
    <div className="wtt" role="group" aria-label="最近一次发布" data-section="release">
      <div className="wtt-head">
        <span className="wtt-title">最近一次发布</span>
        <span className={cls('wtt-badge', tone)}>{RELEASE_STATUS_LABEL[last.status]}</span>
        {last.version && <code>{last.version}</code>}
        <span className="wt-muted">{when(last.started_at)}{last.source === 'sop' ? '，SOP 发起' : ''}</span>
        <span className="wtt-actions">
          {last.report_path && !running && (
            <a className="wtt-link" href={releaseReportUrl(last.id)} target="_blank" rel="noreferrer">看报告</a>
          )}
          {(running || prepared) && (
            <Button size="sm" variant={running ? 'danger' : 'outline'} disabled={stop.isPending} onClick={doStop}>
              {stop.isPending ? (running ? '停止中…' : '作废中…') : running ? '停止' : '作废'}
            </Button>
          )}
        </span>
      </div>
      <div className={cls('wtt-summary', tone)} role={tone === 'bad' ? 'alert' : undefined}>{releaseSummary(last)}</div>
      {last.approved_at && <div className="wt-muted">上线审批：{when(last.approved_at)}{last.approved_by.startsWith('sop') ? '（SOP 人工审批）' : '（接口）'}</div>}
      {(['prepare', 'deploy'] as const).map((ph) => <PhaseSteps key={ph} r={last} phase={ph} />)}
      {last.changelog && (
        <details className="wtt-out">
          <summary>更新日志</summary>
          <pre>{last.changelog}</pre>
        </details>
      )}
      {err && <div className="wt-err" role="alert">{running ? '没停下：' : '没作废：'}{err}</div>}
    </div>
  )
}

function PhaseSteps({ r, phase }: { r: Release; phase: ReleasePhase }) {
  const steps = r.steps.filter((s) => s.phase === phase)
  if (steps.length === 0) return null
  return (
    <div className="wtr-phase">
      <span className="wtr-phase-title">{RELEASE_PHASE_LABEL[phase]}</span>
      <ol className="wtt-steps">
        {steps.map((s) => <StepRow key={s.key} s={s} />)}
      </ol>
    </div>
  )
}

function StepRow({ s }: { s: ReleaseStep }) {
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
      {s.output && (
        <details className="wtt-out">
          <summary>输出尾部</summary>
          <pre>{s.output}</pre>
        </details>
      )}
    </li>
  )
}
