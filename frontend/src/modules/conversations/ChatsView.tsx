// 会话（SPEC-sessions-1）：左边全局会话列表（搜索、按服务商筛、按时间分段），右边当前会话的对话。
// 当前会话记在 ?s=，别的页面能直接链接到某个会话。
import { Fragment, useMemo, useState } from 'react'
import {
  useAgentProviders, useAgentSessions, useArtifacts, useCreateAgentSession, useDeleteAgentSession, usePatchAgentSession,
  type AgentProvider, type AgentSession, type AgentSessionInput,
} from '../../core/data'
import { Avatar, Button, ErrorState, IconSearch, LoadingState, PageTitle, SearchSelect, cls } from '../../core/ui'
import { ChatPane } from './ChatPane'
import { useLiveChat } from './chatLive'
import { NEW_TITLE, avatarName, timeAgo, whenGroup } from './chatModel'
import { NewSession } from './NewSession'

/** 一次先露多少条，往下点「显示更多」 */
const PAGE = 50
// 会话产出列表取一页就够
const ARTIFACT_LIMIT = 100

function SessionItem({ s, provider, selected, onOpen }: {
  s: AgentSession
  provider: AgentProvider | undefined
  selected: boolean
  onOpen: () => void
}) {
  const live = useLiveChat(s.id)
  const sub = live?.phase === 'streaming' ? '正在回复…' : s.message_count ? `${s.message_count} 条消息` : '还没有消息'
  return (
    <button type="button" className={cls('chat-item', selected && 'sel')} aria-current={selected || undefined} onClick={onOpen}>
      {provider ? <Avatar name={avatarName(provider)} size={30} /> : <span className="chat-item-noavatar" aria-hidden="true" />}
      <span className="chat-item-text">
        <span className="chat-item-top"><span className="ellipsis chat-item-title">{s.title || NEW_TITLE}</span></span>
        <span className="ellipsis list-sub">{provider ? provider.name || '未命名' : '已删除的服务商'} · {s.model} · {sub}</span>
      </span>
      <span className="chat-item-time">{timeAgo(s.updated_at)}</span>
    </button>
  )
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

export function ChatsView({ current, onOpen, pickRequest = 0 }: {
  current: string | null
  onOpen: (id: string | null) => void
  /** 二级菜单里点「新会话」时加一，这边打开新会话面板 */
  pickRequest?: number
}) {
  const sessions = useAgentSessions()
  const providers = useAgentProviders()
  const create = useCreateAgentSession()
  const patch = usePatchAgentSession()
  const del = useDeleteAgentSession()

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
  const providerOf = (id: string) => provs.find((p) => p.id === id)
  const kw = q.trim().toLowerCase()
  // 后端已按 updated_at 倒序；列表接口不带消息，搜索只匹配标题和模型
  const rows = all.filter((s) => (!filter || s.provider_id === filter) && (!kw || `${s.title} ${s.model}`.toLowerCase().includes(kw)))
  const shown = rows.slice(0, limit)
  const setF = (f: () => void) => { f(); setLimit(PAGE) }

  const usage = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of all) m.set(s.provider_id, (m.get(s.provider_id) ?? 0) + 1)
    return m
  }, [all])
  const providerOpts = useMemo(() => [...provs].sort((a, b) => (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0)).map((p) => ({
    value: p.id, label: p.name || '未命名', hint: usage.get(p.id) ? `${usage.get(p.id)} 条` : p.enabled ? undefined : '已停用',
  })), [provs, usage])
  // 新会话选服务商：最近聊过的在前
  const recent = useMemo(() => {
    const last = new Map<string, string>()
    for (const s of all) if ((last.get(s.provider_id) ?? '') < s.updated_at) last.set(s.provider_id, s.updated_at)
    return [...provs].sort((a, b) => (last.get(b.id) ?? '').localeCompare(last.get(a.id) ?? ''))
  }, [provs, all])

  const cur = all.find((s) => s.id === current) ?? null

  const open = (id: string | null) => { onOpen(id); setEditing(false); setConfirmDel(false) }
  const doCreate = (input: AgentSessionInput, text: string) => {
    create.mutate({ ...input, title: NEW_TITLE }, {
      onSuccess: (s) => {
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
              <SessionItem s={s} provider={providerOf(s.provider_id)} selected={s.id === current} onOpen={() => open(s.id)} />
            </Fragment>
          )
        })}
        {rows.length > shown.length && (
          <button type="button" className="agent-more" onClick={() => setLimit(limit + PAGE)}>显示更多（还有 {rows.length - shown.length} 条）</button>
        )}
        {!rows.length && <div className="tree-empty">{kw || filter ? '没有匹配的会话' : '还没有会话，点「新会话」开始聊'}</div>}
      </>
    )
  }

  const provider = cur ? providerOf(cur.provider_id) : undefined
  return (
    <div className="chats">
      <PageTitle parent="会话" count={rows.length} desc="和 Agent 的对话都留在这里，能接着聊，也能回看每次调用了什么工具"
        actions={<Button variant="primary" onClick={() => setPicking(!picking)}>新会话</Button>}>会话</PageTitle>
      <div className="chat-list">
        <div className="chat-list-head">
          <div className="search search-full search-sm">
            <IconSearch />
            <input placeholder="搜会话标题和模型" value={q} aria-label="搜会话" onChange={(e) => setF(() => setQ(e.target.value))} />
          </div>
          <div className="chat-filters">
            <SearchSelect value={filter} noneLabel="全部服务商" placeholder="全部服务商" searchPlaceholder="搜服务商" options={providerOpts}
              missingLabel={() => '已删除的服务商'} aria-label="按服务商筛选" onChange={(v) => setF(() => setFilter(v))} />
          </div>
        </div>
        {picking && (
          <NewSession providers={recent} busy={create.isPending} error={create.error ?? undefined}
            onCreate={doCreate} onClose={() => { setPicking(false); create.reset() }} />
        )}
        <div className="chat-items">{list}</div>
      </div>
      <div className="chat-main">
        {cur ? (
          <ChatPane key={cur.id} session={cur} provider={provider}
            autoSend={first?.sessionId === cur.id ? first.text : undefined}
            onRetitle={(title) => patch.mutate({ id: cur.id, patch: { title } })}
            head={(
              <>
                <div className="chat-head">
                  {provider && <Avatar name={avatarName(provider)} size={28} />}
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
                  <span className="list-sub chat-agent ellipsis">{provider ? provider.name || '未命名' : '已删除的服务商'} · {cur.model}</span>
                  <span className="spacer" />
                  {confirmDel ? (
                    <>
                      <span className="danger-text">删除会话？产出的文件、任务不受影响</span>
                      <Button size="sm" onClick={() => setConfirmDel(false)}>取消</Button>
                      <Button size="sm" variant="danger" disabled={del.isPending} onClick={() => doDelete(cur)}>删除</Button>
                    </>
                  ) : <Button size="sm" onClick={() => { del.reset(); setConfirmDel(true) }}>删除会话</Button>}
                </div>
                {del.isError && <div className="chat-head-err field-err">删除失败：{del.error.message}</div>}
                <SessionOutputs sessionId={cur.id} />
              </>
            )} />
        ) : (
          <div className="lib-reader-empty">{current && sessions.isSuccess ? '这个会话已经不在了' : all.length ? '从左边选一个会话' : sessions.isSuccess ? '还没有会话' : ''}</div>
        )}
      </div>
    </div>
  )
}
