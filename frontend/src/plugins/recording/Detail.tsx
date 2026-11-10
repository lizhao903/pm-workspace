// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 录音详情（/recording/:id，M1 + M4a + M5）：音频播放器 + 带时间戳和说话人标签的段落（点一段跳音频）+
// 可编辑的转写全文（防抖自动保存）、标题行内重命名、说话人（改名/绑定联系人/重新识别）、
// 纪要（Markdown/结论/图表 + 生成/SOP）、待确认候选（确认建任务/忽略）、文件清单与下载。
// 状态/转写/纪要/说话人进度、失败原因、重新转写、删除；导出/归档/搜索是 M3，不放无功能的按钮。
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import {
  errorText, isApiError, recordingAudioUrl, useDeleteRecording, usePatchRecording, useRecording, useRecordingSettings,
  useRetranscribe,
} from '../../core/data'
import { Button, ConfirmDialog, ErrorState, LoadingState, PageTitle, Pill, Textarea, cls } from '../../core/ui'
import { FilesSection } from './Files'
import { MinutesSection } from './Minutes'
import { InlineRename } from './Rename'
import { SpeakersSection } from './Speakers'
import { TodosSection } from './Todos'
import {
  clampPct, fmtDuration, jobText, minutesThreshold, recordingPath, speakerColor, speakerDisplayName, speakerMap,
  statusText, statusTone,
} from './model'
import './recording.css'

const SAVE_MS = 800

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export function Detail() {
  const rest = useParams()['*'] ?? ''
  const id = decodeURIComponent(rest.split('/')[0] ?? '')
  const q = useRecording(id || null)
  const settings = useRecordingSettings()
  const patch = usePatchRecording()
  const retranscribe = useRetranscribe()
  const del = useDeleteRecording()
  const navigate = useNavigate()

  const audioRef = useRef<HTMLAudioElement>(null)
  const timerRef = useRef<number | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState('')
  const [actionError, setActionError] = useState('')
  const [confirmRetranscribe, setConfirmRetranscribe] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const recording = q.data
  const serverText = recording?.transcript ?? ''
  const value = draft ?? serverText
  const dirty = draft !== null && draft !== serverText

  // 停手 800 毫秒自动保存；失焦立刻保存（flushSave 会先清掉定时器）
  useEffect(() => {
    if (!dirty) return
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      saveTranscript()
    }, SAVE_MS)
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [draft]) // eslint-disable-line react-hooks/exhaustive-deps

  function saveTranscript() {
    if (!recording || draft === null || draft === recording.transcript) return
    setSaveState('saving')
    setSaveError('')
    patch.mutate({ id: recording.id, patch: { transcript: draft } }, {
      onSuccess: () => setSaveState('saved'),
      onError: (e) => { setSaveState('error'); setSaveError(errorText(e)) },
    })
  }

  function flushSave() {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (dirty) saveTranscript()
  }

  function doRetranscribe() {
    if (!recording) return
    setConfirmRetranscribe(false)
    setActionError('')
    retranscribe.mutate(recording.id, {
      onSuccess: () => { setDraft(null); setSaveState('idle'); setSaveError('') },
      onError: (e) => setActionError(`重新转写失败：${errorText(e)}`),
    })
  }

  function doDelete() {
    if (!recording) return
    setActionError('')
    del.mutate(recording.id, {
      onSuccess: () => { setConfirmDelete(false); navigate(recordingPath()) },
      onError: (e) => { setConfirmDelete(false); setActionError(`删除失败：${errorText(e)}`) },
    })
  }

  /** 点段落跳到音频对应位置并播放；浏览器拒绝自动播放时至少把进度定过去 */
  function seek(ms: number) {
    const a = audioRef.current
    if (!a) return
    a.currentTime = Math.max(0, ms) / 1000
    void a.play().catch(() => { /* 被自动播放策略拦下时停在定位处，用户再点播放 */ })
  }

  if (!id) {
    return (
      <section className="rec-page">
        <PageTitle actions={<Link to={recordingPath()}><Button size="sm">返回录音列表</Button></Link>}>录音</PageTitle>
        <ErrorState title="找不到这条录音" error="地址里没有录音 id" />
      </section>
    )
  }
  if (q.isPending) {
    return <section className="rec-page"><PageTitle>录音</PageTitle><LoadingState /></section>
  }
  if (q.isError) {
    const notFound = isApiError(q.error, 'not_found')
    return (
      <section className="rec-page">
        <PageTitle>录音</PageTitle>
        <ErrorState title={notFound ? '这条录音不存在或已删除' : '录音没加载出来'} error={errorText(q.error)}
          onRetry={notFound ? undefined : () => void q.refetch()} />
        <p><Link className="rec-back" to={recordingPath()}>← 返回录音列表</Link></p>
      </section>
    )
  }
  if (!recording) {
    return <section className="rec-page"><PageTitle>录音</PageTitle><LoadingState /></section>
  }

  const r = recording
  const transcribeBusy = r.status === 'uploaded' || r.status === 'transcribing'
    || (r.job?.kind !== 'summarize' && r.job?.kind !== 'diarize'
      && (r.job?.status === 'pending' || r.job?.status === 'running'))
  const summaryBusy = r.status === 'summarizing'
    || (r.job?.kind === 'summarize' && (r.job.status === 'pending' || r.job.status === 'running'))
  const diarizeBusy = r.job?.kind === 'diarize' && (r.job.status === 'pending' || r.job.status === 'running')
  const busyJob = transcribeBusy || summaryBusy
  // 说话人识别的进度/成败放在「说话人」区，顶部任务条只显示转写/纪要
  const activeJob = r.job && r.job.kind !== 'diarize' && (busyJob || r.job.status === 'failed')
  const threshold = minutesThreshold(settings.data?.minutes_threshold)
  const spkMap = speakerMap(r.speakers)

  return (
    <section className="rec-page">
      <Link className="rec-back" to={recordingPath()}>← 返回录音列表</Link>
      <PageTitle parent="录音" desc={`${statusText(r.status)}${r.duration_ms > 0 ? ` · ${fmtDuration(r.duration_ms)}` : ''}`}
        actions={
          <>
            <Button variant={r.status === 'failed' ? 'primary' : 'ghost'} disabled={retranscribe.isPending || busyJob || diarizeBusy}
              title={busyJob || diarizeBusy ? '还有任务在跑，等它结束再重试' : undefined}
              onClick={() => (r.status === 'failed' ? doRetranscribe() : setConfirmRetranscribe(true))}>
              {retranscribe.isPending ? '提交中…' : '重新转写'}
            </Button>
            <Button variant="danger-ghost" disabled={del.isPending} onClick={() => setConfirmDelete(true)}>删除</Button>
          </>
        }>
        <InlineRename id={r.id} title={r.title} className="rec-title-lg" onError={setActionError} />
      </PageTitle>

      {actionError && <div className="rec-err" role="alert">{actionError}</div>}

      {r.job && activeJob && (
        <div className="rec-job">
          <Pill label={statusText(r.status)} color={statusTone(r.status)} />
          <span className="rec-job-text">{jobText(r.job)}</span>
          {busyJob && (
            <span className="rec-progress" role="progressbar" aria-label="任务进度" aria-valuenow={clampPct(r.job.progress)}
              aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${clampPct(r.job.progress)}%` }} />
            </span>
          )}
        </div>
      )}

      {r.status === 'failed' && (
        <div className="rec-err" role="alert">
          <b>转写失败</b>
          {r.error ? `：${r.error}` : ''}。原始音频还在，可以点「重新转写」再跑一次。
        </div>
      )}

      <section className="rec-section">
        <div className="rec-section-title">音频</div>
        {r.has_audio ? (
          <audio ref={audioRef} className="rec-audio" controls preload="metadata" src={recordingAudioUrl(r.id)} />
        ) : <span className="rec-faint">这条录音没有音频文件</span>}
      </section>

      {r.segments.length > 0 && (
        <section className="rec-section">
          <div className="rec-section-title">段落<span className="rec-faint">点一段跳到音频对应位置</span></div>
          <ol className="rec-segs">
            {r.segments.map((seg) => {
              const spk = seg.speaker ? spkMap.get(seg.speaker) : undefined
              return (
                <li key={seg.seq}>
                  <button type="button" className="rec-seg" onClick={() => seek(seg.start_ms)}>
                    <span className="rec-seg-t">{fmtDuration(seg.start_ms)}</span>
                    {spk ? (
                      <span className="rec-seg-spk" style={{ color: speakerColor(spk.label), borderColor: speakerColor(spk.label) }}>
                        {speakerDisplayName(spk)}
                      </span>
                    ) : null}
                    <span className="rec-seg-x">{seg.text}</span>
                  </button>
                </li>
              )
            })}
          </ol>
        </section>
      )}

      <section className="rec-section">
        <div className="rec-section-title">
          <span>转写全文</span>
          <span className={cls('rec-save', saveState === 'error' && 'bad')} role="status">
            {saveState === 'saving' ? '保存中…' : saveState === 'saved' ? '已保存' : saveState === 'error' ? `保存失败：${saveError}` : ''}
          </span>
        </div>
        <Textarea className="rec-transcript" aria-label="转写全文" rows={10} value={value}
          placeholder="还没有转写文本；转写完成后会出现在这里，也可以直接粘贴或修改"
          onChange={(e) => { setDraft(e.target.value); setSaveState('idle'); setSaveError('') }}
          onBlur={flushSave} />
        <div className="rec-section-hint">失焦或停手 0.8 秒自动保存。段落是转写原文，改全文不会改原始时间戳。</div>
      </section>

      <SpeakersSection r={r} />
      <MinutesSection r={r} />
      <TodosSection r={r} threshold={threshold} />
      <FilesSection id={r.id} active={busyJob} revision={`${r.status}:${r.updated_at}`} />

      <ConfirmDialog open={confirmRetranscribe} title="重新转写这条录音？" confirmLabel="重新转写" busy={retranscribe.isPending}
        onCancel={() => setConfirmRetranscribe(false)} onConfirm={doRetranscribe}>
        会重新跑一遍本机 whisper.cpp，覆盖现在的段落和全文；已经手工改过的文本也会被新结果覆盖。
      </ConfirmDialog>
      <ConfirmDialog open={confirmDelete} danger title="删除这条录音？" confirmLabel="删除" busy={del.isPending}
        impacts={r.has_audio ? ['原始音频文件一起删除，不能恢复'] : ['录音记录一起删除，不能恢复']}
        onCancel={() => setConfirmDelete(false)} onConfirm={doDelete}>
        删除后列表里不再出现这条录音；已经转成的任务或文档不会跟着删。
      </ConfirmDialog>
    </section>
  )
}
