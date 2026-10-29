// 内网域名插件 domains（DOM-01b）：设置、路由、本机状态、生成的配置。契约见 docs/api-contract.md「内网域名插件 domains」（DOM-01a）。
// 插件只读检测、只生成配置和命令，不改系统；状态每次现测，进分节测一次，「重新检测」再测，不跟着窗口聚焦重测。
// 写操作报 { kind: 'domains' }：后缀、端口、路由一变，完整域名、状态、配置都跟着变，整个前缀一起刷。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestList } from '../api'
import { domainKeys } from './domainKeys'
import { useNotifyChange } from './invalidate'

export type DomainResolve = 'hosts' | 'local_dns' | 'router_dns'
export type DomainProxy = 'builtin' | 'caddy' | 'nginx'

export type DomainSettings = {
  enabled: boolean
  suffix: string
  resolve: DomainResolve
  proxy: DomainProxy
  https: boolean
  /** 只为和原型同形，证书状态以 status 的检测为准 */
  ca_installed: boolean
  lan: boolean
  lan_ip: string
  auto_proto: boolean
  /** 工作台的别名（完整域名），和工作台那条路由一起出现在 hosts、状态和证书里 */
  aliases: string[]
  /** pf 把 80、443 转到的工作台明文口和 TLS 口 */
  http_port: number
  https_port: number
  updated_at: string
}

export type DomainSettingsPatch = Partial<Omit<DomainSettings, 'updated_at'>>

export type DomainTarget = { kind: 'app' } | { kind: 'proto'; proto_id: string } | { kind: 'url'; url: string }

export type DomainCheck = { ok: boolean; at: string; message: string }

export type DomainRoute = {
  /** dm_ 前缀；工作台那条是 dm_app */
  id: string
  /** 子域名；只有目标是工作台的可以为空（完整域名就是后缀本身） */
  host: string
  fqdn: string
  target: DomainTarget
  enabled: boolean
  /** 项目原型自动分配的（DOM-02a 建）；改过就转成手动 */
  auto: boolean
  note: string
  /** 最近一次测试，按完整域名记，没测过为 null */
  check: DomainCheck | null
  created_at: string
  updated_at: string
}

export type DomainRouteInput = { host: string; target: DomainTarget; enabled?: boolean; note?: string }
export type DomainRoutePatch = { host?: string; target?: DomainTarget; enabled?: boolean; note?: string }

export type DomainFix = { text: string; commands: string[] }
export type DomainStatusState = 'ok' | 'problem' | 'unknown'
export type DomainStatusItem = {
  key: string
  group: string
  name: string
  state: DomainStatusState
  message: string
  fix?: DomainFix
  detail?: Record<string, unknown>
}
export type DomainStatus = {
  checked_at: string
  enabled: boolean
  domains: string[]
  service: { addr?: string; tls_addr?: string }
  items: DomainStatusItem[]
  summary: Record<DomainStatusState, number>
}

export type DomainConfigSection = { kind: string; path?: string; content: string; commands: string[]; note?: string }
export type DomainConfig = {
  proxy: DomainProxy
  domains: string[]
  resolve: DomainConfigSection
  pf: DomainConfigSection
  proxy_config: DomainConfigSection
  /** HTTPS 开着才有 */
  cert: DomainConfigSection | null
}

const base = '/api/domains'
const routePath = (id: string) => `${base}/routes/${encodeURIComponent(id)}`

export const domainsApi = {
  settings: (signal?: AbortSignal) => request<DomainSettings>('GET', `${base}/settings`, { signal }),
  putSettings: (body: DomainSettingsPatch) => request<DomainSettings>('PUT', `${base}/settings`, { body }),
  routes: async (signal?: AbortSignal) => (await requestList<DomainRoute>(`${base}/routes`, { signal })).data,
  addRoute: (body: DomainRouteInput) => request<DomainRoute>('POST', `${base}/routes`, { body }),
  patchRoute: (id: string, body: DomainRoutePatch) => request<DomainRoute>('PATCH', routePath(id), { body }),
  removeRoute: (id: string) => request<null>('DELETE', routePath(id)),
  checkRoute: (id: string) => request<{ id: string; fqdn: string; check: DomainCheck }>('POST', `${routePath(id)}/check`),
  status: (signal?: AbortSignal) => request<DomainStatus>('GET', `${base}/status`, { signal }),
  config: (signal?: AbortSignal) => request<DomainConfig>('GET', `${base}/config`, { signal }),
}

export function useDomainSettings() {
  return useQuery({ queryKey: domainKeys.settings, queryFn: ({ signal }) => domainsApi.settings(signal) })
}

/** 按创建先后，不分页 */
export function useDomainRoutes() {
  return useQuery({ queryKey: domainKeys.routes, queryFn: ({ signal }) => domainsApi.routes(signal) })
}

/** 本机状态：每次现测，窗口聚焦不重测；要再测调 refetch（「重新检测」） */
export function useDomainStatus() {
  return useQuery({
    queryKey: domainKeys.status,
    queryFn: ({ signal }) => domainsApi.status(signal),
    staleTime: 0,
    refetchOnWindowFocus: false,
  })
}

/** 生成的配置，按设置里的代理 */
export function useDomainConfig() {
  return useQuery({ queryKey: domainKeys.config, queryFn: ({ signal }) => domainsApi.config(signal), refetchOnWindowFocus: false })
}

/** 改设置（只传改的字段）：回来的整份先写回缓存，开关不闪，再刷路由、状态和配置 */
export function usePutDomainSettings() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (patch: DomainSettingsPatch) => domainsApi.putSettings(patch),
    onSuccess: (s) => {
      qc.setQueryData(domainKeys.settings, s)
      return notify({ kind: 'domains' })
    },
  })
}

export function useAddDomainRoute() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (body: DomainRouteInput) => domainsApi.addRoute(body),
    onSuccess: () => notify({ kind: 'domains' }),
  })
}

export function usePatchDomainRoute() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: DomainRoutePatch }) => domainsApi.patchRoute(id, patch),
    onSuccess: () => notify({ kind: 'domains' }),
  })
}

export function useDeleteDomainRoute() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (id: string) => domainsApi.removeRoute(id),
    onSuccess: () => notify({ kind: 'domains' }),
  })
}

/** 测试一次：结果按完整域名另存在后端，不改路由；只刷路由列表拿回 check */
export function useCheckDomainRoute() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (id: string) => domainsApi.checkRoute(id),
    onSettled: () => notify({ kind: 'domain-check' }),
  })
}
