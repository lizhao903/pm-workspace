// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// SOP 标签（SPEC-projects-9）的纯函数：关联的流程、候选、最近执行、执行状态的显示名。
// 执行状态的显示名和颜色同 SOP 插件的 RUN_STATUS（插件之间不互相 import，这里抄一份）
import type { SopFlow, SopRunBrief, SopRunShow } from '../../core/data'

/** 最近执行露几条（SPEC-projects-9.6） */
export const SOP_RUN_PEEK = 8

export const RUN_LOOK: Record<SopRunShow, { label: string; color: string }> = {
  running: { label: '执行中', color: 'var(--accent)' },
  waiting: { label: '待我处理', color: 'var(--warn)' },
  done: { label: '已完成', color: 'var(--ok)' },
  failed: { label: '失败', color: 'var(--danger)' },
  stopped: { label: '已终止', color: 'var(--faint)' },
  relaunched: { label: '已重跑', color: 'var(--faint)' },
}
/** s 是显示状态（core/data 的 sopRunShow）：失败后已按最新流程重跑过的显示「已重跑」 */
export const runLook = (s: string) => RUN_LOOK[s as SopRunShow] ?? { label: s, color: 'var(--faint)' }

/** 关联的流程，按 sop_ids 的顺序；流程库里找不到的（已删）跳过（SPEC-projects-9.9） */
export function linkedFlows(ids: readonly string[], flows: readonly SopFlow[]): SopFlow[] {
  const byId = new Map(flows.map((f) => [f.id, f]))
  return ids.map((id) => byId.get(id)).filter((f): f is SopFlow => !!f)
}

/** 下拉候选：还没关联的流程，保持流程库的顺序 */
export const availFlows = (ids: readonly string[], flows: readonly SopFlow[]) => flows.filter((f) => !ids.includes(f.id))

/** 关联流程的执行，按开始时间倒序取前 SOP_RUN_PEEK 条；只算还在流程库里的流程 */
export function recentRuns(linked: readonly SopFlow[], runs: readonly SopRunBrief[]): SopRunBrief[] {
  const ids = new Set(linked.map((f) => f.id))
  return runs.filter((r) => ids.has(r.flow_id))
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
    .slice(0, SOP_RUN_PEEK)
}

// ---- 自动反向关联：流程不用在项目里手动关联，也能出现在这个项目的 SOP 标签里 ----

/** 执行输入里表示「哪个项目」的字段名；按这些字段查执行记录 */
export const PROJECT_INPUT_KEYS = ['project_id', 'project'] as const

/** 为什么自动关联：def 流程里写了本项目的编号，run 执行时用的是本项目，name 流程名以项目名开头 */
export type AutoReason = 'def' | 'run' | 'name'
export const AUTO_REASON_LABEL: Record<AutoReason, string> = {
  def: '流程里引用了本项目',
  run: '执行时用的是本项目',
  name: '流程名以项目名开头',
}
export type AutoFlow = { flow: SopFlow; reasons: AutoReason[] }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** 整词出现：前后不是字母数字、下划线、连字符，PRJ-0008 不会命中 PRJ-00081 */
const hasToken = (text: string, token: string) => !!token && new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(token)}($|[^A-Za-z0-9_-])`).test(text)
/** 流程名以项目名开头，后面紧跟分隔符（「XAUE · 按生产代码更新原型」「XAUE-周报」） */
const NAME_SEP = /^[\s·•\-—–:：|/／]/
const nameHit = (flowName: string, title: string) => {
  const t = title.trim()
  return !!t && flowName.startsWith(t) && NAME_SEP.test(flowName.slice(t.length))
}

/**
 * 自动关联的流程：不在手动关联里、没被点掉（hidden），且满足任一条——流程的步骤配置或输入字段里写了本项目的 id 或编号；
 * 有执行关联到本项目（object_id 是它）或执行输入里的项目字段是它（runs 传进来的就是这两类）；流程名以项目名开头。
 * 保持流程库的顺序。
 */
export function autoFlows(
  project: { id: string; ref: string; name: string },
  flows: readonly SopFlow[],
  runs: readonly Pick<SopRunBrief, 'flow_id'>[],
  linked: readonly string[],
  hidden: readonly string[],
): AutoFlow[] {
  const ran = new Set(runs.map((r) => r.flow_id))
  const out: AutoFlow[] = []
  for (const f of flows) {
    if (linked.includes(f.id) || hidden.includes(f.id)) continue
    const def = JSON.stringify([f.steps, f.fields])
    const reasons: AutoReason[] = []
    if (hasToken(def, project.id) || hasToken(def, project.ref)) reasons.push('def')
    if (ran.has(f.id)) reasons.push('run')
    if (nameHit(f.name, project.name)) reasons.push('name')
    if (reasons.length) out.push({ flow: f, reasons })
  }
  return out
}

/** 加到末尾，已有的不重复加 */
export const addSop = (ids: readonly string[], id: string) => (ids.includes(id) ? [...ids] : [...ids, id])
/** 取消关联：只从 sop_ids 拿掉，流程和执行记录不动（SPEC-projects-9.5） */
export const removeSop = (ids: readonly string[], id: string) => ids.filter((x) => x !== id)
