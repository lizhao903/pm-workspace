import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './Button'
import { cls } from './cls'
import { focusables, restoreFocus, trapTab } from './focus'

/**
 * 确认弹窗：居中，背后加遮罩。删除这类不可逆操作传 danger，并用 impacts 列出连带影响
 * （比如「3 条子任务一起删除」「2 个文档解除关联」）。
 * 打开时焦点落在「取消」上，Tab 不跑出弹窗；Esc、点遮罩等于取消；关掉后焦点回到打开前的位置。
 */
export function ConfirmDialog({
  open, title, children, impacts, impactsTitle = '连带影响', confirmLabel = '确定', cancelLabel = '取消',
  danger, busy, onConfirm, onCancel,
}: {
  open: boolean
  title: ReactNode
  /** 正文说明 */
  children?: ReactNode
  /** 连带影响清单，一条一行；空数组不显示 */
  impacts?: ReactNode[]
  impactsTitle?: ReactNode
  confirmLabel?: ReactNode
  cancelLabel?: ReactNode
  danger?: boolean
  /** 正在提交：确认按钮禁用 */
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  if (!open) return null
  return (
    <DialogPanel title={title} impacts={impacts} impactsTitle={impactsTitle} confirmLabel={confirmLabel}
      cancelLabel={cancelLabel} danger={danger} busy={busy} onConfirm={onConfirm} onCancel={onCancel}>
      {children}
    </DialogPanel>
  )
}

function DialogPanel({ title, children, impacts, impactsTitle, confirmLabel, cancelLabel, danger, busy, onConfirm, onCancel }: {
  title: ReactNode
  children?: ReactNode
  impacts?: ReactNode[]
  impactsTitle: ReactNode
  confirmLabel: ReactNode
  cancelLabel: ReactNode
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const id = useId()
  const [prev] = useState(() => document.activeElement)
  const cancelFn = useRef(onCancel)
  useEffect(() => { cancelFn.current = onCancel })

  useEffect(() => {
    cancelRef.current?.focus()
    // 捕获阶段拦下，外层抽屉的 Esc 就收不到了
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
      <div ref={ref} className={cls('dialog', danger && 'dialog-danger')} role="alertdialog" aria-modal="true"
        aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`} tabIndex={-1}
        onFocus={() => { if (ref.current && !focusables(ref.current).length) ref.current.focus() }}>
        <h2 className="dialog-title" id={`${id}-t`}>{title}</h2>
        <div id={`${id}-d`} className="dialog-body">
          {children}
          {!!impacts?.length && (
            <div className="dialog-impact">
              <div className="dialog-impact-title">{impactsTitle}</div>
              <ul>{impacts.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
          )}
        </div>
        <div className="dialog-foot">
          <Button ref={cancelRef} variant="ghost" onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={busy} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
