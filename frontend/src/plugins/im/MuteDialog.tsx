// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 自动忽略发信人（IM 0.27.0，TSK-0495，SPEC-messages-9）：消息抽屉的发信人处、群组管理的「成员」里都用这里的按钮和弹窗。
// 「自动忽略」弹窗：按渠道身份或（认上联系人时）按联系人；群里的消息可选只在这个群里忽略；
// 可选把此人已有的待处理消息一并忽略（默认不勾，勾了按钮上写条数）。已标过的按钮写「已自动忽略」，点开是取消确认。
import { useState } from 'react'
import {
  errorText, findMute, useCreateImMute, useImMutePending, useImMutes, useRemoveImMute,
  type ImMute, type ImMuteResult, type ImMuteTarget,
} from '../../core/data'
import { Checkbox, ConfirmDialog, cls } from '../../core/ui'
import { muteScopeText, muteWhoText } from './muteModel'
import './mutes.css'

/** 要标的发信人：渠道身份（必有），认上的联系人，所在会话（群名为空是私聊） */
export type MuteSubject = {
  channel: string
  channelLabel: string
  sender_id: string
  name: string
  stakeholder_id?: string | null
  contact_name?: string
  conversation_id?: string | null
  conversation?: string
}

export function MuteButton({ subject, className, onDone }: { subject: MuteSubject; className?: string; onDone?: (text: string) => void }) {
  const mutes = useImMutes()
  const [open, setOpen] = useState(false)
  const hit = findMute(mutes.data, subject)
  if (mutes.isError) return null
  return (
    <>
      <button type="button" className={cls('im-act im-act-quiet', hit.length > 0 && 'im-muted-on', className)} disabled={mutes.isPending}
        title={hit.length ? `${muteScopeText(hit[0])}自动忽略；点这里取消` : '之后此人的消息直接进「已忽略」，不计未读、不触发 SOP 和 Agent'}
        aria-label={hit.length ? `已自动忽略 ${subject.name}` : `自动忽略 ${subject.name}`} onClick={() => setOpen(true)}>
        {hit.length ? '已自动忽略' : '自动忽略'}
      </button>
      {open && (hit.length
        ? <UnmuteDialog mute={hit[0]} onClose={() => setOpen(false)} onDone={onDone} />
        : <MuteDialog subject={subject} onClose={() => setOpen(false)} onDone={onDone} />)}
    </>
  )
}

/** 标记结果一句话 */
export function muteDoneText(r: ImMuteResult) {
  const head = r.created ? `已把 ${r.mute.name} 设为自动忽略` : `${r.mute.name} 之前就设为自动忽略了`
  return r.ignored > 0 ? `${head}，已有的 ${r.ignored} 条待处理一并忽略` : head
}

export function MuteDialog({ subject, onClose, onDone }: { subject: MuteSubject; onClose: () => void; onDone?: (text: string) => void }) {
  const [by, setBy] = useState<'sender' | 'contact'>('sender')
  const group = !!subject.conversation_id && !!subject.conversation
  const [scope, setScope] = useState<'all' | 'conv'>('all')
  const [also, setAlso] = useState(false)
  const create = useCreateImMute()
  const target: ImMuteTarget = by === 'contact' && subject.stakeholder_id
    ? { stakeholder_id: subject.stakeholder_id } : { channel: subject.channel, sender_id: subject.sender_id }
  if (group && scope === 'conv') target.conversation_id = subject.conversation_id!
  const pending = useImMutePending(target)
  const n = pending.data ?? 0
  const name = by === 'contact' ? subject.contact_name || subject.name : subject.name
  const submit = () => {
    create.mutate({ ...target, name, ignore_pending: also && n > 0 }, {
      onSuccess: (r) => { onDone?.(muteDoneText(r)); onClose() },
    })
  }
  return (
    <ConfirmDialog open title={`自动忽略 ${name}`} busy={create.isPending} onCancel={onClose} onConfirm={submit}
      confirmLabel={also && n > 0 ? `自动忽略，并忽略 ${n} 条` : '自动忽略'}>
      <div className="im-mute-form">
        <p className="im-mute-desc">之后收到的消息直接进「已忽略」：已读、不计未读、不通知，也不触发 SOP 的 IM 流程和 Agent 的 IM 触发。取消后新消息恢复正常。</p>
        {subject.stakeholder_id && (
          <fieldset className="im-mute-opt">
            <legend>按谁</legend>
            <label><input type="radio" name="im-mute-by" checked={by === 'sender'} onChange={() => setBy('sender')} />只这个身份<span className="im-muted im-mono">{subject.channelLabel} · {subject.sender_id}</span></label>
            <label><input type="radio" name="im-mute-by" checked={by === 'contact'} onChange={() => setBy('contact')} />联系人「{subject.contact_name || subject.name}」的全部 IM 身份</label>
          </fieldset>
        )}
        {!subject.stakeholder_id && <div className="im-muted im-mono">{subject.channelLabel} · {subject.sender_id}</div>}
        {group && (
          <fieldset className="im-mute-opt">
            <legend>范围</legend>
            <label><input type="radio" name="im-mute-scope" checked={scope === 'all'} onChange={() => setScope('all')} />全部会话</label>
            <label><input type="radio" name="im-mute-scope" checked={scope === 'conv'} onChange={() => setScope('conv')} />只在「{subject.conversation}」里</label>
          </fieldset>
        )}
        <Checkbox checked={also && n > 0} disabled={pending.isPending || n === 0} onCheckedChange={setAlso}>
          {pending.isPending ? '正在数此人的待处理消息…' : n > 0 ? `把此人已有的 ${n} 条待处理消息也一并标为忽略` : '此人现在没有待处理消息'}
        </Checkbox>
        {create.isError && <div className="im-err" role="alert">没标上：{errorText(create.error)}</div>}
      </div>
    </ConfirmDialog>
  )
}

export function UnmuteDialog({ mute, onClose, onDone }: { mute: ImMute; onClose: () => void; onDone?: (text: string) => void }) {
  const remove = useRemoveImMute()
  return (
    <ConfirmDialog open title={`取消自动忽略 ${mute.name}`} confirmLabel="取消自动忽略" cancelLabel="不取消" busy={remove.isPending} onCancel={onClose}
      onConfirm={() => remove.mutate(mute.id, { onSuccess: () => { onDone?.(`已取消自动忽略 ${mute.name}`); onClose() } })}>
      <p className="im-mute-desc">{muteWhoText(mute)}，{muteScopeText(mute)}。取消后此人的新消息恢复正常；
        {mute.ignored > 0 ? `已被自动忽略的 ${mute.ignored} 条不会自动恢复，要改回的在「已忽略」里搜此人，逐条重新打开。` : '目前还没有被它忽略的消息。'}</p>
      {remove.isError && <div className="im-err" role="alert">没取消成：{errorText(remove.error)}</div>}
    </ConfirmDialog>
  )
}
