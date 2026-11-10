// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 任务的产出物汇总（TSK-0497）：任务列表、看板卡片上的「3 · 提交 2 文档 1」，「产出物」视图的筛选口径。
// 数据来自 GET /api/artifacts/by-object，种类按后端给的 display_kind（历史上没填 kind 的后端按备注、链接、扩展名推断），
// 前端不再推一遍；种类名和顺序取字典 artifact_kind，字典没取到时用这里的内置名。
import type { ArtifactObjectSummary, ArtifactSource, DictItem } from '../../core/data'

/** 字典 artifact_kind 的内置条目（0031），字典没取到、或插件加的种类没在字典里时兜底 */
export const KIND_FALLBACK: { key: string; label: string }[] = [
  { key: 'commit', label: '提交' },
  { key: 'branch', label: '分支' },
  { key: 'pr', label: '合并请求' },
  { key: 'doc', label: '文档' },
  { key: 'prototype', label: '原型' },
  { key: 'code', label: '代码' },
  { key: 'data', label: '数据' },
  { key: 'other', label: '其他' },
]

export type KindInfo = { key: string; label: string; color?: string }

/** 种类表：字典里的按字典顺序在前（含已停用的，老数据照样要有名字），字典里没有的内置种类补在后面 */
export function kindTable(dict: readonly DictItem[] | undefined): KindInfo[] {
  const out: KindInfo[] = (dict ?? []).map((d) => ({ key: d.key, label: d.label, color: d.color || undefined }))
  for (const f of KIND_FALLBACK) if (!out.some((k) => k.key === f.key)) out.push(f)
  return out
}

export const kindLabel = (kinds: readonly KindInfo[], key: string) => kinds.find((k) => k.key === key)?.label ?? key

export type KindPart = { key: string; label: string; n: number }

/** 一个对象的各种类条数，按种类表顺序，0 条的不要；种类表里没有的排最后 */
export function kindParts(byKind: Record<string, number>, kinds: readonly KindInfo[]): KindPart[] {
  const rank = (k: string) => {
    const i = kinds.findIndex((x) => x.key === k)
    return i < 0 ? kinds.length : i
  }
  return Object.entries(byKind)
    .filter(([, n]) => n > 0)
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([key, n]) => ({ key, label: kindLabel(kinds, key), n }))
}

/** 「3 · 提交 2 文档 1」：只有一种时省掉分项（「2 · 提交 2」是废话），写成「2 · 提交」 */
export function summaryText(total: number, parts: readonly KindPart[]): string {
  if (!parts.length) return String(total)
  if (parts.length === 1) return `${total} · ${parts[0].label}`
  return `${total} · ${parts.map((p) => `${p.label} ${p.n}`).join(' ')}`
}

/** 悬停提示：每种一行 */
export const summaryTitle = (total: number, parts: readonly KindPart[]) =>
  [`产出物 ${total} 件`, ...parts.map((p) => `${p.label} ${p.n}`)].join('\n')

/** 任务列表、看板的「产出」筛选：全部 / 有产出 / 无产出 */
export type OutputsFilter = '' | 'with' | 'without'
export const OUTPUTS_FILTERS: { key: OutputsFilter; label: string }[] = [
  { key: '', label: '全部产出' },
  { key: 'with', label: '有产出' },
  { key: 'without', label: '无产出' },
]

/** 汇总还没取到（undefined）时不筛：不能把「还不知道」当成「无产出」 */
export function matchOutputs(id: string, f: OutputsFilter, outputs: ReadonlyMap<string, ArtifactObjectSummary> | undefined): boolean {
  if (!f || !outputs) return true
  return f === 'with' ? outputs.has(id) : !outputs.has(id)
}

/** 来源（登记途径）的叫法；契约「登记来源」 */
export const SOURCE_LABEL: Record<ArtifactSource, string> = { agent: '内置 Agent', run: '任务执行', manual: '手工登记', mcp: 'MCP 回写' }
export const SOURCES: ArtifactSource[] = ['agent', 'run', 'manual', 'mcp']

/** 时间筛选：按产出物的登记时间 */
export type OutputsSince = '' | '7d' | '30d' | '90d'
export const SINCE_OPTIONS: { key: OutputsSince; label: string; days: number }[] = [
  { key: '7d', label: '最近 7 天', days: 7 },
  { key: '30d', label: '最近 30 天', days: 30 },
  { key: '90d', label: '最近 90 天', days: 90 },
]

/** 时间筛选换成接口的 since：本地日期 YYYY-MM-DD（后端按本地时区补当天 00:00），按天取整，缓存键一天内不变 */
export function sinceParam(k: OutputsSince, now: Date): string | undefined {
  const o = SINCE_OPTIONS.find((x) => x.key === k)
  if (!o) return undefined
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (o.days - 1))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 产出物视图的本地搜索：编号、任务标题、项目名（产出物本身的标题、路径、链接、备注交给后端 q） */
export function matchSummary(s: ArtifactObjectSummary, kw: string): boolean {
  const k = kw.trim().toLowerCase()
  if (!k) return true
  return [s.object_ref, s.object_title, s.project_title].some((v) => v.toLowerCase().includes(k))
}
