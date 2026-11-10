// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 来源分类的名字：分类树按 doc 类型取（来源只能是文档分类），拍平成「上级 / 名字」。
import { useMemo } from 'react'
import { useCategoryTree } from '../../../core/data'
import { flatCategories } from './model'

export function useDocCategories() {
  const q = useCategoryTree('doc')
  const list = useMemo(() => flatCategories(q.data ?? []), [q.data])
  const label = useMemo(() => {
    const m = new Map(list.map((c) => [c.id, c.label]))
    return (id: string) => m.get(id) ?? (q.data ? '已删除的分类' : id)
  }, [list, q.data])
  return { list, label, loaded: !!q.data }
}
