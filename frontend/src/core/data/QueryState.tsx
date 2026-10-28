// 统一的加载和出错状态（CORE-03a）：查询还没数据时显示加载中，出错且没有旧数据时显示错误和「重试」，
// 有数据就交给 children 渲染。刷新失败但手上还有旧数据时照常显示旧数据，不整块换成错误。
import type { ReactNode } from 'react'
// 直接引 states，不经 ui/index（那里加载样式和主题，纯函数测试跑在 node 里会挂）
import { ErrorState, LoadingState } from '../ui/states'
import { errorText } from './errors'

type QueryLike<T> = {
  data: T | undefined
  isPending: boolean
  isError: boolean
  error: unknown
  refetch: () => unknown
}

export function QueryState<T>({ query, children, loading, errorTitle, compact }: {
  query: QueryLike<T>
  children: (data: T) => ReactNode
  /** 加载中的替代内容，默认 LoadingState */
  loading?: ReactNode
  errorTitle?: ReactNode
  compact?: boolean
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>
  if (query.isError) {
    return <ErrorState compact={compact} title={errorTitle} error={errorText(query.error)} onRetry={() => void query.refetch()} />
  }
  return <>{loading ?? <LoadingState />}</>
}
