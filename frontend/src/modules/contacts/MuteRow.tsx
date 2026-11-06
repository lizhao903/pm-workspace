// 联系人抽屉「IM 渠道」下的「自动忽略」一行（IM 插件 0.27.0，TSK-0495，SPEC-contacts-2）：按联系人标，名下全部 IM 身份一起生效。
// 没标时「自动忽略此人的全部消息」，确认里可选把已有的待处理消息一并忽略（默认不勾，勾了按钮写条数）；
// 标了（含只在某个会话里、按某个身份标的）写出来，按联系人标的那条能取消。IM 插件没在跑（接口 404）时整行不显示。
import { useState } from 'react'
import { errorText, useCreateImMute, useImMutePending, useImMutes, useRemoveImMute, type ImMute } from '../../core/data'
import { Checkbox, ConfirmDialog } from '../../core/ui'

export function ContactMuteRow({ id, name }: { id: string; name: string }) {
  const mutes = useImMutes()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  if (mutes.isError || mutes.isPending) return null
  const mine = (mutes.data ?? []).filter((m) => m.stakeholder_id === id)
  const whole = mine.find((m) => m.kind === 'contact' && !m.conversation_id)
  const others = mine.filter((m) => m !== whole)
  return (
    <div className="ct-mute">
      <div className="ct-mute-row">
        <span className={whole ? undefined : 'faint'}>
          {whole ? `已自动忽略此人的全部消息${whole.ignored ? `（已忽略 ${whole.ignored} 条）` : ''}` : '消息照常收'}
        </span>
        <span className="spacer" />
        <button type="button" className="ct-copy" onClick={() => setOpen(true)}>{whole ? '取消自动忽略' : '自动忽略此人的全部消息'}</button>
      </div>
      {others.length > 0 && (
        <div className="faint ct-mute-sub">另有 {others.length} 条只针对某个身份或会话的自动忽略，在 IM 消息页「自动忽略」里管理</div>
      )}
      {note && <div className="ct-mute-sub" role="status">{note}</div>}
      {open && (whole
        ? <Unmute mute={whole} onClose={() => setOpen(false)} onDone={setNote} />
        : <Mute id={id} name={name} onClose={() => setOpen(false)} onDone={setNote} />)}
    </div>
  )
}

function Mute({ id, name, onClose, onDone }: { id: string; name: string; onClose: () => void; onDone: (t: string) => void }) {
  const [also, setAlso] = useState(false)
  const pending = useImMutePending({ stakeholder_id: id })
  const create = useCreateImMute()
  const n = pending.data ?? 0
  return (
    <ConfirmDialog open title={`自动忽略 ${name}`} busy={create.isPending} onCancel={onClose}
      confirmLabel={also && n > 0 ? `自动忽略，并忽略 ${n} 条` : '自动忽略'}
      onConfirm={() => create.mutate({ stakeholder_id: id, ignore_pending: also && n > 0 }, {
        onSuccess: (r) => { onDone(r.ignored ? `已设为自动忽略，已有的 ${r.ignored} 条待处理一并忽略` : '已设为自动忽略'); onClose() },
      })}>
      <div className="ct-mute-form">
        <p className="muted">此人名下全部 IM 身份之后收到的消息直接进「已忽略」：已读、不计未读、不通知，也不触发 SOP 的 IM 流程和 Agent 的 IM 触发。取消后新消息恢复正常。</p>
        <Checkbox checked={also && n > 0} disabled={pending.isPending || n === 0} onCheckedChange={setAlso}>
          {pending.isPending ? '正在数此人的待处理消息…' : n > 0 ? `把此人已有的 ${n} 条待处理消息也一并标为忽略` : '此人现在没有待处理消息'}
        </Checkbox>
        {create.isError && <div className="ct-err" role="alert">没标上：{errorText(create.error)}</div>}
      </div>
    </ConfirmDialog>
  )
}

function Unmute({ mute, onClose, onDone }: { mute: ImMute; onClose: () => void; onDone: (t: string) => void }) {
  const remove = useRemoveImMute()
  return (
    <ConfirmDialog open title={`取消自动忽略 ${mute.name}`} confirmLabel="取消自动忽略" cancelLabel="不取消" busy={remove.isPending} onCancel={onClose}
      onConfirm={() => remove.mutate(mute.id, { onSuccess: () => { onDone('已取消自动忽略'); onClose() } })}>
      <p className="muted">取消后此人的新消息恢复正常；{mute.ignored > 0 ? `已被自动忽略的 ${mute.ignored} 条不会自动恢复，要改回的在 IM 消息页「已忽略」里搜此人，逐条重新打开。` : '目前还没有被它忽略的消息。'}</p>
      {remove.isError && <div className="ct-err" role="alert">没取消成：{errorText(remove.error)}</div>}
    </ConfirmDialog>
  )
}
