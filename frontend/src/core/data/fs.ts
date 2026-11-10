// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 工作目录校验和选目录（DEV-07b 起，CORE-03a 迁进数据访问层）。只读，不参与失效规则。
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { agentWorkdir, fs, type WorkdirCheck } from '../api'
import { useNotifyChange } from './invalidate'
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

/** 额外可浏览目录（FS-01）：默认根和用户加的分开给 */
export function useFsRoots() {
  return useQuery({ queryKey: dataKeys.fs.roots, queryFn: fs.roots })
}

export function useAddFsRoot() {
  const notify = useNotifyChange()
  return useMutation({ mutationFn: fs.addRoot, onSuccess: () => notify({ kind: 'fs-root' }) })
}

export function useRemoveFsRoot() {
  const notify = useNotifyChange()
  return useMutation({ mutationFn: fs.removeRoot, onSuccess: () => notify({ kind: 'fs-root' }) })
}

/** 面包屑：从所在根一段段到 path，第一段显示根的完整路径（比如 /Volumes）。不在根里时只给 path 本身 */
export function fsCrumbs(path: string, root: string): { label: string; path: string }[] {
  if (!root || (path !== root && !path.startsWith(root.endsWith('/') ? root : root + '/'))) return [{ label: path, path }]
  const out = [{ label: root, path: root }]
  let cur = root.replace(/\/$/, '')
  for (const seg of path.slice(root.length).split('/').filter(Boolean)) {
    cur = `${cur}/${seg}`
    out.push({ label: seg, path: cur })
  }
  return out
}
