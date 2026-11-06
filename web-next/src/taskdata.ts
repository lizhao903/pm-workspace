// 任务：三种来源
//   人工创建
//   IM 消息转任务：记下原消息，任务里能回看；消息那边显示「已转任务」
//   Webhook 转任务：外部系统往接收地址推 JSON，按映射规则取字段建任务；每次推送都留记录，建没建、为什么没建都查得到

// review：做完了等人验收（开发任务由 Claude Code 提交验收后停在这里），验收通过再改成 done
export type TaskStatus = 'todo' | 'doing' | 'review' | 'done' | 'cancelled'
/** 还没结束的任务：没完成也没取消 */
export const isOpenTask = (s: TaskStatus) => s !== 'done' && s !== 'cancelled'
/** 本地日期 yyyy-mm-dd：「今天」、逾期、截止日都按本地时区算，不用 toISOString（那是 UTC，东八区 0 点到 8 点会差一天） */
export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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
  /** session_id：从消息发起的会话里 Agent 拆出来的任务（SPEC-messages-5.6），转任务建的没有 */
  /** reply_on_done：转任务时勾了「执行完成后在原消息里回复」（SPEC-tasks-4.42），正式产品由 SOP「IM 任务回执」回复 */
  | { kind: 'im'; message_id: string; channel: string; sender: string; text: string; session_id?: string; reply_on_done?: boolean }
  | { kind: 'webhook'; hook_id: string; delivery_id: string }
  | { kind: 'schedule'; schedule_id: string; name: string }
  | { kind: 'incident'; incident_id: string; title: string }

/** 提出人：认到联系人时 contact_id 是联系人 id、name 是联系人名；认不上时存 IM 发送者快照（渠道、编号、显示名） */
export interface TaskRequester { contact_id?: string; name: string; channel?: string; sender_id?: string; sender_name?: string }

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
  /** 开发任务：验收标准（Markdown 清单，对应 props.acceptance） */
  acceptance?: string
  /** 开发任务：工作目录；没设时继承所属项目的根目录 */
  workdir?: string
  /** 开发任务：关联仓库，远端地址或本机绝对路径，只放一个（对应 props.repo） */
  repo?: string
  /** 标签；运行异常巡检建的任务带 claude-code，交给 Claude Code 修（INC-01） */
  tags?: string[]
  /** 阶段（AUTO-05，SPEC-tasks-11）：提出人在看板上看到的流程进度，取值见 taskstage.tsx 的 STAGES；没设为空（对应 props.stage） */
  stage?: string
  /** 提出人（对应 props.requester）：IM 转来的自动填，认得出联系人带 contact_id */
  requester?: TaskRequester
  /**
   * 阶段变化历史（AUTO-12，流水线时间线 SPEC-sop-16），早的在前；from、to 没设阶段为空串。
   * 正式产品不存在任务上，取审计 kind=stage（每次阶段变化记一条，detail 带 from、to）
   */
  stage_log?: { at: string; from: string; to: string }[]
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
const dayOffset = (d: number) => { const x = new Date(); x.setDate(x.getDate() + d); return localDay(x) }

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
  // 交给 Claude Code 做的开发任务：进展、产出物、执行记录在文件末尾的 seedProgress / seedArtifacts / seedRuns
  { id: 'tk_dev3', stage: 'accepting', requester: { contact_id: 'ct_005', name: '许知行', channel: 'lark', sender_id: 'ou_7f3a9c21' }, project_id: 'pj_perm', ref: 'T-017', title: '权限变更缓存改成按部门失效', desc: '对应 T-009：权限变更要 1 分钟内生效。现在整租户缓存 10 分钟，改成按部门打版本号，改了哪个部门只失效哪个部门。', status: 'review', priority: 'P1', assignee: 'Claude Code', due: dayOffset(2), source: { kind: 'manual' },
    acceptance: '- [ ] 改了某个部门的角色，1 分钟内该部门成员的权限生效\n- [ ] 其他部门的缓存不受影响\n- [ ] 500 并发下权限查询 p99 不超过 20ms',
    workdir: '/Volumes/project/clients/yuanchuan-permission/server', repo: '/Volumes/project/clients/yuanchuan-permission', created_at: minsAgo(60 * 4), updated_at: minsAgo(50) },
  { id: 'tk_dev2', stage: 'developing', stage_log: [
    { at: minsAgo(60 * 2), from: '', to: 'received' }, { at: minsAgo(115), from: 'received', to: 'designing' },
    { at: minsAgo(100), from: 'designing', to: 'reviewing' }, { at: minsAgo(97), from: 'reviewing', to: 'designing' },
    { at: minsAgo(95), from: 'designing', to: 'reviewing' }, { at: minsAgo(92), from: 'reviewing', to: 'developing' },
  ], project_id: 'pj_pmw', ref: 'T-016', title: '旧版设置页的错误横幅改成行内提示', desc: '旧版问题清单里的「列表页错误横幅太占地方」。保存失败时在出错的字段下面提示，不在页顶铺一条横幅。', status: 'doing', priority: 'P2', assignee: 'Claude Code', due: dayOffset(4), source: { kind: 'manual' },
    acceptance: '- [ ] 连接器、模型服务商、Agent 三个设置页保存失败时在字段下提示\n- [ ] 页顶不再出现错误横幅\n- [ ] npm run build 通过',
    workdir: '/Volumes/project/example/pm-workspace/web', repo: '/Volumes/project/example/pm-workspace', created_at: minsAgo(60 * 2), updated_at: minsAgo(25) },
  { id: 'tk_dev1', stage: 'testing', requester: { contact_id: 'ct_002', name: '周屿', channel: 'slack', sender_id: 'U04ZHOUYU0' }, project_id: 'pj_pmw', ref: 'T-015', title: '导出改成分批写文件，修掉 300 秒超时', desc: '对应 T-012。Sentry 报 runExport 300 秒超时：大租户的审计日志一次读进内存再写文件。改成分批读、边读边写。', status: 'review', priority: 'P1', assignee: 'Claude Code', due: dayOffset(1), source: { kind: 'manual' },
    acceptance: '- [ ] 12 万行的导出 60 秒内完成\n- [ ] 导出过程中内存峰值不超过 200MB\n- [ ] 界面上不再显示「导出超时」\n- [ ] go test ./internal/export/... 通过',
    repo: '/Volumes/project/example/pm-workspace', created_at: minsAgo(60 * 6), updated_at: minsAgo(100) },
  { id: 'tk_a1', project_id: 'pj_perm', ref: 'T-014', title: '确认演示环境能不能打开自定义角色', desc: '消息分诊助手在会话里建的，跟 T-010 配套：先确认演示环境的开关', status: 'todo', priority: 'P2', assignee: '我', due: dayOffset(2), source: { kind: 'manual' }, created_at: minsAgo(24), updated_at: minsAgo(24) },
  { id: 'tk_inc_seed', ref: 'T-013', title: '[异常] Webhook：官网需求表单标题字段取不到', desc: '对方表单可能改了字段名，映射要兼容，或者取不到时给出明确提示', status: 'todo', priority: 'P2', assignee: '周屿', due: dayOffset(4), source: { kind: 'incident', incident_id: 'inc3', title: '官网需求表单：标题字段取不到' }, created_at: minsAgo(110), updated_at: minsAgo(110) },
  { id: 'tk_s1', stage: 'need_human', stage_log: [
    { at: minsAgo(60 * 5), from: '', to: 'received' }, { at: minsAgo(60 * 4), from: 'received', to: 'designing' },
    { at: minsAgo(60 * 3), from: 'designing', to: 'reviewing' }, { at: minsAgo(40), from: 'reviewing', to: 'need_human' },
  ], requester: { contact_id: 'ct_002', name: '周屿', channel: 'slack', sender_id: 'U04ZHOUYU0' }, project_id: 'pj_pmw', ref: 'T-012', title: 'Export job timeout after 300s', desc: 'src/pages/Export.tsx in runExport', status: 'doing', priority: 'P0', assignee: '周屿', due: dayOffset(0), source: { kind: 'webhook', hook_id: 'wh_sentry', delivery_id: 'dl_s1' }, created_at: AT_S1, updated_at: minsAgo(10) },
  { id: 'tk_f1', stage: 'received', requester: { name: '山区站点王师傅', channel: 'webhook', sender_name: '山区站点王师傅' }, project_id: 'pj_beian', ref: 'T-011', title: '司机端支持离线签收', desc: '山区信号差，签收时经常提交失败，希望先存本地，有网了自动补传。', status: 'todo', priority: 'P1', assignee: '林予安', due: dayOffset(21), source: { kind: 'webhook', hook_id: 'wh_form', delivery_id: 'dl_f1' }, created_at: AT_F1, updated_at: AT_F1 },
  { id: 'tk_i1', stage: 'designing', requester: { contact_id: 'ct_005', name: '许知行', channel: 'lark', sender_id: 'ou_7f3a9c21' }, project_id: 'pj_perm', ref: 'T-010', title: '月底演示带上按部门自定义角色', desc: '客户老板下周要看，先确认演示环境能不能开这个开关。', status: 'todo', priority: 'P1', assignee: '我', due: dayOffset(3), source: { kind: 'im', message_id: 'msg_003', channel: 'lark', sender: '许知行', text: '月底的演示能不能把按部门自定义角色带上？我们老板下周要看。' }, created_at: minsAgo(30), updated_at: minsAgo(30) },
  { id: 'tk_i2', stage: 'clarifying', requester: { contact_id: 'ct_002', name: '周屿', channel: 'slack', sender_id: 'U04ZHOUYU0' }, project_id: 'pj_perm', ref: 'T-009', title: '和后端对齐权限变更生效时间的缓存方案', desc: '', status: 'doing', priority: 'P2', assignee: '我', due: dayOffset(1), source: { kind: 'im', message_id: 'msg_005', channel: 'slack', sender: 'Zhou Yu', text: '权限变更 1 分钟内生效这条，缓存方案要改，可能会影响排期，找时间对一下。' }, created_at: minsAgo(75), updated_at: minsAgo(40) },
  { id: 'tk_m1', project_id: 'pj_pmw', ref: 'T-008', title: '整理 Q4 路线图初稿', desc: '按「云端 / 本地端 / 平台」三条线，先列候选，周五前给到负责人。', status: 'todo', priority: 'P2', assignee: '我', due: dayOffset(-1), source: { kind: 'manual' }, created_at: minsAgo(60 * 30), updated_at: minsAgo(60 * 30) },
  { id: 'tk_m2', project_id: 'pj_perm', ref: 'T-007', title: '权限模型 PRD 评审', desc: '约林予安、周屿、陈若溪', status: 'done', priority: 'P1', assignee: '我', due: dayOffset(-2), source: { kind: 'manual' }, created_at: minsAgo(60 * 70), updated_at: minsAgo(60 * 26) },
  { id: 'tk_m3', ref: 'T-006', title: '续签云栈 IDC 机柜合同', desc: '', status: 'todo', priority: 'P3', assignee: '我', due: dayOffset(10), source: { kind: 'manual' }, created_at: minsAgo(60 * 80), updated_at: minsAgo(60 * 80) },
  { id: 'tk_eu1', project_id: 'pj_eu', ref: 'T-004', title: '画欧盟租户的存储和备份架构', desc: '业务数据和备份都落在欧盟境内机房；运维访问走工单留痕。和 Mia 通电话前发给她。', status: 'doing', priority: 'P1', assignee: '我', due: dayOffset(1), source: { kind: 'manual' }, created_at: minsAgo(60 * 24 * 5), updated_at: minsAgo(60 * 3) },
  { id: 'tk_ba1', project_id: 'pj_beian', ref: 'T-003', title: '用工单状态机搭审批流 demo', desc: '待提交、审批中、通过 / 驳回，驳回后能重新提交；金额大于 5 万走总监审批。', status: 'todo', priority: 'P3', assignee: '林予安', due: dayOffset(14), source: { kind: 'manual' }, created_at: minsAgo(60 * 24 * 6), updated_at: minsAgo(60 * 24 * 2) },
  // 定时任务「周会前整理议程」每周一建的两条（scheduledata 里 sc_weekly_agenda 的执行记录指向它们）
  { id: 'tk_sc2', ref: 'T-005', title: '整理本周产品周会议程', desc: '把上周遗留问题和本周要拍板的事列出来，会前发群里', status: 'done', priority: 'P2', assignee: '我', due: dayOffset(-2), source: { kind: 'schedule', schedule_id: 'sc_weekly_agenda', name: '周会前整理议程' }, created_at: minsAgo(60 * 24 * 2 + 300), updated_at: minsAgo(60 * 24 * 2 + 180) },
  { id: 'tk_sc1', ref: 'T-002', title: '整理本周产品周会议程', desc: '把上周遗留问题和本周要拍板的事列出来，会前发群里', status: 'done', priority: 'P2', assignee: '我', due: dayOffset(-9), source: { kind: 'schedule', schedule_id: 'sc_weekly_agenda', name: '周会前整理议程' }, created_at: minsAgo(60 * 24 * 9 + 300), updated_at: minsAgo(60 * 24 * 9 + 200) },
]

/* ---------- 开发任务闭环：进展、产出物、执行记录 ---------- */
// 字段跟 docs/api-contract.md 的 Progress / Artifact / TaskRun 对齐；原型只存在内存里

/** claim 领取 / note 进展 / review 提交验收 */
export type ProgressKind = 'claim' | 'note' | 'review'
export const PROGRESS_LABEL: Record<ProgressKind, string> = { claim: '领取', note: '进展', review: '提交验收' }

export interface TaskProgress {
  id: string
  task_id: string
  kind: ProgressKind
  /** Markdown 正文 */
  text: string
  commits: string[]
  files: string[]
  /** 和这条进展同时切到的状态 */
  status?: TaskStatus
  /** claude-code、我 */
  actor_name: string
  /** Claude Code 的会话 id；界面上操作的没有 */
  session_id?: string
  source: 'agent' | 'ui'
  at: string
}

/** 产出物：commit / branch / PR 的种类写在 note 开头的 [commit] 这类标记里，没有标记的算文件 */
export interface TaskArtifact {
  id: string
  task_id: string
  note: string
  url?: string
  /** 绝对路径；本地的 commit / branch 填仓库目录 */
  path?: string
  rel_path?: string
  source: 'manual' | 'agent' | 'run' | 'mcp'
  at: string
}
export type ArtifactKind = 'commit' | 'branch' | 'pr' | 'file'
export const ARTIFACT_GROUPS: { key: ArtifactKind; label: string }[] = [
  { key: 'commit', label: '提交' }, { key: 'branch', label: '分支' }, { key: 'pr', label: 'PR' }, { key: 'file', label: '文件' },
]

/** 从 note 里拆出种类、sha、branch、repo 和余下的备注 */
export function parseArtifact(note: string): { kind: ArtifactKind; sha?: string; branch?: string; repo?: string; text: string } {
  const m = /^\[(commit|branch|pr)\]\s*/.exec(note)
  if (!m) return { kind: 'file', text: note }
  const kv: Record<string, string> = {}
  let rest = note.slice(m[0].length)
  for (;;) {
    const x = /^(sha|branch|repo)=(\S+)\s*/.exec(rest)
    if (!x) break
    kv[x[1]] = x[2]
    rest = rest.slice(x[0].length)
  }
  return { kind: m[1] as ArtifactKind, sha: kv.sha, branch: kv.branch, repo: kv.repo, text: rest.trim() }
}

/** 执行时的流式事件，形状同 SSE 的 delta / tool / tool_result；confirm、decision 只有工作台 Agent 执行有（SPEC-tasks-5.33、5.34） */
export type RunEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; id: string; name: string; detail: string }
  | { type: 'tool_result'; id: string; ok: boolean; error?: string; summary?: string }
  /** 要人确认的写操作：执行停下等，deadline 到了按拒绝处理 */
  | { type: 'confirm'; id: string; name: string; summary: string; deadline: string }
  | { type: 'decision'; id: string; approved: boolean; reason: 'user' | 'timeout' }

/** 执行器（SPEC-tasks-6.20）：本机 Claude Code，或工作台自己的 Agent（正式产品 task_runs.harness，claude / deepseek / agent） */
export type RunHarness = 'claude' | 'agent'

export interface TaskRun {
  id: string
  task_id: string
  /** 后端按「有没有工具调用成功过」判定，不看 exit_code；waiting 是工作台 Agent 停在要确认的写操作上（SPEC-tasks-5.34） */
  status: 'running' | 'waiting' | 'done' | 'failed' | 'cancelled'
  /** 执行方式：stream 工作台里流式执行（缺省），terminal 在终端里交互执行（0048 的 task_runs.mode） */
  mode?: 'stream' | 'terminal'
  /** 执行器，缺省 claude（SPEC-tasks-6.20） */
  harness?: RunHarness
  /** 工作台 Agent 执行：用的 Agent、服务商下的模型、绑定的会话（会话页能打开接着聊，正式产品 harness_session） */
  agent_id?: string
  model?: string
  agent_session?: string
  /** 工作台 Agent 执行：等确认多少分钟按拒绝处理（confirm_wait_minutes，默认 10） */
  confirm_wait?: number
  agent_name?: string
  task_ref?: string
  /** 终端执行的结论摘要：终端里的 claude 经 MCP pmw_finish_run 回写，或手动「标记结束」时填 */
  summary?: string
  workdir: string
  allow_writes: boolean
  extra_prompt: string
  exit_code?: number
  /** 失败原因；done 时可能是一句保留意见 */
  error?: string
  session_id: string
  started_at: string
  ended_at?: string
  events: RunEvent[]
  /** 原型模拟流式：还没吐出来的事件 */
  pending: RunEvent[]
}

const SS_A = '7c41e2a9-3b0d-4f6e-9a12-5d8e0c6b1f37'
const SS_B = 'b18f5d03-92c4-4a7e-8d61-0f3a9e27c5b4'
const SS_C = 'e5a90c17-6d2b-48f3-b0e4-71c8d39a2f60'
const SS_D = '42d7b8e6-1f05-4c9a-a3d2-9b6e0f71c834'
const PMW = '/Volumes/project/example/pm-workspace'
const YC = '/Volumes/project/clients/yuanchuan-permission'
const cc = (task_id: string, session_id: string, m: number, kind: ProgressKind, text: string, x: Partial<TaskProgress> = {}): TaskProgress => ({
  id: `pg_${task_id}_${m}`, task_id, kind, text, commits: [], files: [], actor_name: 'claude-code', session_id, source: 'agent', at: minsAgo(m), ...x,
})

export const seedProgress: TaskProgress[] = [
  // T-015：第一次提交验收被退回（前端还是 300 秒报超时），换了一个会话接着做
  cc('tk_dev1', SS_A, 300, 'claim', '领取了任务', { status: 'doing' }),
  cc('tk_dev1', SS_A, 290, 'note', '定位到原因：runExport 先把审计日志全读进内存再写 CSV，12 万行要 340 秒。改成每 5000 行一批，边读边写。', { files: ['internal/export/runner.go'] }),
  cc('tk_dev1', SS_A, 262, 'note', '改完。本地 12 万行导出 41 秒，内存峰值 96MB；补了分批写的单元用例。', { commits: ['e3b91c4'], files: ['internal/export/runner.go', 'internal/export/runner_test.go'] }),
  cc('tk_dev1', SS_A, 250, 'review', '提交验收：服务端改成分批写文件，12 万行 41 秒、内存峰值 96MB；go test ./internal/export/... 通过。', { commits: ['e3b91c4'], status: 'review' }),
  { id: 'pg_tk_dev1_180', task_id: 'tk_dev1', kind: 'note', text: '退回：服务端快了，但界面还是固定等 300 秒就报「导出超时」，验收标准第 3 条没过。', commits: [], files: [], status: 'todo', actor_name: '我', source: 'ui', at: minsAgo(180) },
  cc('tk_dev1', SS_B, 150, 'claim', '领取了任务，接着处理退回意见', { status: 'doing' }),
  cc('tk_dev1', SS_B, 125, 'note', '前端不再写死 300 秒：导出任务完成前一直按进度轮询，超时改成看服务端返回的状态。', { commits: ['5a07d2f'], files: ['web/src/pages/Export.tsx'] }),
  cc('tk_dev1', SS_B, 100, 'review', '提交验收：\n- 服务端分批写文件：12 万行 41 秒，内存峰值 96MB\n- 界面按导出任务的状态轮询，不再固定 300 秒报超时\n- go test ./internal/export/... 通过，npm run build 通过\n性能记录在 docs/export-bench.md。', { commits: ['e3b91c4', '5a07d2f'], files: ['docs/export-bench.md'], status: 'review' }),
  // T-016：做到一半
  cc('tk_dev2', SS_C, 40, 'claim', '领取了任务', { status: 'doing' }),
  cc('tk_dev2', SS_C, 25, 'note', '连接器、模型服务商两个设置页改完了，错误跟在字段下面；还剩 Agent 设置页。', { commits: ['9c2e7a1'], files: ['web/src/pages/Connectors.tsx', 'web/src/pages/Providers.tsx'] }),
  // T-017：一次做完，等验收
  cc('tk_dev3', SS_D, 200, 'claim', '领取了任务', { status: 'doing' }),
  cc('tk_dev3', SS_D, 130, 'note', '权限缓存的 key 加上部门版本号；改角色时只给受影响的部门加版本号，其他部门的缓存不动。', { files: ['server/authz/cache.go'] }),
  cc('tk_dev3', SS_D, 50, 'review', '提交验收：\n- 改角色后 1 分钟内生效（实测 3 秒）\n- 其他部门缓存命中率不变\n- 500 并发下 p99 14ms，截图在产出物里', { commits: ['f81d3b0'], files: ['server/authz/cache.go', 'server/authz/cache_test.go'], status: 'review' }),
]

export const seedArtifacts: TaskArtifact[] = [
  { id: 'af_d1', task_id: 'tk_dev1', note: `[commit] sha=e3b91c4 branch=fix/export-batch repo=${PMW} 导出分批写文件`, path: PMW, source: 'mcp', at: minsAgo(262) },
  { id: 'af_d2', task_id: 'tk_dev1', note: `[commit] sha=5a07d2f branch=fix/export-batch repo=${PMW} 界面按任务状态轮询`, path: PMW, source: 'mcp', at: minsAgo(125) },
  { id: 'af_d3', task_id: 'tk_dev1', note: '[branch] branch=fix/export-batch', path: PMW, source: 'mcp', at: minsAgo(262) },
  { id: 'af_d4', task_id: 'tk_dev1', note: '[pr] branch=fix/export-batch 导出超时修复', url: 'https://git.example.com/pm-workspace/pull/42', source: 'mcp', at: minsAgo(100) },
  { id: 'af_d5', task_id: 'tk_dev1', note: '性能记录', path: `${PMW}/docs/export-bench.md`, rel_path: 'docs/export-bench.md', source: 'run', at: minsAgo(100) },
  { id: 'af_d6', task_id: 'tk_dev2', note: `[branch] branch=feat/inline-errors repo=${PMW}`, path: PMW, source: 'mcp', at: minsAgo(25) },
  { id: 'af_d7', task_id: 'tk_dev2', note: `[commit] sha=9c2e7a1 branch=feat/inline-errors repo=${PMW} 连接器和服务商页改成行内提示`, path: PMW, source: 'mcp', at: minsAgo(25) },
  { id: 'af_d8', task_id: 'tk_dev3', note: `[commit] sha=f81d3b0 branch=feat/dept-cache repo=${YC} 按部门版本号失效`, path: YC, source: 'mcp', at: minsAgo(55) },
  { id: 'af_d9', task_id: 'tk_dev3', note: 'p99 截图', path: `${YC}/docs/shots/cache-p99.png`, rel_path: 'docs/shots/cache-p99.png', source: 'run', at: minsAgo(52) },
]

const ev = {
  d: (text: string): RunEvent => ({ type: 'delta', text }),
  t: (id: string, name: string, detail: string): RunEvent => ({ type: 'tool', id, name, detail }),
  r: (id: string, ok = true, error?: string): RunEvent => ({ type: 'tool_result', id, ok, error }),
}
export const seedRuns: TaskRun[] = [
  {
    id: 'run_d1', task_id: 'tk_dev1', status: 'done', workdir: PMW, allow_writes: false, extra_prompt: '先别改，看看超时卡在哪', exit_code: 0,
    error: '这次执行有 2 个工具调用被权限策略拒绝（Edit、Bash），其余步骤已执行，但被挡下的部分可能没有生效。被拒的命令：go test ./internal/export/...。本次为只读执行；要让它真正改文件，请在发起时勾选「允许修改文件」（选一个写入档位）。本次档位「只读」没放行这些调用；建议放行：`Bash(go test:*)`。到「设置 / 执行权限」把它们加进自定义白名单，发起时选「自定义白名单」档位。', session_id: SS_A, started_at: minsAgo(310), ended_at: minsAgo(306), pending: [],
    events: [ev.d('先读任务和验收标准。\n'), ev.t('t1', 'pmw_get_object', 'T-015'), ev.r('t1'), ev.t('t2', 'Grep', 'runExport'), ev.r('t2'), ev.t('t3', 'Read', 'internal/export/runner.go'), ev.r('t3'),
      ev.t('t4', 'Edit', 'internal/export/runner.go'), ev.r('t4', false, '只读运行，没有写入权限'),
      ev.t('t5', 'Bash', 'go test ./internal/export/...'), ev.r('t5', false, 'This command requires approval'),
      ev.d('卡在 runExport 一次读完所有行。打算：\n1. 改成每 5000 行一批读\n2. 边读边写 CSV\n勾选「允许写入」再执行一次就会真的改。')],
  },
  {
    id: 'run_d2', task_id: 'tk_dev1', status: 'done', workdir: PMW, allow_writes: true, extra_prompt: '', exit_code: 0,
    session_id: SS_A, started_at: minsAgo(300), ended_at: minsAgo(250), pending: [],
    events: [ev.t('t1', 'pmw_claim_task', 'T-015'), ev.r('t1'), ev.t('t2', 'Edit', 'internal/export/runner.go'), ev.r('t2'), ev.t('t3', 'Bash', 'go test ./internal/export/...'), ev.r('t3'),
      ev.t('t4', 'pmw_submit_review', 'T-015'), ev.r('t4'), ev.d('改完了，go test 通过，已提交验收。')],
  },
  {
    id: 'run_d3', task_id: 'tk_dev2', status: 'failed', workdir: `${PMW}/web`, allow_writes: true, extra_prompt: '', exit_code: 1,
    error: 'npm run build 失败：Providers.tsx 类型错误', session_id: SS_C, started_at: minsAgo(38), ended_at: minsAgo(33), pending: [],
    events: [ev.t('t1', 'Read', 'web/src/pages/Providers.tsx'), ev.r('t1', false, '文件被另一个进程锁住'), ev.t('t2', 'Bash', 'npm run build'), ev.r('t2', false, 'Providers.tsx(42,7): Property \'field\' does not exist')],
  },
  {
    id: 'run_d4', task_id: 'tk_dev3', status: 'done', workdir: `${YC}/server`, allow_writes: true, extra_prompt: '并发按 500 跑', exit_code: 0,
    session_id: SS_D, started_at: minsAgo(205), ended_at: minsAgo(50), pending: [],
    events: [ev.t('t1', 'pmw_claim_task', 'T-017'), ev.r('t1'), ev.t('t2', 'Edit', 'server/authz/cache.go'), ev.r('t2'), ev.t('t3', 'Bash', 'go test ./authz/...'), ev.r('t3'),
      ev.t('t4', 'Bash', 'hey -c 500 -n 50000 /authz/check'), ev.r('t4'), ev.d('p99 14ms，截图已登记。已提交验收。')],
  },
  {
    // 切换到终端执行的（SPEC-tasks-5.30）：没有流式事件，结论是终端里的 claude 经 MCP pmw_finish_run 回写的
    id: 'run_d5', task_id: 'tk_dev2', mode: 'terminal', status: 'done', workdir: `${PMW}/web`, allow_writes: false, extra_prompt: '先只改设置页',
    summary: '设置页三处保存失败改成字段下方提示，顶部横幅去掉；npm run build 通过。还剩连接器页同样的横幅没改。',
    session_id: SS_C, started_at: minsAgo(30), ended_at: minsAgo(12), pending: [], events: [],
  },
]

/**
 * 「交给工作台 Agent」模拟执行的过程（SPEC-tasks-6.20）：读任务、记进展、提出改状态（要确认，停下等），
 * 确认或拒绝之后的事件由 agentAfterDecision 接上。只读角色不提写操作，直接给结论
 */
export function agentRunScript(task: Task, readOnly: boolean, extra: string, resume: boolean): RunEvent[] {
  return [
    ...(resume ? [ev.d('接着上次的执行继续。\n')] : []),
    ...(extra.trim() ? [ev.d(`按补充说明：${extra.trim()}\n`)] : []),
    ev.d('先读任务和关联对象。\n'), ev.t('a1', 'get_object', task.ref), { type: 'tool_result', id: 'a1', ok: true, summary: `读了 ${task.ref} ${task.title}` },
    ...(readOnly
      ? [ev.d(`只读角色：这次只给结论，不改任何东西。\n结论：${task.title} 的验收标准逐条看过，建议先拆成两条子任务再动手。`)]
      : [
        ev.t('a2', 'append_progress', task.ref), { type: 'tool_result' as const, id: 'a2', ok: true, summary: `已给 ${task.ref} 记了一条进展` },
        ev.t('a3', 'create_object', `子任务：${task.title.slice(0, 10)}（拆出来的第一步）`), { type: 'tool_result' as const, id: 'a3', ok: true, summary: `已创建 ${task.ref} 的子任务` },
        ev.d('拆好了子任务，打算把这条任务改成待验收。\n'),
        { type: 'confirm' as const, id: 'atc_demo', name: 'update_object', summary: `修改 ${task.ref}（状态改为待验收）`, deadline: '' },
      ]),
  ]
}

/** 确认或拒绝之后 Agent 接着跑的事件 */
export function agentAfterDecision(task: Pick<Task, 'ref'>, approved: boolean, reason: 'user' | 'timeout'): RunEvent[] {
  return [
    { type: 'decision', id: 'atc_demo', approved, reason },
    ...(approved
      ? [ev.t('a4', 'update_object', task.ref), { type: 'tool_result' as const, id: 'a4', ok: true, summary: `已修改 ${task.ref} 的状态` },
        ev.d('结论：读完任务，拆了一条子任务，状态已改为待验收。')]
      : [ev.d(`结论：${reason === 'timeout' ? '等确认超时，按拒绝处理，' : '你拒绝了改状态，'}没有改状态；子任务已经拆好，剩下的等你决定。`)]),
  ]
}

/** 「交给 Claude Code」模拟执行的过程：只读时写文件那一步被权限挡下 */
export function runScript(task: Task, allow: boolean, extra: string, files: string[]): RunEvent[] {
  const f = files[0] ?? 'README.md'
  return [
    ...(extra.trim() ? [ev.d(`按附加说明：${extra.trim()}\n`)] : []),
    ev.d('先读任务和验收标准。\n'), ev.t('t1', 'pmw_get_object', task.ref), ev.r('t1'),
    ...(allow ? [ev.t('t0', 'pmw_claim_task', task.ref), ev.r('t0')] : []),
    ev.d('看一下工作目录里相关的代码。\n'), ev.t('t2', 'Grep', task.title.slice(0, 12)), ev.r('t2'), ev.t('t3', 'Read', f), ev.r('t3'),
    ev.t('t4', 'Edit', f), allow ? ev.r('t4') : ev.r('t4', false, '只读运行，没有写入权限'),
    ...(allow
      ? [ev.t('t5', 'Bash', '运行单元用例'), ev.r('t5'), ev.d('改完了，用例都通过。进展和改动的文件已回写到任务里。')]
      : [ev.d(`只读运行，下面是打算的改法：\n1. 改 ${f}\n2. 补单元用例\n勾选「允许写入」再执行一次就会真的改。`)]),
  ]
}

/** 吐出下一个事件；吐完按工具调用结果定状态 */
export function stepRun(r: TaskRun, at = new Date().toISOString()): TaskRun {
  // 终端执行不归这里推进：结束由终端里的 claude 经 MCP 回写，或手动标记
  if (r.status !== 'running' || r.mode === 'terminal') return r
  const [e, ...rest] = r.pending
  const events = e ? [...r.events, e] : r.events
  // 工作台 Agent 提出要确认的写操作：停下等人确认（SPEC-tasks-5.34），剩下的事件等决定后再接
  if (e?.type === 'confirm') return { ...r, events, pending: rest, status: 'waiting' }
  if (rest.length) return { ...r, events, pending: rest }
  const results = events.filter((x): x is Extract<RunEvent, { type: 'tool_result' }> => x.type === 'tool_result')
  const ok = results.filter((x) => x.ok).length
  const bad = results.length - ok
  if (!ok) return { ...r, events, pending: [], status: 'failed', exit_code: 0, error: '没有一次工具调用成功', ended_at: at }
  return { ...r, events, pending: [], status: 'done', exit_code: 0, error: bad ? `有 ${bad} 次工具调用被权限挡下${r.allow_writes ? '' : '（只读运行）'}，没有改文件` : undefined, ended_at: at }
}
