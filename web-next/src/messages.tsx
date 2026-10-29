import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { PageTitle } from './topbar'
import { ALL_HANDLES, IM_CHANNELS, MY_HANDLES, QUICK_REPLIES, TOOLS, type Connector, type Contact, type Message } from './data'
import { Avatar, ImMark, cls, timeAgo } from './ui'
import { AttachmentChips, AttachmentPanel } from './attachments'
import type { Project } from './projectdata'
import { useEnumView } from './enumdata'
import { SearchSelect, type SearchOption } from './searchselect'

export type MsgAction =
  | { kind: 'done' | 'ignore' | 'reopen' | 'read' }
  | { kind: 'snooze'; until: string }
  | { kind: 'reply'; text: string; done: boolean }

type View = 'pending' | 'snoozed' | 'done' | 'ignored' | 'all'

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

/** 状态小标签按枚举颜色上色，和原来「已处理」的绿色标签同一种做法 */
const stateStyle = (c: string): React.CSSProperties => ({ color: c, background: `color-mix(in srgb, ${c} 12%, transparent)` })

export function MessagesPage({ messages, contacts, connectors, selected, onOpen, onAct, onGoConnectors, onToTask, taskOf, onSync, syncing, syncResult }: {
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
    .filter((m) => inView(m, view) && (!channel || m.channel === channel) && (!conv || convKey(m) === conv) && (!unreadOnly || !m.read) && relOk(m)
      && (!kw || [m.text, m.sender_name, m.conversation, whoOf(m)?.name ?? ''].some((v) => v.toLowerCase().includes(kw))))
    .sort((a, b) => b.at.localeCompare(a.at)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [messages, people, rels, view, channel, conv, unreadOnly, mine, kw])

  // 状态 seg：待处理、稍后 + 枚举里的状态；状态多时 seg 只放前几个，其余收进「更多状态」
  const views = msgEnum.items.flatMap((i) => (i.key === 'pending' ? [[i.key, i.label], ['snoozed', '稍后']] : [[i.key, i.label]])) as [View, string][]
  const segViews = views.length > VIEW_SEG_MAX + 1 ? views.slice(0, VIEW_SEG_MAX) : views
  const moreViews = views.slice(segViews.length)
  const count = (v: View) => messages.filter((m) => inView(m, v) && (!channel || m.channel === channel) && (!conv || convKey(m) === conv) && relOk(m)).length
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

  // 先渲染 PAGE 条；筛选一变就回到第一页（按筛选条件记，不用 effect 清）
  const sig = [view, channel, conv, unreadOnly, mine, kw].join('|')
  const [lim, setLim] = useState({ sig, n: PAGE })
  const limit = lim.sig === sig ? lim.n : PAGE
  const shown = rows.slice(0, limit)
  const dayCount = new Map<string, number>()
  for (const m of rows) dayCount.set(dayLabel(m.at), (dayCount.get(dayLabel(m.at)) ?? 0) + 1)
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
      const i = rows.findIndex((r) => r.id === selected)
      if (e.key === 'j' && rows.length) {
        const n = Math.min(i + 1, rows.length - 1)
        // 走到已渲染的末尾就再加载一页
        if (n >= limit) setLim({ sig, n: limit + PAGE })
        onOpen(rows[n].id)
      }
      if (e.key === 'k' && rows.length) onOpen(rows[Math.max(i - 1, 0)].id)
      // 只对待处理（含稍后）的生效，已处理、已忽略的不动
      if (e.key === 'e' && selected && messages.find((m) => m.id === selected)?.status === 'pending') onAct(selected, { kind: 'done' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rows, messages, selected, onOpen, onAct, limit, sig])

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
        {convOptions.length > 1 && (
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

      {rows.length === 0 ? (
        <div className="empty">
          <div className="empty-title">{mine === 'at' ? '没有 @我 的消息' : view === 'pending' && !conv ? `${msgEnum.label('pending')}的消息都清完了` : '这里没有消息'}</div>
          <div className="muted">{view === 'pending' && !conv ? '新消息会按连接器的同步间隔收进来' : '换个状态、渠道或会话看看'}</div>
        </div>
      ) : (
        <div className="msg-list">
          {shown.map((m, i) => {
            const ch = channelOf(m.channel)
            const who = whoOf(m)
            const conn = connectors.find((c) => c.id === m.connector_id)
            const blocker = replyBlocker(conn)
            const rel = relOf(m)
            const task = taskOf(m.id)
            const day = dayLabel(m.at)
            return (
              <Fragment key={m.id}>
              {(i === 0 || dayLabel(shown[i - 1].at) !== day) && <div className="msg-day">{day}<span className="seg-n">{dayCount.get(day)}</span></div>}
              <div role="button" tabIndex={0} className={cls('msg', selected === m.id && 'sel', !m.read && 'unread', m.status !== 'pending' && 'msg-closed')}
                onClick={() => onOpen(m.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(m.id)}>
                <span className="msg-unread" />
                <Avatar name={who?.name ?? m.sender_name} size={34} src={who?.photo} />
                <div className="msg-main">
                  <div className="msg-top">
                    <span className="msg-who">{who?.name ?? m.sender_name}</span>
                    {!who && <span className="msg-stranger">未存联系人</span>}
                    <ImMark ch={ch} compact />
                    {conn && broken.includes(conn) && <span className="state state-bad" title={conn.error}>渠道异常</span>}
                    <span className="msg-conv">{m.conversation || '私聊'}</span>
                    {rel && rel !== 'dm' && <span className={cls('rel-tag', rel === 'me' && 'rel-me')}>{RELEVANCE[rel]}</span>}
                    <span className="spacer" />
                    {m.status !== 'pending' && <span className="state" style={stateStyle(msgEnum.color(m.status))}>{msgEnum.label(m.status)}</span>}
                    {isSnoozed(m) && <span className="state state-snooze">{new Date(m.snooze_until!).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 提醒</span>}
                    {m.replies.length > 0 && <span className="state">已回复 {m.replies.length}</span>}
                    {task && <button className="state state-task state-link" onClick={(e) => { e.stopPropagation(); onToTask(m.id) }} onKeyDown={(e) => e.stopPropagation()} title="打开这条任务">已转任务 {task}</button>}
                    <span className="msg-time">{timeAgo(m.at)}</span>
                  </div>
                  <div className="msg-text"><MentionText text={m.text} /></div>
                  <AttachmentChips atts={m.attachments} />
                </div>
                <div className="msg-actions" onClick={(e) => e.stopPropagation()}>
                  {m.status === 'pending' ? (
                    <>
                      <button className="act act-primary" onClick={() => onAct(m.id, { kind: 'done' })} title={`标为${msgEnum.label('done')} (E)`}>{msgEnum.label('done')}</button>
                      {blocker
                        ? <button className="act" disabled title={blocker}>回复{caret}</button>
                        : <Menu className="act" label={<>回复{caret}</>}>{(close) => <QuickReplyItems close={close} onPick={(text, done) => onAct(m.id, { kind: 'reply', text, done })} />}</Menu>}
                      <Menu className="act" label={<>稍后{caret}</>}>
                        {(close) => snoozeOptions().map((o) => (
                          <button key={o.label} className="menu-item" onClick={() => { onAct(m.id, { kind: 'snooze', until: o.until.toISOString() }); close() }}>{o.label}</button>
                        ))}
                      </Menu>
                      {!task && <button className="act" onClick={() => onToTask(m.id)}>转任务</button>}
                      <button className="act act-quiet" onClick={() => onAct(m.id, { kind: 'ignore' })}>忽略</button>
                    </>
                  ) : (
                    <button className="act" onClick={() => onAct(m.id, { kind: 'reopen' })}>重新打开</button>
                  )}
                </div>
              </div>
              </Fragment>
            )
          })}
          {rows.length > limit && (
            <button className="msg-more" onClick={() => setLim({ sig, n: limit + PAGE })}>
              加载更多<span className="seg-n">还有 {rows.length - limit} 条</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/* ---------- 抽屉：会话 + 处理 + 反馈 ---------- */

export function MessageDrawer({ msg, contact, connector, onClose, onAct, onOpenContact, onSaveContact, task, onToTask, deal, onToDeal, onFixConnector, projects, msgProjects, onFetchAttachment, onAddAttachment }: {
  /** 附件：获取到本地、加进项目支持材料；msgProjects 是这条消息所在的项目 */
  projects: Project[]; msgProjects: string[]
  onFetchAttachment: (attId: string) => void; onAddAttachment: (attId: string, projectId: string) => void
  onFixConnector: () => void
  msg: Message; contact: Contact | undefined; connector: Connector | undefined
  onClose: () => void; onAct: (a: MsgAction) => void
  onOpenContact: (id: string) => void; onSaveContact: () => void
  /** 这条消息转出来的任务；onToTask 没转过就新建，转过就打开 */
  task?: { ref: string; title: string }; onToTask: () => void
  /** 品牌询价转商单（视频模块开着才有，VID-08p）：没转过就新建，转过就打开 */
  deal?: { title: string; brand: string }; onToDeal?: () => void
}) {
  const msgEnum = useEnumView('msg_status')
  const ch = channelOf(msg.channel)
  const blocker = replyBlocker(connector)
  const [text, setText] = useState('')
  const [alsoDone, setAlsoDone] = useState(true)
  const send = (t: string, done: boolean) => {
    if (!t.trim() || blocker) return
    onAct({ kind: 'reply', text: t.trim(), done })
    setText('')
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
              {rel && rel !== 'dm' && <span className="ms-sub">{RELEVANCE[rel]}</span>}
              {msg.replies.length > 0 && <span className="ms-sub">已回复 {msg.replies.length} 次</span>}
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
        </div>

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

        <AttachmentPanel msg={msg} projects={projects} suggested={msgProjects} onFetch={onFetchAttachment} onAdd={onAddAttachment} />

        <div className="section-label">转任务</div>
        {task ? (
          <div className="act-row"><span className="muted">已转为任务 {task.ref} {task.title}</span><button className="act" onClick={onToTask}>打开任务</button></div>
        ) : (
          <div className="act-row"><button className="act" onClick={onToTask}>转为任务</button><span className="muted">原消息会记在任务里，方便回看</span></div>
        )}

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
            {QUICK_REPLIES.map((qr) => (
              <button key={qr.text} className="qr" onClick={() => send(qr.text, qr.done)} title={qr.done ? `发送并标为${msgEnum.label('done')}` : '发送'}>
                {qr.text}{qr.done && <span className="qr-done">并处理</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="drawer-foot reply-box">
        <textarea rows={2} value={text} disabled={!!blocker}
          placeholder={blocker ? '这个会话现在不能回复' : `回复 ${contact?.name ?? msg.sender_name}，⌘ Enter 发送`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(text, alsoDone) }} />
        <div className="reply-bar">
          <label className="check"><input type="checkbox" checked={alsoDone} onChange={(e) => setAlsoDone(e.target.checked)} disabled={!!blocker} />发送后标为{msgEnum.label('done')}</label>
          <div className="spacer" />
          <button className="btn btn-primary" disabled={!!blocker || !text.trim()} onClick={() => send(text, alsoDone)}>发送</button>
        </div>
      </div>
    </aside>
  )
}
