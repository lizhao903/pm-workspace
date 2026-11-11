// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 外壳状态条（shellStatus）：录音常驻时在任意页面显示计时、暂停/停止，只有用户手动停止才保存。
// 只读 recorder.ts 的模块级状态；点一下回录音页。不渲染在录音页里，所以切页面不会消失。
import { useNavigate } from 'react-router'
import { Button, cls } from '../../core/ui'
import { captureSourceShort, fmtDuration } from './model'
import {
  discardRecording, isSystemSource, pauseRecording, resumeRecording, retryRecording, stopRecording, useRecorder,
} from './recorder'
import './recording.css'

export default function RecorderStatus() {
  const s = useRecorder()
  const navigate = useNavigate()
  if (s.phase === 'idle') return null
  const active = s.phase === 'recording' || s.phase === 'paused'
  const browserMode = !isSystemSource(s.source)
  const text = s.phase === 'requesting' ? `正在申请${captureSourceShort(s.source)}…`
    : s.phase === 'recording' ? (browserMode ? '录音中' : `${captureSourceShort(s.source)} · 录音中`)
      : s.phase === 'paused' ? '录音已暂停'
        : s.phase === 'uploading' ? '正在保存录音…'
          : '录音没保存上'
  const tone = s.phase === 'recording' ? 'live' : s.phase === 'paused' ? 'paused' : ''
  return (
    <div className="rec-status" role="status" aria-live="polite">
      <button type="button" className="rec-status-open" onClick={() => navigate('/recording')} title="打开录音页">
        <span className={cls('rec-dot', tone)} aria-hidden="true" />
        <span className="rec-status-text">{text}</span>
        {(active || s.phase === 'uploading') && <span className="rec-status-timer">{fmtDuration(s.elapsedMs)}</span>}
      </button>
      <span className="rec-status-acts">
        {s.phase === 'recording' && browserMode && <Button size="sm" variant="outline" onClick={pauseRecording}>暂停</Button>}
        {s.phase === 'paused' && <Button size="sm" variant="primary" onClick={resumeRecording}>继续</Button>}
        {(s.phase === 'recording' || s.phase === 'paused') && (
          <Button size="sm" variant="primary" onClick={stopRecording}>停止并转写</Button>
        )}
        {s.phase === 'error' && <Button size="sm" onClick={retryRecording}>重试</Button>}
        {s.phase === 'error' && <Button size="sm" onClick={discardRecording}>放弃</Button>}
      </span>
    </div>
  )
}
