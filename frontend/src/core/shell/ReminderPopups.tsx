// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { reminderPopup, reminderTask, useReadNotification, useUnreadReminders, type AppNotification } from '../data'
import { Button, IconClose } from '../ui'
import { restoreFocus, trapTab } from '../ui/focus'

// 提醒弹窗：定时任务动作 remind 到点发的通知，在右下角一条条叠起来，直到点「知道了」或「打开任务」（都标已读）。
// 只在工作台里弹，不外发 IM；服务没在跑时到点的提醒不补发（执行记录记错过），开着页面时事件流推进来、断线时退回轮询。
// 一次最多显示 MAX_SHOWN 条，更多的折成「还有 N 条」。
// 弹窗方式（SPEC-tasks-8.26）：提醒设成「中间弹窗」的（data.popup = modal）在屏幕中间模态弹出、背后加遮罩，
// 一次一条（最早到的先弹），点「知道了」或「打开任务」才关、Esc 和点遮罩不关，免得一下没看清就没了；
// 后面还有中间弹窗的写「还有 N 条」。右下角的照旧叠着，两种可以同时出现。

const MAX_SHOWN = 3

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function ReminderPopups({ onOpenTask }: {
  /** 打开关联的任务；任务模块停用时不传，不显示按钮 */
  onOpenTask?: (id: string) => void
}) {
  const all = useUnreadReminders()
  const read = useReadNotification()
  const modals = all.filter((n) => reminderPopup(n) === 'modal')
  const items = all.filter((n) => reminderPopup(n) !== 'modal')
  // 列表新的在前，中间弹窗先弹最早到的
  const modal = modals.length ? modals[modals.length - 1] : null
  const shown = items.slice(0, MAX_SHOWN)
  const more = items.length - shown.length
  return (
    <>
      {modal && <ReminderModal key={modal.id} n={modal} rest={modals.length - 1} onOpenTask={onOpenTask} onRead={(id) => read.mutate(id)} />}
      {items.length > 0 && <div className="shell-reminders" role="region" aria-label="提醒">
      {shown.map((n) => {
        const task = reminderTask(n)
        return (
          <div key={n.id} className="shell-reminder" role="alert">
            <div className="shell-reminder-head">
              <span className="shell-reminder-kicker">提醒 · {hhmm(n.at)}</span>
              <button type="button" className="shell-reminder-x" aria-label="知道了" title="知道了" onClick={() => read.mutate(n.id)}>
                <IconClose size={10} />
              </button>
            </div>
            <div className="shell-reminder-title">{n.title}</div>
            {n.body && <div className="shell-reminder-body">{n.body}</div>}
            <div className="shell-reminder-acts">
              {task && onOpenTask && (
                <Button size="sm" variant="primary" onClick={() => { read.mutate(n.id); onOpenTask(task.id) }}>
                  打开任务{task.ref ? ` ${task.ref}` : ''}
                </Button>
              )}
              <Button size="sm" onClick={() => read.mutate(n.id)}>知道了</Button>
            </div>
          </div>
        )
      })}
      {more > 0 && (
        <div className="shell-reminder-more">
          还有 {more} 条提醒
          <Button size="sm" onClick={() => { for (const n of items) read.mutate(n.id) }}>全部知道了</Button>
        </div>
      )}
      </div>}
    </>
  )
}

/** 中间弹窗：模态，焦点落在「知道了」上，Tab 不跑出去；只有按钮能关 */
function ReminderModal({ n, rest, onOpenTask, onRead }: {
  n: AppNotification
  rest: number
  onOpenTask?: (id: string) => void
  onRead: (id: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const okRef = useRef<HTMLButtonElement>(null)
  const id = useId()
  const [prev] = useState(() => document.activeElement)
  const task = reminderTask(n)
  useEffect(() => {
    okRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current
      if (!el) return
      // Esc 不关：要明确点「知道了」；拦下免得关掉背后的抽屉
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
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
    <div className="dialog-scrim">
      <div ref={ref} className="shell-reminder-modal" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={n.body ? `${id}-b` : undefined}>
        <div className="shell-reminder-kicker">提醒 · {hhmm(n.at)}</div>
        <div id={`${id}-t`} className="shell-reminder-modal-title">{n.title}</div>
        {n.body && <div id={`${id}-b`} className="shell-reminder-modal-body">{n.body}</div>}
        <div className="shell-reminder-modal-acts">
          {rest > 0 && <span className="shell-reminder-modal-rest">还有 {rest} 条</span>}
          <span className="spacer" />
          {task && onOpenTask && (
            <Button onClick={() => { onRead(n.id); onOpenTask(task.id) }}>
              打开任务{task.ref ? ` ${task.ref}` : ''}
            </Button>
          )}
          <Button ref={okRef} variant="primary" onClick={() => onRead(n.id)}>知道了</Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
