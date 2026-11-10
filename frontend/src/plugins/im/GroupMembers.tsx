// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 群组管理每行的「成员」菜单（TSK-0495，SPEC-messages-9）：列这个会话里发过言的人（含机器人），
// 每人一项「自动忽略」或「已自动忽略」（只在这个群里的也算），点了打开 MuteDialog / UnmuteDialog；结果写回群组管理顶上的提示。
// 加为联系人（IM 0.30.0，TSK-0724，SPEC-messages-9.13 起）：没认上联系人的人旁边「加为联系人」「关联已有」（ContactLinkDialog，同消息抽屉），
// 已认上的显示联系人名、点了去联系人页；菜单顶上「全部加为联系人 N」（排除机器人和自己，先确认名单，MemberContacts）。
import { useState } from 'react'
import { findMute, useConnectors, useImMembers, useImMutes, type ImConversationSummary, type ImMember, type ImMute } from '../../core/data'
import { ContactLinkDialog, type ContactLinkMode, type ContactLinkSubject } from './ContactLink'
import { contactCandidates, memberName } from './historyModel'
import { BatchContactDialog } from './MemberContacts'
import { MuteDialog, UnmuteDialog, type MuteSubject } from './MuteDialog'
import { Caret, Menu } from './parts'
import './mutes.css'

type Pick =
  | { kind: 'mute'; subject: MuteSubject; hit?: ImMute }
  | { kind: 'contact'; member: ImMember; mode: ContactLinkMode }
  | { kind: 'batch'; members: ImMember[] }

export function GroupMembersMenu({ s, chLabel, onDone, onOpenContact }: {
  s: ImConversationSummary
  chLabel: string
  onDone: (text: string) => void
  /** 去联系人页看这个人；不给时联系人名不可点 */
  onOpenContact?: (id: string) => void
}) {
  const [pick, setPick] = useState<Pick | null>(null)
  const connectors = useConnectors()
  const close = () => setPick(null)
  const done = (text: string) => { setPick(null); onDone(text) }
  let dialog = null
  if (pick?.kind === 'mute') {
    dialog = pick.hit ? <UnmuteDialog mute={pick.hit} onClose={close} onDone={onDone} /> : <MuteDialog subject={pick.subject} onClose={close} onDone={onDone} />
  } else if (pick?.kind === 'contact') {
    const m = pick.member
    const subject: ContactLinkSubject = {
      channel: s.channel, connector_id: s.connector_id, sender_id: m.external_id, sender_name: m.sender_name || m.name,
      identity_id: m.identity_id || null, stakeholder_id: m.contact_id || null, contact_name: m.contact_id ? m.name : '',
    }
    dialog = (
      <ContactLinkDialog msg={subject} mode={pick.mode} chLabel={chLabel} connectors={connectors.data} onCancel={close}
        onDone={(r) => done(r.text)} onOpenContact={(id) => { close(); onOpenContact?.(id) }} />
    )
  } else if (pick?.kind === 'batch') {
    dialog = <BatchContactDialog s={s} chLabel={chLabel} members={pick.members} onClose={close} onDone={done} />
  }
  return (
    <>
      <Menu className="im-ga-members" label={<>成员<Caret /></>} title="会话里发过言的人：可以加为联系人，或把某人（含机器人）设为自动忽略">
        {(closeMenu) => (
          <MemberItems s={s} chLabel={chLabel} onPick={(x) => { setPick(x); closeMenu() }}
            onOpenContact={onOpenContact && ((id) => { closeMenu(); onOpenContact(id) })} />
        )}
      </Menu>
      {dialog}
    </>
  )
}

function MemberItems({ s, chLabel, onPick, onOpenContact }: {
  s: ImConversationSummary
  chLabel: string
  onPick: (x: Pick) => void
  onOpenContact?: (id: string) => void
}) {
  const members = useImMembers(s.conversation_id)
  const mutes = useImMutes()
  // 只列在这个会话里发过言的：自动忽略是对来信的人
  const list = (members.data ?? []).filter((m) => m.last_at)
  const candidates = contactCandidates(members.data)
  const subjectOf = (m: ImMember): MuteSubject => ({
    channel: s.channel, channelLabel: chLabel, sender_id: m.external_id, name: memberName(m),
    stakeholder_id: m.contact_id || null, contact_name: m.contact_id ? m.name : '', conversation_id: s.conversation_id,
    conversation: s.kind === 'direct' ? '' : s.name,
  })
  return (
    <div className="im-mem-menu">
      {candidates.length > 0 && (
        <button type="button" role="menuitem" className="menu-item im-mem-all" onClick={() => onPick({ kind: 'batch', members: candidates })}
          title="把这里还没认上联系人的人都建成联系人（不含机器人和你自己），先确认名单">
          <span>全部加为联系人</span><span className="im-menu-note">{candidates.length} 人</span>
        </button>
      )}
      <div className="menu-label">发过言的人</div>
      {members.isPending && <div className="menu-item im-menu-note" aria-disabled="true">加载中…</div>}
      {members.isError && <div className="menu-item im-menu-note" aria-disabled="true">成员没加载出来</div>}
      {!members.isPending && !members.isError && !list.length && <div className="menu-item im-menu-note" aria-disabled="true">还没有人在这里发过言</div>}
      {list.map((m) => {
        const subject = subjectOf(m)
        const hit = findMute(mutes.data, subject)[0]
        const name = memberName(m)
        return (
          <div key={m.external_id} className="im-mem-row" role="group" aria-label={name}>
            <div className="im-mem-who" title={`${chLabel} · ${m.external_id}`}>
              <span className="ellipsis">{name}</span>
              {m.is_bot && <span className="im-mem-tag">机器人</span>}
              {m.is_self && <span className="im-mem-tag">你</span>}
            </div>
            <div className="im-mem-acts">
              {m.contact_id ? (
                <button type="button" role="menuitem" className="im-mem-act im-mem-contact" disabled={!onOpenContact}
                  aria-label={`查看联系人 ${name}`} title="已是联系人，点了去联系人页" onClick={() => onOpenContact?.(m.contact_id)}>联系人</button>
              ) : !m.is_self && (
                <>
                  <button type="button" role="menuitem" className="im-mem-act" aria-label={`把 ${name} 加为联系人`}
                    title="新建联系人（名字用渠道里的，可改）并挂上这个渠道身份" onClick={() => onPick({ kind: 'contact', member: m, mode: 'create' })}>加为联系人</button>
                  <button type="button" role="menuitem" className="im-mem-act" aria-label={`把 ${name} 关联到已有联系人`}
                    title="他已经在联系人里了：把这个渠道身份挂到他名下" onClick={() => onPick({ kind: 'contact', member: m, mode: 'link' })}>关联已有</button>
                </>
              )}
              <button type="button" role="menuitem" className={hit ? 'im-mem-act im-muted-on' : 'im-mem-act'}
                aria-label={hit ? `取消自动忽略 ${name}` : `自动忽略 ${name}`} onClick={() => onPick({ kind: 'mute', subject, hit })}>
                {hit ? '已自动忽略' : '自动忽略'}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
