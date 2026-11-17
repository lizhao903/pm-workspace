// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 群组管理「成员」菜单的加为联系人（IM 0.30.0，TSK-0724，SPEC-messages-9.13 起）。
// 没认上联系人的人旁边「加为联系人」「关联已有」，已认上的显示「联系人」点了去联系人页；
// 菜单顶上「全部加为联系人 N」（在这个会话里发过言、没认上联系人的真人，排除机器人和自己），先确认名单再逐个建。
// 正式产品 frontend/src/plugins/im/GroupMembers.tsx、MemberContacts.tsx，建联系人、挂身份走 POST /api/stakeholders、POST /api/im-identities；
// 原型直接改 App 里的联系人列表。
import { useState } from 'react'
import { GROUPS, IM_CHANNELS, type Contact, type Message } from './data'
import { cls } from './ui'
import './imsync.css'

export type ContactOps = {
  contacts: Contact[]
  /** 新建联系人并挂上渠道身份；回建成的联系人名（同名已存在的回错误原因） */
  create: (xs: { name: string; channel: string; sender_id: string; company: string; group: Contact['group'] }[]) => { ok: string[]; failed: Record<string, string> }
  /** 把渠道身份挂到已有联系人名下 */
  link: (contactId: string, channel: string, senderId: string) => void
  /** 去联系人页看这个人 */
  open: (id: string) => void
}

export type Member = { channel: string; sender_id: string; name: string; contact?: Contact; is_bot: boolean; is_self: boolean }

/** 机器人口径同正式产品：Slack 编号 B 开头、Telegram 用户名以 bot 结尾 */
export const isBot = (m: Pick<Message, 'channel' | 'sender_id'>) =>
  (m.channel === 'slack' && /^B[A-Z0-9]+$/.test(m.sender_id)) || (m.channel === 'telegram' && /bot$/i.test(m.sender_id))
/** 原型里「我」的称呼（正式产品对连接器账号和设置里的「我的称呼」） */
const SELF_NAMES = ['Broleez']

export function membersOf(msgs: Message[], contacts: Contact[]): Member[] {
  const seen = new Set<string>()
  return [...msgs].sort((a, b) => b.at.localeCompare(a.at)).filter((m) => !seen.has(m.sender_id) && !!seen.add(m.sender_id)).map((m) => {
    const contact = contacts.find((c) => c.im[m.channel] === m.sender_id)
    return { channel: m.channel, sender_id: m.sender_id, name: contact?.name ?? m.sender_name, contact, is_bot: isBot(m), is_self: SELF_NAMES.includes(m.sender_name) }
  })
}

/** 「全部加为联系人」的候选：没认上联系人的真人（排除机器人和自己） */
export const contactCandidates = (xs: Member[]) => xs.filter((m) => !m.contact && !m.is_bot && !m.is_self)

const chLabel = (ch: string) => IM_CHANNELS.find((c) => c.key === ch)?.label ?? ch

/** 关联已有：选一个联系人，把这个渠道身份挂过去 */
export function LinkContactDialog({ member, ops, onClose, onDone }: { member: Member; ops: ContactOps; onClose: () => void; onDone: (text: string) => void }) {
  const [q, setQ] = useState('')
  const kw = q.trim().toLowerCase()
  const list = ops.contacts.filter((c) => !kw || [c.name, c.company].some((v) => v.toLowerCase().includes(kw))).slice(0, 30)
  return (
    <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="qs msg-start mute-dlg" role="dialog" aria-label={`把 ${member.name} 关联到已有联系人`}>
        <div className="qs-head"><b>关联到已有联系人</b></div>
        <p className="muted mute-desc">把 {member.name} 的{chLabel(member.channel)}身份（{member.sender_id}）挂到已有联系人名下，以前和以后的消息都会显示为联系人名。</p>
        <div className="search"><input autoFocus placeholder="搜姓名、公司" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="mc-pick">
          {list.map((c) => (
            <button key={c.id} className="menu-item" onClick={() => { ops.link(c.id, member.channel, member.sender_id); onDone(`已把 ${member.name} 关联到联系人「${c.name}」`) }}>
              <span className="ellipsis">{c.name}</span><span className="muted">{c.company}</span>
              {c.im[member.channel] && <span className="muted">（已有{chLabel(member.channel)}身份，会被换掉）</span>}
            </button>
          ))}
          {!list.length && <div className="muted">没有匹配的联系人</div>}
        </div>
        <div className="act-row"><span className="spacer" /><button className="act act-quiet" onClick={onClose}>取消</button></div>
      </div>
    </div>
  )
}

/** 全部加为联系人：先列名单确认，可去掉某人、改名字；分组、公司对这批统一生效。同名已存在的失败留在名单里 */
export function BatchContactDialog({ members, ops, onClose, onDone }: { members: Member[]; ops: ContactOps; onClose: () => void; onDone: (text: string) => void }) {
  const [rows, setRows] = useState(() => members.map((m) => ({ m, name: m.name, on: true, error: '' })))
  const [group, setGroup] = useState<Contact['group']>('其他')
  const [company, setCompany] = useState('')
  const picked = rows.filter((r) => r.on && r.name.trim())
  const patch = (id: string, p: Partial<(typeof rows)[number]>) => setRows((rs) => rs.map((r) => (r.m.sender_id === id ? { ...r, ...p } : r)))
  const confirm = () => {
    const res = ops.create(picked.map((r) => ({ name: r.name.trim(), channel: r.m.channel, sender_id: r.m.sender_id, company: company.trim(), group })))
    if (!Object.keys(res.failed).length) {
      onDone(`已加为联系人 ${res.ok.length} 个：${res.ok.slice(0, 3).join('、')}${res.ok.length > 3 ? ' 等' : ''}；他们的消息都会显示为联系人名`)
      return
    }
    setRows((rs) => rs.filter((r) => !(r.on && r.name.trim()) || res.failed[r.m.sender_id]).map((r) => ({ ...r, error: res.failed[r.m.sender_id] ?? '' })))
  }
  return (
    <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="qs msg-start mute-dlg" role="dialog" aria-label="全部加为联系人">
        <div className="qs-head"><b>全部加为联系人</b></div>
        <p className="muted mute-desc">把这个会话里还没认上联系人的人建成联系人，并挂上他们的渠道身份，以前和以后的消息都会显示为联系人名。机器人和你自己不在名单里。</p>
        <div className="mc-list" role="list" aria-label="要加的人">
          {rows.map((r) => (
            <div key={r.m.sender_id} role="listitem" className="mc-row">
              <input type="checkbox" checked={r.on} aria-label={`加 ${r.m.name}`} onChange={(e) => patch(r.m.sender_id, { on: e.target.checked })} />
              <div className="mc-main">
                <input className={cls('mc-name', r.on && !r.name.trim() && 'invalid')} value={r.name} disabled={!r.on} aria-label={`${r.m.name} 的姓名`} onChange={(e) => patch(r.m.sender_id, { name: e.target.value })} />
                <span className="muted mc-ext">{chLabel(r.m.channel)} · <code>{r.m.sender_id}</code></span>
                {r.error && <span className="mc-err">{r.error}</span>}
              </div>
            </div>
          ))}
        </div>
        <div className="mc-fields">
          <label>分组<select value={group} onChange={(e) => setGroup(e.target.value as Contact['group'])}>{GROUPS.map((g) => <option key={g}>{g}</option>)}</select></label>
          <label>公司<input value={company} placeholder="选填，这批都填上" onChange={(e) => setCompany(e.target.value)} /></label>
        </div>
        <p className="muted mute-desc">电话、邮箱这些建好后到联系人页补全；同名的联系人已存在时这个人会失败，改个名字再点，或在成员菜单里单个「关联已有」。</p>
        <div className="act-row">
          <span className="spacer" />
          <button className="act act-quiet" onClick={onClose}>取消</button>
          <button className="act act-primary" disabled={!picked.length} onClick={confirm}>{picked.length ? `加为联系人 ${picked.length} 个` : '加为联系人'}</button>
        </div>
      </div>
    </div>
  )
}
