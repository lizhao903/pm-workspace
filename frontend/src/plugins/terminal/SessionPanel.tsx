// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 会话旁边的终端（SPEC-sessions-1.35）：和一级菜单「终端」是同一套标签和会话。每次从会话头部点「终端」打开时，
// 定位到停在会话工作目录的格子，没有就在那个目录新开一个标签；会话没设目录时用终端的默认目录（第一个有目录的项目，再没有是主目录）
import { useEffect, useRef } from 'react'
import type { SessionToolProps } from '../../core/plugin'
import { useTerminalDefaults } from './defaults'
import { TerminalView } from './Page'
import { openTerminalAt } from './store'
import './terminal.css'

export default function TerminalSessionPanel({ workdir, request }: SessionToolProps) {
  const { home, defaultCwd, settled, homeSettled } = useTerminalDefaults()
  const handled = useRef(0)

  useEffect(() => {
    if (!settled || !homeSettled || request === handled.current) return
    handled.current = request
    void openTerminalAt(workdir.trim() || defaultCwd || home, defaultCwd)
  }, [request, settled, homeSettled, workdir, defaultCwd, home])

  return <TerminalView autoInit={false} />
}
