// 枚举值的草稿模型（SPEC-settings-17），照原型 web-next/src/enumdata.ts、enums.tsx。
// 后端的字典没有所属模块、默认值、系统值这几个字段：模块和系统值按字典 id 在这里登记，默认值存在条目的 meta.default（任务新建已经在读它）。
// 任务状态（object_types.statuses）和文档分类（categories）不在字典表里，换成同样的组在这里一起编辑（PR-13）。
import type { Category, DictItem, Dictionary, DictSavePlan, ObjectType } from '../../../core/data'

export type EnumItem = {
  /** 已保存的条目才有 */
  id?: string
  key: string
  label: string
  color: string
  desc: string
  enabled: boolean
  locked: boolean
  /** 接了数据的字典才有 */
  usage?: number
  meta: Record<string, unknown>
}

/** 数据从哪来：字典表、某类对象的状态集、某类对象的一级分类 */
export type EnumSource = 'dict' | 'status' | 'category'

export type EnumGroup = {
  key: string
  name: string
  module: string
  desc: string
  builtin: boolean
  default_key?: string
  items: EnumItem[]
  source: EnumSource
  /** 状态、分类所属的对象类型 */
  typeId?: string
  /** 值不能停用（分类没有停用） */
  noArchive?: boolean
  /** 默认值由程序定、这里不能改时的说明 */
  defaultHint?: string
}

/** 原型的 MODULES；后端的关联关系、产出物两本字典没有对应模块，分别归到任务、产出物；项目干系人角色（TSK-0718）归到项目 */
export const MODULES = ['任务', '联系人', '项目', '文档', 'IM 消息', 'SOP', '产出物', '其他', '自定义']
const MODULE_OF: Record<string, string> = {
  priority: '任务', link_relation: '任务', artifact_platform: '产出物', artifact_kind: '产出物', contact_group: '联系人', msg_status: 'IM 消息', project_role: '项目',
}
/** 枚举模块对应的菜单模块：当前工作台没开这个模块时整组不显示；没登记的（其他、自定义）一直显示 */
const MENU_OF: Record<string, string> = { 任务: 'tasks', 联系人: 'contacts', 项目: 'projects', 文档: 'library', 'IM 消息': 'messages', SOP: 'sop', 产出物: 'videos' }
export const moduleShown = (module: string, menu: readonly string[] | undefined) => !menu || !MENU_OF[module] || menu.includes(MENU_OF[module])

export const ENUM_COLORS = ['#3d4fd6', '#0c8599', '#2f7d43', '#b0570b', '#c0352b', '#7048e8', '#e8590c', '#a19d92']

export const KEY_RE = /^[A-Za-z0-9_一-龥-]{1,32}$/
export const KEY_HINT = '只能用字母、数字、中文、下划线和中划线，32 字以内'

/** 值超过这么多个时才出搜索框，已停用的沉底并默认收起 */
export const MANY = 12

/** 字典 id 不会和这两个撞：都带 task_ / doc_ 前缀且后端没有同名字典 */
export const TASK_STATUS = 'task_status'
export const DOC_CATEGORY = 'doc_category'

/** 后端按 key 写死的值：关联关系只认这五种，产出物认不出来时落到 other，IM 消息状态是表的约束，联系人没填分组算「其他」 */
const LOCKED: Record<string, string[] | '*'> = {
  link_relation: '*', artifact_platform: ['other'], artifact_kind: ['other'], msg_status: '*', contact_group: ['其他'],
}
/** 值由程序固定，不能加新值 */
export const FIXED = new Set(['link_relation', 'msg_status', TASK_STATUS])
/** 后端统计了引用数的字典（dictUsageSourceOf）；其余的「使用中」列为空，删除不用检查 */
const WIRED = new Set(['priority', 'link_relation', 'artifact_platform', 'artifact_kind', 'contact_group', 'msg_status', 'project_role'])
/** 没设默认值时的兜底，和任务新建（tasks/draft.ts）、联系人（contacts/model.ts 的 DEFAULT_GROUP）一致 */
const FALLBACK_DEFAULT: Record<string, string> = { priority: 'P2', contact_group: '其他', project_role: 'member' }
/** 默认值由程序定的字典 */
const DEFAULT_HINT: Record<string, string> = { msg_status: '新收到的消息都是待处理' }

const isLocked = (dictId: string, key: string) => {
  const l = LOCKED[dictId]
  return l === '*' || (!!l && l.includes(key))
}

export function toGroup(d: Dictionary, items: DictItem[]): EnumGroup {
  const sorted = [...items].sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key))
  const wired = WIRED.has(d.id)
  const out: EnumItem[] = sorted.map((i) => ({
    id: i.id, key: i.key, label: i.label, color: i.color, desc: i.description, enabled: !i.archived_at,
    locked: isLocked(d.id, i.key), usage: wired ? i.usage : undefined, meta: i.meta ?? {},
  }))
  const marked = out.find((i) => i.meta.default === true)?.key
  const fb = FALLBACK_DEFAULT[d.id]
  return {
    key: d.id, name: d.name, desc: d.description, builtin: d.builtin, module: MODULE_OF[d.id] ?? (d.builtin ? '其他' : '自定义'),
    default_key: marked ?? (fb && out.some((i) => i.key === fb) ? fb : undefined), items: out, source: 'dict', defaultHint: DEFAULT_HINT[d.id],
  }
}

/** 任务状态：都是系统值（完成率、逾期、验收按 key 判断），能改显示名、颜色、说明和顺序；条目 id 用 key */
export function statusGroup(t: ObjectType, byStatus: Record<string, number> | undefined): EnumGroup {
  return {
    key: TASK_STATUS, name: '任务状态', module: '任务', builtin: true, source: 'status', typeId: t.id,
    desc: '任务列表的状态筛选和状态标签。都是系统值：完成率、逾期判断依赖它们',
    defaultHint: '新建任务用排在第一个的状态',
    items: t.statuses.map((s) => ({
      id: s.key, key: s.key, label: s.label, color: s.color, desc: s.description ?? '', enabled: true, locked: true,
      usage: byStatus?.[`${t.id}:${s.key}`] ?? 0, meta: { terminal: s.terminal },
    })),
  }
}

/** 文档分类：文档树的一级分类，key 是 slug；没有停用，被文档用着或下面有子分类时不能删 */
export function categoryGroup(typeId: string, tree: Category[]): EnumGroup {
  const top = [...tree].filter((c) => !c.parent_id).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
  return {
    key: DOC_CATEGORY, name: '文档分类', module: '文档', builtin: true, source: 'category', typeId, noArchive: true,
    desc: '工作台文档的分类，文档树的一级文件夹和顶栏筛选。子分类在文档页里管',
    defaultHint: '新建文档放进当前打开的分类，没打开时放进排在第一个的',
    items: top.map((c, n) => ({
      id: c.id, key: c.slug, label: c.name, color: c.color || ENUM_COLORS[n % ENUM_COLORS.length], desc: c.description, enabled: true, locked: false,
      usage: c.total_count ?? 0, meta: { children: c.children?.length ?? 0 },
    })),
  }
}

/** 草稿和已保存的比，只比界面上能改的 */
export function sameGroup(a: EnumGroup, b: EnumGroup) {
  const pick = (g: EnumGroup) => [g.default_key ?? '', g.items.map((i) => [i.key, i.label, i.color, i.desc, i.enabled])]
  return JSON.stringify(pick(a)) === JSON.stringify(pick(b))
}

export function matchGroup(g: EnumGroup, kw: string) {
  const k = kw.trim().toLowerCase()
  return !k || [g.name, g.key, g.desc, ...g.items.map((i) => i.label)].some((v) => v.toLowerCase().includes(k))
}

export function validate(d: EnumGroup): string[] {
  const out: string[] = []
  const keys = d.items.map((i) => i.key)
  d.items.forEach((i, n) => {
    if (!i.label.trim()) out.push(`第 ${n + 1} 个值没有显示名`)
    if (!KEY_RE.test(i.key)) out.push(`「${i.label || i.key}」的 key ${KEY_HINT}`)
    else if (keys.indexOf(i.key) !== n) out.push(`key「${i.key}」重复了`)
  })
  if (!d.items.some((i) => i.enabled)) out.push('至少保留一个启用的值')
  if (d.default_key && !d.items.some((i) => i.key === d.default_key && i.enabled)) out.push('默认值必须是一个启用的值')
  return out
}

/** 末尾加一个空值：key 为 v<序号>（避开已有的），颜色按位置轮流取 */
export function newItem(d: EnumGroup): EnumItem {
  let n = d.items.length + 1
  while (d.items.some((i) => i.key === `v${n}`)) n += 1
  return { key: `v${n}`, label: '', color: ENUM_COLORS[d.items.length % ENUM_COLORS.length], desc: '', enabled: true, locked: false, meta: {} }
}

function withDefault(meta: Record<string, unknown>, on: boolean): Record<string, unknown> {
  const { default: _, ...rest } = meta
  return on ? { ...rest, default: true } : rest
}

/** 草稿和已保存的差异，换成要写的接口 */
export function savePlan(saved: EnumGroup, d: EnumGroup, typeId?: string): DictSavePlan {
  const byKey = new Map(saved.items.map((i) => [i.key, i]))
  const kept = new Set(d.items.map((i) => i.key))
  const plan: DictSavePlan = { dictId: saved.key, typeId, deletes: [], creates: [], patches: [], archives: [], order: null }
  for (const s of saved.items) if (!kept.has(s.key) && s.id) plan.deletes.push(s.id)
  const wasDefault = (k: string) => byKey.get(k)?.meta.default === true
  for (const i of d.items) {
    const label = i.label.trim()
    const isDef = d.default_key === i.key
    const s = byKey.get(i.key)
    if (!s?.id) {
      plan.creates.push({ key: i.key, label, color: i.color, description: i.desc, ...(isDef && { meta: { default: true } }), archived: !i.enabled })
      continue
    }
    const patch: DictSavePlan['patches'][number]['patch'] = {}
    if (label !== s.label) patch.label = label
    if (i.color !== s.color) patch.color = i.color
    if (i.desc !== s.desc) patch.description = i.desc
    // 默认值只在换了的时候写；兜底的默认（P2）没标过，不换就不动
    if (saved.default_key !== d.default_key && isDef !== wasDefault(i.key)) patch.meta = withDefault(s.meta, isDef)
    if (Object.keys(patch).length) plan.patches.push({ id: s.id, patch })
    if (i.enabled !== s.enabled) plan.archives.push({ id: s.id, archived: !i.enabled })
  }
  // 新建的后端排在末尾；草稿的顺序和那样不一致才整组重排
  const expected = [...saved.items.filter((s) => kept.has(s.key)).map((s) => s.key), ...plan.creates.map((c) => c.key)]
  const order = d.items.map((i) => i.key)
  if (order.join('\n') !== expected.join('\n')) plan.order = order
  return plan
}

export const planEmpty = (p: DictSavePlan) => !p.deletes.length && !p.creates.length && !p.patches.length && !p.archives.length && !p.order
