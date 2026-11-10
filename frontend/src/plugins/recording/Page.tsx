// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 录音页（/recording）：顶部「开始录音」，下面是录音工作区（未开始/授权中/录音中/暂停/上传中/失败重试）和录音列表。
// 录音走浏览器 getUserMedia + MediaRecorder，停止后先把 Blob 传到 attachments，再跳详情看转写。
// 列表按状态本地筛（转写中要含排队与转写中两态），行的进度条和状态每 2 秒刷新由数据层轮询。
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import {
  errorText, useCreateRecording, useRecordingList, useUploadAudio, type RecordingSummary,
} from '../../core/data'
import { Button, EmptyState, ErrorState, Input, LoadingState, PageTitle, Pill, Tag, cls } from '../../core/ui'
import {
  LIST_FILTERS, LIST_LIMIT, clampPct, fmtCreatedAt, fmtDuration, matchesFilter, mediaErrorText, recordingPath, statusText, statusTone,
  type ListFilter,
} from './model'
import { Detail } from './Detail'
import { InlineRename } from './Rename'
import './recording.css'

/** 路由：/recording 列表，/recording/<id> 详情（模块挂在 recording/* 下，用通配段分派） */
export default function Page() {
  const rest = useParams()['*'] ?? ''
  return rest ? <Detail /> : <ListPage />
}

type Phase = 'idle' | 'requesting' | 'recording' | 'paused' | 'uploading' | 'error'

/** 录音文件格式优先级：opus 的 webm 最小最稳，Safari 只有 mp4，最后交给浏览器默认 */
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return ''
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
}

function ListPage() {
  const list = useRecordingList({ limit: LIST_LIMIT })
  const [filter, setFilter] = useState<ListFilter>('')
  const [startSignal, setStartSignal] = useState(0)
  const navigate = useNavigate()
  const rows = (list.data ?? []).filter((r) => matchesFilter(filter, r.status))

  return (
    <section className="rec-page">
      <PageTitle desc="浏览器内录音，本机 whisper.cpp 转写；音频和文本都不出本机"
        actions={<Button variant="primary" size="sm" onClick={() => setStartSignal((n) => n + 1)}>开始录音</Button>}>
        录音
      </PageTitle>

      <Recorder startSignal={startSignal} onDone={(id) => navigate(recordingPath(id))} />

      <div className="rec-filters" role="group" aria-label="状态筛选">
        {LIST_FILTERS.map((f) => (
          <button key={f.key || 'all'} type="button" aria-pressed={filter === f.key} className={cls(filter === f.key && 'on')}
            onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>

      {list.isPending ? <LoadingState /> : list.isError ? (
        <ErrorState title="录音列表没加载出来" error={errorText(list.error)} onRetry={() => void list.refetch()} />
      ) : !list.data.length ? (
        <EmptyState title="还没有录音" desc="点右上「开始录音」，录完会自动保存到本机并排队转写"
          action={<Button variant="primary" onClick={() => setStartSignal((n) => n + 1)}>开始录音</Button>} />
      ) : !rows.length ? (
        <EmptyState title="没有符合条件的录音" action={<Button size="sm" onClick={() => setFilter('')}>清除筛选</Button>} />
      ) : (
        <ul className="rec-list" aria-label="录音列表">
          {rows.map((r) => <Row key={r.id} r={r} onOpen={() => navigate(recordingPath(r.id))} />)}
        </ul>
      )}
    </section>
  )
}

/** 一行录音：标题（可直接铅笔重命名）、创建时间、项目、状态、时长、转写进度、纪要/待确认/任务标记；点标题进详情 */
function Row({ r, onOpen }: { r: RecordingSummary; onOpen: () => void }) {
  const active = r.status === 'uploaded' || r.status === 'transcribing'
  const [renameError, setRenameError] = useState('')
  return (
    <li className="rec-row">
      <div className="rec-row-body">
        <div className="rec-row-main">
          <InlineRename id={r.id} title={r.title} onOpen={onOpen} onError={setRenameError} />
          <span className="rec-row-meta">
            {fmtCreatedAt(r.created_at) || '—'}
            {r.project_title ? ` · ${r.project_title}` : ''}
            {r.error && r.status === 'failed' ? <span className="rec-row-err"> · {r.error}</span> : null}
            {renameError ? <span className="rec-row-err" role="alert"> · {renameError}</span> : null}
          </span>
        </div>
        <span className="rec-row-tags">
          {r.speaker_count > 0 ? <Tag>{r.speaker_count} 位说话人</Tag> : null}
          {r.todos_pending > 0 ? <Tag>待确认 {r.todos_pending}</Tag> : null}
          {r.has_minutes ? <Tag>已有纪要</Tag> : null}
          {r.task_count > 0 ? <Tag>{r.task_count} 个任务</Tag> : null}
        </span>
        <Pill label={statusText(r.status)} color={statusTone(r.status)} />
        <span className="rec-row-dur">{fmtDuration(r.duration_ms)}</span>
        {active && r.job ? (
          <span className="rec-progress" role="progressbar" aria-label="转写进度" aria-valuenow={clampPct(r.job.progress)}
            aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${clampPct(r.job.progress)}%` }} />
          </span>
        ) : <span className="rec-row-progress-gap" aria-hidden="true" />}
      </div>
    </li>
  )
}

/* ---------- 录音工作区 ---------- */

function Recorder({ startSignal, onDone }: { startSignal: number; onDone: (id: string) => void }) {
  const create = useCreateRecording()
  const upload = useUploadAudio()
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [title, setTitle] = useState('')
  const [error, setError] = useState('')

  const mountedRef = useRef(true)
  const streamRef = useRef<MediaStream | null>(null)
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const blobRef = useRef<Blob | null>(null)
  const draftIdRef = useRef<string | null>(null)
  const discardRef = useRef(false)
  /** 从开始申请麦克风到录完保存之间禁止重入（连点、StrictMode 双跑 effect） */
  const lockRef = useRef(false)
  const startedAtRef = useRef(0)
  const accumulatedRef = useRef(0)
  const tickRef = useRef<number | null>(null)
  const titleRef = useRef(title)
  const finishRef = useRef<() => Promise<void>>(async () => {})

  useEffect(() => { titleRef.current = title }, [title])

  const stopTick = () => {
    if (tickRef.current !== null) window.clearInterval(tickRef.current)
    tickRef.current = null
  }

  const runTick = () => {
    stopTick()
    tickRef.current = window.setInterval(() => {
      setElapsed(accumulatedRef.current + (performance.now() - startedAtRef.current))
    }, 200)
  }

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  /** 保存并上传：content 是音频 Blob，durationMs 是实际录了多久 */
  async function save(blob: Blob, durationMs: number) {
    setPhase('uploading')
    setError('')
    try {
      let id = draftIdRef.current
      if (!id) {
        const created = await create.mutateAsync({ title: titleRef.current.trim() })
        id = created.id
        draftIdRef.current = id
      }
      await upload.mutateAsync({ id, file: blob, durationMs })
      draftIdRef.current = null
      blobRef.current = null
      accumulatedRef.current = 0
      setElapsed(0)
      setTitle('')
      setPhase('idle')
      lockRef.current = false
      onDone(id)
    } catch (e) {
      // 草稿已建好就留着，重试只重传音频，不重复建录音
      setError(`保存失败：${errorText(e)}`)
      setPhase('error')
      lockRef.current = false
    }
  }

  /** MediaRecorder 停了：收拾流、组 Blob、进入上传 */
  async function finish() {
    stopTick()
    const mime = recRef.current?.mimeType || chunksRef.current[0]?.type || 'audio/webm'
    recRef.current = null
    const durationMs = Math.round(accumulatedRef.current)
    setElapsed(durationMs)
    stopStream()
    if (discardRef.current) {
      discardRef.current = false
      chunksRef.current = []
      return
    }
    const blob = new Blob(chunksRef.current, { type: mime })
    chunksRef.current = []
    if (!blob.size) {
      setError('没有录到声音：检查麦克风是否静音，或换一个输入设备再试')
      setPhase('error')
      lockRef.current = false
      return
    }
    blobRef.current = blob
    await save(blob, durationMs)
  }

  useEffect(() => { finishRef.current = finish })

  async function start() {
    if (lockRef.current) return
    lockRef.current = true
    discardRef.current = false
    blobRef.current = null
    draftIdRef.current = null
    setError('')
    setPhase('requesting')

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError('浏览器不允许录音：当前页面不是安全上下文。请用 http://127.0.0.1 或 https://localhost 打开工作台（内网 http 域名用不了麦克风）')
      setPhase('error')
      lockRef.current = false
      return
    }
    if (typeof MediaRecorder === 'undefined') {
      setError('这个浏览器不支持录音（没有 MediaRecorder）：换 Chrome、Edge 或新版 Safari 再试')
      setPhase('error')
      lockRef.current = false
      return
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      setError(mediaErrorText(e))
      setPhase('error')
      lockRef.current = false
      return
    }
    // 申请期间组件已经卸载：直接把流关掉，别让麦克风一直开着
    if (!mountedRef.current) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    streamRef.current = stream

    const mimeType = pickMimeType()
    let rec: MediaRecorder
    try {
      rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
    } catch {
      stopStream()
      setError('这个浏览器不支持当前的录音格式：换一个浏览器再试')
      setPhase('error')
      lockRef.current = false
      return
    }
    recRef.current = rec
    chunksRef.current = []
    rec.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }
    rec.onstop = () => { void finishRef.current() }
    accumulatedRef.current = 0
    startedAtRef.current = performance.now()
    setElapsed(0)
    runTick()
    rec.start(1000)
    setPhase('recording')
  }

  const pause = () => {
    const rec = recRef.current
    if (!rec || rec.state !== 'recording') return
    accumulatedRef.current += performance.now() - startedAtRef.current
    stopTick()
    setElapsed(accumulatedRef.current)
    rec.pause()
    setPhase('paused')
  }

  const resume = () => {
    const rec = recRef.current
    if (!rec || rec.state !== 'paused') return
    startedAtRef.current = performance.now()
    runTick()
    rec.resume()
    setPhase('recording')
  }

  /** 停止：累计时长后交给 onstop 去组 Blob、上传 */
  const stop = () => {
    const rec = recRef.current
    if (!rec) return
    if (rec.state === 'recording') accumulatedRef.current += performance.now() - startedAtRef.current
    stopTick()
    setElapsed(accumulatedRef.current)
    rec.stop()
  }

  /** 放弃：不保存，直接关掉麦克风和计时 */
  const discard = () => {
    discardRef.current = true
    stopTick()
    stopStream()
    const rec = recRef.current
    recRef.current = null
    if (rec && rec.state !== 'inactive') rec.stop()
    chunksRef.current = []
    blobRef.current = null
    draftIdRef.current = null
    accumulatedRef.current = 0
    setElapsed(0)
    setTitle('')
    setError('')
    setPhase('idle')
    lockRef.current = false
  }

  /** 失败重试：有录好的 Blob 就只重传音频，否则重新申请麦克风 */
  const retry = () => {
    if (blobRef.current) void save(blobRef.current, accumulatedRef.current)
    else void start()
  }

  // 外面点「开始录音」：只在空闲或失败时起录，录音中/上传中不重入
  useEffect(() => {
    if (startSignal <= 0) return
    if (!lockRef.current && (phase === 'idle' || phase === 'error')) void start()
    // 只响应外部信号，内部状态用 lockRef 防重入
  }, [startSignal]) // eslint-disable-line react-hooks/exhaustive-deps

  // 卸载：停计时、关麦克风、丢掉半截录音
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      discardRef.current = true
      stopTick()
      stopStream()
      const rec = recRef.current
      recRef.current = null
      if (rec && rec.state !== 'inactive') {
        try { rec.stop() } catch { /* 已经停了就不用管 */ }
      }
    }
    // 卸载时只清资源
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const active = phase === 'recording' || phase === 'paused'
  return (
    <section className={cls('rec-work', active && 'on')} aria-label="录音工作区">
      <div className="rec-work-head">
        <span className={cls('rec-dot', phase === 'recording' && 'live', phase === 'paused' && 'paused')} aria-hidden="true" />
        <b className="rec-work-title">
          {phase === 'idle' ? '准备录音' : phase === 'requesting' ? '正在申请麦克风' : phase === 'recording' ? '录音中'
            : phase === 'paused' ? '已暂停' : phase === 'uploading' ? '正在保存' : '录音没保存上'}
        </b>
        {active && <span className="rec-timer" aria-label="录音时长">{fmtDuration(elapsed)}</span>}
      </div>

      {phase === 'idle' && (
        <>
          <Input className="rec-title-input" aria-label="录音标题（可空）" placeholder="标题（可空，之后也能在详情里改）"
            value={title} onChange={(e) => setTitle(e.target.value)} />
          <div className="rec-work-actions">
            <Button variant="primary" onClick={() => void start()}>开始录音</Button>
            <span className="rec-work-hint">先允许使用麦克风；停止后自动保存到本机并排队转写</span>
          </div>
        </>
      )}

      {phase === 'requesting' && <LoadingState text="正在请求麦克风授权…" />}

      {active && (
        <div className="rec-work-actions">
          {phase === 'recording'
            ? <Button variant="outline" onClick={pause}>暂停</Button>
            : <Button variant="primary" onClick={resume}>继续</Button>}
          <Button variant="primary" onClick={stop}>停止并转写</Button>
          <Button onClick={discard}>放弃</Button>
        </div>
      )}

      {phase === 'uploading' && <LoadingState text="正在保存录音，保存后开始转写…" />}

      {phase === 'error' && <ErrorState compact title="录音失败" error={error} onRetry={retry} />}
    </section>
  )
}
