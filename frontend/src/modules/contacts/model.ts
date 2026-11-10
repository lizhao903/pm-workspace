// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 联系人列表的纯函数（SPEC-contacts-1）：分组（可多个）、搜索、排序、分段、相对时间。页面状态和渲染在 Page.tsx。
import { contactGroupsOf, imOf, type Contact, type DictItem, type Dictionary, type Identity } from '../../core/data'
import { initialRank, nameInitial } from '../../core/ui/pinyin'

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

/** 多个分组存成一个字符串，用「、」连接；读的时候也认逗号、斜杠和分号 */
export const GROUP_SEP = '、'

/** 联系人的分组 key 列表：拆开、去空白、去重；后端默认空串，按默认分组算 */
export const groupsOf = (c: Pick<Contact, 'group'>): string[] => contactGroupsOf(c)

/** 存回后端的分组字符串 */
export const joinGroups = (gs: string[]) => gs.join(GROUP_SEP)

/** IM 渠道（SPEC-contacts-0 的 IM_CHANNELS）；加渠道只改这张表。身份来自 /api/im-identities（CT-01b），合进 Contact.im */
export type ImChannel = {
  key: string; label: string; short: string; color: string
  /** 表单里提示填什么 */
  hint: string
  /** 能直达会话的给链接，没有公开 deep link 的只提供复制 */
  link?: (id: string) => string
}
export const IM_CHANNELS: ImChannel[] = [
  { key: 'wechat', label: '微信', short: '微信', color: '#07c160', hint: '微信号，不是昵称' },
  { key: 'lark', label: '飞书', short: '飞书', color: '#3370ff', hint: '飞书 / Lark 的用户 ID 或登录邮箱' },
  { key: 'slack', label: 'Slack', short: 'Slack', color: '#611f69', hint: 'Member ID，形如 U01ABCDEF' },
  { key: 'telegram', label: 'Telegram', short: 'TG', color: '#229ed9', hint: '用户名，形如 @name', link: (id) => `https://t.me/${id.replace(/^@+/, '')}` },
  { key: 'qq', label: 'QQ', short: 'QQ', color: '#12b7f5', hint: 'QQ 号' },
]

/** 身份合进联系人：身份接口能用时每个人都带 im（没有身份是空对象），不能用时保持 undefined，列表不显示 IM 列 */
export function mergeIm(list: Contact[], byContact: Map<string, Identity[]> | null): Contact[] {
  if (!byContact) return list
  return list.map((c) => ({ ...c, im: imOf(byContact.get(c.id)) }))
}

/** 接口带不带 IM 身份：不带时不显示 IM 列和渠道筛选 */
export const hasImField = (list: Contact[]) => list.some((c) => c.im !== undefined)

/** 每个联系人预先算好的：索引字母、搜索用的文本 */
export type Row = { c: Contact; initial: string; hay: string[] }

export function toRows(list: Contact[]): Row[] {
  return list.map((c) => ({
    c,
    initial: nameInitial(c.name),
    // 备注和角色里常写别名、职责（B-04），也一起搜
    hay: [c.name, c.company, c.title, c.phone.replace(/\s/g, ''), c.email, ...c.tags, ...Object.values(c.im ?? {}), c.role, c.note]
      .filter(Boolean).map((v) => v.toLowerCase()),
  }))
}

/** 搜索：不区分大小写；整串或去掉空格后（电话「137 22」）被某个字段包含即命中，
 * 否则按空格拆词，每个词都要命中某个字段，可以是不同字段（「Globex 信用卡」） */
export function matches(r: Row, q: string): boolean {
  const kw = q.trim().toLowerCase()
  if (!kw) return true
  const tight = kw.replace(/\s/g, '')
  if (r.hay.some((v) => v.includes(kw) || v.includes(tight))) return true
  const words = kw.split(/\s+/)
  return words.length > 1 && words.every((w) => r.hay.some((v) => v.includes(w)))
}

/** 默认排序（E-03）：没联系过的人多于一半时按姓名，否则按最近联系；还没有人时按最近联系 */
export function defaultSort(list: readonly Pick<Contact, 'last_contact_at'>[]): Sort {
  const never = list.filter((c) => !c.last_contact_at).length
  return never * 2 > list.length ? 'name' : 'recent'
}

export type Filter = { q: string; group: string | null; starredOnly: boolean; channel: string; sort: Sort }

const zh = new Intl.Collator('zh-CN')

/** 筛选加排序：按姓名时先按索引字母（英文名和中文名混排，# 最后），同字母内按中文排序规则；按最近联系倒序，没联系过的最后 */
export function applyFilter(rows: Row[], f: Filter): Row[] {
  const out = rows.filter((r) => (!f.group || groupsOf(r.c).includes(f.group)) && (!f.starredOnly || r.c.starred)
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

/** 分组切换的内容：一个人在几个分组里就各算一次；列出启用的和停用但还有人的；多于 SEG_MAX+1 个时切换里放人数最多的 SEG_MAX 个（保持枚举顺序），其余进「更多分组」 */
export function groupView(items: GroupItem[], contacts: Contact[]) {
  const counts = new Map<string, number>()
  for (const c of contacts) for (const g of groupsOf(c)) counts.set(g, (counts.get(g) ?? 0) + 1)
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

// ---- 新建和编辑（SPEC-contacts-3） ----

export type Draft = {
  name: string; company: string; title: string; phone: string; email: string; group: string[]
  tags: string[]; photo: string; note: string; im: Record<string, string>
}

/** 新建的空白值；分组取枚举默认值 */
export const blankDraft = (group = DEFAULT_GROUP): Draft => ({
  name: '', company: '', title: '', phone: '', email: '', group: [group], tags: [], photo: '', note: '', im: {},
})

export const draftOf = (c: Contact): Draft => ({
  name: c.name, company: c.company, title: c.title, phone: c.phone, email: c.email, group: groupsOf(c),
  tags: c.tags, photo: c.photo, note: c.note, im: { ...(c.im ?? {}) },
})

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** 校验：姓名必填，邮箱非空时要像邮箱；电话不校验 */
export function validate(d: Draft): { name: string; email: string } {
  return {
    name: d.name.trim() ? '' : '姓名必填',
    email: d.email.trim() && !EMAIL.test(d.email.trim()) ? '邮箱格式不对' : '',
  }
}

/** 表单可选的分组：启用的，加上当前选中的（即使已停用或字典里没有） */
export function groupOptions(items: GroupItem[], current: string[]): GroupItem[] {
  const out = items.filter((g) => g.enabled || current.includes(g.key))
  for (const k of current) if (!items.some((g) => g.key === k)) out.push({ key: k, label: k, color: GONE_COLOR, enabled: false })
  return out
}

/** 表单里点一个分组：选上或去掉，至少留一个；顺序按可选项的顺序 */
export function toggleGroup(opts: GroupItem[], current: string[], key: string): string[] {
  const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key]
  if (!next.length) return current
  const rank = (k: string) => { const i = opts.findIndex((g) => g.key === k); return i < 0 ? opts.length : i }
  return [...next].sort((a, b) => rank(a) - rank(b))
}

/** 删除前的检查：名册只在零引用时允许删除，有负责或参与的事就拦下，改为归档 */
export function deleteBlock(c: Pick<Contact, 'name' | 'owned_count' | 'participating_count'>): string | null {
  const parts = [c.owned_count > 0 && `负责 ${c.owned_count} 件事`, c.participating_count > 0 && `参与 ${c.participating_count} 件事`].filter(Boolean)
  if (!parts.length) return null
  return `「${c.name}」还${parts.join('、')}，不能删除。可以改为归档：不再出现在联系人里，事项上的负责人和参与人保持不变`
}

/** 撞名 409 的提示（后端是英文）：要求加区分 */
export const dupNameText = (name: string) => `已经有叫「${name}」的联系人了，名字加个区分再保存，比如「${name}（公司）」`
