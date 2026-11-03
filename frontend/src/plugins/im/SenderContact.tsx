// 发信人和联系人（IM-05）：单条消息抽屉和合并的一组的抽屉共用。
// 认上联系人的给「查看联系人」「不是这个人」，没认上的给「关联到联系人」「新建联系人」；认人按 IM 身份（渠道 + 编号），
// 改一次这个人所有消息都跟着变。做完的结果一行提示（note），新建的能去联系人页补全。
import { Button } from '../../core/ui'
import type { ImMessage } from '../../core/data'
import type { ContactLinkMode, ContactLinkResult } from './ContactLink'

export function SenderContactActs({ msg, chLabel, onOpenContact, onLinkContact }: {
  msg: ImMessage
  chLabel: string
  onOpenContact: (id: string) => void
  onLinkContact: (mode: ContactLinkMode) => void
}) {
  return msg.stakeholder_id ? (
    <div className="im-sender-acts">
      <Button onClick={() => onOpenContact(msg.stakeholder_id!)}>查看联系人</Button>
      <button type="button" className="im-act im-act-quiet" title="认错人了：改挂到别人，或解除关联" onClick={() => onLinkContact('fix')}>不是这个人</button>
    </div>
  ) : (
    <div className="im-sender-acts">
      <Button variant="outline" onClick={() => onLinkContact('link')} title={`把 ${chLabel} 编号 ${msg.sender_id} 挂到已有联系人名下`}>关联到联系人</Button>
      <Button onClick={() => onLinkContact('create')} title="就地新建，姓名预填发信人名字">新建联系人</Button>
    </div>
  )
}

export function LinkNote({ note, onOpenContact }: { note: ContactLinkResult; onOpenContact: (id: string) => void }) {
  return (
    <div className="im-link-note" role="status">
      <span>{note.text}</span>
      {note.created && note.contactId && <button type="button" className="im-act" onClick={() => onOpenContact(note.contactId!)}>去联系人页补全</button>}
    </div>
  )
}
