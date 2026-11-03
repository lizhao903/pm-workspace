// 应用唯一的缓存。main.tsx 挂到 QueryClientProvider 上，组件外的失效（notifyChange）也作用在它上面。
import { QueryClient } from '@tanstack/react-query'
import { retryable } from './errors'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => retryable(err) && count < 2,
    },
  },
})
