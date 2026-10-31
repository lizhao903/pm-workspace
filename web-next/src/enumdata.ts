// 枚举值：系统里各处下拉、筛选、状态标签用到的选项集中在这里管
// 规则：
//   key 一经创建不改，数据里存的是 key；显示名、颜色、说明、顺序随时可改
//   系统值（locked）是程序逻辑依赖的，比如任务的「已完成」，能改显示名和颜色，不能停用、不能删
//   停用：新建和编辑时不再出现，已经用了它的数据照常显示
//   删除：没被用过的直接删；被用过的要先选一个值合并过去，数据跟着改
import { createContext, useContext, useMemo } from 'react'
import { CONTENT_CATEGORIES, GROUPS } from './data'

// 不从 ui 里取分组颜色：ui 的 GroupPill 反过来读这里的枚举，互相引用会在加载时拿到未初始化的值
const GROUP_COLOR: Record<string, string> = { 客户: '#3d4fd6', 合作伙伴: '#0c8599', 同事: '#e8590c', 供应商: '#7048e8', 其他: '#868e96' }

export interface EnumItem {
  key: string
  label: string
  color: string
  desc: string
  enabled: boolean
  locked?: boolean
}

export interface EnumGroup {
  key: string
  name: string
  module: string
  desc: string
  /** 内置的枚举不能整组删除；自定义的可以 */
  builtin: boolean
  /** 新建时默认选中哪个 */
  default_key?: string
  items: EnumItem[]
}

export const MODULES = ['任务', '联系人', '文档', 'IM 消息', 'SOP', '自定义']

export const ENUM_COLORS = ['#3d4fd6', '#0c8599', '#2f7d43', '#b0570b', '#c0352b', '#7048e8', '#e8590c', '#a19d92']

const it = (key: string, label: string, color: string, desc = '', locked = false): EnumItem => ({ key, label, color, desc, enabled: true, locked })

export const seedEnums: EnumGroup[] = [
  {
    key: 'task_status', name: '任务状态', module: '任务', builtin: true, default_key: 'todo',
    desc: '任务列表的状态筛选和状态标签。五个都是系统值：完成率、逾期判断依赖它们',
    items: [it('todo', '待办', '#a19d92', '', true), it('doing', '进行中', '#3d4fd6', '', true), it('review', '待验收', '#7048e8', '做完了等人验收，验收通过再改成已完成', true), it('done', '已完成', '#2f7d43', '算作完成，不再提示逾期', true), it('cancelled', '已取消', '#a19d92', '不算完成也不算逾期', true)],
  },
  {
    key: 'task_priority', name: '任务优先级', module: '任务', builtin: true, default_key: 'P2',
    desc: '新建任务、Webhook 映射优先级时可选的值',
    items: [it('P0', 'P0 紧急', '#c0352b', '当天处理'), it('P1', 'P1 高', '#b0570b', '本周内'), it('P2', 'P2 中', '#3d4fd6'), it('P3', 'P3 低', '#a19d92', '有空再做')],
  },
  {
    key: 'contact_group', name: '联系人分组', module: '联系人', builtin: true, default_key: '其他',
    desc: '联系人的分组筛选和分组标签',
    items: GROUPS.map((g) => it(g, g, GROUP_COLOR[g])),
  },
  {
    key: 'content_category', name: '文档分类', module: '文档', builtin: true, default_key: 'note',
    desc: '工作台文档的分类，文档树的一级文件夹和顶栏筛选',
    items: CONTENT_CATEGORIES.map((c, i) => it(c.key, c.label, ENUM_COLORS[i])),
  },
  {
    key: 'msg_status', name: 'IM 消息状态', module: 'IM 消息', builtin: true, default_key: 'pending',
    desc: 'IM 消息的处理状态。四个都是系统值',
    items: [it('pending', '待处理', '#b0570b', '', true), it('done', '已处理', '#2f7d43', '', true), it('ignored', '已忽略', '#a19d92', '', true),
      it('expired', '已过期', '#868e96', '超过设置的天数没处理，不再提醒', true)],
  },
  {
    key: 'sop_trigger', name: 'SOP 触发方式', module: 'SOP', builtin: true, default_key: 'manual',
    desc: '编排 SOP 时开始节点可选的触发方式',
    items: [it('manual', '手动', '#a19d92', '', true), it('im', 'IM 消息', '#2f7d43', '收到符合条件的 IM 消息时'), it('daily', '每天 09:00', '#3d4fd6'), it('weekly', '每周一 18:00', '#3d4fd6')],
  },
  {
    key: 'customer_level', name: '客户等级', module: '自定义', builtin: false, default_key: 'B',
    desc: '自己加的枚举，还没有地方用到；以后联系人加自定义字段时可以引用',
    items: [it('A', 'A 级', '#c0352b', '年合同额 50 万以上'), it('B', 'B 级', '#b0570b'), it('C', 'C 级', '#a19d92')],
  },
]

/** 枚举在 App 里是 state，页面通过这个 context 读，改了枚举值各处跟着变 */
export const EnumContext = createContext<EnumGroup[]>(seedEnums)
export const useEnum = (key: string) => useContext(EnumContext).find((g) => g.key === key)?.items ?? []

/** 页面读枚举用这个：显示名、颜色、顺序都跟设置走，数据里存的 key 不变 */
export interface EnumView {
  /** 全部值，按设置里的顺序；筛选、展示已有数据用 */
  items: EnumItem[]
  /** 启用的值；新建时的选项 */
  options: EnumItem[]
  /** 编辑时的选项：启用的值，再加上当前值（哪怕已停用或已删除），保证已有数据能显示、不会被悄悄改掉 */
  optionsWith: (cur?: string | null) => EnumItem[]
  item: (k: string) => EnumItem | undefined
  /** 找不到的 key 原样显示 */
  label: (k: string) => string
  color: (k: string) => string
  /** 设置里的默认值；没设或已停用时取第一个启用的 */
  defaultKey: string | undefined
}

const FALLBACK_COLOR = '#a19d92'

export function enumView(groups: EnumGroup[], key: string): EnumView {
  // 内置枚举不能整组删除，这里再兜一层：context 里没有就用种子
  const g = groups.find((x) => x.key === key) ?? seedEnums.find((x) => x.key === key)
  const items = g?.items ?? []
  const options = items.filter((i) => i.enabled)
  const item = (k: string) => items.find((i) => i.key === k)
  const def = g?.default_key && options.some((i) => i.key === g.default_key) ? g.default_key : options[0]?.key
  return {
    items,
    options,
    optionsWith: (cur) => {
      if (!cur || options.some((i) => i.key === cur)) return options
      const hit = item(cur)
      // 停用的放回它在设置里的位置；已删除的补在最后
      return hit ? items.filter((i) => i.enabled || i.key === cur) : [...options, { key: cur, label: cur, color: FALLBACK_COLOR, desc: '', enabled: false }]
    },
    item,
    label: (k) => item(k)?.label ?? k,
    color: (k) => item(k)?.color ?? FALLBACK_COLOR,
    defaultKey: def,
  }
}

export function useEnumView(key: string): EnumView {
  const groups = useContext(EnumContext)
  return useMemo(() => enumView(groups, key), [groups, key])
}

export const KEY_RE = /^[A-Za-z0-9_一-龥-]{1,32}$/
