// 群组管理每行的「成员」菜单（TSK-0495，SPEC-messages-9）：列这个会话里发过言的人（含机器人），
// 每人一项「自动忽略」或「已自动忽略」（只在这个群里的也算），点了打开 MuteDialog / UnmuteDialog；结果写回群组管理顶上的提示。
import { useState } from 'react'
import { findMute, useImMembers, useImMutes, type ImConversationSummary, type ImMember, type ImMute } from '../../core/data'
import { MuteDialog, UnmuteDialog, type MuteSubject } from './MuteDialog'
import { Caret, Menu } from './parts'
import './mutes.css'

export function GroupMembersMenu({ s, chLabel, onDone }: { s: ImConversationSummary; chLabel: string; onDone: (text: string) => void }) {
  const [pick, setPick] = useState<{ subject: MuteSubject; hit?: ImMute } | null>(null)
  return (
    <>
      <Menu className="im-ga-members" label={<>成员<Caret /></>} title="会话里发过言的人：可以把某人（含机器人）设为自动忽略">
        {(close) => <MemberItems s={s} chLabel={chLabel} onPick={(x) => { setPick(x); close() }} />}
      </Menu>
      {pick && (pick.hit
        ? <UnmuteDialog mute={pick.hit} onClose={() => setPick(null)} onDone={onDone} />
        : <MuteDialog subject={pick.subject} onClose={() => setPick(null)} onDone={onDone} />)}
    </>
  )
}

function MemberItems({ s, chLabel, onPick }: { s: ImConversationSummary; chLabel: string; onPick: (x: { subject: MuteSubject; hit?: ImMute }) => void }) {
  const members = useImMembers(s.conversation_id)
  const mutes = useImMutes()
  // 只列在这个会话里发过言的：自动忽略是对来信的人
  const list = (members.data ?? []).filter((m) => m.last_at)
  const subjectOf = (m: ImMember): MuteSubject => ({
    channel: s.channel, channelLabel: chLabel, sender_id: m.external_id, name: m.name || m.sender_name || m.external_id,
    stakeholder_id: m.contact_id || null, contact_name: m.contact_id ? m.name : '', conversation_id: s.conversation_id,
    conversation: s.kind === 'direct' ? '' : s.name,
  })
  return (
    <>
      <div className="menu-label">自动忽略此人的消息</div>
      {members.isPending && <div className="menu-item im-menu-note" aria-disabled="true">加载中…</div>}
      {members.isError && <div className="menu-item im-menu-note" aria-disabled="true">成员没加载出来</div>}
      {!members.isPending && !members.isError && !list.length && <div className="menu-item im-menu-note" aria-disabled="true">还没有人在这里发过言</div>}
      {list.map((m) => {
        const subject = subjectOf(m)
        const hit = findMute(mutes.data, subject)[0]
        return (
          <button key={m.external_id} type="button" role="menuitem" className="menu-item" onClick={() => onPick({ subject, hit })}
            title={`${chLabel} · ${m.external_id}`}>
            <span className="ellipsis">{subject.name}</span>
            <span className="im-menu-note">{hit ? '已自动忽略，点了取消' : '自动忽略'}</span>
          </button>
        )
      })}
    </>
  )
}
