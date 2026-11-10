// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 任务阶段与提出人（AUTO-05，SPEC-tasks-11）：阶段在 props.stage，提出人在 props.requester（契约「任务阶段与提出人」）。
// 阶段和状态是两套：状态是负责人的工作状态，阶段是提出人在看板上看到的流程进度（docs/auto-delivery-flow.md 第 3 节）。
import { TASK_STAGES, type WorkObject } from '../../core/data'

export type Stage = { key: string; label: string }

/** 阶段全集，顺序即看板从左到右的列序；和后端 domain.TaskStages、GET /api/task-stages 一致（定义在 core/data） */
export const STAGES: readonly Stage[] = TASK_STAGES

/** 看板卡片点开时默认停的标签：SOP 插件登记的「流水线」（AUTO-12）；插件没在跑时退回默认标签 */
export const PIPELINE_TAB = 'pipeline'

/** 「未设阶段」列的 key（老任务、手动建的任务没有阶段） */
export const NO_STAGE = ''

/** 需要人处理的阶段：卡片和列头标醒目色 */
export const ATTENTION_STAGES: ReadonlySet<string> = new Set(['confirm_project', 'clarifying', 'need_human', 'accepting'])

export function stageOf(t: WorkObject): string {
  const s = t.props?.stage
  return typeof s === 'string' ? s.trim() : ''
}

export function stageLabel(key: string): string {
  if (!key) return '未设阶段'
  return STAGES.find((s) => s.key === key)?.label ?? key
}

export type Requester = { contact_id?: string; name: string; channel?: string; sender_id?: string; sender_name?: string }

/** 读 props.requester；没有或形状不对返回 null */
export function requesterOf(t: WorkObject): Requester | null {
  const r = t.props?.requester
  if (!r || typeof r !== 'object') return null
  const m = r as Record<string, unknown>
  const str = (k: string) => (typeof m[k] === 'string' ? (m[k] as string).trim() : '')
  const out: Requester = { name: str('name') || str('sender_name') }
  for (const k of ['contact_id', 'channel', 'sender_id', 'sender_name'] as const) if (str(k)) out[k] = str(k)
  if (!out.name && !out.contact_id && !out.sender_id) return null
  if (!out.name) out.name = out.sender_id ?? ''
  return out
}

/** 提出人筛选的值：联系人用 c:<id>，认不上联系人的 IM 发送者用 s:<渠道>:<编号>；「没有提出人」用 NO_REQUESTER */
export const NO_REQUESTER = '-'
export function requesterKey(r: Requester | null): string {
  if (!r) return NO_REQUESTER
  if (r.contact_id) return `c:${r.contact_id}`
  if (r.channel && r.sender_id) return `s:${r.channel}:${r.sender_id}`
  return `n:${r.name}`
}

/** 提出人下拉的选项：出现过的提出人，条数多的在前；认不上联系人的名字后面带渠道 */
export function requesterOptions(rows: readonly WorkObject[]): { value: string; label: string; n: number }[] {
  const m = new Map<string, { value: string; label: string; n: number }>()
  for (const t of rows) {
    const r = requesterOf(t)
    if (!r) continue
    const k = requesterKey(r)
    const o = m.get(k) ?? { value: k, label: r.contact_id || !r.channel ? r.name : `${r.name}（${r.channel}）`, n: 0 }
    o.n += 1
    m.set(k, o)
  }
  return [...m.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
}

export function matchRequester(t: WorkObject, key: string): boolean {
  if (!key) return true
  return requesterKey(requesterOf(t)) === key
}

/** 按阶段分列：列序同 STAGES；withNone 时最前面多一列「未设阶段」；不认识的阶段值并进「未设阶段」 */
export function stageColumns(rows: readonly WorkObject[], withNone: boolean): { stage: Stage; rows: WorkObject[] }[] {
  const known = new Set(STAGES.map((s) => s.key))
  const by = new Map<string, WorkObject[]>()
  for (const t of rows) {
    const s = stageOf(t)
    const k = known.has(s) ? s : NO_STAGE
    by.set(k, [...(by.get(k) ?? []), t])
  }
  const cols = STAGES.map((s) => ({ stage: s, rows: by.get(s.key) ?? [] }))
  return withNone ? [{ stage: { key: NO_STAGE, label: '未设阶段' }, rows: by.get(NO_STAGE) ?? [] }, ...cols] : cols
}
