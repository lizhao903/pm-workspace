import { useQuery } from '@tanstack/react-query'
import { dictionaries, health, objectTypes } from './resources'

// 查询键集中定义，改数据后按键失效缓存。
export const keys = {
  health: ['health'] as const,
  objectTypes: ['object-types'] as const,
  dictionaries: ['dictionaries'] as const,
}

export function useHealth() {
  return useQuery({
    queryKey: keys.health,
    queryFn: health,
    refetchInterval: 30_000,
  })
}

// 状态、类型、优先级一律从后端读，不在前端写死。
export function useObjectTypes() {
  return useQuery({ queryKey: keys.objectTypes, queryFn: objectTypes.list })
}

export function useDictionaries() {
  return useQuery({ queryKey: keys.dictionaries, queryFn: () => dictionaries.list() })
}
