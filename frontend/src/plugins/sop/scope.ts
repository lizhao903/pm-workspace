// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 流程和当前工作台（PR-14，C-06）：流程里有插件节点、提供它的插件不在当前工作台里时，流程库和流程详情标「需要视频模块」。
// 工作台开了哪些插件 = 它的模块要的插件加它记的插件；工作台、插件列表还没取到时不标。触发方式的显示名也在这里读字典
import { useMemo } from 'react'
import { useDictionaries, usePlugins, useWorkspaces, type SopFlow } from '../../core/data'
import { moduleKeyOf, moduleLabel, pluginsForModules, resolveCurrent, useCurrentWorkspaceId } from '../../core/shell/workspace'
import { missingFlowPlugins, triggerLabelOf } from './model'

/** 流程要的、当前工作台没开的模块名（「视频」） */
export function useFlowNeeds(): (f: SopFlow) => string[] {
  const ws = useWorkspaces()
  const plugins = usePlugins()
  const cur = resolveCurrent(ws.data, useCurrentWorkspaceId())
  return useMemo(() => {
    const list = plugins.data ?? []
    const enabled = cur && plugins.data ? new Set([...pluginsForModules(cur.modules, list), ...cur.plugins]) : null
    const name = (id: string) => {
      const p = list.find((x) => x.id === id)
      const mod = p?.provides?.modules?.[0]
      return mod ? moduleLabel(moduleKeyOf(mod)) : p?.name || id
    }
    return (f: SopFlow) => missingFlowPlugins(f, enabled, list).map(name)
  }, [cur, plugins.data])
}

export const needsText = (mods: readonly string[]) => `需要${mods.join('、')}模块`

/** 触发方式的显示名：设置里的 sop_trigger 枚举，没有用内置的 */
export function useTriggerLabel(): (t: string) => string {
  const dicts = useDictionaries({ withItems: true })
  const items = dicts.data?.find((d) => d.id === 'sop_trigger')?.items
  return useMemo(() => triggerLabelOf(items), [items])
}
