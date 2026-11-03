// Webhook 接入（SPEC-tasks-9）：列表，筛选全部 / 最近失败 / 已停用，最近失败的排在前面。
// WebhooksView 按路由在列表、配置页（SPEC-tasks-10）之间切换，管从推送记录打开的任务抽屉。
import { useState } from 'react'
import {
  hookPath, useLastDeliveries, useWebhooks, useWebhookUsages,
  type DictItem, type LastDelivery, type ObjectStatus, type Webhook, type WebhookUsage, type WorkObject,
} from '../../core/data'
import { Button, EmptyState, ErrorState, IconClose, IconSearch, LoadingState, PageTitle, Pill, cls } from '../../core/ui'
import { timeAgo } from './model'
import { TaskById } from './Schedules'
import { WebhookPage } from './WebhookPage'
import { RESULT, deliveryText, isFailing, matchHook, sortHooks, type HookFilter } from './webhookModel'
import './schedules.css'
import './webhooks.css'

// 列表「最近推送」多久重取一次（外部推送不发投递事件）
export const LAST_DELIVERY_POLL_MS = 60_000

/** route：list 是列表，new 是新建，其余是 Webhook id */
export function WebhooksView({ route, statuses, priorities, projects, onOpenHook, onNewHook, onList }: {
  route: string
  statuses: ObjectStatus[]
  priorities: DictItem[]
  projects: WorkObject[]
  onOpenHook: (id: string) => void
  onNewHook: () => void
  onList: () => void
}) {
  const list = useWebhooks()
  const hooks = list.data ?? []
  const ids = hooks.map((h) => h.id)
  const last = useLastDeliveries(ids, LAST_DELIVERY_POLL_MS)
  const usage = useWebhookUsages(ids)
  const [taskId, setTaskId] = useState<string | null>(null)

  let main
  if (route === 'list') {
    main = (
      <WebhooksPage hooks={hooks} loading={list.isPending} error={list.isError ? list.error : undefined}
        onRetry={() => void list.refetch()} last={last} usage={usage} onOpen={onOpenHook} onNew={onNewHook} />
    )
  } else if (route === 'new') {
    main = <WebhookPage key="new" hook={null} priorities={priorities} onSaved={onOpenHook} onDeleted={onList} onCancel={onList} onOpenTask={setTaskId} />
  } else if (list.isError) {
    main = <div className="tasks-page"><ErrorState title="Webhook 加载失败" error={list.error} onRetry={() => void list.refetch()} /></div>
  } else if (list.isPending) {
    main = <div className="tasks-page"><LoadingState /></div>
  } else {
    const hook = hooks.find((h) => h.id === route)
    main = hook
      // 换一个 Webhook 就重新挂载，表单从它的值重新开始
      ? <WebhookPage key={hook.id} hook={hook} priorities={priorities} onSaved={onOpenHook} onDeleted={onList} onCancel={onList} onOpenTask={setTaskId} />
      : (
        <div className="tasks-page">
          <EmptyState title="这个 Webhook 已删除" desc="可能在别处删掉了，或者链接写错了"
            action={<Button variant="outline" onClick={onList}>回到 Webhook 接入</Button>} />
        </div>
      )
  }

  return (
    <>
      {main}
      {taskId && <TaskById id={taskId} statuses={statuses} priorities={priorities} projects={projects} onClose={() => setTaskId(null)} back="回到 Webhook" />}
    </>
  )
}

export function WebhooksPage({ hooks, loading, error, onRetry, last, usage, onOpen, onNew, now: nowProp }: {
  hooks: Webhook[]
  loading?: boolean
  error?: unknown
  onRetry?: () => void
  /** 每个 Webhook 最近一次投递；undefined 是没取到 */
  last: Record<string, LastDelivery | undefined>
  usage: Record<string, WebhookUsage | undefined>
  onOpen: (id: string) => void
  onNew: () => void
  /** 测试里固定「现在」 */
  now?: Date
}) {
  const [opened] = useState(() => new Date())
  const now = nowProp ?? opened
  const [q, setQ] = useState('')
  const [f, setF] = useState<HookFilter>('')
  // 拿不到推送记录时不显示「最近失败」，推送相关的列显示「-」，不当成「没收到推送」
  const known = hooks.every((h) => last[h.id] !== undefined)
  const pass = (h: Webhook, k: HookFilter) => !k || (k === 'failed' ? isFailing(last[h.id]) : !h.enabled)
  const filter = f === 'failed' && !known ? '' : f
  const rows = sortHooks(hooks.filter((h) => pass(h, filter) && matchHook(h, q)), last)
  const filters: [HookFilter, string][] = [['', '全部'], ...(known ? [['failed', '最近失败'] as [HookFilter, string]] : []), ['off', '已停用']]
  const base = typeof window === 'undefined' ? '' : window.location.origin

  let body
  if (error) body = <ErrorState title="Webhook 加载失败" error={error} onRetry={onRetry} />
  else if (loading) body = <LoadingState />
  else if (!rows.length) {
    body = q.trim() || filter
      ? <EmptyState title="没有匹配的 Webhook" desc="换个筛选条件试试" />
      : <EmptyState title="还没有 Webhook" desc="建一个 Webhook，把接收地址填到 Sentry、表单、工单系统里，推过来的事件自动变成任务"
        action={<Button variant="outline" onClick={onNew}>新建 Webhook</Button>} />
  } else {
    body = (
      <div className="task-table">
        <div className="hook-row task-th" aria-hidden="true"><span>名称</span><span>接收地址</span><span>最近推送</span><span>推送时间</span><span>建了任务</span><span>启用</span></div>
        {rows.map((h) => {
          const ld = last[h.id]
          const d = ld?.last
          const made = usage[h.id]?.tasks
          const failed = d?.result === 'failed'
          return (
            <div key={h.id} role="button" tabIndex={0} aria-label={h.name || '未命名'}
              className={cls('hook-row', !h.enabled && 'is-off', failed && 'is-failed')}
              onClick={() => onOpen(h.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(h.id) } }}>
              <span className="task-main"><span className="task-title"><span className="ellipsis" title={h.name}>{h.name || '未命名'}</span></span></span>
              <span className="run-muted ellipsis mono" title={`${base}${hookPath(h.token)}`}>…/{h.token}</span>
              <span className="sched-action">
                {d ? <><Pill {...RESULT[d.result]} /><span className="ellipsis run-muted" title={deliveryText(d)}>{deliveryText(d)}</span></>
                  : <span className="run-muted">{ld ? '还没收到推送' : '-'}</span>}
              </span>
              <span className={cls('run-muted', failed && 'danger-text')}>{d ? timeAgo(d.at, now) : '-'}</span>
              <span className="run-muted" title={ld && made !== undefined ? `推送 ${ld.total} 次，建了 ${made} 条任务` : undefined}>
                {made === undefined ? '-' : `${made} 条`}{ld ? ` / ${ld.total} 次` : ''}
              </span>
              <span className="run-muted">{h.enabled ? '启用' : '停用'}</span>
            </div>
          )
        })}
      </div>
    )
  }

  const showCounts = !loading && !error
  return (
    <div className="tasks-page">
      <PageTitle parent="任务" count={showCounts ? hooks.length : undefined}
        desc="外部系统往接收地址 POST 一段 JSON，按映射规则自动建任务；最近推送失败的排在前面"
        actions={<Button variant="primary" onClick={onNew}>新建 Webhook</Button>}>
        Webhook 接入
      </PageTitle>
      <div className="toolbar">
        <div className="seg" role="group" aria-label="筛选">
          {filters.map(([k, l]) => (
            <button key={k} type="button" className={cls(filter === k && 'on')} aria-pressed={filter === k} onClick={() => setF(k)}>
              {l}{showCounts && <span className="seg-n">{hooks.filter((h) => pass(h, k)).length}</span>}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <div className="search">
          <IconSearch />
          <input type="search" placeholder="搜索名称、地址" aria-label="搜索 Webhook" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.preventDefault(); setQ('') } }} />
          {q && <button type="button" className="search-clear" aria-label="清空" title="清空" onClick={() => setQ('')}><IconClose size={10} /></button>}
        </div>
      </div>
      {body}
    </div>
  )
}
