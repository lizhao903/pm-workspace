// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 联系人（CT-03a）：沿用干系人名册 /api/stakeholders，带 CT-01a（0026）加的联系人字段。契约见 docs/api-contract.md「干系人名册」。
// 缓存键挂在 stakeholders 前缀下，干系人一变（含对象改动带来的任务数变化）联系人列表一起刷。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from '../api'
import type { Dictionary, Stakeholder } from '../api'
import { useNotifyChange } from './invalidate'
import { applyIdentityPlan, identitiesApi, identityPlan, type Identity, type IdentityFailure, type IdentityInput } from './identities'
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

// ---- 从 IM 消息就地新建（IM-05）：只填姓名、公司、分组，建好接着挂身份 ----

/** 联系人分组字典和默认分组；没有字典时用内置五组（SPEC-contacts-0） */
export const CONTACT_GROUP_DICT = 'contact_group'
export const DEFAULT_CONTACT_GROUP = '其他'
const BUILTIN_GROUPS = ['客户', '合作伙伴', '同事', '供应商', '其他']

/** 能选的分组：字典里没停用的，按 sort_order */
export function contactGroupOptions(dicts: Dictionary[] | undefined): { value: string; label: string }[] {
  const items = dicts?.find((d) => d.id === CONTACT_GROUP_DICT)?.items
  if (!items?.length) return BUILTIN_GROUPS.map((g) => ({ value: g, label: g }))
  return [...items].filter((i) => !i.archived_at).sort((a, b) => a.sort_order - b.sort_order).map((i) => ({ value: i.key, label: i.label }))
}

/** 联系人的分组 key 列表：分组可以多个，存成一个字符串（「、」连接，也认逗号、斜杠、分号）；空串按默认分组算 */
export function contactGroupsOf(c: { group?: string | null }): string[] {
  const out = [...new Set((c.group ?? '').split(/[、,，/／;；]/).map((g) => g.trim()).filter(Boolean))]
  return out.length ? out : [DEFAULT_CONTACT_GROUP]
}

export type ContactQuick = Pick<ContactInput, 'name' | 'company' | 'group'>

/** 联系人一定建成了才返回；身份没挂上时 identity 为 null，原因在 error */
export type ContactLinked = { contact: Contact; identity: Identity | null; error?: unknown }

/** 先建联系人（撞名 409 整体报错），再挂身份；身份失败不回滚联系人，交给界面说清楚 */
export function useCreateContactLinked() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: async ({ fields, identity }: { fields: ContactQuick; identity: Omit<IdentityInput, 'stakeholder_id'> }): Promise<ContactLinked> => {
      const contact = await request<Contact>('POST', '/api/stakeholders', { body: fields })
      try {
        return { contact, identity: await identitiesApi.create({ ...identity, stakeholder_id: contact.id }) }
      } catch (error) {
        return { contact, identity: null, error }
      }
    },
    onSettled: () => Promise.all([notify({ kind: 'stakeholder' }), notify({ kind: 'im-identity' })]),
  })
}
