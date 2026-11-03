// 会话来源（内核 0047）：从别的记录发起的会话带 source_ref，会话页头部显示「来源：…」并能跳回去。
// 来源是哪种记录、怎么显示、跳到哪，由发起它的插件按 source_ref.kind 登记（IM 插件登记 im_message）；
// 会话模块和插件互不 import，会话页只认这里登记的定义；停用插件时按 id 撤掉，退回只显示 source_ref.label、不能跳。
// 和项目标签、对象区块一样不进清单 provides
import { useMemo, useSyncExternalStore } from 'react'
import type { SessionSourceRef } from '../data'
import type { Disposable } from './api'
import { OwnedStore } from './extensions'

/** 头部显示的来源：label 是一句话，to 是站内路径（带前导斜杠），给不出时为空串（只显示不跳） */
export type SessionSourceLink = { label: string; to: string; title?: string }

export interface SessionSourceDef {
  /** 认哪种来源：source_ref.kind 等于它；全局唯一 */
  kind: string
  describe: (ref: SessionSourceRef) => SessionSourceLink | null
}

export interface SessionSourceRegistry {
  register(def: SessionSourceDef): Disposable
}

export type PluginSessionSource = SessionSourceDef & { plugin: string }

export const sessionSourceStore = new OwnedStore<PluginSessionSource>()

export function sessionSourceRegistry(owner: string): SessionSourceRegistry {
  return {
    register(def) {
      if (sessionSourceStore.find((s) => s.kind === def.kind)) throw new Error(`会话来源 ${def.kind} 重复注册`)
      return sessionSourceStore.add(owner, { ...def, plugin: owner })
    },
  }
}

/** 按登记的定义描述来源；没人认（插件停用了）时只用 label，不能跳；没有来源为 null */
export function describeSource(list: readonly PluginSessionSource[], ref: SessionSourceRef | null | undefined): SessionSourceLink | null {
  if (!ref || typeof ref !== 'object') return null
  const def = list.find((d) => d.kind === ref.kind)
  const got = def ? def.describe(ref) : null
  if (got) return got
  const label = typeof ref.label === 'string' ? ref.label.trim() : ''
  return label ? { label, to: '' } : null
}

export function useSessionSource(ref: SessionSourceRef | null | undefined): SessionSourceLink | null {
  const list = useSyncExternalStore(sessionSourceStore.subscribe, sessionSourceStore.list)
  return useMemo(() => describeSource(list, ref), [list, ref])
}
