// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// IM 消息页的合并显示和「交给 Agent」（SPEC-messages-1.54 起）：同一个私聊合成一行、群里同一人连发合成一行、重复消息合成一行。
// 只是展示：消息不动，状态筛选、计数、勾选、批量仍按一条条消息。正式产品同口径，见 frontend/src/plugins/im/groupModel.ts、sessionModel.ts。
import type { Message } from './data'

/** 群里同一人连发：相邻两条间隔不超过 10 分钟才算一段 */
export const BURST_GAP_MS = 10 * 60_000
/** 重复消息：同会话同人同正文，和这组上一条相隔不超过 24 小时才合 */
export const DUP_WINDOW_MS = 24 * 3600_000

export type GroupKind = 'single' | 'dm' | 'burst' | 'dup'
/** threads 是归到这一行的消息列（列表上不显示回复，只在行上标「消息列 N 条（未读）回复」）；faded 是原消息不在筛选结果里、只因消息列有新回复才显示的一行（变淡） */
export type MsgRow = { key: string; kind: GroupKind; head: Message; items: Message[]; all: Message[]; threads?: ThreadBlock[]; faded?: boolean }
/** 一个消息列：原消息和归到这一行的消息列回复（筛得出来的，按时间正序） */
export type ThreadBlock = { parent: Message; replies: Message[] }

const norm = (t: string) => t.replace(/\s+/g, ' ').trim()
const t = (iso: string) => new Date(iso).getTime()
const convOf = (m: Message) => (m.conversation ? `g:${m.channel}|${m.conversation}` : `d:${m.channel}:${m.sender_id}`)

/** 按全部消息分组：私聊按会话一组；群里连发一段、24 小时内的重复消息并成一组。key 私聊是 dm:<会话>，其余是 grp:<最早一条 id> */
export function clusterMessages(list: readonly Message[]) {
  const byConv = new Map<string, Message[]>()
  const of = new Map<string, string>()
  const byKey = new Map<string, { key: string; kind: GroupKind; all: Message[] }>()
  for (const m of list) {
    // 消息列回复不参与连发、重复合并，各自一条，由 nestThreads 归到原消息那一行
    if (m.thread) { byKey.set(`grp:${m.id}`, { key: `grp:${m.id}`, kind: 'single', all: [m] }); of.set(m.id, `grp:${m.id}`); continue }
    byConv.set(convOf(m), [...(byConv.get(convOf(m)) ?? []), m])
  }
  for (const [ck, xs0] of byConv) {
    const xs = [...xs0].sort((a, b) => a.at.localeCompare(b.at))
    if (!xs[0].conversation) {
      const key = `dm:${ck}`
      byKey.set(key, { key, kind: xs.length > 1 ? 'dm' : 'single', all: xs })
      for (const m of xs) of.set(m.id, key)
      continue
    }
    const parent = xs.map((_, i) => i)
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
    const union = (a: number, b: number) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb) }
    for (let i = 1; i < xs.length; i++) if (xs[i].sender_id === xs[i - 1].sender_id && t(xs[i].at) - t(xs[i - 1].at) <= BURST_GAP_MS) union(i, i - 1)
    const last = new Map<string, number>()
    xs.forEach((m, i) => {
      if (!norm(m.text)) return
      const k = `${m.sender_id}\u0000${norm(m.text)}`
      const j = last.get(k)
      if (j !== undefined && t(m.at) - t(xs[j].at) <= DUP_WINDOW_MS) union(i, j)
      last.set(k, i)
    })
    const groups = new Map<number, Message[]>()
    xs.forEach((m, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), m]))
    for (const all of groups.values()) {
      const key = `grp:${all[0].id}`
      const same = all.every((m) => norm(m.text) === norm(all[0].text))
      byKey.set(key, { key, kind: all.length === 1 ? 'single' : same ? 'dup' : 'burst', all })
      for (const m of all) of.set(m.id, key)
    }
  }
  return { of, byKey }
}

/** 筛好的消息（按时间倒序）摆成行；merge 为假时一条一行 */
export function toRows(rows: readonly Message[], cs: ReturnType<typeof clusterMessages>, merge: boolean): MsgRow[] {
  const one = (m: Message): MsgRow => ({ key: m.id, kind: 'single', head: m, items: [m], all: [m] })
  if (!merge) return rows.map(one)
  const out: MsgRow[] = []
  const at = new Map<string, MsgRow>()
  for (const m of rows) {
    const c = cs.byKey.get(cs.of.get(m.id) ?? '')
    if (!c || c.kind === 'single') { out.push(one(m)); continue }
    const r = at.get(c.key)
    if (r) { r.items.push(m); continue }
    const n = { key: c.key, kind: c.kind, head: m, items: [m], all: c.all }
    at.set(c.key, n)
    out.push(n)
  }
  return out
}

export const countLabel = (r: MsgRow) => (r.items.length < 2 ? '' : r.kind === 'dup' ? `重复 ${r.items.length} 次` : `${r.items.length} 条`)
export const previewText = (r: MsgRow) => (r.kind === 'burst' ? [...r.items].reverse().map((m) => norm(m.text)).join(' / ') : r.head.text)
export const isOpenMsg = (m: Message) => m.status === 'pending' || m.status === 'expired'

// ---- 交给 Agent ----

export type SessionIntent = 'chat' | 'split'

/** 第一句话：消息原文、发信人、群、时间、归属项目、附件名，加上意图（同正式产品 sessionModel.sessionPrompt） */
export function sessionPrompt(xs: readonly Message[], intent: SessionIntent, opts: { who: (m: Message) => string; chLabel: string; project?: string; grant?: string }): string {
  const all = [...xs].sort((a, b) => a.at.localeCompare(b.at))
  const last = all[all.length - 1]
  const fmt = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const atts = [...new Set(all.flatMap((m) => (m.attachments ?? []).map((a) => a.name)))]
  const lines = [
    `下面是 ${opts.chLabel} 上${last.conversation ? `群「${last.conversation}」` : `和 ${opts.who(last)} 的私聊`}里收到的 ${all.length} 条消息。`, '',
    `发信人：${[...new Set(all.map((m) => `${opts.who(m)}（${opts.chLabel} 编号 ${m.sender_id}）`))].join('、')}`,
    `群：${last.conversation || '私聊'}`,
    `时间：${all.length > 1 ? `${fmt(all[0].at)} 到 ${fmt(last.at)}` : fmt(last.at)}`,
    `归属项目：${opts.project || '未归项目'}`,
    ...(atts.length ? [`附件：${atts.join('、')}`] : []), '',
    '消息原文：',
    ...all.slice(-40).map((m) => `[${fmt(m.at)}] ${opts.who(m)}：${m.text.trim() || '（没有正文）'}`), '',
  ]
  if (intent === 'split') {
    lines.push('请把消息里要做的事拆成若干条任务。',
      '先用一个列表写出拆分清单：每条一个标题（一句话说清做什么），再写一句说明；消息里提到了优先级、截止时间就带上，没提到的不要编。拆不出来就直说，不要硬拆。',
      opts.grant === 'auto'
        ? '列完先停下，等我回复确认或修改后，再用 create_object 逐条建成任务（type_id 为 task）。'
        : '列完后用 create_object 逐条建成任务（type_id 为 task），每建一条我会在确认卡片上确认或拒绝，拒绝的就跳过、接着建下一条。',
      opts.project ? `任务不用指定项目，会自动挂到项目「${opts.project}」下，并记上来源消息。` : '任务会自动记上来源消息。')
  } else {
    lines.push('请先帮我理解这些消息：说的是什么事、需要我做什么、有没有要马上回复的；需要建任务时先告诉我。')
  }
  return lines.join('\n')
}

// ---- 消息列回复（SPEC-messages-1.62 起，正式产品同口径见 frontend/src/plugins/im/groupModel.ts） ----

/**
 * 把消息列回复归到原消息那一行（列表上不显示回复本身）：原消息在某一行里（合并的一组里也算）就归那一行；原消息不在筛选结果里时补一行变淡的原消息；
 * 原消息没收到的回复照普通行留着。行按「行里最新一条（含归来的回复）」重新排，老话题来了新回复被顶上来
 */
export function nestThreads(rows: readonly MsgRow[], all: readonly Message[]): MsgRow[] {
  const byId = new Map(all.map((m) => [m.id, m]))
  const replies = new Map<string, Message[]>()
  const out: MsgRow[] = []
  for (const r of rows) {
    const pid = r.kind === 'single' ? r.head.thread?.parent_id : null
    if (!pid || !byId.has(pid)) { out.push({ ...r }); continue }
    replies.set(pid, [...(replies.get(pid) ?? []), r.head])
  }
  if (!replies.size) return out
  for (const [pid, xs] of replies) {
    const parent = byId.get(pid)!
    const block = { parent, replies: [...xs].sort((a, b) => a.at.localeCompare(b.at)) }
    const host = out.find((r) => r.items.some((m) => m.id === pid)) ?? out.find((r) => r.all.some((m) => m.id === pid))
    if (host) { host.threads = [...(host.threads ?? []), block]; continue }
    out.push({ key: `thr:${pid}`, kind: 'single', head: parent, items: [], all: [parent], threads: [block], faded: true })
  }
  return out.map((r, i) => ({ r, i, at: rowTime(r) })).sort((a, b) => b.at.localeCompare(a.at) || a.i - b.i).map((x) => x.r)
}

/** 一行排序、分天用的时间：行里最新一条，挂着的回复也算；变淡的原消息只按回复算 */
export function rowTime(r: MsgRow): string {
  let at = r.faded ? '' : r.head.at
  for (const b of r.threads ?? []) for (const m of b.replies) if (m.at > at) at = m.at
  return at || r.head.at
}

/** 原消息的整个消息列，按时间正序（原消息抽屉里列） */
export const threadOf = (parent: Message, all: readonly Message[]) =>
  all.filter((m) => m.thread?.parent_id === parent.id).sort((a, b) => a.at.localeCompare(b.at))

/** 消息列回复的灰字：「回复 <原消息发信人>：<原消息前 40 字>」 */
export function threadHint(m: Message, parent?: Message, who?: string): string {
  if (!m.thread) return ''
  const name = who || parent?.sender_name || m.thread.parent_sender || '原消息'
  const text = norm(parent?.text ?? m.thread.parent_text)
  const cut = [...text].length > 40 ? `${[...text].slice(0, 40).join('')}…` : text
  return cut ? `回复 ${name}：${cut}` : `回复 ${name}`
}

// ---- 转任务、转项目资料带上消息列（SPEC-messages-2.15、6；正式产品同口径见 frontend/src/plugins/im/groupModel.ts） ----

/**
 * 这条消息所在消息列里除它以外的消息，按时间正序：是原消息时是它的全部回复；是回复时是原消息（收到了的）加同一消息列里的别的回复。
 * 原型的回复只按 parent_id 认，原消息没收到（parent_id 为空）的认不出同伴，为空
 */
export function threadForTask(m: Message, all: readonly Message[]): Message[] {
  const pid = m.thread ? m.thread.parent_id : m.id
  if (!pid) return []
  const parent = m.thread ? all.find((x) => x.id === pid) : undefined
  const replies = all.filter((x) => x.id !== m.id && x.thread?.parent_id === pid).sort((a, b) => a.at.localeCompare(b.at))
  return parent ? [parent, ...replies] : replies
}

/** 一组消息各自所在消息列里、不在这组里的消息，去重，按时间正序（转项目资料带上消息列用） */
export function threadForMany(ms: readonly Message[], all: readonly Message[]): Message[] {
  const have = new Set(ms.map((m) => m.id))
  const out = new Map<string, Message>()
  for (const m of ms) for (const x of threadForTask(m, all)) if (!have.has(x.id)) out.set(x.id, x)
  return [...out.values()].sort((a, b) => a.at.localeCompare(b.at))
}

/** 附上的消息列正文最多这么多字（正式产品转任务请求体限 64KB，留足余量） */
export const THREAD_TASK_MAX = 12000

/** M/D HH:mm */
const threadTime = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/**
 * 附上的消息列拼成任务正文（Markdown）：「## 消息列（N 条）」，一条一行「- **发信人**（原消息） 时间：正文」，多行正文缩进两格；
 * 太长时后面的不附，末尾写「还有 K 条没附上，在原消息里看」
 */
export function threadTaskBody(xs: readonly Message[], who: (m: Message) => string = (m) => m.sender_name, time: (iso: string) => string = threadTime): string {
  if (!xs.length) return ''
  const lines: string[] = []
  let len = 0
  let cut = 0
  for (const [i, x] of xs.entries()) {
    const text = (x.text.trim() || '（没有正文）').split(/\r?\n/).map((l, j) => (j ? `  ${l}` : l)).join('\n')
    const line = `- **${who(x)}**${x.thread ? '' : '（原消息）'} ${time(x.at)}：${text}`
    if (len + line.length > THREAD_TASK_MAX && lines.length) { cut = xs.length - i; break }
    lines.push(line)
    len += line.length + 1
  }
  const tail = cut ? `\n\n还有 ${cut} 条没附上，在原消息里看` : ''
  return `## 消息列（${xs.length} 条）\n\n${lines.join('\n')}${tail}`
}
