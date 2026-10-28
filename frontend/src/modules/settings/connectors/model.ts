// 连接器抽屉的草稿和请求体（纯函数，单元测试盯着）。
// 凭证三态：输入框空着就不带（不改），清掉走单独的确认（传空串），填了才覆盖；界面上只显示后端给的 secret_hints。
// 工具授权的改动先记在草稿里（只记和后端不同的），保存时一次 PATCH /tools。
import type {
  Connector, ConnectorAuthMode, ConnectorDef, ConnectorDirection, ConnectorInput, ConnectorPatch, ConnectorTool, ConnectorToolMode,
} from '../../../core/data'

/** 这次打开页面以来最近一次连通测试的结论 */
export type ConnCheck = { ok: boolean; message: string; at: number }

export type Draft = {
  name: string
  authMode: ConnectorAuthMode
  /** 非凭证字段 */
  config: Record<string, string>
  /** 这次新填的凭证，空串表示不改 */
  secrets: Record<string, string>
  direction: ConnectorDirection
  interval: number
  enabled: boolean
  /** 改过的工具授权：工具名 -> 新授权 */
  modes: Record<string, ConnectorToolMode>
}

export const isIM = (def: ConnectorDef) => def.category === 'im'
const plainFields = (def: ConnectorDef) => def.fields.filter((f) => f.kind !== 'secret')
const secretFields = (def: ConnectorDef) => def.fields.filter((f) => f.kind === 'secret')

/** 定义不在了（插件停用）时，抽屉按实例拼一个最小定义：只能改名、启停和删除 */
export function fallbackDef(c: Connector): ConnectorDef {
  return { tool: c.tool, label: c.tool, category: 'other', color: '', desc: '提供它的插件已停用', can_send: false, auth: [c.auth_mode], fields: [], tools: [], source: '' }
}

export function initialDraft(def: ConnectorDef, c?: Connector): Draft {
  if (!c) {
    return {
      name: def.label,
      authMode: def.auth[0] ?? 'token',
      // 下拉新建时默认第一项
      config: Object.fromEntries(plainFields(def).map((f) => [f.key, f.kind === 'select' ? f.options?.[0] ?? '' : ''])),
      secrets: Object.fromEntries(secretFields(def).map((f) => [f.key, ''])),
      direction: def.can_send ? 'both' : 'receive',
      interval: isIM(def) ? 5 : 0,
      enabled: true,
      modes: {},
    }
  }
  return {
    name: c.name,
    authMode: c.auth_mode,
    config: Object.fromEntries(plainFields(def).map((f) => [f.key, c.config[f.key] ?? ''])),
    secrets: Object.fromEntries(secretFields(def).map((f) => [f.key, ''])),
    direction: c.direction,
    interval: c.interval,
    enabled: c.status !== 'paused',
    modes: {},
  }
}

/** 必填没填的字段 key。凭证已经配过（有 hint）就不算没填 */
export function missingFields(def: ConnectorDef, d: Draft, c?: Connector): string[] {
  return def.fields.filter((f) => {
    if (!f.required) return false
    if (f.kind === 'secret') return !d.secrets[f.key]?.trim() && !c?.secret_hints[f.key]
    return !d.config[f.key]?.trim()
  }).map((f) => f.key)
}

const nonEmpty = (m: Record<string, string>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v))

export function createBody(def: ConnectorDef, d: Draft): ConnectorInput {
  const body: ConnectorInput = { tool: def.tool, name: d.name.trim(), auth_mode: d.authMode, enabled: d.enabled }
  const config = nonEmpty(d.config)
  const secrets = nonEmpty(d.secrets)
  if (Object.keys(config).length) body.config = config
  if (Object.keys(secrets).length) body.secrets = secrets
  if (isIM(def)) {
    body.direction = d.direction
    body.interval = d.interval
  }
  return body
}

/** 只带改了的字段；凭证没填不带，config 清空的键传空串 */
export function patchBody(def: ConnectorDef, d: Draft, c: Connector): ConnectorPatch {
  const patch: ConnectorPatch = {}
  const name = d.name.trim()
  if (name !== c.name) patch.name = name
  if (d.authMode !== c.auth_mode) patch.auth_mode = d.authMode
  const config: Record<string, string> = {}
  for (const f of plainFields(def)) {
    const v = (d.config[f.key] ?? '').trim()
    if (v !== (c.config[f.key] ?? '')) config[f.key] = v
  }
  if (Object.keys(config).length) patch.config = config
  const secrets = nonEmpty(d.secrets)
  if (Object.keys(secrets).length) patch.secrets = secrets
  if (d.enabled !== (c.status !== 'paused')) patch.enabled = d.enabled
  if (isIM(def)) {
    if (d.direction !== c.direction) patch.direction = d.direction
    if (d.interval !== c.interval) patch.interval = d.interval
  }
  return patch
}

/** 只读工具没有「需确认」 */
export const modesFor = (t: Pick<ConnectorTool, 'write'>): ConnectorToolMode[] => (t.write ? ['off', 'confirm', 'auto'] : ['off', 'auto'])

/** 抽屉里显示的工具：后端的清单叠上草稿里改过的授权 */
export const effectiveTools = (tools: ConnectorTool[], modes: Record<string, ConnectorToolMode>): ConnectorTool[] =>
  tools.map((t) => (modes[t.name] ? { ...t, mode: modes[t.name] } : t))

/** 只留和后端不同、工具还在、授权合法的改动；拉取清单后用它清一遍 */
export function pruneModes(tools: ConnectorTool[], modes: Record<string, ConnectorToolMode>): Record<string, ConnectorToolMode> {
  const out: Record<string, ConnectorToolMode> = {}
  for (const [name, m] of Object.entries(modes)) {
    const t = tools.find((x) => x.name === name)
    if (t && t.mode !== m && modesFor(t).includes(m)) out[name] = m
  }
  return out
}

export type Bulk = 'recommended' | 'readonly' | 'off'
const BULK: Record<Bulk, (t: ConnectorTool) => ConnectorToolMode> = {
  recommended: (t) => (t.write ? 'confirm' : 'auto'),
  readonly: (t) => (t.write ? 'off' : 'auto'),
  off: () => 'off',
}

/** 批量改授权：按推荐（写操作需确认、只读自动）、只开只读、全部关闭 */
export function bulkModes(tools: ConnectorTool[], kind: Bulk): Record<string, ConnectorToolMode> {
  return pruneModes(tools, Object.fromEntries(tools.map((t) => [t.name, BULK[kind](t)])))
}

/** 测试、拉清单前差什么；就绪是空串 */
export function notReady(def: ConnectorDef, d: Draft, c?: Connector): string {
  if (c && !c.available) return '提供它的插件已停用'
  const missing = missingFields(def, d, c)
  if (missing.length) return `还没填：${missing.map((k) => def.fields.find((f) => f.key === k)?.label ?? k).join('、')}`
  if (d.authMode === 'oauth2') return 'OAuth 授权还没开放，先用 Token'
  return ''
}

/** 拉取清单后的说明：第一次和重新获取写法不同 */
export function refreshNote(before: number, r: { added: string[]; removed: string[]; connector: Connector }): string {
  if (!before) return `发现 ${r.connector.tools.length} 个工具：只读的默认自动，写操作默认需确认`
  return `新增 ${r.added.length} 个，移除 ${r.removed.length} 个，其余保留原来的权限`
}

/** 列表行第二行：应用类写认证方式和可用工具数，IM 类写方向和上次同步 */
export function rowSummary(def: ConnectorDef | undefined, c: Connector, authLabel: string, now = Date.now()): string {
  if (def && isIM(def)) {
    return `${c.direction === 'both' ? '收发' : '只收'} · ${c.last_sync_at ? `${ago(c.last_sync_at, now)}同步` : '未同步'}`
  }
  return `${authLabel} · ${c.tools.filter((t) => t.mode !== 'off').length}/${c.tools.length} 个工具可用`
}

export function ago(iso: string, now = Date.now()): string {
  const m = Math.round((now - new Date(iso).getTime()) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  if (m < 1440) return `${Math.floor(m / 60)} 小时前`
  return `${Math.floor(m / 1440)} 天前`
}
