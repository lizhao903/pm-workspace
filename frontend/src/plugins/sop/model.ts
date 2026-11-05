// SOP 插件的纯函数：状态和节点类型的显示、流程图分列、执行列表的筛选排序和进度文字。口径照原型 web-next/src/sopflow.ts、sop.tsx。
// 运行状态由后端算好给（SopRun.status），这里不重算；节点是不是分支节点从 GET /api/sop/node-types 读，名字在前端
import { isSopHeld, isSopProviderWait, sopRunShow, type SopFlow, type SopJson, type SopNodeType, type SopRun, type SopRunBrief, type SopRunShow, type SopRunStatus, type SopRunStep, type SopStepDef, type SopStepStatus } from '../../core/data'
import { sopNodeView } from '../../core/plugin'
import { describeRule as describeScheduleRule, fullRule as fullScheduleRule } from '../../core/ui/scheduleRule'

type Look = { label: string; color: string }

export const STEP_STATUS: Record<SopStepStatus, Look> = {
  pending: { label: '未开始', color: 'var(--faint)' },
  running: { label: '执行中', color: 'var(--accent)' },
  paused: { label: '待确认输入', color: 'var(--warn)' },
  review: { label: '待处理', color: 'var(--warn)' },
  done: { label: '完成', color: 'var(--ok)' },
  failed: { label: '失败', color: 'var(--danger)' },
  skipped: { label: '已跳过', color: 'var(--faint)' },
  bypassed: { label: '未走此分支', color: 'var(--faint)' },
}

/** 运行状态的显示；relaunched 是失败后已按最新流程重跑过的（sopRunShow），灰色 */
export const RUN_STATUS: Record<SopRunShow, Look> = {
  running: { label: '执行中', color: 'var(--accent)' },
  waiting: { label: '待我处理', color: 'var(--warn)' },
  done: { label: '已完成', color: 'var(--ok)' },
  failed: { label: '失败', color: 'var(--danger)' },
  stopped: { label: '已终止', color: 'var(--faint)' },
  relaunched: { label: '已重跑', color: 'var(--faint)' },
}

const stepLook = (s: string): Look => STEP_STATUS[s as SopStepStatus] ?? { label: s, color: 'var(--faint)' }

/** 在排队等模型名额的步骤（SOP-07）：状态仍是 running，后端带 queue；界面显示「排队中」 */
export const QUEUED_LOOK: Look = { label: '排队中', color: 'var(--muted)' }
export const isQueued = (s?: Pick<SopRunStep, 'status' | 'queue'>): boolean => !!s && s.status === 'running' && !!s.queue
/** 超出治理上限暂停的步骤（AUTO-12）：状态是 paused，带没放行的 hold */
export const HELD_LOOK: Look = { label: '超出上限', color: 'var(--danger)' }
/** 服务商不可用、挂起等它恢复的步骤（TSK-0392）：状态仍是 running，带 provider_wait */
export const PROVIDER_WAIT_LOOK: Look = { label: '等服务商恢复', color: 'var(--warn)' }
/** 步骤的显示：等服务商恢复、排队中、超出上限的单独一种，其余按状态 */
export const runStepLook = (s: Pick<SopRunStep, 'status' | 'queue' | 'hold' | 'provider_wait'>): Look =>
  (isSopProviderWait(s) ? PROVIDER_WAIT_LOOK : isQueued(s) ? QUEUED_LOOK : isSopHeld(s) ? HELD_LOOK : stepLook(s.status))
/** 设置里的模型服务商 */
export const PROVIDERS_SETTINGS_PATH = '/settings/providers'
/** 插件设置分节的路径（设置 > 插件 > SOP 编排） */
export const SOP_SETTINGS_PATH = '/settings/plugins/sop/sop'
const runLook = (s: string): Look => RUN_STATUS[s as SopRunShow] ?? { label: s, color: 'var(--faint)' }
export { stepLook, runLook }

/** 节点类型的显示名，照原型 nodetypes.tsx 的 NODE_TYPES，另加 SOP-02a 的写节点 doc、contact；颜色在 sop.css 的 .sop-kt-<kind> */
export const KIND_LABEL: Record<string, string> = {
  auto: '自动执行', ai: 'AI 处理', knowledge: '知识检索', extract: '参数提取', template: '模板转换', aggregate: '变量聚合',
  code: '代码执行', decide: '条件分支', classifier: '问题分类器', iterate: '迭代', wait: '等待', loopback: '条件回退', review: '人工检查',
  http: 'HTTP 请求', notify: '发送消息', task: '创建任务', doc: '写文档', contact: '写联系人', local_append: '写进项目目录', agent: '调用 Agent', subflow: '子流程',
  claude_code: 'Claude Code 执行', end: '结束',
  // 执行任务、更新任务（TSK-0411）
  task_run: '执行任务', task_update: '更新任务',
}
export const kindLabel = (k: string) => KIND_LABEL[k] ?? sopNodeView(k)?.label ?? k

/**
 * 触发方式的内置显示名（同原型 enumdata.ts 的 sop_trigger），设置里有 sop_trigger 枚举时以枚举为准；都没有的原样显示（SPEC-sop-0）。
 * 定时（TSK-0463）只有一项 schedule，时间规则在随流程管理的定时任务里；旧的 daily、weekly、cron 后端转成 schedule，显示也按「定时」
 */
export const TRIGGER_LABEL: Record<string, string> = {
  manual: '手动', im: 'IM 消息', schedule: '定时', webhook: 'Webhook',
}
/** 旧的定时类触发方式，都按 schedule 看 */
export const LEGACY_SCHEDULE_TRIGGERS: readonly string[] = ['daily', 'weekly', 'cron']
/** 旧触发方式换成 schedule，其余原样 */
export const normTrigger = (t: string) => (LEGACY_SCHEDULE_TRIGGERS.includes(t) ? 'schedule' : t)
export function triggerLabelOf(items?: readonly { key: string; label: string }[]) {
  const m = new Map((items ?? []).map((x) => [x.key, x.label]))
  return (t: string) => {
    if (!t) return '手动'
    const k = normTrigger(t)
    return m.get(k) ?? TRIGGER_LABEL[k] ?? t
  }
}

/* ---------- 流程要的插件 ---------- */

type Provider = { id: string; provides?: Record<string, string[] | undefined> }

/** 流程里插件节点的提供者，去重保序：按插件清单 provides.sop_nodes 认，清单里没有的取 kind 的「<插件 id>_」前缀（plugin-api.md 2.7） */
export function flowPlugins(flow: Pick<SopFlow, 'steps'>, plugins: readonly Provider[] = []): string[] {
  const out = new Set<string>()
  for (const s of flow.steps) {
    if (s.kind in KIND_LABEL) continue
    const p = plugins.find((x) => x.provides?.sop_nodes?.includes(s.kind))?.id ?? s.kind.split('_')[0]
    if (p) out.add(p)
  }
  return [...out]
}

/** 当前工作台没开的插件；enabled 为 null（工作台还没取到）时不判断 */
export const missingFlowPlugins = (flow: Pick<SopFlow, 'steps'>, enabled: ReadonlySet<string> | null, plugins: readonly Provider[] = []) =>
  enabled ? flowPlugins(flow, plugins).filter((p) => !enabled.has(p)) : []

const FINISHED: readonly SopStepStatus[] = ['done', 'skipped', 'bypassed']
export const isFinished = (s: SopStepStatus) => FINISHED.includes(s)
export const needsMe = (s: SopStepStatus) => s === 'paused' || s === 'review' || s === 'failed'
/** 待我处理：等人或失败的执行（isPending）；已重跑过的失败执行不算 */
export const isPendingRun = (r: { status: SopRunStatus; relaunched_to?: string }) => r.status === 'waiting' || sopRunShow(r) === 'failed'
export const isEnded = (r: { status: SopRunStatus }) => r.status === 'done' || r.status === 'stopped'

/** 分支节点：后端节点类型表说了算，表还没回来时看有没有 cases */
export function branchingOf(types: readonly SopNodeType[] | undefined) {
  const m = new Map((types ?? []).map((t) => [t.kind, t.branching]))
  return (d: SopStepDef) => m.get(d.kind) ?? !!d.cases?.length
}
/** 规则留空的条件分支是人工判断 */
export const isManualDecide = (d: SopStepDef) => d.kind === 'decide' && !d.rule?.trim()

/** 补全默认依赖：没写 after 的接在上一步后面 */
export const depsOf = (flow: Pick<SopFlow, 'steps'>, i: number): string[] => flow.steps[i].after ?? (i === 0 ? [] : [flow.steps[i - 1].key])

/** 每步在图里的列：起点为 0，其余是依赖的最大列 + 1；依赖不存在或成环时当成起点，不死循环 */
export function ranks(flow: Pick<SopFlow, 'steps'>): number[] {
  const idx = new Map(flow.steps.map((s, i) => [s.key, i]))
  const memo: number[] = []
  const busy = new Set<number>()
  const rank = (i: number): number => {
    if (memo[i] !== undefined) return memo[i]
    if (busy.has(i)) return 0
    busy.add(i)
    const deps = depsOf(flow, i).map((k) => idx.get(k)).filter((j): j is number => j !== undefined)
    memo[i] = deps.length ? 1 + Math.max(...deps.map(rank)) : 0
    busy.delete(i)
    return memo[i]
  }
  flow.steps.forEach((_, i) => rank(i))
  return memo
}

/** 界面默认看哪一步：先看等人处理的，再看执行中的，都没有就看最后完成的（同后端 focusIndex） */
export function focusIndex(steps: readonly SopRunStep[]): number {
  const a = steps.findIndex((s) => needsMe(s.status))
  if (a >= 0) return a
  const b = steps.findIndex((s) => s.status === 'running')
  if (b >= 0) return b
  let last = 0
  const t = (s: SopRunStep) => (s.ended_at ? Date.parse(s.ended_at) : 0)
  steps.forEach((s, j) => { if (s.status === 'done' && t(s) >= t(steps[last])) last = j })
  return last
}

/* ---------- 时间 ---------- */

export const dur = (ms: number) =>
  ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} 分钟` : `${(ms / 3_600_000).toFixed(1)} 小时`
/** 执行耗时：没结束算到现在 */
export const runDur = (r: { started_at: string; ended_at?: string }, now = Date.now()) =>
  dur((r.ended_at ? Date.parse(r.ended_at) : now) - Date.parse(r.started_at))

export function timeAgo(iso: string, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`
  return new Date(iso).toLocaleDateString('zh-CN')
}

/** 24 小时制时分秒 */
export const clock = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour12: false })

/* ---------- 执行列表 ---------- */

export type DaySeg = 'today' | 'yesterday' | 'week' | 'older'
export const DAY_SEGS: { key: DaySeg; label: string }[] = [
  { key: 'today', label: '今天' }, { key: 'yesterday', label: '昨天' }, { key: 'week', label: '本周更早' }, { key: 'older', label: '更早' },
]
/** 按开始日期分段，周一算一周第一天 */
export function daySegOf(now = new Date()) {
  const d0 = new Date(now)
  d0.setHours(0, 0, 0, 0)
  const today = d0.getTime()
  const yesterday = today - 86_400_000
  const week = today - ((d0.getDay() + 6) % 7) * 86_400_000
  return (iso: string): DaySeg => {
    const t = Date.parse(iso)
    return t >= today ? 'today' : t >= yesterday ? 'yesterday' : t >= week ? 'week' : 'older'
  }
}

const ORDER: Record<SopRunShow, number> = { waiting: 0, failed: 1, running: 2, done: 3, stopped: 4, relaunched: 5 }
/** 段内按显示状态（待我处理、失败、执行中、已完成、已终止、已重跑），同状态按开始时间倒序 */
export const sortRuns = <T extends SopRunBrief>(rows: readonly T[]) =>
  [...rows].sort((a, b) => (ORDER[sopRunShow(a)] ?? 9) - (ORDER[sopRunShow(b)] ?? 9) || Date.parse(b.started_at) - Date.parse(a.started_at))

export type RunFilter = { status?: '' | SopRunStatus; flow?: string; q?: string; waitingOnly?: boolean }

/** 状态以外的筛选（状态分段按钮的条数按它算） */
export function baseRuns(runs: readonly SopRunBrief[], f: RunFilter) {
  const kw = (f.q ?? '').trim().toLowerCase()
  return runs.filter((r) => (!f.waitingOnly || isPendingRun(r)) && (!f.flow || r.flow_id === f.flow)
    && (!kw || `${r.title} ${r.flow_name}`.toLowerCase().includes(kw)))
}

/** 进度文字：全部完成「N 步全部完成」，多路并行「N 路并行执行中」，否则「已结束/走到的 当前步骤名」 */
export function progressText(r: SopRunBrief) {
  const running = r.steps.filter((x) => x.status === 'running').length
  const walked = r.steps.filter((x) => x.status !== 'bypassed')
  const doneN = walked.filter((x) => isFinished(x.status)).length
  if (r.status === 'done') return `${doneN} 步全部完成`
  if (running > 1 && r.status === 'running') return `${running} 路并行执行中`
  return `${doneN}/${walked.length} ${r.steps[r.focus]?.name ?? ''}`.trim()
}

export type FlowStat = { n: number; pending: number; last: number }
/** 每个流程的执行次数、待处理次数、最近一次开始时间 */
export function flowStats(runs: readonly SopRunBrief[]) {
  const m = new Map<string, FlowStat>()
  for (const r of runs) {
    const x = m.get(r.flow_id) ?? { n: 0, pending: 0, last: 0 }
    x.n += 1
    if (isPendingRun(r)) x.pending += 1
    x.last = Math.max(x.last, Date.parse(r.started_at))
    m.set(r.flow_id, x)
  }
  return m
}

/** 二级菜单「最近用过」：最近执行过的流程，最多 5 个（流程删了不列） */
export function recentFlows(flows: readonly SopFlow[], stats: Map<string, FlowStat>, n = 5) {
  return flows.filter((f) => stats.has(f.id)).sort((a, b) => stats.get(b.id)!.last - stats.get(a.id)!.last).slice(0, n)
}

export type LibFilter = '' | 'pending' | 'never'
export const libPass = (f: SopFlow, k: LibFilter, stats: Map<string, FlowStat>) =>
  !k || (k === 'pending' ? (stats.get(f.id)?.pending ?? 0) > 0 : !stats.has(f.id))

/** 流程库：有待处理的在前，其余按最近执行时间，没执行过的按名字排在后面；要当前工作台没开的模块的（elsewhere）排在最后 */
export function libraryRows(flows: readonly SopFlow[], stats: Map<string, FlowStat>, k: LibFilter, q: string,
  opts: { trigger?: (t: string) => string; elsewhere?: (f: SopFlow) => boolean } = {}) {
  const kw = q.trim().toLowerCase()
  const trig = opts.trigger ?? ((t: string) => t)
  const away = (f: SopFlow) => Number(!!opts.elsewhere?.(f))
  const pend = (f: SopFlow) => Number((stats.get(f.id)?.pending ?? 0) > 0)
  return flows.filter((f) => libPass(f, k, stats) && (!kw || `${f.name} ${f.desc} ${f.trigger} ${trig(f.trigger)} ${f.schedule ? describeScheduleRule(fullScheduleRule(f.schedule.rule)) : ''}`.toLowerCase().includes(kw)))
    .sort((a, b) => away(a) - away(b) || pend(b) - pend(a) || (stats.get(b.id)?.last ?? 0) - (stats.get(a.id)?.last ?? 0) || a.name.localeCompare(b.name, 'zh-CN'))
}

/** 流程筛选的选项：现有流程加执行记录里出现过的已删除流程，后面带「N 次」 */
export function flowOptions(flows: readonly SopFlow[], runs: readonly SopRunBrief[]) {
  const m = new Map<string, string>()
  for (const f of flows) m.set(f.id, f.name)
  for (const r of runs) if (!m.has(r.flow_id)) m.set(r.flow_id, r.flow_name)
  const n = new Map<string, number>()
  for (const r of runs) n.set(r.flow_id, (n.get(r.flow_id) ?? 0) + 1)
  return [...m].map(([value, label]) => ({ value, label, hint: `${n.get(value) ?? 0} 次` }))
}

/* ---------- 运行页 ---------- */

export type Tab = 'input' | 'output' | 'log'

/** 步骤状态最该看的标签：暂停、失败、执行中、人工判断看输入；其余有输出看输出 */
export function defaultTab(def: SopStepDef, step: SopRunStep): Tab {
  if (step.status === 'paused' || step.status === 'failed' || step.status === 'running') return 'input'
  if (isManualDecide(def) && step.status === 'review') return 'input'
  return step.output ? 'output' : 'input'
}

/** 走到的上游（没走到的分支不算），退回重做用 */
export function upstreamOf(run: SopRun, i: number) {
  const byKey = new Map(run.flow.steps.map((d, j) => [d.key, j]))
  return depsOf(run.flow, i).map((k) => byKey.get(k)).filter((j): j is number => j !== undefined && run.steps[j]?.status !== 'bypassed')
    .map((j) => run.flow.steps[j])
}

export const EDITED_LABEL = { input: '输入被人工修改', output: '输出被人工修改', route: '分支由人选择' } as const

/** 改输入、改输出的 JSON：必须是对象 */
export function parseJsonObject(text: string): { ok: true; value: SopJson } | { ok: false; error: string } {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `JSON 格式不对：${(e as Error).message}` }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: '需要是一个 JSON 对象，形如 { "字段": 值 }' }
  return { ok: true, value: v as SopJson }
}

/** 发起执行抽屉的初始值：预填那次的输入，没有用默认值 */
export const initialValues = (flow: SopFlow, initial?: SopJson | null) =>
  Object.fromEntries(flow.fields.map((f) => [f.key, String(initial?.[f.key] ?? f.default ?? (f.type === 'select' ? f.options?.[0]?.value ?? '' : ''))]))
export const missingRequired = (flow: SopFlow, vals: Record<string, string>) => flow.fields.filter((f) => f.required && !vals[f.key]?.trim())
