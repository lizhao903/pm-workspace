// 连接器（CONN-01d、CONN-04、CONN-04b）：定义列表、实例增删改查、连通测试、拉工具清单、改工具授权、发起 OAuth 授权。契约见 docs/api-contract.md「连接器 connectors」。
// 定义在后端代码里登记（不进库），界面按定义渲染认证字段，不写死厂商。凭证只写不读，响应里只有 secret_hints。
// 测试、拉清单的响应带着最新的实例，先写进列表缓存再按失效规则刷一遍。
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { request, requestList } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'

export type ConnectorAuthMode = 'none' | 'oauth2' | 'token'
export type ConnectorToolMode = 'off' | 'confirm' | 'auto'
export type ConnectorStatus = 'connecting' | 'connected' | 'error' | 'paused' | 'disconnected'
export type ConnectorDirection = 'receive' | 'both'

export type ConnectorField = {
  key: string
  label: string
  kind: 'text' | 'secret' | 'select'
  placeholder?: string
  options?: string[]
  required: boolean
  /** 非空时这个字段只属于这几种认证方式：别的方式下不显示、不算必填（CONN-04） */
  auth?: ConnectorAuthMode[]
  /** 新建时的默认值 */
  default?: string
  /** 长文本，多行输入（如粘贴的 OpenAPI 文档） */
  long?: boolean
}

/** 定义里的 OAuth 配置：client_id 内置（builtin）或取 client_id_field 指的字段；自定义类的地址、范围也在字段里 */
export type ConnectorOAuthDef = {
  auth_url: string
  token_url: string
  scopes: string[] | null
  base_url_field?: string
  auth_url_field?: string
  token_url_field?: string
  scopes_field?: string
  client_id_field?: string
  client_secret_field?: string
  builtin: boolean
}

/** 实例的授权状态，时间为 null 表示没有；没授权或已断开时 authorized_at 为 null */
export type ConnectorOAuthState = {
  authorized_at: string | null
  expires_at: string | null
  refreshed_at: string | null
  refresh_failed_at: string | null
  scope: string
}

/** 发起授权：浏览器打开 authorize_url；expires_at 之后这次授权作废 */
export type ConnectorOAuthStart = { authorize_url: string; redirect_uri: string; expires_at: string }

/** schema 是参数的 JSON Schema，给模型看的，界面不用 */
export type ConnectorToolDef = { name: string; desc: string; write: boolean; schema?: unknown }
export type ConnectorTool = ConnectorToolDef & { mode: ConnectorToolMode }

export type ConnectorDef = {
  tool: string
  label: string
  /** im / dev / media / market 等，分类名前端按原型对照 */
  category: string
  color: string
  desc: string
  can_send: boolean
  /** 支持的认证方式，第一个是默认 */
  auth: ConnectorAuthMode[]
  fields: ConnectorField[]
  /** 静态工具目录 */
  tools: ConnectorToolDef[]
  /** core 或插件 id */
  source: string
  /** auth 不含 oauth2 时为 null；老测试桩里可能没有 */
  oauth?: ConnectorOAuthDef | null
}

export type Connector = {
  id: string
  tool: string
  name: string
  account: string
  status: ConnectorStatus
  error: string
  auth_mode: ConnectorAuthMode
  /** 非凭证字段 */
  config: Record<string, string>
  /** 凭证字段的脱敏提示，没有明文 */
  secret_hints: Record<string, string>
  direction: ConnectorDirection
  /** 同步间隔，分钟 */
  interval: number
  tools: ConnectorTool[]
  tools_at: string | null
  last_tested_at: string | null
  last_sync_at: string | null
  /** false：定义已不在（提供它的插件停用了），只能改名、启停和删除 */
  available: boolean
  /** 自定义分类换的图标（data URL），没换为空串；老数据和测试桩里可能没有 */
  icon?: string
  /** auth_mode 不是 oauth2 时为 null */
  oauth?: ConnectorOAuthState | null
  created_at: string
  updated_at: string
}

export type ConnectorInput = {
  tool: string
  name?: string
  auth_mode?: ConnectorAuthMode
  config?: Record<string, string>
  /** 明文只写；PATCH 时空串表示清掉 */
  secrets?: Record<string, string>
  enabled?: boolean
  direction?: ConnectorDirection
  interval?: number
  /** 只有自定义分类能换；空串换回默认图标 */
  icon?: string
}
export type ConnectorPatch = Partial<Omit<ConnectorInput, 'tool'>>

/** 连不上不是接口错误：ok=false，message 是对方的说明（凭证原文已被后端抹掉） */
export type ConnectorTestResult = { ok: boolean; account: string; message: string; connector: Connector }
export type ConnectorRefreshResult = { added: string[]; removed: string[]; connector: Connector }

// 后端的空数组、空对象可能是 null，这里一次补齐
const normDef = (d: ConnectorDef): ConnectorDef => ({ ...d, auth: d.auth ?? [], fields: d.fields ?? [], tools: d.tools ?? [] })
export const normConnector = (c: Connector): Connector => ({
  ...c, config: c.config ?? {}, secret_hints: c.secret_hints ?? {}, tools: c.tools ?? [], error: c.error ?? '', account: c.account ?? '',
  icon: c.icon ?? '',
})

const path = (id: string) => `/api/connectors/${encodeURIComponent(id)}`

export const connectorsApi = {
  defs: async () => (await requestList<ConnectorDef>('/api/connectors/defs')).data.map(normDef),
  list: async () => (await requestList<Connector>('/api/connectors')).data.map(normConnector),
  create: async (body: ConnectorInput) => normConnector(await request<Connector>('POST', '/api/connectors', { body })),
  patch: async (id: string, body: ConnectorPatch) => normConnector(await request<Connector>('PATCH', path(id), { body })),
  remove: (id: string) => request<Connector>('DELETE', path(id)),
  test: async (id: string) => {
    const r = await request<ConnectorTestResult>('POST', `${path(id)}/test`, { body: {} })
    return { ...r, connector: normConnector(r.connector) }
  },
  refreshTools: async (id: string) => {
    const r = await request<ConnectorRefreshResult>('POST', `${path(id)}/tools/refresh`, { body: {} })
    return { ...r, added: r.added ?? [], removed: r.removed ?? [], connector: normConnector(r.connector) }
  },
  /** 按已保存的配置发起授权；returnTo 是授权结束后浏览器回到哪 */
  oauthStart: (id: string, returnTo?: string) =>
    request<ConnectorOAuthStart>('POST', `${path(id)}/oauth/start`, { body: returnTo ? { return_to: returnTo } : {} }),
  setToolModes: async (id: string, modes: Record<string, ConnectorToolMode>) =>
    normConnector(await request<Connector>('PATCH', `${path(id)}/tools`, { body: { modes } })),
}

/** 定义在代码里登记；插件启停时会变（CONN-02），由失效规则 plugin 刷新，其余时候不变，缓存久一点 */
export function useConnectorDefs() {
  return useQuery({ queryKey: dataKeys.connectors.defs, queryFn: connectorsApi.defs, staleTime: 5 * 60_000 })
}

/** poll 给毫秒数时定时重取（等 OAuth 授权完成） */
export function useConnectors(poll: number | false = false) {
  return useQuery({ queryKey: dataKeys.connectors.list, queryFn: connectorsApi.list, refetchInterval: poll })
}

/** 把响应里的最新实例先放进列表缓存，界面不用等重新取 */
function putConnector(qc: QueryClient, c: Connector) {
  qc.setQueryData<Connector[]>(dataKeys.connectors.list, (old) => old?.map((x) => (x.id === c.id ? c : x)))
}

export function useCreateConnector() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (input: ConnectorInput) => connectorsApi.create(input),
    onSuccess: () => notify({ kind: 'connector' }),
  })
}

export function usePatchConnector() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ConnectorPatch }) => connectorsApi.patch(id, patch),
    onSuccess: (c) => {
      putConnector(qc, c)
      return notify({ kind: 'connector' })
    },
  })
}

export function useDeleteConnector() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (id: string) => connectorsApi.remove(id),
    onSuccess: () => notify({ kind: 'connector' }),
  })
}

export function useTestConnector() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (id: string) => connectorsApi.test(id),
    onSuccess: (r) => {
      putConnector(qc, r.connector)
      return notify({ kind: 'connector' })
    },
  })
}

/** 拉取失败回 409，工具清单不变 */
export function useRefreshConnectorTools() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (id: string) => connectorsApi.refreshTools(id),
    onSuccess: (r) => {
      putConnector(qc, r.connector)
      return notify({ kind: 'connector' })
    },
  })
}

/** 只改给了的工具；只读工具不能设 confirm */
export function useSetConnectorToolModes() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, modes }: { id: string; modes: Record<string, ConnectorToolMode> }) => connectorsApi.setToolModes(id, modes),
    onSuccess: (c) => {
      putConnector(qc, c)
      return notify({ kind: 'connector' })
    },
  })
}

/** 发起 OAuth 授权：只拿授权地址，实例要等回调换完令牌才变，不在这里失效 */
export function useStartConnectorOAuth() {
  return useMutation({ mutationFn: ({ id, returnTo }: { id: string; returnTo?: string }) => connectorsApi.oauthStart(id, returnTo) })
}
