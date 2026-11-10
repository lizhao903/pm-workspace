// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 沟通标签（SPEC-projects-4，PJ-02b）的纯函数：渠道名、待回复口径、消息筛选、会话显示名、绑定面板的候选、正文 @ 切分。
// 照原型 web-next/src/projecttabs.tsx 的 CommsTab；插件之间不能 import，IM 插件里的同类小函数这里各写一份，口径保持一致。
import type { Contact, Conversation, ConnectorDef, DictItem, Identity, ImMessage, ProjectConversation } from '../../core/data'

/** 搜索口径同 core/ui 的 matchOption：按空格切词，每个词都要命中；这里是纯函数文件，不引 UI 包 */
function matchOption(o: { label: string; keywords?: string; hint?: string }, q: string) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const hay = `${o.label} ${o.keywords ?? ''} ${o.hint ?? ''}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}

/** 消息先渲染这么多条，每点一次多这么多（SPEC-projects-4.12） */
export const MSG_PAGE = 50
/** 绑定面板没搜时群聊、私聊各露几个（SPEC-projects-4.4、4.5） */
export const DM_PEEK = 8
/** 搜了最多列几个 */
export const SEARCH_MAX = 50
/** IM 消息插件的 id，沟通标签靠它的消息接口 */
export const IM_PLUGIN = 'im'

// ---- 渠道名：连接器定义（category=im）优先，没有时按原型 IM_CHANNELS 兜底 ----

const CHANNEL_LABELS: Record<string, string> = { wechat: '微信', lark: '飞书', slack: 'Slack', telegram: 'Telegram', qq: 'QQ' }

export function channelLabeler(defs: readonly ConnectorDef[] | undefined): (key: string) => string {
  const live = new Map((defs ?? []).filter((d) => d.category === 'im' && d.label).map((d) => [d.tool, d.label]))
  return (key) => live.get(key) ?? CHANNEL_LABELS[key] ?? key
}

// ---- 处理状态：名字跟字典 msg_status 走，没有时按内置兜底 ----

const STATUS_LABELS: Record<string, string> = { pending: '待处理', done: '已处理', ignored: '已忽略', expired: '已过期' }

export function statusLabeler(items: readonly DictItem[] | undefined): (key: string) => string {
  const live = new Map((items ?? []).filter((i) => !i.archived_at).map((i) => [i.key, i.label]))
  return (key) => live.get(key) || STATUS_LABELS[key] || key
}

/** 待处理里设了稍后、还没到点的 */
export const isSnoozed = (m: Pick<ImMessage, 'status' | 'snooze_until'>, now = Date.now()) =>
  m.status === 'pending' && !!m.snooze_until && new Date(m.snooze_until).getTime() > now

/** 项目里的「待回复」：与我相关（@我、@所有人、私聊）、待处理且不在稍后里；其余群消息只在 IM 消息页处理（B-01） */
export const awaitingReply = (m: Pick<ImMessage, 'status' | 'snooze_until' | 'relevance'>, now = Date.now()) =>
  !!m.relevance && m.status === 'pending' && !isSnoozed(m, now)

/** 发信人：联系人姓名，认不上时 sender_name */
export const whoName = (m: Pick<ImMessage, 'contact_name' | 'sender_name'>) => m.contact_name || m.sender_name

/** 每个会话的待回复数 */
export function pendingByConversation(list: readonly ImMessage[], now = Date.now()): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of list) if (m.conversation_id && awaitingReply(m, now)) out.set(m.conversation_id, (out.get(m.conversation_id) ?? 0) + 1)
  return out
}

// ---- 消息筛选（B-10）：与我相关、搜索，口径同 IM 消息页 ----

/** 「全部消息」「与我相关」（@我、@所有人、私聊）「只看 @我」 */
export type Mine = '' | 'mine' | 'at'

export const relOk = (m: Pick<ImMessage, 'relevance'>, mine: Mine) => !mine || (mine === 'at' ? m.relevance === 'me' : !!m.relevance)

/** 搜正文、发信人、联系人姓名、群名；按空格切词，每个词都要命中，不区分大小写 */
export function textOk(m: Pick<ImMessage, 'text' | 'sender_name' | 'contact_name' | 'conversation'>, q: string) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = `${m.text} ${m.sender_name} ${m.contact_name} ${m.conversation}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}

export type MsgFilter = { conv: string; mine: Mine; q: string }

/** 右栏要列的消息：按渠道、与我相关、搜索筛，顺序不动（项目消息已按时间倒序） */
export const filterMessages = (list: readonly ImMessage[], f: MsgFilter) =>
  list.filter((m) => (!f.conv || m.conversation_id === f.conv) && relOk(m, f.mine) && textOk(m, f.q))

/** 「只看 @我」后面的数：@我、待回复的 */
export const atMeCount = (list: readonly ImMessage[], now = Date.now()) =>
  list.filter((m) => m.relevance === 'me' && awaitingReply(m, now)).length

/** 行内「已处理」只给待处理的（含稍后的），和 IM 消息页一样 */
export const canMarkDone = (m: Pick<ImMessage, 'status'>) => m.status === 'pending'

// ---- 会话显示名：群用群名；私聊按成员认联系人 ----

export type People = {
  /** 身份 id -> 联系人 id */
  identityOwner: Map<string, string>
  contacts: Map<string, Contact>
}

export function peopleOf(identities: readonly Identity[] | undefined, contacts: readonly Contact[] | undefined): People {
  return {
    identityOwner: new Map((identities ?? []).map((i) => [i.id, i.stakeholder_id])),
    contacts: new Map((contacts ?? []).map((c) => [c.id, c])),
  }
}

/** 私聊会话对面的联系人：成员里第一个认得上联系人的身份 */
export function directContact(conv: Pick<Conversation, 'members'> | undefined, people: People): Contact | undefined {
  for (const idn of conv?.members ?? []) {
    const c = people.contacts.get(people.identityOwner.get(idn) ?? '')
    if (c) return c
  }
  return undefined
}

export const isDirect = (kind: string) => kind === 'direct'

/** 渠道列表、绑定面板上的名字；私聊认不上联系人时用会话名、编号 */
export function convLabel(c: ProjectConversation['conversation'], full: Conversation | undefined, people: People): string {
  if (!isDirect(c.kind)) return c.name || c.external_id
  return directContact(full, people)?.name || c.name || c.external_id || '私聊'
}

// ---- 绑定面板的候选（SPEC-projects-4.4 到 4.6） ----

export type GroupCand = { conv: Conversation; label: string; channel: string; lastAt: string }
/**
 * 私聊候选是联系人的一个 IM 身份：conv 是这个身份已有的私聊会话，没有时绑定前按身份建一个。
 * 联系人一个 IM 身份都没有时 identity 为空，这一项置灰
 */
export type DirectCand = { key: string; label: string; contact: Contact; identity?: Identity; channel: string; conv?: Conversation }
export type BindPool<T> = {
  /** 露出来的 */
  shown: T[]
  /** 去掉已绑后的全部候选 */
  pool: number
  /** 搜中的 */
  matched: number
}

/** 每个会话最近一条消息的时间 */
export function lastMessageAt(list: readonly ImMessage[] | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of list ?? []) if (m.conversation_id && (out.get(m.conversation_id) ?? '') < m.at) out.set(m.conversation_id, m.at)
  return out
}

/** 群：去掉已绑的，最近有消息的在前，没收到消息的排最后；没搜露 DM_PEEK 个，搜了最多 SEARCH_MAX 个 */
export function groupCandidates(convs: readonly Conversation[], bound: ReadonlySet<string>, lastAt: ReadonlyMap<string, string>,
  chLabel: (k: string) => string, q: string): BindPool<GroupCand> {
  const pool = convs.filter((c) => !isDirect(c.kind) && !bound.has(c.id))
    .map((c) => ({ conv: c, label: c.name || c.external_id, channel: c.channel, lastAt: lastAt.get(c.id) ?? '' }))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
  const matched = pool.filter((x) => matchOption({ label: x.label, hint: chLabel(x.channel) }, q))
  return { shown: matched.slice(0, q.trim() ? SEARCH_MAX : DM_PEEK), pool: pool.length, matched: matched.length }
}

/** 私聊候选的整体情况，空状态按它写（E-01） */
export type DirectPool = BindPool<DirectCand> & {
  /** 联系人总数 */
  contacts: number
  /** 能绑的（有 IM 身份）候选数 */
  bindable: number
}

/**
 * 私聊（SPEC-projects-4.5）：按联系人列，每个 IM 身份一项，私聊会话已绑的去掉；没填 IM 编号的联系人一项、置灰。
 * 按姓名、公司、职位搜；能绑的在前，同类里按最近联系倒序；没搜露 DM_PEEK 个
 */
export function directCandidates(contacts: readonly Contact[], identities: readonly Identity[], convs: readonly Conversation[],
  bound: ReadonlySet<string>, q: string): DirectPool {
  // 身份 -> 私聊会话：成员里有它的，没有时按编号对（对方的私聊编号就是身份编号，如 Telegram）
  const dmByMember = new Map<string, Conversation>()
  const dmByExt = new Map<string, Conversation>()
  for (const c of convs) {
    if (!isDirect(c.kind)) continue
    for (const m of c.members) if (!dmByMember.has(m)) dmByMember.set(m, c)
    dmByExt.set(`${c.channel}\u0000${c.external_id}`, c)
  }
  const byOwner = new Map<string, Identity[]>()
  for (const i of identities) byOwner.set(i.stakeholder_id, [...(byOwner.get(i.stakeholder_id) ?? []), i])
  const pool: DirectCand[] = []
  for (const contact of contacts) {
    const ids = byOwner.get(contact.id) ?? []
    if (!ids.length) {
      pool.push({ key: `none:${contact.id}`, label: contact.name, contact, channel: '' })
      continue
    }
    for (const identity of ids) {
      const conv = dmByMember.get(identity.id) ?? dmByExt.get(`${identity.channel}\u0000${identity.external_id}`)
      if (conv && bound.has(conv.id)) continue
      pool.push({ key: `idn:${identity.id}`, label: contact.name, contact, identity, channel: identity.channel, conv })
    }
  }
  const recent = (a: DirectCand, b: DirectCand) =>
    Number(!a.identity) - Number(!b.identity) || (b.contact.last_contact_at ?? '').localeCompare(a.contact.last_contact_at ?? '')
  const matched = (q.trim() ? pool.filter((x) => matchOption({ label: x.label, hint: x.contact.company, keywords: x.contact.title }, q)) : pool)
    .sort(recent)
  return {
    shown: matched.slice(0, q.trim() ? SEARCH_MAX : DM_PEEK), pool: pool.length, matched: matched.length,
    contacts: contacts.length, bindable: pool.filter((x) => x.identity).length,
  }
}

/** 私聊没有能露的候选时写什么（SPEC-projects-4.18）；有候选但都没填 IM 编号时另写一行提示 */
export function directEmptyText(p: Pick<DirectPool, 'shown' | 'contacts' | 'pool'>, searching: boolean): string {
  if (p.shown.length) return ''
  if (searching) return '没有匹配的联系人'
  if (!p.contacts) return '还没有联系人'
  return '联系人都已经绑过了'
}

/** 私聊候选没填 IM 编号时的说明 */
export const NO_IDENTITY_HINT = '先在联系人里填 IM 编号'

// ---- 正文里的 @，口径同 IM 消息页 ----

/** @所有人 一类的称呼，和后端 relevance 的口径一致 */
const ALL_HANDLES = ['所有人', '全体成员', 'all', 'here', 'channel', 'everyone']
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export type MentionPart = string | { name: string; hot: boolean }

/** 正文切成文字和 @ 片段；hot 是 @所有人 或 @我 */
export function mentionParts(text: string, myHandles: readonly string[] = ['我']): MentionPart[] {
  const known = [...myHandles, ...ALL_HANDLES].filter(Boolean).map(esc).join('|')
  const re = new RegExp(`@(${known ? `${known}|` : ''}[A-Z][a-z]+ [A-Z][a-z]+|[\\w一-龥.-]+)`, 'g')
  const out: MentionPart[] = []
  let last = 0
  for (const x of text.matchAll(re)) {
    if (x.index > last) out.push(text.slice(last, x.index))
    out.push({ name: x[1], hot: myHandles.includes(x[1]) || ALL_HANDLES.includes(x[1]) })
    last = x.index + x[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

// ---- 概览、标签红点、干系人共用项目消息（SPEC-projects-2.3、3.1、3.2、6.7） ----

/** 待回复条数，口径同 awaitingReply（不含稍后） */
export const awaitingCount = (list: readonly ImMessage[], now = Date.now()) => list.filter((m) => awaitingReply(m, now)).length

/** 每个联系人在这些消息里最近的一条：先认消息上的 stakeholder_id，没有时按 IM 身份对上联系人 */
export function latestByContact(list: readonly ImMessage[], identityOwner: ReadonlyMap<string, string> = new Map()): Map<string, ImMessage> {
  const out = new Map<string, ImMessage>()
  for (const m of list) {
    const c = m.stakeholder_id || (m.identity_id ? identityOwner.get(m.identity_id) : undefined)
    if (c && (out.get(c)?.at ?? '') < m.at) out.set(c, m)
  }
  return out
}

/** 正文前 n 个字，超出加省略号（SPEC-projects-6.7） */
export const snippet = (text: string, n = 14) => {
  const cs = Array.from(text.replace(/\s+/g, ' ').trim())
  return cs.length > n ? `${cs.slice(0, n).join('')}…` : cs.join('')
}

/** 附件大小：B、KB、MB */
export const fmtSize = (n?: number) => (n === undefined || n === null ? ''
  : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
