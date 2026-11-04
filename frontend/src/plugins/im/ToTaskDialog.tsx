// 消息转任务的确认（SPEC-messages-2.15、SPEC-tasks-4.3、4.14）：标题预填正文前 40 字，勾着时建好后把消息标为已处理。
// 确认后调 POST /api/im/messages/{id}/task 由后端建任务（来源 im、props.source_ref 指回消息），再打开建好的任务抽屉补别的字段。
// 这条消息在消息列里（是原消息且有回复，或本身是回复）时，可以勾「附上消息列」把整段消息列拼进任务正文（默认勾上）。
// 「执行完成后在原消息里回复」（SPEC-messages-2.50，默认勾上）：后端发起内置 SOP「IM 任务回执」，任务执行完成后回复原消息；
// 回执没发起（SOP 插件没在跑、流程被删等）不挡建任务，原因交给 onCreated 由列表顶栏提示。
import { useMemo, useState } from 'react'
import { errorText, isApiError, useImToTask, type ImMessage } from '../../core/data'
import { Checkbox, ConfirmDialog, Field, Input } from '../../core/ui'
import { threadTaskBody } from './groupModel'
import { replyNoteOf, shortTime, taskTitleOf, whoName } from './model'

/** 弹窗里预览的消息列条数，多的折成「还有 N 条」 */
const THREAD_PEEK = 3

export function ToTaskDialog({ msg, thread = [], doneLabel, onCancel, onCreated, onExisting }: {
  msg: ImMessage
  /** 这条消息所在消息列里的其它消息（threadForTask），按时间正序；空的不出「附上消息列」 */
  thread?: ImMessage[]
  doneLabel: string
  onCancel: () => void
  /** 建好了：打开那条任务；replyNote 是回执没发起的原因（勾了回复但没发起时才有） */
  onCreated: (taskId: string, replyNote?: string) => void
  /** 已经转过（409）：读回消息后打开那条任务 */
  onExisting: () => void
}) {
  const toTask = useImToTask()
  const [title, setTitle] = useState(() => taskTitleOf(msg))
  const pending = msg.status === 'pending'
  const [done, setDone] = useState(pending)
  const [touched, setTouched] = useState(false)
  const [withThread, setWithThread] = useState(true)
  const [replyOnDone, setReplyOnDone] = useState(true)
  const threadBody = useMemo(() => threadTaskBody(thread), [thread])
  const empty = !title.trim()

  const submit = () => {
    setTouched(true)
    if (empty || toTask.isPending) return
    const body = withThread && threadBody ? threadBody : undefined
    toTask.mutate({ id: msg.id, input: { title: title.trim(), done: pending && done, reply_on_done: replyOnDone, ...(body ? { body } : {}) } }, {
      onSuccess: (r) => onCreated(r.task.id, replyNoteOf(replyOnDone, r.reply)),
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
        {thread.length > 0 && (
          <div className="im-totask-thread">
            <Checkbox checked={withThread} onCheckedChange={setWithThread}>附上消息列（{thread.length} 条），写进任务正文</Checkbox>
            {withThread && (
              <ul className="im-totask-thread-list" aria-label="附上的消息列">
                {thread.slice(-THREAD_PEEK).map((x) => (
                  <li key={x.id}><b>{whoName(x)}</b>{!x.thread && <span className="im-muted">（原消息）</span>} <span className="im-muted">{shortTime(x.at)}</span>：<span className="ellipsis">{x.text || '（没有正文）'}</span></li>
                ))}
                {thread.length > THREAD_PEEK && <li className="im-muted">前面还有 {thread.length - THREAD_PEEK} 条，一起附上</li>}
              </ul>
            )}
          </div>
        )}
        {pending && <Checkbox checked={done} onCheckedChange={setDone}>建好后把这条消息标为{doneLabel}</Checkbox>}
        <div className="im-totask-reply">
          <Checkbox checked={replyOnDone} onCheckedChange={setReplyOnDone}>执行完成后在原消息里回复</Checkbox>
          <div className="im-muted">任务交给 Claude Code 执行成功、或标为已完成后，自动在原消息里回复对方，带上执行结论（SOP「IM 任务回执」）</div>
        </div>
        <div className="im-muted">建好后打开任务抽屉，状态、负责人、截止和所属项目在那里改</div>
        {toTask.isError && !isApiError(toTask.error, 'conflict') && <div className="im-err" role="alert">没建成：{errorText(toTask.error)}</div>}
      </div>
    </ConfirmDialog>
  )
}

