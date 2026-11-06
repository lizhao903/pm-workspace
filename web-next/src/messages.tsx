import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MuteButton, MutesDrawer, muteReasonOf, useMutes } from './mutes'
import { PageTitle } from './topbar'
import { ALL_HANDLES, IM_CHANNELS, MY_HANDLES, QUICK_REPLIES, TOOLS, sendAsText, type Connector, type Contact, type Message } from './data'
import { Avatar, ImMark, cls, timeAgo } from './ui'
import { AttachmentChips, AttachmentPanel } from './attachments'
import type { Project } from './projectdata'
import { useEnumView } from './enumdata'
import { SearchSelect, type SearchOption } from './searchselect'
import type { Sop, SopRun } from './sopflow'
import { TRIAGE_TOTAL_MAX, TriageBar, TriageTag, activeTriage, latestTriage } from './triage'
import './msgbulk.css'
import { AgentSection, ReplyBarActions } from './msgagent'
import { MaterialSection, notesOf } from './msgmaterial'
import { clusterMessages, countLabel, isOpenMsg, nestThreads, previewText, rowTime, threadHint, threadOf, toRows, type MsgRow, type SessionIntent } from './msggroup'
import { GroupAdminDrawer } from './groupadmin'
import { SendDialog, SentStrip, sentReplyOf, type Sent } from './msgsend'
import { MentionBox, composeReply, quickReplyText, useReplyMention, type Member, type MentionPick } from './mention'
import { ThreadReplies } from './msgthread'

export type MsgAction =
  | { kind: 'done' | 'ignore' | 'reopen' | 'read' }
  | { kind: 'snooze'; until: string }
  /** mentions 是正文里真正要 @ 的人（SPEC-messages-2.46）；原型只记正文 */
  | { kind: 'reply'; text: string; done: boolean; mentions?: MentionPick[] }

type View = 'pending' | 'snoozed' | 'done' | 'ignored' | 'expired' | 'all'

/* ---------- 与我相关：@我、@所有人、私聊 ---------- */

// @ 后面接名字；英文名允许带一个空格（@Lin Yuan），所以先按已知名字整串匹配，再退回到单词
const MENTION = new RegExp(`@(${[...MY_HANDLES, ...ALL_HANDLES].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}|[A-Z][a-z]+ [A-Z][a-z]+|[\\w\u4e00-\u9fa5.-]+)`, 'g')
export type Relevance = 'me' | 'all' | 'dm'
export const RELEVANCE: Record<Relevance, string> = { me: '@我', all: '@所有人', dm: '私聊' }

/** 这条消息为什么和我有关；无关返回 null。@我 优先于 @所有人，私聊本来就是发给我的 */
export function relevance(m: Message): Relevance | null {
  const names = [...m.text.matchAll(MENTION)].map((x) => x[1])
  if (names.some((n) => MY_HANDLES.includes(n))) return 'me'
  if (names.some((n) => ALL_HANDLES.includes(n))) return 'all'
  if (!m.conversation) return 'dm'
  return null
}

/** 正文里的 @ 标出来，@我 的更醒目 */
export function MentionText({ text }: { text: string }) {
  const out: (string | { name: string; mine: boolean })[] = []
  let last = 0
  for (const x of text.matchAll(MENTION)) {
    if (x.index! > last) out.push(text.slice(last, x.index))
    out.push({ name: x[1], mine: MY_HANDLES.includes(x[1]) || ALL_HANDLES.includes(x[1]) })
    last = x.index! + x[0].length
  }
  out.push(text.slice(last))
  return <>{out.map((p, i) => typeof p === 'string' ? p : <span key={i} className={cls('mention', p.mine && 'mention-me')}>@{p.name}</span>)}</>
}

/** 待处理里设了稍后、还没到点的；项目里的待回复也按这个排除 */
export const isSnoozed = (m: Message) => m.status === 'pending' && !!m.snooze_until && new Date(m.snooze_until).getTime() > Date.now()
const channelOf = (key: string) => IM_CHANNELS.find((c) => c.key === key)!
export const contactFor = (m: Message, contacts: Contact[]) => contacts.find((c) => c.im[m.channel] === m.sender_id)
/** 「渠道:发信人编号」，查联系人索引用 */
export const senderKey = (m: Message) => `${m.channel}:${m.sender_id}`
/** 联系人索引：「渠道:编号」→ 联系人。列表逐行查人时先建好它，别每行扫一遍联系人；同一编号取第一个，和 contactFor 一致 */
export function contactIndex(contacts: Contact[]) {
  const map = new Map<string, Contact>()
  for (const c of contacts) for (const [ch, id] of Object.entries(c.im)) if (id && !map.has(`${ch}:${id}`)) map.set(`${ch}:${id}`, c)
  return map
}
/** 消息属于哪个会话：群聊按渠道 + 群名，私聊按渠道 + 发信人 */
const convKey = (m: Message) => (m.conversation ? `g:${m.channel}|${m.conversation}` : `d:${senderKey(m)}`)
/** 群组标签里「私聊」合成一个标签，键是 dm:<渠道> */
const dmTab = (channel: string) => `dm:${channel}`
/** 会话筛选：空串不筛；dm:<渠道> 是这个渠道的全部私聊；其余按会话键 */
const convOk = (m: Message, conv: string) => !conv || (conv.startsWith('dm:') ? !m.conversation && m.channel === conv.slice(3) : convKey(m) === conv)
/** 群组标签最多直接摆几个，其余收进「更多」 */
const GROUP_TAB_MAX = 8

/**
 * 群组默认归属的项目：消息自己没归项目时，按所在群（会话键 g:<渠道>|<群名>）设的默认项目算，project_source 记为 conversation；
 * 项目删了按没设。正式产品存在 IM 插件里（GET/PUT /api/im/conversation-projects），读消息时由后端兜底
 */
export function withGroupProjects(messages: Message[], groupProjects: Record<string, string>, projects: Project[]): Message[] {
  if (!Object.keys(groupProjects).length) return messages
  return messages.map((m) => {
    // 私聊也能在群组管理（SPEC-messages-7）里设默认归属，会话键 d:<渠道>:<发信人>
    if (m.project_id) return m
    const pid = groupProjects[convKey(m)]
    return pid && projects.some((p) => p.id === pid) ? { ...m, project_id: pid, project_source: 'conversation' as const } : m
  })
}
/** 列表按天分段 */
const dayLabel = (iso: string) => {
  const d = new Date(iso), t = new Date()
  const start = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()
  return d.getTime() >= start ? '今天' : d.getTime() >= start - 86400000 ? '昨天' : '更早'
}
/** 状态 seg 里最多放几个状态（不算「全部」） */
const VIEW_SEG_MAX = 4
/** 列表先渲染这么多条，底部「加载更多」再加这么多 */
const PAGE = 50

/** 回不了的原因；null 表示能回。界面上按钮灰掉时要把原因写出来，不能只是点不动 */
export function replyBlocker(conn: Connector | undefined) {
  if (!conn) return '渠道已删除，这条消息只能查看'
  if (conn.status === 'error') return `连接器「${conn.name}」异常，修好之前发不出去`
  if (conn.status === 'paused') return `连接器「${conn.name}」已暂停`
  if (conn.status === 'disconnected') return `连接器「${conn.name}」已断开，去设置里重新连接`
  if (conn.status === 'connecting') return `连接器「${conn.name}」正在连接`
  if (conn.direction === 'receive') return `连接器「${conn.name}」设置为只收消息`
  return null
}

/** 取不到附件的原因；null 表示能取。分类和 replyBlocker 一样，只收消息的照样能取。incident 为真时要记运行异常 */
export function fetchBlocker(conn: Connector | undefined): { text: string; incident: boolean } | null {
  if (!conn) return { text: '渠道已删除，取不到附件', incident: false }
  if (conn.status === 'error') return { text: `连接器「${conn.name}」异常，取不到附件；修好连接器后重试`, incident: true }
  if (conn.status === 'paused') return { text: `连接器「${conn.name}」已暂停，取不到附件；恢复后重试`, incident: false }
  if (conn.status === 'disconnected') return { text: `连接器「${conn.name}」已断开，取不到附件；去设置里重新连接`, incident: false }
  if (conn.status === 'connecting') return { text: `连接器「${conn.name}」正在连接，连上后重试`, incident: false }
  return null
}

function snoozeOptions() {
  const now = new Date()
  const tonight = new Date(now); tonight.setHours(20, 0, 0, 0)
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1); tomorrow.setHours(9, 0, 0, 0)
  return [
    { label: '1 小时后', until: new Date(now.getTime() + 3600000) },
    ...(tonight > now ? [{ label: '今晚 20:00', until: tonight }] : []),
    { label: '明天 9:00', until: tomorrow },
  ]
}

/** 行内和抽屉共用的小弹出菜单，点外面收起 */
function Menu({ label, className, children }: { label: React.ReactNode; className?: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <div className="menu-wrap" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className={className} onClick={() => setOpen(!open)}>{label}</button>
      {open && <div className="menu">{children(() => setOpen(false))}</div>}
    </div>
  )
}

function QuickReplyItems({ onPick, close }: { onPick: (text: string, done: boolean) => void; close: () => void }) {
  const msgEnum = useEnumView('msg_status')
  return (
    <>
      <div className="menu-label">快捷回复</div>
      {!QUICK_REPLIES.length && <div className="menu-item muted">没有快捷回复，到设置的即时通讯里添加</div>}
      {QUICK_REPLIES.map((q) => (
        <button key={q.text} className="menu-item" onClick={() => { onPick(q.text, q.done); close() }}>
          <span className="ellipsis">{q.text}</span>
          {q.done && <span className="menu-note">并标为{msgEnum.label('done')}</span>}
        </button>
      ))}
    </>
  )
}

export const gear = <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>

const caret = <svg viewBox="0 0 16 16" width="10" height="10"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>

/* ---------- 列表 ---------- */

/** M/D HH:mm */
const fmtMD = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** 状态小标签按枚举颜色上色，和原来「已处理」的绿色标签同一种做法 */
const stateStyle = (c: string): React.CSSProperties => ({ color: c, background: `color-mix(in srgb, ${c} 12%, transparent)` })

export function MessagesPage({ messages, contacts, connectors, selected, onOpen, onAct, onGoConnectors, onToTask, taskOf, onSync, syncing, syncResult, projects, groupProjects, onSetGroupProject, sops, runs, onBatchTriage, onOpenQueue, onOpenTriage, selectedGroup, onOpenGroup, onStartSession, linksOf, onOpenSession, onToMaterial, onOpenMaterial }: {
  /** 转项目资料（SPEC-messages-6）：带上这些消息打开弹窗；转过的去项目资料页定位那一条 */
  onToMaterial: (ids: string[]) => void
  onOpenMaterial: (projectId: string, materialId: string) => void
  /** 合并显示（SPEC-messages-1.54）：打开的一组、点一组打开组抽屉 */
  selectedGroup: string | null; onOpenGroup: (key: string) => void
  /** 交给 Agent（SPEC-messages-1.57）：带上这些消息发起会话、拆分任务；linksOf 是一组消息发起过的会话（新的在前）和拆出来的任务数 */
  onStartSession: (ids: string[], intent: SessionIntent) => void
  linksOf: (ids: string[]) => { sessions: string[]; tasks: number }
  onOpenSession: (id: string) => void
  /** 批量分诊、处理队列（SPEC-messages-1.51~1.53）：分诊用的流程和执行；onBatchTriage 回发起、跳过各几条 */
  sops: Sop[]; runs: SopRun[]; onBatchTriage: (sopId: string, messageIds: string[], rerun: boolean) => { started: number; skipped: number }; onOpenQueue: () => void
  /** 分诊建议（SPEC-messages-1.53）：点「已分诊」打开这条消息的抽屉并滚到「分诊建议」 */
  onOpenTriage: (id: string) => void
  /** 群组默认归属的项目：群的会话键 -> 项目 id；选中一个群标签时能设、改、清除（null） */
  projects: Project[]; groupProjects: Record<string, string>; onSetGroupProject: (convKey: string, projectId: string | null) => void
  /** 立即同步：传了渠道只同步那个渠道 */
  onSync: (channel?: string) => void; syncing: boolean; syncResult: { at: string; text: string; bad: boolean } | null
  /** onGoConnectors：打开设置里的连接器，并定位到即时通讯分类 */
  messages: Message[]; contacts: Contact[]; connectors: Connector[]; selected: string | null
  onOpen: (id: string) => void; onAct: (id: string, a: MsgAction) => void; onGoConnectors: () => void
  /** 转任务；已经转过的打开那条任务 */
  onToTask: (id: string) => void; taskOf: (id: string) => string | undefined
}) {
  const msgEnum = useEnumView('msg_status')
  const [view, setView] = useState<View>('pending')
  const [channel, setChannel] = useState('')
  const [unreadOnly, setUnreadOnly] = useState(false)
  /** '' 全部；mine 与我相关（@我、@所有人、私聊）；at 只看 @我 */
  const [mine, setMine] = useState<'' | 'mine' | 'at'>('')
  const [q, setQ] = useState('')
  /** 只看某个会话：convKey */
  const [conv, setConv] = useState('')
  /** 合并显示，默认开（SPEC-messages-1.54） */
  const [merge, setMerge] = useState(true)
  /** 群组管理抽屉（SPEC-messages-7） */
  const [groupsOpen, setGroupsOpen] = useState(false)
  /** 自动忽略的管理抽屉（SPEC-messages-9） */
  const [mutesOpen, setMutesOpen] = useState(false)
  const muteList = useMutes()
  /** 主动发消息（SPEC-messages-8）：弹窗带上的会话键；发件记录原型只存在这里 */
  const [sending, setSending] = useState<{ key?: string } | null>(null)
  const [outbox, setOutbox] = useState<Sent[]>([])
  const sentReply = useMemo(() => sentReplyOf(messages, outbox), [messages, outbox])
  const addSent = (s: Omit<Sent, 'id' | 'at' | 'status' | 'error' | 'source'>) =>
    setOutbox((xs) => [...xs, { ...s, id: `ob${xs.length + 1}`, at: new Date().toISOString(), status: 'sent', error: '', source: 'manual' }])
  const sentTag = (ids: string[]) => {
    const s = ids.map((id) => sentReply.get(id)).find(Boolean)
    return s ? <span className="state sent-tag" title={`回复了我 ${timeAgo(s.at)}发出的「${s.text.slice(0, 40)}」`}>回复了我发出的</span> : null
  }
  const people = useMemo(() => contactIndex(contacts), [contacts])
  const whoOf = (m: Message) => people.get(senderKey(m))
  // @ 解析是正则，每条只算一次
  const rels = useMemo(() => new Map(messages.map((m) => [m.id, relevance(m)])), [messages])
  const relOf = (m: Message) => rels.get(m.id) ?? null

  const inView = (m: Message, v: View) =>
    v === 'all' ? true
      : v === 'pending' ? m.status === 'pending' && !isSnoozed(m)
        : v === 'snoozed' ? isSnoozed(m)
          : m.status === v
  const kw = q.trim().toLowerCase()
  const relOk = (m: Message) => !mine || (mine === 'at' ? relOf(m) === 'me' : relOf(m) !== null)
  const rows = useMemo(() => messages
    .filter((m) => inView(m, view) && (!channel || m.channel === channel) && convOk(m, conv) && (!unreadOnly || !m.read) && relOk(m)
      && (!kw || [m.text, m.sender_name, m.conversation, whoOf(m)?.name ?? '', m.sender_id].some((v) => v.toLowerCase().includes(kw))))
    .sort((a, b) => b.at.localeCompare(a.at)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [messages, people, rels, view, channel, conv, unreadOnly, mine, kw])

  // 状态 seg：待处理、稍后 + 枚举里的状态；状态多时 seg 只放前几个，其余收进「更多状态」
  const views = msgEnum.items.flatMap((i) => (i.key === 'pending' ? [[i.key, i.label], ['snoozed', '稍后']] : [[i.key, i.label]])) as [View, string][]
  const segViews = views.length > VIEW_SEG_MAX + 1 ? views.slice(0, VIEW_SEG_MAX) : views
  const moreViews = views.slice(segViews.length)
  const count = (v: View) => messages.filter((m) => inView(m, v) && (!channel || m.channel === channel) && convOk(m, conv) && relOk(m)).length
  const atMe = messages.filter((m) => m.status === 'pending' && !isSnoozed(m) && relOf(m) === 'me').length

  // 会话筛选的选项：当前渠道下出现过的群和私聊，各自按待处理数排
  const convOptions = useMemo(() => {
    const acc = new Map<string, { m: Message; n: number; pending: number }>()
    for (const m of messages) {
      if (channel && m.channel !== channel) continue
      const k = convKey(m)
      const x = acc.get(k) ?? { m, n: 0, pending: 0 }
      x.n += 1
      if (m.status === 'pending' && !isSnoozed(m)) x.pending += 1
      acc.set(k, x)
    }
    const opt = ([k, x]: [string, { m: Message; n: number; pending: number }]): SearchOption => {
      const p = people.get(senderKey(x.m))
      return {
        value: k, group: x.m.conversation ? '群聊' : '私聊',
        label: x.m.conversation || p?.name || x.m.sender_name,
        hint: `${channelOf(x.m.channel).label} · ${x.pending ? `${x.pending} 条${msgEnum.label('pending')}` : `${x.n} 条`}`,
        keywords: x.m.conversation ? '' : `${x.m.sender_name} ${x.m.sender_id}`,
      }
    }
    const by = (a: [string, { pending: number; m: Message }], b: [string, { pending: number; m: Message }]) => b[1].pending - a[1].pending || b[1].m.at.localeCompare(a[1].m.at)
    const xs = [...acc.entries()]
    return [...xs.filter(([k]) => k.startsWith('g:')).sort(by).map(opt), ...xs.filter(([k]) => k.startsWith('d:')).sort(by).map(opt)]
  }, [messages, channel, people, msgEnum])

  // 群组标签：选了渠道后按群组归总。群按消息条数、再按群名排（不按待处理数排，处理消息时标签不跳），
  // 私聊合成一个「私聊」标签紧跟「全部」（群多时也看得到）；超过 GROUP_TAB_MAX 的群和单个私聊收进「更多」。数字是待处理（不含稍后）
  const tabs = useMemo(() => {
    if (!channel) return null
    const acc = new Map<string, { m: Message; n: number; pending: number }>()
    for (const m of messages) {
      if (m.channel !== channel) continue
      const k = convKey(m)
      const x = acc.get(k) ?? { m, n: 0, pending: 0 }
      x.n += 1
      if (m.status === 'pending' && !isSnoozed(m)) x.pending += 1
      acc.set(k, x)
    }
    const xs = [...acc.entries()].map(([value, x]) => ({ value, label: x.m.conversation || people.get(senderKey(x.m))?.name || x.m.sender_name, n: x.n, pending: x.pending, group: !!x.m.conversation }))
    const groups = xs.filter((x) => x.group).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, 'zh-CN'))
    const dms = xs.filter((x) => !x.group)
    const all = { value: '', label: '全部', n: 0, pending: messages.filter((m) => m.channel === channel && m.status === 'pending' && !isSnoozed(m)).length }
    const dm = dms.length ? [{ value: dmTab(channel), label: '私聊', n: 0, pending: dms.reduce((a, x) => a + x.pending, 0) }] : []
    const more: SearchOption[] = [...groups.slice(GROUP_TAB_MAX), ...dms].map((x) => ({
      value: x.value, group: x.group ? '群聊' : '私聊', label: x.label, hint: x.pending ? `${x.pending} 条${msgEnum.label('pending')}` : `${x.n} 条`,
    }))
    return { tabs: [all, ...dm, ...groups.slice(0, GROUP_TAB_MAX)], more, moreGroups: Math.max(0, groups.length - GROUP_TAB_MAX), any: groups.length + dms.length > 0 }
  }, [messages, channel, people, msgEnum])
  const moreOn = !!tabs?.more.some((o) => o.value === conv)
  const lastTriage = useMemo(() => latestTriage(runs), [runs])
  const activeN = activeTriage(runs).length
  const [triaging, setTriaging] = useState(false)
  const [triageNote, setTriageNote] = useState('')
  const groupOn = conv.startsWith('g:')
  const projectOptions = projects.map((p) => ({ value: p.id, label: p.name }))

  // 先渲染 PAGE 条；筛选一变就回到第一页（按筛选条件记，不用 effect 清）
  const sig = [view, channel, conv, unreadOnly, mine, kw, merge].join('|')
  const [lim, setLim] = useState({ sig, n: PAGE })
  const limit = lim.sig === sig ? lim.n : PAGE
  const clusters = useMemo(() => clusterMessages(messages), [messages])
  // 消息列回复归到原消息那一行（SPEC-messages-1.62），列表上不显示回复本身，不管合不合并
  const viewRows = useMemo(() => nestThreads(toRows(rows, clusters, merge), messages), [rows, clusters, merge, messages])
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages])
  const shown = viewRows.slice(0, limit)
  // 勾选和常驻全选（SPEC-messages-1.40、1.41，TSK-0492）：还没处理的（待处理含稍后、已过期）能勾；
  // 已选按列表上看得到的消息算（不含收起的消息列回复），全选只选已加载（已渲染出来的行）里能勾的
  const [sel, setSel] = useState<ReadonlySet<string>>(() => new Set())
  const picked = viewRows.flatMap((r) => r.items).filter((m) => sel.has(m.id) && isOpenMsg(m))
  const loaded = shown.flatMap((r) => r.items.filter(isOpenMsg))
  const allState = loaded.length && loaded.every((m) => sel.has(m.id)) ? 'all' : picked.length ? 'some' : 'none'
  const unloaded = viewRows.length > limit
  const toggleAll = () => setSel((x) => (allState === 'all' ? new Set<string>() : new Set([...x, ...loaded.map((m) => m.id)])))
  const toggleIds = (ids: string[]) => setSel((x) => {
    const n = new Set(x)
    const on = ids.every((id) => n.has(id))
    for (const id of ids) { if (on) n.delete(id); else n.add(id) }
    return n
  })
  const bulk = (kind: 'done' | 'ignore') => {
    picked.forEach((m) => onAct(m.id, { kind }))
    setTriageNote(`已把 ${picked.length} 条标为${msgEnum.label(kind === 'done' ? 'done' : 'ignored')}`)
    setSel(new Set())
  }
  const pickBox = (ms: Message[], label: string) => {
    const xs = ms.filter(isOpenMsg)
    if (!xs.length) return <span className="msg-pick" aria-hidden="true" />
    const n = xs.filter((m) => sel.has(m.id)).length
    return (
      <input type="checkbox" className="msg-pick" aria-label={label} checked={n > 0 && n === xs.length}
        ref={(el) => { if (el) el.indeterminate = n > 0 && n < xs.length }}
        onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onChange={() => toggleIds(xs.map((m) => m.id))} />
    )
  }
  // 每天的条数按消息算（归来的消息列回复也算），一组归在它最新一条那天
  const dayCount = new Map<string, number>()
  for (const r of viewRows) {
    const d = dayLabel(rowTime(r))
    dayCount.set(d, (dayCount.get(d) ?? 0) + r.items.length + (r.threads ?? []).reduce((n, b) => n + b.replies.length, 0))
  }
  const openRow = (r: MsgRow) => (r.kind === 'single' ? onOpen(r.head.id) : onOpenGroup(r.key))
  const usedChannels = IM_CHANNELS.filter((ch) => connectors.some((c) => c.tool === ch.key) || messages.some((m) => m.channel === ch.key))
  const broken = connectors.filter((c) => c.status === 'error' && TOOLS.find((t) => t.key === c.tool)?.category === 'im')
  const lastSync = connectors.filter((c) => TOOLS.find((t) => t.key === c.tool)?.category === 'im' && c.last_sync_at).map((c) => c.last_sync_at!).sort().pop()
  // 同步结果在按钮旁边留 6 秒
  const [showResult, setShowResult] = useState(false)
  useEffect(() => {
    if (!syncResult) return
    setShowResult(true)
    const t = window.setTimeout(() => setShowResult(false), 6000)
    return () => window.clearTimeout(t)
  }, [syncResult])

  // 键盘：j/k 上下，e 标已处理。只在没有输入框聚焦时生效
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select') || e.metaKey || e.ctrlKey) return
      const i = viewRows.findIndex((r) => (r.kind === 'single' ? r.head.id === selected : r.key === selectedGroup))
      if (e.key === 'j' && viewRows.length) {
        const n = Math.min(i + 1, viewRows.length - 1)
        // 走到已渲染的末尾就再加载一页
        if (n >= limit) setLim({ sig, n: limit + PAGE })
        openRow(viewRows[n])
      }
      if (e.key === 'k' && viewRows.length) openRow(viewRows[Math.max(i - 1, 0)])
      // 只对还没处理的（待处理含稍后、已过期）生效，已处理、已忽略的不动
      const st = selected ? messages.find((m) => m.id === selected)?.status : undefined
      if (e.key === 'e' && selected && (st === 'pending' || st === 'expired')) onAct(selected, { kind: 'done' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // 行上的「更多」菜单：交给 Agent（拆分任务、发起会话，SPEC-messages-1.57）、转项目资料（SPEC-messages-1.59）
  const agentMenu = (ids: string[]) => (
    <Menu className="act" label={<>更多{caret}</>}>
      {(close) => (
        <>
          <div className="menu-label">交给 Agent</div>
          <button className="menu-item" onClick={() => { onStartSession(ids, 'split'); close() }}>拆分任务…</button>
          <button className="menu-item" onClick={() => { onStartSession(ids, 'chat'); close() }}>发起会话…</button>
          <div className="menu-label">资料</div>
          <button className="menu-item" onClick={() => { onToMaterial(ids); close() }}>转项目资料…</button>
        </>
      )}
    </Menu>
  )
  // 转过资料的标「已转资料」，点了去项目资料页（SPEC-messages-1.60）
  const matTag = (ids: string[]) => {
    const notes = notesOf(projects, ids)
    if (!notes.length) return null
    return (
      <button className="state state-task state-link" title={notes.map((h) => `${h.project.name}：${h.material.name}`).join('\n')}
        onClick={(e) => { e.stopPropagation(); onOpenMaterial(notes[0].project.id, notes[0].material.id) }} onKeyDown={(e) => e.stopPropagation()}>
        已转资料{notes.length > 1 ? ` ${notes.length}` : ''}
      </button>
    )
  }
  // 发起过会话、拆出过任务的标出来（SPEC-messages-1.58）
  const linkTags = (ids: string[]) => {
    const l = linksOf(ids)
    if (l.tasks) return <button className="state state-task state-link" onClick={(e) => { e.stopPropagation(); if (l.sessions[0]) onOpenSession(l.sessions[0]) }} onKeyDown={(e) => e.stopPropagation()}>已拆分 {l.tasks} 条任务</button>
    if (l.sessions.length) return <button className="state state-task state-link" onClick={(e) => { e.stopPropagation(); onOpenSession(l.sessions[0]) }} onKeyDown={(e) => e.stopPropagation()} title="打开最近的一个会话">已发起会话</button>
    return null
  }
  // 合并的一组（SPEC-messages-1.55）：人名、条数、拼起来的预览；整组标已处理、忽略
  // 消息列回复不在列表上显示（SPEC-messages-1.62）：原消息那一行标「消息列 N 条未读回复」（整个消息列里有没读的），
  // 没有未读但这一行归来了筛得出来的回复时标「消息列 N 条回复」；点了打开原消息，消息列回复在原消息抽屉里看
  const threadTags = (r: MsgRow) => (r.threads ?? []).map((b) => {
    const unread = threadOf(b.parent, messages).filter((x) => !x.read).length
    if (!unread && !b.replies.length) return null
    return (
      <button key={`thr:${b.parent.id}`} className={cls('thread-count', unread > 0 && 'unread')} title="消息列里的回复在原消息里看，点开原消息"
        onClick={(e) => { e.stopPropagation(); onOpen(b.parent.id) }} onKeyDown={(e) => e.stopPropagation()}>
        {unread > 0 ? `消息列 ${unread} 条未读回复` : `消息列 ${b.replies.length} 条回复`}
      </button>
    )
  })

  const groupRow = (r: MsgRow) => {
    const m = r.head
    const who = whoOf(m)
    const open = r.items.filter(isOpenMsg)
    const unread = r.items.filter((x) => !x.read).length
    const label = countLabel(r)
    return (
      <div role="button" tabIndex={0} className={cls('msg msg-group', selectedGroup === r.key && 'sel', unread > 0 && 'unread', !open.length && 'msg-closed')}
        onClick={() => onOpenGroup(r.key)} onKeyDown={(e) => e.key === 'Enter' && onOpenGroup(r.key)}>
        <span className="msg-unread" />
        {pickBox(r.items, `选中 ${who?.name ?? m.sender_name} 这一组`)}
        <Avatar name={who?.name ?? m.sender_name} size={34} src={who?.photo} />
        <div className="msg-main">
          <div className="msg-top">
            <span className="msg-who">{who?.name ?? m.sender_name}</span>
            {label && <span className="msg-count">{label}</span>}
            <ImMark ch={channelOf(m.channel)} compact />
            <span className="msg-conv">{m.conversation || '私聊'}</span>
            {threadTags(r)}
            <span className="spacer" />
            {open.length > 0 && open.length < r.items.length && <span className="state">{open.length} 条{msgEnum.label('pending')}</span>}
            {unread > 0 && r.kind === 'dm' && <span className="state">{unread} 条未读</span>}
            {linkTags(r.all.map((x) => x.id))}
            {matTag(r.all.map((x) => x.id))}
            {sentTag(r.items.map((x) => x.id))}
            <span className="msg-time">{timeAgo(m.at)}</span>
          </div>
          <div className="msg-text"><MentionText text={previewText(r)} /></div>
        </div>
        <div className="msg-actions" onClick={(e) => e.stopPropagation()}>
          {open.length > 0 ? (
            <>
              <button className="act act-primary" onClick={() => open.forEach((x) => onAct(x.id, { kind: 'done' }))} title={`这一行 ${open.length} 条都标为${msgEnum.label('done')}`}>{msgEnum.label('done')}</button>
              {agentMenu(r.all.map((x) => x.id))}
              <button className="act act-quiet" onClick={() => open.forEach((x) => onAct(x.id, { kind: 'ignore' }))}>忽略</button>
            </>
          ) : (
            <>{agentMenu(r.all.map((x) => x.id))}<button className="act" onClick={() => r.items.forEach((x) => onAct(x.id, { kind: 'reopen' }))}>重新打开</button></>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <PageTitle count={`${count('pending')} 条${msgEnum.label('pending')}`} desc={<>各渠道收进来的消息。<kbd>J</kbd> <kbd>K</kbd> 上下切换，<kbd>E</kbd> 标为{msgEnum.label('done')}</>} actions={
        <>
        {showResult && syncResult && <span className={cls('sync-note', syncResult.bad && 'bad')}>{syncResult.text}</span>}
        <button className="btn btn-outline" onClick={() => onSync(channel || undefined)} disabled={syncing}
          title={`${channel ? `只同步${channelOf(channel).label}` : '同步全部 IM 渠道'}${lastSync ? `；上次同步 ${timeAgo(lastSync)}` : ''}`}>
          <svg className={cls(syncing && 'spin')} viewBox="0 0 16 16" width="13" height="13"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 3v2.5h-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {syncing ? '同步中…' : channel ? `同步${channelOf(channel).label}` : '立即同步'}
        </button>
        {triageNote && <span className="sync-note">{triageNote}</span>}
        <button className="btn btn-ghost btn-outline" onClick={() => setSending({})} title="主动发一条到群或私聊">发消息</button>
        <button className="btn btn-ghost btn-outline" onClick={() => setGroupsOpen(true)} title="给群和私聊设默认归属的项目，能批量设">群组管理</button>
        <button className="btn btn-ghost btn-outline" onClick={() => setMutesOpen(true)} title="自动忽略的发信人：他们的消息一收到就进「已忽略」，不计未读、不触发 SOP 和 Agent；在这里查看、取消">
          自动忽略{muteList.length > 0 && <span className="seg-n">{muteList.length}</span>}
        </button>
        <button className="btn btn-ghost btn-outline" onClick={onGoConnectors} title="在设置里管理 IM 渠道的连接器">
          {gear}渠道配置
          {broken.length > 0 && <span className="dot-alert" title={`${broken.length} 个连接器异常`} />}
        </button>
        </>
      }>IM 消息</PageTitle>

      {/* 渠道异常不在列表顶上铺横幅：标题行「渠道配置」带红点，受影响的消息行上有小标记，详情里再说清楚原因 */}

      <div className="toolbar">
        <div className="seg">
          {[...segViews, ['all', '全部'] as [View, string]].map(([v, label]) => (
            <button key={v} className={cls(view === v && 'on')} onClick={() => setView(v)}>{label}<span className="seg-n">{count(v)}</span></button>
          ))}
        </div>
        {moreViews.length > 0 && (
          <SearchSelect value={moreViews.some(([v]) => v === view) ? view : ''} placeholder={`更多状态 ${moreViews.length}`} searchPlaceholder="搜状态" aria-label="更多状态"
            options={moreViews.map(([v, label]) => ({ value: v, label, hint: `${count(v)} 条` }))}
            onChange={(v) => setView(v ? (v as View) : 'pending')} />
        )}
        <div className="search">
          <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder="搜索内容、发信人、群名" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className={cls('chip chip-select', mine && 'chip-on')} title="与我相关：@我、@所有人和私聊">
          <select value={mine} onChange={(e) => setMine(e.target.value as typeof mine)}>
            <option value="">全部消息</option>
            <option value="mine">与我相关</option>
            <option value="at">只看 @我{atMe ? `（${atMe} 条${msgEnum.label('pending')}）` : ''}</option>
          </select>
          {!mine && atMe > 0 && <span className="mention-n" title={`${atMe} 条 @我 的消息${msgEnum.label('pending')}`}>@{atMe}</span>}
        </div>
        <button className={cls('chip', unreadOnly && 'chip-on')} onClick={() => setUnreadOnly(!unreadOnly)}>只看未读</button>
        <button className={cls('chip', merge && 'chip-on')} aria-pressed={merge} onClick={() => setMerge(!merge)}
          title="同一个私聊合成一行，群里同一人连发、重复的消息合成一行；只是显示，消息不变">合并显示</button>
        {/* 选了渠道时由群组标签代替这个下拉 */}
        {!channel && convOptions.length > 1 && (
          <SearchSelect value={conv} onChange={setConv} noneLabel="全部会话" options={convOptions}
            searchPlaceholder="搜群名、发信人" missingLabel={() => '这个渠道下没有这个会话'} aria-label="只看某个会话" />
        )}
        <div className="spacer" />
        <div className="channel-filter">
          <button className={cls('ch-btn', !channel && 'on')} onClick={() => { setChannel(''); setConv('') }}>全部渠道</button>
          {usedChannels.map((ch) => (
            <button key={ch.key} className={cls('ch-btn', channel === ch.key && 'on')} style={{ ['--c' as string]: ch.color }} onClick={() => { setChannel(channel === ch.key ? '' : ch.key); setConv('') }}>
              <i className="pill-dot" />{ch.label}
            </button>
          ))}
        </div>
      </div>

      {/* 页面下方的批量处理条（SPEC-messages-1.41、1.51、1.52，TSK-0492）：左边常驻全选框（已加载里能勾的）和「已选 N 条 / 已加载 M 条」；
          勾了时多「标为已处理」「忽略」「取消选择」；批量分诊对勾选的，没勾时对当前筛选结果 */}
      <div className={cls('run-bulk', !picked.length && 'msg-bulk-idle')} role="toolbar" aria-label="批量处理">
        <label className="msg-bulk-all" title={loaded.length ? `选中已加载的 ${loaded.length} 条能处理的消息` : '已加载的消息里没有能勾选的（只有还没处理的能勾）'}>
          <input type="checkbox" className="msg-pick" aria-label="全选已加载的消息" disabled={!loaded.length} checked={allState === 'all'}
            ref={(el) => { if (el) el.indeterminate = allState === 'some' }} onChange={toggleAll} />
          全选
        </label>
        {picked.length > 0 && <b>已选 {picked.length} 条</b>}
        <span className="list-sub">{picked.length > 0 ? '/ ' : ''}已加载 {loaded.length} 条</span>
        {unloaded && loaded.length > 0 && <span className="list-sub msg-bulk-hint">还有未加载的，加载更多后再全选可包含更多</span>}
        {!picked.length && <span className="list-sub msg-bulk-hint">不勾时批量分诊对当前筛选结果 {rows.length} 条</span>}
        <span className="spacer" />
        <button className="btn btn-outline" onClick={() => setTriaging(true)} disabled={!picked.length && !rows.length}
          title={picked.length ? `给勾选的 ${picked.length} 条消息各发起一次分诊流程` : `给当前筛选结果全部的消息各发起一次分诊流程（最多 ${TRIAGE_TOTAL_MAX} 条，超过 200 条自动分批）`}>批量分诊</button>
        {picked.length > 0 && (
          <>
            <button className="btn btn-primary" onClick={() => bulk('done')}>标为{msgEnum.label('done')}</button>
            <button className="btn btn-outline" onClick={() => bulk('ignore')}>忽略</button>
          </>
        )}
        <button className="btn btn-outline" onClick={onOpenQueue} title="分诊这类按消息发起的流程执行：进行中的和最近结束的">处理队列{activeN > 0 && <span className="seg-n">{activeN}</span>}</button>
        {picked.length > 0 && <button className="btn btn-ghost" onClick={() => setSel(new Set())}>取消选择</button>}
      </div>
      {triaging && (
        <TriageBar sops={sops} runs={runs} targets={picked.length ? picked : rows}
          scope={picked.length ? `勾选的 ${picked.length} 条` : `当前筛选结果全部 ${rows.length} 条`}
          onCancel={() => setTriaging(false)}
          onBatch={(sopId, ids, rerun) => onBatchTriage(sopId, ids, rerun)}
          onDone={(r) => {
            setTriaging(false)
            setSel(new Set())
            setTriageNote(`分诊发起 ${r.started} 条${r.skipped ? `，跳过 ${r.skipped} 条已跑过的` : ''}`)
          }} />
      )}
      {tabs?.any && (
        <div className="msg-tabs-row">
          <div className="msg-tabs" role="tablist" aria-label="群组">
            {tabs.tabs.map((t) => (
              <button key={t.value || 'all'} role="tab" aria-selected={conv === t.value} className={cls(conv === t.value && 'on')} onClick={() => setConv(t.value)}
                ref={conv === t.value ? (el) => { el?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) } : undefined}
                title={t.value ? `${t.label}：${t.pending} 条${msgEnum.label('pending')}` : undefined}>
                <span className="msg-tab-label">{t.label}</span>{t.pending > 0 && <span className="seg-n">{t.pending}</span>}
              </button>
            ))}
          </div>
          {tabs.more.length > 0 && (
            <SearchSelect value={moreOn ? conv : ''} onChange={setConv} placeholder={tabs.moreGroups ? `更多群组 ${tabs.moreGroups}` : '单个私聊'} options={tabs.more}
              searchPlaceholder="搜群名、发信人" aria-label="更多群组和私聊" />
          )}
        </div>
      )}
      {channel && groupOn && (
        <div className="msg-group-bar">
          <span className="muted">默认归属</span>
          <SearchSelect value={groupProjects[conv] ?? ''} onChange={(v) => onSetGroupProject(conv, v || null)} noneLabel="不归项目" placeholder="设为项目"
            searchPlaceholder="搜项目" aria-label="群组默认归属的项目" missingLabel={() => '已删除的项目'} options={projectOptions} />
          <span className="muted">这个群里没单独归项目的消息都算到这个项目，项目「沟通」里能看到</span>
        </div>
      )}
      {conv && !conv.startsWith('dm:') && (
        <SentStrip sent={outbox.filter((s) => s.key === conv)} onSend={() => setSending({ key: conv })}
          onResend={(s) => addSent({ key: s.key, channel: s.channel, connector_id: s.connector_id, name: s.name, text: s.text })} />
      )}

      {viewRows.length === 0 ? (
        <div className="empty">
          <div className="empty-title">{mine === 'at' ? '没有 @我 的消息' : view === 'pending' && !conv ? `${msgEnum.label('pending')}的消息都清完了` : '这里没有消息'}</div>
          <div className="muted">{view === 'pending' && !conv ? '新消息会按连接器的同步间隔收进来' : '换个状态、渠道或会话看看'}</div>
        </div>
      ) : (
        <div className="msg-list">
          {shown.map((r, i) => {
            const day = dayLabel(rowTime(r))
            const dayHead = (i === 0 || dayLabel(rowTime(shown[i - 1])) !== day) && <div className="msg-day">{day}<span className="seg-n">{dayCount.get(day)}</span></div>
            if (r.kind !== 'single') return <Fragment key={r.key}>{dayHead}{groupRow(r)}</Fragment>
            const m = r.head
            const parent = m.thread?.parent_id ? byId.get(m.thread.parent_id) : undefined
            const hint = threadHint(m, parent, parent && whoOf(parent)?.name)
            const ch = channelOf(m.channel)
            const who = whoOf(m)
            const conn = connectors.find((c) => c.id === m.connector_id)
            const blocker = replyBlocker(conn)
            const rel = relOf(m)
            const task = taskOf(m.id)
            return (
              <Fragment key={m.id}>
              {dayHead}
              <div role="button" tabIndex={0} className={cls('msg', selected === m.id && 'sel', !m.read && 'unread', m.status !== 'pending' && 'msg-closed', r.faded && 'msg-faded')}
                title={r.faded ? '原消息不在当前筛选里，消息列有新回复才显示' : undefined}
                onClick={() => onOpen(m.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(m.id)}>
                <span className="msg-unread" />
                {pickBox(r.faded ? [] : [m], `选中 ${who?.name ?? m.sender_name} 的消息`)}
                <Avatar name={who?.name ?? m.sender_name} size={34} src={who?.photo} />
                <div className="msg-main">
                  <div className="msg-top">
                    <span className="msg-who">{who?.name ?? m.sender_name}</span>
                    {!who && <span className="msg-stranger">未存联系人</span>}
                    <ImMark ch={ch} compact />
                    {conn && broken.includes(conn) && <span className="state state-bad" title={conn.error}>渠道异常</span>}
                    <span className="msg-conv">{m.conversation || '私聊'}</span>
                    <TriageTag run={lastTriage.get(m.id)} onClick={onOpenQueue} onOpenAdvice={() => onOpenTriage(m.id)} />
                    {rel && rel !== 'dm' && <span className={cls('rel-tag', rel === 'me' && 'rel-me')}>{RELEVANCE[rel]}</span>}
                    {m.thread && (parent
                      ? <button className="thread-tag" title={`${hint}，点开看整个消息列`} onClick={(e) => { e.stopPropagation(); onOpen(parent.id) }} onKeyDown={(e) => e.stopPropagation()}>消息列回复</button>
                      : <span className="thread-tag" title={`${hint}（原消息还没收到）`}>消息列回复</span>)}
                    {threadTags(r)}
                    <span className="spacer" />
                    {m.status !== 'pending' && (
                      <span className="state" style={stateStyle(msgEnum.color(m.status))}
                        title={m.status === 'expired' && m.expired_at ? `${fmtMD(m.expired_at)} 超期没处理，标为${msgEnum.label('expired')}` : muteReasonOf(m) || undefined}>{muteReasonOf(m) ? '自动忽略' : msgEnum.label(m.status)}</span>
                    )}
                    {isSnoozed(m) && <span className="state state-snooze">{new Date(m.snooze_until!).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 提醒</span>}
                    {m.replies.length > 0 && <span className="state">已回复 {m.replies.length}</span>}
                    {task && <button className="state state-task state-link" onClick={(e) => { e.stopPropagation(); onToTask(m.id) }} onKeyDown={(e) => e.stopPropagation()} title="打开这条任务">已转任务 {task}</button>}
                    {linkTags([m.id])}
                    {matTag([m.id])}
                    {sentTag([m.id])}
                    <span className="msg-time">{timeAgo(m.at)}</span>
                  </div>
                  <div className="msg-text"><MentionText text={m.text} /></div>
                  {hint && <div className="thread-hint">{hint}</div>}
                  <AttachmentChips atts={m.attachments} />
                </div>
                <div className="msg-actions" onClick={(e) => e.stopPropagation()}>
                  {m.status === 'pending' ? (
                    <>
                      <button className="act act-primary" onClick={() => onAct(m.id, { kind: 'done' })} title={`标为${msgEnum.label('done')} (E)`}>{msgEnum.label('done')}</button>
                      {blocker
                        ? <button className="act" disabled title={blocker}>回复{caret}</button>
                        : <Menu className="act" label={<>回复{caret}</>}>{(close) => <QuickReplyItems close={close} onPick={(text, done) => onAct(m.id, { kind: 'reply', done, ...quickReplyText(m, who?.name ?? m.sender_name, text) })} />}</Menu>}
                      <Menu className="act" label={<>稍后{caret}</>}>
                        {(close) => snoozeOptions().map((o) => (
                          <button key={o.label} className="menu-item" onClick={() => { onAct(m.id, { kind: 'snooze', until: o.until.toISOString() }); close() }}>{o.label}</button>
                        ))}
                      </Menu>
                      {!task && <button className="act" onClick={() => onToTask(m.id)}>转任务</button>}
                      {agentMenu([m.id])}
                      <button className="act act-quiet" onClick={() => onAct(m.id, { kind: 'ignore' })}>忽略</button>
                    </>
                  ) : m.status === 'expired' ? (
                    // 已过期（IM-07）：还没处理，能标已处理、忽略；重新打开回到待处理，过期重新算。不能稍后
                    <>
                      <button className="act act-primary" onClick={() => onAct(m.id, { kind: 'done' })} title={`标为${msgEnum.label('done')} (E)`}>{msgEnum.label('done')}</button>
                      <button className="act" onClick={() => onAct(m.id, { kind: 'reopen' })} title={`回到${msgEnum.label('pending')}，重新计算过期`}>重新打开</button>
                      <button className="act act-quiet" onClick={() => onAct(m.id, { kind: 'ignore' })}>忽略</button>
                    </>
                  ) : (
                    <>{agentMenu([m.id])}<button className="act" onClick={() => onAct(m.id, { kind: 'reopen' })}>重新打开</button></>
                  )}
                </div>
              </div>
              </Fragment>
            )
          })}
          {viewRows.length > limit && (
            <button className="msg-more" onClick={() => setLim({ sig, n: limit + PAGE })}>
              加载更多<span className="seg-n">还有 {viewRows.length - limit} 行</span>
            </button>
          )}
        </div>
      )}
      {mutesOpen && (
        <MutesDrawer onClose={() => setMutesOpen(false)}
          onShow={(name) => { setMutesOpen(false); setChannel(''); setConv(''); setMine(''); setUnreadOnly(false); setView('ignored'); setQ(name) }} />
      )}
      {groupsOpen && (
        <GroupAdminDrawer messages={messages} contacts={contacts} projects={projects} groupProjects={groupProjects} onSetGroupProject={onSetGroupProject}
          onClose={() => setGroupsOpen(false)} onSend={(key) => setSending({ key })}
          onOpenConversation={(ch, key) => { setGroupsOpen(false); setChannel(ch); setConv(key) }} />
      )}
      {sending && (
        <SendDialog messages={messages} contacts={contacts} connectors={connectors} preset={sending.key} onCancel={() => setSending(null)}
          onSend={(t, c, text) => { addSent({ key: t.key, channel: t.channel, connector_id: c.id, name: t.name, text }); setSending(null) }} />
      )}
    </div>
  )
}

/* ---------- 抽屉：会话 + 处理 + 反馈 ---------- */

export function MessageDrawer({ msg, contact, connector, members = [], onClose, onAct, onOpenContact, onSaveContact, task, onToTask, deal, onToDeal, onFixConnector, projects, msgProjects, onFetchAttachment, onAddAttachment, onSetProject , links, onStartSession, onOpenSession, onToMaterial, onOpenMaterial, triage, thread = [], threadParent, onOpenMessage, onActOther }: {
  /** 「分诊建议」一节（SPEC-messages-2.41），放在正文下面 */
  triage?: ReactNode
  /** 转项目资料（SPEC-messages-2.38）：打开弹窗；转过的去项目资料页 */
  onToMaterial: () => void; onOpenMaterial: (projectId: string, materialId: string) => void
  /** 归到项目、清除归属（消息分流）；null 是清除 */
  onSetProject: (projectId: string | null) => void
  /** 附件：获取到本地、加进项目支持材料；msgProjects 是这条消息所在的项目 */
  projects: Project[]; msgProjects: string[]
  onFetchAttachment: (attId: string) => void; onAddAttachment: (attId: string, projectId: string) => void
  onFixConnector: () => void
  msg: Message; contact: Contact | undefined; connector: Connector | undefined
  /** @ 候选（SPEC-messages-2.46）：联系人在前，再是会话里发过言、没认上联系人的 */
  members?: Member[]
  onClose: () => void; onAct: (a: MsgAction) => void
  onOpenContact: (id: string) => void; onSaveContact: () => void
  /** 这条消息转出来的任务；onToTask 没转过就新建，转过就打开 */
  task?: { ref: string; title: string }; onToTask: () => void
  /** 品牌询价转商单（视频模块开着才有，VID-08p）：没转过就新建，转过就打开 */
  deal?: { title: string; brand: string }; onToDeal?: () => void
  /** 交给 Agent（SPEC-messages-2.36）：发起过的会话、拆出来的任务数；发起会话、拆分任务 */
  links: { sessions: string[]; tasks: number }; onStartSession: (intent: SessionIntent) => void; onOpenSession: (id: string) => void
  /** 消息列回复（SPEC-messages-2.45）：这条作为原消息时整个消息列（按时间）；这条是消息列回复时它的原消息；打开另一条；处理消息列里的某一条 */
  thread?: Message[]; threadParent?: Message; onOpenMessage?: (id: string) => void; onActOther?: (id: string, a: MsgAction) => void
}) {
  const msgEnum = useEnumView('msg_status')
  const ch = channelOf(msg.channel)
  const blocker = replyBlocker(connector)
  // 以谁的身份发出去（IM-06）：Slack 按连接器的身份写，别的渠道不写
  const sendAs = blocker ? null : sendAsText(connector)
  const [text, setText] = useState('')
  const [alsoDone, setAlsoDone] = useState(true)
  // 自动忽略（SPEC-messages-9）：发信人处的按钮、状态条里的原因
  useMutes()
  const muteReason = muteReasonOf(msg)
  const [muteNote, setMuteNote] = useState('')
  // 回复时 @ 对方（SPEC-messages-2.46）：群聊才有开关，默认打开、记在本机；私聊不加
  const [atOn, setAtOn] = useReplyMention()
  const target: MentionPick | null = msg.conversation ? { id: msg.sender_id, name: contact?.name ?? msg.sender_name } : null
  const [picked, setPicked] = useState<MentionPick[]>([])
  const send = (t: string, done: boolean, fromBox = true) => {
    if (!t.trim() || blocker) return
    const out = composeReply(t, target && atOn ? target : null, picked)
    onAct({ kind: 'reply', text: out.text, done, mentions: out.mentions })
    if (fromBox) { setText(''); setPicked([]) }
  }

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <ImMark ch={ch} compact />
        <span className="drawer-kicker">{msg.conversation || '私聊'} · {connector?.name ?? '渠道已删除'}</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="drawer-body">
        {connector?.status === 'error' && (
          <div className="detail-alert">
            <span><b>{connector.name} 连接异常</b>{connector.error}。{connector.last_sync_at && `最后一次同步在 ${timeAgo(connector.last_sync_at)}，之后这个渠道的消息没有收进来，也回复不了。`}</span>
            <button className="act" onClick={onFixConnector}>去修复</button>
          </div>
        )}
        {/* 处理状态是一条细条：左边是现在的状态，右边是能做的操作 */}
        {(() => {
          const snoozed = isSnoozed(msg)
          const tone = snoozed ? 'snooze' : msg.status
          const rel = relevance(msg)
          return (
            <div className={cls('msg-strip', `ms-${tone}`)}>
              <span className="ms-dot" style={snoozed ? undefined : { background: msgEnum.color(msg.status) }} />
              <b>{snoozed ? '稍后提醒' : msgEnum.label(msg.status)}</b>
              {snoozed && <span className="ms-sub">{new Date(msg.snooze_until!).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 再提醒</span>}
              {msg.status === 'expired' && msg.expired_at && <span className="ms-sub">{fmtMD(msg.expired_at)} 超期没处理</span>}
              {rel && rel !== 'dm' && <span className="ms-sub">{RELEVANCE[rel]}</span>}
              {msg.replies.length > 0 && <span className="ms-sub">已回复 {msg.replies.length} 次</span>}
              {muteReason && <span className="ms-sub">{muteReason}</span>}
              <span className="spacer" />
              {msg.status === 'pending' ? (
                <>
                  <button className="ms-act ms-primary" onClick={() => onAct({ kind: 'done' })}>标为{msgEnum.label('done')}</button>
                  <Menu className="ms-act" label={<>稍后{caret}</>}>
                    {(close) => snoozeOptions().map((o) => (
                      <button key={o.label} className="menu-item" onClick={() => { onAct({ kind: 'snooze', until: o.until.toISOString() }); close() }}>{o.label}</button>
                    ))}
                  </Menu>
                  <button className="ms-act" onClick={() => onAct({ kind: 'ignore' })}>忽略</button>
                </>
              ) : msg.status === 'expired' ? (
                <>
                  <button className="ms-act ms-primary" onClick={() => onAct({ kind: 'done' })}>标为{msgEnum.label('done')}</button>
                  <button className="ms-act" onClick={() => onAct({ kind: 'reopen' })}>重新打开</button>
                  <button className="ms-act" onClick={() => onAct({ kind: 'ignore' })}>忽略</button>
                </>
              ) : <button className="ms-act" onClick={() => onAct({ kind: 'reopen' })}>重新打开</button>}
            </div>
          )
        })()}
        <div className="sender">
          <Avatar name={contact?.name ?? msg.sender_name} size={40} src={contact?.photo} />
          <div className="sender-text">
            <div className="sender-name">{contact?.name ?? msg.sender_name}</div>
            <div className="muted mono">{ch.label} · {msg.sender_id}</div>
          </div>
          <div className="spacer" />
          {contact
            ? <button className="btn btn-ghost" onClick={() => onOpenContact(contact.id)}>查看联系人</button>
            : <button className="btn btn-ghost" onClick={onSaveContact}>存为联系人</button>}
          <MuteButton msg={msg} onDone={setMuteNote} />
        </div>
        {muteNote && <div className="ok-text mute-note">{muteNote}</div>}

        {msg.thread && (
          <div className="thread-from">
            <span className="thread-tag">消息列回复</span>
            <span className="muted ellipsis">{threadHint(msg, threadParent)}</span>
            {threadParent && onOpenMessage && <button className="act" onClick={() => onOpenMessage(threadParent.id)}>打开原消息</button>}
          </div>
        )}
        <div className="thread">
          <div className="bubble bubble-in">
            <div><MentionText text={msg.text} /></div>
            <div className="bubble-meta">{new Date(msg.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
          </div>
          {msg.replies.map((r) => (
            <div key={r.id} className="bubble bubble-out">
              <div>{r.text}</div>
              <div className="bubble-meta">我 · {timeAgo(r.at)}</div>
            </div>
          ))}
        </div>

        {thread.length > 0 && (
          <ThreadReplies key={msg.id} parent={msg} replies={thread} onOpen={onOpenMessage} onActOther={onActOther} onActParent={onAct} />
        )}

        {triage}

        <AttachmentPanel msg={msg} projects={projects} suggested={msgProjects} onFetch={onFetchAttachment} onAdd={onAddAttachment} />

        {/* 归到项目：分流流程会自动设，这里能改、能清除；归了的消息出现在项目「沟通」里 */}
        <div className="section-label">项目</div>
        <div className="act-row">
          <SearchSelect value={msg.project_id ?? ''} onChange={(v) => onSetProject(v || null)} noneLabel="不归项目" placeholder="归到项目"
            searchPlaceholder="搜项目" aria-label="归到项目" missingLabel={() => '已删除的项目'}
            options={projects.map((pj) => ({ value: pj.id, label: pj.name }))} />
          {msg.project_id && msg.project_source !== 'conversation' && <button className="act" onClick={() => onSetProject(null)}>清除</button>}
          <span className="muted">{msg.project_source === 'conversation' ? '按群组默认归属；在这里改只改这一条'
            : msg.project_id ? '项目「沟通」里能看到这条' : '归到项目后，项目「沟通」里能看到这条'}</span>
        </div>

        <div className="section-label">转任务</div>
        {task ? (
          <div className="act-row"><span className="muted">已转为任务 {task.ref} {task.title}</span><button className="act" onClick={onToTask}>打开任务</button></div>
        ) : (
          <div className="act-row"><button className="act" onClick={onToTask}>转为任务</button><span className="muted">原消息会记在任务里，方便回看</span></div>
        )}

        <AgentSection links={links} onOpenSession={onOpenSession} />
        <MaterialSection notes={notesOf(projects, [msg.id])} onOpen={onOpenMaterial} />

        {onToDeal && (
          <>
            <div className="section-label">转商单</div>
            {deal ? (
              <div className="act-row"><span className="muted">已转为商单 {deal.brand} · {deal.title}</span><button className="act" onClick={onToDeal}>打开商单</button></div>
            ) : (
              <div className="act-row"><button className="act" onClick={onToDeal}>转为商单</button><span className="muted">品牌来问报价时用：询价人、品牌、项目按这条消息预填</span></div>
            )}
          </>
        )}

        <div className="section-label">反馈</div>
        {blocker ? (
          <div className="banner banner-warn">{blocker}</div>
        ) : (
          <div className="quick-replies">
            {!QUICK_REPLIES.length && <span className="muted">没有快捷回复，到设置的即时通讯里添加</span>}
            {QUICK_REPLIES.map((qr) => (
              <button key={qr.text} className="qr" onClick={() => send(qr.text, qr.done, false)} title={qr.done ? `发送并标为${msgEnum.label('done')}` : '发送'}>
                {qr.text}{qr.done && <span className="qr-done">并处理</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="drawer-foot reply-box">
        <MentionBox value={text} onChange={setText} onPick={(p) => setPicked((x) => [...x, p])} members={members} disabled={!!blocker} label="回复内容"
          placeholder={blocker ? '这个会话现在不能回复' : `回复 ${contact?.name ?? msg.sender_name}${msg.thread ? '（发到同一个消息列）' : ''}，输入 @ 提到别人，⌘ Enter 发送`}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(text, alsoDone) }} />
        <div className="reply-bar">
          <label className="check"><input type="checkbox" checked={alsoDone} onChange={(e) => setAlsoDone(e.target.checked)} disabled={!!blocker} />发送后标为{msgEnum.label('done')}</label>
          {target && <label className="check" title={`发送时在正文开头 @${target.name}，对方会收到通知`}><input type="checkbox" checked={atOn} onChange={(e) => setAtOn(e.target.checked)} disabled={!!blocker} />回复时 @ 对方</label>}
          <div className="spacer" />
          <ReplyBarActions many={false} onStart={onStartSession} onToMaterial={onToMaterial} />
          {sendAs && <span className="send-as">{sendAs}</span>}
          <button className="btn btn-primary" disabled={!!blocker || !text.trim()} title={sendAs ?? undefined} onClick={() => send(text, alsoDone)}>发送</button>
        </div>
      </div>
    </aside>
  )
}
