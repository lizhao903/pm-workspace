// 工作目录校验和选目录（DEV-07b 起，CORE-03a 迁进数据访问层）。只读，不参与失效规则。
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { agentWorkdir, fs, type WorkdirCheck } from '../api'
import { dataKeys } from './keys'

/** 目录能不能用作工作目录：存在、是目录、可写 */
export const workdirUsable = (c: WorkdirCheck) => c.exists && c.is_dir && c.writable

/** 工作目录即时校验；空路径不查 */
export function useWorkdirCheck(path: string) {
  const p = path.trim()
  return useQuery({
    queryKey: dataKeys.workdir(p),
    queryFn: ({ signal }) => agentWorkdir.check(p, signal),
    enabled: !!p,
    staleTime: 5_000,
  })
}

/** 选目录：空路径是后端的默认起点 */
export function useFsBrowse(path: string, enabled: boolean) {
  return useQuery({
    queryKey: dataKeys.fs.browse(path),
    queryFn: () => fs.browse(path || undefined),
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
  })
}

export function useFsShortcuts(enabled: boolean) {
  return useQuery({ queryKey: dataKeys.fs.shortcuts, queryFn: fs.shortcuts, enabled })
}
