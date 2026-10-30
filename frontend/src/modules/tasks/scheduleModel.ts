// 定时任务页的纯函数（SPEC-tasks-7、8）：规则说成一句话、前端先挡的规则错误、「做什么」的文字、表单草稿和提交体。
// 下次执行、接下来几次由后端算（next_run_at、POST /api/schedules/preview），这里不重复算。
import type {
  DictItem, Schedule, ScheduleAction, ScheduleActionKind, ScheduleFreq, ScheduleInput, SchedulePatch, ScheduleRule, ScheduleRun,
} from '../../core/data'

export const FREQS: ScheduleFreq[] = ['once', 'daily', 'weekdays', 'weekly', 'monthly', 'cron']
export const FREQ_LABEL: Record<ScheduleFreq, string> = { once: '一次', daily: '每天', weekdays: '工作日', weekly: '每周', monthly: '每月', cron: 'Cron 表达式' }
export const ACTION_KINDS: ScheduleActionKind[] = ['task', 'sop', 'agent', 'incident_sweep']
export const ACTION_LABEL: Record<ScheduleActionKind, string> = { task: '建一条任务', sop: '执行 SOP', agent: '让 Agent 去做', incident_sweep: '运行异常巡检' }
/** 运行异常巡检（INC-01b）：最低级别、最少次数 */
export const SWEEP_LEVEL_LABEL = { error: '只看错误', warn: '错误和警告' } as const
export const SWEEP_COUNTS = [1, 2, 3, 5, 10]
/** 插件登记的动作（VID-06a）：后端原样回，这里只给认得的起名字，其余显示 kind */
const PLUGIN_ACTION_LABEL: Record<string, string> = { video_publish: '发布视频' }
export const actionLabel = (kind: string) => ACTION_LABEL[kind as ScheduleActionKind] ?? PLUGIN_ACTION_LABEL[kind] ?? kind
/** 不是内核的四种动作 */
export const isPluginAction = (kind: string) => !(ACTION_KINDS as string[]).includes(kind)
/** 视频发布动作（video_publish）的发布记录 id */
export function publishIdOf(a: ScheduleAction): string | undefined {
  const x = a as unknown as { kind: string; publish_id?: unknown }
  return x.kind === 'video_publish' && typeof x.publish_id === 'string' && x.publish_id ? x.publish_id : undefined
}
/** 动作里引用的东西的名字：发布记录 id 到发布标题；没取到（视频插件没启用）不传 */
export type ActionNames = { publishes?: Record<string, string> }
export const WEEK = ['日', '一', '二', '三', '四', '五', '六']
/** 周一在前 */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]
export const DUE_DAYS = [0, 1, 2, 3, 5, 7]

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** 新建时的默认规则：每周一 09:00；一次性默认明天，cron 默认同一个点 */
export function emptyRule(now: Date = new Date()): ScheduleRule {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return { freq: 'weekly', time: '09:00', weekdays: [1], day: 1, date: ymd(tomorrow), cron: '0 9 * * 1' }
}

/** 后端只给自己频率的字段时补齐，切换频率时有默认值可用 */
export function fullRule(r: Partial<ScheduleRule> | undefined, now: Date = new Date()): ScheduleRule {
  const e = emptyRule(now)
  return {
    freq: r?.freq ?? e.freq,
    time: r?.time || e.time,
    weekdays: r?.weekdays?.length ? [...r.weekdays] : e.weekdays,
    day: r?.day || e.day,
    date: r?.date || e.date,
    cron: r?.cron || e.cron,
  }
}

/** 规则写成一句话：「每周一 09:00」「Cron：0 18 * * 1」 */
export function describeRule(r: ScheduleRule): string {
  switch (r.freq) {
    case 'once': return `${r.date || '未定日期'} ${r.time}`
    case 'daily': return `每天 ${r.time}`
    case 'weekdays': return `工作日 ${r.time}`
    case 'weekly': {
      const days = WEEK_ORDER.filter((d) => r.weekdays.includes(d))
      return `每周${days.length ? days.map((d) => WEEK[d]).join('、') : '（没选周几）'} ${r.time}`
    }
    case 'monthly': return `每月 ${r.day} 号 ${r.time}`
    case 'cron': return `Cron：${r.cron || '未填'}`
  }
}

/** 前端先挡的规则错误（SPEC-tasks-0 ruleError 的五种文案）；cron 的细节和时区由后端预览再校验 */
export function ruleError(r: ScheduleRule, now: Date = new Date()): string {
  if (r.freq !== 'cron' && !/^\d{2}:\d{2}$/.test(r.time)) return '时间要写成 09:00 这种格式'
  if (r.freq === 'weekly' && !r.weekdays.length) return '每周执行要至少选一天'
  if (r.freq === 'once' && !r.date) return '选一个执行日期'
  if (r.freq === 'once' && new Date(`${r.date}T${r.time}`) <= now) return '这个时间已经过去了'
  if (r.freq === 'cron' && r.cron.trim().split(/\s+/).filter(Boolean).length !== 5) return 'Cron 要 5 段：分 时 日 月 周，比如 0 9 * * 1'
  return ''
}

/** 「今天 09:00」「明天 09:00」「周三 18:00」「11-15 09:00」；算不出时「不再执行」 */
export function whenText(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '不再执行'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '不再执行'
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(d) - day(now)) / 86400000)
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (diff === 0) return `今天 ${t}`
  if (diff === 1) return `明天 ${t}`
  if (diff > 1 && diff < 7) return `周${WEEK[d.getDay()]} ${t}`
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${t}`
}

/** 发布记录名「平台 · 标题」；发布记录取到了但没有这一条时「已删除的发布记录」，没取到时显示编号 */
export function publishName(id: string, names: ActionNames): string {
  if (!names.publishes) return `发布记录 ${id}`
  return names.publishes[id] ?? '已删除的发布记录'
}

/** 列表里「做什么」的文字。SOP、Agent 的接口 M4 之后才有，拿不到名字时显示编号；视频发布显示发布标题 */
export function actionText(a: ScheduleAction, names: ActionNames = {}): string {
  if (a.kind === 'task') return `建任务「${a.title || '未填标题'}」`
  if (a.kind === 'sop') return `执行「${a.sop_id || '未选 SOP'}」`
  if (a.kind === 'incident_sweep') return `巡检运行异常：${SWEEP_LEVEL_LABEL[a.min_level] ?? SWEEP_LEVEL_LABEL.error}${a.min_count > 1 ? `，至少 ${a.min_count} 次` : ''}，建任务交给 Claude Code`
  const kind = (a as { kind: string }).kind
  if (kind === 'video_publish') {
    const id = publishIdOf(a)
    return id ? (names.publishes ? `发布「${publishName(id, names)}」` : `发布记录 ${id}`) : '发布「未选发布记录」'
  }
  if (isPluginAction(kind)) return actionLabel(kind)
  return `${a.agent_id || '未选 Agent'}：${a.prompt || '未填要求'}`
}

/** 执行记录一条的样子：成功绿点，执行中灰点，其余（失败、停用跳过、暂不支持、错过）红点 */
export function runTone(r: Pick<ScheduleRun, 'status'>): 'ok' | 'wait' | 'bad' {
  if (r.status === 'ok') return 'ok'
  if (r.status === 'running') return 'wait'
  return 'bad'
}

/** 动作的表单字段摊平存，切换类型时各自的字段不丢 */
export type ActionDraft = {
  kind: ScheduleActionKind
  title: string
  desc: string
  priority: string
  assignee: string
  due_days: number
  sop_id: string
  agent_id: string
  prompt: string
  /** 运行异常巡检 */
  min_level: 'error' | 'warn'
  min_count: number
}

export type ScheduleDraft = { name: string; enabled: boolean; rule: ScheduleRule; action: ActionDraft }

/** 优先级字典的默认值：meta.default，没有就 P2，和新建任务一致 */
export function defaultPriority(priorities: readonly DictItem[]): string {
  const live = priorities.filter((p) => !p.archived_at)
  return (live.find((p) => p.meta?.default === true) ?? live.find((p) => p.key === 'P2') ?? live[0])?.key ?? ''
}

export function emptyAction(kind: ScheduleActionKind, priority: string): ActionDraft {
  return { kind, title: '', desc: '', priority, assignee: '', due_days: 0, sop_id: '', agent_id: '', prompt: '', min_level: 'error', min_count: 1 }
}

export function emptyScheduleDraft(priorities: readonly DictItem[], now: Date = new Date()): ScheduleDraft {
  return { name: '', enabled: true, rule: emptyRule(now), action: emptyAction('task', defaultPriority(priorities)) }
}

export function scheduleDraftOf(s: Schedule, priorities: readonly DictItem[], now: Date = new Date()): ScheduleDraft {
  const a = emptyAction(s.action.kind, defaultPriority(priorities))
  return { name: s.name, enabled: s.enabled, rule: fullRule(s.rule, now), action: { ...a, ...s.action } }
}

/** 按类型只留自己的字段 */
export function actionOf(a: ActionDraft): ScheduleAction {
  if (a.kind === 'sop') return { kind: 'sop', sop_id: a.sop_id.trim() }
  if (a.kind === 'agent') return { kind: 'agent', agent_id: a.agent_id.trim(), prompt: a.prompt.trim() }
  if (a.kind === 'incident_sweep') return { kind: 'incident_sweep', min_level: a.min_level, min_count: a.min_count }
  return { kind: 'task', title: a.title.trim(), desc: a.desc.trim(), priority: a.priority, assignee: a.assignee, due_days: a.due_days }
}

/** 必填项的错误，按底栏显示的顺序（SPEC-tasks-8.17） */
export function draftErrors(d: ScheduleDraft, now: Date = new Date()): string[] {
  const a = d.action
  // 插件动作在这里只读，校验交给插件
  const aErr = isPluginAction(a.kind) ? '' : a.kind === 'task' ? (!a.title.trim() ? '任务标题必填' : '')
    : a.kind === 'sop' ? (!a.sop_id.trim() ? '选一个 SOP' : '')
      : a.kind === 'incident_sweep' ? (Number.isInteger(a.min_count) && a.min_count >= 1 ? '' : '最少次数要是 1 以上的整数')
      : !a.agent_id.trim() ? '选一个 Agent' : !a.prompt.trim() ? '写一下要它做什么' : ''
  return [!d.name.trim() ? '名称必填' : '', ruleError(d.rule, now), aErr].filter(Boolean)
}

export function buildScheduleInput(d: ScheduleDraft): ScheduleInput {
  return { name: d.name.trim(), enabled: d.enabled, rule: d.rule, action: actionOf(d.action) }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * 编辑保存只传改过的：名称、启用单独比；规则按「这个频率用到的字段」比，动作按提交体比。
 * 只改名称或启停时不带规则，过期的一次性任务也能改名、停用（契约）。
 */
export function buildSchedulePatch(base: ScheduleDraft, d: ScheduleDraft): SchedulePatch {
  const p: SchedulePatch = {}
  if (d.name.trim() !== base.name.trim()) p.name = d.name.trim()
  if (d.enabled !== base.enabled) p.enabled = d.enabled
  if (!same(ruleKey(d.rule), ruleKey(base.rule))) p.rule = d.rule
  if (!same(actionOf(d.action), actionOf(base.action))) p.action = actionOf(d.action)
  return p
}

/** 有没有改动：和提交体同一个口径，切频率又切回来不算 */
export const scheduleDirty = (base: ScheduleDraft, d: ScheduleDraft) => Object.keys(buildSchedulePatch(base, d)).length > 0

/** 规则里这个频率真正用到的字段 */
function ruleKey(r: ScheduleRule): unknown[] {
  switch (r.freq) {
    case 'once': return [r.freq, r.date, r.time]
    case 'weekly': return [r.freq, r.time, [...r.weekdays].sort()]
    case 'monthly': return [r.freq, r.time, r.day]
    case 'cron': return [r.freq, r.cron.trim()]
    default: return [r.freq, r.time]
  }
}

/** 页面搜索：名称、规则文字、「做什么」文字 */
export function matchSchedule(s: Schedule, kw: string, names: ActionNames = {}): boolean {
  const q = kw.trim().toLowerCase()
  if (!q) return true
  return `${s.name} ${describeRule(fullRule(s.rule))} ${actionText(s.action, names)}`.toLowerCase().includes(q)
}
