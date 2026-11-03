// 在终端里开 Claude Code（交给 Claude Code「切换到终端」，内核 0048）：终端插件登记一个入口，
// 任务模块经它在终端里新开标签、执行设置里的启动命令。任务模块和终端插件互不 import，只认这里的定义；
// 同一时间只有一个入口，终端插件停用时按插件 id 撤掉，任务弹窗里「切换到终端」随之置灰。不进清单 provides
import { useSyncExternalStore } from 'react'
import type { Disposable } from './api'
import { OwnedStore } from './extensions'

/** 工作台写好的两个临时文件和这次的工作目录，见 POST /api/objects/{id}/run/terminal 的响应 */
export type ClaudeLaunch = { prompt_file: string; mcp_config: string; workdir: string }

export type TerminalLaunchRequest = {
  /** 新标签的目录，就是这次执行的工作目录 */
  cwd: string
  claude: ClaudeLaunch
  /** 新标签的名字，如任务编号 */
  title: string
}

export interface TerminalLauncherDef {
  /** 开好之后去的站内路径，带前导斜杠，如 '/terminal' */
  page: string
  /** 新开标签并执行启动命令，回写进终端的那条命令；失败抛错（终端开不出来、文件不在） */
  launch(req: TerminalLaunchRequest): Promise<{ command: string }>
}

export interface TerminalLauncherRegistry {
  register(def: TerminalLauncherDef): Disposable
}

export type PluginTerminalLauncher = TerminalLauncherDef & { plugin: string }

export const terminalLauncherStore = new OwnedStore<PluginTerminalLauncher>()

export function terminalLauncherRegistry(owner: string): TerminalLauncherRegistry {
  return {
    register(def) {
      const had = terminalLauncherStore.list()[0]
      if (had) throw new Error(`终端入口已由插件 ${had.plugin} 登记，同一时间只能有一个`)
      return terminalLauncherStore.add(owner, { ...def, plugin: owner })
    },
  }
}

/** 当前的终端入口；没有插件登记（终端插件没启用）时为 undefined */
export function useTerminalLauncher(): PluginTerminalLauncher | undefined {
  return useSyncExternalStore(terminalLauncherStore.subscribe, terminalLauncherStore.list)[0]
}
