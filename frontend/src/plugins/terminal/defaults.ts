// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 终端新标签的默认目录和主目录：一级菜单的终端页和会话旁边的终端共用
import { useFsShortcuts, useProjects } from '../../core/data'

/** 新标签的默认目录和主目录；settled：项目列表读完了（默认目录定下来了） */
export function useTerminalDefaults() {
  const projects = useProjects()
  const shortcuts = useFsShortcuts(true)
  const home = shortcuts.data?.find((s) => s.label === '主目录')?.path ?? ''
  // 新标签的目录：第一个有目录的项目，都没有用主目录（后端收到空串就是主目录）
  const defaultCwd = projects.data?.data.find((p) => p.workdir?.startsWith('/'))?.workdir ?? ''
  return { home, defaultCwd, settled: !projects.isPending, homeSettled: !shortcuts.isPending }
}
