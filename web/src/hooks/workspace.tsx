// 工作台全局状态。所有组件通过 useWorkspace() 消费，禁止组件内自行 fetch。
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react'
import { api, ApiError } from '../lib/api'
import type {
  Category, Counts, CreateObjectInput, ObjectPatch, ObjectQuery,
  ObjectType, Stats, Tag, ViewMode, WorkObject,
} from '../lib/types'

export type FocusKind = 'inbox' | 'today' | 'week' | 'overdue' | 'stalled' | 'trash'
// 独立页面：不走对象列表，由 App 直接分发到对应页面组件
export type PageKind = 'shortcuts' | 'settings'
// 设置的二级页面；nav.section 指定打开哪一个
export type SettingsSection =
  | 'types' | 'categories' | 'tags' | 'stakeholders' | 'priority' | 'link-relation' | 'data' | 'agent'
export type DrawerTab = 'detail' | 'ai' | 'activity' | 'links'
// 'type' 只在「全部类型」作用域下有意义：跨类型时分类树会把不同类型的同名分类混成一组
export type GroupBy = 'none' | 'category' | 'status' | 'priority' | 'type'

// 侧栏只回答「我在看哪类工作对象」。所有「看哪些」的条件都在 Filters 里，由内容页工具条控制。
export interface NavSelection {
  kind: 'type' | 'page'
  typeId?: string // undefined = 全部类型（跨类型视图）
  categoryId?: string
  subtree?: boolean
  uncategorized?: boolean // 只看该类型下未分类的对象
  page?: PageKind
  section?: SettingsSection // page='settings' 时指定二级页
}

export interface Filters {
  focus: FocusKind | null // 收件箱/今日/本周/逾期/停滞/回收站，null = 全部
  status: string[]
  priority: string[]
  tags: string[]
  q: string
  /** 干系人 id，不是名字。
   *  不叫 owner 是因为 WorkObject.owner 是那个已经作废的自由文本字段——
   *  同一个词在同一个代码库里指两个东西，注释挡不住手快的人。 */
  ownerId: string
}

const emptyFilters: Filters = { focus: null, status: [], priority: [], tags: [], q: '', ownerId: '' }

export interface WorkspaceValue {
  // 元数据
  types: ObjectType[]
  typeById: Record<string, ObjectType>
  tags: Tag[]
  counts: Counts | null
  stats: Stats | null

  // 当前导航
  nav: NavSelection
  setNav: (n: NavSelection) => void
  categories: Category[] // 当前导航类型的分类树（嵌套 children）
  activeType: ObjectType | null

  // 列表
  objects: WorkObject[]
  total: number
  loading: boolean
  error: string | null
  filters: Filters
  setFilters: (f: Partial<Filters>) => void
  resetFilters: () => void
  sort: string
  setSort: (s: string) => void
  viewMode: ViewMode
  setViewMode: (v: ViewMode) => void
  groupBy: GroupBy
  setGroupBy: (g: GroupBy) => void

  // 选中与抽屉
  selectedId: string | null
  selected: WorkObject | null
  select: (id: string | null) => void
  drawerOpen: boolean
  setDrawerOpen: (b: boolean) => void
  drawerTab: DrawerTab
  setDrawerTab: (t: DrawerTab) => void

  // 弹层
  quickCaptureOpen: boolean
  setQuickCaptureOpen: (b: boolean) => void
  categoryManagerOpen: boolean
  setCategoryManagerOpen: (b: boolean) => void
  commandPaletteOpen: boolean
  setCommandPaletteOpen: (b: boolean) => void

  // 动作
  createObject: (input: CreateObjectInput) => Promise<WorkObject>
  updateObject: (id: string, patch: ObjectPatch) => Promise<WorkObject>
  deleteObject: (id: string, hard?: boolean) => Promise<void>
  restoreObject: (id: string) => Promise<void>
  reloadAll: () => Promise<void>
  reloadObjects: () => Promise<void>
  reloadCategories: () => Promise<void>
  reloadCounts: () => Promise<void>

  /** 一步跳到某个视图：同时设置侧栏作用域与工具条条件 */
  applyView: (v: ViewDescriptor) => void
  /** 当前视图的描述符，供「存为快捷入口」 */
  currentView: () => ViewDescriptor
}

/* ────────────────── 视图描述符 ────────────────── */

// 一个「视图」= 侧栏作用域 + 工具条条件。快捷入口的 internal 目标、以及 M2 的保存视图都用它。
// 单独定义而不是复用 NavSelection：存快捷入口时用户期望连筛选一起存下来。
export interface ViewDescriptor {
  typeId?: string
  categoryId?: string
  subtree?: boolean
  uncategorized?: boolean
  focus?: FocusKind | null
  status?: string[]
  priority?: string[]
  tags?: string[]
  /** 干系人 id。0010 之前这里存的是 owner 名字，键名也叫 owner——
   *  parseView 会把那个旧键直接丢掉，不做转换：把名字当 id 用会筛出 0 条，
   *  而用户看到的是「这个人名下什么都没有」，比筛选条整个消失更难查。 */
  owner_id?: string
  q?: string
}

/** 把当前状态导出成视图描述符，供「存为快捷入口」使用 */
export function toView(nav: NavSelection, filters: Filters): ViewDescriptor {
  const v: ViewDescriptor = {}
  if (nav.typeId) v.typeId = nav.typeId
  if (nav.uncategorized) v.uncategorized = true
  else if (nav.categoryId) { v.categoryId = nav.categoryId; v.subtree = nav.subtree ?? true }
  if (filters.focus) v.focus = filters.focus
  if (filters.status.length) v.status = filters.status
  if (filters.priority.length) v.priority = filters.priority
  if (filters.tags.length) v.tags = filters.tags
  if (filters.ownerId) v.owner_id = filters.ownerId
  if (filters.q.trim()) v.q = filters.q.trim()
  return v
}

const FOCUS_KEYS: FocusKind[] = ['inbox', 'today', 'week', 'overdue', 'stalled', 'trash']

/**
 * 解析存库的视图 JSON。同时兼容旧形状 NavSelection（kind: 'focus' | 'tag' | 'type'），
 * 因为已有的快捷入口就是那么存的，不能因为改了导航模型就让它们失效。
 */
export function parseView(json: string): ViewDescriptor | null {
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>

  if (typeof o.kind === 'string') { // 旧形状，翻译过来
    if (o.kind === 'focus' && FOCUS_KEYS.includes(o.focus as FocusKind)) return { focus: o.focus as FocusKind }
    if (o.kind === 'tag' && typeof o.tag === 'string') return { tags: [o.tag] }
    if (o.kind === 'type') {
      const v: ViewDescriptor = {}
      if (typeof o.typeId === 'string') v.typeId = o.typeId
      if (typeof o.categoryId === 'string') { v.categoryId = o.categoryId; v.subtree = o.subtree !== false }
      return v
    }
    return null
  }

  const v: ViewDescriptor = {}
  if (typeof o.typeId === 'string') v.typeId = o.typeId
  if (o.uncategorized === true) v.uncategorized = true
  else if (typeof o.categoryId === 'string') { v.categoryId = o.categoryId; v.subtree = o.subtree !== false }
  if (typeof o.focus === 'string' && FOCUS_KEYS.includes(o.focus as FocusKind)) v.focus = o.focus as FocusKind
  const arr = (x: unknown) => (Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : undefined)
  v.status = arr(o.status); v.priority = arr(o.priority); v.tags = arr(o.tags)
  if (typeof o.owner_id === 'string') v.owner_id = o.owner_id
  if (typeof o.q === 'string') v.q = o.q
  return Object.keys(v).some((k) => v[k as keyof ViewDescriptor] !== undefined) ? v : null
}

const Ctx = createContext<WorkspaceValue | null>(null)

export function useWorkspace(): WorkspaceValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useWorkspace must be used inside <WorkspaceProvider>')
  return v
}

// 侧栏（作用域）+ 工具条（条件）合成一次查询。两者正交：聚焦筛选在任何类型/分类作用域下都成立。
function navToQuery(nav: NavSelection, filters: Filters, sort: string): ObjectQuery {
  const q: ObjectQuery = { sort, limit: 200 }

  // 作用域：来自侧栏
  if (nav.typeId) q.type = [nav.typeId]
  if (nav.uncategorized) q.uncategorized = true
  else if (nav.categoryId) {
    q.category = nav.categoryId
    q.subtree = nav.subtree ?? true
  }

  // 条件：来自内容页工具条
  if (filters.status.length) q.status = filters.status
  if (filters.priority.length) q.priority = filters.priority
  if (filters.tags.length) q.tag = filters.tags
  if (filters.q.trim()) q.q = filters.q.trim()
  if (filters.ownerId) q.owner_id = filters.ownerId

  switch (filters.focus) {
    case 'inbox': q.inbox = true; break
    case 'overdue': q.overdue = true; break
    // 用窗口而不是上界：只给上界的话「今日」会把所有逾期的也扫进来，
    // 和侧栏/工具条徽标用的 Counts.Today 口径对不上，徽标就成了谎报。
    // 三个视图都要 not_terminal：Counts 那边排除终态，列表不排除就又对不上。
    case 'today': q.due_after = startOfDay(0); q.due_before = endOfDay(0); q.not_terminal = true; break
    case 'week': q.due_after = startOfDay(0); q.due_before = endOfDay(7); q.not_terminal = true; break
    // 停滞原本只设了排序、没有过滤，点下去出全部对象而徽标只显示停滞数。
    case 'stalled': q.stalled = true; q.sort = 'updated_at'; break
    case 'trash': q.deleted = true; break
  }
  return q
}

/** n 天后当地时间的 00:00:00，RFC3339 */
function startOfDay(daysFromNow: number): string {
  const d = new Date()
  d.setDate(d.getDate() + daysFromNow)
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

/** n 天后当地时间的 23:59:59，RFC3339 */
function endOfDay(daysFromNow: number): string {
  const d = new Date()
  d.setDate(d.getDate() + daysFromNow)
  d.setHours(23, 59, 59, 0)
  return d.toISOString()
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [types, setTypes] = useState<ObjectType[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [counts, setCounts] = useState<Counts | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [categories, setCategories] = useState<Category[]>([])

  const [nav, setNavState] = // 默认落在跨类型视图：一进来看到的是「最近在动什么」，而不是某一个类型的池子
  useState<NavSelection>({ kind: 'type' })
  const [filters, setFiltersState] = useState<Filters>(emptyFilters)
  const [sort, setSort] = useState('-updated_at')
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [groupBy, setGroupBy] = useState<GroupBy>('category')

  const [objects, setObjects] = useState<WorkObject[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(true)
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('detail')

  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false)
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)

  const seq = useRef(0)

  const typeById = useMemo(
    () => Object.fromEntries(types.map((t) => [t.id, t])) as Record<string, ObjectType>,
    [types],
  )
  const activeType = nav.typeId ? (typeById[nav.typeId] ?? null) : null

  // 徽标按当前作用域取：在「需求池」下点「今日」，徽标就该是需求池里今天到期的数量，
  // 否则徽标说 2、点进去 0 条，用户会以为筛选坏了。
  const reloadCounts = useCallback(async () => {
    try { setCounts(await api.counts(nav.typeId)) } catch { /* 徽标失败不阻塞主流程 */ }
  }, [nav.typeId])

  const reloadCategories = useCallback(async () => {
    if (nav.kind !== 'type' || !nav.typeId) { setCategories([]); return }
    try { setCategories(await api.categories(nav.typeId, { tree: true, counts: true })) }
    catch { setCategories([]) }
  }, [nav.kind, nav.typeId])

  const reloadObjects = useCallback(async () => {
    const my = ++seq.current
    if (nav.kind === 'page') {
      // 独立页面不拉对象列表，但**保留** objects——selected 是从 objects 派生的，
      // 清空会让 selectedId 虽在却取不到对象，快捷入口的 {{title}} 变量就失效了。
      setLoading(false); setError(null)
      return
    }
    setLoading(true)
    try {
      const { items, total } = await api.objects(navToQuery(nav, filters, sort))
      if (my !== seq.current) return // 丢弃过期响应
      setObjects(items); setTotal(total); setError(null)
    } catch (e) {
      if (my !== seq.current) return
      setObjects([]); setTotal(0)
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [nav, filters, sort])

  const reloadAll = useCallback(async () => {
    try {
      const [t, tg, st] = await Promise.all([api.objectTypes(), api.tags(), api.stats()])
      setTypes(t); setTags(tg); setStats(st)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
    await Promise.all([reloadCounts(), reloadCategories(), reloadObjects()])
  }, [reloadCounts, reloadCategories, reloadObjects])

  useEffect(() => { void reloadAll() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void reloadObjects() }, [reloadObjects])
  useEffect(() => { void reloadCategories() }, [reloadCategories])
  useEffect(() => { void reloadCounts() }, [reloadCounts])

  const setNav = useCallback((n: NavSelection) => {
    setNavState(n)
    // 切换列表类导航时清空选中；进独立页面时保留，
    // 这样快捷入口的 {{title}} 一类变量在页面里仍有上下文可用。
    // （selected 是从 objects 派生的，回到列表后若该对象不在结果里会自然变 null）
    if (n.kind !== 'page') setSelectedId(null)
  }, [])

  const applyView = useCallback((v: ViewDescriptor) => {
    setNavState({
      kind: 'type',
      typeId: v.typeId,
      categoryId: v.categoryId,
      subtree: v.subtree,
      uncategorized: v.uncategorized,
    })
    setFiltersState({
      focus: v.focus ?? null,
      status: v.status ?? [],
      priority: v.priority ?? [],
      tags: v.tags ?? [],
      ownerId: v.owner_id ?? '',
      q: v.q ?? '',
    })
    setSelectedId(null)
  }, [])

  const setFilters = useCallback((f: Partial<Filters>) => {
    setFiltersState((prev) => ({ ...prev, ...f }))
  }, [])
  const resetFilters = useCallback(() => setFiltersState(emptyFilters), [])

  const afterWrite = useCallback(async () => {
    await Promise.all([reloadObjects(), reloadCounts(), reloadCategories()])
  }, [reloadObjects, reloadCounts, reloadCategories])

  const createObject = useCallback(async (input: CreateObjectInput) => {
    const o = await api.createObject(input)
    await afterWrite()
    setSelectedId(o.id); setDrawerOpen(true); setDrawerTab('detail')
    return o
  }, [afterWrite])

  // 乐观更新必须配回滚。没有回滚的话，请求失败时界面停在乐观值上、库里没改，
  // 而这个分歧不会有任何提示——用户以为改成功了，下次刷新才发现没有。
  // 内联编辑、看板拖拽、批量操作全都走这条路径，一处漏掉就是三处静默失效。
  const updateObject = useCallback(async (id: string, patch: ObjectPatch) => {
    // 先留底。注意存的是整个对象而不是 patch 的反值：
    // 服务端可能顺带改了别的字段（改成终态会带上 completed_at），
    // 只回滚 patch 里那几个键会把那些顺带的改动留在界面上。
    let before: WorkObject | undefined
    setObjects((prev) => {
      before = prev.find((o) => o.id === id)
      return prev.map((o) => (o.id === id ? { ...o, ...patch } as WorkObject : o))
    })
    try {
      const o = await api.updateObject(id, patch)
      setObjects((prev) => prev.map((x) => (x.id === id ? o : x)))
      void reloadCounts()
      return o
    } catch (e) {
      if (before) {
        const snapshot = before
        setObjects((prev) => prev.map((x) => (x.id === id ? snapshot : x)))
      }
      throw e // 调用方照旧能 catch 到去弹提示
    }
  }, [reloadCounts])

  const deleteObject = useCallback(async (id: string, hard = false) => {
    await api.deleteObject(id, hard)
    if (selectedId === id) setSelectedId(null)
    await afterWrite()
  }, [afterWrite, selectedId])

  const restoreObject = useCallback(async (id: string) => {
    await api.restoreObject(id)
    await afterWrite()
  }, [afterWrite])

  const selected = useMemo(
    () => objects.find((o) => o.id === selectedId) ?? null,
    [objects, selectedId],
  )

  const select = useCallback((id: string | null) => {
    setSelectedId(id)
    if (id) setDrawerOpen(true)
  }, [])

  const value: WorkspaceValue = {
    types, typeById, tags, counts, stats,
    nav, setNav, categories, activeType,
    objects, total, loading, error,
    filters, setFilters, resetFilters,
    sort, setSort, viewMode, setViewMode, groupBy, setGroupBy,
    selectedId, selected, select,
    drawerOpen, setDrawerOpen, drawerTab, setDrawerTab,
    quickCaptureOpen, setQuickCaptureOpen,
    categoryManagerOpen, setCategoryManagerOpen,
    commandPaletteOpen, setCommandPaletteOpen,
    createObject, updateObject, deleteObject, restoreObject,
    reloadAll, reloadObjects, reloadCategories, reloadCounts,
    applyView, currentView: () => toView(nav, filters),
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
