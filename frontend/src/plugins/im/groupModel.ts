// 合并显示（IM 消息页）：同一个私聊合成一行、群里同一人连发合成一行、同会话同人同正文的重复消息合成一行。
// 只是展示：库里的消息不动，状态筛选、计数、勾选、批量都还是按一条条消息算，一组只是把几条消息摆在一行。
// 分组在前端算：列表接口按页拉完全部消息放在一份缓存里（core/data/im.ts），「连发」「插话」要看整段会话（含筛掉的），
// 前端手里正好有全部；渲染时的「加载更多」只截显示的行，不影响分组。
// 消息列回复（0010，Slack 在消息列里回复的）不参与上面三种合并，免得两种分组叠加：它们归到原消息那一行（nestThreads），列表上不显示，只在原消息行上标「消息列 N 条未读回复」，
// 原消息还没收到的按普通行显示、标「消息列回复」。
import type { ImMessage } from '../../core/data'
import { canPick, convKey, isGroup, isOpen, shortTime, whoName } from './model'

/** 群里同一人连发：相邻两条间隔不超过这么久才算一段 */
export const BURST_GAP_MS = 10 * 60_000
/** 重复消息：同会话同人同正文，和这组最近一条相隔不超过这么久才合（隔天又说一遍「好的」不算刷屏） */
export const DUP_WINDOW_MS = 24 * 3600_000
/** 合并显示的开关记在本机（每个浏览器各记各的） */
export const MERGE_KEY = 'im.merge'

/** single 单条；dm 一个私聊；burst 群里同一人连发；dup 内容相同的重复消息 */
export type GroupKind = 'single' | 'dm' | 'burst' | 'dup'

export type Cluster = {
  key: string
  kind: GroupKind
  /** 这组在全部消息里的成员，按时间正序（抽屉里按它显示整段） */
  all: ImMessage[]
}

export type Clusters = { of: Map<string, string>; byKey: Map<string, Cluster> }

const normText = (t: string) => t.replace(/\s+/g, ' ').trim()
const ms = (iso: string) => new Date(iso).getTime()

/**
 * 按全部消息分组（不看筛选）：私聊按会话一组；群里先按「同一人连发、中间没人插话、相邻不超过 10 分钟」切段，
 * 再把同会话同人同正文、24 小时内的重复消息并进同一组（机器人刷屏时中间夹着别人的话也能合上）。
 * 组的 key：私聊是 dm:<会话键>，其余是 grp:<组里最早一条的 id>，同一份数据算出来不变，地址里能记。
 */
export function clusterMessages(list: readonly ImMessage[]): Clusters {
  const byConv = new Map<string, ImMessage[]>()
  const of = new Map<string, string>()
  const byKey = new Map<string, Cluster>()
  for (const m of list) {
    if (m.thread) {
      // 消息列回复各自一组（单条），归到原消息那一行由 nestThreads 管
      const key = `grp:${m.id}`
      byKey.set(key, { key, kind: 'single', all: [m] })
      of.set(m.id, key)
      continue
    }
    const k = convKey(m)
    const xs = byConv.get(k)
    if (xs) xs.push(m)
    else byConv.set(k, [m])
  }
  for (const [ck, xs0] of byConv) {
    const xs = [...xs0].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    if (!isGroup(xs[0])) {
      const key = `dm:${ck}`
      byKey.set(key, { key, kind: xs.length > 1 ? 'dm' : 'single', all: xs })
      for (const m of xs) of.set(m.id, key)
      continue
    }
    // 并查集：连发一段、重复一组各自连起来
    const parent = xs.map((_, i) => i)
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
    const union = (a: number, b: number) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb) }
    for (let i = 1; i < xs.length; i++) {
      if (xs[i].sender_id === xs[i - 1].sender_id && ms(xs[i].at) - ms(xs[i - 1].at) <= BURST_GAP_MS) union(i, i - 1)
    }
    const lastDup = new Map<string, number>()
    xs.forEach((m, i) => {
      const t = normText(m.text)
      if (!t) return
      const dk = `${m.sender_id}\u0000${t}`
      const j = lastDup.get(dk)
      if (j !== undefined && ms(m.at) - ms(xs[j].at) <= DUP_WINDOW_MS) union(i, j)
      lastDup.set(dk, i)
    })
    const groups = new Map<number, ImMessage[]>()
    xs.forEach((m, i) => {
      const r = find(i)
      const g = groups.get(r)
      if (g) g.push(m)
      else groups.set(r, [m])
    })
    for (const all of groups.values()) {
      const key = `grp:${all[0].id}`
      const same = all.every((m) => normText(m.text) === normText(all[0].text))
      byKey.set(key, { key, kind: all.length === 1 ? 'single' : same ? 'dup' : 'burst', all })
      for (const m of all) of.set(m.id, key)
    }
  }
  return { of, byKey }
}

/** 列表上的一行：一条消息，或合并的一组 */
export type Row = {
  key: string
  kind: GroupKind
  /** 这一行里最新的一条（时间、头像、回复按它） */
  head: ImMessage
  /** 这一行里筛得出来的消息，按时间倒序（勾选、批量按它们） */
  items: ImMessage[]
  /** 这组的全部消息，按时间正序；不合并时就是这一条 */
  all: ImMessage[]
  /** 归到这一行的消息列（nestThreads）：这一行里的原消息和筛得出来的消息列回复（列表上不显示，只用来标小标、排序） */
  threads?: ThreadBlock[]
  /** 原消息自己不在筛选结果里（比如已处理），只因消息列有新回复才显示：变淡，不能勾 */
  faded?: boolean
}

/** 一个消息列：原消息和筛得出来的消息列回复（按时间正序） */
export type ThreadBlock = { parent: ImMessage; replies: ImMessage[] }

/**
 * 把筛好的消息（按时间倒序）摆成行：merge 为假时一条一行；为真时同组的并成一行，行的位置按组里最新一条（筛得出来的）。
 * 只剩一条筛得出来的也照样是这一组的行（点开能看整段），kind 仍按整组算
 */
export function toRows(rows: readonly ImMessage[], clusters: Clusters, merge: boolean): Row[] {
  if (!merge) return rows.map((m) => ({ key: m.id, kind: 'single', head: m, items: [m], all: [m] }))
  const out: Row[] = []
  const at = new Map<string, Row>()
  for (const m of rows) {
    const k = clusters.of.get(m.id)
    const c = k ? clusters.byKey.get(k) : undefined
    if (!c || c.kind === 'single') { out.push({ key: m.id, kind: 'single', head: m, items: [m], all: [m] }); continue }
    const r = at.get(c.key)
    if (r) { r.items.push(m); continue }
    const n: Row = { key: c.key, kind: c.kind, head: m, items: [m], all: c.all }
    at.set(c.key, n)
    out.push(n)
  }
  return out
}

/** 是不是合并的一组（一条的不算） */
export const isMerged = (r: Pick<Row, 'kind'>) => r.kind !== 'single'

/** 行上的条数小标：私聊、连发是「N 条」，重复是「重复 N 次」；按这一行筛得出来的条数，一条时不标 */
export function countLabel(r: Row): string {
  const n = r.items.length
  if (n < 2) return ''
  return r.kind === 'dup' ? `重复 ${n} 次` : `${n} 条`
}

/** 行上的预览：连发按时间顺序拼起来；重复只给一遍正文；私聊给最新一条 */
export function previewText(r: Row): string {
  if (r.kind === 'burst') return [...r.items].reverse().map((m) => normText(m.text)).filter(Boolean).join(' / ')
  return r.head.text
}

/** 这一行里还没处理的（待处理含稍后、已过期），整组标已处理、忽略按它们 */
export const openItems = (r: Pick<Row, 'items'>) => r.items.filter(isOpen)

/** 勾选状态：all 全选了、some 选了一部分、none 没选；能勾的才算 */
export function pickState(r: Pick<Row, 'items'>, sel: ReadonlySet<string>): 'all' | 'some' | 'none' {
  const xs = r.items.filter(canPick)
  const n = xs.filter((m) => sel.has(m.id)).length
  return n === 0 ? 'none' : n === xs.length ? 'all' : 'some'
}

/** 勾一组 = 勾组里全部能处理的；全选了再点就全去掉 */
export function toggleRow(sel: ReadonlySet<string>, r: Pick<Row, 'items'>): Set<string> {
  const n = new Set(sel)
  const xs = r.items.filter(canPick)
  const all = xs.every((m) => n.has(m.id))
  for (const m of xs) {
    if (all) n.delete(m.id)
    else n.add(m.id)
  }
  return n
}

/** 行上的人名：私聊是对方，群里是发信人（同一组同一个人） */
export const rowWho = (r: Row) => whoName(r.head)

/** 一组消息发起过的会话（按时间新的在前，去重）和拆出来的任务（去重） */
export function rowLinks(xs: readonly ImMessage[]) {
  const sessions = new Map<string, { session_id: string; intent: string; at: string }>()
  const tasks = new Map<string, { id: string; ref: string; title: string }>()
  for (const m of xs) {
    for (const s of m.sessions) {
      const cur = sessions.get(s.session_id)
      if (!cur || cur.at < s.at) sessions.set(s.session_id, s)
    }
    for (const t of m.split_tasks) tasks.set(t.id, t)
  }
  return { sessions: [...sessions.values()].sort((a, b) => b.at.localeCompare(a.at)), tasks: [...tasks.values()] }
}

/** 消息列回复的原消息（库里收到了的）；原消息还没收到时为 undefined */
export function threadParent(m: ImMessage, byId: ReadonlyMap<string, ImMessage>): ImMessage | undefined {
  const id = m.thread?.parent_message_id
  return id ? byId.get(id) : undefined
}

/**
 * 把消息列回复归到原消息那一行（回复自己不再成行）：rows 是 toRows 摆好的行，all 是全部消息（认原消息用）。
 * 原消息在某一行里（筛得出来的优先，合并的一组里也算）就归那一行；原消息不在筛选结果里时补一行变淡的原消息；
 * 原消息还没收到的回复照普通行留着。行按「行里最新一条（含消息列回复）」重新排，新回复把老话题顶上来
 */
export function nestThreads(rows: readonly Row[], all: readonly ImMessage[]): Row[] {
  const byId = new Map(all.map((m) => [m.id, m]))
  const replies = new Map<string, ImMessage[]>()
  const out: Row[] = []
  for (const r of rows) {
    const p = r.kind === 'single' ? threadParent(r.head, byId) : undefined
    if (!p) { out.push({ ...r }); continue }
    const xs = replies.get(p.id)
    if (xs) xs.push(r.head)
    else replies.set(p.id, [r.head])
  }
  if (!replies.size) return out
  const inItems = new Map<string, Row>()
  const inAll = new Map<string, Row>()
  for (const r of out) {
    for (const m of r.items) inItems.set(m.id, r)
    for (const m of r.all) if (!inAll.has(m.id)) inAll.set(m.id, r)
  }
  for (const [pid, xs] of replies) {
    const parent = byId.get(pid)!
    const block: ThreadBlock = { parent, replies: [...xs].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)) }
    const host = inItems.get(pid) ?? inAll.get(pid)
    if (host) { host.threads = [...(host.threads ?? []), block]; continue }
    const faded: Row = { key: `thr:${pid}`, kind: 'single', head: parent, items: [], all: [parent], threads: [block], faded: true }
    inItems.set(pid, faded)
    out.push(faded)
  }
  return out
    .map((r, i) => ({ r, i, at: rowTime(r) }))
    .sort((a, b) => b.at.localeCompare(a.at) || a.i - b.i)
    .map((x) => x.r)
}

/** 一行排序、分天用的时间：行里最新一条，归到这一行的消息列回复也算；变淡的原消息只按回复算 */
export function rowTime(r: Row): string {
  let at = r.faded ? '' : r.head.at
  for (const b of r.threads ?? []) for (const m of b.replies) if (m.at > at) at = m.at
  return at || r.head.at
}

/**
 * 一行上的消息列小标（SPEC-messages-1.62）：列表里不列消息列回复，只在原消息那一行标出来。
 * unread 是这一行挂着的原消息的整个消息列里没读的回复数（不受筛选影响），replies 是筛得出来的回复数；
 * parentId 是点小标要打开的原消息（有多个时取最新回复所在的那个）。这一行没挂消息列时为 null
 */
export function threadBadge(r: Row, all: readonly ImMessage[]): { parentId: string; unread: number; replies: number } | null {
  const bs = r.threads ?? []
  if (!bs.length) return null
  let unread = 0
  let replies = 0
  let latest = bs[0]
  let at = ''
  for (const b of bs) {
    unread += threadOf(b.parent, all).filter((m) => !m.read).length
    replies += b.replies.length
    const last = b.replies[b.replies.length - 1]?.at ?? ''
    if (last > at) { at = last; latest = b }
  }
  return { parentId: latest.parent.id, unread, replies }
}

/** 消息列小标的文字：有未读时「消息列 N 条未读回复」，否则「消息列 N 条回复」 */
export function threadBadgeLabel(b: { unread: number; replies: number }): string {
  return b.unread > 0 ? `消息列 ${b.unread} 条未读回复` : `消息列 ${b.replies} 条回复`
}

/** 原消息的整个消息列（抽屉里列）：全部消息里属于这个消息列的回复，按时间正序 */
export function threadOf(parent: ImMessage, all: readonly ImMessage[]): ImMessage[] {
  return all
    .filter((m) => m.thread && (m.thread.parent_message_id === parent.id
      || (m.channel === parent.channel && m.thread.parent_external_id === parent.external_id)))
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
}

/** 消息列回复下一行的灰字：「回复 <原消息发信人>：<原消息前 40 字>」；原消息在库里时按它的发信人和正文，否则按快照 */
export const THREAD_HINT_MAX = 40
export function threadHint(m: ImMessage, parent?: ImMessage): string {
  if (!m.thread) return ''
  const who = (parent && whoName(parent)) || m.thread.parent_sender_name || '原消息'
  const text = (parent?.text || m.thread.parent_text).replace(/\s+/g, ' ').trim()
  const cut = [...text].length > THREAD_HINT_MAX ? `${[...text].slice(0, THREAD_HINT_MAX).join('')}…` : text
  return cut ? `回复 ${who}：${cut}` : `回复 ${who}`
}

/**
 * 转任务时可以附上的消息列（SPEC-messages-2.15）：这条消息所在消息列里除它以外的消息，按时间正序。
 * 这条是原消息时是它的全部回复；是回复时是原消息（收到了的才有）加同一消息列里的别的回复。不是消息列里的、也没有回复的为空
 */
export function threadForTask(m: ImMessage, all: readonly ImMessage[]): ImMessage[] {
  if (!m.thread) return threadOf(m, all)
  const parent = threadParent(m, new Map(all.map((x) => [x.id, x])))
  const ext = m.thread.parent_external_id
  const replies = all
    .filter((x) => x.id !== m.id && x.thread && x.channel === m.channel && x.thread.parent_external_id === ext)
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  return parent ? [parent, ...replies] : replies
}

/** 一组消息各自所在消息列里、不在这组里的消息，去重，按时间正序（转项目资料带上消息列用） */
export function threadForMany(ms: readonly ImMessage[], all: readonly ImMessage[]): ImMessage[] {
  const have = new Set(ms.map((m) => m.id))
  const out = new Map<string, ImMessage>()
  for (const m of ms) for (const x of threadForTask(m, all)) if (!have.has(x.id)) out.set(x.id, x)
  return [...out.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
}

/** 附上的消息列正文最多这么多字，超出的条数写在末尾（转任务请求体后端限 64KB，中文一字 3 字节，留足余量） */
export const THREAD_TASK_MAX = 12000

/**
 * 附上的消息列拼成任务正文（Markdown）：标题「消息列（N 条）」，一条一行「**发信人** 时间：正文」，原消息标「（原消息）」，
 * 多行正文缩进接在下面；太长时后面的不附，末尾写「还有 K 条没附上，在原消息里看」
 */
export function threadTaskBody(xs: readonly ImMessage[], time: (iso: string) => string = shortTime): string {
  if (!xs.length) return ''
  const lines: string[] = []
  let len = 0
  let cut = 0
  for (const [i, x] of xs.entries()) {
    const text = (x.text.trim() || '（没有正文）').split(/\r?\n/).map((l, j) => (j ? `  ${l}` : l)).join('\n')
    const line = `- **${whoName(x)}**${x.thread ? '' : '（原消息）'} ${time(x.at)}：${text}`
    if (len + line.length > THREAD_TASK_MAX && lines.length) { cut = xs.length - i; break }
    lines.push(line)
    len += line.length + 1
  }
  const tail = cut ? `\n\n还有 ${cut} 条没附上，在原消息里看` : ''
  return `## 消息列（${xs.length} 条）\n\n${lines.join('\n')}${tail}`
}
