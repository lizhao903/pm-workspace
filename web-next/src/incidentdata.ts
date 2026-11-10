// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 运行异常：系统运行中出的问题集中记一份，同一个问题按指纹合并，只累加次数
// 能转成研发任务：任务里带上异常详情、上下文，来源标为「异常」，两边互相能跳
import type { Priority } from './taskdata'
import { newId } from './ids'

export type IncidentLevel = 'error' | 'warn'
export type IncidentStatus = 'open' | 'tasked' | 'ignored' | 'resolved'
export const INCIDENT_STATUS: Record<IncidentStatus, { label: string; color: string }> = {
  open: { label: '未处理', color: '#c0352b' },
  tasked: { label: '已转任务', color: '#3d4fd6' },
  ignored: { label: '已忽略', color: '#a19d92' },
  resolved: { label: '已解决', color: '#2f7d43' },
}

export const INCIDENT_MODULES = ['连接器', '模型服务商', 'Webhook', 'SOP', '项目原型', 'Agent', 'Claude Code', 'IM 消息', '交易', '发布', '前端'] as const
export type IncidentModule = (typeof INCIDENT_MODULES)[number]

export interface Incident {
  id: string
  /** 同一个问题的指纹：模块 + 对象 + 错误类型，用来合并 */
  fingerprint: string
  level: IncidentLevel
  module: IncidentModule
  title: string
  message: string
  /** 堆栈或原始报错 */
  stack?: string
  /** 出事时的上下文：哪个连接器、哪次执行、什么输入 */
  context: Record<string, unknown>
  count: number
  first_at: string
  last_at: string
  /** 最近几次发生的时间，详情里画时间线 */
  occurrences: string[]
  status: IncidentStatus
  task_id?: string
  note?: string
}

export type IncidentReport = Pick<Incident, 'fingerprint' | 'level' | 'module' | 'title' | 'message' | 'stack' | 'context'>

/** 记一条：指纹相同就合并（次数 +1、更新最近时间；已解决、已忽略的再次出现会重新打开） */
export function mergeIncident(list: Incident[], r: IncidentReport, at = new Date().toISOString()): Incident[] {
  const i = list.findIndex((x) => x.fingerprint === r.fingerprint)
  if (i < 0) {
    const fresh: Incident = { ...r, id: newId('inc'), count: 1, first_at: at, last_at: at, occurrences: [at], status: 'open' }
    return [fresh, ...list]
  }
  const old = list[i]
  const reopened = old.status === 'resolved' || old.status === 'ignored'
  const next: Incident = {
    ...old, ...r, count: old.count + 1, last_at: at, occurrences: [at, ...old.occurrences].slice(0, 20),
    status: reopened ? 'open' : old.status,
    // 修复任务删了以后又出现：清掉「关联的任务已删除」，巡检重新算它
    note: reopened ? `${old.status === 'resolved' ? '标为已解决' : '忽略'}后又出现了` : old.note === '关联的任务已删除' ? undefined : old.note,
  }
  return [next, ...list.filter((_, j) => j !== i)]
}

export const levelPriority = (x: Incident): Priority => (x.level === 'error' ? (x.count >= 5 ? 'P0' : 'P1') : 'P2')

/** 转任务时的描述：一眼能看出是什么问题、在哪、多频繁、怎么复现 */
export function taskDesc(x: Incident): string {
  const ctx = Object.entries(x.context).map(([k, v]) => `- ${k}：${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n')
  return [
    `【运行异常】${x.module} · ${x.level === 'error' ? '错误' : '警告'}`,
    `现象：${x.message}`,
    `频率：共 ${x.count} 次，首次 ${new Date(x.first_at).toLocaleString('zh-CN')}，最近 ${new Date(x.last_at).toLocaleString('zh-CN')}`,
    ctx && `上下文：\n${ctx}`,
    x.stack && `报错：\n${x.stack}`,
    '期望：系统能自己处理这种情况，或者给出明确的修复指引。',
  ].filter(Boolean).join('\n\n')
}

/** 巡检（定时任务「运行异常巡检」）建任务时的描述：taskDesc 再加怎么复现、改完怎么验收，交给 Claude Code 修（INC-01） */
export function sweepTaskDesc(x: Incident): string {
  const page = typeof x.context['页面'] === 'string' ? x.context['页面'] : ''
  return [
    taskDesc(x),
    `怎么复现：${page ? `打开 ${page}，` : ''}按上面的上下文重做一遍出事时的操作，看能不能再报出同样的错误；复现不了先看报错里的文件和行号。`,
    '改完怎么验收：同样的操作不再报错；补一条能盯住这个问题的测试；回到「设置 / 运行异常」把这条标为已解决，之后再出现会自动重新打开。',
  ].join('\n\n')
}

export type SweepConfig = { min_level: IncidentLevel; min_count: number }

/** 巡检够格的：未处理、还没有任务、级别够、次数够 */
const sweepEligible = (x: Incident, c: SweepConfig) => x.status === 'open' && !x.task_id
  && (c.min_level === 'warn' || x.level === 'error') && x.count >= c.min_count

/**
 * 够格但留给用户自己处理、不自动建的：修复任务被删过的（删任务就是先不修，再出现时 note 清掉才重新算）；
 * Claude Code 执行失败的（指纹 claude: 开头，修复任务本身又失败，自动再建会一层套一层）
 */
export const sweepHeld = (x: Incident) => x.note === '关联的任务已删除' || x.fingerprint.startsWith('claude:')

/** 巡检要建任务的：够格且不留给用户；同一条不会重复建 */
export const sweepPick = (list: Incident[], c: SweepConfig) => list.filter((x) => sweepEligible(x, c) && !sweepHeld(x))
export const sweepHeldCount = (list: Incident[], c: SweepConfig) => list.filter((x) => sweepEligible(x, c) && sweepHeld(x)).length

/** 巡检建出来的任务带这个标签，交给 Claude Code 修 */
export const SWEEP_TAG = 'claude-code'

const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString()
const times = (...m: number[]) => m.map(minsAgo)

export const seedIncidents: Incident[] = [
  {
    id: 'inc1', fingerprint: 'conn:cn_wechat:auth', level: 'error', module: '连接器', title: '企业微信连接器凭证失效',
    message: '应用 Secret 已失效（errcode 40001），同步中断，这之后的消息没有收进来', stack: 'WeComError: invalid credential, access_token is invalid or not latest (errcode 40001)\n    at refreshToken (connectors/wecom.ts:88)\n    at sync (connectors/wecom.ts:142)',
    context: { 连接器: '企业微信', 最后同步: '3 小时前', 影响: 'IM 消息收不进来，回复发不出去' },
    count: 18, first_at: minsAgo(190), last_at: minsAgo(10), occurrences: times(10, 20, 30, 40, 50, 60, 70, 80), status: 'open',
  },
  {
    id: 'inc2', fingerprint: 'provider:pv_openai:401', level: 'error', module: '模型服务商', title: 'OpenAI 鉴权失败',
    message: '401 Unauthorized：API Key 已失效或被撤销，用到 GPT-5 的场景退回了默认模型',
    context: { 服务商: 'OpenAI', 受影响模型: 'gpt-5', 退回到: 'Claude Sonnet 5.5' },
    count: 6, first_at: minsAgo(60 * 3), last_at: minsAgo(25), occurrences: times(25, 55, 85, 115, 145, 175), status: 'open',
  },
  {
    id: 'inc3', fingerprint: 'webhook:wh_form:title', level: 'warn', module: 'Webhook', title: '官网需求表单：标题字段取不到',
    message: '推送里没有 answers.need，没建成任务。对方表单可能改了字段名',
    context: { Webhook: '官网需求表单', 映射: 'answers.need', 推送样例: { form: '需求收集', answers: { company: '远川科技', detail: '希望审批能接企业微信' } } },
    count: 1, first_at: minsAgo(120), last_at: minsAgo(120), occurrences: times(120), status: 'tasked', task_id: 'tk_inc_seed',
  },
  {
    id: 'inc4', fingerprint: 'sop:sop_feedback:send', level: 'error', module: 'SOP', title: '「客户反馈转需求」发送回复失败',
    message: '微信连接器凭证已过期（401），流程停在「发送回复」',
    context: { SOP: '客户反馈转需求', 步骤: '发送回复', 执行: '客户反馈转需求 · 许知行' },
    count: 2, first_at: minsAgo(95), last_at: minsAgo(60), occurrences: times(60, 95), status: 'open',
  },
  {
    id: 'inc5', fingerprint: 'front:ResizeObserver', level: 'warn', module: '前端', title: 'ResizeObserver loop completed with undelivered notifications',
    message: '布局抖动时浏览器报的警告，不影响使用', stack: 'ResizeObserver loop completed with undelivered notifications.',
    context: { 页面: 'SOP 编排画布' },
    count: 3, first_at: minsAgo(60 * 24), last_at: minsAgo(60 * 5), occurrences: times(300, 900, 1440), status: 'ignored',
  },
  // 种子里本来就是 error 的连接器和交易账户，各记一条（指纹和运行时上报的一致，再出现会合并）
  {
    id: 'inc6', fingerprint: 'conn:cn_douyin:auth', level: 'error', module: '连接器', title: '抖音账号连接失败',
    message: '授权已过期（access_token expired），拉不到作品数据，也发不了新视频', stack: 'DouyinOpenError: access_token expired (error_code 2190008)\n    at refreshToken (connectors/douyin.ts:61)',
    context: { 连接器: '抖音账号', 工具: 'douyin', 认证方式: 'oauth2' },
    count: 30, first_at: minsAgo(60 * 30), last_at: minsAgo(60), occurrences: times(60, 120, 180, 240, 300, 360), status: 'open',
  },
  {
    id: 'inc7', fingerprint: 'conn:cn_notion:auth', level: 'error', module: '连接器', title: 'Notion 产品空间连接失败',
    message: 'OAuth 令牌已过期，周报助手挂的 Notion 工具调用都会失败', stack: 'APIResponseError: API token is invalid. (401 unauthorized)',
    context: { 连接器: 'Notion 产品空间', 工具: 'notion', 认证方式: 'oauth2', 受影响: '周报助手' },
    count: 3, first_at: minsAgo(60 * 5), last_at: minsAgo(60 * 2), occurrences: times(120, 200, 300), status: 'open',
  },
  {
    id: 'inc8', fingerprint: 'trade:交易账户异常', level: 'warn', module: '交易', title: '交易账户异常',
    message: 'OKX 合约：API Key 已过期，请到 OKX 重新创建并更新；余额和持仓停在 4 小时前，对账也暂停了',
    context: {}, count: 1, first_at: minsAgo(240), last_at: minsAgo(240), occurrences: times(240), status: 'open',
  },
  // 实盘账户对账发现差异（TRD-08），指纹和交易页「重新对账」上报的一致
  {
    id: 'inc9', fingerprint: 'trade:交易对账异常', level: 'warn', module: '交易', title: '交易对账异常',
    message: 'Binance 主账户：ETH/USDT 持仓本地 6.2，交易所 6.1938，差 0.0062（买入手续费按 ETH 扣）',
    context: { 账户: 'Binance 主账户', 对账项: 3, 差异: 1 }, count: 2, first_at: minsAgo(72), last_at: minsAgo(12), occurrences: times(12, 72), status: 'open',
  },
  // 第 1 集抖音那条定时发布到点失败（VID-06），指纹和发布失败时上报的一致：publish:<发布记录 id>
  {
    id: 'inc10', fingerprint: 'publish:pb3', level: 'error', module: '发布', title: '抖音发布失败：今日待办一页清',
    message: '封面比例不符合要求：抖音要 3:4 或 9:16，这次用的是 1:1', context: { 视频: '第 1 集：今日待办一页清', 平台: '抖音', 账号: '一人之下', 定时任务: '定时发布：抖音「今日待办一页清」' },
    count: 1, first_at: minsAgo(60 * 24 * 5), last_at: minsAgo(60 * 24 * 5), occurrences: times(60 * 24 * 5), status: 'open',
  },
]
