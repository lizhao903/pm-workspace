// 运行异常（INC-01b，SPEC-settings-18、19）：系统运行中出的问题，同一个指纹合并记次数；能转成研发任务。
// 契约见 docs/api-contract.md「运行异常」（INC-01a）。列表一次拉全，状态、级别、模块、搜索都在前端筛，各状态的数量也从这一份算。
import { useMutation, useQuery } from '@tanstack/react-query'
import { request, requestList } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'

export type IncidentLevel = 'error' | 'warn'
export type IncidentStatus = 'open' | 'tasked' | 'ignored' | 'resolved'

export type Incident = {
  id: string
  /** 模块前缀 + 对象 + 错误类型，如 conn:cn_x:auth；第一段用来分组 */
  fingerprint: string
  level: IncidentLevel
  /** 中文模块名：连接器、项目原型、IM 消息、前端页面所属的模块…… */
  module: string
  title: string
  message: string
  /** 出事时的上下文，值可以是对象 */
  context: Record<string, unknown> | null
  stack: string
  status: IncidentStatus
  /** 状态说明：「标为已解决后又出现了」「关联的任务已删除」 */
  note: string
  count: number
  first_at: string
  last_at: string
  /** 最近几次的时间，新的在前，最多 20 个 */
  occurrences: string[] | null
  task_id: string | null
  /** 关联任务的编号、状态、是否已到终态；任务删了或没有时为空 */
  task_ref?: string
  task_status?: string
  task_done?: boolean
  /** frontend / backend / plugin:<id> */
  source: string
}

/** 前端上报：fingerprint 省略时后端按 module + title + 堆栈第一帧算 */
export type IncidentReport = {
  level: IncidentLevel
  module: string
  title: string
  message: string
  stack?: string
  context?: Record<string, unknown>
  url?: string
  fingerprint?: string
}

export type IncidentTaskInput = { title?: string; body?: string; priority?: string; assignee_id?: string }

/** 转任务的回包（201）：建出的任务和更新后的异常 */
export type IncidentTaskResult = { incident: Incident; task: { id: string; ref: string } }

export const INCIDENT_STATUS: Record<IncidentStatus, { label: string; color: string }> = {
  open: { label: '未处理', color: '#c0352b' },
  tasked: { label: '已转任务', color: '#3d4fd6' },
  ignored: { label: '已忽略', color: '#a19d92' },
  resolved: { label: '已解决', color: '#2f7d43' },
}

/** 模块下拉的顺序（原型 INCIDENT_MODULES）；不在里面的（前端页面所属模块）排在后面 */
export const INCIDENT_MODULES = ['连接器', '模型服务商', 'Webhook', 'SOP', '项目原型', 'Agent', 'Claude Code', 'IM 消息', '交易', '发布', '前端'] as const

/** 后端可能给 null 的列表、对象字段补成空的 */
export function normIncident(x: Incident): Incident {
  return {
    ...x,
    context: x.context && typeof x.context === 'object' ? x.context : {},
    occurrences: x.occurrences ?? [],
    stack: x.stack ?? '',
    note: x.note ?? '',
    task_id: x.task_id || null,
  }
}

const path = (id: string) => `/api/incidents/${encodeURIComponent(id)}`

export const incidentsApi = {
  list: async (signal?: AbortSignal) => (await requestList<Incident>('/api/incidents', { signal })).data.map(normIncident),
  get: async (id: string, signal?: AbortSignal) => normIncident(await request<Incident>('GET', path(id), { signal })),
  setStatus: async (id: string, status: IncidentStatus) => normIncident(await request<Incident>('PATCH', path(id), { body: { status } })),
  toTask: (id: string, body: IncidentTaskInput) => request<IncidentTaskResult>('POST', `${path(id)}/task`, { body }),
  /** 回 201 + 合并后的那条；超限 429 */
  report: (body: IncidentReport) => request<Incident>('POST', '/api/incidents/report', { body }),
}

/** 全部运行异常；后端按最近一次倒序 */
export function useIncidents(opts: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: dataKeys.incidents.list, queryFn: ({ signal }) => incidentsApi.list(signal), enabled: opts.enabled ?? true })
}

/** 忽略、标为已解决、重新打开 */
export function useSetIncidentStatus() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: IncidentStatus }) => incidentsApi.setStatus(id, status),
    onSuccess: (x) => notify({ kind: 'incident', id: x.id }),
  })
}

/** 转研发任务：后端建任务（来源异常、关联异常），异常变已转任务 */
export function useIncidentToTask() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: IncidentTaskInput }) => incidentsApi.toTask(id, input),
    onSuccess: (_, v) => notify({ kind: 'incident-task', id: v.id }),
  })
}

/** 未处理的错误数：二级菜单红点、今日待办都按它（警告不算） */
export const openErrors = (xs: readonly Incident[]) => xs.filter((x) => x.status === 'open' && x.level === 'error')

/** 运行异常页的地址；给了 id 就打开那条的抽屉 */
export const incidentsPagePath = (id?: string) => (id ? `/settings/incidents?open=${encodeURIComponent(id)}` : '/settings/incidents')
