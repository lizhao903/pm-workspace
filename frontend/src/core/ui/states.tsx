// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import type { ReactNode } from 'react'
import { Button } from './Button'
import { cls } from './cls'

/** 空状态：虚线框里一个标题、一句说明、可选一个操作 */
export function EmptyState({ title, desc, action, compact }: {
  title: ReactNode
  desc?: ReactNode
  action?: ReactNode
  compact?: boolean
}) {
  return (
    <div className={cls('empty', compact && 'empty-compact')}>
      <div className="empty-title">{title}</div>
      {desc && <div className="empty-desc">{desc}</div>}
      {action}
    </div>
  )
}

/** 加载中 */
export function LoadingState({ text = '加载中' }: { text?: ReactNode }) {
  return (
    <div className="state-loading" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{text}</span>
    </div>
  )
}

/** 出错：显示错误信息，给了 onRetry 就带「重试」 */
export function ErrorState({ title = '加载失败', error, onRetry, compact }: {
  title?: ReactNode
  /** Error（含接口层的 ApiError）取 message，字符串原样显示 */
  error?: unknown
  onRetry?: () => void
  compact?: boolean
}) {
  const msg = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined
  return (
    <div className={cls('empty state-error', compact && 'empty-compact')} role="alert">
      <div className="empty-title">{title}</div>
      {msg && <div className="empty-desc">{msg}</div>}
      {onRetry && <Button variant="outline" onClick={onRetry}>重试</Button>}
    </div>
  )
}
