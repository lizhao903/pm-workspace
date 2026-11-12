// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 对象详情的插件区块（SOP-06）：插件往某几类对象的详情里加一块（SOP 插件给任务加「SOP 执行」），宿主模块按 order 摆在自己的区块后面。
// 模块和插件互不 import，宿主只认这里登记的定义；停用插件时按 id 撤掉，区块跟着消失。和项目标签一样不进清单 provides
import { useMemo, useSyncExternalStore, type ComponentType, type LazyExoticComponent } from 'react'
import type { WorkObject } from '../api/types'
import type { Disposable } from './api'
import { OwnedStore } from './extensions'

export type ObjectSectionProps = {
  object: WorkObject
  /**
   * 离开详情（比如去 SOP 运行页）后「返回」回哪里，能重新打开这条对象；宿主给不出时不传，区块退回当前地址
   */
  returnTo?: string
  /** 地址上 tab.focusParam 的值：从别处跳到区块里的某一行（某次 SOP 执行），区块高亮并滚到它；没有时不传 */
  focus?: string
}

/**
 * 区块放进详情的哪个标签（任务详情分成基础信息、开发任务、插件标签、执行记录）。同 key 的区块合在一个标签里，按 order 排；
 * 标签跟着插件走，插件停用区块撤掉、标签也不显示。不给 tab 的区块摆在基础信息标签的末尾
 */
export interface ObjectSectionTab {
  /** 写进地址 ?tab= 的值，如 'sop' */
  key: string
  label: string
  /** 标签名后面的计数或状态点，同项目详情的标签；没有可显示的返回 null */
  badge?: LazyExoticComponent<ComponentType<ObjectSectionProps>>
  /** 地址上带这个参数时（?sop_run=<id>）自动切到这个标签，值作为 focus 传给区块 */
  focusParam?: string
}

export interface ObjectSectionDef {
  /** 插件内唯一 */
  key: string
  /** 在哪些类型的对象详情里显示，如 ['task'] */
  typeIds: string[]
  /** 越小越靠前，没有算 100；同 order 按登记顺序 */
  order?: number
  section: LazyExoticComponent<ComponentType<ObjectSectionProps>>
  tab?: ObjectSectionTab
}

export interface ObjectSectionRegistry {
  register(def: ObjectSectionDef): Disposable
}

export type PluginObjectSection = ObjectSectionDef & { plugin: string }

export const objectSectionStore = new OwnedStore<PluginObjectSection>()

export function objectSectionRegistry(owner: string): ObjectSectionRegistry {
  return {
    register(def) {
      if (objectSectionStore.find((s) => s.plugin === owner && s.key === def.key)) throw new Error(`对象区块 ${def.key} 重复注册`)
      return objectSectionStore.add(owner, { ...def, plugin: owner })
    },
  }
}

/** 某类对象详情里的插件区块，按 order 排 */
export function sectionsFor(list: readonly PluginObjectSection[], typeId: string): PluginObjectSection[] {
  return list.map((s, i) => [s, i] as const).filter(([s]) => s.typeIds.includes(typeId))
    .sort((a, b) => (a[0].order ?? 100) - (b[0].order ?? 100) || a[1] - b[1]).map(([s]) => s)
}

export function useObjectSections(typeId: string): PluginObjectSection[] {
  const list = useSyncExternalStore(objectSectionStore.subscribe, objectSectionStore.list)
  return useMemo(() => sectionsFor(list, typeId), [list, typeId])
}

/** 区块按 tab 分组，标签按第一个区块的先后排；没给 tab 的不在里面 */
export function sectionTabs(secs: readonly PluginObjectSection[]): { tab: ObjectSectionTab; sections: PluginObjectSection[] }[] {
  const out: { tab: ObjectSectionTab; sections: PluginObjectSection[] }[] = []
  for (const s of secs) {
    if (!s.tab) continue
    const g = out.find((x) => x.tab.key === s.tab!.key)
    if (g) g.sections.push(s)
    else out.push({ tab: s.tab, sections: [s] })
  }
  return out
}
