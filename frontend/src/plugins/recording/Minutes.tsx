// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 详情页「纪要」区：Markdown 摘要、结论、待办建议、流程图/树形图；按钮生成/重新生成/发起纪要 SOP 与进度。
// 纪要由本机 Agent 生成（可以走设置里的 SOP 流程），生成中状态 summarizing 由数据层轮询刷新。
import { useEffect, useState } from 'react'
import {
  errorText, useGenerateMinutes, useRecordingSettings, useStartSop, type Recording,
} from '../../core/data'
import { Button, ConfirmDialog, Markdown, Tag } from '../../core/ui'
import { Diagrams } from './Diagrams'
import { actionKindText, clampPct, confidencePct, confidenceTone, fmtCreatedAt } from './model'

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60)
  const ss = String(sec % 60).padStart(2, '0')
  return `${m}:${ss}`
}

export function MinutesSection({ r }: { r: Recording }) {
  const settings = useRecordingSettings()
  const generate = useGenerateMinutes()
  const sop = useStartSop()
  const [confirmRegen, setConfirmRegen] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [elapsed, setElapsed] = useState(0)

  const generating = r.status === 'summarizing'
    || (r.job?.kind === 'summarize' && (r.job.status === 'pending' || r.job.status === 'running'))
  const transcribing = r.status === 'uploaded' || r.status === 'transcribing'
    || (r.job?.kind !== 'summarize' && (r.job?.status === 'pending' || r.job?.status === 'running'))
  const summaryFailed = r.job?.kind === 'summarize' && r.job.status === 'failed'
  const canRun = r.transcript.trim().length > 0
  const minutes = r.minutes
  const summary = minutes?.summary_md ?? ''
  const conclusions = Array.isArray(minutes?.conclusions) ? minutes.conclusions : []
  const actions = Array.isArray(minutes?.actions) ? minutes.actions : []
  const diagrams = minutes?.diagrams ?? null
  const flow = settings.data?.minutes_flow ?? ''

  const doGenerate = () => {
    setConfirmRegen(false)
    setError('')
    setNote('')
    generate.mutate(r.id, {
      onSuccess: () => setNote('已提交生成纪要任务，完成后这里会自动刷新'),
      onError: (e) => setError(`生成纪要失败：${errorText(e)}`),
    })
  }

  const doSop = () => {
    setError('')
    setNote('')
    sop.mutate({ id: r.id, flow }, {
      onSuccess: (res) => setNote(`已发起纪要流程「${res.flow || '内置流程'}」，完成后文件与纪要会出现在这里`),
      onError: (e) => setError(`发起纪要 SOP 失败：${errorText(e)}`),
    })
  }

  const busy = generate.isPending || sop.isPending || generating || transcribing
  const generateLabel = generating ? '生成中…' : minutes ? '重新生成' : '生成纪要'

  // 生成中显示已用时间：模型慢或排队时，光一个 0% 会让人以为卡死。
  const runJob = generating ? r.job : null
  const pct = clampPct(runJob?.progress ?? 0)
  useEffect(() => {
    if (!generating) {
      setElapsed(0)
      return
    }
    const start = Date.now()
    setElapsed(0)
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [generating])

  return (
    <section className="rec-section">
      <div className="rec-section-title">
        <span>纪要</span>
        <span className="rec-faint">
          {minutes
            ? `${minutes.model || r.minutes_model || '未知模型'} · ${fmtCreatedAt(minutes.generated_at) || '生成时间未知'}`
            : '本机 Agent 读转写全文，生成摘要、结论、待办建议和图表'}
        </span>
        <span className="rec-section-actions">
          <Button size="sm" variant={minutes ? 'ghost' : 'primary'} disabled={!canRun || busy}
            title={!canRun ? '还没有转写全文，转写完成后才能生成' : undefined}
            onClick={() => (minutes ? setConfirmRegen(true) : doGenerate())}>
            {generateLabel}
          </Button>
          <Button size="sm" variant="outline" disabled={!canRun || busy}
            title={flow ? `按设置里的流程「${flow}」发起` : '按设置里的流程发起；没设置就用内置「会议纪要整理」'}
            onClick={doSop}>
            {sop.isPending ? '发起中…' : '发起纪要 SOP'}
          </Button>
        </span>
      </div>

      {!canRun && <div className="rec-section-hint">还没有转写全文。转写完成（或手动粘贴全文）后才能生成纪要。</div>}
      {generating && (
        <div className="rec-generating" role="status">
          <div className="rec-generating-head">
            <span>{runJob?.status === 'pending' ? '排队等待生成纪要…' : `正在生成纪要 · 已用 ${fmtElapsed(elapsed)}`}</span>
            {runJob && <span className="rec-faint">{pct}%</span>}
          </div>
          {runJob && (
            <span className="rec-progress" role="progressbar" aria-label="纪要生成进度"
              aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${pct}%` }} />
            </span>
          )}
          <div className="rec-faint">
            {runJob?.status === 'pending'
              ? '前面的任务（转写/说话人识别）跑完就轮到它。'
              : '本机模型生成中，通常 1–5 分钟；模型较大或正忙时会更久，完成后这里会自动刷新。'}
          </div>
        </div>
      )}
      {summaryFailed && !error && (
        <div className="rec-err" role="alert">
          <b>上次生成纪要失败</b>{r.job?.last_error ? `：${r.job.last_error}` : ''}。可以点「重新生成」再试。
        </div>
      )}
      {error && <div className="rec-err" role="alert">{error}</div>}
      {note && <div className="rec-note ok" role="status">{note}</div>}

      {!minutes ? (
        <p className="rec-faint">
          还没有纪要。点「生成纪要」让本机 Agent 读一遍转写稿；也可以在设置里打开「转写完成后自动生成」。
        </p>
      ) : (
        <div className="rec-minutes">
          <Markdown source={summary} empty="这份纪要没有摘要" className="rec-minutes-summary" />

          {conclusions.length > 0 && (
            <div className="rec-minutes-block">
              <div className="rec-minutes-subtitle">结论</div>
              <ul className="rec-points">
                {conclusions.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          )}

          {actions.length > 0 && (
            <div className="rec-minutes-block">
              <div className="rec-minutes-subtitle">待办建议</div>
              <ul className="rec-actions">
                {actions.map((a, i) => (
                  <li key={i} className="rec-action">
                    <div className="rec-action-head">
                      <Tag>{actionKindText(a.kind)}</Tag>
                      <b className="rec-action-title">{a.title || '未命名待办'}</b>
                      <span className="rec-confidence" title={`置信度 ${confidencePct(a.confidence)}%`}>
                        <span className="rec-confidence-bar" aria-hidden="true">
                          <span style={{ width: `${confidencePct(a.confidence)}%`, background: confidenceTone(a.confidence) }} />
                        </span>
                        {confidencePct(a.confidence)}%
                      </span>
                    </div>
                    {a.detail && <div className="rec-action-detail">{a.detail}</div>}
                    <div className="rec-action-meta">
                      {a.project ? `项目：${a.project}` : ''}
                      {a.owner ? `${a.project ? ' · ' : ''}负责人：${a.owner}` : ''}
                      {a.due ? `${a.project || a.owner ? ' · ' : ''}截止：${a.due}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Diagrams diagrams={diagrams} />
        </div>
      )}

      <ConfirmDialog open={confirmRegen} title="重新生成纪要？" confirmLabel="重新生成" busy={generate.isPending}
        onCancel={() => setConfirmRegen(false)} onConfirm={doGenerate}>
        会重新读一遍现在的转写全文，覆盖已有的纪要、候选和图表；已经确认过的候选任务不受影响。
      </ConfirmDialog>
    </section>
  )
}
