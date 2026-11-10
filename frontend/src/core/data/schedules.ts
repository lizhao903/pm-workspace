// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 定时任务（TASK-03a、TASK-03b、TASK-04a）：定义、执行记录、规则预览、立即执行。契约见 docs/api-contract.md「定时任务 schedules」。
// 列表的缓存键沿用今日页的 todayKeys.schedules（今日「今天还会自动执行」和定时任务页共用一份）；执行记录、预览在 dataKeys.schedules 下。
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestList } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'
import { todayKeys } from './today'

export type ScheduleFreq = 'once' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'cron'

/** 各频率只用自己的字段，其余原样保存（切换频率时不丢） */
export type ScheduleRule = {
  freq: ScheduleFreq
  /** HH:mm，cron 不用 */
  time: string
  /** 0 到 6，0 是周日 */
  weekdays: number[]
  /** 1 到 31，小月按月底 */
  day: number
  /** 一次性的日期 yyyy-mm-dd */
  date: string
  /** 5 段：分 时 日 月 周 */
  cron: string
}

/** incident_sweep：运行异常巡检（INC-01a），内核动作，不属于插件；remind：到点在工作台里弹一条提醒通知；git_pull：到点在本机仓库 git pull --ff-only */
export type ScheduleActionKind = 'task' | 'sop' | 'agent' | 'incident_sweep' | 'remind' | 'git_pull'

/** 后端按 kind 只输出自己的字段 */
export type ScheduleAction =
  | { kind: 'task'; title: string; desc: string; priority: string; assignee: string; due_days: number }
  /** managed：随 SOP 流程管理的那一条（TSK-0463），流程触发方式选「定时」时 SOP 插件建的；这里新建时不认，修改时保持原值 */
  | { kind: 'sop'; sop_id: string; managed?: boolean }
  | { kind: 'agent'; agent_id: string; prompt: string }
  /** 到点把满足条件、未处理、还没有任务的运行异常各建一条交给 Claude Code 修的任务 */
  | { kind: 'incident_sweep'; min_level: 'error' | 'warn'; min_count: number }
  /** 到点在工作台里发一条通知（不外发 IM）；object_id 是关联的对象（任务），点通知打开它，空串为不关联 */
  | { kind: 'remind'; title: string; body: string; object_id: string; popup?: 'toast' | 'modal' }
  /** 到点在本机仓库里 git pull --ff-only；repo 是绝对路径，remote、branch 空串时按仓库自己的上游拉，branch 非空时 remote 必填 */
  | { kind: 'git_pull'; repo: string; remote: string; branch: string }

export type Schedule = {
  id: string
  name: string
  enabled: boolean
  rule: ScheduleRule
  action: ScheduleAction
  /** 所属项目（0055），null 为不属于任何项目；动作「建一条任务」建的任务也挂到这个项目 */
  project_id: string | null
  /** 按规则现算，带服务时区偏移；停用、一次性已过时为 null */
  next_run_at: string | null
  created_at: string
  updated_at: string
}

export type ScheduleRunStatus = 'running' | 'ok' | 'failed' | 'skipped' | 'unsupported' | 'missed'

export type ScheduleRun = {
  id: string
  schedule_id: string
  /** 计划时刻；手动执行是点按钮的时刻 */
  at: string
  status: ScheduleRunStatus
  ok: boolean
  text: string
  manual: boolean
  missed: number
  /** 建出来的任务；任务删了这里仍是原值 */
  object_id: string | null
  ref: string | null
  started_at: string
  finished_at: string | null
}

export type ScheduleInput = { name: string; enabled?: boolean; rule: ScheduleRule; action: ScheduleAction; project_id?: string | null }
export type SchedulePatch = Partial<ScheduleInput>
export type SchedulePreview = { rule: ScheduleRule; next_runs: string[]; time_zone: string }

/** 执行记录默认取的条数，和后端缺省一致 */
export const SCHEDULE_RUNS_LIMIT = 50

const path = (id: string) => `/api/schedules/${encodeURIComponent(id)}`

export const schedulesApi = {
  list: (signal?: AbortSignal) => requestList<Schedule>('/api/schedules', { signal }).then((r) => r.data),
  /** 关联这个对象的提醒（动作 remind），停用的、已提醒过的也在 */
  byObject: (objectId: string, signal?: AbortSignal) =>
    requestList<Schedule>('/api/schedules', { query: new URLSearchParams({ object_id: objectId }), signal }).then((r) => r.data),
  /** 属于这个项目的定时任务（项目详情的「定时任务」标签） */
  byProject: (projectId: string, signal?: AbortSignal) =>
    requestList<Schedule>('/api/schedules', { query: new URLSearchParams({ project: projectId }), signal }).then((r) => r.data),
  create: (body: ScheduleInput) => request<Schedule>('POST', '/api/schedules', { body }),
  patch: (id: string, body: SchedulePatch) => request<Schedule>('PATCH', path(id), { body }),
  delete: (id: string) => request<null>('DELETE', path(id)),
  runs: (id: string, limit: number, signal?: AbortSignal) =>
    requestList<ScheduleRun>(`${path(id)}/runs`, { query: new URLSearchParams({ limit: String(limit) }), signal }).then((r) => r.data),
  run: (id: string) => request<ScheduleRun>('POST', `${path(id)}/run`),
  preview: (rule: ScheduleRule, count = 3, signal?: AbortSignal) =>
    request<SchedulePreview>('POST', '/api/schedules/preview', { body: { rule, count }, signal }),
}

/** 全部定时任务，不分页；下次执行早的在前，不再执行的排最后（后端排好） */
export function useSchedules() {
  return useQuery({ queryKey: todayKeys.schedules, queryFn: ({ signal }) => schedulesApi.list(signal) })
}

/** 任务抽屉里「提醒」：关联这条任务的提醒。键挂在列表键下面，新建、改、删定时任务时跟着刷新 */
export function useObjectReminders(objectId: string | null) {
  return useQuery({
    queryKey: [...todayKeys.schedules, 'object', objectId ?? ''] as const,
    queryFn: ({ signal }) => schedulesApi.byObject(objectId!, signal),
    enabled: !!objectId,
  })
}

/** 项目详情的「定时任务」标签：属于这个项目的。键挂在列表键下面，新建、改、删定时任务时跟着刷新 */
export function useProjectSchedules(projectId: string | null) {
  return useQuery({
    queryKey: [...todayKeys.schedules, 'project', projectId ?? ''] as const,
    queryFn: ({ signal }) => schedulesApi.byProject(projectId!, signal),
    enabled: !!projectId,
  })
}

/** 一个定时任务的执行记录，计划时刻新的在前。调度器到点执行不发事件，打开着的时候隔一阵自己再取 */
export function useScheduleRuns(id: string | null, opts: { limit?: number; refetchInterval?: number } = {}) {
  const limit = opts.limit ?? SCHEDULE_RUNS_LIMIT
  return useQuery({
    queryKey: dataKeys.schedules.runs(id ?? '', limit),
    queryFn: ({ signal }) => schedulesApi.runs(id!, limit, signal),
    enabled: !!id,
    refetchInterval: opts.refetchInterval,
  })
}

/** 列表「上次」一列：每个定时任务最近一条执行记录；没执行过是 null，没取到是 undefined */
export function useLastScheduleRuns(ids: readonly string[], refetchInterval?: number): Record<string, ScheduleRun | null | undefined> {
  const qs = useQueries({
    queries: ids.map((id) => ({
      queryKey: dataKeys.schedules.runs(id, 1),
      queryFn: ({ signal }: { signal: AbortSignal }) => schedulesApi.runs(id, 1, signal),
      refetchInterval,
    })),
  })
  const out: Record<string, ScheduleRun | null | undefined> = {}
  ids.forEach((id, i) => { out[id] = qs[i]?.data ? (qs[i].data[0] ?? null) : undefined })
  return out
}

/** 没保存的规则算接下来几次；rule 为 null 时不请求（前端校验没过） */
export function useSchedulePreview(rule: ScheduleRule | null, count = 3) {
  return useQuery({
    queryKey: dataKeys.schedules.preview(rule, count),
    queryFn: ({ signal }) => schedulesApi.preview(rule!, count, signal),
    enabled: !!rule,
    // 「接下来几次」随时间推移会变，但开着抽屉的几分钟里不必重算
    staleTime: 60_000,
    placeholderData: (prev) => prev,
    retry: false,
  })
}

/** 新建、改、启停回来的那份先写进列表缓存，开关立刻翻过去，再按规则刷新 */
function useSaved() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return (s: Schedule) => {
    qc.setQueryData<Schedule[]>(todayKeys.schedules, (rows) =>
      rows ? (rows.some((r) => r.id === s.id) ? rows.map((r) => (r.id === s.id ? s : r)) : [s, ...rows]) : rows)
    return notify({ kind: 'schedule', id: s.id })
  }
}

export function useCreateSchedule() {
  const saved = useSaved()
  return useMutation({ mutationFn: (input: ScheduleInput) => schedulesApi.create(input), onSuccess: (s) => { void saved(s) } })
}

/** 只传要改的字段；rule、action 整体替换。启停也走这里（只传 enabled） */
export function usePatchSchedule() {
  const saved = useSaved()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: SchedulePatch }) => schedulesApi.patch(id, patch),
    onSuccess: (s) => { void saved(s) },
  })
}

/** 彻底删除，执行记录一起删，已经建出来的任务保留 */
export function useDeleteSchedule() {
  const notify = useNotifyChange()
  return useMutation({ mutationFn: (id: string) => schedulesApi.delete(id), onSuccess: (_, id) => notify({ kind: 'schedule', id }) })
}

/** 立即执行一次：按已保存的配置，停用的也能跑，不影响下次执行时间；建任务类会建出一条任务 */
export function useRunSchedule() {
  const notify = useNotifyChange()
  return useMutation({ mutationFn: (id: string) => schedulesApi.run(id), onSuccess: (_, id) => notify({ kind: 'schedule-run', id }) })
}
