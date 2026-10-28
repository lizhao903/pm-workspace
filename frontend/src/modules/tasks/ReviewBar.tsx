// 待验收的任务在抽屉里验收通过或退回（DEV-08d，照原型 devloop.tsx 的 ReviewBar）。
// 验收通过和列表完成圆圈走同一个 useApprove（kind=note、status=done）；退回意见必填，状态回初始状态。
import { useState } from 'react'
import type { ObjectStatus, WorkObject } from '../../core/api'
import { shortSession, useProgress } from '../../core/api/progress'
import { useApprove } from '../../core/api/taskEdit'
import { useReject } from '../../core/api/taskReview'
import { Button, Textarea } from '../../core/ui'
import { doneKey, reopenKey, timeAgo } from './model'
import './changes.css'

type Mode = '' | 'pass' | 'back'

export function ReviewBar({ task, statuses, onReviewed }: {
  task: WorkObject
  statuses: ObjectStatus[]
  /** 提交成功后的新状态，抽屉据此同步自己的表单 */
  onReviewed: (status: string) => void
}) {
  const [mode, setMode] = useState<Mode>('')
  const [text, setText] = useState('')
  const [tried, setTried] = useState(false)
  const approve = useApprove()
  const reject = useReject()
  const progress = useProgress(task.id)
  const last = progress.data?.find((p) => p.kind === 'review')

  const done = doneKey(statuses)
  const initial = reopenKey(statuses)
  const busy = approve.isPending || reject.isPending
  const err = (mode === 'pass' ? approve.error : mode === 'back' ? reject.error : null)?.message
  const missing = tried && mode === 'back' && !text.trim()

  const pick = (m: Mode) => {
    setMode(m)
    setTried(false)
    approve.reset()
    reject.reset()
  }
  // 用 mutateAsync：成功后刷新对象会让这一栏先卸载，mutate 的回调就不会再触发
  const submit = async () => {
    setTried(true)
    try {
      if (mode === 'pass') {
        if (!done) return
        await approve.mutateAsync({ id: task.id, status: done, comment: text })
        onReviewed(done)
      } else if (mode === 'back') {
        if (!text.trim() || !initial) return
        await reject.mutateAsync({ id: task.id, status: initial, comment: text })
        onReviewed(initial)
      }
    } catch {
      // 错误由 approve.error / reject.error 显示
    }
  }

  const initialLabel = statuses.find((s) => s.key === initial)?.label ?? initial
  const doneLabel = statuses.find((s) => s.key === done)?.label ?? done

  return (
    <div className="rv-bar" role="region" aria-label="等你验收">
      <div className="rv-head">
        <span className="field-group-title">等你验收</span>
        <span className="rv-sub">
          {last
            ? `${last.actor_name || last.actor || '未知'}${last.session_id ? ` · 会话 ${shortSession(last.session_id)}` : ''} · ${timeAgo(last.created_at)}提交`
            : '状态是待验收'}
        </span>
      </div>
      {mode ? (
        <div className="rv-form">
          <Textarea rows={3} value={text} autoFocus invalid={missing} aria-label={mode === 'pass' ? '验收意见' : '退回意见'}
            placeholder={mode === 'pass' ? '意见（可选）' : '哪里没过、要怎么改，Claude Code 下次领取时会读到'}
            onChange={(e) => setText(e.target.value)} />
          {missing && <span className="field-err" role="alert">写一下退回原因</span>}
          {err && <span className="field-err" role="alert">没提交成功：{err}</span>}
          <div className="rv-acts">
            <Button variant={mode === 'pass' ? 'primary' : 'danger'} disabled={busy} onClick={() => void submit()}>
              {mode === 'pass' ? '确认验收通过' : '确认退回'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => pick('')}>取消</Button>
            <span className="rv-hint">
              {mode === 'pass' ? `状态改为${doneLabel}，记一条「验收通过」的进展` : `状态回到${initialLabel}，别的会话可以重新领取`}
            </span>
          </div>
        </div>
      ) : (
        <div className="rv-acts">
          <Button variant="primary" disabled={!done} onClick={() => pick('pass')}>验收通过</Button>
          <Button variant="outline" disabled={!initial} onClick={() => pick('back')}>退回</Button>
        </div>
      )}
    </div>
  )
}
