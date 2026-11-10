// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 任务阶段的全集和阶段变化历史（AUTO-05 阶段、AUTO-12 流水线时间线）。
// 阶段全集同后端 domain.TaskStages（GET /api/task-stages）；历史取审计 kind=stage（契约「任务阶段与提出人」：
// 每次阶段变化记一条审计 action=stage_change，detail 带 from、to）。键挂在对象前缀下，任务一改跟着刷。
import { useQuery } from '@tanstack/react-query'
import { isApiError, requestList } from '../api'
import { dataKeys } from './keys'

export type TaskStage = { key: string; label: string }

/** 阶段全集，顺序即看板从左到右的列序 */
export const TASK_STAGES: readonly TaskStage[] = [
  { key: 'received', label: '已接收' },
  { key: 'confirm_project', label: '待确认项目' },
  { key: 'designing', label: '设计中' },
  { key: 'clarifying', label: '待澄清' },
  { key: 'reviewing', label: '评审中' },
  { key: 'need_human', label: '需人工' },
  { key: 'developing', label: '开发中' },
  { key: 'testing', label: '测试中' },
  { key: 'accepting', label: '待验收' },
  { key: 'releasing', label: '待发布' },
  { key: 'released', label: '已上线' },
]

/** 等人的阶段（AUTO-12 今日「待我处理」）：待确认项目、需人工、待验收 */
export const WAITING_STAGES: readonly string[] = ['confirm_project', 'need_human', 'accepting']

export function taskStageLabel(key: string): string {
  if (!key) return '未设阶段'
  return TASK_STAGES.find((s) => s.key === key)?.label ?? key
}

/** 一次阶段变化；from、to 没设阶段为空串 */
export type StageChange = { id: string; at: string; from: string; to: string; actor: string }

type AuditRow = { id: string; at: string; action: string; actor: string; detail?: Record<string, unknown> | null }

/** 审计接口单次上限 */
const STAGE_HISTORY_LIMIT = 200

export const stageHistoryApi = {
  /** 早的在前（接口给的是最近的在前） */
  list: async (id: string, signal?: AbortSignal): Promise<StageChange[]> => {
    const query = new URLSearchParams({ target_type: 'object', target_id: id, kind: 'stage', limit: String(STAGE_HISTORY_LIMIT) })
    const r = await requestList<AuditRow>('/api/audits', { query, signal })
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    return r.data.filter((a) => a.action === 'stage_change')
      .map((a) => ({ id: a.id, at: a.at, from: str(a.detail?.from), to: str(a.detail?.to), actor: a.actor }))
      .reverse()
  },
}

/** 一条任务的阶段变化历史；id 为 null 时不取。审计没接上（500）时不重试 */
export function useStageHistory(id: string | null) {
  return useQuery({
    queryKey: dataKeys.objects.stageHistory(id ?? ''),
    queryFn: ({ signal }) => stageHistoryApi.list(id!, signal),
    enabled: !!id,
    retry: (n, e) => !isApiError(e, 'internal') && n < 2,
  })
}
