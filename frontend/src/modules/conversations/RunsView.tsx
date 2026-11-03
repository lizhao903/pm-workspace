// 执行记录（SPEC-sessions-2，AG-01b8）：Agent 被任务、IM 消息、定时任务触发后的每一次执行，接 /api/agent-runs。
// 状态、Agent 在后端筛，等你确认的在前（后端排序）；卡片展开时取详情看调用。?run= 定位到一条：清掉筛选、展开、滚到中间、高亮约 2 秒。
// 等确认的调用卡片默认展开，卡片上直接「确认执行 / 拒绝」（AG-02b，SPEC-sessions-2.5），接着跑的回复在它的会话里，跑完执行记录的状态重算。
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AGENT_RUN_STATUS, errorText, useAgentRun, useAgentRunCounts, useAgentRunList, useAgentRuns, useAgents,
  type Agent, type AgentRun, type AgentRunStatus,
} from '../../core/data'
import { Button, EmptyState, ErrorState, IconChevronRight, LoadingState, PageTitle, Pill, SearchSelect, cls } from '../../core/ui'
import { AgentAvatar } from '../../core/ui/AgentAvatar'
import { CallCard } from './CallCard'
import { decideCall, useDeciding, useLiveChat } from './chatLive'
import { GONE_AGENT, timeAgo, type CallView } from './chatModel'
import { runCallViews, topAgents } from './runModel'

/** 一次先露多少条，往下点「显示更多」 */
const PAGE = 50
// 高亮多久
const LIT_MS = 2400
// 状态切换：全部 + 原型的四种；「执行中」只在有的时候出现
const SEG: ('' | AgentRunStatus)[] = ['', 'waiting', 'done', 'rejected', 'failed']
const COUNTED: string[] = ['', 'waiting', 'done', 'rejected', 'failed', 'running']

const statusOf = (s: string) => AGENT_RUN_STATUS[s as AgentRunStatus] ?? { label: s, color: undefined }

/** 执行记录里等确认的调用：确认、拒绝走会话的接着跑，失败原因取那个会话这一轮的 */
function RunConfirm({ call, sessionId, agentOk, goSession }: { call: CallView; sessionId: string | null; agentOk: boolean; goSession: ReactNode }) {
  const deciding = useDeciding(call.id)
  const live = useLiveChat(sessionId)
  const failed = live?.phase === 'failed' && live.decide?.callId === call.id ? live.error : undefined
  if (!call.id || !sessionId) return <div className="act-row call-confirm-hint">{goSession}</div>
  const id = call.id
  const sid = sessionId
  return (
    <>
      <div className="act-row call-confirm">
        <Button size="sm" variant="primary" disabled={!agentOk || deciding} onClick={() => decideCall(sid, id, true)}>{deciding ? '正在处理' : '确认执行'}</Button>
        <Button size="sm" disabled={!agentOk || deciding} onClick={() => decideCall(sid, id, false)}>拒绝</Button>
        {goSession}
      </div>
      {!agentOk && <div className="list-sub">Agent 已停用或已删除，确认、拒绝都处理不了；先在「设置 / Agent」里启用</div>}
      {failed && <div className="field-err" role="alert">没处理成：{failed}</div>}
    </>
  )
}

function RunCard({ run, agent, open, lit, onToggle, onOpenSession }: {
  run: AgentRun
  agent: Agent | undefined
  open: boolean
  lit: boolean
  onToggle: () => void
  onOpenSession: (id: string) => void
}) {
  const detail = useAgentRun(run.id, open)
  const st = statusOf(run.status)
  const calls = useMemo(() => (detail.data ? runCallViews(detail.data.calls, detail.data.tool_calls) : []), [detail.data])
  // 不挂对象的会话在会话页里；任务触发的会话挂在任务下，不在全局会话列表里
  const canOpen = !!run.session_id && run.trigger_kind !== 'task'
  const goSession = canOpen
    ? <button type="button" className="link-btn" onClick={() => onOpenSession(run.session_id!)}>去会话里看</button>
    : <span className="list-sub">对话在这条任务的 Agent 会话里</span>
  return (
    <div data-run={run.id} data-status={run.status}
      className={cls('agent-run', run.status === 'waiting' && 'waiting', !open && 'folded', lit && 'lit')}>
      <button type="button" className="agent-run-head" aria-expanded={open} title={open ? '收起' : '展开看调用'} onClick={onToggle}>
        <span className={cls('call-chev', open && 'open')} aria-hidden="true"><IconChevronRight /></span>
        {agent && <AgentAvatar agent={agent} size={24} />}
        <span className="agent-run-agent ellipsis">{agent ? agent.name || '未命名' : GONE_AGENT}</span>
        <Pill label={st.label} color={st.color} />
        <span className="agent-run-trigger ellipsis">{run.trigger}</span>
        <span className="spacer" />
        {run.pending > 0 && <span className="agent-run-n agent-run-wait">{run.pending} 处等你确认</span>}
        {!open && detail.data && <span className="run-muted agent-run-n">{calls.length} 次调用</span>}
        <span className="run-muted agent-run-n" title={run.started_at}>{timeAgo(run.started_at)}</span>
      </button>
      {open && (
        <>
          {run.summary && <div className={cls('agent-run-summary', run.status === 'failed' && 'danger-text')}>{run.summary}</div>}
          {detail.isPending ? <LoadingState />
            : detail.isError ? <div className="field-err">调用没取到：{errorText(detail.error)}</div>
            : (
              <div className="call-list">
                {calls.map((c, i) => (
                  <CallCard key={c.id ?? i} call={c}>
                    {c.state === 'pending' && <RunConfirm call={c} sessionId={run.session_id} agentOk={!!agent?.enabled} goSession={goSession} />}
                  </CallCard>
                ))}
                {!calls.length && <div className="list-sub">{run.status === 'running' ? '正在执行，还没有调用' : '这次执行没有调用工具'}</div>}
              </div>
            )}
          {run.session_id && canOpen && run.status !== 'waiting' && (
            <div><button type="button" className="link-btn link-muted" onClick={() => onOpenSession(run.session_id!)}>在会话里看完整对话</button></div>
          )}
        </>
      )}
    </div>
  )
}

export function RunsView({ focus, onOpenSession, onFocused, onBack }: {
  /** 标题上的「会话」点了回会话页 */
  onBack?: () => void
  /** ?run= 带来的那一条 */
  focus?: string | null
  onOpenSession: (sessionId: string) => void
  onFocused?: () => void
}) {
  const [filter, setFilter] = useState('')
  const [st, setSt] = useState<'' | AgentRunStatus>('')
  const [limit, setLimit] = useState(PAGE)
  /** 手动展开、收起过的；没动过的只展开等你确认的 */
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const [lit, setLit] = useState<string | null>(null)
  // 渲染时对一下上次看到的定位，变了就清筛选、展开、高亮（不用 effect 再渲染一遍）
  const [seenFocus, setSeenFocus] = useState<string | null>(null)
  if ((focus ?? null) !== seenFocus) {
    setSeenFocus(focus ?? null)
    if (focus) {
      setFilter('')
      setSt('')
      setLimit(PAGE)
      setToggled((t) => ({ ...t, [focus]: true }))
      setLit(focus)
    }
  }

  const list = useAgentRunList({ agent: filter || undefined, status: st ? [st] : undefined, limit })
  const counts = useAgentRunCounts(COUNTED)
  const agentsQ = useAgents()
  const agents = useMemo(() => agentsQ.data ?? [], [agentsQ.data])
  // chip 按执行记录数排：用设置页那份最近 200 条（等确认的在前）估一下
  const brief = useAgentRuns()
  const usage = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of brief.data ?? []) m.set(r.agent_id, (m.get(r.agent_id) ?? 0) + 1)
    return m
  }, [brief.data])
  const { chips, rest } = topAgents(agents, usage)

  // 定位的那一条不在这一页里（太靠后）时单独取来放在最前；不存在就只停在本页
  const rows = list.data?.data ?? []
  const focusMissing = !!lit && list.isSuccess && !rows.some((r) => r.id === lit)
  const focused = useAgentRun(lit, focusMissing)
  const shown = focusMissing && focused.data ? [focused.data, ...rows] : rows
  const litShown = !!lit && shown.some((r) => r.id === lit)

  useEffect(() => {
    if (!lit || !litShown) return
    // id 来自地址栏，不拼进选择器
    const el = [...document.querySelectorAll<HTMLElement>('[data-run]')].find((x) => x.dataset.run === lit)
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    onFocused?.()
    const t = window.setTimeout(() => setLit(null), LIT_MS)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lit, litShown])

  const pickSt = (k: '' | AgentRunStatus) => { setSt(k); setLimit(PAGE) }
  // 单选，再点一次取消
  const pickAgent = (id: string) => { setFilter(id === filter ? '' : id); setLimit(PAGE) }
  const total = list.data?.total ?? 0
  const all = counts[''] ?? 0
  const inMore = !!filter && rest.some((a) => a.id === filter)

  let body
  if (list.isPending) body = <LoadingState />
  else if (list.isError) body = <ErrorState title="执行记录加载失败" error={list.error} onRetry={() => void list.refetch()} />
  else if (!shown.length) {
    body = filter || st
      ? <EmptyState title="没有符合条件的执行记录" desc="换个状态或 Agent 看看" />
      : <EmptyState title="没有执行记录" desc="Agent 被触发后，每次调用了什么工具、输入输出是什么都会留在这里" />
  } else {
    body = (
      <div className="agent-runs">
        {shown.map((r) => {
          const open = toggled[r.id] ?? r.status === 'waiting'
          return (
            <RunCard key={r.id} run={r} agent={agents.find((a) => a.id === r.agent_id)} open={open} lit={lit === r.id}
              onToggle={() => setToggled({ ...toggled, [r.id]: !open })} onOpenSession={onOpenSession} />
          )
        })}
        {total > rows.length && (
          <button type="button" className="agent-more" disabled={list.isFetching} onClick={() => setLimit(limit + PAGE)}>
            显示更多（还有 {total - rows.length} 条）
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="conv-page">
      <PageTitle parent={onBack ? <button type="button" className="link-btn tb-back" onClick={onBack}>会话</button> : '会话'} count={list.isSuccess ? total : undefined}
        desc="Agent 被消息、定时、任务触发后的每一次执行；写操作等你确认的在这里处理">执行记录</PageTitle>
      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="状态">
          {[...SEG, ...(counts.running ? ['running' as const] : [])].map((k) => (
            <button key={k} type="button" role="tab" aria-selected={st === k} className={cls(st === k && 'on')} onClick={() => pickSt(k)}>
              {k ? statusOf(k).label : '全部'}<span className="seg-n">{k ? counts[k] ?? '' : all}</span>
            </button>
          ))}
        </div>
        {agents.length > 0 && (
          <div className="out-agents" role="group" aria-label="Agent">
            <button type="button" className={cls('chip', !filter && 'chip-on')} aria-pressed={!filter} onClick={() => pickAgent('')}>全部 Agent</button>
            {chips.map((a) => (
              <button key={a.id} type="button" className={cls('chip agent-chip', filter === a.id && 'chip-on')} aria-pressed={filter === a.id}
                title={a.name} onClick={() => pickAgent(a.id)}>
                <AgentAvatar agent={a} size={16} /><span className="ellipsis agent-chip-name">{a.name || '未命名'}</span>
              </button>
            ))}
            {rest.length > 0 && (
              <SearchSelect value={inMore ? filter : ''} placeholder={`更多 Agent（${rest.length}）`} searchPlaceholder="搜 Agent" aria-label="更多 Agent"
                options={rest.map((a) => ({ value: a.id, label: a.name || '未命名', hint: usage.get(a.id) ? `${usage.get(a.id)} 条` : undefined, icon: <AgentAvatar agent={a} size={16} /> }))}
                onChange={(v) => { setFilter(v); setLimit(PAGE) }} />
            )}
          </div>
        )}
      </div>
      {body}
    </div>
  )
}
