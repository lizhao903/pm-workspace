// 工作台在前端这一侧的规则（CORE-10b）：模块 key 和前端模块的对应、模块要哪个插件、缺哪些插件、当前用哪个工作台。
// 工作台配置存后端（core/data/workspaces.ts）；当前用哪个只记在这台浏览器里，切换只换菜单，不清缓存。
import { useSyncExternalStore } from 'react'
import type { PluginInfo, Workspace } from '../data'
import type { MenuGroupDef } from './menu'

/** 工作台里能放的模块，说明照原型 web-next/src/workspacedata.ts MODULES */
export const MODULE_CATALOG: readonly { key: string; label: string; desc: string }[] = [
  { key: 'today', label: '今日', desc: '今天要处理的事集中在一页' },
  { key: 'projects', label: '项目', desc: '项目目录、材料、文档、原型启停' },
  { key: 'contacts', label: '联系人', desc: '客户、伙伴、同事和他们的 IM 账号' },
  { key: 'messages', label: 'IM 消息', desc: '各渠道收进来的消息，处理和回复' },
  { key: 'tasks', label: '任务', desc: '人工、IM、Webhook、定时、异常转来的任务' },
  { key: 'library', label: '文档', desc: '工作台文档和本地目录' },
  { key: 'sop', label: 'SOP', desc: '标准流程的编排和执行' },
  { key: 'sessions', label: '会话', desc: '和 Agent 的对话、执行记录、产出' },
  { key: 'terminal', label: '终端', desc: '分屏终端，能启停项目原型' },
  { key: 'browser', label: '浏览器', desc: '内置浏览器：看原型、Google Drive 文件' },
  { key: 'videos', label: '视频', desc: '视频制作流程、产出物、系列和多平台发布' },
  { key: 'markets', label: '行情', desc: '数币、A 股、港股、美股的看盘和期权 T 型报价' },
  { key: 'monitor', label: '盯盘', desc: '盯盘墙、价格与异动提醒、市场时段' },
  { key: 'strategy', label: '策略', desc: '策略编辑、回测和参数扫描' },
  { key: 'trading', label: '交易', desc: '账户、持仓、委托、策略运行和风控' },
]

// 后端的模块 key 和前端内核模块 id 不一样的两个；其余同名（插件模块的 key 就是前端模块 id）
const FRONT_ID: Record<string, string> = { library: 'docs', sessions: 'conversations' }
const BACK_KEY: Record<string, string> = Object.fromEntries(Object.entries(FRONT_ID).map(([k, v]) => [v, k]))

export const moduleIdOf = (key: string) => FRONT_ID[key] ?? key
export const moduleKeyOf = (id: string) => BACK_KEY[id] ?? id

/** 目录里的模块对应的前端模块 id：这些模块在不在菜单里完全由工作台决定 */
export const CATALOG_IDS: ReadonlySet<string> = new Set(MODULE_CATALOG.map((m) => moduleIdOf(m.key)))

const KERNEL_KEYS = new Set(['today', 'tasks', 'library', 'contacts', 'sessions'])

/** 模块由哪个插件提供；内核模块为 null。和契约一致：messages 由 im 提供，其余插件模块 key 即插件 id */
export function pluginOfModule(key: string): string | null {
  if (KERNEL_KEYS.has(key)) return null
  return key === 'messages' ? 'im' : key
}

/** 按模块推出需要的插件，去重保序 */
export const pluginsForModules = (keys: readonly string[]) =>
  [...new Set(keys.map(pluginOfModule).filter((p): p is string => !!p))]

/** 插件清单里没有的插件用这里的名字（还没做出来） */
const PLUGIN_NAMES: Record<string, string> = {
  projects: '项目', im: 'IM 消息', sop: 'SOP', terminal: '终端', browser: '浏览器', videos: '视频',
  markets: '行情', monitor: '盯盘', strategy: '策略与回测', trading: '交易执行',
}

/** 几个插件合成一个套件：都还没提供时合成一行说 */
const SUITES: readonly { id: string; name: string; plugins: readonly string[] }[] = [
  { id: 'trading-suite', name: '交易套件', plugins: ['markets', 'monitor', 'strategy', 'trading'] },
]

export function moduleLabel(key: string, live?: readonly { id: string; label: string }[]): string {
  return MODULE_CATALOG.find((m) => m.key === key)?.label ?? live?.find((m) => m.id === moduleIdOf(key))?.label ?? key
}

export type PluginState = 'ok' | 'disabled' | 'not-installed' | 'unavailable'

export const PLUGIN_STATE_TEXT: Record<Exclude<PluginState, 'ok'>, string> = {
  disabled: '已安装未启用',
  'not-installed': '未安装',
  unavailable: '尚未提供',
}

export function pluginState(id: string, list: readonly PluginInfo[]): PluginState {
  const p = list.find((x) => x.id === id)
  if (!p) return 'unavailable'
  if (!p.installed) return 'not-installed'
  return p.running ? 'ok' : 'disabled'
}

/** 缺的插件一行：套件合成的行带 members */
export type MissingPlugin = { id: string; name: string; state: Exclude<PluginState, 'ok'>; members?: string[] }

/** 工作台需要、现在没在跑的插件。插件清单里没有的算「尚未提供」，同一套件里尚未提供的合成一行 */
export function missingPlugins(required: readonly string[], list: readonly PluginInfo[]): MissingPlugin[] {
  const out: MissingPlugin[] = []
  const suiteRow = new Map<string, MissingPlugin>()
  for (const id of new Set(required)) {
    const state = pluginState(id, list)
    if (state === 'ok') continue
    const name = list.find((x) => x.id === id)?.name || PLUGIN_NAMES[id] || id
    const suite = state === 'unavailable' ? SUITES.find((s) => s.plugins.includes(id)) : undefined
    if (!suite) {
      out.push({ id, name, state })
      continue
    }
    let row = suiteRow.get(suite.id)
    if (!row) {
      row = { id: suite.id, name: suite.name, state, members: [] }
      suiteRow.set(suite.id, row)
      out.push(row)
    }
    row.members!.push(name)
  }
  return out
}

/** 缺的插件里有没有能去插件管理页装上的（尚未提供的装不了） */
export const canInstallSome = (m: readonly MissingPlugin[]) => m.some((x) => x.state !== 'unavailable')

/** 一行缺插件的文字：「交易套件（行情、盯盘）：尚未提供」 */
export const missingText = (m: MissingPlugin) =>
  `${m.name}${m.members && m.members.length ? `（${m.members.join('、')}）` : ''}：${PLUGIN_STATE_TEXT[m.state]}`

/** 工作台的分组换成菜单分组：模块 key 换成前端模块 id；分组 id 带上工作台 id，折叠记忆不串 */
export function workspaceMenuGroups(w: Workspace): MenuGroupDef[] {
  return w.groups.map((g) => ({ id: `${w.id}:${g.id}`, name: g.name, modules: g.modules.map(moduleIdOf), collapsed: g.collapsed }))
}

// 当前工作台：记在这台浏览器里。记的工作台被删了就落到列表第一个
const CUR_KEY = 'pmw-workspace'
const listeners = new Set<() => void>()

function readStored(): string {
  try { return localStorage.getItem(CUR_KEY) ?? '' } catch { return '' }
}
let stored = readStored()

export function setCurrentWorkspace(id: string) {
  stored = id
  try { localStorage.setItem(CUR_KEY, id) } catch { /* 只在本次会话生效 */ }
  for (const f of listeners) f()
}

const subscribe = (f: () => void) => {
  listeners.add(f)
  return () => { listeners.delete(f) }
}

export function resolveCurrent<T extends { id: string }>(list: readonly T[] | undefined, id: string): T | undefined {
  return list?.find((w) => w.id === id) ?? list?.[0]
}

/** 记下的当前工作台 id（可能已经不在列表里，用 resolveCurrent 落到实际的） */
export function useCurrentWorkspaceId(): string {
  return useSyncExternalStore(subscribe, () => stored, () => stored)
}

/** 测试用：复位模块级状态 */
export function resetCurrentWorkspaceForTest() {
  stored = readStored()
}

/** 工作台的默认模块；它要的插件没在跑时落到菜单里的第一个 */
export function homeModule<T extends { id: string }>(w: Workspace, live: readonly T[]): T | undefined {
  for (const key of [w.home, ...w.modules]) {
    const m = live.find((x) => x.id === moduleIdOf(key))
    if (m) return m
  }
  return undefined
}
