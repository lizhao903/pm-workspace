import { reminderTask, useReadNotification, useUnreadReminders } from '../data'
import { Button, IconClose } from '../ui'

// 提醒弹窗：定时任务动作 remind 到点发的通知，在右下角一条条叠起来，直到点「知道了」或「打开任务」（都标已读）。
// 只在工作台里弹，不外发 IM；服务没在跑时到点的提醒不补发（执行记录记错过），开着页面时事件流推进来、断线时退回轮询。
// 一次最多显示 MAX_SHOWN 条，更多的折成「还有 N 条」。

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
  const items = useUnreadReminders()
  const read = useReadNotification()
  if (!items.length) return null
  const shown = items.slice(0, MAX_SHOWN)
  const more = items.length - shown.length
  return (
    <div className="shell-reminders" role="region" aria-label="提醒">
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
    </div>
  )
}
