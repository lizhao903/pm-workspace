// 枚举值的编辑（ALIGN-14，SPEC-settings-17）：设置页按字典把条目连同已停用的一起拉回来，改动攒成一份草稿，保存时按差异逐条写。
// 接口都是 docs/api-contract.md「枚举字典 dictionaries」已有的：建、改、停用、删、整组重排；没有建字典和合并数据的接口。
import { useMutation, useQueries } from '@tanstack/react-query'
import { request, type DictItem } from '../api'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'

const seg = encodeURIComponent

export const dictItemsApi = {
  /** 含已停用的条目 */
  listAll: (dictId: string) =>
    request<DictItem[]>('GET', `/api/dictionaries/${seg(dictId)}/items`, { query: new URLSearchParams({ include_archived: 'true' }) }),
}

/** 几本字典的全部条目（含已停用），按传入顺序 */
export function useDictItemsAll(dictIds: string[]) {
  return useQueries({
    queries: dictIds.map((id) => ({ queryKey: dataKeys.dictionaries.itemsAll(id), queryFn: () => dictItemsApi.listAll(id) })),
  })
}

/** 一次保存要做的写操作；新建的值用 key 指代，重排时换成新 id */
export type DictSavePlan = {
  dictId: string
  typeId?: string
  deletes: string[]
  creates: { key: string; label: string; color: string; description: string; meta?: Record<string, unknown>; archived: boolean }[]
  patches: { id: string; patch: { label?: string; color?: string; description?: string; meta?: Record<string, unknown> } }[]
  archives: { id: string; archived: boolean }[]
  /** 全部条目的新顺序（key），null 表示顺序没变 */
  order: string[] | null
}

/** 按删、建、改、停用、重排的顺序写；先删是为了让同 key 删了再加能成。中途失败就停下，已写的不回滚，界面刷新后照库里的显示 */
export async function saveDictItems(plan: DictSavePlan, current: Pick<DictItem, 'key' | 'id'>[]) {
  const base = `/api/dictionaries/${seg(plan.dictId)}/items`
  for (const id of plan.deletes) await request<null>('DELETE', `/api/dict-items/${seg(id)}`)
  const idOf = new Map(current.map((i) => [i.key, i.id]))
  for (const c of plan.creates) {
    const out = await request<DictItem>('POST', base, {
      body: { key: c.key, label: c.label, color: c.color, description: c.description, ...(c.meta && { meta: c.meta }), ...(plan.typeId && { type_id: plan.typeId }) },
    })
    idOf.set(out.key, out.id)
    if (c.archived) await request<DictItem>('POST', `/api/dict-items/${seg(out.id)}/archive`, { body: { archived: true } })
  }
  for (const p of plan.patches) await request<DictItem>('PATCH', `/api/dict-items/${seg(p.id)}`, { body: p.patch })
  for (const a of plan.archives) await request<DictItem>('POST', `/api/dict-items/${seg(a.id)}/archive`, { body: { archived: a.archived } })
  if (plan.order) {
    const ids = plan.order.map((k) => idOf.get(k)).filter((x): x is string => !!x)
    await request<null>('POST', `${base}/reorder`, { body: plan.typeId ? { type_id: plan.typeId, ids } : { ids } })
  }
}

/** 保存一本字典的草稿；成功失败都刷字典（各处下拉、标签跟着变） */
export function useSaveDictItems() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ plan, current }: { plan: DictSavePlan; current: Pick<DictItem, 'key' | 'id'>[] }) => saveDictItems(plan, current),
    onSettled: () => notify({ kind: 'dictionary' }),
  })
}
