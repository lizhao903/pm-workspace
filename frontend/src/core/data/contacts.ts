// 联系人（CT-03a）：沿用干系人名册 /api/stakeholders，带 CT-01a（0026）加的联系人字段。契约见 docs/api-contract.md「干系人名册」。
// 缓存键挂在 stakeholders 前缀下，干系人一变（含对象改动带来的任务数变化）联系人列表一起刷。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from '../api'
import type { Stakeholder } from '../api'
import { useNotifyChange } from './invalidate'
import { applyIdentityPlan, identityPlan, type Identity, type IdentityFailure } from './identities'
import { dataKeys } from './keys'

export type Contact = Stakeholder & {
  /** 分组显示名，不约束取值；空串是没分组 */
  group: string
  company: string
  /** 职位；和 role（产品、研发这类角色）是两个字段 */
  title: string
  phone: string
  tags: string[]
  /** data URL；空串表示按名字生成头像 */
  photo: string
  starred: boolean
  /** RFC3339；没联系过为 null */
  last_contact_at: string | null
  /** 各渠道账号，IM 身份表（CT-01b）上线后才有 */
  im?: Record<string, string>
}

export type ContactPatch = Partial<Pick<Contact, 'group' | 'company' | 'title' | 'phone' | 'tags' | 'photo' | 'starred' | 'email' | 'note'>>
  & { last_contact_at?: string | null }

const path = (id: string) => `/api/stakeholders/${encodeURIComponent(id)}`

export const contactsApi = {
  // 只要在岗的；归档的人不出现在联系人里
  list: (signal?: AbortSignal) => request<Contact[]>('GET', '/api/stakeholders', { signal }),
  patch: (id: string, body: ContactPatch) => request<Contact>('PATCH', path(id), { body }),
}

export function useContacts() {
  return useQuery({ queryKey: dataKeys.contacts.list, queryFn: ({ signal }) => contactsApi.list(signal) })
}

/** 星标：先改缓存再发请求，失败退回；只改 starred */
export function useSetContactStarred() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => contactsApi.patch(id, { starred: on }),
    onMutate: async ({ id, on }) => {
      await qc.cancelQueries({ queryKey: dataKeys.contacts.list })
      const prev = qc.getQueryData<Contact[]>(dataKeys.contacts.list)
      qc.setQueryData<Contact[]>(dataKeys.contacts.list, (list) => list?.map((c) => (c.id === id ? { ...c, starred: on } : c)))
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(dataKeys.contacts.list, ctx.prev)
    },
    onSettled: () => notify({ kind: 'stakeholder' }),
  })
}

// ---- 新建、编辑、删除（CT-03b） ----

/** 新建和编辑表单提交的资料；name 必填，全局唯一，撞名回 409 */
export type ContactInput = Pick<Contact, 'name' | 'group' | 'company' | 'title' | 'phone' | 'email' | 'tags' | 'photo' | 'note'>
  & { starred?: boolean; last_contact_at?: string | null }

/** 归档、改名也走它 */
export type ContactUpdate = ContactPatch & { name?: string; archived?: boolean }

export type ContactSave = {
  /** 不传是新建 */
  id?: string
  fields: ContactInput
  /** 渠道到编号；空串表示没填 */
  im: Record<string, string>
  /** 这个人现有的身份，比出要增删改的 */
  before: Identity[]
}

export type ContactSaved = { contact: Contact; failed: IdentityFailure[] }

/** 资料先存，存成了再逐个改 IM 身份；资料失败整体报错，身份失败的放在 failed 里，别的渠道照样存 */
export function useSaveContact() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: async ({ id, fields, im, before }: ContactSave): Promise<ContactSaved> => {
      const contact = id
        ? await request<Contact>('PATCH', path(id), { body: fields })
        : await request<Contact>('POST', '/api/stakeholders', { body: fields })
      const failed = await applyIdentityPlan(contact.id, identityPlan(id ? before : [], im))
      return { contact, failed }
    },
    onSettled: () => Promise.all([notify({ kind: 'stakeholder' }), notify({ kind: 'im-identity' })]),
  })
}

/** 单改几个字段：记一次联系、换头像、归档 */
export function useUpdateContact() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ContactUpdate }) => request<Contact>('PATCH', path(id), { body: patch }),
    onSettled: () => notify({ kind: 'stakeholder' }),
  })
}

/** 只在零引用时成功（含回收站里的对象），有引用回 409，改走归档；身份跟着删 */
export function useDeleteContact() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (id: string) => request<null>('DELETE', path(id)),
    onSuccess: () => Promise.all([notify({ kind: 'stakeholder' }), notify({ kind: 'im-identity' })]),
  })
}
