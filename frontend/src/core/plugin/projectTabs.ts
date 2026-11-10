// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 项目详情的插件标签（VID-08d）：插件给项目详情加一个标签（视频插件的「商单」），项目插件按 after 插进自己的标签条。
// 插件之间互不 import，项目插件只认这里登记的定义；停用插件时按 id 撤掉，标签跟着消失。和今日来源一样不进清单 provides
import { useSyncExternalStore, type ComponentType, type LazyExoticComponent } from 'react'
import type { Disposable } from './api'
import { OwnedStore } from './extensions'

export interface ProjectTabDef {
  /** 路由段 /projects/<id>/<key>，不和项目自己的标签撞 */
  key: string
  label: string
  /** 插在哪个项目标签后面；不给或找不到放在「设置」前面 */
  after?: string
  /** 标签内容 */
  page: LazyExoticComponent<ComponentType<{ projectId: string }>>
  /** 标签上的小红点这类提示，不给不显示 */
  badge?: ComponentType<{ projectId: string }>
}

export interface ProjectTabRegistry {
  register(def: ProjectTabDef): Disposable
}

export type PluginProjectTab = ProjectTabDef & { plugin: string }

export const projectTabStore = new OwnedStore<PluginProjectTab>()

export function projectTabRegistry(owner: string): ProjectTabRegistry {
  return {
    register(def) {
      if (projectTabStore.find((t) => t.key === def.key)) throw new Error(`项目标签 ${def.key} 重复注册`)
      return projectTabStore.add(owner, { ...def, plugin: owner })
    },
  }
}

export function useProjectTabs(): readonly PluginProjectTab[] {
  return useSyncExternalStore(projectTabStore.subscribe, projectTabStore.list)
}
