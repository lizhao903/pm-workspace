// 模型服务商的增删改、设默认、测试连接（MP-01b）。契约见 docs/api-contract.md「Agent 供应商」。
// 列表和类型沿用 agent.ts（AG-01a）；测试结果写进 agentKeys.models(id)，Agent 的模型下拉同一份缓存。
// 改了连接配置的服务商把它的测试结果丢掉：凭证或地址变了，上次的结论不作数。
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import { request } from '../api'
import { agentApi, type AgentProvider, type ProviderTestResult } from './agent'
import { agentKeys } from './agentKeys'
import { useNotifyChange } from './invalidate'

/** 后端认的协议；兼容 OpenAI 的厂商用 openai 加 extra.preset */
export type ProviderProtocol = 'openai' | 'anthropic' | 'gemini' | 'ollama'

export type ProviderInput = {
  name: string
  kind: ProviderProtocol
  base_url?: string
  model?: string
  enabled?: boolean
  api_key?: string
  extra?: Record<string, unknown>
}

/** api_key 省略表示不改，空串表示清空；extra 整体替换 */
export type ProviderPatch = Partial<Omit<ProviderInput, 'kind'>> & { kind?: ProviderProtocol }

const path = (id: string) => `/api/agent-providers/${encodeURIComponent(id)}`

export const providersApi = {
  create: (body: ProviderInput) => request<AgentProvider>('POST', '/api/agent-providers', { body }),
  patch: (id: string, body: ProviderPatch) => request<AgentProvider>('PATCH', path(id), { body }),
  remove: (id: string) => request<null>('DELETE', path(id)),
  setDefault: (id: string) => request<AgentProvider>('POST', `${path(id)}/default`, { body: {} }),
  test: (id: string) => agentApi.testProvider(id),
}

/** 测试结果和测试时间；没测过是 undefined */
export type ProviderCheck = { result: ProviderTestResult; at: number }

/**
 * 各服务商最近一次的测试结果。只读，不会自己去测：本次打开页面测过的用内存里的那份（更新），
 * 没测过的用后端存的上一次结论（last_test），离开设置页或刷新后不再回到「未测试」。
 */
export function useProviderChecks(providers: readonly Pick<AgentProvider, 'id' | 'last_test'>[]): Record<string, ProviderCheck | undefined> {
  const ids = providers.map((p) => p.id)
  const qs = useQueries({
    queries: ids.map((id) => ({
      queryKey: agentKeys.models(id),
      queryFn: () => providersApi.test(id),
      enabled: false,
      staleTime: Infinity,
    })),
  })
  const out: Record<string, ProviderCheck | undefined> = {}
  providers.forEach((p, i) => {
    const q = qs[i]
    const saved = p.last_test ? { result: p.last_test, at: Date.parse(p.last_test.at) } : undefined
    out[p.id] = q?.data && (!saved || q.dataUpdatedAt >= saved.at) ? { result: q.data, at: q.dataUpdatedAt } : saved
  })
  return out
}

export function useCreateProvider() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (input: ProviderInput) => providersApi.create(input),
    onSuccess: () => notify({ kind: 'agent-provider' }),
  })
}

export function usePatchProvider() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ProviderPatch }) => providersApi.patch(id, patch),
    onSuccess: (_, { id, patch }) => {
      if (touchesConnection(patch)) qc.removeQueries({ queryKey: agentKeys.models(id), exact: true })
      return notify({ kind: 'agent-provider' })
    },
  })
}

/** 改了凭证、地址、协议、扩展配置或启停：上次的测试结论不作数；只改名称、默认模型不影响 */
const touchesConnection = (p: ProviderPatch) =>
  p.api_key !== undefined || p.base_url !== undefined || p.kind !== undefined || p.extra !== undefined || p.enabled !== undefined

/** 删掉默认服务商时，后端把最早接入的启用服务商提成默认 */
export function useDeleteProvider() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (id: string) => providersApi.remove(id),
    onSuccess: (_, id) => {
      qc.removeQueries({ queryKey: agentKeys.models(id), exact: true })
      return notify({ kind: 'agent-provider' })
    },
  })
}

export function useSetDefaultProvider() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (id: string) => providersApi.setDefault(id),
    onSuccess: () => notify({ kind: 'agent-provider' }),
  })
}

/** 测试连接：失败也是正常结果（ok=false），结果记进缓存给卡片状态和模型下拉用 */
export function useTestProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => providersApi.test(id),
    onSuccess: (r, id) => { qc.setQueryData(agentKeys.models(id), r) },
  })
}
