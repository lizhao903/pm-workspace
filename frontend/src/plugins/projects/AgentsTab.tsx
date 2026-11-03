// Agent 标签（SPEC-projects-10）：项目 Agent（props.agent_ids，第一个是默认）和在项目里开的会话。
// 「对话」建一个挂这个 Agent 的会话，工作目录用项目目录，会话 id 记进 props.session_ids，再切到会话页打开它。
// 会话页还没有按项目筛选，多于 10 条时就地「显示全部」（SPEC-projects-10.8 的退化写法）
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  errorText, projectView, useAgentSessions, useAgents, useSaveProject, type WorkObject,
} from '../../core/data'
import { AgentAvatar } from '../../core/ui/AgentAvatar'
import { Button, ErrorState, LoadingState, SearchSelect } from '../../core/ui'
import { SESSION_PEEK, addAgent, availAgents, linkedAgents, makeDefault, projectSessions, removeAgent } from './agentModel'
import { ago } from './model'
import { NEW_TITLE, SESSIONS_PATH, useProjectChat } from './projectChat'

const AGENT_PATH = '/settings/agents'

export function AgentsTab({ project }: { project: WorkObject }) {
  const p = projectView(project)
  const navigate = useNavigate()
  const agentsQ = useAgents()
  const sessionsQ = useAgentSessions()
  const save = useSaveProject()
  const chat = useProjectChat(project)
  const [err, setErr] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  const agents = useMemo(() => agentsQ.data ?? [], [agentsQ.data])
  const mine = useMemo(() => linkedAgents(p.agentIds, agents), [p.agentIds, agents])
  const avail = availAgents(p.agentIds, agents)
  const chats = useMemo(() => projectSessions(p.sessionIds, sessionsQ.data ?? []), [p.sessionIds, sessionsQ.data])
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])
  const busy = save.isPending || chat.pending

  const setIds = (ids: string[]) => {
    setErr('')
    save.mutate({ id: p.id, props: { agent_ids: ids } }, { onError: (e) => setErr(`没存上：${errorText(e)}`) })
  }
  const openAgent = (id: string) => navigate(`${AGENT_PATH}/${encodeURIComponent(id)}`)
  const openSession = (id: string) => navigate(`${SESSIONS_PATH}?s=${encodeURIComponent(id)}`)

  const head = (
    <div className="pj-tab-head">
      <span className="pj-muted pj-wrap">第一个是默认项目 Agent；在这里开的会话归到这个项目，能读这个项目的材料和文档</span>
      <span className="spacer" />
      <SearchSelect value="" placeholder="加 Agent" searchPlaceholder="搜 Agent" align="end" active={false}
        disabled={!agentsQ.data || busy}
        options={avail.map((a) => ({
          value: a.id, label: a.name || '未命名', keywords: a.desc, hint: a.enabled ? undefined : '已停用', disabled: !a.enabled,
          icon: <AgentAvatar agent={a} size={18} />,
        }))}
        emptyText="Agent 都已经加进来了" onChange={(id) => { if (id) setIds(addAgent(p.agentIds, id)) }} />
    </div>
  )

  let agentList
  if (agentsQ.isPending) agentList = <LoadingState />
  else if (agentsQ.isError) agentList = <ErrorState title="Agent 没加载出来" error={errorText(agentsQ.error)} onRetry={() => void agentsQ.refetch()} />
  else if (!mine.length) agentList = <div className="pj-mount-empty">还没给项目配 Agent</div>
  else {
    agentList = (
      <ul className="pj-mat-list" aria-label="项目 Agent">
        {mine.map((a, i) => (
          <li key={a.id} className="pj-mat pj-sop pj-agent">
            <AgentAvatar agent={a} size={32} />
            <button type="button" className="pj-sop-text" title="在设置里打开这个 Agent" onClick={() => openAgent(a.id)}>
              <span><b className="pj-mat-name">{a.name || '未命名'}</b>{i === 0 && <span className="tag pj-agent-def">默认</span>}</span>
              <span className="pj-muted pj-wrap">{a.enabled ? a.desc : '已停用'}</span>
            </button>
            {i > 0 && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setIds(makeDefault(p.agentIds, a.id))}>设为默认</Button>}
            <Button variant="primary" size="sm" disabled={!a.enabled || busy} title={a.enabled ? undefined : '这个 Agent 已停用'} onClick={() => chat.start(a.id)}>对话</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setIds(removeAgent(p.agentIds, a.id))}>移除</Button>
          </li>
        ))}
      </ul>
    )
  }

  const shown = showAll ? chats : chats.slice(0, SESSION_PEEK)
  return (
    <div className="pj-tab">
      {head}
      {(err || chat.err) && <div className="pj-err" role="alert">{err || chat.err}</div>}
      {agentList}
      <section className="pj-sop-runs" aria-label="项目里的会话">
        <h3 className="pj-sec-title">项目里的会话{chats.length > SESSION_PEEK && <span className="pj-muted"> {chats.length}</span>}</h3>
        {sessionsQ.isPending ? <LoadingState />
          : sessionsQ.isError ? <ErrorState compact error={`会话没加载出来：${errorText(sessionsQ.error)}`} onRetry={() => void sessionsQ.refetch()} />
            : chats.length ? (
              <div className="pj-table">
                {shown.map((s) => {
                  const a = s.agent_id ? byId.get(s.agent_id) : undefined
                  return (
                    <button key={s.id} type="button" className="pj-agent-chat" onClick={() => openSession(s.id)}>
                      {a ? <AgentAvatar agent={a} size={20} /> : <span className="pj-agent-noav" aria-hidden="true" />}
                      <span className="ellipsis">{s.title || NEW_TITLE}</span>
                      <span className="pj-muted ellipsis">{a?.name ?? ''}</span>
                      <span className="pj-muted" title={s.updated_at}>{ago(s.updated_at, now)}</span>
                    </button>
                  )
                })}
                {chats.length > SESSION_PEEK && (
                  <button type="button" className="pj-more" onClick={() => setShowAll(!showAll)}>
                    {showAll ? '收起' : <>显示全部<span className="pj-muted">还有 {chats.length - SESSION_PEEK} 条</span></>}
                  </button>
                )}
              </div>
            ) : <div className="pj-mount-empty">还没有项目会话；点上面的「对话」开一个</div>}
      </section>
    </div>
  )
}
