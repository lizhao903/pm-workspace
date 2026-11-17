// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 运行中心（P0-O1，SPEC-runs-1）：Agent 执行记录和任务执行一页看到。正式产品 frontend/src/modules/runs/Page.tsx，接 GET /api/runs/all。
// 原型没有后端：Agent 行来自会话模块的执行记录（seedAgentRuns），任务行来自任务的执行记录（devloop 的 runs）。
// 状态、来源在页面上筛；Agent 行能停、能重新执行（原型里重新执行是本页模拟：先执行中，几秒后完成），任务行能取消、能打开任务。
// 任务行的「缓存 N%」是模块前缀复用的命中率（8c098989，只有 DeepSeek（dsh）执行有 token 数据），原型按演示表给一条。
import { useEffect, useMemo, useState } from 'react'
import type { Agent, AgentRun } from './agentdata'
import type { Task, TaskRun } from './taskdata'
import { PageTitle } from './topbar'
import { cls, timeAgo } from './ui'
import './runs.css'

export type RunCenterKind = 'agent' | 'task'
/** 两种执行共用的状态；等你确认、已拒绝是 Agent 才有的 */
export type RunCenterStatus = 'running' | 'waiting' | 'done' | 'failed' | 'canceled' | 'rejected'

/** 运行中心的一行（正式产品 RunCenterItem）：Agent 行 title=Agent 名、sub=触发说明；任务行 title=「编号 标题」、sub=执行器中文名 */
export interface RunCenterItem {
  kind: RunCenterKind
  id: string
  status: RunCenterStatus
  title: string
  sub: string
  summary: string
  started_at: string
  finished_at: string | null
  /** 还在等确认的调用数 */
  pending: number
  session_id: string | null
  object_id: string
  /** 模块前缀复用（只有任务行有）：project:<对象 id> 或 workdir:<路径> */
  module_key?: string
  /** 缓存命中率 0~1；没有 token 数据时缺省 */
  cache_hit_ratio?: number
}

export const RUN_STATUS: Record<RunCenterStatus, { label: string; color: string }> = {
  running: { label: '执行中', color: 'var(--accent)' },
  waiting: { label: '等你确认', color: '#b0570b' },
  done: { label: '已完成', color: '#2f7d43' },
  rejected: { label: '已拒绝', color: '#a19d92' },
  failed: { label: '失败', color: '#c0352b' },
  canceled: { label: '已停止', color: 'var(--muted)' },
}

/** 一次先露多少条（正式产品 100；原型数据少，用 6 条演示「显示更多」） */
const PAGE = 6
const SEG: ('' | RunCenterStatus)[] = ['', 'running', 'waiting', 'failed', 'done', 'canceled']
const SOURCES: { key: '' | RunCenterKind; label: string }[] = [
  { key: '', label: '全部' },
  { key: 'agent', label: 'Agent' },
  { key: 'task', label: '任务' },
]
const HARNESS_LABEL: Record<string, string> = { claude: 'Claude Code', deepseek: 'DeepSeek', agent: '工作台 Agent', codex: 'Codex CLI' }

/** 演示用的模块前缀复用数据：正式产品由 dsh 的 token 用量算出，原型给一条已完成的任务执行挂上 */
const CACHE_DEMO: Record<string, { module_key: string; ratio: number }> = {
  run_d4: { module_key: 'workdir:~/code/demo-server', ratio: 0.82 },
}

/** 一次执行从开始到结束的耗时；还没结束的按现在算 */
export function runElapsed(item: Pick<RunCenterItem, 'started_at' | 'finished_at'>, now: number = Date.now()): string {
  const start = Date.parse(item.started_at)
  const end = item.finished_at ? Date.parse(item.finished_at) : now
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return ''
  const sec = Math.max(0, Math.round((end - start) / 1000))
  if (sec < 60) return `${sec} 秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return sec % 60 ? `${min} 分 ${sec % 60} 秒` : `${min} 分`
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分`
}

const Pill = ({ label, color }: { label: string; color: string }) => <span className="pill" style={{ '--c': color } as React.CSSProperties}><span className="pill-dot" />{label}</span>

/** 本页模拟的 Agent 停止 / 重新执行：key 是执行 id */
type Overlay = Record<string, { status: RunCenterStatus; finished_at: string | null; retryOf?: string }>

export function RunsCenterPage({ agents, agentRuns, taskRuns, tasks, onOpenAgentRun, onOpenTaskRun, onCancelTaskRun }: {
  agents: Agent[]
  agentRuns: AgentRun[]
  taskRuns: TaskRun[]
  tasks: Task[]
  /** 打开会话模块的执行记录并定位这一条 */
  onOpenAgentRun: (id: string) => void
  /** 打开任务抽屉的执行记录标签并定位这次执行 */
  onOpenTaskRun: (taskId: string, runId: string) => void
  onCancelTaskRun: (runId: string) => void
}) {
  const [status, setStatus] = useState<'' | RunCenterStatus>('')
  const [source, setSource] = useState<'' | RunCenterKind>('')
  const [limit, setLimit] = useState(PAGE)
  const [overlay, setOverlay] = useState<Overlay>({})
  const [retried, setRetried] = useState<RunCenterItem[]>([])
  const [now, setNow] = useState(() => Date.now())
  // 有在跑的就隔一会儿刷新耗时（正式产品每 5 秒重取一次）
  const anyRunning = taskRuns.some((r) => r.status === 'running') || retried.some((r) => (overlay[r.id]?.status ?? r.status) === 'running')
  useEffect(() => {
    if (!anyRunning) return
    const t = window.setInterval(() => setNow(Date.now()), 5000)
    return () => window.clearInterval(t)
  }, [anyRunning])

  const all = useMemo(() => {
    const agentRows: RunCenterItem[] = agentRuns.map((r) => ({
      kind: 'agent', id: r.id, status: r.status, title: agents.find((a) => a.id === r.agent_id)?.name ?? '已删除的 Agent',
      sub: r.trigger, summary: r.summary, started_at: r.at, finished_at: r.status === 'waiting' ? null : r.at,
      pending: r.calls.filter((c) => c.state === 'pending').length, session_id: null, object_id: '',
    }))
    const taskRows: RunCenterItem[] = taskRuns.map((r) => {
      const t = tasks.find((x) => x.id === r.task_id)
      const cache = CACHE_DEMO[r.id]
      return {
        kind: 'task', id: r.id, status: r.status === 'cancelled' ? 'canceled' : r.status,
        title: t ? `${t.ref} ${t.title}` : r.task_ref ?? '已删除的任务', sub: HARNESS_LABEL[r.harness ?? 'claude'] ?? r.harness ?? 'Claude Code',
        summary: r.summary ?? r.error ?? r.extra_prompt, started_at: r.started_at, finished_at: r.ended_at ?? null, pending: 0,
        session_id: r.agent_session ?? null, object_id: r.task_id,
        ...(cache && { module_key: cache.module_key, cache_hit_ratio: cache.ratio }),
      }
    })
    return [...retried, ...agentRows, ...taskRows]
      .map((x) => (overlay[x.id] ? { ...x, status: overlay[x.id].status, finished_at: overlay[x.id].finished_at } : x))
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
  }, [agentRuns, taskRuns, tasks, agents, overlay, retried])

  const filtered = all.filter((x) => (!status || x.status === status) && (!source || x.kind === source))
  const rows = filtered.slice(0, limit)

  const pickStatus = (k: '' | RunCenterStatus) => { setStatus(k); setLimit(PAGE) }
  const pickSource = (k: '' | RunCenterKind) => { setSource(k === source ? '' : k); setLimit(PAGE) }

  const stop = (id: string) => setOverlay((o) => ({ ...o, [id]: { status: 'canceled', finished_at: new Date().toISOString() } }))
  // 重新执行：按这次执行的输入再发起一次，新的一条在最上面，原型几秒后算完成
  const retry = (item: RunCenterItem) => {
    const id = `${item.id}_re${Date.now().toString(36)}`
    setRetried((xs) => [{ ...item, id, status: 'running', started_at: new Date().toISOString(), finished_at: null, summary: '重新执行中…', pending: 0 }, ...xs])
    window.setTimeout(() => {
      setRetried((xs) => xs.map((x) => (x.id === id ? { ...x, summary: '重新执行完成（原型模拟）' } : x)))
      setOverlay((o) => (o[id]?.status === 'canceled' ? o : { ...o, [id]: { status: 'done', finished_at: new Date().toISOString(), retryOf: item.id } }))
    }, 4000)
  }

  return (
    <div className="page runs-page">
      <PageTitle count={filtered.length} desc="Agent 执行和任务执行一页看到；在跑的能停止、取消，失败的能重新发起">运行中心</PageTitle>
      <div className="runs-toolbar">
        <div className="seg runs-seg" role="tablist" aria-label="状态">
          {SEG.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={status === k} className={cls(status === k && 'on')} onClick={() => pickStatus(k)}>
              {k ? RUN_STATUS[k].label : '全部'}
            </button>
          ))}
        </div>
        <div className="seg runs-seg" role="group" aria-label="来源">
          {SOURCES.map((s) => (
            <button key={s.key} type="button" aria-pressed={source === s.key} className={cls(source === s.key && 'on')} onClick={() => pickSource(s.key)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {!rows.length ? (
        status || source
          ? <div className="empty"><div className="empty-title">没有符合条件的运行记录</div><div className="muted">换个状态或来源看看</div></div>
          : <div className="empty"><div className="empty-title">还没有运行记录</div><div className="muted">Agent 被触发、任务被执行后，每一次执行都会出现在这里</div></div>
      ) : (
        <div className="runs-list">
          {rows.map((item) => {
            const st = RUN_STATUS[item.status]
            const isAgent = item.kind === 'agent'
            const elapsed = runElapsed(item, now)
            const openRow = () => (isAgent ? onOpenAgentRun(overlay[item.id]?.retryOf ?? item.id.replace(/_re[a-z0-9]+$/, '')) : onOpenTaskRun(item.object_id, item.id))
            return (
              <div key={`${item.kind}:${item.id}`} className="runs-row" data-kind={item.kind} data-status={item.status}>
                <div className="runs-row-main">
                  <div className="runs-row-top">
                    <Pill label={st.label} color={st.color} />
                    <button type="button" className="runs-title ellipsis" title={isAgent ? `打开执行记录 · ${item.title}` : `打开任务 · ${item.title}`} onClick={openRow}>{item.title}</button>
                    <span className="spacer" />
                    {!isAgent && item.cache_hit_ratio !== undefined && (
                      <span className="runs-elapsed" title={`命中率（模块前缀复用）${item.module_key ? ` · ${item.module_key}` : ''}`}>缓存 {Math.round(item.cache_hit_ratio * 100)}%</span>
                    )}
                    <span className="runs-time" title={item.started_at}>{timeAgo(item.started_at)}</span>
                    {elapsed && <span className="runs-elapsed" title="耗时">{elapsed}</span>}
                  </div>
                  <div className="runs-row-sub">
                    <span className="runs-sub ellipsis" title={item.sub}>{item.sub}</span>
                    {item.pending > 0 && <span className="runs-wait">{item.pending} 处等你确认</span>}
                  </div>
                  {item.summary && <div className="runs-summary ellipsis" title={item.summary}>{item.summary}</div>}
                </div>
                <div className="runs-acts">
                  {isAgent && item.status === 'running' && <button className="act act-danger" title="停掉这次执行；已经执行的调用不会撤回" onClick={() => stop(item.id)}>停止</button>}
                  {isAgent && (item.status === 'failed' || item.status === 'canceled') && <button className="act" title="按这次执行的输入重新发起一次" onClick={() => retry(item)}>重新执行</button>}
                  {!isAgent && item.status === 'running' && <button className="act act-danger" title="取消这次任务执行" onClick={() => onCancelTaskRun(item.id)}>取消</button>}
                  {!isAgent && <button className="act" onClick={openRow}>打开任务</button>}
                </div>
              </div>
            )
          })}
          {filtered.length > rows.length && (
            <button type="button" className="runs-more" onClick={() => setLimit(limit + PAGE)}>显示更多（还有 {filtered.length - rows.length} 条）</button>
          )}
        </div>
      )}
    </div>
  )
}
