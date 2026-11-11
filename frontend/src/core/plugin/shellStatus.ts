// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 外壳状态条（后台常驻状态）：插件在任意页面都该看到、能点的那一块放这里，外壳在顶栏下面统一渲染。
// 和今日来源一样不进清单 provides：怎么摆由内核定，插件只给要渲染的一块。停用插件时按 id 撤掉。
import { useSyncExternalStore, type ComponentType, type LazyExoticComponent } from 'react'
import type { Disposable } from './api'
import { OwnedStore } from './extensions'

export interface ShellStatusDef {
  /** 本插件内唯一 */
  key: string
  /** 越小越靠前，默认 100；同 order 按注册顺序 */
  order?: number
  /** 状态条内容；常驻，不随路由卸载。可以给 lazy() 的组件，外壳会包 Suspense */
  render: ComponentType | LazyExoticComponent<ComponentType>
}

export interface ShellStatusRegistry {
  register(def: ShellStatusDef): Disposable
}

export type PluginShellStatus = ShellStatusDef & { plugin: string }

export const shellStatusStore = new OwnedStore<PluginShellStatus>()

export function shellStatusRegistry(owner: string): ShellStatusRegistry {
  return {
    register(def) {
      if (shellStatusStore.find((s) => s.plugin === owner && s.key === def.key)) throw new Error(`外壳状态 ${def.key} 重复注册`)
      return shellStatusStore.add(owner, { ...def, plugin: owner })
    },
  }
}

export function useShellStatus(): readonly PluginShellStatus[] {
  return useSyncExternalStore(shellStatusStore.subscribe, shellStatusStore.list)
}

/** 按 order 排，没给按 100，同 order 按注册顺序 */
export function sortShellStatus(items: readonly PluginShellStatus[]): PluginShellStatus[] {
  return items.map((s, i) => [s, i] as const)
    .sort((a, b) => (a[0].order ?? 100) - (b[0].order ?? 100) || a[1] - b[1])
    .map(([s]) => s)
}
