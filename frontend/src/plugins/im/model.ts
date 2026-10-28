// IM 消息页的纯函数：视图、会话键、按天分段、稍后选项、回不了的原因、@ 解析、渠道显示。照原型 web-next/src/messages.tsx。
import type { Connector, ConnectorDef, DictItem, ImMessage, ImMsgStatus } from '../../core/data'

export type View = 'pending' | 'snoozed' | 'done' | 'ignored' | 'all'
/** '' 全部；mine 与我相关（@我、@所有人、私聊）；at 只看 @我 */
export type Mine = '' | 'mine' | 'at'

/** 状态 seg 里最多放几个状态（不算「全部」） */
export const VIEW_SEG_MAX = 4
/** 列表先渲染这么多条，底部「加载更多」再加这么多 */
export const PAGE = 50

export const RELEVANCE: Record<'me' | 'all' | 'dm', string> = { me: '@我', all: '@所有人', dm: '私聊' }

/** 快捷回复，done 为真的发完同时标为已处理（原型 QUICK_REPLIES） */
export const QUICK_REPLIES: readonly { text: string; done: boolean }[] = [
  { text: '收到，我看一下', done: false },
  { text: '稍后回复你', done: false },
  { text: '已处理，请查看', done: true },
  { text: '这个需求记下了，排期后同步你', done: true },
]

// ---- 处理状态：后端有 msg_status 字典就用它，没有时按原型枚举兜底 ----

export type StatusItem = { key: string; label: string; color: string }
export const MSG_STATUS_DICT = 'msg_status'
const BUILTIN_STATUS: StatusItem[] = [
  { key: 'pending', label: '待处理', color: 'var(--warn)' },
  { key: 'done', label: '已处理', color: 'var(--ok)' },
  { key: 'ignored', label: '已忽略', color: 'var(--faint)' },
]
const MSG_STATUSES: readonly ImMsgStatus[] = ['pending', 'done', 'ignored']

/** 字典条目只认三个内置 key（后端的状态集是固定的），顺序和名字、颜色跟字典走；缺的按内置补在后面 */
export function statusItems(dict: DictItem[] | undefined): StatusItem[] {
  const live = (dict ?? [])
    .filter((i) => !i.archived_at && (MSG_STATUSES as readonly string[]).includes(i.key))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((i) => ({ key: i.key, label: i.label, color: i.color || BUILTIN_STATUS.find((b) => b.key === i.key)!.color }))
  return [...live, ...BUILTIN_STATUS.filter((b) => !live.some((x) => x.key === b.key))]
}

export type StatusView = { items: StatusItem[]; label: (k: string) => string; color: (k: string) => string }
export function statusView(items: StatusItem[]): StatusView {
  return {
    items,
    label: (k) => items.find((i) => i.key === k)?.label ?? k,
    color: (k) => items.find((i) => i.key === k)?.color ?? 'var(--faint)',
  }
}

/** 状态 seg：待处理、稍后 + 字典里的状态 */
export function viewsOf(sv: StatusView): [View, string][] {
  return sv.items.flatMap((i) => (i.key === 'pending' ? [[i.key, i.label], ['snoozed', '稍后']] : [[i.key, i.label]])) as [View, string][]
}

// ---- 视图和筛选 ----

/** 待处理里设了稍后、还没到点的 */
export const isSnoozed = (m: Pick<ImMessage, 'status' | 'snooze_until'>, now = Date.now()) =>
  m.status === 'pending' && !!m.snooze_until && new Date(m.snooze_until).getTime() > now

export function inView(m: ImMessage, v: View, now = Date.now()) {
  if (v === 'all') return true
  if (v === 'pending') return m.status === 'pending' && !isSnoozed(m, now)
  if (v === 'snoozed') return isSnoozed(m, now)
  return m.status === v
}

export const relOk = (m: ImMessage, mine: Mine) => !mine || (mine === 'at' ? m.relevance === 'me' : !!m.relevance)

export const isGroup = (m: ImMessage) => !!m.conversation || m.conversation_kind === 'group'

/** 会话键：认上会话的按会话 id；没认上的群按渠道 + 群编号，私聊按渠道 + 发信人编号 */
export function convKey(m: ImMessage) {
  if (m.conversation_id) return `cv:${m.conversation_id}`
  const ext = m.conversation_external_id || m.conversation
  return isGroup(m) ? `g:${m.channel}|${ext}` : `d:${m.channel}:${m.sender_id}`
}

/** 显示的人名：认上联系人用联系人姓名，否则渠道上的名字 */
export const whoName = (m: ImMessage) => m.contact_name || m.sender_name

export type Filter = { view: View; channel: string; conv: string; unreadOnly: boolean; mine: Mine; q: string }

/** 只按渠道、会话、与我相关筛（seg 上的数字用它，不受搜索和只看未读影响） */
export const baseOk = (m: ImMessage, f: Pick<Filter, 'channel' | 'conv' | 'mine'>) =>
  (!f.channel || m.channel === f.channel) && (!f.conv || convKey(m) === f.conv) && relOk(m, f.mine)

export function filterRows(list: readonly ImMessage[], f: Filter, now = Date.now()) {
  const kw = f.q.trim().toLowerCase()
  return list
    .filter((m) => inView(m, f.view, now) && baseOk(m, f) && (!f.unreadOnly || !m.read)
      && (!kw || [m.text, m.sender_name, m.conversation, m.contact_name].some((v) => v.toLowerCase().includes(kw))))
    .sort((a, b) => b.at.localeCompare(a.at))
}

export type ConvOption = { value: string; group: '群聊' | '私聊'; label: string; channel: string; n: number; pending: number; keywords: string }

/** 会话筛选的选项：当前渠道下出现过的群和私聊，各按待处理数、再按最近一条时间倒序 */
export function convOptions(list: readonly ImMessage[], channel: string, now = Date.now()): ConvOption[] {
  const acc = new Map<string, { m: ImMessage; n: number; pending: number }>()
  for (const m of list) {
    if (channel && m.channel !== channel) continue
    const k = convKey(m)
    const x = acc.get(k) ?? { m, n: 0, pending: 0 }
    x.n += 1
    if (m.at > x.m.at) x.m = m
    if (m.status === 'pending' && !isSnoozed(m, now)) x.pending += 1
    acc.set(k, x)
  }
  const xs = [...acc.entries()].map(([k, x]) => ({
    at: x.m.at,
    opt: {
      value: k, group: isGroup(x.m) ? '群聊' : '私聊', label: (isGroup(x.m) && x.m.conversation) || whoName(x.m) || x.m.conversation_external_id,
      channel: x.m.channel, n: x.n, pending: x.pending, keywords: isGroup(x.m) ? '' : `${x.m.sender_name} ${x.m.sender_id}`,
    } satisfies ConvOption,
  }))
  const by = (a: (typeof xs)[number], b: (typeof xs)[number]) => b.opt.pending - a.opt.pending || b.at.localeCompare(a.at)
  return [...xs.filter((o) => o.opt.group === '群聊').sort(by), ...xs.filter((o) => o.opt.group === '私聊').sort(by)].map((o) => o.opt)
}

/** 列表按天分段 */
export function dayLabel(iso: string, now = new Date()) {
  const t = new Date(iso).getTime()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return t >= start ? '今天' : t >= start - 86400000 ? '昨天' : '更早'
}

/** 稍后：1 小时后、今晚 20:00（现在早于 20:00 才有）、明天 9:00 */
export function snoozeOptions(now = new Date()) {
  const tonight = new Date(now); tonight.setHours(20, 0, 0, 0)
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1); tomorrow.setHours(9, 0, 0, 0)
  return [
    { label: '1 小时后', until: new Date(now.getTime() + 3600000) },
    ...(tonight > now ? [{ label: '今晚 20:00', until: tonight }] : []),
    { label: '明天 9:00', until: tomorrow },
  ]
}

/** 最早一个还没到点的稍后时间；到点要重新算视图 */
export function nextWake(list: readonly ImMessage[], now = Date.now()): number | null {
  let min: number | null = null
  for (const m of list) {
    if (m.status !== 'pending' || !m.snooze_until) continue
    const t = new Date(m.snooze_until).getTime()
    if (t > now && (min === null || t < min)) min = t
  }
  return min
}

/** 回不了的原因；null 表示能回。connector_id 为空（演练用的假适配器）时不查连接器，由后端判 */
export function replyBlocker(m: Pick<ImMessage, 'connector_id'>, connectors: readonly Connector[] | undefined): string | null {
  if (!m.connector_id || !connectors) return null
  const conn = connectors.find((c) => c.id === m.connector_id)
  if (!conn) return '渠道已删除，这条消息只能查看'
  if (conn.status === 'error') return `连接器「${conn.name}」异常，修好之前发不出去`
  if (conn.status === 'paused') return `连接器「${conn.name}」已暂停`
  if (conn.status === 'disconnected') return `连接器「${conn.name}」已断开，去设置里重新连接`
  if (conn.status === 'connecting') return `连接器「${conn.name}」正在连接`
  if (conn.direction === 'receive') return `连接器「${conn.name}」设置为只收消息`
  return null
}

// ---- 正文里的 @ ----

/** @所有人 一类的称呼，和后端 relevance 的口径一致 */
export const ALL_HANDLES = ['所有人', '全体成员', 'all', 'here', 'channel', 'everyone']
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export type MentionPart = string | { name: string; hot: boolean }

/** 正文切成文字和 @ 片段；hot 是 @所有人 或 @我（myHandles，适配器给的「我」的称呼） */
export function mentionParts(text: string, myHandles: readonly string[] = ['我']): MentionPart[] {
  const known = [...myHandles, ...ALL_HANDLES].filter(Boolean).map(esc).join('|')
  // 英文名允许带一个空格（@Lin Yuan），所以先按已知名字整串匹配，再退回到单词
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

// ---- 渠道 ----

export type Channel = { key: string; label: string; color: string }
// 后端连接器定义里没有这个渠道时的兜底显示（原型 IM_CHANNELS 的顺序和颜色）
const CHANNELS: Channel[] = [
  { key: 'wechat', label: '微信', color: '#07c160' },
  { key: 'lark', label: '飞书', color: '#3370ff' },
  { key: 'slack', label: 'Slack', color: '#611f69' },
  { key: 'telegram', label: 'Telegram', color: '#229ed9' },
  { key: 'qq', label: 'QQ', color: '#12b7f5' },
]

/** 渠道表：连接器定义（category=im）优先，其次内置表；顺序按内置表，新渠道排在后面 */
export function channelTable(defs: readonly ConnectorDef[] | undefined): Channel[] {
  const live = (defs ?? []).filter((d) => d.category === 'im').map((d) => ({ key: d.tool, label: d.label || d.tool, color: d.color }))
  const out = CHANNELS.map((c) => {
    const d = live.find((x) => x.key === c.key)
    return d ? { ...c, label: d.label, color: d.color || c.color } : c
  })
  for (const d of live) if (!out.some((c) => c.key === d.key)) out.push({ ...d, color: d.color || 'var(--faint)' })
  return out
}

export const channelOf = (table: readonly Channel[], key: string): Channel =>
  table.find((c) => c.key === key) ?? { key, label: key, color: 'var(--faint)' }

/** 用到的渠道：有该渠道的连接器或消息的，按渠道表顺序 */
export function usedChannels(table: readonly Channel[], list: readonly ImMessage[], connectors: readonly Connector[] | undefined) {
  const keys = new Set([...list.map((m) => m.channel), ...(connectors ?? []).map((c) => c.tool)])
  const known = table.filter((c) => keys.has(c.key))
  const extra = [...new Set(list.map((m) => m.channel))].filter((k) => !table.some((c) => c.key === k)).map((k) => channelOf(table, k))
  return [...known, ...extra]
}

// ---- 时间 ----

export function timeAgo(iso: string, now = Date.now()) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`
  return new Date(iso).toLocaleDateString('zh-CN')
}

/** M/D HH:mm */
export const shortTime = (iso: string) =>
  new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** 转任务的默认标题：正文压掉空白后的前 40 字（同后端） */
export const taskTitleOf = (m: Pick<ImMessage, 'text' | 'contact_name' | 'sender_name'>) =>
  m.text.replace(/\s+/g, ' ').trim().slice(0, 40) || `来自 ${m.contact_name || m.sender_name} 的消息`

/** 小于 1024 显示 N B，小于 1MB 显示整数 N KB，否则一位小数 N.N MB；没有大小返回空串 */
export function fmtSize(n?: number) {
  if (n === undefined || n === null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
