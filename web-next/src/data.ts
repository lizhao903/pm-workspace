// 演示数据，人名和公司都是编的。原型阶段只存在内存里，刷新即复原。

export const GROUPS = ['客户', '合作伙伴', '同事', '供应商', '其他'] as const
// 分组可在设置的枚举里新增，类型放宽成任意字符串，保留内置分组的字面量提示
export type Group = (typeof GROUPS)[number] | (string & {})

// IM 渠道按本机装了的客户端列：微信、飞书（Lark）、Slack、Telegram、QQ。
// 加渠道只改这张表；联系人身上的 im 按 key 存，没填的渠道不存。
export interface ImChannel {
  key: string
  label: string
  /** 列表格子里的短名，五个渠道并排也放得下 */
  short: string
  color: string
  /** 表单里提示填什么：各家的「编号」含义不一样 */
  hint: string
  /** 能直达会话的给出链接，没有公开 deep link 的只提供复制 */
  link?: (id: string) => string
}

export const IM_CHANNELS: ImChannel[] = [
  { key: 'wechat', label: '微信', short: '微信', color: '#07c160', hint: '微信号，不是昵称' },
  { key: 'lark', label: '飞书', short: '飞书', color: '#3370ff', hint: '飞书 / Lark 的用户 ID 或登录邮箱' },
  { key: 'slack', label: 'Slack', short: 'Slack', color: '#611f69', hint: 'Member ID，形如 U01ABCDEF' },
  { key: 'telegram', label: 'Telegram', short: 'TG', color: '#229ed9', hint: '用户名，形如 @name', link: (id) => `https://t.me/${id.replace(/^@/, '')}` },
  { key: 'qq', label: 'QQ', short: 'QQ', color: '#12b7f5', hint: 'QQ 号' },
]

export interface Contact {
  id: string
  name: string
  company: string
  title: string
  phone: string
  email: string
  group: Group
  tags: string[]
  /** 渠道 key -> 该渠道上的账号编号 */
  im: Record<string, string>
  /** 上传的头像（data URL）；没有就按名字生成 */
  photo?: string
  note: string
  starred: boolean
  last_contact_at: string | null
  created_at: string
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

let seq = 0
const c = (p: Partial<Contact> & Pick<Contact, 'name' | 'group'>): Contact => {
  seq += 1
  return {
    id: `ct_${seq.toString().padStart(3, '0')}`,
    company: '', title: '', phone: '', email: '', tags: [], im: {}, note: '',
    starred: false, last_contact_at: null, created_at: daysAgo(60 - seq),
    ...p,
  }
}

export const seedContacts: Contact[] = [
  c({ name: '林予安', im: { wechat: 'linyuan_fe', lark: 'lin.yuan@example.com', slack: 'U04LINYUAN' }, group: '同事', company: '本公司', title: '前端负责人', phone: '138 0013 2201', email: 'lin.yuan@example.com', tags: ['研发'], starred: true, last_contact_at: daysAgo(0) }),
  c({ name: '周屿', im: { wechat: 'zhouyu1990', lark: 'zhou.yu@example.com', slack: 'U04ZHOUYU0' }, group: '同事', company: '本公司', title: '后端负责人', phone: '139 1022 3302', email: 'zhou.yu@example.com', tags: ['研发'], last_contact_at: daysAgo(1) }),
  c({ name: '陈若溪', im: { lark: 'chen.ruoxi@example.com', slack: 'U05CHENRX0' }, group: '同事', company: '本公司', title: '设计师', email: 'chen.ruoxi@example.com', tags: ['设计'], last_contact_at: daysAgo(3) }),
  c({ name: '何牧', im: { lark: 'he.mu@example.com' }, group: '同事', company: '本公司', title: '测试', email: 'he.mu@example.com', last_contact_at: daysAgo(9) }),
  c({ name: '许知行', im: { wechat: 'xzx_yc', lark: 'ou_7f3a9c21' }, group: '客户', company: '远川科技', title: 'IT 总监', phone: '137 2233 4405', email: 'xu.zx@yuanchuan.example', tags: ['试点客户', '决策人'], starred: true, last_contact_at: daysAgo(2),
    note: '云端平台 2.0 的试点方。关心权限模型能否按部门自定义，月底前要一版演示。' }),
  c({ name: '梁晚晴', im: { wechat: 'liangwanqing88', lark: 'ou_liangwq' }, group: '客户', company: '远川科技', title: '采购经理', phone: '136 5566 7708', email: 'liang.wq@yuanchuan.example', tags: ['试点客户'], last_contact_at: daysAgo(14) }),
  c({ name: '宋砚', im: { wechat: 'songyan_logi', qq: '20431187' }, group: '客户', company: '北岸物流', title: '运营负责人', phone: '135 8899 0011', tags: ['潜在客户'], last_contact_at: daysAgo(31),
    note: '上次展会认识，对运营后台审批流感兴趣，答应下季度再约。' }),
  c({ name: 'Mia Hoffmann', im: { slack: 'U02MIAHOFF', telegram: '@mia_nordlicht' }, group: '合作伙伴', company: 'Nordlicht GmbH', title: 'Partner Manager', email: 'mia.h@nordlicht.example', tags: ['欧盟', '渠道'], last_contact_at: daysAgo(6),
    note: '欧盟数据驻留方案的本地合作方，沟通用英文，时差 7 小时。' }),
  c({ name: '顾北辰', im: { wechat: 'gubeichen', telegram: '@gbc_compliance' }, group: '合作伙伴', company: '青石咨询', title: '合规顾问', phone: '186 1234 5678', email: 'gu.bc@qingshi.example', tags: ['合规'], starred: true, last_contact_at: daysAgo(1) }),
  c({ name: '唐一苇', im: { wechat: 'yunzhan_tang', qq: '85213009' }, group: '供应商', company: '云栈 IDC', title: '客户经理', phone: '400 800 1234', email: 'tang.yw@yunzhan.example', tags: ['机房'], last_contact_at: daysAgo(45) }),
  c({ name: '苏禾', group: '供应商', company: '墨点设计工作室', title: '创始人', phone: '159 0000 1122', tags: ['外包'] }),
  c({ name: '方既白', im: { wechat: 'fangjibai', telegram: '@jibai' }, group: '其他', company: '', title: '前同事', phone: '177 3344 5566', note: '现在在做出海 SaaS，可以聊聊海外合规。' }),
]

/* ---------- 连接器：工具目录 ---------- */

// 工具按分类挂。现在只有即时通讯一类，加分类就是往这里加一行、再往 TOOLS 里放这一类的工具。
export interface ToolCategory { key: string; label: string; desc: string }
export const TOOL_CATEGORIES: ToolCategory[] = [
  { key: 'im', label: '即时通讯', desc: '把各 IM 的消息收进工作台，并能直接从工作台回复' },
  { key: 'dev', label: '研发协作', desc: '代码仓库、需求和缺陷、线上告警' },
  { key: 'docs', label: '文档知识', desc: '团队的文档、知识库和云盘' },
  { key: 'office', label: '日程邮件', desc: '日历、邮箱' },
  { key: 'crm', label: '客户与服务', desc: 'CRM、客服工单' },
  { key: 'data', label: '数据与搜索', desc: '数据库、网页搜索、公开数据接口' },
  { key: 'media', label: '内容平台', desc: '视频平台的上传发布、数据和评论，配音用的语音合成' },
  { key: 'market', label: '行情数据', desc: '数币、A 股、港股、美股的行情来源；下单用的交易账户在「交易 / 交易账户」里管' },
  { key: 'custom', label: '自定义', desc: '自己的 MCP 服务或 OpenAPI 接口' },
]

/* ---------- 应用与 API 类连接器：认证方式 + 工具清单 ---------- */

/** 无授权：公开接口；OAuth 2.0：跳转授权拿令牌；Token：自己填 API Key / 个人令牌 */
export type AuthMode = 'none' | 'oauth2' | 'token'
export const AUTH_LABEL: Record<AuthMode, string> = { none: '无授权', oauth2: 'OAuth 2.0', token: 'Token' }

export interface ToolDef { name: string; desc: string; write: boolean }
/** 工具权限：关闭 / 需确认（调用前要人点确认）/ 自动；只读工具没有「需确认」 */
export type ToolMode = 'off' | 'confirm' | 'auto'
export interface ConnTool extends ToolDef { mode: ToolMode }

export interface ConnAuth {
  mode: AuthMode
  /** OAuth：授权后的账号、到期时间、授权范围 */
  oauth?: { client_id: string; client_secret: string; auth_url: string; token_url: string; scopes: string; account?: string; expires_at?: string }
  /** Token：放在哪个请求头、前缀 */
  token?: { header: string; prefix: string; value: string }
}

export interface ToolField {
  key: string
  label: string
  kind: 'text' | 'secret' | 'select'
  placeholder?: string
  options?: string[]
  required?: boolean
}

export interface Tool {
  key: string
  category: string
  label: string
  color: string
  desc: string
  /** 平台本身能不能从外部发消息回去；不能的话连接器只能「只收」 */
  canSend: boolean
  fields: ToolField[]
  /** 应用与 API 类才有：支持哪几种认证方式，第一个是默认 */
  auth?: AuthMode[]
  /** 内置的 OAuth 应用信息，用户只需要点授权；自定义的要自己填 */
  oauth?: { auth_url: string; token_url: string; scopes: string; builtin: boolean }
  /** 获取工具清单时对方会报回来的工具（原型里写死） */
  catalog?: ToolDef[]
}

const imTool = (key: string, desc: string, canSend: boolean, fields: ToolField[]): Tool => {
  const ch = IM_CHANNELS.find((c) => c.key === key)!
  // IM 类工具的 key 与 IM 渠道 key 相同：消息、联系人的渠道编号、连接器三者靠它对上
  return { key, category: 'im', label: ch.label, color: ch.color, desc, canSend, fields }
}

export const TOOLS: Tool[] = [
  imTool('wechat', '通过企业微信自建应用收发，或桥接本机微信客户端只读同步', true, [
    { key: 'mode', label: '接入方式', kind: 'select', options: ['企业微信自建应用', '本机客户端桥接（只收）'], required: true },
    { key: 'corp_id', label: '企业 ID', kind: 'text', placeholder: 'ww 开头的 CorpID', required: true },
    { key: 'agent_id', label: '应用 AgentId', kind: 'text', placeholder: '1000002' },
    { key: 'secret', label: '应用 Secret', kind: 'secret', required: true },
  ]),
  imTool('lark', '飞书 / Lark 自建应用机器人，订阅消息事件', true, [
    { key: 'region', label: '数据中心', kind: 'select', options: ['飞书（feishu.cn）', 'Lark（larksuite.com）'], required: true },
    { key: 'app_id', label: 'App ID', kind: 'text', placeholder: 'cli_ 开头', required: true },
    { key: 'app_secret', label: 'App Secret', kind: 'secret', required: true },
    { key: 'verify_token', label: '事件订阅 Verification Token', kind: 'secret' },
  ]),
  imTool('slack', 'Slack App，监听指定频道与私信', true, [
    { key: 'bot_token', label: 'Bot Token', kind: 'secret', placeholder: 'xoxb-', required: true },
    { key: 'signing_secret', label: 'Signing Secret', kind: 'secret', required: true },
    { key: 'channels', label: '监听频道', kind: 'text', placeholder: '#product, #feedback，逗号分隔；留空 = 只收私信' },
  ]),
  imTool('telegram', '用个人账号（API ID）同步会话，或接一个 Bot', true, [
    { key: 'mode', label: '接入方式', kind: 'select', options: ['用户账号（API ID）', 'Bot'], required: true },
    { key: 'api_id', label: 'API ID', kind: 'text', placeholder: 'my.telegram.org 上申请' },
    { key: 'api_hash', label: 'API Hash / Bot Token', kind: 'secret', required: true },
    { key: 'phone', label: '登录手机号', kind: 'text', placeholder: '+86 …，Bot 方式不用填' },
  ]),
  imTool('qq', 'QQ 开放平台机器人，收群 @ 与私信', true, [
    { key: 'app_id', label: '机器人 AppID', kind: 'text', required: true },
    { key: 'app_secret', label: 'AppSecret', kind: 'secret', required: true },
    { key: 'sandbox', label: '沙箱模式', kind: 'select', options: ['关闭', '开启'] },
  ]),
]

// 应用类连接器统一在这里登记：分类、支持的认证方式、对方会报回来的工具
const appTool = (key: string, category: string, label: string, color: string, desc: string, auth: AuthMode[], catalog: ToolDef[], extra: Partial<Tool> = {}): Tool =>
  ({ key, category, label, color, desc, canSend: false, fields: [], auth, catalog, ...extra })
const oauth = (auth_url: string, token_url: string, scopes: string) => ({ oauth: { auth_url, token_url, scopes, builtin: true } })
const R = (name: string, desc: string): ToolDef => ({ name, desc, write: false })
const W = (name: string, desc: string): ToolDef => ({ name, desc, write: true })

TOOLS.push(
  appTool('github', 'dev', 'GitHub', '#24292f', '读 issue、PR，建 issue、发评论', ['oauth2', 'token'], [
    R('list_issues', '按仓库、标签、状态列出 issue'), R('get_issue', '读一个 issue 和它的评论'), R('get_pull_request', '读 PR 的描述、改动文件和评审'),
    R('search_code', '在仓库里搜代码'), W('create_issue', '新建 issue'), W('comment_issue', '在 issue 或 PR 下评论'), W('add_labels', '给 issue 打标签'), W('merge_pull_request', '合并 PR'),
  ], { oauth: { auth_url: 'https://github.com/login/oauth/authorize', token_url: 'https://github.com/login/oauth/access_token', scopes: 'repo, read:org', builtin: true } }),
  appTool('notion', 'docs', 'Notion', '#191919', '搜页面、读数据库，写页面', ['oauth2', 'token'], [
    R('search', '按标题和内容搜页面'), R('get_page', '读一个页面的内容'), R('query_database', '按条件查数据库'), W('create_page', '新建页面'), W('update_page', '改页面内容和属性'), W('append_block', '在页面末尾追加内容'),
  ], { oauth: { auth_url: 'https://api.notion.com/v1/oauth/authorize', token_url: 'https://api.notion.com/v1/oauth/token', scopes: '由工作区授权时选页面', builtin: true } }),
  appTool('jira', 'dev', 'Jira', '#0052cc', '查需求和缺陷，建单、流转状态', ['oauth2', 'token'], [
    R('search_issues', '用 JQL 查单'), R('get_issue', '读一张单'), W('create_issue', '建单'), W('transition_issue', '流转状态'), W('add_comment', '加评论'),
  ], { fields: [{ key: 'site', label: '站点地址', kind: 'text', placeholder: 'https://your-team.atlassian.net', required: true }], oauth: { auth_url: 'https://auth.atlassian.com/authorize', token_url: 'https://auth.atlassian.com/oauth/token', scopes: 'read:jira-work, write:jira-work', builtin: true } }),
  appTool('gcal', 'office', 'Google 日历', '#1a73e8', '查日程、找空档、建会议', ['oauth2'], [
    R('list_events', '列出某段时间的日程'), R('find_free_time', '找几个人共同的空档'), W('create_event', '建日程并发邀请'), W('update_event', '改日程'), W('delete_event', '删日程'),
  ], { oauth: { auth_url: 'https://accounts.google.com/o/oauth2/v2/auth', token_url: 'https://oauth2.googleapis.com/token', scopes: 'calendar.events', builtin: true } }),
  appTool('weather', 'data', '和风天气（公开接口）', '#0ea5e9', '查天气，用在出差、活动类流程里', ['none', 'token'], [
    R('current_weather', '实时天气'), R('forecast_7d', '未来 7 天预报'),
  ]),
  // 研发协作
  appTool('gitlab', 'dev', 'GitLab', '#fc6d26', '读写 issue、MR，适合自建 GitLab', ['token', 'oauth2'], [
    R('list_issues', '列出 issue'), R('get_merge_request', '读 MR 和评审'), R('list_pipelines', '看流水线状态'), W('create_issue', '新建 issue'), W('comment', '在 issue 或 MR 下评论'),
  ], { fields: [{ key: 'site', label: '实例地址', kind: 'text', placeholder: 'https://gitlab.com 或自建地址', required: true }], ...oauth('https://gitlab.com/oauth/authorize', 'https://gitlab.com/oauth/token', 'api') }),
  appTool('linear', 'dev', 'Linear', '#5e6ad2', '查和建 issue、看迭代进度', ['oauth2', 'token'], [
    R('search_issues', '按条件查 issue'), R('list_cycles', '看迭代'), W('create_issue', '新建 issue'), W('update_issue', '改状态、负责人'),
  ], oauth('https://linear.app/oauth/authorize', 'https://api.linear.app/oauth/token', 'read, write')),
  appTool('sentry', 'dev', 'Sentry', '#362d59', '查线上错误和影响用户数', ['token'], [
    R('list_issues', '按项目列出错误'), R('get_issue', '读错误详情和堆栈'), R('get_stats', '看错误趋势'), W('resolve_issue', '标为已解决'),
  ], { fields: [{ key: 'org', label: '组织 slug', kind: 'text', required: true }] }),
  // 文档知识
  appTool('confluence', 'docs', 'Confluence', '#1868db', '搜页面、读页面、建页面', ['oauth2', 'token'], [
    R('search', '用 CQL 搜页面'), R('get_page', '读页面正文'), W('create_page', '新建页面'), W('update_page', '改页面'),
  ], { fields: [{ key: 'site', label: '站点地址', kind: 'text', placeholder: 'https://your-team.atlassian.net/wiki', required: true }], ...oauth('https://auth.atlassian.com/authorize', 'https://auth.atlassian.com/oauth/token', 'read:confluence-content.all, write:confluence-content') }),
  appTool('feishu_docs', 'docs', '飞书文档', '#3370ff', '读写飞书云文档、多维表格', ['oauth2', 'token'], [
    R('search_docs', '搜云文档'), R('get_doc', '读文档'), R('query_bitable', '查多维表格'), W('create_doc', '新建文档'), W('append_bitable', '往多维表格加一行'),
  ], oauth('https://open.feishu.cn/open-apis/authen/v1/authorize', 'https://open.feishu.cn/open-apis/authen/v2/oauth/token', 'docx:document, bitable:app')),
  appTool('yuque', 'docs', '语雀', '#00b96b', '读写知识库文档', ['token'], [
    R('list_repos', '列出知识库'), R('get_doc', '读文档'), W('create_doc', '新建文档'),
  ]),
  appTool('gdrive', 'docs', 'Google Drive', '#0f9d58', '搜文件、读文档内容', ['oauth2'], [
    R('search_files', '按名称和内容搜文件'), R('read_file', '读文档、表格内容'), W('create_file', '新建文件'),
  ], oauth('https://accounts.google.com/o/oauth2/v2/auth', 'https://oauth2.googleapis.com/token', 'drive.readonly, drive.file')),
  // 日程邮件
  appTool('gmail', 'office', 'Gmail', '#ea4335', '搜邮件、起草和发送邮件', ['oauth2'], [
    R('search_mail', '搜邮件'), R('read_thread', '读整个往来'), W('create_draft', '存草稿'), W('send_mail', '发送邮件'),
  ], oauth('https://accounts.google.com/o/oauth2/v2/auth', 'https://oauth2.googleapis.com/token', 'gmail.readonly, gmail.compose')),
  appTool('outlook', 'office', 'Outlook / Microsoft 365', '#0078d4', '邮件和日历，一次授权两样都能用', ['oauth2'], [
    R('search_mail', '搜邮件'), R('list_events', '列出日程'), W('send_mail', '发送邮件'), W('create_event', '建日程'),
  ], oauth('https://login.microsoftonline.com/common/oauth2/v2.0/authorize', 'https://login.microsoftonline.com/common/oauth2/v2.0/token', 'Mail.ReadWrite Calendars.ReadWrite')),
  appTool('imap', 'office', '企业邮箱（IMAP / SMTP）', '#868e96', '腾讯企业邮、阿里邮箱等，用账号和授权码接入', ['token'], [
    R('search_mail', '搜邮件'), R('read_mail', '读一封邮件'), W('send_mail', '发送邮件'),
  ], { fields: [{ key: 'imap', label: 'IMAP 服务器', kind: 'text', placeholder: 'imap.exmail.qq.com:993', required: true }, { key: 'smtp', label: 'SMTP 服务器', kind: 'text', placeholder: 'smtp.exmail.qq.com:465', required: true }, { key: 'user', label: '邮箱账号', kind: 'text', required: true }] }),
  // 客户与服务
  appTool('hubspot', 'crm', 'HubSpot', '#ff7a59', '查客户、商机，记跟进', ['oauth2', 'token'], [
    R('search_contacts', '查联系人'), R('get_deal', '读商机'), W('create_note', '记一条跟进'), W('update_deal', '改商机阶段'),
  ], oauth('https://app.hubspot.com/oauth/authorize', 'https://api.hubapi.com/oauth/v1/token', 'crm.objects.contacts.read crm.objects.deals.write')),
  appTool('salesforce', 'crm', 'Salesforce', '#00a1e0', '查客户和商机，记活动', ['oauth2'], [
    R('soql_query', '用 SOQL 查记录'), R('get_account', '读客户'), W('create_task', '建跟进任务'), W('update_opportunity', '改商机'),
  ], oauth('https://login.salesforce.com/services/oauth2/authorize', 'https://login.salesforce.com/services/oauth2/token', 'api refresh_token')),
  appTool('zendesk', 'crm', 'Zendesk', '#03363d', '查客服工单、回复工单', ['oauth2', 'token'], [
    R('search_tickets', '查工单'), R('get_ticket', '读工单和对话'), W('reply_ticket', '回复工单'), W('update_ticket', '改状态、优先级'),
  ], { fields: [{ key: 'subdomain', label: '子域名', kind: 'text', placeholder: 'yourcompany.zendesk.com', required: true }], ...oauth('https://{subdomain}.zendesk.com/oauth/authorizations/new', 'https://{subdomain}.zendesk.com/oauth/tokens', 'read write') }),
  // 数据与搜索
  appTool('postgres', 'data', 'PostgreSQL', '#336791', '只读查询业务库，给报表和分析用', ['token'], [
    R('list_tables', '列出表'), R('describe_table', '看表结构'), R('run_query', '执行只读 SQL'),
  ], { fields: [{ key: 'host', label: '主机', kind: 'text', placeholder: 'db.internal:5432', required: true }, { key: 'database', label: '数据库', kind: 'text', required: true }, { key: 'user', label: '用户名', kind: 'text', required: true, placeholder: '建议用只读账号' }] }),
  appTool('mysql', 'data', 'MySQL', '#00758f', '只读查询业务库', ['token'], [
    R('list_tables', '列出表'), R('describe_table', '看表结构'), R('run_query', '执行只读 SQL'),
  ], { fields: [{ key: 'host', label: '主机', kind: 'text', placeholder: 'db.internal:3306', required: true }, { key: 'database', label: '数据库', kind: 'text', required: true }, { key: 'user', label: '用户名', kind: 'text', required: true, placeholder: '建议用只读账号' }] }),
  appTool('web_search', 'data', '网页搜索', '#2f7d43', '联网搜索，给调研、竞品分析用', ['token'], [
    R('search', '搜网页'), R('search_news', '搜新闻'),
  ], { fields: [{ key: 'engine', label: '搜索服务', kind: 'select', options: ['Tavily', 'Bing Web Search', 'SerpAPI', '博查'], required: true }] }),
  appTool('web_fetch', 'data', '网页读取', '#495057', '打开一个网址读正文，公开网页不需要凭证', ['none'], [
    R('fetch_page', '读网页正文'), R('fetch_links', '列出页面上的链接'),
  ]),
  // 内容平台：视频模块的发布记录按平台对上这里的连接器（videodata 的 PLATFORM_TOOL）
  appTool('bilibili', 'media', 'B 站', '#fb7299', '投稿、定时发布、拉播放和互动数据、读回评论', ['oauth2'], [
    R('list_videos', '列出已投稿的视频'), R('get_stats', '单个视频的播放、点赞、投币、收藏、分享'), R('list_comments', '读评论和弹幕'),
    W('upload_video', '上传视频并投稿'), W('schedule_publish', '定时发布'), W('reply_comment', '回复评论'),
  ], oauth('https://passport.bilibili.com/register/pc_oauth2.html', 'https://api.bilibili.com/x/account-oauth2/v1/token', 'ARCHIVE_BASE, DATA_CENTER, COMMENT')),
  appTool('youtube', 'media', 'YouTube', '#ff0033', '上传、设封面和章节、拉 Studio 数据、读回评论', ['oauth2'], [
    R('list_videos', '列出频道的视频'), R('get_analytics', '曝光、点击率、观看时长、留存'), R('list_comments', '读评论'),
    W('upload_video', '上传视频'), W('set_thumbnail', '设置封面'), W('update_video', '改标题、简介、章节'), W('reply_comment', '回复评论'),
  ], oauth('https://accounts.google.com/o/oauth2/v2/auth', 'https://oauth2.googleapis.com/token', 'youtube.upload, youtube.readonly, yt-analytics.readonly')),
  appTool('douyin', 'media', '抖音', '#161823', '发布视频、拉作品数据和评论（抖音开放平台）', ['oauth2'], [
    R('list_videos', '列出作品'), R('get_stats', '播放、点赞、评论、分享'), R('list_comments', '读评论'), W('create_video', '上传并发布'), W('reply_comment', '回复评论'),
  ], oauth('https://open.douyin.com/platform/oauth/connect', 'https://open.douyin.com/oauth/access_token', 'video.create, video.data, item.comment')),
  appTool('channels', 'media', '视频号', '#07c160', '拉视频号作品数据和评论；发布需在视频号助手里完成', ['token'], [
    R('list_videos', '列出作品'), R('get_stats', '播放、点赞、转发'), R('list_comments', '读评论'),
  ], { fields: [{ key: 'appid', label: '公众号 / 小程序 AppID', kind: 'text', required: true, placeholder: '视频号绑定的主体' }, { key: 'secret', label: 'AppSecret', kind: 'secret', required: true }] }),
  appTool('xiaohongshu', 'media', '小红书', '#ff2442', '笔记数据和评论（蒲公英 / 开放平台）；发布需在 App 或创作者中心', ['token'], [
    R('list_notes', '列出笔记'), R('get_stats', '曝光、阅读、点赞、收藏'), R('list_comments', '读评论'),
  ], { fields: [{ key: 'app_key', label: 'App Key', kind: 'text', required: true }, { key: 'app_secret', label: 'App Secret', kind: 'secret', required: true }] }),
  appTool('tts', 'media', '语音合成', '#0f8a8a', '把口播稿合成音频，视频的「音频合成」阶段用它', ['token'], [
    R('list_voices', '列出可用音色'), W('synthesize', '按章节合成音频'),
  ], { fields: [{ key: 'vendor', label: '服务', kind: 'select', options: ['火山引擎（豆包语音）', 'MiniMax', 'ElevenLabs', 'Azure 语音', '阿里云智能语音'], required: true }, { key: 'voice', label: '默认音色', kind: 'text', placeholder: '比如 zh_male_jingqiang' }] }),
  // 行情数据：行情、盯盘、回测取数用；没有接入时页面用模拟行情
  appTool('binance_md', 'market', 'Binance 行情', '#f0b90b', '现货和合约的实时行情、K 线、盘口、资金费率，公开接口', ['none'], [
    R('ticker', '最新价和 24 小时统计'), R('klines', 'K 线'), R('depth', '盘口'), R('funding_rate', '永续资金费率'),
  ]),
  appTool('okx_md', 'market', 'OKX 行情', '#121212', '现货、永续、交割、期权行情，公开接口', ['none'], [
    R('ticker', '最新价'), R('candles', 'K 线'), R('books', '盘口'), R('opt_summary', '期权希腊值和隐含波动率'),
  ]),
  appTool('deribit_md', 'market', 'Deribit 期权行情', '#14b8a6', 'BTC / ETH 期权链、隐含波动率曲面', ['none'], [
    R('instruments', '期权合约列表'), R('ticker', '期权报价和希腊值'), R('volatility_index', 'DVOL 波动率指数'),
  ]),
  appTool('futu_opend', 'market', '富途 OpenD', '#ff7a00', '港股、美股、A 股通的行情和期权链；需要本机运行 OpenD', ['none', 'token'], [
    R('snapshot', '行情快照'), R('kline', 'K 线'), R('order_book', '盘口'), R('option_chain', '期权链'),
  ], { fields: [{ key: 'host', label: 'OpenD 地址', kind: 'text', placeholder: '127.0.0.1:11111', required: true }] }),
  appTool('tushare', 'market', 'Tushare Pro', '#c0352b', 'A 股、指数、期货、ETF 期权的日线和分钟数据', ['token'], [
    R('daily', '日线'), R('stk_mins', '分钟线'), R('fut_daily', '期货日线'), R('opt_daily', '期权日线'), R('trade_cal', '交易日历'),
  ]),
  appTool('polygon', 'market', 'Polygon.io', '#5f5cff', '美股、期权、指数的实时和历史行情', ['token'], [
    R('aggs', 'K 线聚合'), R('last_trade', '最新成交'), R('options_chain', '期权链快照'), R('market_status', '市场开收盘状态'),
  ]),
  { key: 'custom_mcp', category: 'custom', label: 'MCP 服务', color: '#7a4fd6', desc: '接一个 MCP 服务，自动发现它提供的工具', canSend: false,
    fields: [{ key: 'url', label: '服务地址', kind: 'text', placeholder: 'https://mcp.example.com/sse', required: true }, { key: 'transport', label: '传输方式', kind: 'select', options: ['Streamable HTTP', 'SSE'], required: true }],
    auth: ['none', 'oauth2', 'token'], oauth: { auth_url: '', token_url: '', scopes: '', builtin: false } },
  { key: 'custom_openapi', category: 'custom', label: 'OpenAPI 接口', color: '#e8590c', desc: '给一份 OpenAPI 文档，每个接口变成一个工具', canSend: false,
    fields: [{ key: 'spec_url', label: 'OpenAPI 文档地址', kind: 'text', placeholder: 'https://api.example.com/openapi.json', required: true }, { key: 'base_url', label: '接口地址', kind: 'text', placeholder: '留空用文档里的 servers' }],
    auth: ['none', 'token', 'oauth2'], oauth: { auth_url: '', token_url: '', scopes: '', builtin: false } },
)

/** 获取工具清单（模拟）：内置的用写死的清单，自定义的按地址编几项 */
export function discoverTools(tool: Tool, config: Record<string, string>): ToolDef[] {
  if (tool.catalog) return tool.catalog
  const host = (config.url || config.spec_url || '').replace(/^https?:\/\//, '').split(/[/.]/)[0] || 'service'
  return [R(`${host}_list`, '列出记录'), R(`${host}_get`, '按 ID 读一条'), R(`${host}_search`, '按关键词搜'), W(`${host}_create`, '新建一条'), W(`${host}_update`, '修改一条'), W(`${host}_delete`, '删除一条')]
}
/** 新拉到的工具：写操作默认需确认，只读默认自动 */
export const defaultMode = (t: ToolDef): ToolMode => (t.write ? 'confirm' : 'auto')

/* ---------- 连接器：已接入的实例 ---------- */

/** disconnected：人主动断开，配置留着、授权撤销；paused：保存时关了「启用」；connecting：正在连 */
export type ConnStatus = 'connected' | 'connecting' | 'error' | 'paused' | 'disconnected'
export interface Connector {
  id: string
  tool: string
  name: string
  /** 连上之后对方平台报回来的账号，用来区分同一工具接了两个 */
  account: string
  status: ConnStatus
  error?: string
  config: Record<string, string>
  direction: 'receive' | 'both'
  interval: number
  last_sync_at: string | null
  created_at: string
  /** 自定义连接器（MCP、OpenAPI）可以换图标，data URL */
  icon?: string
  /** 应用与 API 类才有 */
  auth?: ConnAuth
  tools?: ConnTool[]
  tools_at?: string
}

const minsAgo = (n: number) => new Date(Date.now() - n * 60000).toISOString()

/** 内置工具的清单直接取目录：只读自动、写操作需确认 */
const catalogOf = (key: string): ConnTool[] => (TOOLS.find((t) => t.key === key)?.catalog ?? []).map((d) => ({ ...d, mode: defaultMode(d) }))

export const seedConnectors: Connector[] = [
  { id: 'cn_bilibili', tool: 'bilibili', name: 'B 站账号', account: '一人之下官方', status: 'connected', direction: 'both', interval: 60, config: {}, last_sync_at: minsAgo(25), created_at: daysAgo(25),
    auth: { mode: 'oauth2', oauth: { client_id: '', client_secret: '', auth_url: '', token_url: '', scopes: 'ARCHIVE_BASE, DATA_CENTER, COMMENT', account: '一人之下官方', expires_at: new Date(Date.now() + 86400000 * 20).toISOString() } }, tools: catalogOf('bilibili'), tools_at: daysAgo(25) },
  { id: 'cn_youtube', tool: 'youtube', name: 'YouTube 频道', account: 'One Below Studio', status: 'connected', direction: 'both', interval: 60, config: {}, last_sync_at: minsAgo(40), created_at: daysAgo(15),
    auth: { mode: 'oauth2', oauth: { client_id: '', client_secret: '', auth_url: '', token_url: '', scopes: 'youtube.upload, youtube.readonly, yt-analytics.readonly', account: 'One Below Studio', expires_at: new Date(Date.now() + 86400000 * 40).toISOString() } }, tools: catalogOf('youtube'), tools_at: daysAgo(15) },
  { id: 'cn_channels', tool: 'channels', name: '视频号数据', account: '一人之下', status: 'connected', direction: 'receive', interval: 120, config: { appid: 'wx7a1c90e2b3d4f5a6', secret: 'demo-secret' }, last_sync_at: minsAgo(60 * 2), created_at: daysAgo(12),
    auth: { mode: 'token' }, tools: catalogOf('channels'), tools_at: daysAgo(12) },
  { id: 'cn_douyin', tool: 'douyin', name: '抖音账号', account: '一人之下', status: 'error', error: '授权已过期（access_token expired），请重新授权', direction: 'both', interval: 60, config: {}, last_sync_at: minsAgo(60 * 30), created_at: daysAgo(18),
    auth: { mode: 'oauth2', oauth: { client_id: '', client_secret: '', auth_url: '', token_url: '', scopes: 'video.create, video.data', account: '一人之下', expires_at: daysAgo(1) } }, tools: catalogOf('douyin'), tools_at: daysAgo(18) },
  { id: 'cn_binance_md', tool: 'binance_md', name: 'Binance 行情', account: '公开接口', status: 'connected', direction: 'receive', interval: 0, config: {}, last_sync_at: minsAgo(0), created_at: daysAgo(10), auth: { mode: 'none' }, tools: catalogOf('binance_md'), tools_at: daysAgo(10) },
  { id: 'cn_futu_opend', tool: 'futu_opend', name: '富途 OpenD', account: '127.0.0.1:11111', status: 'connected', direction: 'receive', interval: 0, config: { host: '127.0.0.1:11111' }, last_sync_at: minsAgo(1), created_at: daysAgo(10), auth: { mode: 'none' }, tools: catalogOf('futu_opend'), tools_at: daysAgo(10) },
  { id: 'cn_slack', tool: 'slack', name: '公司 Slack', account: 'acme.slack.com', status: 'connected', direction: 'both', interval: 5,
    config: { bot_token: 'xoxb-1234-demo', signing_secret: 'demo-signing', channels: '#product, #feedback, #release, #pmw-beta' }, last_sync_at: minsAgo(2), created_at: daysAgo(40) },
  { id: 'cn_tg', tool: 'telegram', name: '个人 Telegram', account: '@broleez', status: 'connected', direction: 'both', interval: 5,
    config: { mode: '用户账号（API ID）', api_id: '2040123', api_hash: 'demo-hash', phone: '+86 138 0000 0000' }, last_sync_at: minsAgo(4), created_at: daysAgo(30) },
  { id: 'cn_lark', tool: 'lark', name: '飞书工作区', account: '远川科技 x 本公司', status: 'connected', direction: 'receive', interval: 15,
    config: { region: 'Lark（larksuite.com）', app_id: 'cli_a1b2c3', app_secret: 'demo-secret' }, last_sync_at: minsAgo(11), created_at: daysAgo(20) },
  { id: 'cn_wechat', tool: 'wechat', name: '企业微信', account: '本公司', status: 'error', error: '应用 Secret 已失效（errcode 40001），请到企业微信后台重新获取', direction: 'both', interval: 10,
    config: { mode: '企业微信自建应用', corp_id: 'ww1234567890', agent_id: '1000002', secret: 'expired' }, last_sync_at: minsAgo(190), created_at: daysAgo(50) },
  { id: 'cn_github', tool: 'github', name: '公司 GitHub', account: 'acme-inc', status: 'connected', direction: 'receive', interval: 0, config: {}, last_sync_at: minsAgo(30), created_at: daysAgo(12),
    auth: { mode: 'oauth2', oauth: { client_id: '', client_secret: '', auth_url: '', token_url: '', scopes: 'repo, read:org', account: 'broleez（acme-inc）', expires_at: new Date(Date.now() + 86400000 * 52).toISOString() } },
    tools: [
      { name: 'list_issues', desc: '按仓库、标签、状态列出 issue', write: false, mode: 'auto' }, { name: 'get_issue', desc: '读一个 issue 和它的评论', write: false, mode: 'auto' },
      { name: 'get_pull_request', desc: '读 PR 的描述、改动文件和评审', write: false, mode: 'auto' }, { name: 'search_code', desc: '在仓库里搜代码', write: false, mode: 'off' },
      { name: 'create_issue', desc: '新建 issue', write: true, mode: 'confirm' }, { name: 'comment_issue', desc: '在 issue 或 PR 下评论', write: true, mode: 'confirm' },
      { name: 'add_labels', desc: '给 issue 打标签', write: true, mode: 'auto' }, { name: 'merge_pull_request', desc: '合并 PR', write: true, mode: 'off' },
    ], tools_at: minsAgo(60 * 24 * 3) },
  { id: 'cn_notion', tool: 'notion', name: 'Notion 产品空间', account: 'Product Wiki', status: 'error', error: 'OAuth 令牌已过期，需要重新授权', direction: 'receive', interval: 0, config: {}, last_sync_at: minsAgo(60 * 30), created_at: daysAgo(60),
    auth: { mode: 'oauth2', oauth: { client_id: '', client_secret: '', auth_url: '', token_url: '', scopes: '由工作区授权时选页面', account: 'Product Wiki', expires_at: new Date(Date.now() - 3600000 * 5).toISOString() } },
    tools: [
      { name: 'search', desc: '按标题和内容搜页面', write: false, mode: 'auto' }, { name: 'get_page', desc: '读一个页面的内容', write: false, mode: 'auto' },
      { name: 'query_database', desc: '按条件查数据库', write: false, mode: 'auto' }, { name: 'create_page', desc: '新建页面', write: true, mode: 'confirm' },
      { name: 'update_page', desc: '改页面内容和属性', write: true, mode: 'off' }, { name: 'append_block', desc: '在页面末尾追加内容', write: true, mode: 'confirm' },
    ], tools_at: minsAgo(60 * 24 * 20) },
  { id: 'cn_weather', tool: 'weather', name: '和风天气', account: '公开接口', status: 'connected', direction: 'receive', interval: 0, config: {}, last_sync_at: minsAgo(60 * 2), created_at: daysAgo(5),
    auth: { mode: 'none' }, tools: [{ name: 'current_weather', desc: '实时天气', write: false, mode: 'auto' }, { name: 'forecast_7d', desc: '未来 7 天预报', write: false, mode: 'auto' }], tools_at: minsAgo(60 * 24 * 5) },
]

/* ---------- IM 消息 ---------- */

export type MsgStatus = 'pending' | 'done' | 'ignored'
export interface Reply { id: string; text: string; at: string }
/** 消息里带的附件；文件和图片要先「获取」（从 IM 平台下载到本地）才能加进项目资料，链接不用 */
export type AttachmentKind = 'file' | 'image' | 'link'
export interface MsgAttachment {
  id: string
  name: string
  kind: AttachmentKind
  /** 字节数；链接没有 */
  size?: number
  /** 链接的地址 */
  url?: string
  /** 获取状态：idle 还在平台上；done 已下载到 local */
  fetch?: 'idle' | 'fetching' | 'done' | 'error'
  local?: string
  error?: string
}
export const ATTACH_DIR = '~/Downloads/一人之下/附件'

export interface Message {
  id: string
  channel: string
  connector_id: string
  /** 群名 / 频道名；私聊为空 */
  conversation: string
  sender_name: string
  /** 发信人在该渠道上的编号，用它去联系人的 im 里对人 */
  sender_id: string
  text: string
  at: string
  read: boolean
  status: MsgStatus
  /** 稍后提醒到点前不出现在「待处理」里 */
  snooze_until: string | null
  replies: Reply[]
  attachments?: MsgAttachment[]
}

let mseq = 0
const m = (p: Omit<Message, 'id' | 'read' | 'status' | 'snooze_until' | 'replies'> & Partial<Message>): Message => {
  mseq += 1
  return { id: `msg_${mseq.toString().padStart(3, '0')}`, read: false, status: 'pending', snooze_until: null, replies: [], ...p }
}

export const seedMessages: Message[] = [
  m({ channel: 'slack', connector_id: 'cn_slack', conversation: '#product', sender_name: 'Lin Yuan', sender_id: 'U04LINYUAN', at: minsAgo(6),
    text: '@Broleez 权限点清单我整理了一版放在 PRD 评论里了，今天能过一下吗？有几个点和后端口径不一致。',
    attachments: [{ id: 'att1', name: '权限点清单 v2.xlsx', kind: 'file', size: 48213, fetch: 'idle' }, { id: 'att2', name: 'PRD 评论区', kind: 'link', url: 'https://docs.google.com/document/d/1PRDperm/edit?disco=comments' }] }),
  m({ channel: 'telegram', connector_id: 'cn_tg', conversation: '', sender_name: 'Mia Hoffmann', sender_id: '@mia_nordlicht', at: minsAgo(18),
    text: 'Hi, our legal team confirmed the EU data residency requirements. Can we schedule a call this week to walk through the storage design?' }),
  m({ channel: 'lark', connector_id: 'cn_lark', conversation: '远川试点项目群', sender_name: '许知行', sender_id: 'ou_7f3a9c21', at: minsAgo(35),
    text: '@所有人 月底的演示能不能把按部门自定义角色带上？我们老板下周要看。',
    attachments: [{ id: 'att3', name: '远川组织架构.png', kind: 'image', size: 386120, fetch: 'idle' }, { id: 'att4', name: '部门自定义角色需求说明.docx', kind: 'file', size: 92311, fetch: 'idle' }] }),
  m({ channel: 'slack', connector_id: 'cn_slack', conversation: '#feedback', sender_name: 'Kevin Wu', sender_id: 'U07KEVINWU', at: minsAgo(52), read: true,
    text: '客户反馈导出按钮藏得太深，在列表页找了半天才找到，能不能放到工具条上？',
    attachments: [{ id: 'att5', name: '客户录屏-找导出按钮.mp4', kind: 'file', size: 12480512, fetch: 'idle' }] }),
  m({ channel: 'slack', connector_id: 'cn_slack', conversation: '', sender_name: 'Zhou Yu', sender_id: 'U04ZHOUYU0', at: minsAgo(80), read: true,
    text: '权限变更 1 分钟内生效这条，缓存方案要改，可能会影响排期，找时间对一下。' }),
  m({ channel: 'wechat', connector_id: 'cn_wechat', conversation: '', sender_name: '唐一苇', sender_id: 'yunzhan_tang', at: minsAgo(200), read: true,
    text: '李总您好，下季度机柜续费的报价单发您邮箱了，麻烦确认一下。' }),
  m({ channel: 'telegram', connector_id: 'cn_tg', conversation: '出海 SaaS 交流', sender_name: '方既白', sender_id: '@jibai', at: minsAgo(260), read: true,
    text: '有人做过 GDPR 的数据驻留吗？我们这边法务给的口径和你们之前说的不太一样。' }),
  m({ channel: 'lark', connector_id: 'cn_lark', conversation: '远川试点项目群', sender_name: '梁晚晴', sender_id: 'ou_liangwq', at: minsAgo(400), read: true,
    text: '采购流程这边需要一份正式的报价和服务协议模板，麻烦发一下。',
    attachments: [{ id: 'att6', name: '远川采购流程说明.pdf', kind: 'file', size: 215004, fetch: 'done', local: `${ATTACH_DIR}/远川采购流程说明.pdf` }] }),
  m({ channel: 'wechat', connector_id: 'cn_wechat', conversation: '', sender_name: '宋砚', sender_id: 'songyan_logi', at: minsAgo(1500), read: true, status: 'done',
    text: '上次说的审批流 demo，下季度初可以约个时间看看。',
    replies: [{ id: 'r1', text: '好的，下季度初我提前一周约您。', at: minsAgo(1440) }] }),
  m({ channel: 'slack', connector_id: 'cn_slack', conversation: '#product', sender_name: 'Chen Ruoxi', sender_id: 'U05CHENRX0', at: minsAgo(1600), read: true, status: 'done',
    text: '角色管理设计稿更新了，主要改了权限勾选的分组方式。',
    attachments: [{ id: 'att7', name: '角色管理 v4（Figma）', kind: 'link', url: 'https://www.figma.com/design/roles-v4' }],
    replies: [{ id: 'r2', text: '收到，我今天看。', at: minsAgo(1580) }] }),
  m({ channel: 'telegram', connector_id: 'cn_tg', conversation: 'Crypto News', sender_name: 'NewsBot', sender_id: '@cryptonews_bot', at: minsAgo(700), read: true, status: 'ignored',
    text: '[Daily digest] Top 10 headlines of the day …' }),
  m({ channel: 'slack', connector_id: 'cn_slack', conversation: '#product', sender_name: 'Chen Ruoxi', sender_id: 'U05CHENRX0', at: minsAgo(12),
    text: '评审会改到周四下午三点，@Broleez 麻烦把权限改造的 PRD 提前一天发出来，@Lin Yuan 准备一下接口口径。' }),
  m({ channel: 'lark', connector_id: 'cn_lark', conversation: '远川试点项目群', sender_name: '梁晚晴', sender_id: 'ou_liangwq', at: minsAgo(95),
    text: '@Broleez 试点账号开通了吗？我们这边财务部明天想先试一下审批流。' }),
  m({ channel: 'slack', connector_id: 'cn_slack', conversation: '#release', sender_name: 'Zhou Yu', sender_id: 'U04ZHOUYU0', at: minsAgo(140), read: true,
    text: '@here 今晚 22 点发 2.8 版本，期间权限页只读，有要一起带上的改动下午六点前说。' }),
  m({ channel: 'slack', connector_id: 'cn_slack', conversation: '#feedback', sender_name: 'Kevin Wu', sender_id: 'U07KEVINWU', at: minsAgo(320), read: true,
    text: '@Chen Ruoxi 导出按钮的新位置设计稿出了吗？客户那边在催。' }),
]

/** 「我」在各渠道里被叫的名字：@ 到这些就算 @我 */
export const MY_HANDLES = ['Broleez', 'broleez', '我']
/** 群发型的 @：@所有人、@here 这类 */
export const ALL_HANDLES = ['所有人', '全体成员', 'all', 'here', 'channel', 'everyone']

export const QUICK_REPLIES: { text: string; done: boolean }[] = [
  { text: '收到，我看一下', done: false },
  { text: '稍后回复你', done: false },
  { text: '已处理，请查看', done: true },
  { text: '这个需求记下了，排期后同步你', done: true },
]

/* ---------- 内容 ---------- */

// 文档分类就是「文档」页内容树的一级文件夹。加分类往这里加一行
export const CONTENT_CATEGORIES = [
  { key: 'doc', label: '文档' },
  { key: 'note', label: '笔记' },
  { key: 'meeting', label: '会议纪要' },
  { key: 'clip', label: '摘录' },
] as const
export type ContentCategory = (typeof CONTENT_CATEGORIES)[number]['key']

export interface ContentItem {
  id: string
  category: ContentCategory
  title: string
  /** 正文用轻量 Markdown：# 标题、- 列表、1. 有序、> 引用、``` 代码块、**粗体**、`行内代码` */
  body: string
  /** 从哪来的：手写 / 某条 IM 消息 / 外部链接 */
  source: string
  tags: string[]
  starred: boolean
  updated_at: string
}

export const seedContent: ContentItem[] = [
  { id: 'dc_001', category: 'doc', title: '租户级权限模型 PRD v0.3', source: '手写', tags: ['云端', '权限'], starred: true, updated_at: minsAgo(40),
    body: `# 背景

现在角色写死三种（管理员 / 成员 / 访客），试点客户远川科技要求**按部门自定义角色**，月底演示要带上。

## 目标

- 管理员能新建角色，并按模块勾选权限点
- 权限变更 1 分钟内生效
- 每次变更都有审计日志，可导出

## 不做

- 字段级权限（下一期）
- 跨租户共享角色

## 权限点分组

1. 工作对象：查看、创建、编辑、删除、导出
2. 成员管理：邀请、移除、改角色
3. 系统设置：连接器、计费、审计日志

> 周屿提醒：1 分钟生效需要改缓存方案，可能影响排期，待评估。

## 接口草案

\`\`\`
POST /api/roles
{ "name": "财务只读", "permissions": ["object.read", "object.export"] }
\`\`\`

## 待确认

- 内置的三个角色能否被修改？倾向于只读，避免误操作把管理员权限删光
- 删除角色时，持有该角色的成员落到哪个角色？` },
  { id: 'dc_002', category: 'meeting', title: '10 月第四周产品例会', source: '手写', tags: ['例会'], starred: false, updated_at: minsAgo(60 * 26),
    body: `# 参会

林予安、周屿、陈若溪、何牧、我

## 结论

- 权限模型 PRD 本周五前定稿，下周一评审
- 列表首屏性能优化延期一周，先保权限
- 导出按钮挪到列表工具条（来自 Slack #feedback 的客户反馈）

## 待办

1. 我：周四前把权限点清单和周屿对齐
2. 陈若溪：角色管理页设计稿更新分组方式
3. 何牧：补权限变更的回归用例

## 风险

> 欧盟数据驻留的法务口径还没回，如果下周还不回，Nordlicht 那边的方案要往后推。` },
  { id: 'dc_003', category: 'note', title: '审批流可以复用工单的状态机', source: '手写', tags: ['灵感'], starred: false, updated_at: minsAgo(60 * 50),
    body: `运营后台的租户开通审批，和工单的状态流转几乎一样：**待提交 → 审批中 → 通过 / 驳回**，驳回后可以重新提交。

如果直接复用工单的状态机：

- 审计日志、超时提醒、转派这三样都是现成的
- 前端的时间线组件也能直接用

要确认的是工单状态机能不能挂自定义的审批人规则，比如「金额大于 X 要总监审批」。` },
  { id: 'dc_004', category: 'clip', title: 'Mia：欧盟数据驻留的法务要求', source: 'Telegram · Mia Hoffmann', tags: ['欧盟', '合规'], starred: true, updated_at: minsAgo(18),
    body: `> Hi, our legal team confirmed the EU data residency requirements. Can we schedule a call this week to walk through the storage design?

## 我的理解

- 欧盟租户的业务数据要落在欧盟境内的机房
- 运维访问需要留痕，并能按客户要求导出访问记录
- 备份也不能出境

## 下一步

1. 约本周四下午的电话，时差 7 小时，北京时间 16:00 比较合适
2. 会前把现有的存储架构图发给她` },
  { id: 'dc_005', category: 'clip', title: '客户反馈：导出按钮找不到', source: 'Slack · #feedback', tags: ['反馈'], starred: false, updated_at: minsAgo(52),
    body: `> 客户反馈导出按钮藏得太深，在列表页找了半天才找到，能不能放到工具条上？

已在 10 月第四周例会上确认挪到列表工具条，跟权限模型一起上线。` },
  { id: 'dc_006', category: 'doc', title: '离线同步方案对比', source: '手写', tags: ['客户端'], starred: false, updated_at: minsAgo(60 * 24 * 5),
    body: `# 候选方案

## 方案 A：操作日志回放

客户端记录每一步操作，联网后按顺序回放到服务端。

- 优点：冲突能精确到字段
- 缺点：日志会越来越大，需要定期压缩

## 方案 B：整条覆盖 + 冲突提示

以对象为单位，联网时比较版本号，版本落后就提示用户选保留哪一份。

- 优点：实现简单
- 缺点：两个人改同一条的不同字段也会被判为冲突

## 倾向

先上方案 B，冲突率高于 5% 再考虑 A。` },
  { id: 'dc_007', category: 'note', title: '工作日志 10/27', source: '手写', tags: ['日志'], starred: false, updated_at: minsAgo(60 * 30),
    body: `- 上午：过了一遍陈若溪的角色管理设计稿，分组方式要改
- 下午：和顾北辰聊合规，他建议审计日志至少保留 180 天
- 晚上：整理客户访谈纪要，还剩两份没写完` },
  // 周报助手写的两篇：定时执行写的初稿，和会话里按项目重写的版本（agentdata 的 ar3、ss2 指向这两篇）
  { id: 'dc_w43', category: 'note', title: '第 43 周周报', source: '周报助手 · 定时执行', tags: ['周报'], starred: false, updated_at: minsAgo(60 * 24 * 5),
    body: `# 第 43 周周报

## 已完成（5）
- 权限模型 PRD 评审
- 角色管理设计稿 v4 过稿
- 远川试点环境开通

## 进行中（3）
- 导出任务超时：后端在查慢查询
- 权限变更生效时间：缓存方案待和后端对齐

## 下周计划
- 整理 Q4 路线图初稿` },
  { id: 'dc_w43r', category: 'note', title: '第 43 周周报（按项目重写）', source: '周报助手 · 会话', tags: ['周报'], starred: false, updated_at: minsAgo(60 * 24 * 5 - 30),
    body: `# 第 43 周周报

## 权限改造
- 已完成：PRD 评审、设计稿 v4
- 进行中：权限变更 1 分钟内生效的缓存方案

## 一人之下
- 进行中：导出任务超时
- 下周：Q4 路线图初稿` },
]

/* ---------- 立即同步（模拟）：各渠道还没收进来的消息，按顺序陆续到达 ---------- */
export type IncomingMessage = Pick<Message, 'conversation' | 'sender_name' | 'sender_id' | 'text'> & { attachments?: MsgAttachment[] }
export const SYNC_POOL: Record<string, IncomingMessage[][]> = {
  slack: [
    [{ conversation: '#product', sender_name: 'Lin Yuan', sender_id: 'U04LINYUAN', text: '@Broleez 权限点清单我又补了 3 条，主要是导出和审计日志，麻烦再看一眼。' }],
    [{ conversation: '#release', sender_name: 'Zhou Yu', sender_id: 'U04ZHOUYU0', text: '2.8 预发环境已经部署好了，权限页可以开始验收。' },
      { conversation: '', sender_name: 'Chen Ruoxi', sender_id: 'U05CHENRX0', text: '角色管理 v5 改了空状态，你有空看下这版是不是更清楚。' }],
  ],
  lark: [
    [{ conversation: '远川试点项目群', sender_name: '许知行', sender_id: 'ou_7f3a9c21', text: '@Broleez 演示时间定在下周三下午两点，我们这边会有 6 个人参加。' }],
    [{ conversation: '远川试点项目群', sender_name: '梁晚晴', sender_id: 'ou_liangwq', text: '服务协议我们法务改了两处，改过的版本放附件了。',
      attachments: [{ id: 'att_sync1', name: '服务协议-远川修订.docx', kind: 'file', size: 64512, fetch: 'idle' }] }],
  ],
  telegram: [
    [{ conversation: '', sender_name: 'Mia Hoffmann', sender_id: '@mia_nordlicht', text: 'Thursday 3pm CET works for us. I will send the invite with our DPO included.' }],
  ],
  wechat: [
    [{ conversation: '', sender_name: '宋砚', sender_id: 'songyan_logi', text: '审批流 demo 能不能提前到这周五？我们老板周五有空。' }],
  ],
}
