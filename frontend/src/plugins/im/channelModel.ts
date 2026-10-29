// 渠道配置（IM-01b）的纯函数：哪些是 IM 渠道、状态文案、同步结果的说明、Slack 表单的校验。面板见 ChannelPanel.tsx。
import { errorText, isApiError, type Connector, type ConnectorDef, type ConnectorStatus, type ImSyncResult } from '../../core/data'

/** 空状态给的入口，按这个顺序；后端没登记的定义显示成不可用 */
export const ENTRY_TOOLS = ['slack', 'telegram'] as const

export const STATUS_TEXT: Record<ConnectorStatus, { label: string; tone: 'ok' | 'bad' | 'muted' | 'info' }> = {
  connected: { label: '已连接', tone: 'ok' },
  error: { label: '异常', tone: 'bad' },
  paused: { label: '已停用', tone: 'muted' },
  connecting: { label: '连接中', tone: 'info' },
  disconnected: { label: '已断开', tone: 'muted' },
}

/** Slack App 要的 Bot Token Scopes：收频道、私有频道、私信、多人私信，查人名，回复，下载附件 */
export const SLACK_SCOPES = [
  'channels:read', 'channels:history', 'groups:read', 'groups:history', 'im:read', 'im:history', 'mpim:read', 'mpim:history',
  'users:read', 'chat:write', 'files:read',
]

/** 同步间隔（分钟）；0 是不定时，只收回调和手动同步 */
export const SYNC_INTERVALS = [0, 1, 5, 10, 15, 30, 60]
export const intervalLabel = (n: number) => (n > 0 ? `每 ${n} 分钟` : '不定时（只收回调）')

/** IM 类的定义 */
export const imDefs = (defs: readonly ConnectorDef[] | undefined) => (defs ?? []).filter((d) => d.category === 'im')

/** IM 类的实例，按定义顺序 */
export function imConnectors(defs: readonly ConnectorDef[] | undefined, list: readonly Connector[] | undefined) {
  const order = imDefs(defs).map((d) => d.tool)
  return (list ?? []).filter((c) => order.includes(c.tool)).sort((a, b) => order.indexOf(a.tool) - order.indexOf(b.tool))
}

/** 能「接入」的渠道：定义在、还没接过（一个工具只接一个账号）；ENTRY_TOOLS 在前 */
export function addableDefs(defs: readonly ConnectorDef[] | undefined, list: readonly Connector[] | undefined) {
  const used = new Set((list ?? []).map((c) => c.tool))
  const rank = (t: string) => { const i = (ENTRY_TOOLS as readonly string[]).indexOf(t); return i < 0 ? ENTRY_TOOLS.length : i }
  return imDefs(defs).filter((d) => !used.has(d.tool)).sort((a, b) => rank(a.tool) - rank(b.tool))
}

/** 立即同步的结果说明 */
export function syncText(r: ImSyncResult) {
  const n = r.ids.length
  return n ? `收到 ${n} 条新消息` : r.duplicates ? '没有新消息（都收过了）' : '没有新消息'
}

/** 立即同步失败的说明：渠道出错是 502，后端已把原因记到连接器上 */
export function syncErrorText(e: unknown) {
  if (isApiError(e, 'conflict')) return errorText(e)
  return errorText(e).replace(/^同步失败：/, '') || '同步失败'
}

/** Slack Bot Token：新建必填；已存过的留空不改；填了要以 xoxb- 开头（后端同样检查） */
export function slackTokenError(token: string, saved: boolean): string | undefined {
  const v = token.trim()
  if (!v) return saved ? undefined : '必填'
  if (v.startsWith('xoxp-') || v.startsWith('xoxe')) return '这是用户 Token，要填 Bot User OAuth Token（xoxb- 开头）'
  if (!v.startsWith('xoxb-')) return '要以 xoxb- 开头：Slack App 设置里 OAuth & Permissions 页的 Bot User OAuth Token'
  return undefined
}

/** 「我的称呼」（PR-19）：正文里按名字 @ 到这些也算 @我，微信、飞书这类按名字 @ 的渠道要填 */
export const SELF_NAMES_FIELD = 'self_names'
export const SELF_NAMES_HINT = '逗号分隔，正文里 @ 到它们也算「@我」；连通测试拿到的账号本来就认，不用重复填。改了只影响之后收到的消息'

/** Member ID：空，或 U、W 开头的编号 */
export const memberIdError = (s: string) => (!s.trim() || /^[UW][A-Z0-9]{2,}$/.test(s.trim()) ? undefined : 'Member ID 形如 U01ABCDEF，在 Slack 个人资料里「复制成员 ID」')

/** 事件订阅的回调地址：浏览器当前访问的地址 + 回调路径 */
export const callbackUrl = (tool: string, origin = typeof window === 'undefined' ? '' : window.location.origin) => `${origin}/api/im/callbacks/${tool}`
