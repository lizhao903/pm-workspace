// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 录音页（/recording）：顶部「开始录音」，下面是录音工作区（未开始/授权中/录音中/暂停/上传中/失败重试）和录音列表。
// 录音本身常驻在模块级（recorder.ts）：切到别的模块、切浏览器标签页都继续录，只有用户点「停止并转写」才停并保存；
// 外壳状态条（RecorderStatus.tsx）负责在任意页面显示计时和停止入口。这里只是它的视图。
// 列表按状态本地筛（转写中要含排队与转写中两态），行的进度条和状态每 2 秒刷新由数据层轮询。
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { errorText, useRecordingList, type RecordingSummary } from '../../core/data'
import { Button, EmptyState, ErrorState, Input, LoadingState, PageTitle, Pill, Tag, cls } from '../../core/ui'
import {
  CAPTURE_SOURCES, LIST_FILTERS, LIST_LIMIT, captureSourceShort, captureSourceText, clampPct, fmtCreatedAt, fmtDuration,
  matchesFilter, recordingPath, statusText, statusTone, systemDeviceHint, type ListFilter,
} from './model'
import {
  discardRecording, ensureDevices, isSystemSource, pauseRecording, retryRecording, resumeRecording, setRecorderDevice,
  setRecorderSource, setRecorderTitle, startRecording, stopRecording, subscribeRecorderSaved, useRecorder,
} from './recorder'
import { Detail } from './Detail'
import { InlineRename } from './Rename'
import './recording.css'

/** 路由：/recording 列表，/recording/<id> 详情（模块挂在 recording/* 下，用通配段分派） */
export default function Page() {
  const rest = useParams()['*'] ?? ''
  return rest ? <Detail /> : <ListPage />
}

function ListPage() {
  const list = useRecordingList({ limit: LIST_LIMIT })
  const [filter, setFilter] = useState<ListFilter>('')
  const navigate = useNavigate()
  const rows = (list.data ?? []).filter((r) => matchesFilter(filter, r.status))

  // 保存成功（不管是不是在这个页面点的停止）都跳详情；页面没显示时不听，列表刷新后能看到新录音
  useEffect(() => subscribeRecorderSaved((id) => { void navigate(recordingPath(id)) }), [navigate])

  return (
    <section className="rec-page">
      <PageTitle desc="浏览器内录音，本机 whisper.cpp 转写；音频和文本都不出本机"
        actions={<Button variant="primary" size="sm" onClick={() => void startRecording()}>开始录音</Button>}>
        录音
      </PageTitle>

      <Recorder />

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
          action={<Button variant="primary" onClick={() => void startRecording()}>开始录音</Button>} />
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

/* ---------- 录音工作区（引擎在 recorder.ts，常驻） ---------- */

function Recorder() {
  const { phase, elapsedMs, title, error, source, deviceIndex, devices, devicesPending, devicesError } = useRecorder()
  const needsDevice = isSystemSource(source)

  // 上次选的是系统来源，进页面先把设备读出来（选来源时 recorder 里也会读，这里兜住直接进页面的情况）
  useEffect(() => {
    if (needsDevice && !devices && !devicesPending && !devicesError) void ensureDevices()
  }, [needsDevice, devices, devicesPending, devicesError])

  const active = phase === 'recording' || phase === 'paused'
  const systemMode = isSystemSource(source)
  const sourceDesc = CAPTURE_SOURCES.find((s) => s.key === source)?.desc ?? ''
  const hasVirtual = !!devices?.devices.some((d) => d.virtual)
  return (
    <section className={cls('rec-work', active && 'on')} aria-label="录音工作区">
      <div className="rec-work-head">
        <span className={cls('rec-dot', phase === 'recording' && 'live', phase === 'paused' && 'paused')} aria-hidden="true" />
        <b className="rec-work-title">
          {phase === 'idle' ? '准备录音'
            : phase === 'requesting' ? `正在申请${captureSourceShort(source)}`
              : phase === 'recording' ? `${captureSourceText(source)} · 录音中`
                : phase === 'paused' ? '已暂停'
                  : phase === 'uploading' ? (systemMode ? '正在停止采集并混音保存' : '正在保存')
                    : '录音没保存上'}
        </b>
        {active && <span className="rec-timer" aria-label="录音时长">{fmtDuration(elapsedMs)}</span>}
      </div>

      {phase === 'idle' && (
        <>
          <Input className="rec-title-input" aria-label="录音标题（可空）" placeholder="标题（可空，之后也能在详情里改）"
            value={title} onChange={(e) => setRecorderTitle(e.target.value)} />

          <div className="rec-source" role="radiogroup" aria-label="录音来源">
            {CAPTURE_SOURCES.map((s) => (
              <button key={s.key} type="button" role="radio" aria-checked={source === s.key}
                className={cls('rec-source-opt', source === s.key && 'on')} onClick={() => setRecorderSource(s.key)}>
                {s.label}
              </button>
            ))}
          </div>
          <p className="rec-work-hint">{sourceDesc}</p>

          {needsDevice && (
            <div className="rec-devices">
              {devicesPending ? <span className="rec-faint">正在读取本机音频设备…</span>
                : devicesError ? <span className="rec-row-err">设备列表没读出来：{devicesError}</span>
                  : !devices || !devices.supported || !devices.ffmpeg || devices.devices.length === 0 ? (
                    <span className="rec-row-err">{systemDeviceHint(devices ?? undefined)}</span>
                  ) : (
                    <>
                      <label className="rec-device-label" htmlFor="rec-device">声音设备</label>
                      <select id="rec-device" className="rec-device-select" value={deviceIndex ?? ''}
                        onChange={(e) => setRecorderDevice(Number(e.target.value))}>
                        {devices.devices.map((d) => (
                          <option key={d.index} value={d.index}>
                            {d.name}{d.virtual ? '（虚拟声卡/系统声音）' : ''}{d.default ? ' · 默认' : ''}
                          </option>
                        ))}
                      </select>
                      <Button size="sm" variant="ghost" onClick={() => void ensureDevices(true)}>重新检测</Button>
                      {!hasVirtual && <span className="rec-work-hint">{systemDeviceHint(devices)}</span>}
                    </>
                  )}
            </div>
          )}

          <div className="rec-work-actions">
            <Button variant="primary" onClick={() => void startRecording()}>开始录音</Button>
            <span className="rec-work-hint">
              {systemMode ? '先允许访问声音设备；停止后在本机混音并排队转写'
                : source === 'share' ? '浏览器会弹出分享窗口，记得勾选「分享标签页声音」'
                  : '先允许使用麦克风；停止后自动保存到本机并排队转写'}
            </span>
          </div>

          {systemMode && (
            <p className="rec-work-hint">
              macOS 要录整个电脑/会议 App 的声音需要虚拟声卡：<code>brew install blackhole-2ch</code>，
              再用「音频 MIDI 设置」建一个多输出设备、把系统输出接过去；装好后点「重新检测」。
              只想录网页里的声音可以直接用「系统声音（浏览器分享）」，不用装。
            </p>
          )}
        </>
      )}

      {phase === 'requesting' && <LoadingState text={`正在申请${captureSourceShort(source)}授权…`} />}

      {active && (
        <div className="rec-work-actions">
          {!systemMode && (phase === 'recording'
            ? <Button variant="outline" onClick={pauseRecording}>暂停</Button>
            : <Button variant="primary" onClick={resumeRecording}>继续</Button>)}
          <Button variant="primary" onClick={stopRecording}>停止并转写</Button>
          <Button onClick={discardRecording}>放弃</Button>
        </div>
      )}

      {phase === 'uploading' && (
        <LoadingState text={systemMode ? '正在停止采集、混音并保存，保存后开始转写…' : '正在保存录音，保存后开始转写…'} />
      )}

      {phase === 'error' && (
        <>
          <ErrorState compact title="录音失败" error={error} onRetry={retryRecording} />
          <div className="rec-work-actions">
            <Button onClick={discardRecording}>放弃这次录音</Button>
          </div>
        </>
      )}
    </section>
  )
}
