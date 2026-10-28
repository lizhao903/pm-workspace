import { useState } from 'react'
import type { Agent, Session } from './agentdata'
import { AgentAvatar } from './agents'
import { IM_CHANNELS, type Contact, type Message } from './data'
import { contactFor } from './messages'
import { STAKE_ROLE, type Project, type ProjectChat, type StakeRole } from './projectdata'
import { RUN_STATUS, runStatus, type Sop, type SopRun } from './sopflow'
import type { Task, TaskStatus } from './taskdata'
import { isOpenTask } from './taskdata'
import { PriorityTag, TaskStatusPill } from './tasks'
import { useEnumView } from './enumdata'
import { Avatar, cls, timeAgo } from './ui'
import { AttachmentChips, ProjectAttachmentInbox } from './attachments'

// 项目里的沟通、干系人、任务、SOP、Agent 页签。数据都在各自模块里，项目只记关联关系

const chLabel = (k: string) => IM_CHANNELS.find((c) => c.key === k)?.label ?? k
const Pill = ({ label, color }: { label: string; color: string }) => <span className="pill" style={{ '--c': color } as React.CSSProperties}><span className="pill-dot" />{label}</span>
const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

/** 一条消息属于这个项目的哪个沟通渠道 */
export function chatOf(m: Message, chats: ProjectChat[], contacts: Contact[]): ProjectChat | undefined {
  return chats.find((c) => (c.kind === 'group'
    ? m.channel === c.channel && m.conversation === c.conversation
    : !m.conversation && contactFor(m, contacts)?.id === c.contact_id))
}
export const projectMessages = (p: Project, messages: Message[], contacts: Contact[]) => messages.filter((m) => chatOf(m, p.chats, contacts))

/* ---------- 沟通：私聊 + 群聊 ---------- */

export function CommsTab({ p, messages, contacts, onChange, onOpenMessage, onFetchAttachment, onAddAttachment }: {
  p: Project; messages: Message[]; contacts: Contact[]
  onChange: (x: Partial<Project>) => void; onOpenMessage: (id: string) => void
  onFetchAttachment: (msgId: string, attId: string) => void
  /** 加进这个项目的支持材料；没获取的会先获取 */
  onAddAttachment: (msgId: string, attId: string) => void
}) {
  const msgEnum = useEnumView('msg_status')
  const [filter, setFilter] = useState('')
  const [adding, setAdding] = useState(false)
  const mine = projectMessages(p, messages, contacts).sort((a, b) => b.at.localeCompare(a.at))
  const rows = mine.filter((m) => !filter || chatOf(m, p.chats, contacts)?.id === filter)
  const label = (c: ProjectChat) => (c.kind === 'group' ? c.conversation : contacts.find((x) => x.id === c.contact_id)?.name ?? '已删除的联系人')
  // 可以绑的群：现有消息里出现过的群聊，去掉已经绑了的
  const groups = [...new Map(messages.filter((m) => m.conversation).map((m) => [`${m.channel}|${m.conversation}`, m])).values()]
    .filter((m) => !p.chats.some((c) => c.kind === 'group' && c.channel === m.channel && c.conversation === m.conversation))
  const dms = contacts.filter((c) => !p.chats.some((x) => x.kind === 'dm' && x.contact_id === c.id))
  const pending = (c: ProjectChat) => mine.filter((m) => chatOf(m, [c], contacts) && m.status === 'pending').length

  return (
    <div className="pt-comms">
      <div className="pt-chats">
        <div className="mount-head"><div className="field-group-title">项目沟通渠道</div><button className="act" onClick={() => setAdding(!adding)}>绑定</button></div>
        {adding && (
          <div className="pt-bind">
            <div className="menu-label">群聊</div>
            {groups.length ? groups.map((m) => (
              <button key={`${m.channel}|${m.conversation}`} className="menu-item" onClick={() => { onChange({ chats: [...p.chats, { id: uid('ch'), kind: 'group', channel: m.channel, conversation: m.conversation }] }); setAdding(false) }}>
                <span className="tag">{chLabel(m.channel)}</span>{m.conversation}
              </button>
            )) : <div className="list-sub pt-bind-empty">没有可绑的群</div>}
            <div className="menu-label">私聊</div>
            <div className="pt-bind-dms">
              {dms.map((c) => (
                <button key={c.id} className="menu-item" onClick={() => { onChange({ chats: [...p.chats, { id: uid('ch'), kind: 'dm', contact_id: c.id }] }); setAdding(false) }}>
                  <Avatar name={c.name} size={18} src={c.photo} />{c.name}<span className="list-sub">{c.company}</span>
                </button>
              ))}
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
        <ProjectAttachmentInbox p={p} messages={mine} onFetch={onFetchAttachment} onAdd={onAddAttachment} onOpenMessage={onOpenMessage}
          onSkip={(id, skip) => onChange({ skipped_attachments: skip ? [...(p.skipped_attachments ?? []), id] : (p.skipped_attachments ?? []).filter((x) => x !== id) })} />
        {rows.length ? rows.map((m) => {
          const who = contactFor(m, contacts)
          return (
            <button key={m.id} className={cls('pt-msg', m.status === 'pending' && 'pending')} onClick={() => onOpenMessage(m.id)}>
              <Avatar name={who?.name ?? m.sender_name} size={30} src={who?.photo} />
              <span className="mount-text">
                <span className="pt-msg-top"><b>{who?.name ?? m.sender_name}</b><span className="list-sub">{chLabel(m.channel)} · {m.conversation || '私聊'}</span><span className="spacer" /><span className="run-muted">{timeAgo(m.at)}</span></span>
                <span className="pt-msg-text">{m.text}</span>
                <AttachmentChips atts={m.attachments} />
              </span>
              {m.status === 'pending' ? <span className="today-go">回复</span> : <span className="list-sub">{msgEnum.label(m.status)}</span>}
            </button>
          )
        }) : <div className="empty"><div className="empty-title">没有消息</div><div className="list-sub">绑定的群和私聊里收到消息后会出现在这里</div></div>}
      </div>
    </div>
  )
}

/* ---------- 干系人 ---------- */

export function StakeholdersTab({ p, contacts, messages, onChange, onOpenContact, onOpenMessage }: {
  p: Project; contacts: Contact[]; messages: Message[]
  onChange: (x: Partial<Project>) => void; onOpenContact: (id: string) => void; onOpenMessage: (id: string) => void
}) {
  const [adding, setAdding] = useState(false)
  const avail = contacts.filter((c) => !p.stakeholders.some((s) => s.contact_id === c.id))
  const patch = (id: string, x: Partial<{ role: StakeRole; focus: string }>) => onChange({ stakeholders: p.stakeholders.map((s) => (s.contact_id === id ? { ...s, ...x } : s)) })
  const lastMsg = (c: Contact) => messages.filter((m) => contactFor(m, contacts)?.id === c.id).sort((a, b) => b.at.localeCompare(a.at))[0]
  const order: StakeRole[] = ['decider', 'contact', 'owner', 'member', 'informed']
  const rows = [...p.stakeholders].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role))
  return (
    <>
      <div className="mount-head pt-head">
        <span className="list-sub">谁拍板、谁对接、谁负责，每个人关心什么。人从联系人里挑</span>
        <span className="spacer" />
        <select className="chat-filter" value="" onChange={(e) => { if (e.target.value) { onChange({ stakeholders: [...p.stakeholders, { contact_id: e.target.value, role: 'member', focus: '' }] }); setAdding(false) } }} onFocus={() => setAdding(true)}>
          <option value="">{adding ? '选一个联系人…' : '加干系人'}</option>
          {avail.map((c) => <option key={c.id} value={c.id}>{c.name}{c.company ? ` · ${c.company}` : ''}</option>)}
        </select>
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
                <span>{last ? <button className="link-btn link-muted ellipsis" onClick={() => onOpenMessage(last.id)} title={last.text}>{timeAgo(last.at)} · {last.text.slice(0, 14)}…</button> : <span className="list-sub">没有消息</span>}</span>
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

export function ProjectTasksTab({ p, tasks, onNew, onOpen, onStatus }: {
  p: Project; tasks: Task[]; onNew: () => void; onOpen: (id: string) => void; onStatus: (id: string, s: TaskStatus) => void
}) {
  const [all, setAll] = useState(false)
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
              <button className={cls('task-check', t.status === 'done' && 'on')} onClick={(e) => { e.stopPropagation(); onStatus(t.id, t.status === 'done' ? 'todo' : 'done') }}>
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
        <select className="chat-filter" value="" onChange={(e) => e.target.value && onChange({ sop_ids: [...p.sop_ids, e.target.value] })}>
          <option value="">关联 SOP…</option>
          {avail.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
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

export function ProjectAgentTab({ p, agents, sessions, onChange, onChat, onOpenAgent, onOpenSession }: {
  p: Project; agents: Agent[]; sessions: Session[]
  onChange: (x: Partial<Project>) => void; onChat: (agentId: string) => void; onOpenAgent: (id: string) => void; onOpenSession: (id: string) => void
}) {
  const mine = p.agent_ids.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a)
  const avail = agents.filter((a) => !p.agent_ids.includes(a.id))
  const chats = sessions.filter((s) => s.project_id === p.id).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  return (
    <>
      <div className="mount-head pt-head">
        <span className="list-sub">第一个是默认项目 Agent；在这里开的会话归到这个项目，能读这个项目的材料和文档</span>
        <span className="spacer" />
        <select className="chat-filter" value="" onChange={(e) => e.target.value && onChange({ agent_ids: [...p.agent_ids, e.target.value] })}>
          <option value="">加 Agent…</option>
          {avail.map((a) => <option key={a.id} value={a.id} disabled={!a.enabled}>{a.name}{a.enabled ? '' : '（已停用）'}</option>)}
        </select>
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
      <div className="section-label">项目里的会话</div>
      {chats.length ? (
        <div className="task-table">
          {chats.map((s) => {
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
        </div>
      ) : <div className="mount-empty">还没有项目会话；点上面的「对话」开一个</div>}
    </>
  )
}
