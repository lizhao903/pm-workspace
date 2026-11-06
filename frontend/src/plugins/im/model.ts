// IM 消息页的纯函数：视图、会话键、按天分段、稍后选项、回不了的原因、@ 解析、渠道显示。照原型 web-next/src/messages.tsx。
import type { Connector, ConnectorDef, DictItem, ImMessage, ImMsgStatus, ImTaskReply } from '../../core/data'
import { matchOption } from '../../core/ui/searchMatch'

export type View = 'pending' | 'snoozed' | 'done' | 'ignored' | 'expired' | 'all'
/** '' 全部；mine 与我相关（@我、@所有人、私聊）；at 只看 @我 */
export type Mine = '' | 'mine' | 'at'

/** 状态 seg 里最多放几个状态（不算「全部」） */
export const VIEW_SEG_MAX = 4
/** 列表先渲染这么多条，底部「加载更多」再加这么多 */
export const PAGE = 50

export const RELEVANCE: Record<'me' | 'all' | 'dm', string> = { me: '@我', all: '@所有人', dm: '私聊' }

/** 内置的快捷回复（同后端没设过时回的那四条），设置取回来之前用；done 为真的发完同时标为已处理（原型 QUICK_REPLIES） */
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
  // IM-07：后台按过期天数标的；字典里还没有这一项时补在最后
  { key: 'expired', label: '已过期', color: '#868e96' },
]
const MSG_STATUSES: readonly ImMsgStatus[] = ['pending', 'done', 'ignored', 'expired']

/** 字典条目只认四个内置 key（后端的状态集是固定的），顺序和名字、颜色跟字典走；缺的按内置补在后面 */
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

/** project：'' 全部项目；PROJECT_NONE 未归项目；其余是项目 id（TSK-0723） */
export type Filter = { view: View; channel: string; conv: string; unreadOnly: boolean; mine: Mine; q: string; project?: string }

/** 群组标签里「私聊」合成一个标签，键是 dm:<渠道> */
export const dmTab = (channel: string) => `dm:${channel}`

/** 会话筛选：空串不筛；dm:<渠道> 是这个渠道的全部私聊；其余按会话键 */
export const convOk = (m: ImMessage, conv: string) =>
  !conv || (conv.startsWith('dm:') ? !isGroup(m) && m.channel === conv.slice(3) : convKey(m) === conv)

/** 只按渠道、会话、与我相关、项目筛（seg 上的数字用它，不受搜索和只看未读影响） */
export const baseOk = (m: ImMessage, f: Pick<Filter, 'channel' | 'conv' | 'mine' | 'project'>) =>
  (!f.channel || m.channel === f.channel) && convOk(m, f.conv) && relOk(m, f.mine) && projectOk(m, f.project)

// ---- 项目筛选（TSK-0723） ----

/** 项目筛选的「未归项目」，同后端 GET /api/im/messages?project_id=none */
export const PROJECT_NONE = 'none'

/** 按项目筛：口径同后端读出的 project_id——消息自己归的项目优先，其次所在会话的默认项目，项目删了按没归；
 * 未归项目是两者都没有的（读出 project_id 为 null） */
export const projectOk = (m: Pick<ImMessage, 'project_id'>, project = '') =>
  !project || (project === PROJECT_NONE ? !m.project_id : m.project_id === project)

/** 各项目在当前视图（状态、渠道、会话、与我相关、未读、搜索，不算项目本身）下的消息数；未归项目记在 PROJECT_NONE 下 */
export function projectCounts(list: readonly ImMessage[], f: Filter, now = Date.now()) {
  const out = new Map<string, number>()
  for (const m of filterRows(list, { ...f, project: '' }, now)) {
    const k = m.project_id ?? PROJECT_NONE
    out.set(k, (out.get(k) ?? 0) + 1)
  }
  return out
}

export type ProjectOption = { value: string; label: string; group?: string; hint: string }

/** 项目下拉的选项：先「未归项目」，再没归档、没删的项目，按当前视图下的条数、再按名字排 */
export function projectFilterOptions(
  projects: readonly { id: string; title: string; archived_at: string | null; deleted_at: string | null }[],
  counts: ReadonlyMap<string, number>,
): ProjectOption[] {
  const n = (k: string) => counts.get(k) ?? 0
  const live = projects.filter((p) => !p.archived_at && !p.deleted_at)
    .map((p) => ({ value: p.id, label: p.title, group: '项目', hint: `${n(p.id)} 条` }))
    .sort((a, b) => n(b.value) - n(a.value) || a.label.localeCompare(b.label, 'zh-CN'))
  return [{ value: PROJECT_NONE, label: '未归项目', hint: `${n(PROJECT_NONE)} 条` }, ...live]
}

export function filterRows(list: readonly ImMessage[], f: Filter, now = Date.now()) {
  const kw = f.q.trim().toLowerCase()
  return list
    .filter((m) => inView(m, f.view, now) && baseOk(m, f) && (!f.unreadOnly || !m.read)
      && (!kw || [m.text, m.sender_name, m.conversation, m.contact_name, m.sender_id].some((v) => v.toLowerCase().includes(kw))))
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

// ---- 群组标签（选了渠道后按群组归总） ----

/** 群组标签最多直接摆几个，其余收进「更多」 */
export const GROUP_TAB_MAX = 8

export type ConvTab = { value: string; label: string; pending: number; n: number }
/** moreGroups 是「更多」里群的个数（「更多」里另有单个私聊） */
export type ConvTabs = { groups: ConvTab[]; dm: ConvTab | null; more: ConvOption[]; moreGroups: number }

/**
 * 选了渠道后列表上方的群组标签：这个渠道下有消息的群，按消息条数、再按群名排（不按待处理数排，处理消息时标签不跳）；
 * 私聊合成一个「私聊」标签，界面上紧跟「全部」（群多时也看得到）；超过 GROUP_TAB_MAX 的群和单个私聊收进「更多」，从那里还能只看某一个私聊。
 * 数字是待处理（不含稍后），不受状态、与我相关、搜索影响
 */
export function convTabs(list: readonly ImMessage[], channel: string, now = Date.now()): ConvTabs {
  if (!channel) return { groups: [], dm: null, more: [], moreGroups: 0 }
  const opts = convOptions(list, channel, now)
  const groups = opts.filter((o) => o.group === '群聊')
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, 'zh-CN'))
  const dms = opts.filter((o) => o.group === '私聊')
  const tab = (o: ConvOption): ConvTab => ({ value: o.value, label: o.label, pending: o.pending, n: o.n })
  const dm = dms.length
    ? { value: dmTab(channel), label: '私聊', pending: dms.reduce((a, o) => a + o.pending, 0), n: dms.reduce((a, o) => a + o.n, 0) }
    : null
  const rest = groups.slice(GROUP_TAB_MAX)
  return { groups: groups.slice(0, GROUP_TAB_MAX).map(tab), dm, more: [...rest, ...dms], moreGroups: rest.length }
}

/** 会话键里的内核会话 id（cv:<id>）；没登记的会话、私聊合并标签为 null，设不了默认项目 */
export const convIdOf = (conv: string) => (conv.startsWith('cv:') ? conv.slice(3) : null)

// ---- 批量处理（PR-03） ----

/** 还没处理的：待处理（含稍后）和已过期（IM-07），能标已处理、忽略 */
export const isOpen = (m: Pick<ImMessage, 'status'>) => m.status === 'pending' || m.status === 'expired'

/** 能勾选的：还没处理的才有批量动作（后端按 id 批量时已过期的也改） */
export const canPick = isOpen

/** 勾选里还在当前列表、还能处理的；筛选一变、处理掉的自然不算 */
export const pickedRows = (rows: readonly ImMessage[], sel: ReadonlySet<string>) => rows.filter((m) => sel.has(m.id) && canPick(m))

/** 勾选一行：有就去掉，没有就加上 */
export function togglePick(sel: ReadonlySet<string>, id: string) {
  const n = new Set(sel)
  if (n.has(id)) n.delete(id)
  else n.add(id)
  return n
}

export type ConvBatch = { n: number; input: { conversation_id: string; before: string } | { ids: string[] } }

/** 「这个会话全部标为已处理」：这个会话里的待处理（不含稍后，同待处理视图），不受与我相关、搜索、未读筛选影响（项目筛选由调用方先筛 list、带 byIds）。
 * 登记过的会话按会话 + 最近一条的时间点交给后端，后面新到的不动；没登记的按 id */
export function convBatch(list: readonly ImMessage[], conv: string, now = Date.now(), byIds = false): ConvBatch | null {
  if (!conv) return null
  const xs = list.filter((m) => convOk(m, conv) && inView(m, 'pending', now))
  if (!xs.length) return null
  // byIds：选了项目时只处理这个会话里归到这个项目的，按会话交给后端会连别的项目的一起标掉（TSK-0723）
  if (conv.startsWith('cv:') && !byIds) {
    const before = xs.reduce((a, m) => (m.at > a ? m.at : a), xs[0].at)
    return { n: xs.length, input: { conversation_id: conv.slice(3), before } }
  }
  // 不截断：超过后端一次的上限时 useImBatch 自动分批（TSK-0492）
  return { n: xs.length, input: { ids: xs.map((m) => m.id) } }
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

/** 连接器异常时回复框上方的提示：异常多半是收消息那侧的，照样能发，发不出去会记成发送失败 */
export function replyWarning(m: Pick<ImMessage, 'connector_id'>, connectors: readonly Connector[] | undefined): string | null {
  const conn = m.connector_id ? connectors?.find((c) => c.id === m.connector_id) : undefined
  if (conn?.status !== 'error') return null
  return `连接器「${conn.name}」异常${conn.error ? `：${conn.error}` : ''}。仍可尝试发送，发不出去会显示原因`
}

/** 回不了的原因；null 表示能回。连接器异常不算（见 replyWarning）。connector_id 为空（演练用的假适配器）时不查连接器，由后端判 */
export function replyBlocker(m: Pick<ImMessage, 'connector_id'>, connectors: readonly Connector[] | undefined): string | null {
  if (!m.connector_id || !connectors) return null
  const conn = connectors.find((c) => c.id === m.connector_id)
  if (!conn) return '渠道已删除，这条消息只能查看'
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

// ---- 认人（IM-05）：把发信人关联到联系人 ----

type Candidate = { id: string; name: string; company: string; title: string }

/** 名字和发信人有多像：0 一样、1 互相包含、2 有一个词对上、3 不像 */
export function nameCloseness(name: string, sender: string): number {
  const n = name.trim().toLowerCase()
  const s = sender.trim().toLowerCase()
  if (!n || !s) return 3
  if (n === s) return 0
  if (n.includes(s) || s.includes(n)) return 1
  const words = s.split(/[\s._\-@()（）]+/).filter((w) => w.length >= 2)
  return words.some((w) => n.includes(w)) ? 2 : 3
}

/** 候选联系人：按搜索词筛（姓名、公司、职位），和发信人名字相近的排前，同样近的按姓名；exclude 是现在挂着的人 */
export function contactCandidates<C extends Candidate>(list: C[], sender: string, q: string, exclude?: string | null): C[] {
  return list
    .filter((c) => c.id !== exclude && matchOption({ label: c.name, hint: `${c.company} ${c.title}` }, q))
    .map((c) => ({ c, k: nameCloseness(c.name, sender) }))
    .sort((a, b) => a.k - b.k || a.c.name.localeCompare(b.c.name, 'zh-CN'))
    .map((x) => x.c)
}

/** 挂身份时的昵称、账号：后端限 100 字 */
export const clip100 = (s: string) => Array.from(s.trim()).slice(0, 100).join('')

/** 转任务（SPEC-messages-2.50）：勾了回复但回执没发起时给出的提示；没勾、发起了都不提示 */
export function replyNoteOf(asked: boolean, reply: ImTaskReply | undefined): string | undefined {
  if (!asked || !reply || reply.enabled) return undefined
  return `任务建好了，但${reply.note || '回执流程没发起'}`
}
