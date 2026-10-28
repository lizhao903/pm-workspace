import { newId } from './ids'

// Agent：工作助手。每个 Agent 有自己的指令、模型、能用的工具（以及每个工具的权限）、能读的内容和触发方式
// 权限三档：
//   关闭        用不了
//   需确认      Agent 只提出要做什么，人点确认才真的执行（写操作默认这一档）
//   自动        直接执行，执行记录里留痕
// 读操作只有「关闭 / 自动」两档

export type AbilityMode = 'off' | 'confirm' | 'auto'

export interface Ability { key: string; label: string; group: string; write: boolean; desc: string }

export const ABILITIES: Ability[] = [
  { key: 'read_messages', label: '读 IM 消息', group: 'IM 消息', write: false, desc: '查看各渠道收到的消息' },
  { key: 'reply_message', label: '回复 IM 消息', group: 'IM 消息', write: true, desc: '通过连接器发出回复' },
  { key: 'read_contacts', label: '查联系人', group: '联系人', write: false, desc: '按姓名、公司、IM 账号查人' },
  { key: 'write_contacts', label: '新建 / 修改联系人', group: '联系人', write: true, desc: '' },
  { key: 'read_tasks', label: '查任务', group: '任务', write: false, desc: '按状态、负责人、截止时间查任务' },
  { key: 'write_tasks', label: '新建 / 更新任务', group: '任务', write: true, desc: '' },
  { key: 'read_content', label: '读文档', group: '文档', write: false, desc: '只能读下面「可读文档」里勾选的范围' },
  { key: 'write_content', label: '写文档', group: '文档', write: true, desc: '新建笔记、摘录' },
  { key: 'run_sop', label: '发起 SOP', group: 'SOP', write: true, desc: '按标准流程执行，流程里的人工检查点照常停下' },
]

export type TriggerKind = 'manual' | 'im' | 'schedule' | 'task'
export const TRIGGER_KIND: Record<TriggerKind, string> = { manual: '手动对话', im: '收到 IM 消息', schedule: '定时', task: '任务分配给它' }

export interface AgentTrigger { kind: TriggerKind; detail: string }

export interface Agent {
  id: string
  name: string
  desc: string
  color: string
  model: string
  instructions: string
  abilities: Record<string, AbilityMode>
  /** 头像：文字（取名字第一个字或自己填）、内置图标、上传的图片（data URL） */
  avatar: AgentAvatarConf
  /** 挂载的技能 id */
  skills: string[]
  /** 挂载的 MCP / 连接器 id；工具权限仍按 abilities 里 conn:<连接器>:<工具> 管 */
  mcps: string[]
  /** 挂载的知识库 id */
  kbs: string[]
  triggers: AgentTrigger[]
  enabled: boolean
  created_at: string
}

export interface ToolCall { tool: string; input: Record<string, unknown>; output?: unknown; state: 'done' | 'pending' | 'confirmed' | 'rejected' }

export interface AgentRun {
  id: string
  agent_id: string
  at: string
  trigger: string
  summary: string
  calls: ToolCall[]
  status: 'done' | 'waiting' | 'rejected' | 'failed'
}

export const AGENT_COLORS = ['#3d4fd6', '#7a4fd6', '#0f8a8a', '#b0570b', '#2f7d43', '#c0352b', '#e8590c', '#23221e']

export interface AgentAvatarConf { kind: 'text' | 'icon' | 'image'; value: string }
export const AVATAR_ICONS = ['robot', 'chat', 'doc', 'chart', 'flow', 'search', 'mail', 'calendar', 'shield', 'spark'] as const

/* ---------- 技能：一段可复用的做事方法（说明 + 用到的工具），挂到 Agent 上就会按它做 ---------- */

export interface Skill { id: string; name: string; desc: string; source: '内置' | '自定义'; uses: string[]; instructions: string; when?: string }

export const SKILLS: Skill[] = [
  { id: 'sk_video', name: '网页演示做视频', desc: 'web-video-presentation：文稿做成点击驱动的网页演示，可合成口播、录屏成 mp4', source: '内置', uses: ['写文档', '语音合成', '终端'],
    instructions: '按 内容编写、规划检查、网页开发、第一章验收、其余章节、音频、录屏、分发包 推进；4 个检查点必须停下等人确认；画面比例在规划检查时定死。' },
  { id: 'sk_video_review', name: '视频数据复盘', desc: '对比各平台的播放、互动和封面表现，给下一集的建议', source: '内置', uses: ['B 站', 'YouTube', '抖音'],
    instructions: '按平台列核心数据，指出封面和标题的差异，给出续集选题和发布时间建议。' },
  { id: 'sk_premarket', name: '盘前简报', desc: '开盘前汇总自选标的的隔夜变动、要闻和今天的关键价位', source: '内置', uses: ['Binance 行情', '富途 OpenD', '网页搜索'],
    instructions: '按市场分组，每个标的一行：隔夜涨跌、要闻一句、支撑压力位；最后列今天触发概率高的提醒。' },
  { id: 'sk_trade_review', name: '交易复盘', desc: '按笔复盘当日成交，归因到策略、手动和风控拦截', source: '内置', uses: ['查持仓', '查委托'],
    instructions: '盈亏按策略和手动分开；每笔亏损写清入场理由和出场原因；风控拦截单列；结论不超过 5 条。' },
  { id: 'sk_weekly', name: '写周报', desc: '按项目归类本周完成、进行中、下周计划', source: '内置', uses: ['查任务', '写文档'], instructions: '已完成按项目归类，进行中写清卡点，下周计划挑优先级最高的 5 条。' },
  { id: 'sk_triage', name: '消息分诊', desc: '判断一条消息要不要跟进、紧急程度', source: '内置', uses: ['读 IM 消息', '查联系人'], instructions: '有明确诉求、问题或截止时间的需要跟进；寒暄和群通知不需要。' },
  { id: 'sk_reply', name: '客户回复话术', desc: '按对方语气起草回复，不承诺具体上线时间', source: '内置', uses: ['回复 IM 消息'], instructions: '先确认收到，再说明下一步和时间点；涉及排期只说「评估后同步」。' },
  { id: 'sk_breakdown', name: '需求拆解', desc: '把一句诉求拆成用户故事和验收标准', source: '内置', uses: ['新建 / 更新任务'], instructions: '每条故事写清角色、动作、价值，附 2 到 4 条可验证的验收标准。' },
  { id: 'sk_minutes', name: '会议纪要整理', desc: '从转写稿提炼结论、待办和遗留问题', source: '内置', uses: ['写文档'], instructions: '结论单列；待办写负责人和截止时间；没有定论的放进遗留问题。' },
  { id: 'sk_competitor', name: '竞品分析', desc: '按功能、价格、目标用户对比几家竞品', source: '内置', uses: ['网页搜索'], instructions: '每家一行，列功能差异、价格区间、目标用户和最近的更新。' },
  { id: 'sk_sql', name: '业务数据查询', desc: '把问题翻成只读 SQL，结果用表格说明', source: '自定义', uses: ['PostgreSQL'], instructions: '只写 SELECT；先看表结构再写；结果超过 20 行只给汇总。' },
]

/* ---------- 知识库：一组可检索的资料，来源是文档分类或本地目录 ---------- */

/** 知识库。篇数、索引状态由 kbdata 里的文档列表算出，docs、status 只留着兼容旧调用 */
export interface KnowledgeBase { id: string; name: string; desc: string; sources: string[]; docs?: number; updated_at: string; status?: 'ready' | 'indexing' | 'stale' }

/* ---------- 会话与产出 ---------- */

export interface ChatMsg { id: number; role: 'user' | 'agent'; text: string; calls?: ToolCall[]; at?: string }
export interface Session { id: string; agent_id: string; project_id?: string; title: string; created_at: string; updated_at: string; messages: ChatMsg[] }

/** Agent 真正落到数据上的东西：建的任务、写的文档、发的回复、发起的流程 */
export type OutputKind = 'task' | 'doc' | 'reply' | 'sop' | 'other'
export interface AgentOutput {
  id: string
  agent_id: string
  kind: OutputKind
  title: string
  /** 能打开的目标：任务 id、文档 id、消息 id */
  target?: string
  at: string
  origin: { type: 'session' | 'run'; id: string }
}
export const OUTPUT_KIND: Record<OutputKind, string> = { task: '任务', doc: '文档', reply: 'IM 回复', sop: 'SOP 执行', other: '其他' }

const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString()
const allOff = () => Object.fromEntries(ABILITIES.map((a) => [a.key, 'off' as AbilityMode]))

export function newAgent(): Agent {
  return {
    id: newId('ag'), name: '', desc: '', color: AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)],
    model: 'claude-sonnet-5-5', instructions: '', abilities: { ...allOff(), read_tasks: 'auto', read_contacts: 'auto' },
    avatar: { kind: 'text', value: '' }, skills: [], mcps: [], kbs: [],
    triggers: [{ kind: 'manual', detail: '' }], enabled: true, created_at: new Date().toISOString(),
  }
}

export const seedAgents: Agent[] = [
  {
    id: 'ag_triage', name: '消息分诊助手', desc: '新 IM 消息进来先看一遍：认出是谁、判断要不要转任务、起草回复', color: '#0f8a8a',
    model: 'claude-haiku-5-5',
    instructions: '你是产品经理的消息分诊助手。\n1. 先用联系人确认发消息的人是谁、哪家公司。\n2. 判断消息是否需要跟进：有明确诉求、问题或截止时间的需要跟进，寒暄和群通知不需要。\n3. 需要跟进的，建一条任务，标题用一句话概括诉求，优先级按紧急程度给。\n4. 起草一条回复，语气和对方保持一致，不承诺具体上线时间。',
    abilities: { ...allOff(), read_messages: 'auto', read_contacts: 'auto', read_tasks: 'auto', write_tasks: 'confirm', reply_message: 'confirm', 'conn:cn_github:list_issues': 'auto', 'conn:cn_github:get_issue': 'auto', 'conn:cn_github:create_issue': 'confirm' },
    avatar: { kind: 'icon', value: 'chat' }, skills: ['sk_triage', 'sk_reply'], mcps: ['cn_github'], kbs: ['kb_feedback'], triggers: [{ kind: 'im', detail: '飞书、微信、Slack 私聊' }, { kind: 'manual', detail: '' }], enabled: true, created_at: minsAgo(60 * 24 * 14),
  },
  {
    id: 'ag_weekly', name: '周报助手', desc: '每周五下午汇总这周完成和进行中的任务，写成周报草稿', color: '#7a4fd6',
    model: 'claude-sonnet-5-5',
    instructions: '每周五 16:00 汇总本周任务：已完成的按项目归类，进行中的写清卡在哪，下周计划从未开始的任务里挑优先级最高的 5 条。写成「文档 > 笔记」里的一篇周报草稿，不要直接发出去。',
    abilities: { ...allOff(), read_tasks: 'auto', read_content: 'auto', write_content: 'confirm', 'conn:cn_notion:search': 'auto', 'conn:cn_notion:get_page': 'auto', 'conn:cn_notion:create_page': 'confirm' },
    avatar: { kind: 'icon', value: 'doc' }, skills: ['sk_weekly', 'sk_minutes'], mcps: ['cn_notion'], kbs: ['kb_product'], triggers: [{ kind: 'schedule', detail: '每周五 16:00' }, { kind: 'manual', detail: '' }], enabled: true, created_at: minsAgo(60 * 24 * 30),
  },
  {
    id: 'ag_sop', name: '流程执行助手', desc: '按描述挑一个合适的 SOP 发起执行，帮忙填好输入', color: '#b0570b',
    model: 'claude-opus-5-5',
    instructions: '用户描述一件事时，从已有的 SOP 里挑最合适的一个，把用户给的信息填进 SOP 的输入字段，然后发起执行。挑不到合适的就说明原因，不要硬套。',
    abilities: { ...allOff(), read_messages: 'auto', read_contacts: 'auto', run_sop: 'confirm' },
    avatar: { kind: 'icon', value: 'flow' }, skills: [], mcps: [], kbs: [], triggers: [{ kind: 'manual', detail: '' }, { kind: 'task', detail: '' }], enabled: false, created_at: minsAgo(60 * 24 * 3),
  },
]

export const seedAgentRuns: AgentRun[] = [
  {
    id: 'ar1', agent_id: 'ag_triage', at: minsAgo(94), trigger: '收到飞书消息 · 梁晚晴', status: 'waiting',
    summary: '认出是远川科技的采购经理，问试点账号开通了没有，财务部明天要先试审批流。建议建一条 P1 任务并回复，等你确认',
    calls: [
      { tool: 'read_messages', input: { id: 'msg_013' }, output: { kind: '客户询问', follow_up: true }, state: 'done' },
      { tool: 'read_contacts', input: { im: 'lark:ou_liangwq' }, output: { name: '梁晚晴', company: '远川科技', title: '采购经理' }, state: 'done' },
      { tool: 'write_tasks', input: { title: '给远川财务部开通试点账号', priority: 'P1', due: '明天' }, state: 'pending' },
      { tool: 'reply_message', input: { channel: 'lark', to: '梁晚晴', text: '收到，试点账号今天开好，开通后把登录方式发到群里。' }, state: 'pending' },
    ],
  },
  {
    id: 'ar2', agent_id: 'ag_triage', at: minsAgo(70), trigger: '收到 Telegram 消息 · Daily digest', status: 'done',
    summary: '群通知类消息，不需要跟进，没有建任务',
    calls: [{ tool: 'read_messages', input: { id: 'msg_011' }, output: { kind: '群通知', follow_up: false }, state: 'done' }],
  },
  {
    id: 'ar3', agent_id: 'ag_weekly', at: minsAgo(60 * 24 * 5), trigger: '定时 · 每周五 16:00', status: 'done',
    summary: '汇总了 9 条任务，写成周报草稿「第 43 周周报」，你确认后存进了文档',
    calls: [
      { tool: 'read_tasks', input: { updated_after: '本周一' }, output: { done: 5, doing: 3, todo: 1 }, state: 'done' },
      { tool: 'write_content', input: { category: 'note', title: '第 43 周周报' }, output: { content_id: 'dc_w43' }, state: 'confirmed' },
    ],
  },
  {
    id: 'ar4', agent_id: 'ag_triage', at: minsAgo(60 * 26), trigger: '收到微信消息 · 唐一苇', status: 'rejected',
    summary: '建议回复确认续费报价，你拒绝了回复，改为自己处理',
    calls: [{ tool: 'reply_message', input: { channel: 'wechat', to: '唐一苇', text: '李总您好，报价单收到了，我这边确认后回复您。' }, state: 'rejected' }],
  },
]

export const seedKBs: KnowledgeBase[] = [
  { id: 'kb_product', name: '产品文档库', desc: 'PRD、方案对比、会议纪要', sources: ['doc', 'meeting'], updated_at: minsAgo(40) },
  { id: 'kb_feedback', name: '客户反馈库', desc: '从 IM 摘出来的客户原话', sources: ['clip'], updated_at: minsAgo(60 * 3) },
  { id: 'kb_notes', name: '个人笔记', desc: '工作日志和想法', sources: ['note'], updated_at: minsAgo(60 * 20) },
]

export const seedSessions: Session[] = [
  {
    id: 'ss1', agent_id: 'ag_triage', project_id: 'pj_perm', title: '今天谁找我了', created_at: minsAgo(28), updated_at: minsAgo(24),
    messages: [
      { id: 1, role: 'user', text: '今天谁找我了？有要马上处理的吗', at: minsAgo(28) },
      { id: 2, role: 'agent', at: minsAgo(28), text: '有 9 条消息待处理，来自许知行、梁晚晴、Kevin Wu 等。最急的是许知行问月底演示能不能带上按部门自定义角色，你已经把它转成了任务 T-010。',
        calls: [{ tool: 'read_messages', input: { status: 'pending' }, output: { total: 9 }, state: 'done' }] },
      { id: 3, role: 'user', text: '再建一条任务：确认演示环境能不能打开自定义角色', at: minsAgo(24) },
      { id: 4, role: 'agent', at: minsAgo(24), text: '我准备建一条任务「确认演示环境能不能打开自定义角色」，确认后执行。',
        calls: [{ tool: 'write_tasks', input: { title: '确认演示环境能不能打开自定义角色', priority: 'P2', assignee: '我' }, output: { ref: 'T-014' }, state: 'confirmed' }] },
    ],
  },
  {
    id: 'ss2', agent_id: 'ag_weekly', title: '第 43 周周报', created_at: minsAgo(60 * 24 * 5 - 20), updated_at: minsAgo(60 * 24 * 5 - 30),
    messages: [
      { id: 1, role: 'user', text: '定时写的那篇周报按项目重新分一下组', at: minsAgo(60 * 24 * 5 - 20) },
      { id: 2, role: 'agent', at: minsAgo(60 * 24 * 5 - 30), text: '按项目重写好了，存进「文档 > 笔记」前请你确认。', calls: [{ tool: 'write_content', input: { category: 'note', title: '第 43 周周报（按项目重写）' }, output: { content_id: 'dc_w43r' }, state: 'confirmed' }] },
    ],
  },
]

export const seedOutputs: AgentOutput[] = [
  { id: 'op1', agent_id: 'ag_triage', kind: 'task', title: '确认演示环境能不能打开自定义角色', target: 'tk_a1', at: minsAgo(24), origin: { type: 'session', id: 'ss1' } },
  { id: 'op2', agent_id: 'ag_weekly', kind: 'doc', title: '第 43 周周报', target: 'dc_w43', at: minsAgo(60 * 24 * 5), origin: { type: 'run', id: 'ar3' } },
  { id: 'op3', agent_id: 'ag_weekly', kind: 'doc', title: '第 43 周周报（按项目重写）', target: 'dc_w43r', at: minsAgo(60 * 24 * 5 - 30), origin: { type: 'session', id: 'ss2' } },
]
