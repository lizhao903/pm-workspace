// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 会话旁边的工具（SPEC-sessions-1.34）：插件给会话头部右上角加一个入口（终端插件的「终端」、浏览器插件的「浏览器」），
// 点了在对话右边展开插件给的面板。会话模块和插件互不 import，会话页只认这里登记的定义；停用插件时按 id 撤掉，入口跟着消失。
// 和项目标签、对象区块一样不进清单 provides
import { useMemo, useSyncExternalStore, type ComponentType, type LazyExoticComponent } from 'react'
import type { Disposable } from './api'
import { OwnedStore } from './extensions'

export type SessionToolProps = {
  sessionId: string
  /** 会话的工作目录；空串表示会话没设，插件按自己的默认处理 */
  workdir: string
  /** 会话里出现过的链接（Agent 回复和工具结果里的 http/https 地址），新的在前，已去重 */
  links: readonly string[]
  /** 每点一次头部入口打开这个面板就加一；插件据此做「打开时」的动作（终端定位到会话目录） */
  request: number
  /** 面板藏起来了（收起或切到另一个工具）；面板不卸载，只是看不见 */
  hidden: boolean
}

export interface SessionToolDef {
  /** 全局唯一，如 'terminal' */
  key: string
  /** 入口上的名字 */
  label: string
  /** 入口和面板头部切换上的图标，14px 左右 */
  icon: ComponentType
  /** 越小越靠前，没有算 100；同 order 按登记顺序 */
  order?: number
  /** 入口的悬停提示（还没展开时）；不给就是「在对话旁边打开<label>」 */
  hint?: (ctx: Pick<SessionToolProps, 'workdir' | 'links'>) => string
  /** 「整页打开」去的站内路径，带前导斜杠，如 '/terminal'；不给就没有这个按钮 */
  page?: string
  panel: LazyExoticComponent<ComponentType<SessionToolProps>>
}

export interface SessionToolRegistry {
  register(def: SessionToolDef): Disposable
}

export type PluginSessionTool = SessionToolDef & { plugin: string }

export const sessionToolStore = new OwnedStore<PluginSessionTool>()

export function sessionToolRegistry(owner: string): SessionToolRegistry {
  return {
    register(def) {
      if (sessionToolStore.find((t) => t.key === def.key)) throw new Error(`会话工具 ${def.key} 重复注册`)
      return sessionToolStore.add(owner, { ...def, plugin: owner })
    },
  }
}

/** 按 order 排，同 order 按登记顺序 */
export function sortSessionTools(list: readonly PluginSessionTool[]): PluginSessionTool[] {
  return list.map((t, i) => [t, i] as const).sort((a, b) => (a[0].order ?? 100) - (b[0].order ?? 100) || a[1] - b[1]).map(([t]) => t)
}

export function useSessionTools(): PluginSessionTool[] {
  const list = useSyncExternalStore(sessionToolStore.subscribe, sessionToolStore.list)
  return useMemo(() => sortSessionTools(list), [list])
}
