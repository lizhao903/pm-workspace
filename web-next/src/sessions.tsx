import { Fragment, useEffect, useMemo, useState } from 'react'
import { OUTPUT_KIND, type Agent, type AgentOutput, type AgentRun, type ChatMsg, type OutputKind, type Session, type ToolCall } from './agentdata'
import { AgentAvatar, CHAT_EXAMPLES, CallCard, ChatPane, Pill, RUN_STATUS, type Ctx } from './agents'
import { SearchSelect } from './searchselect'
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

/** 一次先露多少条，往下点「显示更多」 */
const PAGE = 50
/** Agent 多于这个数时，chip 只放最常用的几个，其余进可搜索的下拉 */
const MANY_AGENTS = 6
const TOP_AGENTS = 4

/** Agent 选项：按这一视图里的记录数排序，记录数写在右边 */
function agentOptions(agents: Agent[], usage: Map<string, number>) {
  return [...agents].sort((a, b) => (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0))
    .map((a) => ({ value: a.id, label: a.name || '未命名', hint: usage.get(a.id) ? `${usage.get(a.id)} 条` : a.enabled ? undefined : '已停用', icon: <AgentAvatar agent={a} size={16} /> }))
}
const countBy = (ids: string[]) => { const m = new Map<string, number>(); ids.forEach((id) => m.set(id, (m.get(id) ?? 0) + 1)); return m }

/** 按 Agent 筛选，三个视图共用：「全部」+ 记录最多的几个 chip，其余收进可搜索的下拉 */
function AgentFilter({ agents, value, onChange, used }: { agents: Agent[]; value: string; onChange: (v: string) => void; used: string[] }) {
  const usage = useMemo(() => countBy(used), [used])
  const opts = useMemo(() => agentOptions(agents, usage), [agents, usage])
  const many = agents.length > MANY_AGENTS
  const top = many ? opts.slice(0, TOP_AGENTS).map((o) => agents.find((a) => a.id === o.value)!) : agents
  const inMore = many && !!value && !top.some((a) => a.id === value)
  return (
    <div className="filter-row">
      <button className={cls('fchip', !value && 'on')} onClick={() => onChange('')}>全部 Agent</button>
      {top.map((a) => (
        <button key={a.id} className={cls('fchip agent-chip', value === a.id && 'on')} title={a.name} onClick={() => onChange(value === a.id ? '' : a.id)}>
          <AgentAvatar agent={a} size={16} /><span className="ellipsis agent-chip-name">{a.name}</span>
        </button>
      ))}
      {many && (
        <SearchSelect value={inMore ? value : ''} placeholder={`更多 Agent（${agents.length - top.length}）`} searchPlaceholder="搜 Agent"
          className="agent-more-pick" options={opts} onChange={(v) => onChange(v)} />
      )}
    </div>
  )
}

/** 更新时间分段：今天 / 本周 / 更早 */
function whenGroup(iso: string) {
  const d = new Date(iso), now = new Date()
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (d.getTime() >= day0) return '今天'
  const week0 = day0 - ((now.getDay() + 6) % 7) * 86400000
  return d.getTime() >= week0 ? '本周' : '更早'
}

/** 已删除的 Agent 的占位：停用、没有权限，只用来回看会话 */
const goneAgent = (id: string): Agent => ({
  id, name: '已删除的 Agent', desc: '', color: 'var(--faint)', model: '', instructions: '', abilities: {}, avatar: { kind: 'icon', value: 'robot' },
  skills: [], mcps: [], kbs: [], triggers: [], enabled: false, created_at: '',
})

const More = ({ left, onMore }: { left: number; onMore: () => void }) => (left > 0 ? <button className="agent-more" onClick={onMore}>显示更多（还有 {left} 条）</button> : null)

/* ---------- 会话 ---------- */

export function ChatsView({ agents, sessions, current, ctx, pickRequest, onOpen, onNew, onMsgs, onRename, onDelete, onExecute, onOpenAgent, firstMessage, projects, initialProject }: {
  /** 传了就多一个「项目」筛选 */
  projects?: { id: string; name: string }[]
  /** 从项目页跳过来时预先按这个项目筛 */
  initialProject?: string
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
  const [proj, setProj] = useState(initialProject ?? '')
  useEffect(() => { setProj(initialProject ?? '') }, [initialProject])
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [picking, setPicking] = useState(false)
  const [pickQ, setPickQ] = useState('')
  useEffect(() => { if (pickRequest) { setPicking(true); setPickQ('') } }, [pickRequest])
  const [editing, setEditing] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const agentOf = (id: string) => agents.find((a) => a.id === id)
  const kw = q.trim().toLowerCase()
  const rows = sessions.filter((s) => (!filter || s.agent_id === filter) && (!proj || (proj === '-' ? !s.project_id : s.project_id === proj))
    && (!kw || s.title.toLowerCase().includes(kw) || s.messages.some((m) => m.text.toLowerCase().includes(kw))))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  const shown = rows.slice(0, limit)
  const usage = useMemo(() => countBy(sessions.map((s) => s.agent_id)), [sessions])
  const agentOpts = useMemo(() => agentOptions(agents, usage), [agents, usage])
  // 新会话选 Agent：最近聊过的排前面，可搜
  const recent = useMemo(() => {
    const last = new Map<string, string>()
    sessions.forEach((s) => { if ((last.get(s.agent_id) ?? '') < s.updated_at) last.set(s.agent_id, s.updated_at) })
    return [...agents].sort((a, b) => (last.get(b.id) ?? '').localeCompare(last.get(a.id) ?? ''))
  }, [agents, sessions])
  const pkw = pickQ.trim().toLowerCase()
  const pickList = pkw ? recent.filter((a) => `${a.name} ${a.desc}`.toLowerCase().includes(pkw)) : recent
  const setF = (f: () => void) => { f(); setLimit(PAGE) }
  const cur = sessions.find((s) => s.id === current) ?? null
  const found = cur ? agentOf(cur.agent_id) : undefined
  // Agent 删了会话还在：换一个停用的占位 Agent，照样能回看历史，发不了消息
  const agent = cur && !found ? goneAgent(cur.agent_id) : found
  const pending = (s: Session) => s.messages.some((m) => m.calls?.some((c) => c.state === 'pending'))

  return (
    <div className="chats">
      <PageTitle parent="会话" count={rows.length} desc="和 Agent 的对话都留在这里，能接着聊，也能回看每次调用了什么工具"
        actions={<button className="btn btn-primary" onClick={() => setPicking(!picking)}>新会话</button>}>会话</PageTitle>
      <div className="chat-list">
        <div className="chat-list-head">
          <div className="search search-full search-sm">
            <svg viewBox="0 0 16 16" width="13" height="13"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            <input placeholder="搜会话标题和内容" value={q} onChange={(e) => setF(() => setQ(e.target.value))} />
          </div>
          <div className="chat-filters">
            <SearchSelect value={filter} noneLabel="全部 Agent" searchPlaceholder="搜 Agent" options={agentOpts} missingLabel={() => '已删除的 Agent'}
              onChange={(v) => setF(() => setFilter(v))} />
            {projects && (
              <SearchSelect value={proj} noneLabel="全部项目" searchPlaceholder="搜项目" missingLabel={() => '已删除的项目'}
                options={[...projects.map((p) => ({ value: p.id, label: p.name })), { value: '-', label: '不属于项目' }]}
                onChange={(v) => setF(() => setProj(v))} />
            )}
          </div>
        </div>
        {picking && (
          <div className="agent-pick">
            <div className="menu-label">和哪个 Agent 聊</div>
            {agents.length > MANY_AGENTS && (
              <div className="search search-sm agent-pick-search">
                <svg viewBox="0 0 16 16" width="13" height="13"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                <input autoFocus placeholder="搜 Agent，最近聊过的在前" value={pickQ} onChange={(e) => setPickQ(e.target.value)}
                  onKeyDown={(e) => { const a = pickList.find((x) => x.enabled); if (e.key === 'Enter' && a) { onNew(a.id); setPicking(false) } if (e.key === 'Escape') setPicking(false) }} />
              </div>
            )}
            <div className="agent-pick-list">
              {pickList.map((a) => (
                <button key={a.id} className="menu-item" disabled={!a.enabled} onClick={() => { onNew(a.id); setPicking(false) }}>
                  <AgentAvatar agent={a} size={20} /><span className="ellipsis">{a.name}</span>{!a.enabled && <span className="list-sub">已停用</span>}
                </button>
              ))}
              {!pickList.length && <div className="io-empty">没有匹配的 Agent</div>}
            </div>
          </div>
        )}
        <div className="chat-items">
          {shown.map((s, i) => {
            const a = agentOf(s.agent_id)
            const last = s.messages[s.messages.length - 1]
            const g = whenGroup(s.updated_at)
            return (
              <Fragment key={s.id}>
              {g !== (i ? whenGroup(shown[i - 1].updated_at) : '') && <div className="menu-label chat-group">{g}</div>}
              <button className={cls('chat-item', s.id === current && 'sel')} onClick={() => { onOpen(s.id); setEditing(false); setConfirmDel(false) }}>
                {a && <AgentAvatar agent={a} size={30} />}
                <span className="chat-item-text">
                  <span className="chat-item-top"><span className="ellipsis chat-item-title">{s.title}</span>{pending(s) && <span className="side-dot" title="有操作等你确认" />}</span>
                  <span className="ellipsis list-sub">{a?.name ?? '已删除的 Agent'} · {last ? last.text : '还没有消息'}</span>
                </span>
                <span className="chat-item-time">{timeAgo(s.updated_at)}</span>
              </button>
              </Fragment>
            )
          })}
          <More left={rows.length - shown.length} onMore={() => setLimit(limit + PAGE)} />
          {!rows.length && <div className="tree-empty">{kw || filter || proj ? '没有匹配的会话' : '还没有会话，点「新会话」和 Agent 聊聊'}</div>}
        </div>
      </div>
      <div className="chat-main">
        {cur && agent ? (
          <ChatPane key={cur.id} agent={agent} msgs={cur.messages} onMsgs={(f) => onMsgs(cur.id, f)} ctx={ctx} onExecute={(c) => onExecute(cur.id, c)}
            autoSend={firstMessage?.sessionId === cur.id ? firstMessage.text : undefined}
            examples={CHAT_EXAMPLES}
            placeholderNote={!found ? '这个 Agent 已删除，只能回看' : agent.enabled ? undefined : '这个 Agent 已停用，只能回看'}
            permHint="可以到「设置 / Agent / 工具与权限」里打开"
            head={(
              <div className="chat-head">
                {found && <AgentAvatar agent={agent} size={28} />}
                {editing ? (
                  <input className="chat-title-input" autoFocus defaultValue={cur.title}
                    onBlur={(e) => { onRename(cur.id, e.target.value.trim() || cur.title); setEditing(false) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                ) : (
                  <button className="chat-title" onClick={() => setEditing(true)} title="点一下改标题">{cur.title}</button>
                )}
                {found ? <button className="link-btn chat-agent" onClick={() => onOpenAgent(agent.id)}>{agent.name}</button> : <span className="list-sub">已删除的 Agent</span>}
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

export function RunsView({ agents, runs, onSettle, focus, onFocused }: {
  agents: Agent[]
  runs: AgentRun[]
  onSettle: (runId: string, i: number, ok: boolean) => void
  /** 从产出结果的来源跳过来：展开这一条、滚到它、高亮一下 */
  focus?: string | null
  onFocused?: () => void
}) {
  const [filter, setFilter] = useState('')
  const [st, setSt] = useState<'' | AgentRun['status']>('')
  const [limit, setLimit] = useState(PAGE)
  /** 手动展开、收起过的；没动过的只展开等你确认的 */
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const [lit, setLit] = useState<string | null>(null)
  useEffect(() => {
    if (!focus) return
    const i = runs.findIndex((r) => r.id === focus)
    if (i >= 0) {
      // 清掉筛选、放开条数，保证这一条在列表里
      setFilter(''); setSt(''); setLimit(Math.max(PAGE, runs.length))
      setToggled((t) => ({ ...t, [focus]: true }))
      setLit(focus)
    }
    onFocused?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])
  useEffect(() => {
    if (!lit) return
    document.querySelector(`[data-run="${lit}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const t = window.setTimeout(() => setLit(null), 2400)
    return () => window.clearTimeout(t)
  }, [lit])
  // 等你确认的置顶
  const rows = runs.filter((r) => (!filter || r.agent_id === filter) && (!st || r.status === st))
    .sort((a, b) => Number(b.status === 'waiting') - Number(a.status === 'waiting') || b.at.localeCompare(a.at))
  const used = useMemo(() => runs.map((r) => r.agent_id), [runs])
  return (
    <div className="page page-fill">
      <PageTitle parent="会话" count={rows.length} desc="Agent 被消息、定时、任务触发后的每一次执行；写操作等你确认的在这里处理">执行记录</PageTitle>
      <div className="toolbar">
        <div className="seg">
          {([['', '全部'], ['waiting', '等你确认'], ['done', '已完成'], ['rejected', '已拒绝'], ['failed', '失败']] as const).map(([k, l]) => (
            <button key={k} className={cls(st === k && 'on')} onClick={() => { setSt(k); setLimit(PAGE) }}>{l}<span className="seg-n">{k ? runs.filter((r) => r.status === k).length : runs.length}</span></button>
          ))}
        </div>
        <AgentFilter agents={agents} value={filter} onChange={(v) => { setFilter(v); setLimit(PAGE) }} used={used} />
      </div>
      {!rows.length && (runs.length
        ? <div className="empty"><div className="empty-title">没有符合条件的执行记录</div><div className="list-sub">换个状态或 Agent 看看</div></div>
        : <div className="empty"><div className="empty-title">没有执行记录</div><div className="list-sub">Agent 被触发后，每次调用了什么工具、输入输出是什么都会留在这里</div></div>)}
      <div className="agent-runs">
        {rows.slice(0, limit).map((r) => {
          const a = agents.find((x) => x.id === r.agent_id)
          const open = toggled[r.id] ?? r.status === 'waiting'
          return (
            <div key={r.id} data-run={r.id} className={cls('agent-run', r.status === 'waiting' && 'waiting', !open && 'folded', lit === r.id && 'lit')}>
              <button className="agent-run-head" onClick={() => setToggled({ ...toggled, [r.id]: !open })} aria-expanded={open} title={open ? '收起' : '展开看调用'}>
                <svg className={cls('call-chev', open && 'open')} viewBox="0 0 16 16" width="10" height="10"><path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                {a && <AgentAvatar agent={a} size={24} />}
                <span className="agent-run-agent ellipsis">{a?.name ?? '已删除的 Agent'}</span>
                <Pill {...RUN_STATUS[r.status]} />
                <span className="agent-run-trigger ellipsis">{r.trigger}</span>
                <span className="spacer" />
                {!open && <span className="run-muted agent-run-n">{r.calls.length} 次调用</span>}
                <span className="run-muted agent-run-n">{timeAgo(r.at)}</span>
              </button>
              {open && (
                <>
                  <div className="agent-run-summary">{r.summary}</div>
                  <div className="call-list">
                    {r.calls.map((c, i) => <CallCard key={i} call={c} onConfirm={() => onSettle(r.id, i, true)} onReject={() => onSettle(r.id, i, false)} />)}
                  </div>
                </>
              )}
            </div>
          )
        })}
        <More left={rows.length - limit} onMore={() => setLimit(limit + PAGE)} />
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
  /** 打开目标；目标已经不在了返回提示文字，不跳页面 */
  onOpenTarget: (o: AgentOutput) => string | void
  onOpenOrigin: (o: AgentOutput) => void
}) {
  const [filter, setFilter] = useState('')
  const [kind, setKind] = useState<'' | OutputKind>('')
  const [limit, setLimit] = useState(PAGE)
  /** 点了但目标已删除的产出：id -> 提示 */
  const [gone, setGone] = useState<Record<string, string>>({})
  const open = (o: AgentOutput) => { const why = onOpenTarget(o); if (why) setGone((g) => ({ ...g, [o.id]: why })) }
  const used = useMemo(() => outputs.map((o) => o.agent_id), [outputs])
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
          <button className={cls(!kind && 'on')} onClick={() => { setKind(''); setLimit(PAGE) }}>全部<span className="seg-n">{outputs.length}</span></button>
          {kinds.map((k) => <button key={k} className={cls(kind === k && 'on')} onClick={() => { setKind(k); setLimit(PAGE) }}>{OUTPUT_KIND[k]}<span className="seg-n">{outputs.filter((o) => o.kind === k).length}</span></button>)}
        </div>
        <AgentFilter agents={agents} value={filter} onChange={(v) => { setFilter(v); setLimit(PAGE) }} used={used} />
      </div>
      {!rows.length ? (outputs.length
        ? <div className="empty"><div className="empty-title">没有符合条件的产出</div><div className="list-sub">换个类型或 Agent 看看</div></div>
        : <div className="empty"><div className="empty-title">还没有产出</div><div className="list-sub">Agent 建了任务、写了文档、发了回复后会出现在这里</div></div>
      ) : (
        <div className="task-table">
          <div className="output-row task-th"><span>类型</span><span>产出</span><span>Agent</span><span>来源</span><span>时间</span></div>
          {rows.slice(0, limit).map((o) => {
            const a = agents.find((x) => x.id === o.agent_id)
            return (
              <div key={o.id} className="output-row">
                <span><span className={`out-kind out-${o.kind}`}>{OUTPUT_KIND[o.kind]}</span></span>
                <span className="output-title">
                  {o.target || o.kind === 'doc'
                    ? <button className={cls('link-btn ellipsis', gone[o.id] && 'link-gone')} onClick={() => open(o)}>{o.title}</button>
                    : <span className="ellipsis">{o.title}</span>}
                  {gone[o.id] && <span className="out-gone">{gone[o.id]}</span>}
                </span>
                <span className="output-agent">{a && <AgentAvatar agent={a} size={18} />}<span className="ellipsis">{a?.name ?? '已删除'}</span></span>
                <span className="ellipsis output-origin"><button className="link-btn link-muted" onClick={() => onOpenOrigin(o)}>{originLabel(o)}</button></span>
                <span className="run-muted">{timeAgo(o.at)}</span>
              </div>
            )
          })}
          <More left={rows.length - limit} onMore={() => setLimit(limit + PAGE)} />
        </div>
      )}
    </div>
  )
}
