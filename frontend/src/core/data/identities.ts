// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// IM 身份（CT-03b）：联系人在各渠道的编号，CT-01b 的 /api/im-identities。契约见 docs/api-contract.md「IM 身份 im-identities」。
// 一次拉全，前端按联系人分组合进 Contact.im；一个渠道多个身份时界面只显示、只改第一个，其余原样保留。
import { useMutation, useQuery } from '@tanstack/react-query'
import { isApiError, request } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'

export type Identity = {
  id: string
  stakeholder_id: string
  channel: string
  external_id: string
  display_name: string
  account: string
  created_at: string
  updated_at: string
}

export type IdentityInput = { stakeholder_id: string; channel: string; external_id: string; display_name?: string; account?: string }

const path = (id: string) => `/api/im-identities/${encodeURIComponent(id)}`

export const identitiesApi = {
  list: (signal?: AbortSignal) => request<Identity[]>('GET', '/api/im-identities', { signal }),
  create: (body: IdentityInput) => request<Identity>('POST', '/api/im-identities', { body }),
  patch: (id: string, body: Partial<IdentityInput>) => request<Identity>('PATCH', path(id), { body }),
  delete: (id: string) => request<null>('DELETE', path(id)),
}

/** 全部身份；后端还没有这个接口（404）时不重试，界面当作不支持 IM */
export function useIdentities() {
  return useQuery({
    queryKey: dataKeys.identities.list,
    queryFn: ({ signal }) => identitiesApi.list(signal),
    retry: (n, e) => !isApiError(e, 'not_found') && n < 2,
  })
}

// ---- 单个身份的挂、改挂、解除（IM-05：IM 消息里认人）；成败都刷：409 时可能是别处刚挂上，读回最新的 ----

export function useCreateIdentity() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (body: IdentityInput) => identitiesApi.create(body),
    onSettled: () => notify({ kind: 'im-identity' }),
  })
}

/** 改挂到另一个联系人；撞上那人已有的同一编号回 409 */
export function useRelinkIdentity() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, stakeholderId }: { id: string; stakeholderId: string }) => identitiesApi.patch(id, { stakeholder_id: stakeholderId }),
    onSettled: () => notify({ kind: 'im-identity' }),
  })
}

/** 只删身份，联系人不动 */
export function useDeleteIdentity() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (id: string) => identitiesApi.delete(id),
    onSettled: () => notify({ kind: 'im-identity' }),
  })
}

/** 编号按后端的规则规整后再比较：去首尾空白，Telegram 去掉开头的 @ */
export function normExternalId(channel: string, v: string): string {
  const t = v.trim()
  return channel === 'telegram' ? t.replace(/^@+/, '') : t
}

/** 按联系人分组，组内保持接口顺序（渠道、编号） */
export function identitiesByContact(list: Identity[] | undefined): Map<string, Identity[]> {
  const m = new Map<string, Identity[]>()
  for (const i of list ?? []) {
    const arr = m.get(i.stakeholder_id)
    if (arr) arr.push(i)
    else m.set(i.stakeholder_id, [i])
  }
  return m
}

/** 渠道到编号：每个渠道取第一个 */
export function imOf(ids: Identity[] | undefined): Record<string, string> {
  const im: Record<string, string> = {}
  for (const i of ids ?? []) if (!(i.channel in im)) im[i.channel] = i.external_id
  return im
}

/** 「渠道:编号」属于谁，同一编号取第一个；保存前提示编号被别人占用用 */
export function identityOwner(list: Identity[] | undefined, channel: string, externalId: string): Identity | undefined {
  const ext = normExternalId(channel, externalId)
  if (!ext) return undefined
  return list?.find((i) => i.channel === channel && i.external_id === ext)
}

export type IdentityOp =
  | { op: 'create'; channel: string; external_id: string }
  | { op: 'patch'; id: string; channel: string; external_id: string }
  | { op: 'delete'; id: string; channel: string }

/** 表单里每渠道一个编号，和已有身份比出要做的增删改；清空一个渠道就是删掉这个渠道的第一个身份 */
export function identityPlan(before: Identity[], im: Record<string, string>): IdentityOp[] {
  const ops: IdentityOp[] = []
  const first = new Map<string, Identity>()
  for (const i of before) if (!first.has(i.channel)) first.set(i.channel, i)
  const channels = new Set([...first.keys(), ...Object.keys(im)])
  for (const ch of channels) {
    const old = first.get(ch)
    const ext = normExternalId(ch, im[ch] ?? '')
    if (old && !ext) ops.push({ op: 'delete', id: old.id, channel: ch })
    else if (!old && ext) ops.push({ op: 'create', channel: ch, external_id: ext })
    else if (old && ext && old.external_id !== ext) ops.push({ op: 'patch', id: old.id, channel: ch, external_id: ext })
  }
  return ops
}

export type IdentityFailure = { channel: string; external_id: string; error: unknown }

/** 逐个执行，失败的记下来接着做别的渠道；返回没做成的 */
export async function applyIdentityPlan(stakeholderId: string, ops: IdentityOp[]): Promise<IdentityFailure[]> {
  const failed: IdentityFailure[] = []
  for (const o of ops) {
    try {
      if (o.op === 'create') await identitiesApi.create({ stakeholder_id: stakeholderId, channel: o.channel, external_id: o.external_id })
      else if (o.op === 'patch') await identitiesApi.patch(o.id, { external_id: o.external_id })
      else await identitiesApi.delete(o.id)
    } catch (error) {
      failed.push({ channel: o.channel, external_id: o.op === 'delete' ? '' : o.external_id, error })
    }
  }
  return failed
}
