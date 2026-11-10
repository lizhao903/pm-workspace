// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 任务详情的标签（SPEC-tasks-4.35 起）：基础信息、开发任务、插件登记的标签（SOP）、执行记录。
// 当前标签记在地址 ?tab= 上；?run=<执行 id> 定位某次 Claude Code 执行（切到执行记录），插件标签的 focusParam（?sop_run=）定位那个插件里的一行。
// 什么时候显示哪个标签、停在哪个标签，都在这里算，抽屉只管摆。
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'
import { sectionTabs, useObjectSections } from '../../core/plugin'

export const TAB_PARAM = 'tab'
/** 定位某次 Claude Code 执行 */
export const RUN_PARAM = 'run'
/** 定位「开发任务」标签里的某一块（TSK-0497：focus=artifacts 是产出物面板），打开后滚到那里 */
export const FOCUS_PARAM = 'focus'
export const FOCUS_ARTIFACTS = 'artifacts'

export type HostTab = 'info' | 'dev' | 'runs'
export const HOST_TABS: Record<HostTab, string> = { info: '基础信息', dev: '开发任务', runs: '执行记录' }

/** 插件标签只关心这两项 */
export type PluginTabRef = { key: string; focusParam?: string }

/** 地址上要的标签：明说的 ?tab= 优先，其次按定位参数推（?run= 去执行记录，插件的 focusParam 去插件标签） */
export function wantedTab(params: URLSearchParams, plugins: readonly PluginTabRef[]): string | null {
  const t = params.get(TAB_PARAM)
  if (t) return t
  if (params.get(RUN_PARAM)) return 'runs'
  return plugins.find((p) => p.focusParam && params.get(p.focusParam))?.key ?? null
}

/** 关抽屉、换一条任务时从地址上去掉的参数 */
export function tabParams(plugins: readonly PluginTabRef[]): string[] {
  return [TAB_PARAM, RUN_PARAM, FOCUS_PARAM, ...plugins.flatMap((p) => (p.focusParam ? [p.focusParam] : []))]
}

export function withoutTabParams(params: URLSearchParams, plugins: readonly PluginTabRef[]): URLSearchParams {
  const next = new URLSearchParams(params)
  for (const k of tabParams(plugins)) next.delete(k)
  return next
}

/** 切标签：记下新标签，定位参数用过就去掉，切回来不再跳 */
export function withTab(params: URLSearchParams, tab: string, plugins: readonly PluginTabRef[]): URLSearchParams {
  const next = withoutTabParams(params, plugins)
  next.set(TAB_PARAM, tab)
  return next
}

/** 开发任务的迹象：填了开发字段之一，或者已经有进展、产出物、执行记录，或者在等你验收 */
export type DevSigns = {
  acceptance: string
  workdir: string
  repo: string
  /** 基础信息里点了「设为开发任务」，还没填 */
  opened: boolean
  reviewing: boolean
  progress: number
  artifacts: number
  runs: number
}

export const isDevTask = (s: DevSigns) =>
  !!(s.acceptance.trim() || s.workdir.trim() || s.repo.trim()) || s.opened || s.reviewing || s.progress > 0 || s.artifacts > 0 || s.runs > 0

/**
 * 标签条：基础信息一直有；开发任务和执行记录只在开发任务上有（执行记录都是从开发任务交给 Claude Code 来的）；
 * 插件标签跟着插件，插件没在跑就没有。地址上明说要开发任务或执行记录时照样显示（同项目详情：正停在这个标签上时照样显示），
 * 链接点进来不会落空；要的是不在跑的插件标签就回默认
 */
export function visibleTabs(dev: boolean, plugins: readonly PluginTabRef[], want: string | null): string[] {
  const showDev = dev || want === 'dev' || want === 'runs'
  return ['info', ...(showDev ? ['dev'] : []), ...plugins.map((p) => p.key), ...(showDev ? ['runs'] : [])]
}

/** 停在哪个标签：地址要的在标签条里就用它，否则用打开时的默认（待验收的任务默认开发任务，其余基础信息） */
export function currentTab(want: string | null, visible: readonly string[], fallback: string): string {
  if (want && visible.includes(want)) return want
  return visible.includes(fallback) ? fallback : 'info'
}

/**
 * 地址上的标签参数和插件标签：抽屉读写当前标签，任务页换一条任务时清掉（不然新打开的那条会停在上一条的标签上）
 */
export function useTaskTabParams(typeId = 'task') {
  const secs = useObjectSections(typeId)
  const plugins = useMemo(() => sectionTabs(secs), [secs])
  const refs = useMemo(() => plugins.map((p) => p.tab), [plugins])
  const [params, setParams] = useSearchParams()
  const clear = useCallback(() => {
    setParams((p) => (tabParams(refs).some((k) => p.has(k)) ? withoutTabParams(p, refs) : p), { replace: true })
  }, [setParams, refs])
  const select = useCallback((tab: string, extra?: Record<string, string>) => {
    setParams((p) => {
      const next = withTab(p, tab, refs)
      for (const [k, v] of Object.entries(extra ?? {})) next.set(k, v)
      return next
    }, { replace: true })
  }, [setParams, refs])
  return { plugins, refs, params, clear, select }
}
