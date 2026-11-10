// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 命令面板数据源取数（A-01）：组件外调用，走同一份缓存。
// 联系人和身份整份拉、前端过滤（62 人量级）；任务交给后端 q 搜（标题、正文、编号）。
import { objects, type ObjectListParams } from '../api'
import { contactsApi, type Contact } from './contacts'
import { identitiesApi, type Identity } from './identities'
import { dataKeys } from './keys'
import { queryClient } from './queryClient'

/** 一页对象，和 useObjects 同一个缓存键 */
export function fetchObjects(filter: ObjectListParams) {
  return queryClient.fetchQuery({ queryKey: dataKeys.objects.list(filter), queryFn: ({ signal }) => objects.list(filter, signal) })
}

/** 联系人名册，和 useContacts 同一个缓存键 */
export function fetchContacts(): Promise<Contact[]> {
  return queryClient.fetchQuery({ queryKey: dataKeys.contacts.list, queryFn: ({ signal }) => contactsApi.list(signal) })
}

/** 全部 IM 身份；接口不可用时给 null，搜索照样按别的字段搜 */
export function fetchIdentities(): Promise<Identity[] | null> {
  return queryClient.fetchQuery({ queryKey: dataKeys.identities.list, queryFn: ({ signal }) => identitiesApi.list(signal), retry: false })
    .catch(() => null)
}
