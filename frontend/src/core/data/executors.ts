// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestList } from '../api'

export type Executor = { id: string; name: string; kind: 'claude' | 'deepseek' | 'codex'; bin: string; desc: string; enabled: boolean; provider_id?: string; use_cli_config?: boolean; warnings?: string[]; provider_name?: string; model?: string }
export type ExecutorInput = Omit<Executor, 'id' | 'warnings' | 'provider_name' | 'model'>
export type ExecutorProbe = { base_url?: string; config_source?: string; path: string; version: string; warnings: string[] }
const key = ['local-executors'] as const
export const executorsApi = {
  list: async (signal?: AbortSignal) => (await requestList<Executor>('/api/executors', { signal })).data,
  save: (input: ExecutorInput, id?: string) => request<Executor>(id ? 'PUT' : 'POST', id ? `/api/executors/${encodeURIComponent(id)}` : '/api/executors', { body: input }),
  command: (input: ExecutorInput, signal?: AbortSignal) => request<{ command: string }>('POST', '/api/executors/command', { body: input, signal }),
  probe: (input: ExecutorInput, signal?: AbortSignal) => request<ExecutorProbe>('POST', '/api/executors/probe', { body: input, signal }),
  test: (executor: ExecutorInput, prompt: string, messages: readonly { role: 'user' | 'assistant'; content: string }[] = [], signal?: AbortSignal) => request<{ reply: string; model: string }>('POST', '/api/executors/test', { body: { executor, prompt, messages }, signal }),
  remove: (id: string) => request<null>('DELETE', `/api/executors/${encodeURIComponent(id)}`),
}
export function useExecutors() {
  return useQuery({ queryKey: key, queryFn: ({ signal }) => executorsApi.list(signal) })
}
export function useSaveExecutor() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: ({ input, id }: { input: ExecutorInput; id?: string }) => executorsApi.save(input, id), onSuccess: () => qc.invalidateQueries({ queryKey: key }) })
}
export function useDeleteExecutor() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: executorsApi.remove, onSuccess: () => qc.invalidateQueries({ queryKey: key }) })
}
