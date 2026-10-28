// 列表上点待验收任务的完成圆圈：先确认再验收通过（SPEC-tasks-5.27）。
// 三个按钮「取消」「打开任务」「验收通过」，默认焦点在「验收通过」；Esc、点遮罩同取消。
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WorkObject } from '../../core/api'
import { Button } from '../../core/ui'
import { restoreFocus, trapTab } from '../../core/ui/focus'

export function ApproveDialog({ task, busy, error, onApprove, onOpen, onCancel }: {
  task: WorkObject
  busy?: boolean
  error?: string
  onApprove: () => void
  onOpen: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const okRef = useRef<HTMLButtonElement>(null)
  const id = useId()
  const [prev] = useState(() => document.activeElement)
  const cancelFn = useRef(onCancel)
  useEffect(() => { cancelFn.current = onCancel })

  useEffect(() => {
    okRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current
      if (!el) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cancelFn.current()
      } else if (e.key === 'Tab') {
        trapTab(el, e)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      restoreFocus(prev)
    }
  }, [prev])

  return createPortal(
    <div className="dialog-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div ref={ref} className="dialog" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`} tabIndex={-1}>
        <h2 className="dialog-title" id={`${id}-t`}>验收通过 {task.ref}？</h2>
        <div className="dialog-body" id={`${id}-d`}>
          「{task.title}」会改为已完成，并记一条「验收通过」的进展。要写意见或退回，打开任务处理。
          {error && <div className="field-err approve-err" role="alert">验收没提交成功：{error}</div>}
        </div>
        <div className="dialog-foot">
          <Button variant="ghost" onClick={onCancel}>取消</Button>
          <Button variant="outline" onClick={onOpen}>打开任务</Button>
          <Button ref={okRef} variant="primary" disabled={busy} onClick={onApprove}>验收通过</Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
