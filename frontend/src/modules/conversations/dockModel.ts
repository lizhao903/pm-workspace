// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 会话旁边工具面板的状态（SPEC-sessions-1.34 到 1.38），纯函数

export type DockState = {
  /** 展开着的工具 key；null 是收起 */
  open: string | null
  /** 打开过的工具，面板一直挂着 */
  mounted: string[]
  /** 每个工具被入口打开了几次，传给面板的 request */
  req: Record<string, number>
}

export const EMPTY_DOCK: DockState = { open: null, mounted: [], req: {} }

/** 头部入口：展开着的再点就收起；否则展开它，并算一次「打开」（终端据此定位到会话目录） */
export function toggleTool(d: DockState, key: string): DockState {
  if (d.open === key) return { ...d, open: null }
  return { open: key, mounted: d.mounted.includes(key) ? d.mounted : [...d.mounted, key], req: { ...d.req, [key]: (d.req[key] ?? 0) + 1 } }
}

/** 面板头部的切换：只换显示哪个，不收起；没打开过的第一次切过去也算一次打开 */
export function switchTool(d: DockState, key: string): DockState {
  if (d.mounted.includes(key)) return { ...d, open: key }
  return toggleTool(d, key)
}
