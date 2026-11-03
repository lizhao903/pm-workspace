// 消息转任务的确认（SPEC-messages-2.15、SPEC-tasks-4.3、4.14）：标题预填正文前 40 字，勾着时建好后把消息标为已处理。
// 确认后调 POST /api/im/messages/{id}/task 由后端建任务（来源 im、props.source_ref 指回消息），再打开建好的任务抽屉补别的字段。
import { useState } from 'react'
import { errorText, isApiError, useImToTask, type ImMessage } from '../../core/data'
import { Checkbox, ConfirmDialog, Field, Input } from '../../core/ui'
import { taskTitleOf, whoName } from './model'

export function ToTaskDialog({ msg, doneLabel, onCancel, onCreated, onExisting }: {
  msg: ImMessage
  doneLabel: string
  onCancel: () => void
  /** 建好了：打开那条任务 */
  onCreated: (taskId: string) => void
  /** 已经转过（409）：读回消息后打开那条任务 */
  onExisting: () => void
}) {
  const toTask = useImToTask()
  const [title, setTitle] = useState(() => taskTitleOf(msg))
  const pending = msg.status === 'pending'
  const [done, setDone] = useState(pending)
  const [touched, setTouched] = useState(false)
  const empty = !title.trim()

  const submit = () => {
    setTouched(true)
    if (empty || toTask.isPending) return
    toTask.mutate({ id: msg.id, input: { title: title.trim(), done: pending && done } }, {
      onSuccess: (r) => onCreated(r.task.id),
      onError: (e) => { if (isApiError(e, 'conflict')) onExisting() },
    })
  }

  return (
    <ConfirmDialog open title="IM 消息转任务" confirmLabel={toTask.isPending ? '创建中…' : '创建任务'} busy={toTask.isPending}
      onConfirm={submit} onCancel={onCancel}>
      <div className="im-totask">
        <div className="im-totask-src">
          <div className="im-muted">来自 IM 消息 · {whoName(msg)}</div>
          <blockquote>{msg.text || '（没有正文）'}</blockquote>
        </div>
        <Field label="标题" required error={touched && empty ? '必填' : undefined}>
          <Input value={title} invalid={touched && empty} placeholder="要做的事" onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }} />
        </Field>
        {pending && <Checkbox checked={done} onCheckedChange={setDone}>建好后把这条消息标为{doneLabel}</Checkbox>}
        <div className="im-muted">建好后打开任务抽屉，状态、负责人、截止和所属项目在那里改</div>
        {toTask.isError && !isApiError(toTask.error, 'conflict') && <div className="im-err" role="alert">没建成：{errorText(toTask.error)}</div>}
      </div>
    </ConfirmDialog>
  )
}
