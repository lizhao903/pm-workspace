// 会话（SPEC-sessions-1）：左边全局会话列表（搜索、按 Agent 筛、按时间分段），右边当前会话的对话。
// 当前会话记在 ?s=，别的页面能直接链接到某个会话。会话挂 Agent（AG-01b8）；0032 之前和「更多」里按服务商开的会话不挂 Agent。
// 空会话不堆积（B-09）：没有消息的会话只在打开时列出，从它切走时删掉。
// 头部右上角是插件登记的工具入口（终端、浏览器，SPEC-sessions-1.34），点了在对话右边展开面板。
// 从别的记录发起的会话（内核 0047，如 IM 消息的「发起会话」「拆分任务」）头部下面显示「来源」，按插件登记的定义跳回去。
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  firstMessageOf, useAgentMessages, useAgentProviders, useAgentSessions, useAgents, useArtifacts, useCreateAgentSession, useDeleteAgentSession,
  usePatchAgentSession, useRunningAgentSessions, useStopAgentSession, type AgentSession, type AgentSessionInput, type SessionSourceRef,
} from '../../core/data'
import { useSessionSource, useSessionTools } from '../../core/plugin'
import { Button, ErrorState, IconSearch, LoadingState, PageTitle, SearchSelect, cls } from '../../core/ui'
import { AgentAvatar } from '../../core/ui/AgentAvatar'
import { ChatPane } from '../../core/chat/ChatPane'
import { hasLiveChat, useLiveChat } from '../../core/chat/chatLive'
import {
  FILTER_GONE, FILTER_NO_AGENT, GONE_AGENT, NEW_TITLE, matchAgentFilter, recentAgents, sessionLinks, timeAgo, whenGroup, whoName, whoOf, type ChatWho,
} from '../../core/chat/chatModel'
import { EMPTY_DOCK, switchTool, toggleTool } from './dockModel'
import { NewSession } from './NewSession'
import { ToolButtons, ToolDock } from './ToolDock'
import { WhoAvatar } from '../../core/chat/WhoAvatar'

/** 一次先露多少条，往下点「显示更多」 */
const PAGE = 50
// 会话产出列表取一页就够
const ARTIFACT_LIMIT = 100

/** 还没有消息、也没在发第一句话的会话 */
function isEmpty(s: AgentSession): boolean {
  return !s.message_count && !hasLiveChat(s.id) && !firstMessageOf(s.id)
}

function SessionItem({ s, who, selected, onOpen }: {
  s: AgentSession
  who: ChatWho
  selected: boolean
  onOpen: () => void
}) {
  const live = useLiveChat(s.id)
  const sub = live?.phase === 'streaming' ? '正在回复…' : s.message_count ? `${s.message_count} 条消息` : '还没有消息'
  return (
    <button type="button" className={cls('chat-item', selected && 'sel')} aria-current={selected || undefined} onClick={onOpen}>
      {/* 已删除的 Agent、已删除的服务商不放头像（SPEC-sessions-1.27） */}
      {who.kind === 'agent' || (who.kind === 'provider' && who.provider)
        ? <WhoAvatar who={who} size={30} />
        : who.kind !== 'gone' && <span className="chat-item-noavatar" aria-hidden="true" />}
      <span className="chat-item-text">
        <span className="chat-item-top">
          <span className="ellipsis chat-item-title">{s.title || NEW_TITLE}</span>
          {/* 任务交给工作台 Agent 执行建的会话（TSK-0460）：标出来自任务，悬停是哪条 */}
          {s.source_ref?.kind === 'task_run' && (
            <span className="chat-item-tag" title={typeof s.source_ref.label === 'string' ? s.source_ref.label : undefined}>任务执行</span>
          )}
        </span>
        <span className="ellipsis list-sub">{whoName(who)}{who.kind === 'provider' ? ` · ${s.model}` : ''} · {sub}</span>
      </span>
      <span className="chat-item-time">{timeAgo(s.updated_at)}</span>
    </button>
  )
}

/** 会话的来源（内核 0047）：从哪条记录发起的；插件登记了这种来源时能点回去 */
function SessionSource({ source }: { source: SessionSourceRef | null | undefined }) {
  const link = useSessionSource(source)
  if (!link) return null
  return (
    <div className="chat-source">
      <span className="list-sub">来源</span>
      {link.to ? <SourceLink label={link.label} to={link.to} title={link.title} /> : <span className="ellipsis" title={link.title}>{link.label}</span>}
    </div>
  )
}

function SourceLink({ label, to, title }: { label: string; to: string; title?: string }) {
  const navigate = useNavigate()
  return <button type="button" className="link-btn ellipsis" title={title ?? `打开${label}`} onClick={() => navigate(to)}>{label}</button>
}

/** 会话头部下面的本会话产出（SPEC-sessions-3 的会话切片），没有就不占地方 */
function SessionOutputs({ sessionId }: { sessionId: string }) {
  const q = useArtifacts({ session_id: sessionId, limit: ARTIFACT_LIMIT })
  const [open, setOpen] = useState(false)
  const items = q.data?.data ?? []
  if (!items.length) return null
  return (
    <div className="chat-outputs">
      <button type="button" className="chat-outputs-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        这个会话产出了 {q.data?.total ?? items.length} 件东西
      </button>
      {open && (
        <ul className="chat-outputs-list">
          {items.map((a) => (
            <li key={a.id}>
              {a.url
                ? <a className="ellipsis" href={a.url} target="_blank" rel="noopener noreferrer">{a.title || a.url}</a>
                : <span className="ellipsis mono" title={a.path}>{a.rel_path || a.path}</span>}
              <span className="list-sub">{timeAgo(a.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function ChatsView({ current, onOpen, onOpenAgent, pickRequest = 0, onOpenRuns, onOpenOutputs, runsWaiting = 0 }: {
  current: string | null
  onOpen: (id: string | null) => void
  /** 头部点 Agent 名：去「设置 > Agent」它的配置页（SPEC-sessions-1.12）；权限没开时带 tab 直接打开工具与权限 */
  onOpenAgent?: (id: string, tab?: 'tools') => void
  /** 外面要打开新会话面板时加一（现在只有标题行的「新会话」，留着给别处用） */
  pickRequest?: number
  /** 会话清单底部两个并排按钮：去执行记录、产出结果（原来的二级菜单） */
  onOpenRuns?: () => void
  onOpenOutputs?: () => void
  /** 等你确认的执行记录数，「执行记录」按钮上的红点 */
  runsWaiting?: number
}) {
  const sessions = useAgentSessions()
  const providers = useAgentProviders()
  const agentsQ = useAgents()
  const create = useCreateAgentSession()
  const patch = usePatchAgentSession()
  const del = useDeleteAgentSession()
  // 停止（会话里正在跑的一轮，含关掉页面后仍在后台跑的）：在跑时头部给「停止」
  const running = useRunningAgentSessions()
  const stop = useStopAgentSession()
  // 切走时清掉空会话，和「删除会话」分开，失败不在头部报
  const drop = useDeleteAgentSession()

  const [filter, setFilter] = useState('')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [picking, setPicking] = useState(pickRequest > 0)
  // 渲染时对一下上次看到的请求号，变了就打开面板（不用 effect 再渲染一遍）
  const [seenPick, setSeenPick] = useState(pickRequest)
  if (pickRequest !== seenPick) {
    setSeenPick(pickRequest)
    setPicking(true)
  }
  const [editing, setEditing] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  // 新建时带的第一句话：打开这个会话时自动发出
  const [first, setFirst] = useState<{ sessionId: string; text: string } | null>(null)

  const all = useMemo(() => sessions.data ?? [], [sessions.data])
  const provs = useMemo(() => providers.data ?? [], [providers.data])
  const agents = agentsQ.data
  const who = (s: AgentSession) => whoOf(s, agents, provs)
  const kw = q.trim().toLowerCase()
  // 后端已按 updated_at 倒序；列表接口不带消息，搜索匹配标题、Agent 名和模型。没有消息的只列正打开的那条
  const rows = all.filter((s) => (s.id === current || !isEmpty(s))
    && matchAgentFilter(s, filter) && (!kw || `${s.title} ${whoName(who(s))} ${s.model}`.toLowerCase().includes(kw)))
  const shown = rows.slice(0, limit)
  const setF = (f: () => void) => { f(); setLimit(PAGE) }

  // Agent 筛选（SPEC-sessions-1.4）：按会话数倒序，右边「N 条」，没有会话又停用的提示「已停用」；
  // 有 Agent 已删除的会话时多一项「已删除的 Agent」，有不挂 Agent 的会话时多一项「不挂 Agent」
  const agentOpts = useMemo(() => {
    const usage = new Map<string, number>()
    let gone = 0
    let none = 0
    for (const s of all) {
      if (!s.agent_id) none++
      else if (s.agent_deleted) gone++
      else usage.set(s.agent_id, (usage.get(s.agent_id) ?? 0) + 1)
    }
    const n = (k: number) => (k ? `${k} 条` : undefined)
    return [
      ...[...(agents ?? [])].sort((a, b) => (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0)).map((a) => ({
        value: a.id, label: a.name || '未命名', hint: n(usage.get(a.id) ?? 0) ?? (a.enabled ? undefined : '已停用'),
        icon: <AgentAvatar agent={a} size={16} />,
      })),
      ...(gone ? [{ value: FILTER_GONE, label: GONE_AGENT, hint: n(gone) }] : []),
      ...(none ? [{ value: FILTER_NO_AGENT, label: '不挂 Agent 的会话', hint: n(none) }] : []),
    ]
  }, [all, agents])
  // 新会话选 Agent：最近聊过的在前（SPEC-sessions-1.6）
  const recentA = useMemo(() => recentAgents(agents ?? [], all), [agents, all])
  // 「更多」里选服务商：最近聊过的在前
  const recent = useMemo(() => {
    const last = new Map<string, string>()
    for (const s of all) if ((last.get(s.provider_id) ?? '') < s.updated_at) last.set(s.provider_id, s.updated_at)
    return [...provs].sort((a, b) => (last.get(b.id) ?? '').localeCompare(last.get(a.id) ?? ''))
  }, [provs, all])

  const cur = all.find((s) => s.id === current) ?? null

  // 会话旁边的工具（SPEC-sessions-1.34）：插件登记了才有入口；面板跟着会话页，切会话不收起
  const tools = useSessionTools()
  const [dock, setDock] = useState(EMPTY_DOCK)
  // 消息和对话面板共用一份缓存，不多发请求
  const curMsgs = useAgentMessages(cur?.id ?? null)
  const links = useMemo(() => sessionLinks(curMsgs.data ?? []), [curMsgs.data])
  const dockOpen = !!cur && tools.some((t) => t.key === dock.open)

  // 从一个空会话切走（点了别的会话、又新建了一个、从别处链接过来）就删掉它。
  // 按 current 的变化判断，不放在卸载时：离开会话页留下的空会话只是不列出来
  const latest = useRef(all)
  useEffect(() => { latest.current = all })
  const prevCur = useRef(current)
  const { mutate: dropSession } = drop
  useEffect(() => {
    const prev = prevCur.current
    prevCur.current = current
    if (!prev || prev === current) return
    const s = latest.current.find((x) => x.id === prev)
    if (s && isEmpty(s) && prev !== first?.sessionId) dropSession(prev)
  }, [current, first, dropSession])

  const open = (id: string | null) => { onOpen(id); setEditing(false); setConfirmDel(false) }
  const doCreate = (input: AgentSessionInput, text: string) => {
    create.mutate({ ...input, title: NEW_TITLE }, {
      onSuccess: (s) => {
        // 建好就关面板、清筛选，新会话在最前并打开（SPEC-sessions-1.7）
        setPicking(false)
        setFirst(text ? { sessionId: s.id, text } : null)
        setF(() => { setQ(''); setFilter('') })
        open(s.id)
      },
    })
  }
  const doDelete = (s: AgentSession) => {
    del.mutate(s.id, {
      onSuccess: () => {
        setConfirmDel(false)
        // 已经删了，切走时不用再清
        prevCur.current = null
        const rest = rows.filter((x) => x.id !== s.id)
        open(rest[0]?.id ?? null)
      },
    })
  }
  const rename = (s: AgentSession, title: string) => {
    setEditing(false)
    if (title && title !== s.title) patch.mutate({ id: s.id, patch: { title } })
  }

  let list
  if (sessions.isPending) list = <LoadingState />
  else if (sessions.isError) list = <ErrorState title="会话加载失败" error={sessions.error} onRetry={() => void sessions.refetch()} compact />
  else {
    list = (
      <>
        {shown.map((s, i) => {
          const g = whenGroup(s.updated_at)
          return (
            <Fragment key={s.id}>
              {g !== (i ? whenGroup(shown[i - 1].updated_at) : '') && <div className="menu-label chat-group">{g}</div>}
              <SessionItem s={s} who={who(s)} selected={s.id === current} onOpen={() => open(s.id)} />
            </Fragment>
          )
        })}
        {rows.length > shown.length && (
          <button type="button" className="agent-more" onClick={() => setLimit(limit + PAGE)}>显示更多（还有 {rows.length - shown.length} 条）</button>
        )}
        {!rows.length && <div className="tree-empty">{kw || filter ? '没有匹配的会话' : '还没有会话，点「新会话」和 Agent 聊聊'}</div>}
      </>
    )
  }

  const curWho = cur ? who(cur) : null
  return (
    <div className={cls('chats', dockOpen && 'with-dock')}>
      <PageTitle parent="会话" count={rows.length} desc="和 Agent 的对话都留在这里，能接着聊，也能回看每次调用了什么工具"
        actions={<Button variant="primary" onClick={() => setPicking(!picking)}>新会话</Button>}>会话</PageTitle>
      <div className="chat-list">
        <div className="chat-list-head">
          <div className="search search-full search-sm">
            <IconSearch />
            <input placeholder="搜会话标题、Agent 和模型" value={q} aria-label="搜会话" onChange={(e) => setF(() => setQ(e.target.value))} />
          </div>
          <div className="chat-filters">
            <SearchSelect value={filter} noneLabel="全部 Agent" placeholder="全部 Agent" searchPlaceholder="搜 Agent" options={agentOpts}
              missingLabel={() => GONE_AGENT} aria-label="按 Agent 筛选" onChange={(v) => setF(() => setFilter(v))} />
          </div>
        </div>
        {picking && (
          <NewSession agents={recentA} agentsLoading={agentsQ.isPending} providers={recent} busy={create.isPending} error={create.error ?? undefined}
            onCreate={doCreate} onClose={() => { setPicking(false); create.reset() }} />
        )}
        <div className="chat-items">{list}</div>
        {(onOpenRuns || onOpenOutputs) && (
          <div className="chat-list-foot" role="group" aria-label="执行记录和产出结果">
            {onOpenRuns && (
              <button type="button" className="btn btn-outline btn-sm" onClick={onOpenRuns} title="Agent 被消息、定时、任务触发后的每一次执行">
                执行记录{runsWaiting > 0 && <span className="chat-foot-dot" aria-label={`${runsWaiting} 条等你确认`} />}
              </button>
            )}
            {onOpenOutputs && (
              <button type="button" className="btn btn-outline btn-sm" onClick={onOpenOutputs} title="建的任务、写的文档、发的回复">产出结果</button>
            )}
          </div>
        )}
      </div>
      <div className="chat-main">
        {cur && curWho ? (
          <ChatPane key={cur.id} session={cur} who={curWho}
            autoSend={first?.sessionId === cur.id ? first.text : firstMessageOf(cur.id)}
            onRetitle={(title) => patch.mutate({ id: cur.id, patch: { title } })}
            onOpenTools={curWho.kind === 'agent' && onOpenAgent ? () => onOpenAgent(curWho.agent.id, 'tools') : undefined}
            head={(
              <>
                <div className="chat-head">
                  {(curWho.kind === 'agent' || (curWho.kind === 'provider' && curWho.provider)) && <WhoAvatar who={curWho} size={28} />}
                  {editing ? (
                    <input className="chat-title-input" autoFocus defaultValue={cur.title} aria-label="会话标题"
                      onBlur={(e) => rename(cur, e.target.value.trim())}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur()
                        if (e.key === 'Escape') setEditing(false)
                      }} />
                  ) : (
                    <button type="button" className="chat-title ellipsis" title="点一下改标题" onClick={() => setEditing(true)}>{cur.title || NEW_TITLE}</button>
                  )}
                  {curWho.kind === 'agent' ? (
                    <button type="button" className="link-btn chat-agent ellipsis" title={`${curWho.agent.model || cur.model}；点一下去「设置 > Agent」看它的配置`}
                      onClick={() => onOpenAgent?.(curWho.agent.id)}>
                      {whoName(curWho)}
                    </button>
                  ) : (
                    <span className="list-sub chat-agent ellipsis">{whoName(curWho)}{curWho.kind === 'provider' ? ` · ${cur.model}` : ''}</span>
                  )}
                  <span className="spacer" />
                  {!confirmDel && (
                    <ToolButtons tools={tools} dock={dock} workdir={cur.workdir} links={links} onToggle={(k) => setDock((d) => toggleTool(d, k))} />
                  )}
                  {!confirmDel && running.data?.includes(cur.id) && (
                    <Button size="sm" variant="danger" disabled={stop.isPending} title="停掉正在跑的这一轮；已经执行的操作不会撤回"
                      onClick={() => stop.mutate(cur.id)}>{stop.isPending ? '停止中…' : '停止'}</Button>
                  )}
                  {confirmDel ? (
                    <>
                      <span className="danger-text">删除会话？产出的任务、文档不受影响</span>
                      <Button size="sm" onClick={() => setConfirmDel(false)}>取消</Button>
                      <Button size="sm" variant="danger" disabled={del.isPending} onClick={() => doDelete(cur)}>删除</Button>
                    </>
                  ) : <Button size="sm" onClick={() => { del.reset(); setConfirmDel(true) }}>删除会话</Button>}
                </div>
                {del.isError && <div className="chat-head-err field-err">删除失败：{del.error.message}</div>}
                {stop.isError && <div className="chat-head-err field-err">没停下：{stop.error.message}</div>}
                <SessionSource source={cur.source_ref} />
                <SessionOutputs sessionId={cur.id} />
              </>
            )} />
        ) : (
          <div className="lib-reader-empty">{current && sessions.isSuccess ? '这个会话已经不在了' : all.length ? '从左边选一个会话' : sessions.isSuccess ? '还没有会话' : ''}</div>
        )}
      </div>
      {/* 没选中会话时（比如刚删掉一条）只藏起来，不卸载，终端和网页留着 */}
      <ToolDock tools={tools} dock={dockOpen ? dock : { ...dock, open: null }} sessionId={cur?.id ?? ''} workdir={cur?.workdir ?? ''} links={links}
        onSwitch={(k) => setDock((d) => switchTool(d, k))} onCollapse={() => setDock((d) => ({ ...d, open: null }))} />
    </div>
  )
}
