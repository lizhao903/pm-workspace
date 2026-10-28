import { useQuery } from '@tanstack/react-query'
import { api } from './client'
import type { Dictionary, Health, ObjectType } from './types'

// 查询键集中定义，改数据后按键失效缓存。
export const keys = {
  health: ['health'] as const,
  objectTypes: ['object-types'] as const,
  dictionaries: ['dictionaries'] as const,
}

export function useHealth() {
  return useQuery({
    queryKey: keys.health,
    queryFn: () => api.get<Health>('/api/health'),
    refetchInterval: 30_000,
  })
}

// 状态、类型、优先级一律从后端读，不在前端写死。
export function useObjectTypes() {
  return useQuery({ queryKey: keys.objectTypes, queryFn: () => api.get<ObjectType[]>('/api/object-types') })
}

export function useDictionaries() {
  return useQuery({ queryKey: keys.dictionaries, queryFn: () => api.get<Dictionary[]>('/api/dictionaries') })
}
