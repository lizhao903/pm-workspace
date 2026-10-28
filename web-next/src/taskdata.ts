// 任务：三种来源
//   人工创建
//   IM 消息转任务：记下原消息，任务里能回看；消息那边显示「已转任务」
//   Webhook 转任务：外部系统往接收地址推 JSON，按映射规则取字段建任务；每次推送都留记录，建没建、为什么没建都查得到

// review：做完了等人验收（开发任务由 Claude Code 提交验收后停在这里），验收通过再改成 done
export type TaskStatus = 'todo' | 'doing' | 'review' | 'done' | 'cancelled'
/** 还没结束的任务：没完成也没取消 */
export const isOpenTask = (s: TaskStatus) => s !== 'done' && s !== 'cancelled'
// 优先级可在设置的枚举里新增，类型放宽成任意字符串，保留内置四档的字面量提示
export type Priority = 'P0' | 'P1' | 'P2' | 'P3' | (string & {})
export type Json = Record<string, unknown>

// TASK_STATUS、PRIORITIES 页面已不引用（显示走设置里的枚举），只作种子默认值和数据检查用
export const TASK_STATUS: Record<TaskStatus, { label: string; color: string }> = {
  todo: { label: '待办', color: '#a19d92' },
  doing: { label: '进行中', color: '#3d4fd6' },
  review: { label: '待验收', color: '#7048e8' },
  done: { label: '已完成', color: '#2f7d43' },
  cancelled: { label: '已取消', color: '#a19d92' },
}
export const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3']

export type TaskSource =
  | { kind: 'manual' }
  | { kind: 'im'; message_id: string; channel: string; sender: string; text: string }
  | { kind: 'webhook'; hook_id: string; delivery_id: string }
  | { kind: 'schedule'; schedule_id: string; name: string }
  | { kind: 'incident'; incident_id: string; title: string }

export interface Task {
  id: string
  ref: string
  title: string
  desc: string
  status: TaskStatus
  priority: Priority
  assignee: string
  /** yyyy-mm-dd */
  due: string | null
  source: TaskSource
  /** 属于哪个项目；不属于任何项目就留空 */
  project_id?: string
  /** 原属项目被删了：记下项目名，任务上提示「原属项目已删除」 */
  project_removed?: string
  created_at: string
  updated_at: string
}

export interface Webhook {
  id: string
  name: string
  /** 接收地址的最后一段 */
  token: string
  secret: string
  enabled: boolean
  /** 任务字段 <- payload 里的路径，形如 event.title、items[0].name；留空用默认值 */
  mapping: { title: string; desc: string; priority: string; assignee: string; due: string }
  /** 只有满足才建任务，形如 action == opened；留空不过滤 */
  filter: string
  /** 同一个值第二次推来就不再建，防止对方重试造成重复任务 */
  dedupe: string
  defaults: { priority: Priority; assignee: string }
  sample: string
  created_at: string
}

export interface Delivery {
  id: string
  hook_id: string
  at: string
  payload: Json
  result: 'created' | 'skipped' | 'failed'
  task_id?: string
  reason?: string
  /** 映射出来的字段，失败时也留着，方便看是哪一项没取到 */
  mapped?: Partial<Record<keyof Webhook['mapping'], string>>
}

export const HOOK_BASE = 'https://pmw.local/hooks/'
export const FIELD_LABEL: Record<keyof Webhook['mapping'], string> = { title: '标题', desc: '描述', priority: '优先级', assignee: '负责人', due: '截止日期' }

/* ---------- 映射 ---------- */

/** 取 a.b[0].c 这类路径的值 */
export function getPath(obj: unknown, path: string): unknown {
  if (!path.trim()) return undefined
  return path.trim().replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj)
}
const asText = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))

/** 外部系统的级别各说各的，常见的几种直接对上；对不上用默认 */
function toPriority(v: string, fallback: Priority): Priority {
  const s = v.trim().toLowerCase()
  if (/^p[0-3]$/.test(s)) return s.toUpperCase() as Priority
  if (/fatal|critical|blocker|紧急|urgent/.test(s)) return 'P0'
  if (/error|high|高|重要/.test(s)) return 'P1'
  if (/warn|medium|中|normal/.test(s)) return 'P2'
  if (/info|low|低|minor/.test(s)) return 'P3'
  return fallback
}

export function mapFields(hook: Webhook, payload: Json) {
  return Object.fromEntries((Object.keys(hook.mapping) as (keyof Webhook['mapping'])[]).map((k) => [k, asText(getPath(payload, hook.mapping[k]))])) as Record<keyof Webhook['mapping'], string>
}

/** 过滤条件只支持 路径 == 值 / 路径 != 值，够覆盖「只要 opened 事件」「不要 info 级别」 */
export function passFilter(hook: Webhook, payload: Json): { pass: boolean; reason?: string } {
  const m = /^\s*([\w.[\]]+)\s*(==|!=)\s*(.+?)\s*$/.exec(hook.filter)
  if (!hook.filter.trim()) return { pass: true }
  if (!m) return { pass: false, reason: `过滤条件写法不对：${hook.filter}` }
  const actual = asText(getPath(payload, m[1]))
  const want = m[3].replace(/^['"]|['"]$/g, '')
  const ok = m[2] === '==' ? actual === want : actual !== want
  return ok ? { pass: true } : { pass: false, reason: `不满足过滤条件 ${hook.filter}（实际是「${actual || '空'}」）` }
}

export type Ingest = { delivery: Delivery; task?: Task }

export function ingest(hook: Webhook, payload: Json, tasks: Task[], deliveries: Delivery[], at = new Date().toISOString()): Ingest {
  const id = `dl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const mapped = mapFields(hook, payload)
  const base = { id, hook_id: hook.id, at, payload, mapped }
  if (!hook.enabled) return { delivery: { ...base, result: 'skipped', reason: 'Webhook 已停用，只记录不建任务' } }
  const f = passFilter(hook, payload)
  if (!f.pass) return { delivery: { ...base, result: 'skipped', reason: f.reason } }
  if (hook.dedupe.trim()) {
    const key = asText(getPath(payload, hook.dedupe))
    // 只认任务还在的投递：建出来的任务删了，同样的推送再来就重新建
    const dup = key && deliveries.find((d) => d.hook_id === hook.id && d.result === 'created' && tasks.some((t) => t.id === d.task_id) && asText(getPath(d.payload, hook.dedupe)) === key)
    if (dup) return { delivery: { ...base, result: 'skipped', reason: `${hook.dedupe} = ${key} 已经建过任务，按重复推送忽略`, task_id: dup.task_id } }
  }
  if (!mapped.title.trim()) return { delivery: { ...base, result: 'failed', reason: hook.mapping.title ? `标题路径 ${hook.mapping.title} 取不到值` : '没有配置标题映射' } }
  const due = /^\d{4}-\d{2}-\d{2}/.exec(mapped.due)?.[0] ?? null
  const task = newTask(tasks, {
    title: mapped.title.slice(0, 120), desc: mapped.desc,
    priority: toPriority(mapped.priority, hook.defaults.priority),
    assignee: mapped.assignee || hook.defaults.assignee, due,
    source: { kind: 'webhook', hook_id: hook.id, delivery_id: id },
  }, at)
  return { delivery: { ...base, result: 'created', task_id: task.id }, task }
}

/* ---------- 新建 ---------- */

export function newTask(tasks: Task[], p: Partial<Task> & { title: string }, at = new Date().toISOString()): Task {
  const n = Math.max(0, ...tasks.map((t) => Number(t.ref.slice(2)) || 0)) + 1
  return {
    id: `tk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    ref: `T-${String(n).padStart(3, '0')}`,
    desc: '', status: 'todo', priority: 'P2', assignee: '', due: null, source: { kind: 'manual' },
    created_at: at, updated_at: at, ...p,
  }
}

/* ---------- 演示数据 ---------- */

const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString()
const dayOffset = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10)

export const seedHooks: Webhook[] = [
  {
    id: 'wh_sentry', name: 'Sentry 线上告警', token: 'k7Qm2sentry9x', secret: 'whsec_3f9a71c2e84b', enabled: true,
    mapping: { title: 'event.title', desc: 'event.culprit', priority: 'event.level', assignee: '', due: '' },
    filter: 'action == created', dedupe: 'event.id',
    defaults: { priority: 'P1', assignee: '周屿' },
    sample: JSON.stringify({ action: 'created', project: 'web-console', event: { id: 'a81f3c', title: 'TypeError: Cannot read properties of undefined (reading \'roles\')', culprit: 'src/pages/RoleEditor.tsx in buildTree', level: 'error', url: 'https://sentry.io/issues/4431/' } }, null, 2),
    created_at: minsAgo(60 * 24 * 20),
  },
  {
    id: 'wh_form', name: '官网需求表单', token: 'p2Rf8formz4c', secret: 'whsec_b72e01d95aa3', enabled: true,
    mapping: { title: 'answers.need', desc: 'answers.detail', priority: 'answers.urgency', assignee: '', due: 'answers.expect_date' },
    filter: '', dedupe: '',
    defaults: { priority: 'P2', assignee: '林予安' },
    sample: JSON.stringify({ form: '需求收集', answers: { company: '北岸物流', contact: '宋砚', need: '司机端支持离线签收', detail: '山区信号差，签收时经常提交失败，希望先存本地，有网了自动补传。', urgency: '高', expect_date: dayOffset(21) } }, null, 2),
    created_at: minsAgo(60 * 24 * 9),
  },
]

// 投递和它建出的任务共用同一个时间点
const AT_S1 = minsAgo(35)
const AT_F1 = minsAgo(60 * 5)

const sentryPayload = (id: string, title: string, level: string, action = 'created') => ({ action, project: 'web-console', event: { id, title, culprit: 'src/pages/Export.tsx in runExport', level, url: `https://sentry.io/issues/${id}/` } })

export const seedDeliveries: Delivery[] = [
  { id: 'dl_s1', hook_id: 'wh_sentry', at: AT_S1, payload: sentryPayload('b902ee', 'Export job timeout after 300s', 'fatal'), result: 'created', task_id: 'tk_s1', mapped: { title: 'Export job timeout after 300s', desc: 'src/pages/Export.tsx in runExport', priority: 'fatal', assignee: '', due: '' } },
  { id: 'dl_s2', hook_id: 'wh_sentry', at: minsAgo(33), payload: sentryPayload('b902ee', 'Export job timeout after 300s', 'fatal'), result: 'skipped', task_id: 'tk_s1', reason: 'event.id = b902ee 已经建过任务，按重复推送忽略', mapped: { title: 'Export job timeout after 300s', desc: 'src/pages/Export.tsx in runExport', priority: 'fatal', assignee: '', due: '' } },
  { id: 'dl_s3', hook_id: 'wh_sentry', at: minsAgo(20), payload: sentryPayload('c11d04', 'Slow query on /api/audit', 'warning', 'resolved'), result: 'skipped', reason: '不满足过滤条件 action == created（实际是「resolved」）', mapped: { title: 'Slow query on /api/audit', desc: 'src/pages/Export.tsx in runExport', priority: 'warning', assignee: '', due: '' } },
  { id: 'dl_f1', hook_id: 'wh_form', at: AT_F1, payload: JSON.parse(seedHooks[1].sample), result: 'created', task_id: 'tk_f1', mapped: { title: '司机端支持离线签收', desc: '山区信号差，签收时经常提交失败，希望先存本地，有网了自动补传。', priority: '高', assignee: '', due: dayOffset(21) } },
  { id: 'dl_f2', hook_id: 'wh_form', at: minsAgo(60 * 2), payload: { form: '需求收集', answers: { company: '远川科技', contact: '许知行', detail: '希望审批能接企业微信', urgency: '中' } }, result: 'failed', reason: '标题路径 answers.need 取不到值', mapped: { title: '', desc: '希望审批能接企业微信', priority: '中', assignee: '', due: '' } },
]

export const seedTasks: Task[] = [
  { id: 'tk_a1', project_id: 'pj_perm', ref: 'T-014', title: '确认演示环境能不能打开自定义角色', desc: '消息分诊助手在会话里建的，跟 T-010 配套：先确认演示环境的开关', status: 'todo', priority: 'P2', assignee: '我', due: dayOffset(2), source: { kind: 'manual' }, created_at: minsAgo(24), updated_at: minsAgo(24) },
  { id: 'tk_inc_seed', ref: 'T-013', title: '[异常] Webhook：官网需求表单标题字段取不到', desc: '对方表单可能改了字段名，映射要兼容，或者取不到时给出明确提示', status: 'todo', priority: 'P2', assignee: '周屿', due: dayOffset(4), source: { kind: 'incident', incident_id: 'inc3', title: '官网需求表单：标题字段取不到' }, created_at: minsAgo(110), updated_at: minsAgo(110) },
  { id: 'tk_s1', project_id: 'pj_pmw', ref: 'T-012', title: 'Export job timeout after 300s', desc: 'src/pages/Export.tsx in runExport', status: 'doing', priority: 'P0', assignee: '周屿', due: dayOffset(0), source: { kind: 'webhook', hook_id: 'wh_sentry', delivery_id: 'dl_s1' }, created_at: AT_S1, updated_at: minsAgo(10) },
  { id: 'tk_f1', ref: 'T-011', title: '司机端支持离线签收', desc: '山区信号差，签收时经常提交失败，希望先存本地，有网了自动补传。', status: 'todo', priority: 'P1', assignee: '林予安', due: dayOffset(21), source: { kind: 'webhook', hook_id: 'wh_form', delivery_id: 'dl_f1' }, created_at: AT_F1, updated_at: AT_F1 },
  { id: 'tk_i1', project_id: 'pj_perm', ref: 'T-010', title: '月底演示带上按部门自定义角色', desc: '客户老板下周要看，先确认演示环境能不能开这个开关。', status: 'todo', priority: 'P1', assignee: '我', due: dayOffset(3), source: { kind: 'im', message_id: 'msg_003', channel: 'lark', sender: '许知行', text: '月底的演示能不能把按部门自定义角色带上？我们老板下周要看。' }, created_at: minsAgo(30), updated_at: minsAgo(30) },
  { id: 'tk_i2', project_id: 'pj_perm', ref: 'T-009', title: '和后端对齐权限变更生效时间的缓存方案', desc: '', status: 'doing', priority: 'P2', assignee: '我', due: dayOffset(1), source: { kind: 'im', message_id: 'msg_005', channel: 'slack', sender: 'Zhou Yu', text: '权限变更 1 分钟内生效这条，缓存方案要改，可能会影响排期，找时间对一下。' }, created_at: minsAgo(75), updated_at: minsAgo(40) },
  { id: 'tk_m1', project_id: 'pj_pmw', ref: 'T-008', title: '整理 Q4 路线图初稿', desc: '按「云端 / 本地端 / 平台」三条线，先列候选，周五前给到负责人。', status: 'todo', priority: 'P2', assignee: '我', due: dayOffset(-1), source: { kind: 'manual' }, created_at: minsAgo(60 * 30), updated_at: minsAgo(60 * 30) },
  { id: 'tk_m2', project_id: 'pj_perm', ref: 'T-007', title: '权限模型 PRD 评审', desc: '约林予安、周屿、陈若溪', status: 'done', priority: 'P1', assignee: '我', due: dayOffset(-2), source: { kind: 'manual' }, created_at: minsAgo(60 * 70), updated_at: minsAgo(60 * 26) },
  { id: 'tk_m3', ref: 'T-006', title: '续签云栈 IDC 机柜合同', desc: '', status: 'todo', priority: 'P3', assignee: '我', due: dayOffset(10), source: { kind: 'manual' }, created_at: minsAgo(60 * 80), updated_at: minsAgo(60 * 80) },
  // 定时任务「周会前整理议程」每周一建的两条（scheduledata 里 sc_weekly_agenda 的执行记录指向它们）
  { id: 'tk_sc2', ref: 'T-005', title: '整理本周产品周会议程', desc: '把上周遗留问题和本周要拍板的事列出来，会前发群里', status: 'done', priority: 'P2', assignee: '我', due: dayOffset(-2), source: { kind: 'schedule', schedule_id: 'sc_weekly_agenda', name: '周会前整理议程' }, created_at: minsAgo(60 * 24 * 2 + 300), updated_at: minsAgo(60 * 24 * 2 + 180) },
  { id: 'tk_sc1', ref: 'T-002', title: '整理本周产品周会议程', desc: '把上周遗留问题和本周要拍板的事列出来，会前发群里', status: 'done', priority: 'P2', assignee: '我', due: dayOffset(-9), source: { kind: 'schedule', schedule_id: 'sc_weekly_agenda', name: '周会前整理议程' }, created_at: minsAgo(60 * 24 * 9 + 300), updated_at: minsAgo(60 * 24 * 9 + 200) },
]
