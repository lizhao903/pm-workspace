// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 枚举值的编辑（ALIGN-14，SPEC-settings-17）：设置页按字典把条目连同已停用的一起拉回来，改动攒成一份草稿，保存时按差异逐条写。
// 接口都是 docs/api-contract.md「枚举字典 dictionaries」已有的：建、改、停用、删、整组重排；没有建字典和合并数据的接口。
import { useMutation, useQueries } from '@tanstack/react-query'
import { objectTypes, request, type DictItem, type ObjectStatus } from '../api'
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

/**
 * 不在字典表里的两组枚举（PR-13）：任务状态存在 object_types.statuses，文档分类是 categories。
 * 同一份草稿差异按各自的接口写，免得另建一份字典和原数据各改各的。
 */
export type EnumTarget =
  | { kind: 'dict' }
  /** 状态集整组写回；条目 id 就是 key，只改显示名、颜色、说明和顺序 */
  | { kind: 'status'; typeId: string; statuses: ObjectStatus[] }
  /** 一级分类；条目 id 是分类 id，key 是 slug */
  | { kind: 'category'; typeId: string }

export async function saveStatusItems(plan: DictSavePlan, typeId: string, statuses: ObjectStatus[]) {
  const byKey = new Map(statuses.map((s) => [s.key, s]))
  const keys = plan.order ?? statuses.map((s) => s.key)
  const patchOf = new Map(plan.patches.map((p) => [p.id, p.patch]))
  const next = keys.flatMap((k) => {
    const s = byKey.get(k)
    if (!s) return []
    const p = patchOf.get(k) ?? {}
    return [{ ...s, ...(p.label !== undefined && { label: p.label }), ...(p.color !== undefined && { color: p.color }), ...(p.description !== undefined && { description: p.description }) }]
  })
  // 没出现在顺序里的（不该有）补在后面，状态不能少
  for (const s of statuses) if (!keys.includes(s.key)) next.push(s)
  await objectTypes.patch(typeId, { statuses: next })
}

const catPath = (id: string) => `/api/categories/${seg(id)}`

/** 删、建、改，顺序变了再按位置重写 sort_order；分类没有停用 */
export async function saveCategoryItems(plan: DictSavePlan, typeId: string, current: Pick<DictItem, 'key' | 'id'>[]) {
  for (const id of plan.deletes) await request<null>('DELETE', catPath(id))
  const idOf = new Map(current.map((i) => [i.key, i.id]))
  for (const c of plan.creates) {
    const out = await request<{ id: string; slug: string }>('POST', '/api/categories', {
      body: { type_id: typeId, name: c.label, slug: c.key, color: c.color, description: c.description },
    })
    idOf.set(c.key, out.id)
  }
  for (const p of plan.patches) {
    const { label, meta: _, ...rest } = p.patch
    await request<unknown>('PATCH', catPath(p.id), { body: { ...rest, ...(label !== undefined && { name: label }) } })
  }
  if (plan.order) {
    const ids = plan.order.map((k) => idOf.get(k)).filter((x): x is string => !!x)
    for (const [n, id] of ids.entries()) await request<unknown>('PATCH', catPath(id), { body: { sort_order: (n + 1) * 10 } })
  }
}

/** 保存一组枚举的草稿；成功失败都刷对应的数据（各处下拉、标签跟着变） */
export function useSaveDictItems() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ plan, current, target = { kind: 'dict' } }: { plan: DictSavePlan; current: Pick<DictItem, 'key' | 'id'>[]; target?: EnumTarget }) =>
      target.kind === 'status' ? saveStatusItems(plan, target.typeId, target.statuses)
        : target.kind === 'category' ? saveCategoryItems(plan, target.typeId, current)
          : saveDictItems(plan, current),
    // 分类名跟着对象列表返回（category_name），按对象刷
    onSettled: (_d, _e, v) => notify(v.target?.kind === 'status' ? { kind: 'object-type' } : v.target?.kind === 'category' ? { kind: 'object' } : { kind: 'dictionary' }),
  })
}
