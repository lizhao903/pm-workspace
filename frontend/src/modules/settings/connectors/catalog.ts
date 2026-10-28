// 连接器分节的显示用常量：分类、状态、认证方式、工具授权的中文名，照原型 web-next/src/data.ts、connectors.tsx、apiconn.tsx。
// 定义本身（有哪些工具、字段、认证方式）一律从后端 /api/connectors/defs 读，这里不写厂商。
import type { ConnectorAuthMode, ConnectorStatus, ConnectorToolMode } from '../../../core/data'

export type Category = { key: string; label: string; desc: string }

/** 分类按原型 TOOL_CATEGORIES 的顺序；后端给了不认识的分类归到「其他」 */
export const CATEGORIES: Category[] = [
  { key: 'im', label: '即时通讯', desc: '把各 IM 的消息收进工作台，并能直接从工作台回复' },
  { key: 'dev', label: '研发协作', desc: '代码仓库、需求和缺陷、线上告警' },
  { key: 'docs', label: '文档知识', desc: '团队的文档、知识库和云盘' },
  { key: 'office', label: '日程邮件', desc: '日历、邮箱' },
  { key: 'crm', label: '客户与服务', desc: 'CRM、客服工单' },
  { key: 'data', label: '数据与搜索', desc: '数据库、网页搜索、公开数据接口' },
  { key: 'media', label: '内容平台', desc: '视频平台的上传发布、数据和评论，配音用的语音合成' },
  { key: 'market', label: '行情数据', desc: '数币、A 股、港股、美股的行情来源' },
  { key: 'custom', label: '自定义', desc: '自己的 MCP 服务或 OpenAPI 接口' },
]
export const OTHER: Category = { key: 'other', label: '其他', desc: '' }

export const categoryOf = (key: string): Category => CATEGORIES.find((c) => c.key === key) ?? OTHER

export const STATUS: Record<ConnectorStatus, { label: string; tone: 'ok' | 'danger' | 'muted' | 'info' }> = {
  connected: { label: '已连接', tone: 'ok' },
  error: { label: '异常', tone: 'danger' },
  paused: { label: '已暂停', tone: 'muted' },
  connecting: { label: '连接中', tone: 'info' },
  disconnected: { label: '已断开', tone: 'muted' },
}

export const AUTH_LABEL: Record<ConnectorAuthMode, string> = { none: '无授权', oauth2: 'OAuth 2.0', token: 'Token' }
export const AUTH_HINT: Record<ConnectorAuthMode, string> = {
  none: '公开接口，不需要凭证。只适合不涉及账号数据的服务',
  oauth2: '跳转到对方页面登录授权，拿到的令牌到期前会自动续期',
  token: '填 API Key 或个人访问令牌，请求时放在请求头里',
}

export const MODE_LABEL: Record<ConnectorToolMode, string> = { off: '关闭', confirm: '需确认', auto: '自动' }

/** 断开前的确认文案：列表和抽屉共用 */
export const OFF_HINT = '断开后收不到消息，Agent 也调不了它的工具'

/** IM 的拉取间隔，分钟 */
export const INTERVALS = [1, 5, 10, 15, 30, 60]
