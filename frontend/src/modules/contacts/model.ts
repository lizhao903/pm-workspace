// 联系人列表的纯函数（SPEC-contacts-1）：分组、搜索、排序、分段、相对时间。页面状态和渲染在 Page.tsx。
import type { Contact, DictItem, Dictionary } from '../../core/data'
import { initialRank, nameInitial } from './pinyin'

/** 分组切换里最多放几个分组，其余收进「更多分组」 */
export const SEG_MAX = 5
/** 表格先渲染这么多行，底部「显示更多」再加这么多 */
export const PAGE = 100

export type Sort = 'recent' | 'name'

export type GroupItem = { key: string; label: string; color: string; enabled: boolean }

/** 联系人分组字典的 id；设置里能新增分组后由后端提供 */
export const GROUP_DICT = 'contact_group'
/** 分组字典的默认项 */
export const DEFAULT_GROUP = '其他'
/** 字典删掉了的分组按原值显示，用灰色 */
export const GONE_COLOR = '#868e96'

// 后端还没有 contact_group 字典时的兜底：规格里的内置五组（SPEC-contacts-0），颜色同原型
const BUILTIN_GROUPS: GroupItem[] = [
  { key: '客户', label: '客户', color: '#3d4fd6', enabled: true },
  { key: '合作伙伴', label: '合作伙伴', color: '#0c8599', enabled: true },
  { key: '同事', label: '同事', color: '#e8590c', enabled: true },
  { key: '供应商', label: '供应商', color: '#7048e8', enabled: true },
  { key: '其他', label: '其他', color: GONE_COLOR, enabled: true },
]

/** 分组枚举：有字典用字典（含已归档的，按 sort_order），没有用内置五组 */
export function groupItems(dicts: Dictionary[] | undefined): GroupItem[] {
  const items: DictItem[] | undefined = dicts?.find((d) => d.id === GROUP_DICT)?.items
  if (!items?.length) return BUILTIN_GROUPS
  return [...items].sort((a, b) => a.sort_order - b.sort_order)
    .map((i) => ({ key: i.key, label: i.label, color: i.color || GONE_COLOR, enabled: !i.archived_at }))
}

/** 联系人的分组 key：后端默认空串，按默认分组算 */
export const groupOf = (c: Pick<Contact, 'group'>) => c.group.trim() || DEFAULT_GROUP

/** IM 渠道（SPEC-contacts-0 的 IM_CHANNELS）；加渠道只改这张表。IM 身份表（CT-01b）上线前接口不带 im */
export type ImChannel = { key: string; label: string; short: string; color: string }
export const IM_CHANNELS: ImChannel[] = [
  { key: 'wechat', label: '微信', short: '微信', color: '#07c160' },
  { key: 'lark', label: '飞书', short: '飞书', color: '#3370ff' },
  { key: 'slack', label: 'Slack', short: 'Slack', color: '#611f69' },
  { key: 'telegram', label: 'Telegram', short: 'TG', color: '#229ed9' },
  { key: 'qq', label: 'QQ', short: 'QQ', color: '#12b7f5' },
]

/** 接口带不带 IM 身份：不带时不显示 IM 列和渠道筛选 */
export const hasImField = (list: Contact[]) => list.some((c) => c.im !== undefined)

/** 每个联系人预先算好的：索引字母、搜索用的文本 */
export type Row = { c: Contact; initial: string; hay: string[] }

export function toRows(list: Contact[]): Row[] {
  return list.map((c) => ({
    c,
    initial: nameInitial(c.name),
    hay: [c.name, c.company, c.title, c.phone.replace(/\s/g, ''), c.email, ...c.tags, ...Object.values(c.im ?? {})]
      .filter(Boolean).map((v) => v.toLowerCase()),
  }))
}

/** 搜索：不区分大小写，任一字段包含即命中；电话忽略空格（输「137 22」也能搜到） */
export function matches(r: Row, q: string): boolean {
  const kw = q.trim().toLowerCase()
  if (!kw) return true
  const tight = kw.replace(/\s/g, '')
  return r.hay.some((v) => v.includes(kw) || v.includes(tight))
}

export type Filter = { q: string; group: string | null; starredOnly: boolean; channel: string; sort: Sort }

const zh = new Intl.Collator('zh-CN')

/** 筛选加排序：按姓名时先按索引字母（英文名和中文名混排，# 最后），同字母内按中文排序规则；按最近联系倒序，没联系过的最后 */
export function applyFilter(rows: Row[], f: Filter): Row[] {
  const out = rows.filter((r) => (!f.group || groupOf(r.c) === f.group) && (!f.starredOnly || r.c.starred)
    && (!f.channel || !!r.c.im?.[f.channel]) && matches(r, f.q))
  return out.sort(f.sort === 'name'
    ? (a, b) => initialRank(a.initial) - initialRank(b.initial) || zh.compare(a.c.name, b.c.name)
    : (a, b) => (b.c.last_contact_at ?? '').localeCompare(a.c.last_contact_at ?? '') || zh.compare(a.c.name, b.c.name))
}

const DAY = 86_400_000

/** 按最近联系分段：今天 / 本周（周一起）/ 本月 / 更早 / 未联系，按本机时区 */
export function recentBucket(iso: string | null, now = new Date()): string {
  if (!iso) return '未联系'
  const d = new Date(iso).getTime()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const week = today - ((now.getDay() + 6) % 7) * DAY
  const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  return d >= today ? '今天' : d >= week ? '本周' : d >= month ? '本月' : '更早'
}

export const sectionOf = (r: Row, sort: Sort, now?: Date) => (sort === 'name' ? r.initial : recentBucket(r.c.last_contact_at, now))

/** 各段人数（算的是筛选后的全部，不只是已渲染的） */
export function sectionCounts(rows: Row[], sort: Sort, now?: Date): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) {
    const s = sectionOf(r, sort, now)
    m.set(s, (m.get(s) ?? 0) + 1)
  }
  return m
}

/** 最近联系列：今天 / 昨天 / N 天前 / N 个月前 / N 年前；没联系过返回 null。按日历日算 */
export function ago(iso: string | null, now = new Date()): string | null {
  if (!iso) return null
  const t = new Date(iso)
  const d = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    - new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()) / DAY)
  if (d <= 0) return '今天'
  if (d === 1) return '昨天'
  if (d < 30) return `${d} 天前`
  if (d < 365) return `${Math.floor(d / 30)} 个月前`
  return `${Math.floor(d / 365)} 年前`
}

/** 分组切换的内容：列出启用的和停用但还有人的；多于 SEG_MAX+1 个时切换里放人数最多的 SEG_MAX 个（保持枚举顺序），其余进「更多分组」 */
export function groupView(items: GroupItem[], contacts: Contact[]) {
  const counts = new Map<string, number>()
  for (const c of contacts) counts.set(groupOf(c), (counts.get(groupOf(c)) ?? 0) + 1)
  const countOf = (k: string) => counts.get(k) ?? 0
  const groups = items.filter((g) => g.enabled || countOf(g.key) > 0)
  // 字典里没有的分组值（被删掉的）也要能筛到，排在最后
  const known = new Set(items.map((g) => g.key))
  for (const k of counts.keys()) if (!known.has(k)) groups.push({ key: k, label: k, color: GONE_COLOR, enabled: false })
  const top = groups.length <= SEG_MAX + 1 ? null
    : new Set([...groups].sort((a, b) => countOf(b.key) - countOf(a.key)).slice(0, SEG_MAX).map((g) => g.key))
  return {
    countOf,
    seg: top ? groups.filter((g) => top.has(g.key)) : groups,
    more: top ? groups.filter((g) => !top.has(g.key)) : [],
  }
}

/** 分组标签的颜色：字典里删掉了的分组用灰 */
export function groupColor(items: GroupItem[], key: string) {
  return items.find((g) => g.key === key)?.color ?? GONE_COLOR
}
