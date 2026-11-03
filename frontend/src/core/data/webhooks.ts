// Webhook（TASK-02a、TASK-02b、TASK-04b）：配置、密钥轮换、投递记录、往收件地址推一次。契约见 docs/api-contract.md「Webhook 配置 webhooks」。
// 密钥明文只在新建、轮换由服务端生成的那一次响应里有（secret 字段），之后只剩 secret_hint。
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestList } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'

export type WebhookMapping = { title: string; desc: string; priority: string; assignee: string; due: string }
export type WebhookDefaults = { priority: string; assignee: string }

export type Webhook = {
  id: string
  name: string
  /** 收件地址的最后一段，不可改 */
  token: string
  enabled: boolean
  mapping: WebhookMapping
  filter: string
  dedupe: string
  defaults: WebhookDefaults
  sample: string
  /** 保险箱条目被单独删掉时为空串，secret_version 为 0 */
  secret_hint: string
  secret_version: number
  secret_rotated_at: string | null
  created_at: string
  updated_at: string
}

/** 新建、轮换的响应：服务端生成的密钥明文只在这一次给出；自带密钥时没有这个字段 */
export type WebhookWithSecret = Webhook & { secret?: string }

export type WebhookInput = {
  name: string
  enabled?: boolean
  mapping: WebhookMapping
  filter?: string
  dedupe?: string
  defaults?: WebhookDefaults
  sample?: string
}
export type WebhookPatch = Partial<Omit<WebhookInput, 'name' | 'mapping'>> & { name?: string; mapping?: WebhookMapping }

export type WebhookUsage = { tasks: number; open_tasks: number }

export type DeliveryResult = 'created' | 'skipped' | 'failed'

export type Delivery = {
  id: string
  hook_id: string
  at: string
  /** 原始请求体；不是 JSON 时是一个字符串 */
  payload: unknown
  result: DeliveryResult
  reason: string
  /** 建出的任务；重复推送时是之前建的那条；任务删了仍是原值 */
  task_id: string | null
  external_id: string
  dedupe_key: string
  mapped: WebhookMapping
  /** 读时现查：任务编号（硬删后为空串）、任务已删（含软删） */
  task_ref: string
  task_deleted: boolean
}

/** 签名头和投递 id 头，见契约「收件和投递记录」 */
export const SIGNATURE_HEADER = 'X-PMW-Signature'
export const DELIVERY_HEADER = 'X-PMW-Delivery'
/** 投递记录一次最多取的条数，和后端上限一致 */
export const DELIVERIES_MAX = 200

const path = (id: string) => `/api/webhooks/${encodeURIComponent(id)}`
/** 收件地址（相对当前站点） */
export const hookPath = (token: string) => `/api/hooks/${encodeURIComponent(token)}`

export const webhooksApi = {
  list: (signal?: AbortSignal) => requestList<Webhook>('/api/webhooks', { signal }).then((r) => r.data),
  create: (body: WebhookInput) => request<WebhookWithSecret>('POST', '/api/webhooks', { body }),
  patch: (id: string, body: WebhookPatch) => request<Webhook>('PATCH', path(id), { body }),
  rotate: (id: string) => request<WebhookWithSecret>('POST', `${path(id)}/rotate-secret`, { body: {} }),
  usage: (id: string, signal?: AbortSignal) => request<WebhookUsage>('GET', `${path(id)}/usage`, { signal }),
  delete: (id: string) => request<WebhookUsage>('DELETE', path(id)),
  deliveries: (id: string, limit: number, signal?: AbortSignal) =>
    requestList<Delivery>(`${path(id)}/deliveries`, { query: new URLSearchParams({ limit: String(limit) }), signal }),
  /** 往收件地址推一次；body 按 JSON.stringify 原样发出，签名要对同一串算 */
  push: (token: string, body: unknown, headers: Record<string, string>) =>
    request<Delivery>('POST', hookPath(token), { body, headers }),
}

/** 全部 Webhook，不分页，新建的在前 */
export function useWebhooks() {
  return useQuery({ queryKey: dataKeys.webhooks.list, queryFn: ({ signal }) => webhooksApi.list(signal) })
}

/** 一个 Webhook 的投递记录（新的在前）和总次数 */
export function useWebhookDeliveries(id: string | null, limit = DELIVERIES_MAX, refetchInterval?: number) {
  return useQuery({
    queryKey: dataKeys.webhooks.deliveries(id ?? '', limit),
    queryFn: ({ signal }) => webhooksApi.deliveries(id!, limit, signal),
    enabled: !!id,
    refetchInterval,
  })
}

/** 列表和二级菜单用：每个 Webhook 最近一次投递和总次数；没取到是 undefined，没推送过 last 为 null */
export type LastDelivery = { last: Delivery | null; total: number }
export function useLastDeliveries(ids: readonly string[], refetchInterval?: number): Record<string, LastDelivery | undefined> {
  const qs = useQueries({
    queries: ids.map((id) => ({
      queryKey: dataKeys.webhooks.deliveries(id, 1),
      queryFn: ({ signal }: { signal: AbortSignal }) => webhooksApi.deliveries(id, 1, signal),
      refetchInterval,
    })),
  })
  const out: Record<string, LastDelivery | undefined> = {}
  ids.forEach((id, i) => {
    const d = qs[i]?.data
    out[id] = d ? { last: d.data[0] ?? null, total: d.total } : undefined
  })
  return out
}

/** 每个 Webhook 建出、还没删的任务数 */
export function useWebhookUsages(ids: readonly string[]): Record<string, WebhookUsage | undefined> {
  const qs = useQueries({
    queries: ids.map((id) => ({
      queryKey: dataKeys.webhooks.usage(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => webhooksApi.usage(id, signal),
    })),
  })
  const out: Record<string, WebhookUsage | undefined> = {}
  ids.forEach((id, i) => { out[id] = qs[i]?.data })
  return out
}

/** 新建、改、轮换回来的那份先写进列表缓存（去掉明文），再按规则刷新 */
function useSaved() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return (w: WebhookWithSecret) => {
    const { secret: _secret, ...h } = w
    qc.setQueryData<Webhook[]>(dataKeys.webhooks.list, (rows) =>
      rows ? (rows.some((r) => r.id === h.id) ? rows.map((r) => (r.id === h.id ? h : r)) : [h, ...rows]) : rows)
    return notify({ kind: 'webhook', id: h.id })
  }
}

/** 新建；响应里的 secret 是明文，调用方自己记住，缓存里不留 */
export function useCreateWebhook() {
  const saved = useSaved()
  return useMutation({ mutationFn: (input: WebhookInput) => webhooksApi.create(input), onSuccess: (w) => { void saved(w) } })
}

/** 只传要改的字段；mapping、defaults 整体替换 */
export function usePatchWebhook() {
  const saved = useSaved()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: WebhookPatch }) => webhooksApi.patch(id, patch),
    onSuccess: (w) => { void saved(w) },
  })
}

/** 轮换密钥：旧密钥立即失效，响应里有新明文 */
export function useRotateWebhookSecret() {
  const saved = useSaved()
  return useMutation({ mutationFn: (id: string) => webhooksApi.rotate(id), onSuccess: (w) => { void saved(w) } })
}

/** 彻底删除，投递记录一起删，建出的任务保留 */
export function useDeleteWebhook() {
  const notify = useNotifyChange()
  return useMutation({ mutationFn: (id: string) => webhooksApi.delete(id), onSuccess: (_, id) => notify({ kind: 'webhook', id }) })
}

/** 往收件地址推一次（测试推送）：多一条投递记录，可能建出一条任务 */
export function usePushWebhook() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (v: { hookId: string; token: string; body: unknown; headers: Record<string, string> }) =>
      webhooksApi.push(v.token, v.body, v.headers),
    onSettled: (_, __, v) => notify({ kind: 'webhook-delivery', id: v.hookId }),
  })
}
