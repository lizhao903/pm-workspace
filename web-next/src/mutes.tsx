// 自动忽略发信人（SPEC-messages-9，TSK-0495）：把某个发信人标为「自动忽略」，之后收到的他的消息直接进「已忽略」、已读，
// 不触发 SOP 的 IM 流程和 Agent 的 IM 触发（正式产品是后端不发 im.message_received）。
// 原型把自动忽略和「哪条消息是被它忽略的」放在这个模块的本地状态里（刷新就没了），不改 Message 结构：
// 立即同步收到的新消息经 applyMutes 判断（App 的 syncMessages），一并忽略已有待处理走消息的「忽略」动作再记一笔。
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { Contact, Message } from './data'
import { IM_CHANNELS } from './data'
import { newId } from './ids'
import { cls, timeAgo } from './ui'

export type Mute = {
  id: string
  /** sender 按渠道身份（渠道 + 编号），contact 按联系人（名下全部 IM 身份） */
  kind: 'sender' | 'contact'
  channel: string
  sender_id: string
  contact_id: string
  /** 只在这个群里忽略（群名）；空串是全部会话 */
  conversation: string
  name: string
  created_at: string
}
type Mark = { mute_id: string; name: string }

let mutes: Mute[] = []
/** 消息 id → 被哪条自动忽略忽略掉的 */
let marks: Record<string, Mark> = {}
const subs = new Set<() => void>()
const emit = () => { for (const f of subs) f() }
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
const snap = () => mutes

export function useMutes() { return useSyncExternalStore(subscribe, snap) }

/**
 * 消息、联系人和「忽略」动作由 App 每次渲染时交进来（bindMuteEnv），各入口不用层层传；
 * 原型才这么做，正式产品走接口
 */
let env: { messages: Message[]; contacts: Contact[]; ignore: (ids: string[]) => void } = { messages: [], contacts: [], ignore: () => {} }
export function bindMuteEnv(messages: Message[], contacts: Contact[], ignore: (ids: string[]) => void) { env = { messages, contacts, ignore } }

const chLabel = (k: string) => IM_CHANNELS.find((c) => c.key === k)?.label ?? k
const contactOf = (m: Pick<Message, 'channel' | 'sender_id'>, contacts: Contact[]) => contacts.find((c) => c.im[m.channel] === m.sender_id)

/** 这条消息命中的自动忽略：只在这个群里的优先 */
export function matchMute(m: Message, contacts: Contact[], list: readonly Mute[] = mutes) {
  const ct = contactOf(m, contacts)
  const hits = list.filter((x) => ((x.kind === 'sender' && x.channel === m.channel && x.sender_id === m.sender_id) || (x.kind === 'contact' && !!ct && x.contact_id === ct.id))
    && (!x.conversation || x.conversation === m.conversation))
  return hits.sort((a, b) => b.conversation.length - a.conversation.length)[0]
}

/** 新到的消息：命中的直接已忽略、已读，记上是哪条 */
export function applyMutes(fresh: Message[], contacts: Contact[]): Message[] {
  let hit = false
  const out = fresh.map((m) => {
    const x = matchMute(m, contacts)
    if (!x) return m
    hit = true
    marks = { ...marks, [m.id]: { mute_id: x.id, name: x.name } }
    return { ...m, status: 'ignored' as const, read: true, snooze_until: null, expired_at: null }
  })
  if (hit) emit()
  return out
}

/** 消息详情、列表小标里的原因：被自动忽略、现在还是已忽略的才写；组件里先 useMutes() 订阅变化 */
export function muteReasonOf(m: Message) {
  const mk = marks[m.id]
  if (!mk || m.status !== 'ignored') return ''
  return `因发信人 ${mk.name} 被设为自动忽略${mutes.some((x) => x.id === mk.mute_id) ? '' : '（已取消自动忽略）'}`
}

type Target = { kind: 'sender' | 'contact'; channel: string; sender_id: string; contact_id: string; conversation: string }
const sameTarget = (a: Target, b: Target) => a.kind === b.kind && a.channel === b.channel && a.sender_id === b.sender_id && a.contact_id === b.contact_id && a.conversation === b.conversation

function pendingOf(t: Target, messages: Message[], contacts: Contact[]) {
  return messages.filter((m) => m.status === 'pending' && (t.kind === 'sender'
    ? m.channel === t.channel && m.sender_id === t.sender_id : contactOf(m, contacts)?.id === t.contact_id)
    && (!t.conversation || m.conversation === t.conversation))
}

/** 标记；同一对象同一范围标过的不重复建。ignore 给了时把已有待处理一并忽略（走消息的忽略动作），回一句结果 */
function addMute(t: Target, name: string, ignore: Message[] | null, onIgnore: (ids: string[]) => void) {
  const had = mutes.find((x) => sameTarget(x, t))
  const mute = had ?? { ...t, id: newId('imu'), name, created_at: new Date().toISOString() }
  if (!had) mutes = [mute, ...mutes]
  if (ignore?.length) {
    onIgnore(ignore.map((m) => m.id))
    marks = { ...marks, ...Object.fromEntries(ignore.map((m) => [m.id, { mute_id: mute.id, name: mute.name }])) }
  }
  emit()
  const head = had ? `${mute.name} 之前就设为自动忽略了` : `已把 ${mute.name} 设为自动忽略`
  return ignore?.length ? `${head}，已有的 ${ignore.length} 条待处理一并忽略` : head
}

function removeMute(id: string) { mutes = mutes.filter((x) => x.id !== id); emit() }
const ignoredBy = (id: string) => Object.values(marks).filter((x) => x.mute_id === id).length

/** 发信人处的「自动忽略 / 已自动忽略」按钮和弹窗（SPEC-messages-9.1~9.6） */
export function MuteButton({ msg, onDone, className }: { msg: Message; onDone?: (text: string) => void; className?: string }) {
  const { contacts } = env
  const list = useMutes()
  const [open, setOpen] = useState(false)
  const ct = contactOf(msg, contacts)
  const hit = matchMute(msg, contacts, list)
  const name = ct?.name ?? msg.sender_name ?? msg.sender_id
  return (
    <>
      <button className={cls('act act-quiet', hit && 'mute-on', className)} onClick={() => setOpen(true)}
        title={hit ? '已自动忽略；点这里取消' : '之后此人的消息直接进「已忽略」，不计未读、不触发 SOP 和 Agent'}>{hit ? '已自动忽略' : '自动忽略'}</button>
      {open && (hit
        ? <UnmuteDialog mute={hit} onClose={() => setOpen(false)} onDone={onDone} />
        : <MuteDialog msg={msg} contact={ct} name={name} onDone={onDone} onClose={() => setOpen(false)} />)}
    </>
  )
}

function MuteDialog({ msg, contact, name, onDone, onClose }: {
  msg: Message; contact?: Contact; name: string; onDone?: (text: string) => void; onClose: () => void
}) {
  const { messages, contacts, ignore: onIgnore } = env
  const [by, setBy] = useState<'sender' | 'contact'>('sender')
  const [scope, setScope] = useState<'all' | 'conv'>('all')
  const [also, setAlso] = useState(false)
  const t: Target = by === 'contact' && contact
    ? { kind: 'contact', channel: '', sender_id: '', contact_id: contact.id, conversation: scope === 'conv' ? msg.conversation : '' }
    : { kind: 'sender', channel: msg.channel, sender_id: msg.sender_id, contact_id: '', conversation: scope === 'conv' ? msg.conversation : '' }
  const pending = pendingOf(t, messages, contacts)
  const n = pending.length
  const who = by === 'contact' && contact ? contact.name : name
  const submit = () => { onDone?.(addMute(t, who, also && n ? pending : null, onIgnore)); onClose() }
  return (
    <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="qs msg-start mute-dlg" role="dialog" aria-label={`自动忽略 ${who}`}>
        <div className="qs-head"><b>自动忽略 {who}</b></div>
        <p className="muted mute-desc">之后收到的消息直接进「已忽略」：已读、不计未读、不通知，也不触发 SOP 的 IM 流程和 Agent 的 IM 触发。取消后新消息恢复正常。</p>
        {contact ? (
          <fieldset className="mute-opt">
            <legend>按谁</legend>
            <label><input type="radio" checked={by === 'sender'} onChange={() => setBy('sender')} />只这个身份<span className="muted mono">{chLabel(msg.channel)} · {msg.sender_id}</span></label>
            <label><input type="radio" checked={by === 'contact'} onChange={() => setBy('contact')} />联系人「{contact.name}」的全部 IM 身份</label>
          </fieldset>
        ) : <div className="muted mono">{chLabel(msg.channel)} · {msg.sender_id}</div>}
        {msg.conversation && (
          <fieldset className="mute-opt">
            <legend>范围</legend>
            <label><input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} />全部会话</label>
            <label><input type="radio" checked={scope === 'conv'} onChange={() => setScope('conv')} />只在「{msg.conversation}」里</label>
          </fieldset>
        )}
        <label className={cls('mute-also', !n && 'muted')}>
          <input type="checkbox" checked={also && n > 0} disabled={!n} onChange={(e) => setAlso(e.target.checked)} />
          {n ? `把此人已有的 ${n} 条待处理消息也一并标为忽略` : '此人现在没有待处理消息'}
        </label>
        <div className="act-row">
          <span className="spacer" />
          <button className="act act-quiet" onClick={onClose}>取消</button>
          <button className="act act-primary" onClick={submit}>{also && n ? `自动忽略，并忽略 ${n} 条` : '自动忽略'}</button>
        </div>
      </div>
    </div>
  )
}

function whoText(m: Mute, contacts: Contact[] = []) {
  if (m.kind === 'contact') return `联系人「${contacts.find((c) => c.id === m.contact_id)?.name ?? m.name}」的全部 IM 身份`
  return `${chLabel(m.channel)} · ${m.sender_id}`
}
const scopeText = (m: Mute) => (m.conversation ? `只在「${m.conversation}」里` : '全部会话')

function UnmuteDialog({ mute, onClose, onDone }: { mute: Mute; onClose: () => void; onDone?: (text: string) => void }) {
  const n = ignoredBy(mute.id)
  return (
    <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="qs msg-start mute-dlg" role="dialog" aria-label={`取消自动忽略 ${mute.name}`}>
        <div className="qs-head"><b>取消自动忽略 {mute.name}</b></div>
        <p className="muted mute-desc">{whoText(mute)}，{scopeText(mute)}。取消后此人的新消息恢复正常；
          {n ? `已被自动忽略的 ${n} 条不会自动恢复，要改回的在「已忽略」里搜此人，逐条重新打开。` : '目前还没有被它忽略的消息。'}</p>
        <div className="act-row">
          <span className="spacer" />
          <button className="act act-quiet" onClick={onClose}>不取消</button>
          <button className="act act-primary" onClick={() => { removeMute(mute.id); onDone?.(`已取消自动忽略 ${mute.name}`); onClose() }}>取消自动忽略</button>
        </div>
      </div>
    </div>
  )
}

/** 群组管理每行「成员」菜单里的一项：这个会话里发过言的人（SPEC-messages-9.5） */
export function MemberMuteItem({ msg, onDone, close }: { msg: Message; onDone: (text: string) => void; close: () => void }) {
  const name = contactOf(msg, env.contacts)?.name ?? msg.sender_name
  return (
    <div className="menu-item mute-member" onClick={(e) => e.stopPropagation()}>
      <span className="ellipsis">{name}</span>
      <span className="spacer" />
      <MuteButton msg={msg} onDone={(t) => { onDone(t); close() }} />
    </div>
  )
}

/** 群组管理每行的「成员」菜单：这个会话里发过言的人，每人一项（最近发言的在前） */
export function MembersMenu({ msgs, onDone }: { msgs: Message[]; onDone: (text: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  const seen = new Set<string>()
  const people = [...msgs].sort((a, b) => b.at.localeCompare(a.at)).filter((m) => !seen.has(m.sender_id) && !!seen.add(m.sender_id))
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="mute-members-btn" onClick={() => setOpen(!open)} title="会话里发过言的人：可以把某人（含机器人）设为自动忽略">成员 ▾</button>
      {open && (
        <div className="menu mute-members">
          <div className="menu-label">自动忽略此人的消息</div>
          {people.map((m) => <MemberMuteItem key={m.sender_id} msg={m} onDone={onDone} close={() => setOpen(false)} />)}
        </div>
      )}
    </div>
  )
}

/** 联系人抽屉 IM 渠道下的一行（SPEC-contacts-2.11a）：按联系人、全部会话 */
export function ContactMuteRow({ contact }: { contact: Contact }) {
  const { messages, contacts, ignore: onIgnore } = env
  const list = useMutes()
  const [note, setNote] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [also, setAlso] = useState(false)
  const whole = list.find((m) => m.kind === 'contact' && m.contact_id === contact.id && !m.conversation)
  const t: Target = { kind: 'contact', channel: '', sender_id: '', contact_id: contact.id, conversation: '' }
  const pending = pendingOf(t, messages, contacts)
  return (
    <div className="mute-ct">
      <div className="mute-ct-row">
        <span className={whole ? undefined : 'faint'}>{whole ? `已自动忽略此人的全部消息${ignoredBy(whole.id) ? `（已忽略 ${ignoredBy(whole.id)} 条）` : ''}` : '消息照常收'}</span>
        <span className="spacer" />
        {whole
          ? <button className="act act-quiet" onClick={() => setConfirm(true)}>取消自动忽略</button>
          : <button className="act act-quiet" onClick={() => setConfirm(true)}>自动忽略此人的全部消息</button>}
      </div>
      {note && <div className="muted">{note}</div>}
      {confirm && whole && <UnmuteDialog mute={whole} onClose={() => setConfirm(false)} onDone={setNote} />}
      {confirm && !whole && (
        <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirm(false) }}>
          <div className="qs msg-start mute-dlg" role="dialog" aria-label={`自动忽略 ${contact.name}`}>
            <div className="qs-head"><b>自动忽略 {contact.name}</b></div>
            <p className="muted mute-desc">此人名下全部 IM 身份之后收到的消息直接进「已忽略」：已读、不计未读、不通知，也不触发 SOP 的 IM 流程和 Agent 的 IM 触发。取消后新消息恢复正常。</p>
            <label className={cls('mute-also', !pending.length && 'muted')}>
              <input type="checkbox" checked={also && pending.length > 0} disabled={!pending.length} onChange={(e) => setAlso(e.target.checked)} />
              {pending.length ? `把此人已有的 ${pending.length} 条待处理消息也一并标为忽略` : '此人现在没有待处理消息'}
            </label>
            <div className="act-row">
              <span className="spacer" />
              <button className="act act-quiet" onClick={() => setConfirm(false)}>取消</button>
              <button className="act act-primary" onClick={() => { setNote(addMute(t, contact.name, also ? pending : null, onIgnore)); setConfirm(false) }}>
                {also && pending.length ? `自动忽略，并忽略 ${pending.length} 条` : '自动忽略'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 管理抽屉（SPEC-messages-9.7~9.9） */
export function MutesDrawer({ onClose, onShow }: { onClose: () => void; onShow: (name: string) => void }) {
  const { contacts } = env
  const list = useMutes()
  const [cancel, setCancel] = useState<Mute | null>(null)
  const [note, setNote] = useState('')
  const shell = typeof document !== 'undefined' ? document.querySelector('.shell') : null
  const el = (
    <aside className="drawer ga-drawer" aria-label="自动忽略">
      <div className="drawer-head">
        <span className="drawer-kicker">IM 消息</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={onClose} aria-label="关闭">×</button>
      </div>
      <div className="drawer-body">
        <h2 className="ga-title">自动忽略</h2>
        <p className="ga-desc">这些发信人的消息一收到就进「已忽略」：已读、不计未读、不通知，也不触发 SOP 的 IM 流程和 Agent 的 IM 触发。取消后新消息恢复正常，已忽略的不自动恢复。</p>
        {note && <div className="ga-note">{note}</div>}
        {!list.length ? (
          <div className="empty">
            <div className="empty-title">还没有自动忽略的发信人</div>
            <div className="empty-desc">在消息详情的发信人处、群组管理的「成员」里、联系人页点「自动忽略」</div>
          </div>
        ) : (
          <div className="mute-list">
            {list.map((m) => {
              const n = ignoredBy(m.id)
              return (
                <div key={m.id} className="mute-item">
                  <div className="mute-main">
                    <b className="ellipsis">{m.name}</b>
                    <div className="muted mute-sub"><span className="ellipsis">{whoText(m, contacts)}</span><span>{scopeText(m)}</span></div>
                    <div className="muted mute-sub"><span>{n ? `已自动忽略 ${n} 条` : '还没忽略过消息'}</span><span>{timeAgo(m.created_at)}标记</span></div>
                  </div>
                  <button className="act" onClick={() => onShow(m.name)}>看消息</button>
                  <button className="act act-quiet" onClick={() => setCancel(m)}>取消</button>
                </div>
              )
            })}
          </div>
        )}
      </div>
      {cancel && <UnmuteDialog mute={cancel} onClose={() => setCancel(null)} onDone={setNote} />}
    </aside>
  )
  return shell ? createPortal(el, shell) : el
}
