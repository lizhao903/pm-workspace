import { useEffect, useState } from 'react'
import { OUTPUT_KIND, type Agent, type AgentOutput, type AgentRun, type ChatMsg, type OutputKind, type Session, type ToolCall } from './agentdata'
import { AgentAvatar, CHAT_EXAMPLES, CallCard, ChatPane, Pill, RUN_STATUS, type Ctx } from './agents'
import { Subnav } from './subnav'
import { PageTitle } from './topbar'
import { cls, timeAgo } from './ui'

// 会话：和 Agent 的对话（存下来）、Agent 被触发后的执行记录、Agent 真正产出的东西。Agent 本身怎么配置在「设置 > Agent」

export type SessionView = 'chats' | 'runs' | 'outputs'

export function SessionsNav({ view, onSelect, waiting, onNew }: { view: SessionView; onSelect: (v: SessionView) => void; waiting: number; onNew: () => void }) {
  return (
    <Subnav title="会话" active={view} onSelect={onSelect} items={[
      { key: 'chats' as SessionView, label: '会话', desc: '和 Agent 的对话' },
      { key: 'runs' as SessionView, label: '执行记录', desc: '被触发后的每一次执行', alert: waiting },
      { key: 'outputs' as SessionView, label: '产出结果', desc: '建的任务、写的文档、发的回复' },
    ]}>
      <button className="subnav-new" onClick={onNew}>
        <svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        新会话
      </button>
    </Subnav>
  )
}

/** 按 Agent 筛选，三个视图共用 */
function AgentFilter({ agents, value, onChange }: { agents: Agent[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="filter-row">
      <button className={cls('fchip', !value && 'on')} onClick={() => onChange('')}>全部 Agent</button>
      {agents.map((a) => (
        <button key={a.id} className={cls('fchip agent-chip', value === a.id && 'on')} onClick={() => onChange(value === a.id ? '' : a.id)}>
          <AgentAvatar agent={a} size={16} />{a.name}
        </button>
      ))}
    </div>
  )
}

/* ---------- 会话 ---------- */

export function ChatsView({ agents, sessions, current, ctx, pickRequest, onOpen, onNew, onMsgs, onRename, onDelete, onExecute, onOpenAgent, firstMessage }: {
  /** 快速新建会话带来的第一句话：打开对应会话时自动发出 */
  firstMessage?: { sessionId: string; text: string } | null
  /** 二级菜单里点「新会话」时加一，这边打开选 Agent 的列表 */
  pickRequest: number
  agents: Agent[]
  sessions: Session[]
  current: string | null
  ctx: Ctx
  onOpen: (id: string) => void
  onNew: (agentId: string) => void
  onMsgs: (sessionId: string, f: (m: ChatMsg[]) => ChatMsg[]) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onExecute: (sessionId: string, call: ToolCall) => unknown
  onOpenAgent: (id: string) => void
}) {
  const [filter, setFilter] = useState('')
  const [q, setQ] = useState('')
  const [picking, setPicking] = useState(false)
  useEffect(() => { if (pickRequest) setPicking(true) }, [pickRequest])
  const [editing, setEditing] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const agentOf = (id: string) => agents.find((a) => a.id === id)
  const kw = q.trim().toLowerCase()
  const rows = sessions.filter((s) => (!filter || s.agent_id === filter)
    && (!kw || s.title.toLowerCase().includes(kw) || s.messages.some((m) => m.text.toLowerCase().includes(kw))))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  const cur = sessions.find((s) => s.id === current) ?? null
  const agent = cur ? agentOf(cur.agent_id) : undefined
  const pending = (s: Session) => s.messages.some((m) => m.calls?.some((c) => c.state === 'pending'))

  return (
    <div className="chats">
      <PageTitle parent="会话" count={rows.length} desc="和 Agent 的对话都留在这里，能接着聊，也能回看每次调用了什么工具"
        actions={<button className="btn btn-primary" onClick={() => setPicking(!picking)}>新会话</button>}>会话</PageTitle>
      <div className="chat-list">
        <div className="chat-list-head">
          <div className="search search-full search-sm">
            <svg viewBox="0 0 16 16" width="13" height="13"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            <input placeholder="搜会话标题和内容" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select className="chat-filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">全部 Agent</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        {picking && (
          <div className="agent-pick">
            <div className="menu-label">和哪个 Agent 聊</div>
            {agents.map((a) => (
              <button key={a.id} className="menu-item" disabled={!a.enabled} onClick={() => { onNew(a.id); setPicking(false) }}>
                <AgentAvatar agent={a} size={20} /><span className="ellipsis">{a.name}</span>{!a.enabled && <span className="list-sub">已停用</span>}
              </button>
            ))}
          </div>
        )}
        <div className="chat-items">
          {rows.map((s) => {
            const a = agentOf(s.agent_id)
            const last = s.messages[s.messages.length - 1]
            return (
              <button key={s.id} className={cls('chat-item', s.id === current && 'sel')} onClick={() => { onOpen(s.id); setEditing(false); setConfirmDel(false) }}>
                {a && <AgentAvatar agent={a} size={30} />}
                <span className="chat-item-text">
                  <span className="chat-item-top"><span className="ellipsis chat-item-title">{s.title}</span>{pending(s) && <span className="side-dot" title="有操作等你确认" />}</span>
                  <span className="ellipsis list-sub">{a?.name ?? '已删除的 Agent'} · {last ? last.text : '还没有消息'}</span>
                </span>
                <span className="chat-item-time">{timeAgo(s.updated_at)}</span>
              </button>
            )
          })}
          {!rows.length && <div className="tree-empty">{kw || filter ? '没有匹配的会话' : '还没有会话，点「新会话」和 Agent 聊聊'}</div>}
        </div>
      </div>
      <div className="chat-main">
        {cur && agent ? (
          <ChatPane key={cur.id} agent={agent} msgs={cur.messages} onMsgs={(f) => onMsgs(cur.id, f)} ctx={ctx} onExecute={(c) => onExecute(cur.id, c)}
            autoSend={firstMessage?.sessionId === cur.id ? firstMessage.text : undefined}
            examples={CHAT_EXAMPLES}
            placeholderNote={agent.enabled ? undefined : '这个 Agent 已停用，只能回看'}
            head={(
              <div className="chat-head">
                <AgentAvatar agent={agent} size={28} />
                {editing ? (
                  <input className="chat-title-input" autoFocus defaultValue={cur.title}
                    onBlur={(e) => { onRename(cur.id, e.target.value.trim() || cur.title); setEditing(false) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                ) : (
                  <button className="chat-title" onClick={() => setEditing(true)} title="点一下改标题">{cur.title}</button>
                )}
                <button className="link-btn chat-agent" onClick={() => onOpenAgent(agent.id)}>{agent.name}</button>
                <span className="spacer" />
                {confirmDel ? (
                  <>
                    <span className="danger-text">删除会话？产出的任务、文档不受影响</span>
                    <button className="act act-quiet" onClick={() => setConfirmDel(false)}>取消</button>
                    <button className="act btn-danger" onClick={() => { onDelete(cur.id); setConfirmDel(false) }}>删除</button>
                  </>
                ) : <button className="act act-quiet" onClick={() => setConfirmDel(true)}>删除会话</button>}
              </div>
            )} />
        ) : (
          <div className="lib-reader-empty">{sessions.length ? '从左边选一个会话' : '还没有会话'}</div>
        )}
      </div>
    </div>
  )
}

/* ---------- 执行记录 ---------- */

export function RunsView({ agents, runs, onSettle }: { agents: Agent[]; runs: AgentRun[]; onSettle: (runId: string, i: number, ok: boolean) => void }) {
  const [filter, setFilter] = useState('')
  const [st, setSt] = useState<'' | AgentRun['status']>('')
  const rows = runs.filter((r) => (!filter || r.agent_id === filter) && (!st || r.status === st)).sort((a, b) => b.at.localeCompare(a.at))
  return (
    <div className="page page-fill">
      <PageTitle parent="会话" count={rows.length} desc="Agent 被消息、定时、任务触发后的每一次执行；写操作等你确认的在这里处理">执行记录</PageTitle>
      <div className="toolbar">
        <div className="seg">
          {([['', '全部'], ['waiting', '等你确认'], ['done', '已完成'], ['rejected', '已拒绝'], ['failed', '失败']] as const).map(([k, l]) => (
            <button key={k} className={cls(st === k && 'on')} onClick={() => setSt(k)}>{l}<span className="seg-n">{k ? runs.filter((r) => r.status === k).length : runs.length}</span></button>
          ))}
        </div>
        <AgentFilter agents={agents} value={filter} onChange={setFilter} />
      </div>
      {!rows.length && <div className="empty"><div className="empty-title">没有执行记录</div><div className="list-sub">Agent 被触发后，每次调用了什么工具、输入输出是什么都会留在这里</div></div>}
      <div className="agent-runs">
        {rows.map((r) => {
          const a = agents.find((x) => x.id === r.agent_id)
          return (
            <div key={r.id} className={cls('agent-run', r.status === 'waiting' && 'waiting')}>
              <div className="agent-run-head">
                {a && <AgentAvatar agent={a} size={24} />}
                <span className="agent-run-agent">{a?.name ?? '已删除的 Agent'}</span>
                <Pill {...RUN_STATUS[r.status]} />
                <span className="agent-run-trigger">{r.trigger}</span>
                <span className="spacer" />
                <span className="run-muted">{timeAgo(r.at)}</span>
              </div>
              <div className="agent-run-summary">{r.summary}</div>
              <div className="call-list">
                {r.calls.map((c, i) => <CallCard key={i} call={c} onConfirm={() => onSettle(r.id, i, true)} onReject={() => onSettle(r.id, i, false)} />)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ---------- 产出结果 ---------- */

export function OutputsView({ agents, outputs, sessions, runs, onOpenTarget, onOpenOrigin }: {
  agents: Agent[]
  outputs: AgentOutput[]
  sessions: Session[]
  runs: AgentRun[]
  onOpenTarget: (o: AgentOutput) => void
  onOpenOrigin: (o: AgentOutput) => void
}) {
  const [filter, setFilter] = useState('')
  const [kind, setKind] = useState<'' | OutputKind>('')
  const rows = outputs.filter((o) => (!filter || o.agent_id === filter) && (!kind || o.kind === kind)).sort((a, b) => b.at.localeCompare(a.at))
  const kinds = (Object.keys(OUTPUT_KIND) as OutputKind[]).filter((k) => outputs.some((o) => o.kind === k))
  const originLabel = (o: AgentOutput) => (o.origin.type === 'session'
    ? `会话 · ${sessions.find((s) => s.id === o.origin.id)?.title ?? '已删除'}`
    : `执行记录 · ${runs.find((r) => r.id === o.origin.id)?.trigger ?? '已删除'}`)
  return (
    <div className="page page-fill">
      <PageTitle parent="会话" count={rows.length} desc="Agent 真正落到数据上的东西，点标题直接打开，点来源回到当时的对话或执行">产出结果</PageTitle>
      <div className="toolbar">
        <div className="seg">
          <button className={cls(!kind && 'on')} onClick={() => setKind('')}>全部<span className="seg-n">{outputs.length}</span></button>
          {kinds.map((k) => <button key={k} className={cls(kind === k && 'on')} onClick={() => setKind(k)}>{OUTPUT_KIND[k]}<span className="seg-n">{outputs.filter((o) => o.kind === k).length}</span></button>)}
        </div>
        <AgentFilter agents={agents} value={filter} onChange={setFilter} />
      </div>
      {!rows.length ? (
        <div className="empty"><div className="empty-title">还没有产出</div><div className="list-sub">Agent 建了任务、写了文档、发了回复后会出现在这里</div></div>
      ) : (
        <div className="task-table">
          <div className="output-row task-th"><span>类型</span><span>产出</span><span>Agent</span><span>来源</span><span>时间</span></div>
          {rows.map((o) => {
            const a = agents.find((x) => x.id === o.agent_id)
            return (
              <div key={o.id} className="output-row">
                <span><span className={`out-kind out-${o.kind}`}>{OUTPUT_KIND[o.kind]}</span></span>
                <span className="ellipsis">
                  {o.target || o.kind === 'doc' ? <button className="link-btn" onClick={() => onOpenTarget(o)}>{o.title}</button> : o.title}
                </span>
                <span className="output-agent">{a && <AgentAvatar agent={a} size={18} />}<span className="ellipsis">{a?.name ?? '已删除'}</span></span>
                <span className="ellipsis"><button className="link-btn link-muted" onClick={() => onOpenOrigin(o)}>{originLabel(o)}</button></span>
                <span className="run-muted">{timeAgo(o.at)}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
