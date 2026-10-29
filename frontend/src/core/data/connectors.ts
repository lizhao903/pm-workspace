// 连接器（CONN-01d、CONN-04）：定义列表、实例增删改查、连通测试、拉工具清单、改工具授权。契约见 docs/api-contract.md「连接器 connectors」。
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
  setToolModes: async (id: string, modes: Record<string, ConnectorToolMode>) =>
    normConnector(await request<Connector>('PATCH', `${path(id)}/tools`, { body: { modes } })),
}

/** 定义在代码里登记；插件启停时会变（CONN-02），由失效规则 plugin 刷新，其余时候不变，缓存久一点 */
export function useConnectorDefs() {
  return useQuery({ queryKey: dataKeys.connectors.defs, queryFn: connectorsApi.defs, staleTime: 5 * 60_000 })
}

export function useConnectors() {
  return useQuery({ queryKey: dataKeys.connectors.list, queryFn: connectorsApi.list })
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
