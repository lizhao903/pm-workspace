// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 录音转写插件（SPEC-recording，正式产品 frontend/src/plugins/recording/）：录音页（录音工作区 + 列表）、
// 录音详情（音频、段落、转写全文、说话人、纪要、待你确认、文件）、设置 > 插件 > 录音转写、外壳录音状态条。
// 数据和模拟引擎在 recordingdata.ts（模块级常驻，切页面不停录）。
import { useEffect, useId, useRef, useState } from 'react'
import { PageTitle } from './topbar'
import { cls } from './ui'
import {
  CAPTURE_SOURCES, DEMO_DEVICES, FILE_KIND_TEXT, LANGUAGE_OPTIONS, LIST_FILTERS, MODEL_OPTIONS, MODEL_STATUS_TEXT, RETENTION_OPTIONS, STATUS_TEXT,
  TODO_KIND_TEXT, bindSpeaker, captureSourceShort, captureSourceText, confidencePct, confidenceTone, confirmTodo, deleteModel, deleteRecording,
  deleteVoiceprint, diarize, discardRecording, downloadModel, elapsedOf, filesOf, fmtAt, fmtBytes, fmtDuration, generateMinutes, ignoreTodo,
  isSystemSource, jobText, matchesFilter, pauseRecording, renameRecording, renameSpeaker, resumeRecording, retranscribe, retryRecording, saveSettings,
  saveTranscript, setDenyNext, setRecorderDevice, setRecorderSource, setRecorderTitle, speakerColor, speakerName, startMinutesSop, startRecording,
  statusTone, stopRecording, useRecordingStore, type ListFilter, type Recording, type RecordingDiagrams, type RecordingSettings, type RecordingSpeaker,
  type RecordingTodo,
} from './recordingdata'
import './recording.css'

export type RecProject = { id: string; name: string }
export type RecContact = { id: string; name: string; company?: string }
/** 确认任务候选时由 App 建任务，返回编号；原型只建在内存里 */
export type RecCreateTask = (p: { title: string; desc: string; project_id: string; assignee: string; priority: string; due: string | null }) => { id: string; ref: string }

/** 录着时每半秒刷新一次计时 */
function useTick(on: boolean) {
  const [, setN] = useState(0)
  useEffect(() => {
    if (!on) return
    const t = window.setInterval(() => setN((n) => n + 1), 500)
    return () => window.clearInterval(t)
  }, [on])
}

function Pill({ label, color }: { label: string; color: string }) {
  return <span className="pill" style={{ '--c': color } as React.CSSProperties}><span className="pill-dot" />{label}</span>
}
function Progress({ value, label }: { value: number; label: string }) {
  return (
    <span className="rec-progress" role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${value}%` }} />
    </span>
  )
}
function Confidence({ value }: { value: number }) {
  return (
    <span className="rec-confidence" title={`置信度 ${confidencePct(value)}%`}>
      <span className="rec-confidence-bar" aria-hidden="true"><span style={{ width: `${confidencePct(value)}%`, background: confidenceTone(value) }} /></span>
      {confidencePct(value)}%
    </span>
  )
}
function Confirm({ title, children, label, danger, onCancel, onConfirm }: {
  title: string; children: React.ReactNode; label: string; danger?: boolean; onCancel: () => void; onConfirm: () => void
}) {
  return (
    <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="qs" role="alertdialog" aria-label={title}>
        <div className="qs-head"><b>{title}</b></div>
        <div className="rec-dialog-body">{children}</div>
        <div className="rec-actions">
          <button className={cls('btn', danger ? 'btn-danger' : 'btn-primary')} onClick={onConfirm}>{label}</button>
          <button className="btn btn-ghost" onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>
  )
}
function Pencil() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11.3 2.2 13.8 4.7 5.6 12.9 2.6 13.4l.5-3z" /><path d="M9.6 3.9l2.5 2.5" /></svg>
}

/** 行内改标题：铅笔 → 输入框；回车/失焦保存，Esc 取消；空或没变不保存，最多 200 字 */
function InlineRename({ id, title, big, onOpen }: { id: string; title: string; big?: boolean; onOpen?: () => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const cancel = useRef(false)
  const save = () => {
    if (cancel.current) { cancel.current = false; return }
    const t = (draft ?? '').trim()
    if (t.length > 200) { setErr('标题最多 200 字'); return }
    if (t && t !== title) renameRecording(id, t)
    setDraft(null); setErr('')
  }
  if (draft === null) {
    const body = <span className={cls('rec-rename-title', big && 'rec-title-lg')}>{title || '未命名录音'}</span>
    return (
      <span className="rec-rename">
        {onOpen ? <button type="button" className="rec-rename-open" onClick={onOpen}>{body}</button> : body}
        <button type="button" className="rec-icon-btn" aria-label="重命名" title="重命名" onClick={() => setDraft(title)}><Pencil /></button>
      </span>
    )
  }
  return (
    <span className="rec-rename editing">
      <input className={cls('rec-input', err && 'bad')} aria-label="新标题" autoFocus value={draft} onChange={(e) => { setDraft(e.target.value); setErr('') }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save() } else if (e.key === 'Escape') { e.preventDefault(); cancel.current = true; setDraft(null) } }}
        onBlur={save} />
      <button className="btn btn-primary" onMouseDown={(e) => e.preventDefault()} onClick={save}>保存</button>
      <button className="btn btn-ghost" onMouseDown={(e) => e.preventDefault()} onClick={() => { cancel.current = true; setDraft(null) }}>取消</button>
      {err && <span className="err-text" role="alert">{err}</span>}
    </span>
  )
}

/* ---------- 录音页 ---------- */

export function RecordingPage({ projects, contacts, onCreateTask, onOpenTask }: {
  projects: RecProject[]; contacts: RecContact[]; onCreateTask: RecCreateTask; onOpenTask?: (id: string) => void
}) {
  const st = useRecordingStore()
  const [openId, setOpenId] = useState<string | null>(null)
  const [filter, setFilter] = useState<ListFilter>('')
  // 保存成功都跳详情（只在录音页显示时听；不在录音页时回来能在列表里看到新录音）
  const seen = useRef(st.savedSeq)
  useEffect(() => {
    if (st.savedSeq !== seen.current) { seen.current = st.savedSeq; setOpenId(st.savedId) }
  }, [st.savedSeq, st.savedId])
  const projName = (r: Recording) => r.project_title || projects.find((p) => p.id === r.project_id)?.name || ''

  if (openId) {
    const r = st.recordings.find((x) => x.id === openId)
    return <Detail r={r} projects={projects} contacts={contacts} projName={r ? projName(r) : ''} threshold={st.settings.minutes_threshold}
      onBack={() => setOpenId(null)} onCreateTask={onCreateTask} onOpenTask={onOpenTask} />
  }
  const rows = st.recordings.filter((r) => matchesFilter(filter, r.status))
  return (
    <div className="page rec-page">
      <PageTitle desc="浏览器内录音，本机 whisper.cpp 转写；音频和文本都不出本机"
        actions={<button className="act act-primary" onClick={startRecording}>开始录音</button>}>录音</PageTitle>
      <Recorder />
      <div className="seg rec-filters" role="group" aria-label="状态筛选">
        {LIST_FILTERS.map((f) => (
          <button key={f.key || 'all'} className={cls(filter === f.key && 'on')} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</button>
        ))}
      </div>
      {!st.recordings.length ? (
        <div className="empty"><div className="empty-title">还没有录音</div><div className="list-sub">点右上「开始录音」，录完会自动保存到本机并排队转写</div>
          <button className="btn btn-primary" onClick={startRecording}>开始录音</button></div>
      ) : !rows.length ? (
        <div className="empty"><div className="empty-title">没有符合条件的录音</div><button className="btn" onClick={() => setFilter('')}>清除筛选</button></div>
      ) : (
        <ul className="rec-list" aria-label="录音列表">
          {rows.map((r) => {
            const active = r.status === 'uploaded' || r.status === 'transcribing'
            const pending = r.todos.filter((t) => t.status === 'pending').length
            const tasks = r.todos.filter((t) => t.status === 'confirmed' && t.object_id).length
            return (
              <li key={r.id} className="rec-row">
                <div className="rec-row-main">
                  <InlineRename id={r.id} title={r.title} onOpen={() => setOpenId(r.id)} />
                  <span className="rec-row-meta">
                    {fmtAt(r.created_at)}{projName(r) ? ` · ${projName(r)}` : ''}
                    {r.status === 'failed' && r.error ? <span className="rec-row-err"> · {r.error}</span> : null}
                  </span>
                </div>
                <span className="rec-row-tags">
                  {r.speakers.length > 0 && <span className="tag">{r.speakers.length} 位说话人</span>}
                  {pending > 0 && <span className="tag">待确认 {pending}</span>}
                  {r.minutes && <span className="tag">已有纪要</span>}
                  {tasks > 0 && <span className="tag">{tasks} 个任务</span>}
                </span>
                <Pill label={STATUS_TEXT[r.status]} color={statusTone(r.status)} />
                <span className="rec-row-dur">{fmtDuration(r.duration_ms)}</span>
                {active && r.job ? <Progress value={r.job.progress} label="转写进度" /> : <span className="rec-progress-gap" aria-hidden="true" />}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** 录音工作区：未开始（标题、来源、设备）/ 授权中 / 录音中 / 暂停 / 保存中 / 失败 */
function Recorder() {
  const { recorder: s } = useRecordingStore()
  const active = s.phase === 'recording' || s.phase === 'paused'
  useTick(s.phase === 'recording')
  const system = isSystemSource(s.source)
  const desc = CAPTURE_SOURCES.find((x) => x.key === s.source)?.desc ?? ''
  return (
    <section className={cls('rec-work', active && 'on')} aria-label="录音工作区">
      <div className="rec-work-head">
        <span className={cls('rec-dot', s.phase === 'recording' && 'live', s.phase === 'paused' && 'paused')} aria-hidden="true" />
        <b>{s.phase === 'idle' ? '准备录音' : s.phase === 'requesting' ? `正在申请${captureSourceShort(s.source)}`
          : s.phase === 'recording' ? `${captureSourceText(s.source)} · 录音中` : s.phase === 'paused' ? '已暂停'
            : s.phase === 'uploading' ? (system ? '正在停止采集并混音保存' : '正在保存') : '录音没保存上'}</b>
        {active && <span className="rec-timer" aria-label="录音时长">{fmtDuration(elapsedOf(s))}</span>}
      </div>
      {s.phase === 'idle' && (
        <>
          <input className="rec-input rec-title-input" aria-label="录音标题（可空）" placeholder="标题（可空，之后也能在详情里改）" value={s.title} onChange={(e) => setRecorderTitle(e.target.value)} />
          <div className="seg rec-source" role="radiogroup" aria-label="录音来源">
            {CAPTURE_SOURCES.map((x) => (
              <button key={x.key} role="radio" aria-checked={s.source === x.key} className={cls(s.source === x.key && 'on')} onClick={() => setRecorderSource(x.key)}>{x.label}</button>
            ))}
          </div>
          <p className="rec-hint">{desc}</p>
          {system && (
            <div className="rec-devices">
              <label className="field-label" htmlFor="rec-device">声音设备</label>
              <select id="rec-device" className="rec-select" value={s.deviceIndex} onChange={(e) => setRecorderDevice(Number(e.target.value))}>
                {DEMO_DEVICES.map((d) => <option key={d.index} value={d.index}>{d.name}{d.virtual ? '（虚拟声卡/系统声音）' : ''}{d.default ? ' · 默认' : ''}</option>)}
              </select>
              <button className="btn btn-ghost" title="原型的设备列表是写死的演示数据">重新检测</button>
            </div>
          )}
          <div className="rec-actions">
            <button className="btn btn-primary" onClick={startRecording}>开始录音</button>
            <span className="rec-hint">{system ? '先允许访问声音设备；停止后在本机混音并排队转写'
              : s.source === 'share' ? '浏览器会弹出分享窗口，记得勾选「分享标签页声音」' : '先允许使用麦克风；停止后自动保存到本机并排队转写'}</span>
          </div>
          {system && (
            <p className="rec-hint">macOS 要录整个电脑/会议 App 的声音需要虚拟声卡：<code>brew install blackhole-2ch</code>，再用「音频 MIDI 设置」建一个多输出设备、把系统输出接过去；装好后点「重新检测」。只想录网页里的声音可以直接用「系统声音（浏览器分享）」，不用装。</p>
          )}
          <label className="rec-demo list-sub"><input type="checkbox" checked={s.denyNext} onChange={(e) => setDenyNext(e.target.checked)} /> 演示：下一次授权被拒</label>
        </>
      )}
      {s.phase === 'requesting' && <p className="rec-hint">正在申请{captureSourceShort(s.source)}授权…（原型不真的调用麦克风）</p>}
      {active && (
        <div className="rec-actions">
          {!system && (s.phase === 'recording' ? <button className="btn btn-outline" onClick={pauseRecording}>暂停</button> : <button className="btn btn-primary" onClick={resumeRecording}>继续</button>)}
          <button className="btn btn-primary" onClick={stopRecording}>停止并转写</button>
          <button className="btn" onClick={discardRecording}>放弃</button>
        </div>
      )}
      {s.phase === 'uploading' && <p className="rec-hint">{system ? '正在停止采集、混音并保存，保存后开始转写…' : '正在保存录音，保存后开始转写…'}</p>}
      {s.phase === 'error' && (
        <>
          <div className="banner banner-danger" role="alert"><span><b>录音失败</b>：{s.error}</span><button className="btn" onClick={retryRecording}>重试</button></div>
          <div className="rec-actions"><button className="btn" onClick={discardRecording}>放弃这次录音</button></div>
        </>
      )}
    </section>
  )
}

/** 外壳录音状态条（正式产品 shellStatus 插槽）：录音没在空闲时任意页面顶部居中显示，点一下回录音页 */
export function RecorderStatus({ onOpen }: { onOpen: () => void }) {
  const { recorder: s } = useRecordingStore()
  useTick(s.phase === 'recording')
  if (s.phase === 'idle') return null
  const active = s.phase === 'recording' || s.phase === 'paused'
  const browser = !isSystemSource(s.source)
  const text = s.phase === 'requesting' ? `正在申请${captureSourceShort(s.source)}…`
    : s.phase === 'recording' ? (browser ? '录音中' : `${captureSourceShort(s.source)} · 录音中`)
      : s.phase === 'paused' ? '录音已暂停' : s.phase === 'uploading' ? '正在保存录音…' : '录音没保存上'
  return (
    <div className="rec-status" role="status" aria-live="polite">
      <button type="button" className="rec-status-open" onClick={onOpen} title="打开录音页">
        <span className={cls('rec-dot', s.phase === 'recording' && 'live', s.phase === 'paused' && 'paused')} aria-hidden="true" />
        <span className="rec-status-text">{text}</span>
        {(active || s.phase === 'uploading') && <span className="rec-status-timer">{fmtDuration(elapsedOf(s))}</span>}
      </button>
      <span className="rec-status-acts">
        {s.phase === 'recording' && browser && <button className="btn btn-outline" onClick={pauseRecording}>暂停</button>}
        {s.phase === 'paused' && <button className="btn btn-primary" onClick={resumeRecording}>继续</button>}
        {active && <button className="btn btn-primary" onClick={stopRecording}>停止并转写</button>}
        {s.phase === 'error' && <button className="btn" onClick={retryRecording}>重试</button>}
        {s.phase === 'error' && <button className="btn" onClick={discardRecording}>放弃</button>}
      </span>
    </div>
  )
}

/* ---------- 详情 ---------- */

function Detail({ r, projects, contacts, projName, threshold, onBack, onCreateTask, onOpenTask }: {
  r: Recording | undefined; projects: RecProject[]; contacts: RecContact[]; projName: string; threshold: number
  onBack: () => void; onCreateTask: RecCreateTask; onOpenTask?: (id: string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [saved, setSaved] = useState('')
  const [ask, setAsk] = useState<'retranscribe' | 'delete' | null>(null)
  const [pos, setPos] = useState<number | null>(null)
  const timer = useRef<number | null>(null)
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])
  if (!r) {
    return (
      <div className="page rec-page">
        <button className="link-btn" onClick={onBack}>← 返回录音列表</button>
        <div className="empty"><div className="empty-title">这条录音不存在或已删除</div></div>
      </div>
    )
  }
  const value = draft ?? r.transcript
  const flush = () => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null }
    if (draft !== null && draft !== r.transcript) { saveTranscript(r.id, draft); setSaved('已保存') }
  }
  const edit = (v: string) => {
    setDraft(v); setSaved('')
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { timer.current = null; saveTranscript(r.id, v); setSaved('已保存') }, 800)
  }
  const jobRunning = r.job && (r.job.status === 'pending' || r.job.status === 'running')
  const transcribeBusy = r.status === 'uploaded' || r.status === 'transcribing'
  const summaryBusy = r.status === 'summarizing' || (r.job?.kind === 'summarize' && !!jobRunning)
  const busy = transcribeBusy || summaryBusy || !!jobRunning
  const showJob = r.job && r.job.kind !== 'diarize' && (transcribeBusy || summaryBusy || r.job.status === 'failed')
  const spk = new Map(r.speakers.map((s) => [s.label, s]))
  const doRetranscribe = () => { setAsk(null); setDraft(null); setSaved(''); retranscribe(r.id) }
  return (
    <div className="page rec-page">
      <button className="link-btn rec-back" onClick={onBack}>← 返回录音列表</button>
      <PageTitle parent="录音" desc={`${STATUS_TEXT[r.status]}${r.duration_ms > 0 ? ` · ${fmtDuration(r.duration_ms)}` : ''}${projName ? ` · ${projName}` : ''}`}
        actions={<>
          <button className={cls('act', r.status === 'failed' && 'act-primary')} disabled={busy} title={busy ? '还有任务在跑，等它结束再重试' : undefined}
            onClick={() => (r.status === 'failed' ? doRetranscribe() : setAsk('retranscribe'))}>重新转写</button>
          <button className="act act-danger-quiet" onClick={() => setAsk('delete')}>删除</button>
        </>}>
        <InlineRename id={r.id} title={r.title} big />
      </PageTitle>

      {showJob && r.job && (
        <div className="rec-job">
          <Pill label={STATUS_TEXT[r.status]} color={statusTone(r.status)} />
          <span>{jobText(r.job)}</span>
          {(transcribeBusy || summaryBusy) && <Progress value={r.job.progress} label="任务进度" />}
        </div>
      )}
      {r.status === 'failed' && (
        <div className="banner banner-danger" role="alert"><span><b>转写失败</b>{r.error ? `：${r.error}` : ''}。原始音频还在，可以点「重新转写」再跑一次。</span></div>
      )}

      <section className="rec-section">
        <div className="rec-section-title">音频<span className="faint">来源：{captureSourceText(r.source)}</span></div>
        {r.has_audio ? (
          <div className="rec-audio" aria-label="音频">
            <span className="rec-audio-play" aria-hidden="true">▶</span>
            <Progress value={pos === null ? 0 : Math.min(100, Math.round((pos / Math.max(1, r.duration_ms)) * 100))} label="播放位置" />
            <span className="rec-timer">{fmtDuration(pos ?? 0)} / {fmtDuration(r.duration_ms)}</span>
            <span className="faint">原型不带真实音频；正式产品是浏览器自带的播放器</span>
          </div>
        ) : <span className="faint">这条录音没有音频文件</span>}
      </section>

      {r.segments.length > 0 && (
        <section className="rec-section">
          <div className="rec-section-title">段落<span className="faint">点一段跳到音频对应位置</span></div>
          <ol className="rec-segs">
            {r.segments.map((seg) => {
              const s = seg.speaker ? spk.get(seg.speaker) : undefined
              return (
                <li key={seg.seq}>
                  <button type="button" className={cls('rec-seg', pos === seg.start_ms && 'on')} onClick={() => setPos(seg.start_ms)}>
                    <span className="rec-seg-t">{fmtDuration(seg.start_ms)}</span>
                    {s && <span className="rec-seg-spk" style={{ color: speakerColor(s.label), borderColor: speakerColor(s.label) }}>{speakerName(s)}</span>}
                    <span className="rec-seg-x">{seg.text}</span>
                  </button>
                </li>
              )
            })}
          </ol>
        </section>
      )}

      <section className="rec-section">
        <div className="rec-section-title">转写全文<span className="rec-save" role="status">{saved}</span></div>
        <textarea className="rec-transcript" aria-label="转写全文" rows={8} value={value}
          placeholder="还没有转写文本；转写完成后会出现在这里，也可以直接粘贴或修改" onChange={(e) => edit(e.target.value)} onBlur={flush} />
        <div className="rec-hint">失焦或停手 0.8 秒自动保存。段落是转写原文，改全文不会改原始时间戳。</div>
      </section>

      <Speakers r={r} contacts={contacts} />
      <Minutes r={r} />
      <Todos r={r} projects={projects} contacts={contacts} threshold={threshold} onCreateTask={onCreateTask} onOpenTask={onOpenTask} />
      <Files r={r} />

      {ask === 'retranscribe' && (
        <Confirm title="重新转写这条录音？" label="重新转写" onCancel={() => setAsk(null)} onConfirm={doRetranscribe}>
          会重新跑一遍本机 whisper.cpp，覆盖现在的段落和全文；已经手工改过的文本也会被新结果覆盖。
        </Confirm>
      )}
      {ask === 'delete' && (
        <Confirm title="删除这条录音？" label="删除" danger onCancel={() => setAsk(null)} onConfirm={() => { setAsk(null); deleteRecording(r.id); onBack() }}>
          删除后列表里不再出现这条录音；已经转成的任务或文档不会跟着删。
          <ul className="rec-impacts"><li>{r.has_audio ? '原始音频文件一起删除，不能恢复' : '录音记录一起删除，不能恢复'}</li></ul>
        </Confirm>
      )}
    </div>
  )
}

/* ---------- 说话人 ---------- */

function Speakers({ r, contacts }: { r: Recording; contacts: RecContact[] }) {
  const [ask, setAsk] = useState(false)
  const [bind, setBind] = useState<RecordingSpeaker | null>(null)
  const job = r.job?.kind === 'diarize' ? r.job : null
  const running = !!job && (job.status === 'pending' || job.status === 'running')
  const canRun = r.has_audio && r.segments.length > 0
  const run = () => { setAsk(false); diarize(r.id) }
  return (
    <section className="rec-section">
      <div className="rec-section-title">
        说话人<span className="faint">识别后可改名、绑定到联系人；绑定会把声纹登记到该联系人</span>
        <span className="spacer" />
        <button className={cls('btn', r.speakers.length ? 'btn-outline' : 'btn-primary')} disabled={!canRun || running}
          title={!canRun ? '需要先转写出段落才能识别说话人' : undefined} onClick={() => (r.speakers.length ? setAsk(true) : run())}>
          {running ? '识别中…' : r.speakers.length ? '重新识别' : '识别说话人'}
        </button>
      </div>
      {running && job && <div className="rec-job"><span>{jobText(job)}</span><Progress value={job.progress} label="说话人识别进度" /></div>}
      {job?.status === 'failed' && <div className="banner banner-danger" role="alert"><span><b>说话人识别失败</b>{job.last_error ? `：${job.last_error}` : ''}。不影响转写和纪要，可以点「重新识别」再试。</span></div>}
      {!r.speakers.length ? (
        <p className="faint">{r.has_audio ? '还没有识别说话人。点「识别说话人」用本机 Python 跑一次。' : '这条录音没有音频文件，做不了说话人识别。'}</p>
      ) : (
        <ul className="rec-speakers" aria-label="说话人列表">
          {r.speakers.map((s) => <SpeakerRow key={s.label} r={r} s={s} onBind={() => setBind(s)} />)}
        </ul>
      )}
      <p className="rec-hint">需要本机 Python 装好 funasr（首次识别会下载约 33MB 模型）；没装时识别会失败，转写和纪要不受影响。</p>
      {ask && (
        <Confirm title="重新识别说话人？" label="重新识别" onCancel={() => setAsk(false)} onConfirm={run}>
          会重新跑一遍本机 Python 说话人分离，按首次出现顺序重排 <code>spk_1</code>、<code>spk_2</code>；已经改过的名字和联系人绑定可能丢失（自动匹配会保留）。
        </Confirm>
      )}
      {bind && <BindDialog r={r} s={bind} contacts={contacts} onClose={() => setBind(null)} />}
    </section>
  )
}

function SpeakerRow({ r, s, onBind }: { r: Recording; s: RecordingSpeaker; onBind: () => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const name = speakerName(s)
  const save = () => {
    const t = (draft ?? '').trim()
    if (!t) { setErr('名字不能为空'); return }
    if (t.length > 40) { setErr('名字最多 40 字'); return }
    if (t !== name) renameSpeaker(r.id, s.label, t)
    setDraft(null); setErr('')
  }
  return (
    <li className="rec-speaker">
      <span className="rec-speaker-dot" style={{ background: speakerColor(s.label) }} aria-hidden="true" />
      {draft !== null ? (
        <span className="rec-rename editing">
          <input className={cls('rec-input', err && 'bad')} aria-label="说话人显示名" autoFocus value={draft} onChange={(e) => { setDraft(e.target.value); setErr('') }}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') { setDraft(null); setErr('') } }} />
          <button className="btn btn-primary" onClick={save}>保存</button>
          <button className="btn btn-ghost" onClick={() => { setDraft(null); setErr('') }}>取消</button>
          {err && <span className="err-text" role="alert">{err}</span>}
        </span>
      ) : (
        <span className="rec-speaker-name">{name}
          <button type="button" className="rec-icon-btn" aria-label={`改名 ${name}`} title="改显示名" onClick={() => setDraft(s.name.trim() || name)}><Pencil /></button>
        </span>
      )}
      <span className="rec-row-tags">
        <span className="tag">{s.contact_id ? s.contact_name || '联系人已删除' : '未绑定'}</span>
        {s.similarity > 0 && <span className="tag">{s.detected ? '自动匹配' : '已绑定'} {Math.round(s.similarity * 100)}%</span>}
      </span>
      <span className="rec-speaker-meta">{s.segments} 段 · {fmtDuration(s.duration_ms)}</span>
      <button className={cls('btn', s.contact_id ? 'btn-ghost' : 'btn-outline')} onClick={onBind}>{s.contact_id ? '改绑联系人' : '绑定联系人'}</button>
    </li>
  )
}

/** 绑定联系人：选联系人 → 登记声纹；这个联系人已有声纹时提示会覆盖，可删声纹 */
function BindDialog({ r, s, contacts, onClose }: { r: Recording; s: RecordingSpeaker; contacts: RecContact[]; onClose: () => void }) {
  const { voiceprints } = useRecordingStore()
  const [cid, setCid] = useState(s.contact_id)
  const [askDel, setAskDel] = useState(false)
  const chosen = contacts.find((c) => c.id === cid)
  const existing = voiceprints.find((v) => v.contact_id === cid)
  const switching = !!s.contact_id && cid !== s.contact_id
  return (
    <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="qs" role="dialog" aria-label={`绑定 ${speakerName(s)}`}>
        <div className="qs-head"><b>绑定说话人</b><span className="list-sub">{speakerName(s)}</span></div>
        <p className="rec-hint">把「{speakerName(s)}」的声纹登记到联系人，以后录音会自动认出同一个人。同一条录音重复绑定不同联系人就是改绑。</p>
        <label className="field">
          <span className="field-label">联系人<em>*</em><span className="field-hint">只有联系人能绑定声纹</span></span>
          <select className="rec-select" value={cid} onChange={(e) => setCid(e.target.value)}>
            <option value="">选联系人</option>
            {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}{c.company ? ` · ${c.company}` : ''}</option>)}
          </select>
        </label>
        <div className="list-sub">当前相似度：{s.similarity > 0 ? `${Math.round(s.similarity * 100)}%（${s.detected ? '自动匹配' : '已绑定'}）` : '未匹配'}</div>
        {existing && (
          <div className="banner banner-warn" role="alert">
            <span><b>这个联系人已有声纹</b>，绑定会被这次覆盖。现在的声纹来自录音 <code>{existing.source_recording_id}</code>。</span>
            <button className="btn btn-danger-ghost" onClick={() => setAskDel(true)}>删除这个声纹</button>
          </div>
        )}
        {switching && !existing && <div className="banner banner-warn"><span>这条说话人现在绑在「{s.contact_name || '其他联系人'}」，绑定后会改到新联系人。</span></div>}
        <div className="rec-actions">
          <button className="btn btn-primary" disabled={!cid} onClick={() => { if (chosen) { bindSpeaker(r.id, s.label, chosen); onClose() } }}>{existing ? '绑定并覆盖' : '绑定'}</button>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
        </div>
        {askDel && (
          <Confirm title="删除这个联系人的声纹？" label="删除声纹" danger onCancel={() => setAskDel(false)} onConfirm={() => { setAskDel(false); deleteVoiceprint(cid) }}>
            删掉后，后续录音不会再自动认出这个人；已经标好的说话人不受影响。
          </Confirm>
        )}
      </div>
    </div>
  )
}

/* ---------- 纪要 ---------- */

function Minutes({ r }: { r: Recording }) {
  const { settings } = useRecordingStore()
  const [ask, setAsk] = useState(false)
  const [note, setNote] = useState('')
  const generating = r.status === 'summarizing' || (r.job?.kind === 'summarize' && (r.job.status === 'pending' || r.job.status === 'running'))
  const transcribing = r.status === 'uploaded' || r.status === 'transcribing'
  const failed = r.job?.kind === 'summarize' && r.job.status === 'failed'
  const canRun = r.transcript.trim().length > 0
  const m = r.minutes
  const busy = generating || transcribing
  const gen = () => { setAsk(false); setNote('已提交生成纪要任务，完成后这里会自动刷新'); generateMinutes(r.id) }
  return (
    <section className="rec-section">
      <div className="rec-section-title">
        纪要<span className="faint">{m ? `${m.model || '未知模型'} · ${fmtAt(m.generated_at) || '生成时间未知'}` : '本机 Agent 读转写全文，生成摘要、结论、待办建议和图表'}</span>
        <span className="spacer" />
        <button className={cls('btn', m ? 'btn-ghost' : 'btn-primary')} disabled={!canRun || busy} title={!canRun ? '还没有转写全文，转写完成后才能生成' : undefined}
          onClick={() => (m ? setAsk(true) : gen())}>{generating ? '生成中…' : m ? '重新生成' : '生成纪要'}</button>
        <button className="btn btn-outline" disabled={!canRun || busy}
          title={settings.minutes_flow ? `按设置里的流程「${settings.minutes_flow}」发起` : '按设置里的流程发起；没设置就用内置「会议纪要整理」'}
          onClick={() => setNote(`已发起纪要流程「${startMinutesSop(r.id)}」，完成后文件与纪要会出现在这里`)}>发起纪要 SOP</button>
      </div>
      {!canRun && <div className="rec-hint">还没有转写全文。转写完成（或手动粘贴全文）后才能生成纪要。</div>}
      {generating && r.job && (
        <div className="rec-job" role="status">
          <span>{r.job.status === 'pending' ? '排队等待生成纪要…' : '正在生成纪要'}</span>
          <Progress value={r.job.progress} label="纪要生成进度" />
          <span className="faint">{r.job.status === 'pending' ? '前面的任务（转写/说话人识别）跑完就轮到它。' : '本机模型生成中，通常 1–5 分钟；完成后这里会自动刷新。'}</span>
        </div>
      )}
      {failed && <div className="banner banner-danger" role="alert"><span><b>上次生成纪要失败</b>{r.job?.last_error ? `：${r.job.last_error}` : ''}。可以点「重新生成」再试。</span></div>}
      {note && !generating && <div className="rec-note">{note}</div>}
      {!m ? (
        <p className="faint">还没有纪要。点「生成纪要」让本机 Agent 读一遍转写稿；也可以在设置里打开「转写完成后自动生成」。</p>
      ) : (
        <div className="rec-minutes">
          <div className="rec-minutes-summary">{m.summary_md.split('\n').filter(Boolean).map((line, i) => (
            line.startsWith('- ') ? <div key={i} className="rec-md-li">{line.slice(2)}</div>
              : <p key={i}>{line.split(/\*\*(.+?)\*\*/).map((x, j) => (j % 2 ? <b key={j}>{x}</b> : x))}</p>
          ))}</div>
          {m.conclusions.length > 0 && (
            <div><div className="section-label">结论</div><ul className="rec-points">{m.conclusions.map((c, i) => <li key={i}>{c}</li>)}</ul></div>
          )}
          {m.actions.length > 0 && (
            <div>
              <div className="section-label">待办建议</div>
              <ul className="rec-cards">
                {m.actions.map((a, i) => (
                  <li key={i} className="rec-card">
                    <div className="rec-card-head"><span className="tag">{a.kind === 'goal' ? '目标' : '任务'}</span><b>{a.title || '未命名待办'}</b><span className="spacer" /><Confidence value={a.confidence} /></div>
                    {a.detail && <div className="list-sub">{a.detail}</div>}
                    <div className="faint rec-meta">{[a.project && `项目：${a.project}`, a.owner && `负责人：${a.owner}`, a.due && `截止：${a.due}`].filter(Boolean).join(' · ')}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Diagrams d={m.diagrams} />
        </div>
      )}
      {ask && (
        <Confirm title="重新生成纪要？" label="重新生成" onCancel={() => setAsk(false)} onConfirm={gen}>
          会重新读一遍现在的转写全文，覆盖已有的纪要、候选和图表；已经确认过的候选任务不受影响。
        </Confirm>
      )}
    </section>
  )
}

/** 流程图（分层布局，列=BFS 层级）和树形图（缩进列表，最多 3 层每层 8 个）；数据坏了各自给一句提示 */
function Diagrams({ d }: { d: RecordingDiagrams }) {
  const marker = `rec-arrow-${useId().replace(/[«»:]/g, '')}`
  const nodes = d.flow.nodes.slice(0, 10)
  const depth = new Map<string, number>()
  const indeg = new Map(nodes.map((n) => [n.id, 0]))
  const edges = d.flow.edges.slice(0, 15).filter((e) => indeg.has(e.from) && indeg.has(e.to) && e.from !== e.to)
  edges.forEach((e) => indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1))
  const queue = nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id)
  if (!queue.length && nodes[0]) queue.push(nodes[0].id)
  queue.forEach((id) => depth.set(id, 0))
  for (let i = 0; i < queue.length; i++) for (const e of edges) if (e.from === queue[i] && !depth.has(e.to)) { depth.set(e.to, depth.get(queue[i])! + 1); queue.push(e.to) }
  const cols: string[][] = []
  nodes.forEach((n) => (cols[depth.get(n.id) ?? 0] ??= []).push(n.id))
  const W = 148, H = 50, GX = 66, GY = 30, P = 18
  const box = new Map<string, { x: number; y: number }>()
  cols.forEach((ids, c) => ids?.forEach((id, row) => box.set(id, { x: P + c * (W + GX), y: P + row * (H + GY) })))
  const width = P * 2 + cols.length * W + (cols.length - 1) * GX
  const height = P * 2 + Math.max(1, ...cols.map((c) => c?.length ?? 0)) * H + (Math.max(1, ...cols.map((c) => c?.length ?? 0)) - 1) * GY
  const rows: { label: string; depth: number }[] = []
  const walk = (n: RecordingDiagrams['tree']['root'], dp: number) => { if (dp >= 3 || !n.label) return; rows.push({ label: n.label, depth: dp }); n.children.slice(0, 8).forEach((c) => walk(c, dp + 1)) }
  walk(d.tree.root, 0)
  return (
    <div className="rec-diagrams">
      {nodes.length ? (
        <figure className="rec-diagram">
          <figcaption className="section-label">{d.flow.title || '讨论脉络'}</figcaption>
          <div className="rec-diagram-scroll">
            <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`流程图：${d.flow.title}`}>
              <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path className="rec-flow-arrow" d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
              {edges.map((e, i) => {
                const a = box.get(e.from)!, b = box.get(e.to)!
                const sx = a.x + W, sy = a.y + H / 2, tx = b.x, ty = b.y + H / 2, dx = Math.max(28, (tx - sx) / 2)
                return (
                  <g key={i}>
                    <path className="rec-flow-edge" d={`M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`} markerEnd={`url(#${marker})`} />
                    {e.label && <text className="rec-flow-edge-label" x={(sx + tx) / 2} y={(sy + ty) / 2 - 6} textAnchor="middle">{e.label}</text>}
                  </g>
                )
              })}
              {nodes.map((n) => {
                const b = box.get(n.id)!
                return (
                  <g key={n.id} className={`rec-flow-node kind-${n.kind}`}>
                    {n.kind === 'decision'
                      ? <polygon className="rec-flow-shape" points={`${b.x + W / 2},${b.y} ${b.x + W},${b.y + H / 2} ${b.x + W / 2},${b.y + H} ${b.x},${b.y + H / 2}`} />
                      : <rect className="rec-flow-shape" x={b.x} y={b.y} width={W} height={H} rx={n.kind === 'start' || n.kind === 'end' ? H / 2 : 10} />}
                    <text className="rec-flow-label" x={b.x + W / 2} y={b.y + H / 2} textAnchor="middle" dominantBaseline="middle">{n.label.slice(0, 14)}</text>
                  </g>
                )
              })}
            </svg>
          </div>
        </figure>
      ) : <p className="faint">这次纪要没有生成流程图。</p>}
      {rows.length ? (
        <figure className="rec-diagram">
          <figcaption className="section-label">{d.tree.title || '项目/任务树'}</figcaption>
          <ul className="rec-tree" role="tree">
            {rows.map((x, i) => <li key={i} role="treeitem" aria-level={x.depth + 1} style={{ paddingLeft: 8 + x.depth * 20 }}><span className="rec-tree-dot" />{x.label}</li>)}
          </ul>
        </figure>
      ) : <p className="faint">这次纪要没有生成树形图。</p>}
    </div>
  )
}

/* ---------- 待你确认 ---------- */

function Todos({ r, projects, contacts, threshold, onCreateTask, onOpenTask }: {
  r: Recording; projects: RecProject[]; contacts: RecContact[]; threshold: number; onCreateTask: RecCreateTask; onOpenTask?: (id: string) => void
}) {
  const [confirming, setConfirming] = useState<RecordingTodo | null>(null)
  const pending = r.todos.filter((t) => t.status === 'pending')
  const confirmed = r.todos.filter((t) => t.status === 'confirmed')
  const ignored = r.todos.filter((t) => t.status === 'ignored').length
  const low = pending.filter((t) => t.confidence < threshold)
  const questions = r.minutes?.questions ?? []
  const meta = (t: RecordingTodo) => [t.project_title && `项目：${t.project_title}`, t.owner_name && `负责人：${t.owner_name}`, t.due_at && `截止：${t.due_at.slice(0, 10)}`, t.reason].filter(Boolean).join(' · ')
  return (
    <section className="rec-section">
      <div className="rec-section-title">待你确认
        <span className="faint">{pending.length ? `${pending.length} 条候选，确认后建任务或挂项目` : 'AI 识别到项目/任务/目标后列在这里'}{confirmed.length ? ` · 已确认 ${confirmed.length}` : ''}{ignored ? ` · 已忽略 ${ignored}` : ''}</span>
      </div>
      {!pending.length ? <p className="faint">没有待确认的候选。生成纪要后，识别到的项目、任务和目标会出现在这里。</p> : (
        <ul className="rec-cards" aria-label="待确认候选">
          {pending.map((t) => (
            <li key={t.index} className="rec-card">
              <div className="rec-card-head"><span className="tag">{TODO_KIND_TEXT[t.kind]}</span><b>{t.title || '未命名候选'}</b><span className="spacer" /><Confidence value={t.confidence} /></div>
              {t.detail && <div className="list-sub">{t.detail}</div>}
              <div className="faint rec-meta">{meta(t)}</div>
              <div className="rec-actions">
                <button className="btn btn-primary" onClick={() => setConfirming(t)}>确认…</button>
                <button className="btn" onClick={() => ignoreTodo(r.id, t.index)}>忽略</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {confirmed.length > 0 && (
        <div>
          <div className="section-label">已确认</div>
          <ul className="rec-done">
            {confirmed.map((t) => (
              <li key={t.index}>
                <span className="tag">{TODO_KIND_TEXT[t.kind]}</span><span>{t.title}</span>
                {t.kind === 'project' ? <span className="faint">已挂到项目「{t.project_title || t.project_id}」</span>
                  : t.object_id && onOpenTask ? <button className="link-btn" onClick={() => onOpenTask(t.object_id)}>{t.object_ref || '查看任务'}</button>
                    : <span className="faint">已建任务 {t.object_ref}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(questions.length > 0 || low.length > 0) && (
        <div className="rec-supplement">
          <div className="section-label">需要你补充</div>
          <ul className="rec-points">
            {questions.map((q, i) => <li key={`q${i}`}><b>{q.question}</b>{q.why && <span className="faint">（{q.why}）</span>} <Confidence value={q.confidence} /></li>)}
            {low.map((t) => <li key={`t${t.index}`}><span className="faint">{TODO_KIND_TEXT[t.kind]}：</span>{t.title} <Confidence value={t.confidence} />{t.reason && <span className="faint">（{t.reason}）</span>}</li>)}
          </ul>
        </div>
      )}
      {confirming && <ConfirmTodo key={confirming.index} r={r} t={confirming} projects={projects} contacts={contacts} onCreateTask={onCreateTask} onClose={() => setConfirming(null)} />}
    </section>
  )
}

function ConfirmTodo({ r, t, projects, contacts, onCreateTask, onClose }: {
  r: Recording; t: RecordingTodo; projects: RecProject[]; contacts: RecContact[]; onCreateTask: RecCreateTask; onClose: () => void
}) {
  const [title, setTitle] = useState(t.title)
  const [projectId, setProjectId] = useState(t.project_id || (t.kind !== 'project' ? r.project_id : ''))
  const [owner, setOwner] = useState(contacts.some((c) => c.name === t.owner_name) ? t.owner_name : '')
  const [priority, setPriority] = useState('')
  const [due, setDue] = useState(t.due_at.slice(0, 10))
  const titleBad = t.kind !== 'project' && !title.trim()
  const projectBad = t.kind === 'project' && !projectId
  const submit = () => {
    if (titleBad || projectBad) return
    const pj = projects.find((p) => p.id === projectId)
    if (t.kind === 'project') { confirmTodo(r.id, t.index, { project_id: projectId, project_title: pj?.name ?? '' }); onClose(); return }
    const task = onCreateTask({ title: title.trim(), desc: `${t.detail}${t.detail ? '\n\n' : ''}来自录音「${r.title || '未命名录音'}」的${TODO_KIND_TEXT[t.kind]}${t.kind === 'goal' ? '（标为工作目标）' : ''}`,
      project_id: projectId, assignee: owner, priority: priority || 'P2', due: due || null })
    confirmTodo(r.id, t.index, { title: title.trim(), project_id: projectId, project_title: pj?.name ?? '', owner_name: owner, object_id: task.id, object_ref: task.ref })
    onClose()
  }
  return (
    <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="qs" role="dialog" aria-label="确认候选">
        <div className="qs-head"><b>确认{TODO_KIND_TEXT[t.kind]}</b></div>
        <p className="rec-hint">{t.kind === 'project' ? '项目候选：确认后把这条录音挂到你选的项目上，不会新建项目。'
          : t.kind === 'goal' ? '目标候选：确认后建一条任务，并在属性里标为工作目标（暂不新建目标类型）。'
            : '任务候选：确认后在任务里建一条任务；负责人按名字匹配名册，匹配不到就不指派。'}</p>
        {t.detail && <p className="list-sub">{t.detail}</p>}
        {t.kind !== 'project' && (
          <label className="field"><span className="field-label">任务标题<em>*</em></span>
            <input value={title} className={cls(titleBad && 'bad')} placeholder="要做的事" autoFocus onChange={(e) => setTitle(e.target.value)} />
            {titleBad && <span className="field-err">必填</span>}
          </label>
        )}
        <label className="field"><span className="field-label">{t.kind === 'project' ? '挂到哪个项目' : '所属项目'}{t.kind === 'project' && <em>*</em>}
          {t.kind === 'project' && !t.project_id && <span className="field-hint">AI 没能在项目里匹配到，手动选一个</span>}</span>
          <select className={cls(projectBad && 'bad')} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{t.kind === 'project' ? '请选择项目' : '不属于项目'}</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {projectBad && <span className="field-err">项目候选要选一个已有项目</span>}
        </label>
        {t.kind !== 'project' && (
          <>
            <div className="field-row">
              <label className="field"><span className="field-label">负责人{t.owner_name && !owner && <span className="field-hint">AI 建议「{t.owner_name}」，名册里没匹配到</span>}</span>
                <select value={owner} onChange={(e) => setOwner(e.target.value)}>
                  <option value="">未分配</option>
                  {contacts.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                </select>
              </label>
              <label className="field"><span className="field-label">优先级</span>
                <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="">默认优先级</option>{['P0', 'P1', 'P2', 'P3'].map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
            </div>
            <label className="field"><span className="field-label">截止日期</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
          </>
        )}
        <div className="rec-actions">
          <button className="btn btn-primary" disabled={titleBad || projectBad} onClick={submit}>确认</button>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  )
}

/* ---------- 文件 ---------- */

function Files({ r }: { r: Recording }) {
  const files = filesOf(r)
  const download = (name: string, body: string) => {
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url; a.download = name.split('/').pop() ?? name; a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <section className="rec-section">
      <div className="rec-section-title">文件<span className="faint">随转写/纪要生成，点击下载</span></div>
      {!files.length ? <p className="faint">还没有生成文件。转写成功后会出现 transcript.md；生成纪要后还会有 minutes.md、minutes.json 和图表源码。</p> : (
        <ul className="rec-files" aria-label="录音文件">
          {files.map((f) => (
            <li key={f.name} className="rec-file">
              <b className="rec-file-name">{f.name}</b>
              <span className="tag">{FILE_KIND_TEXT[f.kind]}</span>
              <span className="spacer" />
              <span className="faint">{fmtBytes(f.bytes)}</span>
              <span className="faint">{fmtAt(f.updated_at)}</span>
              <button className="link-btn" onClick={() => download(f.name, f.body)}>下载</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/* ---------- 设置 > 插件 > 录音转写 ---------- */

export function RecordingSettingsPage({ projects }: { projects: RecProject[] }) {
  const st = useRecordingStore()
  const [d, setD] = useState<RecordingSettings>(st.settings)
  const [text, setText] = useState({ threads: String(st.settings.threads), th: String(st.settings.minutes_threshold), max: String(st.settings.max_speakers), match: String(st.settings.match_threshold) })
  const [note, setNote] = useState('')
  const set = (p: Partial<RecordingSettings>) => { setD((x) => ({ ...x, ...p })); setNote('') }
  const setT = (p: Partial<typeof text>) => { setText((x) => ({ ...x, ...p })); setNote('') }
  const num = (s: string, re: RegExp, lo: number, hi: number) => (re.test(s.trim()) && Number(s) >= lo && Number(s) <= hi ? Number(s) : null)
  const threads = num(text.threads, /^\d+$/, 0, 64), th = num(text.th, /^\d+(\.\d+)?$/, 0, 1), max = num(text.max, /^\d+$/, 1, 16), match = num(text.match, /^\d+(\.\d+)?$/, 0, 1)
  const bad = threads === null || th === null || max === null || match === null
  const cur: RecordingSettings = { ...d, threads: threads ?? d.threads, minutes_threshold: th ?? d.minutes_threshold, max_speakers: max ?? d.max_speakers, match_threshold: match ?? d.match_threshold }
  const dirty = JSON.stringify(cur) !== JSON.stringify(st.settings)
  const tools = st.tools
  const tool = (label: string, t: typeof tools.whisper) => (
    <div className={cls('rec-tool', !t.ok && 'bad')}>
      <b>{label}</b><span className={t.ok ? 'rec-ok' : 'danger-text'}>{t.ok ? `可用${t.version ? ` · ${t.version}` : ''}` : '不可用'}</span><code className="faint">{t.path || '没找到'}</code>
    </div>
  )
  const input = (label: string, hint: string, k: 'whisper_path' | 'ffmpeg_path' | 'model_dir' | 'minutes_flow' | 'minutes_provider' | 'minutes_model' | 'python_path' | 'voiceprint_model_dir', ph: string) => (
    <label className="field"><span className="field-label">{label}<span className="field-hint">{hint}</span></span><input value={d[k]} placeholder={ph} onChange={(e) => set({ [k]: e.target.value })} /></label>
  )
  const numField = (label: string, hint: string, k: keyof typeof text, ok: boolean, err: string, range?: boolean) => (
    <label className="field"><span className="field-label">{label}<span className="field-hint">{hint}</span></span>
      <span className="rec-threshold">
        {range && <input type="range" min={0} max={1} step={0.05} aria-label={`${label}滑杆`} value={ok ? Number(text[k]) : 0} onChange={(e) => setT({ [k]: e.target.value })} />}
        <input type="number" className={cls(!ok && 'bad', range && 'rec-num')} aria-label={label} value={text[k]} onChange={(e) => setT({ [k]: e.target.value })} />
      </span>
      {!ok && <span className="field-err">{err}</span>}
    </label>
  )
  const check = (label: string, k: 'auto_summarize' | 'auto_diarize') => (
    <label className="rec-check"><input type="checkbox" checked={d[k]} onChange={(e) => set({ [k]: e.target.checked })} />{label}</label>
  )
  return (
    <div className="page rec-settings">
      <PageTitle parent="设置" desc="本机 whisper.cpp 转写设置">录音转写</PageTitle>
      <div className="section-label">工具状态</div>
      <div className="rec-tools">{tool('whisper-cli', tools.whisper)}{tool('ffmpeg', tools.ffmpeg)}</div>
      <div className="field-row">
        {input('whisper-cli 路径', '空 = 自动探测（PATH 和 Homebrew 常见路径）', 'whisper_path', tools.whisper.path || '自动探测')}
        {input('ffmpeg 路径', '空 = 自动探测', 'ffmpeg_path', tools.ffmpeg.path || '自动探测')}
      </div>

      <div className="section-label">模型</div>
      <p className="rec-hint">模型文件放本机，不入备份。可以在这下载，也可以把 <code>ggml-&lt;模型&gt;.bin</code> 手动放进模型目录后刷新。</p>
      <ul className="rec-models" aria-label="模型列表">
        {st.models.map((m) => (
          <li key={m.name} className="rec-model">
            <b>{m.name}</b><span className="faint">{Math.round(m.size / 1024 / 1024)} MB</span>
            <span className={cls(m.status === 'ready' && 'rec-ok', m.status === 'error' && 'danger-text')}>{MODEL_STATUS_TEXT[m.status]}</span>
            {m.status === 'downloading' ? <Progress value={m.progress} label={`${m.name} 下载进度`} /> : <span className="rec-progress-gap" />}
            {m.status === 'ready' ? <button className="btn" onClick={() => deleteModel(m.name)}>删除</button>
              : m.status === 'downloading' ? <button className="btn" disabled>下载中</button>
                : <button className="btn btn-outline" onClick={() => downloadModel(m.name)}>下载</button>}
          </li>
        ))}
      </ul>
      {input('模型目录', '空 = 默认：~/Library/Caches/pmw/recording/models', 'model_dir', '~/Library/Caches/pmw/recording/models')}

      <div className="section-label">转写默认值</div>
      <div className="field-row rec-row3">
        <label className="field"><span className="field-label">默认模型<span className="field-hint">先用 small 跑通</span></span>
          <select value={d.model} onChange={(e) => set({ model: e.target.value })}>{MODEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
        <label className="field"><span className="field-label">语言<span className="field-hint">粤语选 yue</span></span>
          <select value={d.language} onChange={(e) => set({ language: e.target.value })}>{LANGUAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
        {numField('线程数', '0 = 自动（min(8, CPU 核数)）', 'threads', threads !== null, '填 0 到 64 的整数')}
      </div>

      <div className="section-label">纪要</div>
      <p className="rec-hint">转写完成后可自动让本机 Agent 读全文，生成摘要、结论、待办建议和流程图/树形图。SOP 流程为空时插件内直连 Agent。</p>
      {check('转写完成后自动生成纪要', 'auto_summarize')}
      {input('纪要 SOP 流程', '填 SOP 流程 id 或名称；留空 = 插件内直连 Agent（不经过 SOP 编排）', 'minutes_flow', '留空 = 插件内直连 Agent')}
      <div className="field-row">
        {input('纪要服务商', '留空 = 默认服务商（本机 Ollama）', 'minutes_provider', '留空 = 默认服务商')}
        {input('纪要模型', '留空 = 服务商默认模型', 'minutes_model', '留空 = 服务商默认模型')}
      </div>
      {numField('高置信度阈值', '置信度 ≥ 阈值的候选会推送提醒，低于阈值的进详情页「需要你补充」', 'th', th !== null, '填 0 到 1 之间的小数（如 0.7）', true)}

      <div className="section-label">声纹</div>
      <p className="rec-hint">转写后可用本机 Python 离线做说话人分离，给段落标 spk_1、spk_2；绑定联系人后，后续录音自动认人。需要 <code>pip install funasr</code>，首次识别会联网下载约 33MB 模型。识别失败不影响转写和纪要。</p>
      {check('转写完成后自动识别说话人', 'auto_diarize')}
      <div className="field-row rec-row3">
        {input('Python 路径', '空 = 自动找 python3', 'python_path', '自动找 python3')}
        {input('声纹模型目录', '空 = ModelScope 默认缓存', 'voiceprint_model_dir', '默认缓存')}
        {numField('最多人数', '1–16，超过上限会合并最近质心', 'max', max !== null, '填 1 到 16 的整数')}
      </div>
      {numField('声纹匹配阈值', '余弦相似度 ≥ 阈值算同一个人；0 = 全部当同一个人', 'match', match !== null, '填 0 到 1 之间的小数（如 0.65）', true)}
      {st.voiceprints.length > 0 && <div className="list-sub">已登记声纹：{st.voiceprints.map((v) => v.contact_name).join('、')}（在录音详情的说话人里绑定或删除）</div>}

      <div className="section-label">其他</div>
      <div className="field-row">
        <label className="field"><span className="field-label">默认项目<span className="field-hint">录音默认关联的项目，可空</span></span>
          <select value={d.default_project_id} onChange={(e) => set({ default_project_id: e.target.value })}>
            <option value="">不指定</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>
        <label className="field"><span className="field-label">音频保留<span className="field-hint">删除音频只删原始文件，转写文本保留</span></span>
          <select value={d.retention_mode} onChange={(e) => set({ retention_mode: e.target.value as RecordingSettings['retention_mode'] })}>
            {RETENTION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select></label>
      </div>
      <p className="rec-hint">引擎：本地 whisper.cpp（{d.default_engine}）。本地转写，音频和文本不出本机，唯一联网点是下载模型。</p>
      <div className="rec-actions">
        <button className="btn btn-primary" disabled={!dirty || bad} onClick={() => { saveSettings(cur); setD(cur); setNote('已保存') }}>保存</button>
        {note && <span className="rec-ok" role="status">{note}</span>}
      </div>
    </div>
  )
}
