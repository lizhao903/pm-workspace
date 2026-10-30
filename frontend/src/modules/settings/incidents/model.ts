// 运行异常页的纯函数（SPEC-settings-18、19），照原型 web-next/src/incidents.tsx、incidentdata.ts：
// 筛选、同类合并、顶栏数字、转任务的预填、自动巡检的默认定时任务。
import { INCIDENT_MODULES, type DictItem, type Incident, type IncidentStatus, type Schedule, type ScheduleInput } from '../../../core/data'

export type StatusFilter = IncidentStatus | 'all'
export type LevelFilter = '' | 'error' | 'warn'

export const STATUS_FILTERS: [StatusFilter, string][] = [['open', '未处理'], ['tasked', '已转任务'], ['resolved', '已解决'], ['ignored', '已忽略'], ['all', '全部']]
export const LEVEL_FILTERS: [LevelFilter, string][] = [['', '全部级别'], ['error', '错误'], ['warn', '警告']]
export const LEVEL_LABEL = { error: '错误', warn: '警告' } as const

/** 一次先露多少行（SPEC-settings-18.9） */
export const PAGE = 50
/** 同模块、同指纹前缀的异常到这个数合并成一行（SPEC-settings-18.7） */
export const MERGE_MIN = 5
/** 次数到这个数标热 */
export const HOT = 5

export const matchStatus = (x: Incident, s: StatusFilter) => s === 'all' || x.status === s

/** 指纹前缀：conn:cn_wechat:auth -> conn */
export const fpKind = (x: Incident) => x.fingerprint.split(':')[0]

export type Filters = { status: StatusFilter; level: LevelFilter; module: string; q: string }

/** 筛出来的，按最近一次倒序 */
export function filterIncidents(xs: readonly Incident[], f: Filters): Incident[] {
  const kw = f.q.trim().toLowerCase()
  return xs
    .filter((x) => matchStatus(x, f.status) && (!f.module || x.module === f.module) && (!f.level || x.level === f.level)
      && (!kw || `${x.title}${x.message}`.toLowerCase().includes(kw)))
    .sort((a, b) => b.last_at.localeCompare(a.last_at))
}

/** 模块下拉：出现过的模块，按 INCIDENT_MODULES 顺序，不在里面的（前端页面所属的模块）按名字排在后面 */
export function modulesOf(xs: readonly Incident[]): string[] {
  const seen = new Set(xs.map((x) => x.module))
  const known = (INCIDENT_MODULES as readonly string[]).filter((m) => seen.has(m))
  const rest = [...seen].filter((m) => !(INCIDENT_MODULES as readonly string[]).includes(m)).sort((a, b) => a.localeCompare(b, 'zh-CN'))
  return [...known, ...rest]
}

export type Entry = { kind: 'one'; x: Incident } | { kind: 'group'; key: string; xs: Incident[] }

/** 同模块、同指纹前缀到 MERGE_MIN 条合并成一组；搜索时不合并。组的位置跟着组里最近的那条走 */
export function entriesOf(rows: readonly Incident[], searching: boolean): Entry[] {
  if (searching) return rows.map((x) => ({ kind: 'one', x }))
  const key = (x: Incident) => `${x.module}|${fpKind(x)}`
  const by = new Map<string, Incident[]>()
  for (const x of rows) by.set(key(x), [...(by.get(key(x)) ?? []), x])
  const done = new Set<string>()
  const out: Entry[] = []
  for (const x of rows) {
    const k = key(x)
    const xs = by.get(k)!
    if (xs.length < MERGE_MIN) out.push({ kind: 'one', x })
    else if (!done.has(k)) { done.add(k); out.push({ kind: 'group', key: k, xs }) }
  }
  return out
}

/** 顶栏数字（SPEC-settings-18.1）：「N 个未处理」，有警告时「N 个未处理，M 个是错误」 */
export function headCount(xs: readonly Incident[]): string {
  const open = xs.filter((x) => x.status === 'open')
  const errs = open.filter((x) => x.level === 'error').length
  return `${open.length} 个未处理${errs && errs < open.length ? `，${errs} 个是错误` : ''}`
}

/** 优先级预填（SPEC-settings-19.7）：错误 5 次以上 P0、错误 P1、警告 P2；字典里没有这一档时用字典默认值 */
export function levelPriority(x: Pick<Incident, 'level' | 'count'>, prios: readonly DictItem[]): string {
  const want = x.level === 'error' ? (x.count >= HOT ? 'P0' : 'P1') : 'P2'
  const live = prios.filter((p) => !p.archived_at)
  if (!live.length || live.some((p) => p.key === want)) return want
  return (live.find((p) => p.meta?.default === true) ?? live[0]).key
}

const when = (iso: string) => new Date(iso).toLocaleString('zh-CN')

/** 转任务的描述（SPEC-settings-19.6 taskDesc）：现象、频率、上下文、报错、期望 */
export function taskDesc(x: Incident): string {
  const ctx = Object.entries(x.context ?? {}).map(([k, v]) => `- ${k}：${v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n')
  return [
    `【运行异常】${x.module} · ${LEVEL_LABEL[x.level]}`,
    `现象：${x.message}`,
    `频率：共 ${x.count} 次，首次 ${when(x.first_at)}，最近 ${when(x.last_at)}`,
    ctx && `上下文：\n${ctx}`,
    x.stack && `报错：\n${x.stack}`,
    '期望：系统能自己处理这种情况，或者给出明确的修复指引。',
  ].filter(Boolean).join('\n\n')
}

export const taskTitle = (x: Incident) => `[异常] ${x.module}：${x.title}`

// ---- 自动巡检（定时任务动作 incident_sweep） ----

export const SWEEP_KIND = 'incident_sweep'

export type SweepAction = { kind: typeof SWEEP_KIND; min_level: 'error' | 'warn'; min_count: number }

export function sweepOf(s: Schedule): SweepAction | null {
  const a = s.action as unknown as Partial<SweepAction> & { kind: string }
  if (a.kind !== SWEEP_KIND) return null
  return { kind: SWEEP_KIND, min_level: a.min_level === 'warn' ? 'warn' : 'error', min_count: typeof a.min_count === 'number' && a.min_count > 0 ? a.min_count : 1 }
}

/** 已有的巡检定时任务：启用的优先，其次最早建的 */
export function findSweep(xs: readonly Schedule[]): Schedule | undefined {
  const all = xs.filter((s) => s.action.kind === SWEEP_KIND)
  return all.find((s) => s.enabled) ?? all[0]
}

/** 「只看错误」「错误和警告，至少 3 次」 */
export function sweepText(a: SweepAction): string {
  const lv = a.min_level === 'warn' ? '错误和警告' : '只看错误'
  return a.min_count > 1 ? `${lv}，至少 ${a.min_count} 次` : lv
}

/** 一键开启：每天 9:00，只看错误，至少 1 次 */
export function defaultSweepInput(now: Date = new Date()): ScheduleInput {
  const pad = (n: number) => String(n).padStart(2, '0')
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return {
    name: '运行异常巡检',
    enabled: true,
    rule: { freq: 'daily', time: '09:00', weekdays: [1], day: 1, date: `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`, cron: '0 9 * * *' },
    action: { kind: SWEEP_KIND, min_level: 'error', min_count: 1 },
  }
}
