import { useMemo, useState } from 'react'
import type { Agent, Session } from './agentdata'
import { AgentAvatar } from './agents'
import { listenedChannels } from './channelpick'
import { IM_CHANNELS, type Connector, type Contact, type Message } from './data'
import { MentionText, contactIndex, isSnoozed, senderKey } from './messages'
import { SearchSelect, matchOption } from './searchselect'
import { STAKE_ROLE, type Project, type ProjectChat, type StakeRole } from './projectdata'
import { RUN_STATUS, runStatus, type Sop, type SopRun } from './sopflow'
import type { Task, TaskStatus } from './taskdata'
import { isOpenTask } from './taskdata'
import { PriorityTag, TaskStatusPill } from './tasks'
import { useEnumView } from './enumdata'
import { Avatar, cls, timeAgo } from './ui'
import { AttachmentChips, AttachmentsHint } from './attachments'
import { ApproveConfirm } from './devloop'

// 项目里的沟通、干系人、任务、SOP、Agent 页签。数据都在各自模块里，项目只记关联关系

const chLabel = (k: string) => IM_CHANNELS.find((c) => c.key === k)?.label ?? k
const Pill = ({ label, color }: { label: string; color: string }) => <span className="pill" style={{ '--c': color } as React.CSSProperties}><span className="pill-dot" />{label}</span>
const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

// 渠道键：群聊按渠道 + 群名，私聊按联系人。消息和渠道都换成键再比，不用逐条扫联系人
const chatKey = (c: ProjectChat) => (c.kind === 'group' ? `g:${c.channel}|${c.conversation}` : `d:${c.contact_id}`)
const msgKey = (m: Message, people: Map<string, Contact>) => (m.conversation ? `g:${m.channel}|${m.conversation}` : `d:${people.get(senderKey(m))?.id ?? ''}`)

/** 一条消息属于这个项目的哪个沟通渠道；people 是 contactIndex(contacts)，批量调用时传进来省得每次重建 */
export function chatOf(m: Message, chats: ProjectChat[], contacts: Contact[], people = contactIndex(contacts)): ProjectChat | undefined {
  const k = msgKey(m, people)
  return chats.find((c) => chatKey(c) === k)
}
export function projectMessages(p: Project, messages: Message[], contacts: Contact[], people = contactIndex(contacts)) {
  // 绑定会话里的消息，加上归到这个项目的（消息分流），同一条只算一次
  const keys = new Set(p.chats.map(chatKey))
  return messages.filter((m) => m.project_id === p.id || (keys.size > 0 && keys.has(msgKey(m, people))))
}
/** 沟通消息先渲染这么多条 */
const MSG_PAGE = 50
/** 绑定弹层里没搜的时候露几个最近联系的私聊 */
const DM_PEEK = 8

/* ---------- 沟通：私聊 + 群聊 ---------- */

export function CommsTab({ p, messages, contacts, connectors = [], onChange, onOpenMessage, onGoAttachments }: {
  p: Project; messages: Message[]; contacts: Contact[]
  /** IM 连接器：配置里监听的频道也算可绑的群，新建的群收到第一条消息前也能绑 */
  connectors?: Connector[]
  onChange: (x: Partial<Project>) => void; onOpenMessage: (id: string) => void
  /** 去「附件」标签（SPEC-projects-5）；不传时右栏顶上不出「N 个附件待决定」那一行 */
  onGoAttachments?: () => void
}) {
  const msgEnum = useEnumView('msg_status')
  const [filter, setFilter] = useState('')
  const [adding, setAdding] = useState(false)
  const [bq, setBq] = useState('')
  const people = useMemo(() => contactIndex(contacts), [contacts])
  const mine = projectMessages(p, messages, contacts, people).sort((a, b) => b.at.localeCompare(a.at))
  const keyOf = new Map(p.chats.map((c) => [chatKey(c), c.id]))
  const chatIdOf = (m: Message) => keyOf.get(msgKey(m, people))
  const rows = mine.filter((m) => !filter || chatIdOf(m) === filter)
  const label = (c: ProjectChat) => (c.kind === 'group' ? c.conversation : contacts.find((x) => x.id === c.contact_id)?.name ?? '已删除的联系人')
  // 可以绑的群：现有消息里出现过的群聊，加上连接器配置里监听的频道（还没收到消息的排最后），去掉已经绑了的
  // 没搜的时候群聊也只露最近有消息的几个
  const seen = new Map([...messages].sort((a, b) => a.at.localeCompare(b.at)).filter((m) => m.conversation).map((m) => [`${m.channel}|${m.conversation}`, { channel: m.channel, conversation: m.conversation, at: m.at }]))
  // 监听频道存的是会话编号或名字（SPEC-settings-4.7c），换成 #名字 再和消息里的群名对
  for (const c of connectors) for (const name of listenedChannels(c)) {
    if (!seen.has(`${c.tool}|${name}`)) seen.set(`${c.tool}|${name}`, { channel: c.tool, conversation: name, at: '' })
  }
  const groupPool = [...seen.values()]
    .filter((m) => !keyOf.has(`g:${m.channel}|${m.conversation}`))
    .sort((a, b) => b.at.localeCompare(a.at))
  const groupMatched = groupPool.filter((m) => matchOption({ label: m.conversation, hint: chLabel(m.channel) }, bq))
  const groups = groupMatched.slice(0, bq.trim() ? 50 : DM_PEEK)
  // 私聊：没搜的时候只露最近联系的几个，搜了再从全部联系人里找
  const dmPool = contacts.filter((c) => !keyOf.has(`d:${c.id}`))
  const dmMatched = bq.trim()
    ? dmPool.filter((c) => matchOption({ label: c.name, hint: c.company, keywords: c.title }, bq))
    : [...dmPool].sort((a, b) => (b.last_contact_at ?? '').localeCompare(a.last_contact_at ?? ''))
  const dms = dmMatched.slice(0, bq.trim() ? 50 : DM_PEEK)
  const pendingBy = new Map<string, number>()
  // 待处理不含稍后，和 IM 消息页一致
  for (const m of mine) if (m.status === 'pending' && !isSnoozed(m)) { const id = chatIdOf(m); if (id) pendingBy.set(id, (pendingBy.get(id) ?? 0) + 1) }
  const pending = (c: ProjectChat) => pendingBy.get(c.id) ?? 0
  const bind = (c: ProjectChat) => { onChange({ chats: [...p.chats, c] }); setAdding(false); setBq('') }
  // 消息先渲染一页，换渠道筛选就回到第一页
  const [lim, setLim] = useState({ filter, n: MSG_PAGE })
  const limit = lim.filter === filter ? lim.n : MSG_PAGE

  return (
    <div className="pt-comms">
      <div className="pt-chats">
        <div className="mount-head"><div className="field-group-title">项目沟通渠道</div><button className="act" onClick={() => { setAdding(!adding); setBq('') }}>{adding ? '收起' : '绑定'}</button></div>
        {adding && (
          <div className="pt-bind">
            <div className="search search-sm pt-bind-search">
              <svg viewBox="0 0 16 16" width="13" height="13"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              <input autoFocus value={bq} placeholder="搜群名、联系人" onChange={(e) => setBq(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); if (bq) setBq(''); else setAdding(false) } }} />
            </div>
            <div className="menu-label">{bq.trim() || groupPool.length <= DM_PEEK ? '群聊' : `群聊 · 最近有消息的 ${DM_PEEK} 个`}</div>
            {groups.length ? groups.map((m) => (
              <button key={`${m.channel}|${m.conversation}`} className="menu-item" title={m.conversation} onClick={() => bind({ id: uid('ch'), kind: 'group', channel: m.channel, conversation: m.conversation })}>
                <span className="tag">{chLabel(m.channel)}</span><span className="ellipsis">{m.conversation}</span>{!m.at && <span className="list-sub">还没收到消息</span>}
              </button>
            )) : <div className="list-sub pt-bind-empty">{bq.trim() ? '没有匹配的群' : '没有可绑的群'}</div>}
            {groupMatched.length > groups.length && <div className="list-sub pt-bind-empty">{bq.trim() ? `还有 ${groupMatched.length - groups.length} 个，继续输入筛选` : `共 ${groupMatched.length} 个群，输入群名搜`}</div>}
            <div className="menu-label">{bq.trim() || dmPool.length <= DM_PEEK ? '私聊' : `私聊 · 最近联系的 ${DM_PEEK} 个`}</div>
            <div className="pt-bind-dms">
              {dms.map((c) => (
                <button key={c.id} className="menu-item" title={[c.name, c.company].filter(Boolean).join(' · ')} onClick={() => bind({ id: uid('ch'), kind: 'dm', contact_id: c.id })}>
                  <Avatar name={c.name} size={18} src={c.photo} /><span className="ellipsis">{c.name}</span><span className="list-sub ellipsis">{c.company}</span>
                </button>
              ))}
              {!dms.length && <div className="list-sub pt-bind-empty">{bq.trim() ? '没有匹配的联系人' : '联系人都已经绑过了'}</div>}
              {dmMatched.length > dms.length && <div className="list-sub pt-bind-empty">{bq.trim() ? `还有 ${dmMatched.length - dms.length} 个，继续输入筛选` : `共 ${dmMatched.length} 个联系人，输入名字或公司搜`}</div>}
            </div>
          </div>
        )}
        <button className={cls('pt-chat', !filter && 'on')} onClick={() => setFilter('')}>
          <span className="ellipsis">全部</span><span className="tree-count">{mine.length}</span>
        </button>
        {p.chats.map((c) => (
          <div key={c.id} className={cls('pt-chat', filter === c.id && 'on')} role="button" tabIndex={0} onClick={() => setFilter(c.id)}>
            {c.kind === 'group' ? <span className="tag">{chLabel(c.channel)}</span> : <span className="tag tag-dm">私聊</span>}
            <span className="ellipsis">{label(c)}</span>
            {pending(c) > 0 && <span className="side-dot" title={`${pending(c)} 条${msgEnum.label('pending')}`} />}
            <button className="icon-btn icon-btn-sm pt-unbind" title="解绑（不删消息）" onClick={(e) => { e.stopPropagation(); onChange({ chats: p.chats.filter((x) => x.id !== c.id) }); if (filter === c.id) setFilter('') }}>
              <svg viewBox="0 0 16 16" width="10" height="10"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            </button>
          </div>
        ))}
        {!p.chats.length && <div className="mount-empty">还没绑定。把项目群、对接人的私聊绑过来，项目里就只看这些消息</div>}
      </div>
      <div className="pt-msgs">
        {onGoAttachments && <AttachmentsHint p={p} messages={mine} onGo={onGoAttachments} />}
        {rows.length ? rows.slice(0, limit).map((m) => {
          const who = people.get(senderKey(m))
          const snoozed = isSnoozed(m)
          return (
            <button key={m.id} className={cls('pt-msg', m.status === 'pending' && !snoozed && 'pending')} onClick={() => onOpenMessage(m.id)}>
              <Avatar name={who?.name ?? m.sender_name} size={30} src={who?.photo} />
              <span className="mount-text">
                <span className="pt-msg-top"><b>{who?.name ?? m.sender_name}</b><span className="list-sub">{chLabel(m.channel)} · {m.conversation || '私聊'}</span><span className="spacer" /><span className="run-muted">{timeAgo(m.at)}</span></span>
                <span className="pt-msg-text"><MentionText text={m.text} /></span>
                <AttachmentChips atts={m.attachments} />
              </span>
              {snoozed ? <span className="list-sub">稍后提醒</span> : m.status === 'pending' ? <span className="today-go">回复</span> : <span className="list-sub">{msgEnum.label(m.status)}</span>}
            </button>
          )
        }) : <div className="empty"><div className="empty-title">没有消息</div><div className="list-sub">绑定的群和私聊里的消息、归到这个项目的消息会出现在这里</div></div>}
        {rows.length > limit && (
          <button className="pt-more" onClick={() => setLim({ filter, n: limit + MSG_PAGE })}>加载更早的消息<span className="seg-n">还有 {rows.length - limit} 条</span></button>
        )}
      </div>
    </div>
  )
}

/* ---------- 干系人 ---------- */

export function StakeholdersTab({ p, contacts, messages, onChange, onOpenContact, onOpenMessage }: {
  p: Project; contacts: Contact[]; messages: Message[]
  onChange: (x: Partial<Project>) => void; onOpenContact: (id: string) => void; onOpenMessage: (id: string) => void
}) {
  const avail = contacts.filter((c) => !p.stakeholders.some((s) => s.contact_id === c.id))
  const patch = (id: string, x: Partial<{ role: StakeRole; focus: string }>) => onChange({ stakeholders: p.stakeholders.map((s) => (s.contact_id === id ? { ...s, ...x } : s)) })
  // 每个联系人在本项目绑定的会话里最近的一条消息：项目消息扫一遍，按发信人归到联系人上
  const latest = useMemo(() => {
    const people = contactIndex(contacts)
    const out = new Map<string, Message>()
    for (const m of projectMessages(p, messages, contacts, people)) {
      const c = people.get(senderKey(m))
      if (c && (out.get(c.id)?.at ?? '') < m.at) out.set(c.id, m)
    }
    return out
  }, [p, messages, contacts])
  const lastMsg = (c: Contact) => latest.get(c.id)
  const order: StakeRole[] = ['decider', 'contact', 'owner', 'member', 'informed']
  const rows = [...p.stakeholders].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role))
  return (
    <>
      <div className="mount-head pt-head">
        <span className="list-sub">谁拍板、谁对接、谁负责，每个人关心什么。人从联系人里挑</span>
        <span className="spacer" />
        <SearchSelect value="" placeholder="加干系人" searchPlaceholder="搜姓名、公司、职位" align="end" active={false}
          options={avail.map((c) => ({ value: c.id, label: c.name, hint: c.company, keywords: c.title, icon: <Avatar name={c.name} size={18} src={c.photo} /> }))}
          emptyText="联系人都已经加进来了"
          onChange={(id) => { if (id) onChange({ stakeholders: [...p.stakeholders, { contact_id: id, role: 'member', focus: '' }] }) }} />
      </div>
      {rows.length ? (
        <div className="task-table">
          <div className="stake-row task-th"><span>人</span><span>角色</span><span>关注点</span><span>最近沟通</span><span /></div>
          {rows.map((s) => {
            const c = contacts.find((x) => x.id === s.contact_id)
            if (!c) return null
            const last = lastMsg(c)
            return (
              <div key={s.contact_id} className="stake-row">
                <button className="stake-who" onClick={() => onOpenContact(c.id)}>
                  <Avatar name={c.name} size={30} src={c.photo} />
                  <span className="mount-text"><b>{c.name}</b><span className="list-sub ellipsis">{[c.title, c.company].filter(Boolean).join(' · ')}</span></span>
                </button>
                <select className={cls('stake-role', `sr-${s.role}`)} value={s.role} onChange={(e) => patch(c.id, { role: e.target.value as StakeRole })} title={STAKE_ROLE[s.role].desc}>
                  {order.map((r) => <option key={r} value={r}>{STAKE_ROLE[r].label}</option>)}
                </select>
                <input className="stake-focus" value={s.focus} placeholder="他关心什么" onChange={(e) => patch(c.id, { focus: e.target.value })} />
                <span>{last ? <button className="link-btn link-muted ellipsis" onClick={() => onOpenMessage(last.id)} title={last.text}>{timeAgo(last.at)} · {last.text.length > 14 ? `${last.text.slice(0, 14)}…` : last.text}</button> : <span className="list-sub">{p.chats.length ? '本项目会话里没有消息' : '还没绑定沟通渠道'}</span>}</span>
                <button className="act act-quiet" onClick={() => onChange({ stakeholders: p.stakeholders.filter((x) => x.contact_id !== c.id) })}>移除</button>
              </div>
            )
          })}
        </div>
      ) : <div className="empty"><div className="empty-title">还没有干系人</div><div className="list-sub">从联系人里挑出这个项目相关的人，标上角色和关注点</div></div>}
    </>
  )
}

/* ---------- 任务 ---------- */

export function ProjectTasksTab({ p, tasks, onNew, onOpen, onStatus, onApprove }: {
  p: Project; tasks: Task[]; onNew: () => void; onOpen: (id: string) => void; onStatus: (id: string, s: TaskStatus) => void
  /** 待验收的任务点完成圆圈：确认后等于验收通过，和任务列表同一套 */
  onApprove?: (id: string) => void
}) {
  const statusEnum = useEnumView('task_status')
  const [all, setAll] = useState(false)
  const [ask, setAsk] = useState<Task | null>(null)
  const mine = tasks.filter((t) => t.project_id === p.id)
  const rows = mine.filter((t) => all || isOpenTask(t.status)).sort((a, b) => a.priority.localeCompare(b.priority))
  return (
    <>
      <div className="mount-head pt-head">
        <div className="seg seg-sm">
          <button className={cls(!all && 'on')} onClick={() => setAll(false)}>未完成<span className="seg-n">{mine.filter((t) => isOpenTask(t.status)).length}</span></button>
          <button className={cls(all && 'on')} onClick={() => setAll(true)}>全部<span className="seg-n">{mine.length}</span></button>
        </div>
        <span className="spacer" />
        <button className="act act-primary" onClick={onNew}>新建任务</button>
      </div>
      {rows.length ? (
        <div className="task-table">
          {rows.map((t) => (
            <div key={t.id} className={cls('pt-task', t.status === 'done' && 'is-done')} onClick={() => onOpen(t.id)}>
              <button className={cls('task-check', t.status === 'done' && 'on')} title={t.status === 'done' ? `标为${statusEnum.label('todo')}` : t.status === 'review' ? '验收通过' : `标为${statusEnum.label('done')}`}
                onClick={(e) => { e.stopPropagation(); if (t.status === 'review') setAsk(t); else onStatus(t.id, t.status === 'done' ? 'todo' : 'done') }}>
                {t.status === 'done' && <svg viewBox="0 0 16 16" width="10" height="10"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
              </button>
              <PriorityTag p={t.priority} />
              <span className="task-ref">{t.ref}</span>
              <span className="ellipsis pt-task-title">{t.title}</span>
              <span className="run-muted">{t.assignee || '未分配'}</span>
              <span className="run-muted">{t.due ?? '-'}</span>
              <TaskStatusPill s={t.status} />
            </div>
          ))}
        </div>
      ) : <div className="empty"><div className="empty-title">{all ? '这个项目还没有任务' : '没有未完成的任务'}</div><div className="list-sub">在这里新建的任务会自动归到这个项目；其他任务在任务详情里也能改所属项目</div></div>}
      {ask && (
        <ApproveConfirm task={ask} onClose={() => setAsk(null)} onOpen={() => { setAsk(null); onOpen(ask.id) }}
          onApprove={() => { setAsk(null); if (onApprove) onApprove(ask.id); else onStatus(ask.id, 'done') }} />
      )}
    </>
  )
}

/* ---------- SOP ---------- */

export function ProjectSopTab({ p, sops, runs, onChange, onStart, onOpenRun, onOpenSop }: {
  p: Project; sops: Sop[]; runs: SopRun[]
  onChange: (x: Partial<Project>) => void; onStart: (sopId: string) => void; onOpenRun: (id: string) => void; onOpenSop: (id: string) => void
}) {
  const mine = sops.filter((s) => p.sop_ids.includes(s.id))
  const avail = sops.filter((s) => !p.sop_ids.includes(s.id))
  const recent = runs.filter((r) => p.sop_ids.includes(r.sop_id)).sort((a, b) => b.started_at - a.started_at).slice(0, 8)
  return (
    <>
      <div className="mount-head pt-head">
        <span className="list-sub">这个项目常用的标准流程，在这里直接执行</span>
        <span className="spacer" />
        <SearchSelect value="" placeholder="关联 SOP" searchPlaceholder="搜流程名" align="end" active={false}
          options={avail.map((s) => ({ value: s.id, label: s.name, keywords: s.desc }))}
          emptyText="SOP 都已经关联了"
          onChange={(id) => { if (id) onChange({ sop_ids: [...p.sop_ids, id] }) }} />
      </div>
      {mine.length ? (
        <div className="mount-list">
          {mine.map((s) => (
            <div key={s.id} className="mount-card">
              <span className="mount-icon conn-icon"><svg viewBox="0 0 16 16" width="13" height="13"><rect x="1.8" y="2.5" width="4.4" height="3.6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" /><rect x="9.8" y="9.9" width="4.4" height="3.6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M6.2 4.3h2a1.6 1.6 0 0 1 1.6 1.6v4" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg></span>
              <button className="mount-text mount-toggle" onClick={() => onOpenSop(s.id)}><b>{s.name}</b><span className="list-sub">{s.desc}</span></button>
              <button className="act act-primary" onClick={() => onStart(s.id)}>执行</button>
              <button className="act act-quiet" onClick={() => onChange({ sop_ids: p.sop_ids.filter((x) => x !== s.id) })}>取消关联</button>
            </div>
          ))}
        </div>
      ) : <div className="mount-empty">还没关联 SOP</div>}
      {recent.length > 0 && (
        <>
          <div className="section-label">最近执行</div>
          <div className="task-table">
            {recent.map((r) => (
              <button key={r.id} className="pt-run" onClick={() => onOpenRun(r.id)}>
                <span className="ellipsis">{r.title}</span>
                <Pill {...RUN_STATUS[runStatus(r)]} />
                <span className="run-muted">{timeAgo(new Date(r.started_at).toISOString())}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  )
}

/* ---------- Agent ---------- */

/** 项目 Agent 页签里露几条会话 */
const SESSION_PEEK = 10

export function ProjectAgentTab({ p, agents, sessions, onChange, onChat, onOpenAgent, onOpenSession, onAllSessions }: {
  p: Project; agents: Agent[]; sessions: Session[]
  onChange: (x: Partial<Project>) => void; onChat: (agentId: string) => void; onOpenAgent: (id: string) => void; onOpenSession: (id: string) => void
  /** 去会话页看这个项目的全部会话；不传就在这里就地展开 */
  onAllSessions?: () => void
}) {
  const [allChats, setAllChats] = useState(false)
  const mine = p.agent_ids.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a)
  const avail = agents.filter((a) => !p.agent_ids.includes(a.id))
  const chats = sessions.filter((s) => s.project_id === p.id).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  return (
    <>
      <div className="mount-head pt-head">
        <span className="list-sub">第一个是默认项目 Agent；在这里开的会话归到这个项目，能读这个项目的材料和文档</span>
        <span className="spacer" />
        <SearchSelect value="" placeholder="加 Agent" searchPlaceholder="搜 Agent" align="end" active={false}
          options={avail.map((a) => ({ value: a.id, label: a.name, hint: a.enabled ? undefined : '已停用', keywords: a.desc, disabled: !a.enabled, icon: <AgentAvatar agent={a} size={18} /> }))}
          emptyText="Agent 都已经加进来了"
          onChange={(id) => { if (id) onChange({ agent_ids: [...p.agent_ids, id] }) }} />
      </div>
      {mine.length ? (
        <div className="mount-list">
          {mine.map((a, i) => (
            <div key={a.id} className="mount-card">
              <AgentAvatar agent={a} size={32} />
              <button className="mount-text mount-toggle" onClick={() => onOpenAgent(a.id)}>
                <span><b>{a.name}</b>{i === 0 && <span className="tag mount-src">默认</span>}</span>
                <span className="list-sub">{a.enabled ? a.desc : '已停用'}</span>
              </button>
              {i > 0 && <button className="act act-quiet" onClick={() => onChange({ agent_ids: [a.id, ...p.agent_ids.filter((x) => x !== a.id)] })}>设为默认</button>}
              <button className="act act-primary" disabled={!a.enabled} onClick={() => onChat(a.id)}>对话</button>
              <button className="act act-quiet" onClick={() => onChange({ agent_ids: p.agent_ids.filter((x) => x !== a.id) })}>移除</button>
            </div>
          ))}
        </div>
      ) : <div className="mount-empty">还没给项目配 Agent</div>}
      <div className="section-label">项目里的会话{chats.length > SESSION_PEEK && <span className="seg-n"> {chats.length}</span>}</div>
      {chats.length ? (
        <div className="task-table">
          {(allChats ? chats : chats.slice(0, SESSION_PEEK)).map((s) => {
            const a = agents.find((x) => x.id === s.agent_id)
            return (
              <button key={s.id} className="pt-run" onClick={() => onOpenSession(s.id)}>
                {a && <AgentAvatar agent={a} size={20} />}
                <span className="ellipsis">{s.title}</span>
                <span className="run-muted">{a?.name}</span>
                <span className="run-muted">{timeAgo(s.updated_at)}</span>
              </button>
            )
          })}
          {chats.length > SESSION_PEEK && (onAllSessions
            ? <button className="pt-more" onClick={onAllSessions}>在会话里看全部<span className="seg-n">{chats.length} 条</span></button>
            : <button className="pt-more" onClick={() => setAllChats(!allChats)}>{allChats ? '收起' : <>显示全部<span className="seg-n">还有 {chats.length - SESSION_PEEK} 条</span></>}</button>)}
        </div>
      ) : <div className="mount-empty">还没有项目会话；点上面的「对话」开一个</div>}
    </>
  )
}
