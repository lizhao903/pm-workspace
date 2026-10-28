// 元数据和计数：后端健康、对象类型、字典、干系人、/api/counts。
// 状态、类型、优先级一律从后端读，不在前端写死。
import { useQuery } from '@tanstack/react-query'
import { counts, dictionaries, health, objectTypes, stakeholders } from '../api'
import { dataKeys } from './keys'

export function useHealth() {
  return useQuery({ queryKey: dataKeys.health, queryFn: health, refetchInterval: 30_000 })
}

export function useObjectTypes() {
  return useQuery({ queryKey: dataKeys.objectTypes, queryFn: objectTypes.list })
}

export function useDictionaries(opts: { withItems?: boolean } = {}) {
  const withItems = !!opts.withItems
  return useQuery({ queryKey: dataKeys.dictionaries.list(withItems), queryFn: () => dictionaries.list({ withItems }) })
}

/** 某本字典的条目（含已归档的，历史数据要显示得出来） */
export function useDictItems(dictId: string) {
  return useQuery({ queryKey: dataKeys.dictionaries.items(dictId), queryFn: () => dictionaries.items(dictId) })
}

/** 干系人名册；默认只有在岗的 */
export function useStakeholders(opts: { archived?: boolean } = {}) {
  const archived = !!opts.archived
  return useQuery({ queryKey: dataKeys.stakeholders.list(archived), queryFn: () => stakeholders.list({ archived }) })
}

/** 计数器；type 只收窄聚焦类计数器（今日、逾期等），by_type / total 恒为全局 */
export function useCounts(opts: { type?: string; refetchInterval?: number } = {}) {
  return useQuery({
    queryKey: dataKeys.counts.of(opts.type),
    queryFn: () => counts({ type: opts.type }),
    refetchInterval: opts.refetchInterval,
  })
}
