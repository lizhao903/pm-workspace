// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 中栏工作对象视图：工具栏 + 按 viewMode 分发的主体。数据全部来自 useWorkspace()。
// 侧栏只负责「作用域」（哪类工作对象 / 哪个分类），所有筛选条件都收在这里的工具条上。
import { useCallback, useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react'
import { useWorkspace, type FocusKind } from '../hooks/workspace'
import { api } from '../lib/api'
import type { ObjectPatch, ObjectType, Status, ViewMode, WorkObject } from '../lib/types'
import {
  Button, CategoryChip, CategoryPicker, ColorDot, ConfirmDialog, Popover, PriorityTag,
  RelativeTime, TagChip, flattenCategories, formatDate, formatDateTime, formatDue, isOverdue,
  useCategoryTree,
} from '../components/ui'
import {
  OwnerCell, OwnerMenu, PriorityCell, StatusCell, usePriorityOptions,
} from '../components/InlineEditors'
import { useStakeholders } from '../components/StakeholderPicker'
import '../views.css'

const VIEW_MODES: Array<{ key: ViewMode; label: string }> = [
  { key: 'list', label: '列表' },
  { key: 'board', label: '看板' },
  { key: 'table', label: '表格' },
  { key: 'calendar', label: '日历' },
  { key: 'timeline', label: '时间线' },
]

// 聚焦项：互斥单选，等价于一组预置的 WHERE 条件。回收站不在这里，
// 它看的是已删除数据，性质不同，单独放在分隔线右侧。
// 今日 / 逾期是两个不重叠的窗口：今日=同日窗口，逾期=已过期未终态。
type CountKey = 'inbox' | 'today' | 'week' | 'overdue' | 'stalled'

const FOCUS_ITEMS: Array<{ key: FocusKind; label: string; countKey: CountKey; title: string }> = [
  { key: 'inbox', label: '收件箱', countKey: 'inbox', title: '未分类且未开始的新条目' },
  { key: 'today', label: '今日', countKey: 'today', title: '今天到期' },
  { key: 'week', label: '本周', countKey: 'week', title: '今天起 7 天内到期' },
  { key: 'overdue', label: '逾期', countKey: 'overdue', title: '已过期且未完成' },
  { key: 'stalled', label: '停滞', countKey: 'stalled', title: '长时间没有更新' },
]

// 单类型作用域下的分组维度
type GroupKey = 'none' | 'category' | 'status' | 'priority'
// 全部类型作用域下的分组维度：分类树是按类型挂的，跨类型时按分类分组会把
// 不同类型的同名分类混在一起，所以这里用「按类型」取代「按分类」。
type CrossGroupKey = 'none' | 'type' | 'status' | 'priority'

const GROUP_OPTIONS: Array<{ key: GroupKey; label: string }> = [
  { key: 'none', label: '不分组' },
  { key: 'category', label: '按分类' },
  { key: 'status', label: '按状态' },
  { key: 'priority', label: '按优先级' },
]

const CROSS_GROUP_OPTIONS: Array<{ key: CrossGroupKey; label: string }> = [
  { key: 'none', label: '不分组' },
  { key: 'type', label: '按类型' },
  { key: 'status', label: '按状态' },
  { key: 'priority', label: '按优先级' },
]

const SORT_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'updated_at', label: '更新时间' },
  { key: 'created_at', label: '创建时间' },
  { key: 'due_at', label: '到期' },
  { key: 'priority', label: '优先级' },
  { key: 'title', label: '标题' },
]

const NO_CATEGORY = '__uncategorized__'
const NO_VALUE = '__none__'

interface Group {
  key: string
  label: string
  color?: string
  items: WorkObject[]
}

/* ------------------------------------------------------------ 行内联编辑 */

// 可就地改的三列。和批量操作是两件事：那个是「选中多行，工具条上改」，
// 这个是「点某一行的某个单元格，当场改」，互不替代。
type EditField = 'status' | 'priority' | 'owner'

const FIELD_LABEL: Record<EditField, string> = { status: '状态', priority: '优先级', owner: '负责人' }

interface EditFail {
  ref: string
  field: EditField
  message: string
}

/* -------------------------------------------------------------- 批量执行 */

// 不加后端批量接口，前端逐条调。对象之间互相独立、不需要事务，
// 每条各写一条 revision 本来就是正确语义，循环与批量接口在语义上等价。
// 并发限死在 5：后端写池是 MaxOpenConns(1)，一次性打出几百个请求只会把单写连接堵死。
const BATCH_CONCURRENCY = 5

interface BatchFailure {
  id: string
  ref: string
  title: string
  message: string
}

interface BatchOutcome {
  label: string
  ok: number
  failures: BatchFailure[]
}

/** 并发受限的逐条执行器：不因单条失败中断，失败逐条收集后一并呈现。 */
async function runBatch(
  items: WorkObject[],
  fn: (o: WorkObject) => Promise<unknown>,
  onProgress: (done: number) => void,
): Promise<{ ok: number; failures: BatchFailure[] }> {
  const failures: BatchFailure[] = []
  let ok = 0
  let done = 0
  let cursor = 0

  const worker = async () => {
    while (cursor < items.length) {
      const o = items[cursor]
      cursor += 1
      try {
        await fn(o)
        ok += 1
      } catch (e) {
        failures.push({
          id: o.id,
          ref: o.ref,
          title: o.title,
          message: e instanceof Error ? e.message : String(e),
        })
      }
      done += 1
      onProgress(done)
    }
  }

  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, items.length) }, worker))
  return { ok, failures }
}

export default function ObjectListView() {
  const ws = useWorkspace()
  const {
    objects, loading, error, total, counts, filters, setFilters, resetFilters,
    sort, setSort, viewMode, setViewMode, groupBy, setGroupBy,
    activeType, typeById, categories, nav, selectedId, select,
    updateObject, deleteObject, restoreObject, setQuickCaptureOpen,
    reloadObjects, reloadCounts,
  } = ws

  // 回收站是聚焦条件之一，不再是独立的侧栏项
  const inTrash = filters.focus === 'trash'
  // 「全部类型」作用域：列表会混多个类型的对象，行内要给出类型标识
  const allTypes = !nav.typeId

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [checked, setChecked] = useState<Set<string>>(() => new Set())
  const [purgeTarget, setPurgeTarget] = useState<WorkObject | null>(null)
  const [purging, setPurging] = useState(false)
  const [purgeError, setPurgeError] = useState<string | null>(null)
  // 跨类型作用域的分组维度单独存：store 的 groupBy 只描述单类型场景，
  // 在两个作用域间来回切时各自记住自己的选择，不互相覆盖。
  const [crossGroup, setCrossGroup] = useState<CrossGroupKey>('type')
  // 批量执行进度与结果
  const [batchBusy, setBatchBusy] = useState<{ label: string; done: number; total: number } | null>(null)
  const [batchOutcome, setBatchOutcome] = useState<BatchOutcome | null>(null)
  const [showFailures, setShowFailures] = useState(false)
  const [bulkConfirm, setBulkConfirm] = useState<'delete' | 'purge' | null>(null)
  const [bulkCategory, setBulkCategory] = useState<string | null>(null)
  // 行内联编辑：正在提交的行 → 正在改哪一列。用来压暗那个单元格并挡住连点，
  // 否则同一行连点两下会打出两个并发 PATCH，谁后到谁赢。
  const [editing, setEditing] = useState<Record<string, EditField>>({})
  // 负责人是引用：patch 里只有 owner_id，名字得等服务端回。
  // 乐观显示先用本地这一份顶上，请求落地（或回滚）后清掉，换回对象自己的 owner_name。
  const [ownerPreview, setOwnerPreview] = useState<Record<string, string>>({})
  const [editFail, setEditFail] = useState<EditFail | null>(null)

  const effGroup: GroupKey | CrossGroupKey = allTypes ? crossGroup : groupBy
  const groupOptions = allTypes ? CROSS_GROUP_OPTIONS : GROUP_OPTIONS
  const groupLabel = groupOptions.find((g) => g.key === effGroup)?.label ?? '不分组'

  // 「全部类型」作用域下没有单一类型，状态筛选项取所有类型状态按 key 去重后的并集。
  // 选择聚合而不是禁用：跨类型视图（收件箱 / 逾期 …）本身就是常用工作面，
  // 在那儿把状态筛选做成死控件等于砍掉一半筛选能力；后端 status 是 IN 列表，传并集即可。
  const statusOptions = useMemo<Status[]>(() => {
    if (activeType) return activeType.statuses
    const seen = new Map<string, Status>()
    for (const t of ws.types) for (const s of t.statuses) if (!seen.has(s.key)) seen.set(s.key, s)
    return [...seen.values()]
  }, [activeType, ws.types])

  // 标签按使用量降序：常用的排前面，长列表里好找
  const tagOptions = useMemo(() => [...ws.tags].sort((a, b) => b.count - a.count), [ws.tags])

  // 颜色与完整路径由后端 denormalize 在对象上，不用回分类树查，
  // 所以聚焦 / 跨类型 / 快捷访问这些 categories 为空的视图也能拿到真色。
  // 后端未带该字段时（旧数据）color 为 undefined，CategoryChip 自动退中性色。
  const categoryChip = useCallback((o: WorkObject) => {
    if (!o.category_name) return null
    return <CategoryChip name={o.category_name} color={o.category_color} path={o.category_path} />
  }, [])

  // 跨类型列表里 REQ- / TSK- 前缀虽然隐含了类型，但要求用户去记前缀不合理，给个轻量 chip。
  const typeChip = useCallback((o: WorkObject) => {
    if (!allTypes) return null
    const t = typeById[o.type_id]
    if (!t) return null
    return (
      <span
        className="v-type-chip"
        title={`类型：${t.name}`}
        style={t.color ? {
          background: `color-mix(in srgb, ${t.color} 14%, transparent)`,
          borderColor: `color-mix(in srgb, ${t.color} 40%, transparent)`,
        } : undefined}
      >
        <ColorDot color={t.color || ''} size={6} />{t.name}
      </span>
    )
  }, [allTypes, typeById])

  // 优先级选项来自字典，状态来自各类型自己的状态集——两者都不写死在这个文件里，
  // 用户去设置里加一档，列表这边当场就有。
  const priorityOptions = usePriorityOptions()
  const roster = useStakeholders()

  // filters.ownerId 存的是干系人 id（0010 起负责人是引用不是文本），筛选条上要显示成名字。
  // 名册只有在岗的人，所以先查名册、再查当前结果里的 owner_name 兜住已归档的。
  const ownerFilterName = useMemo(() => {
    if (!filters.ownerId) return ''
    return roster.list.find((s) => s.id === filters.ownerId)?.name
      ?? objects.find((o) => o.owner_id === filters.ownerId)?.owner_name
      ?? '已归档的干系人'
  }, [filters.ownerId, roster.list, objects])

  // 条件类筛选（不含聚焦）：空态文案要靠它区分「回收站本来就空」和「回收站里筛没了」
  const hasConditions =
    filters.status.length > 0 || filters.priority.length > 0 || filters.tags.length > 0
    || filters.ownerId !== '' || filters.q.trim() !== ''
  const hasFilters = hasConditions || filters.focus !== null

  /* ------------------------------------------------------------ 批量选择 */

  const picked = useMemo(() => objects.filter((o) => checked.has(o.id)), [objects, checked])
  // 状态集与分类树都是按类型隔离的，跨类型时这两个动作无法给出合法选项 → 禁用。
  const bulkType = useMemo<ObjectType | null>(() => {
    const ids = new Set(picked.map((o) => o.type_id))
    return ids.size === 1 ? (typeById[[...ids][0]] ?? null) : null
  }, [picked, typeById])
  const bulkCategories = useCategoryTree(bulkType?.id ?? null)
  // 选中项身上出现过的标签，供「移除」用
  const bulkTagsPresent = useMemo(() => {
    const seen = new Set<string>()
    for (const o of picked) for (const t of o.tags) seen.add(t)
    return [...seen].sort()
  }, [picked])
  // limit 是 200，结果更多时表头「全选」只能覆盖已加载的部分，要在计数旁说清楚
  const partialLoad = total > objects.length

  // 切换作用域或筛选条件后，原选中项多半已不在结果里，继续持有会造成误操作。
  const scopeKey = JSON.stringify([
    nav.typeId, nav.categoryId, nav.subtree, nav.uncategorized,
    filters.focus, filters.status, filters.priority, filters.tags, filters.ownerId, filters.q,
  ])
  useEffect(() => {
    setChecked(new Set())
    setBatchOutcome(null)
    setShowFailures(false)
  }, [scopeKey])

  // 成功提示自动消隐；有失败时保留，等用户自己关掉
  useEffect(() => {
    if (!batchOutcome || batchOutcome.failures.length > 0) return
    const t = window.setTimeout(() => setBatchOutcome(null), 4000)
    return () => window.clearTimeout(t)
  }, [batchOutcome])

  // 选中态下 Esc 清除选择。弹层/弹窗自己在捕获阶段吃掉了 Esc，这里只兜最外层。
  useEffect(() => {
    if (checked.size === 0 || bulkConfirm !== null || purgeTarget !== null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChecked(new Set())
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [checked.size, bulkConfirm, purgeTarget])

  /**
   * 跑一次批量动作。全部结束后只刷新一次列表与徽标（不要每条都刷）。
   * 无事务：失败不回滚已成功的那些，如实呈现。失败项保留选中，方便修正后重试。
   */
  const runAction = useCallback(async (label: string, fn: (o: WorkObject) => Promise<unknown>) => {
    const items = objects.filter((o) => checked.has(o.id))
    if (items.length === 0) return
    setBatchOutcome(null)
    setShowFailures(false)
    setBatchBusy({ label, done: 0, total: items.length })
    const res = await runBatch(items, fn, (done) => {
      setBatchBusy((b) => (b ? { ...b, done } : b))
    })
    setBatchBusy(null)
    await Promise.all([reloadObjects(), reloadCounts()])
    setChecked(res.failures.length === 0 ? new Set() : new Set(res.failures.map((f) => f.id)))
    setBatchOutcome({ label, ok: res.ok, failures: res.failures })
  }, [objects, checked, reloadObjects, reloadCounts])

  // 标签是**增量**改：读每条现有 tags 做并集 / 差集再写回。
  // 直接覆盖会把各自原有的标签抹掉。已经满足的条目跳过，不产生无意义的 revision。
  const addTag = useCallback((name: string) => runAction(`加标签 #${name}`, async (o) => {
    if (o.tags.includes(name)) return
    await api.updateObject(o.id, { tags: [...o.tags, name] })
  }), [runAction])

  const removeTag = useCallback((name: string) => runAction(`去标签 #${name}`, async (o) => {
    if (!o.tags.includes(name)) return
    await api.updateObject(o.id, { tags: o.tags.filter((t) => t !== name) })
  }), [runAction])

  const busyText = batchBusy ? `处理中 ${batchBusy.done}/${batchBusy.total}` : null

  const sortDesc = sort.startsWith('-')
  const sortField = sortDesc ? sort.slice(1) : sort
  const sortLabel = SORT_FIELDS.find((f) => f.key === sortField)?.label ?? sortField

  const toggleIn = useCallback((list: string[], v: string) =>
    (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]), [])

  // 聚焦是互斥单选：点已选中的项取消回「全部」
  const pickFocus = useCallback((k: FocusKind) => {
    setFilters({ focus: filters.focus === k ? null : k })
  }, [filters.focus, setFilters])

  const pickSort = useCallback((key: string) => {
    if (key === sortField) setSort(sortDesc ? key : `-${key}`) // 同一项再点切换升降序
    else setSort(key === 'title' ? key : `-${key}`)
  }, [setSort, sortField, sortDesc])

  // 分组：组顺序按类型 / 分类树 / 状态定义 / 优先级的自然次序，空值组垫底。
  const groups = useMemo<Group[]>(() => {
    if (effGroup === 'none') return [{ key: 'all', label: '全部', items: objects }]

    const buckets = new Map<string, WorkObject[]>()
    const push = (k: string, o: WorkObject) => {
      const arr = buckets.get(k)
      if (arr) arr.push(o)
      else buckets.set(k, [o])
    }

    if (effGroup === 'type') {
      for (const o of objects) push(o.type_id, o)
      const out: Group[] = []
      for (const t of ws.types) {
        const items = buckets.get(t.id)
        if (items) { out.push({ key: t.id, label: t.name, color: t.color, items }); buckets.delete(t.id) }
      }
      for (const [k, items] of buckets) out.push({ key: k, label: k, items })
      return out
    }

    if (effGroup === 'category') {
      for (const o of objects) push(o.category_id ?? NO_CATEGORY, o)
      const ordered = flattenCategories(categories)
      const out: Group[] = []
      for (const { category } of ordered) {
        const items = buckets.get(category.id)
        if (items) { out.push({ key: category.id, label: category.name, color: category.color, items }); buckets.delete(category.id) }
      }
      // 当前作用域类型之外的分类用对象自带的 category_name 兜底
      for (const [k, items] of buckets) {
        if (k === NO_CATEGORY) continue
        out.push({ key: k, label: items[0].category_name ?? '其他分类', items })
      }
      const none = buckets.get(NO_CATEGORY)
      if (none) out.push({ key: NO_CATEGORY, label: '未分类', items: none })
      return out
    }

    if (effGroup === 'status') {
      for (const o of objects) push(o.status || NO_VALUE, o)
      const out: Group[] = []
      for (const s of statusOptions) {
        const items = buckets.get(s.key)
        if (items) { out.push({ key: s.key, label: s.label, color: s.color, items }); buckets.delete(s.key) }
      }
      for (const [k, items] of buckets) out.push({ key: k, label: k === NO_VALUE ? '无状态' : k, items })
      return out
    }

    // 组的先后取字典里的 sort_order：用户在设置里把 P0 排到最后，这里就跟着变
    for (const o of objects) push(o.priority || NO_VALUE, o)
    const out: Group[] = []
    for (const p of priorityOptions) {
      const items = buckets.get(p.key)
      if (items) {
        out.push({ key: p.key, label: p.label ? `${p.key} ${p.label}` : p.key, color: p.color, items })
        buckets.delete(p.key)
      }
    }
    for (const [k, items] of buckets) out.push({ key: k, label: k === NO_VALUE ? '未设置优先级' : k, items })
    return out
  }, [effGroup, objects, categories, statusOptions, priorityOptions, ws.types])

  const toggleGroup = useCallback((k: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }, [])

  const toggleCheck = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const confirmPurge = useCallback(async () => {
    if (!purgeTarget) return
    setPurging(true); setPurgeError(null)
    try {
      await deleteObject(purgeTarget.id, true)
      setPurgeTarget(null)
    } catch (e) {
      setPurgeError(e instanceof Error ? e.message : String(e))
    } finally {
      setPurging(false)
    }
  }, [purgeTarget, deleteObject])

  /* ---------------------------------------------------------- 行内联编辑 */

  /**
   * 就地改一行的一个字段。
   * 乐观更新与失败回滚都在 ws.updateObject 里，这里只管三件事：
   * 选回原值不发请求、同一行同时只放一个请求出去、失败了如实说是哪条为什么。
   * **刻意不调 reloadObjects**：为改一个状态把整页重拉，会丢滚动位置和已勾选的行。
   * 服务端返回的整条对象会被写回 store，所以改成终态时带回来的 completed_at 会照实显示。
   */
  const commitInline = useCallback(async (
    o: WorkObject, field: EditField, patch: ObjectPatch, preview?: string,
  ) => {
    const same = field === 'status'
      ? patch.status === o.status
      : field === 'priority'
        ? patch.priority === o.priority
        : (patch.owner_id ?? '') === (o.owner_id ?? '')
    if (same) return // 选回原值：不发请求，也就不会写一条什么都没变的 revision

    setEditFail(null)
    setEditing((prev) => ({ ...prev, [o.id]: field }))
    if (preview !== undefined) setOwnerPreview((prev) => ({ ...prev, [o.id]: preview }))
    try {
      await updateObject(o.id, patch)
    } catch (e) {
      // 界面已经被 updateObject 回滚了，这里只补一句「为什么没改成」
      setEditFail({ ref: o.ref, field, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setEditing((prev) => { const next = { ...prev }; delete next[o.id]; return next })
      setOwnerPreview((prev) => { const next = { ...prev }; delete next[o.id]; return next })
    }
  }, [updateObject])

  // 负责人展示：乐观值 > owner_id 指向的名字 > 0010 之前的自由文本。
  // `in` 判断而不是 `||`：乐观值可以是空串（刚点了「未分配」），用 || 会立刻被旧名字顶回去。
  const ownerText = useCallback((o: WorkObject) =>
    (o.id in ownerPreview ? ownerPreview[o.id] : (o.owner_name ?? o.owner)) || '',
  [ownerPreview])

  // 三个单元格列表视图与表格视图共用，交互形态必须一致：
  // 同一列在两个视图里一个能点改、一个不能，用户只会以为坏了。
  const statusCell = useCallback((o: WorkObject) => (
    <StatusCell
      value={o.status}
      statuses={typeById[o.type_id]?.statuses ?? []}
      busy={editing[o.id] === 'status'}
      readOnly={inTrash}
      completedAt={o.completed_at}
      onPick={(st) => void commitInline(o, 'status', { status: st.key })}
    />
  ), [typeById, editing, inTrash, commitInline])

  const priorityCell = useCallback((o: WorkObject) => (
    <PriorityCell
      value={o.priority}
      options={priorityOptions}
      busy={editing[o.id] === 'priority'}
      readOnly={inTrash}
      onPick={(key) => void commitInline(o, 'priority', { priority: key })}
    />
  ), [priorityOptions, editing, inTrash, commitInline])

  const ownerCell = useCallback((o: WorkObject) => (
    <OwnerCell
      value={o.owner_id}
      display={ownerText(o)}
      busy={editing[o.id] === 'owner'}
      readOnly={inTrash}
      onPick={(id) => {
        // 空串 = 清空负责人（契约如此），乐观显示同步给空
        const name = id ? (roster.list.find((s) => s.id === id)?.name ?? '') : ''
        void commitInline(o, 'owner', { owner_id: id }, name)
      }}
    />
  ), [ownerText, editing, inTrash, commitInline, roster.list])

  /* ------------------------------------------------------------ 行内动作 */

  const rowActions = (o: WorkObject) => {
    if (inTrash) {
      return (
        <div className="row-actions v-row-actions">
          <Button small onClick={() => void restoreObject(o.id)}>恢复</Button>
          <Button small variant="danger" onClick={() => { setPurgeError(null); setPurgeTarget(o) }}>彻底删除</Button>
        </div>
      )
    }
    // 这里原来还有「状态」「优先级」两个弹层，已由单元格内联编辑取代：
    // 悬停动作条是绝对定位、盖在右侧几列上的，留着它就会正好挡住要点的那两个单元格。
    return (
      <div className="row-actions v-row-actions">
        <Button small variant="danger" title="移到回收站" onClick={() => void deleteObject(o.id)}>删除</Button>
      </div>
    )
  }

  /* -------------------------------------------------------------- 列表行 */

  const renderRow = (o: WorkObject) => {
    const overdue = isOverdue(o.due_at) && !o.completed_at
    return (
      <div
        key={o.id}
        role="row"
        tabIndex={0}
        className={`obj-row v-obj-row ${o.id === selectedId ? 'obj-row-selected' : ''}`.trim()}
        onClick={() => select(o.id)}
        onKeyDown={(e) => {
          // 键盘优先：行可聚焦，回车 / 空格选中
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            select(o.id)
          }
        }}
      >
        <input
          type="checkbox"
          className="v-cb"
          checked={checked.has(o.id)}
          aria-label={`选择 ${o.title}`}
          onClick={(e) => e.stopPropagation()}
          onChange={() => toggleCheck(o.id)}
        />
        <div className="v-cell-title">
          <div className="v-title-line">
            <span className="mono faint v-ref">{o.ref}</span>
            <span className="v-title truncate">{o.title}</span>
          </div>
          <div className="v-title-meta">
            {typeChip(o)}
            {categoryChip(o)}
            {o.tags.map((t) => (
              <span className="tag v-tag-chip" key={t} title={`标签：${t}`}>
                <span className="faint" aria-hidden="true">#</span>{t}
              </span>
            ))}
          </div>
        </div>
        <div>{statusCell(o)}</div>
        <div>{priorityCell(o)}</div>
        <div className="muted v-cell-owner">
          {ownerCell(o)}
          {/* 已完成的条目显示完成时间而不是到期：事情做完之后，「什么时候做完的」
              比「本来什么时候到期」更有信息量，到期挪到 title 里仍查得到 */}
          {o.completed_at ? (
            <span className="faint" title={`到期 ${formatDue(o.due_at)}`}>完成 {formatDate(o.completed_at)}</span>
          ) : (
            <span className={overdue ? 'v-overdue' : 'faint'}>{formatDue(o.due_at)}</span>
          )}
        </div>
        <div className="faint mono v-cell-links">{o.link_count > 0 ? `${o.link_count} 关联` : '—'}</div>
        {rowActions(o)}
      </div>
    )
  }

  /* -------------------------------------------------------------- 空态 */

  // 三种空：回收站本来就空 / 筛选后没结果 / 该作用域真的没数据。
  // 回收站为空时不给「去新建」，新建的东西不会掉进回收站，按钮语义不通。
  const emptyState = () => {
    if (inTrash) {
      return hasConditions ? (
        <div className="empty-state">
          <p>回收站里没有符合当前筛选的条目。</p>
          <Button variant="primary" onClick={resetFilters}>清空筛选</Button>
        </div>
      ) : (
        <div className="empty-state"><p>回收站是空的。</p></div>
      )
    }
    if (hasFilters) {
      return (
        <div className="empty-state">
          <p>当前筛选下没有结果。</p>
          <Button variant="primary" onClick={resetFilters}>清空筛选</Button>
        </div>
      )
    }
    return (
      <div className="empty-state">
        <p>这里还没有数据。</p>
        <Button variant="primary" onClick={() => setQuickCaptureOpen(true)}>新建一条</Button>
      </div>
    )
  }

  const listBody = () => {
    if (loading && objects.length === 0) {
      return (
        <div className="v-list-body">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div className="obj-row v-obj-row" key={i}>
              <span />
              <span className="skeleton v-sk v-sk-title" />
              <span className="skeleton v-sk" />
              <span className="skeleton v-sk" />
              <span className="skeleton v-sk" />
              <span className="skeleton v-sk" />
            </div>
          ))}
        </div>
      )
    }
    if (objects.length === 0) return emptyState()
    return (
      <div className="v-list-body" role="grid">
        <div className="obj-row obj-row-head v-obj-row v-head-row" role="row">
          <input
            type="checkbox"
            className="v-cb"
            // 只能全选已加载的部分：limit 是 200，结果更多时选不到没拉回来的那些
            aria-label={partialLoad ? `全选当前已加载的 ${objects.length} 条` : '全选'}
            title={partialLoad ? `结果共 ${total} 条，这里只能全选已加载的 ${objects.length} 条` : undefined}
            checked={objects.length > 0 && checked.size === objects.length}
            onChange={(e) => setChecked(e.target.checked ? new Set(objects.map((o) => o.id)) : new Set())}
          />
          <span>标题</span>
          <span>状态</span>
          <span>优先级</span>
          <span>负责人 / 到期</span>
          <span>关联</span>
        </div>
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key)
          return (
            <div key={g.key}>
              {effGroup === 'none' ? null : (
                <button type="button" className="group-bar v-group-bar" onClick={() => toggleGroup(g.key)}>
                  <span className={`v-caret ${isCollapsed ? 'v-caret-closed' : ''}`.trim()} aria-hidden="true" />
                  {g.color ? <ColorDot color={g.color} /> : null}
                  <span>{g.label}</span>
                  <span className="badge">{g.items.length}</span>
                </button>
              )}
              {isCollapsed ? null : g.items.map(renderRow)}
            </div>
          )
        })}
      </div>
    )
  }

  /* ---------------------------------------------------------------- 看板 */

  const boardBody = () => {
    if (!activeType) {
      // 跨类型时没有统一的状态集，看板列无从定义
      return <div className="empty-state"><p>看板视图需要先在左栏选中一个工作对象类型。</p></div>
    }
    return (
      <BoardView
        statuses={activeType.statuses}
        objects={objects}
        selectedId={selectedId}
        categoryChip={categoryChip}
        onSelect={select}
        onMove={(o, status) => void commitInline(o, 'status', { status })}
      />
    )
  }

  /* ---------------------------------------------------------------- 表格 */

  const tableBody = () => {
    if (objects.length === 0) return emptyState()
    return (
      <div className="v-table-wrap">
        <table className="v-table">
          <thead>
            <tr>
              <th>编号</th>
              {allTypes ? <th>类型</th> : null}
              <th>标题</th><th>分类</th><th>状态</th><th>优先级</th>
              <th>负责人</th><th>到期</th><th>创建</th><th>更新</th>
            </tr>
          </thead>
          <tbody>
            {objects.map((o) => (
                <tr
                  key={o.id}
                  className={o.id === selectedId ? 'v-tr-selected' : ''}
                  onClick={() => select(o.id)}
                >
                  <td className="mono faint">{o.ref}</td>
                  {allTypes ? <td>{typeChip(o) ?? <span className="faint">—</span>}</td> : null}
                  <td className="truncate">{o.title}</td>
                  <td>{categoryChip(o) ?? <span className="faint">未分类</span>}</td>
                  <td>{statusCell(o)}</td>
                  <td>{priorityCell(o)}</td>
                  <td>{ownerCell(o)}</td>
                  <td
                    className={isOverdue(o.due_at) && !o.completed_at ? 'v-overdue' : 'muted'}
                    title={o.completed_at ? `完成于 ${formatDateTime(o.completed_at)}` : undefined}
                  >
                    {formatDue(o.due_at)}
                  </td>
                  <td className="faint">{formatDate(o.created_at)}</td>
                  <td className="faint"><RelativeTime value={o.updated_at} /></td>
                </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  const body = () => {
    switch (viewMode) {
      case 'list': return listBody()
      case 'board': return boardBody()
      case 'table': return tableBody()
      case 'calendar': return <div className="empty-state"><p>日历视图将在 M2 支持。</p></div>
      case 'timeline': return <div className="empty-state"><p>时间线视图将在 M2 支持。</p></div>
    }
  }

  return (
    <div className="v-list-view">
      <div className="list-toolbar v-toolbar">
        {/* 第一行：视图形态 + 聚焦（互斥单选） */}
        <div className="v-toolbar-row">
          <div className="seg">
            {VIEW_MODES.map((v) => (
              <button
                key={v.key}
                type="button"
                className={`seg-item ${viewMode === v.key ? 'seg-item-active' : ''}`.trim()}
                onClick={() => setViewMode(v.key)}
              >
                {v.label}
              </button>
            ))}
          </div>

          <div className="v-focus-group" role="group" aria-label="聚焦">
            <button
              type="button"
              className={`chip v-focus-chip ${filters.focus === null ? 'chip-active' : ''}`.trim()}
              aria-pressed={filters.focus === null}
              title="不限聚焦条件"
              onClick={() => setFilters({ focus: null })}
            >
              全部<span className="badge">{total}</span>
            </button>
            {FOCUS_ITEMS.map((f) => {
              // counts 的这五个聚焦计数器已是「当前作用域」口径（/api/counts 带 ?type=，
              // reloadCounts 依赖 nav.typeId），和点下去的列表结果同口径，直接显示即可。
              const n = counts ? counts[f.countKey] : null
              return (
                <button
                  key={f.key}
                  type="button"
                  className={`chip v-focus-chip ${filters.focus === f.key ? 'chip-active' : ''}`.trim()}
                  aria-pressed={filters.focus === f.key}
                  title={f.title}
                  onClick={() => pickFocus(f.key)}
                >
                  {f.label}
                  {n === null ? null : <span className={`badge ${n === 0 ? 'v-badge-zero' : ''}`.trim()}>{n}</span>}
                </button>
              )
            })}
            {/* 回收站看的是已删除数据，和上面几个「还在工作中」的聚焦不同性质，用分隔线隔开 */}
            <span className="v-focus-sep" aria-hidden="true" />
            <button
              type="button"
              className={`chip v-focus-chip ${inTrash ? 'chip-active' : ''}`.trim()}
              aria-pressed={inTrash}
              title="已删除的条目，可恢复或彻底删除"
              onClick={() => pickFocus('trash')}
            >
              回收站
            </button>
          </div>

          <div className="v-toolbar-spacer" />

          <span className="faint mono v-total" title={partialLoad ? `结果共 ${total} 条，当前只加载了前 ${objects.length} 条` : undefined}>
            {total} 项{partialLoad ? `（已加载 ${objects.length}）` : ''}
          </span>
        </div>

        {/* 第二行：有选中项时整行让给批量操作栏，没有时才是筛选条。
            理由见文件末尾注释：三行太高，且两者同时在场是个陷阱——
            动筛选会清空选择，把它和批量动作并排摆着等于邀请用户误操作。 */}
        {checked.size > 0 ? (
          <div className="v-toolbar-row v-bulk-bar">
            <span className="v-bulk-count">
              已选 {checked.size} 项
              {partialLoad ? <span className="faint">（当前已加载 {objects.length} 条内）</span> : null}
            </span>

            {busyText ? (
              <span className="muted v-bulk-busy">{batchBusy?.label} · {busyText}</span>
            ) : inTrash ? (
              <>
                <Button small onClick={() => void runAction('恢复', (o) => api.restoreObject(o.id))}>恢复</Button>
                <Button small variant="danger" onClick={() => setBulkConfirm('purge')}>彻底删除</Button>
              </>
            ) : (
              <>
                <Popover
                  triggerClassName="btn btn-sm"
                  trigger="状态"
                  width={180}
                  disabled={!bulkType}
                  title={bulkType ? `把 ${checked.size} 项改为同一状态` : '选中项跨多个类型，状态集不同'}
                >
                  {(close) => (
                    <div className="v-menu">
                      {(bulkType?.statuses ?? []).map((s) => (
                        <button
                          key={s.key}
                          type="button"
                          className="v-menu-item"
                          onClick={() => { close(); void runAction(`改状态 → ${s.label}`, (o) => api.updateObject(o.id, { status: s.key })) }}
                        >
                          <ColorDot color={s.color} />{s.label}
                        </button>
                      ))}
                    </div>
                  )}
                </Popover>

                <Popover triggerClassName="btn btn-sm" trigger="优先级" width={160}>
                  {(close) => (
                    <div className="v-menu">
                      {priorityOptions.map((p) => (
                        <button
                          key={p.key}
                          type="button"
                          className="v-menu-item"
                          onClick={() => { close(); void runAction(`改优先级 → ${p.key}`, (o) => api.updateObject(o.id, { priority: p.key })) }}
                        >
                          <PriorityTag value={p.key} />
                          {p.label ? <span className="faint truncate">{p.label}</span> : null}
                        </button>
                      ))}
                    </div>
                  )}
                </Popover>

                {/* 和单行内联编辑复用同一个 OwnerMenu：选中的是干系人 id，不是一段文本。
                    自由文本输入框已经去掉——库里那条「示例甲、示例乙、示例丙」就是它的产物。 */}
                <Popover triggerClassName="btn btn-sm" trigger="负责人" width={230}>
                  {(close) => (
                    <OwnerMenu
                      value={null}
                      emptyLabel="清空负责人"
                      onPick={(id) => {
                        close()
                        const name = roster.list.find((s) => s.id === id)?.name ?? id
                        void runAction(
                          id ? `改负责人 → ${name}` : '清空负责人',
                          (o) => api.updateObject(o.id, { owner_id: id }),
                        )
                      }}
                    />
                  )}
                </Popover>

                <Popover
                  triggerClassName="btn btn-sm"
                  trigger="分类"
                  width={260}
                  disabled={!bulkType}
                  title={bulkType ? `把 ${checked.size} 项挂到同一分类` : '选中项跨多个类型，分类树按类型隔离'}
                >
                  {(close) => (
                    <div className="v-pop-pad v-bulk-form">
                      <CategoryPicker
                        categories={bulkCategories}
                        value={bulkCategory}
                        onChange={setBulkCategory}
                        emptyLabel="未分类（移出分类）"
                      />
                      <div className="v-bulk-form-acts">
                        <Button
                          small
                          variant="primary"
                          onClick={() => { close(); void runAction('改分类', (o) => api.updateObject(o.id, { category_id: bulkCategory })) }}
                        >
                          应用到 {checked.size} 项
                        </Button>
                      </div>
                    </div>
                  )}
                </Popover>

                <Popover triggerClassName="btn btn-sm" trigger="标签" width={220}>
                  {(close) => (
                    <div className="v-menu">
                      <div className="v-menu-empty faint">添加到全部选中</div>
                      {tagOptions.length === 0 ? <div className="v-menu-empty faint">还没有标签</div> : null}
                      {tagOptions.map((t) => (
                        <button
                          key={`add-${t.id}`}
                          type="button"
                          className="v-menu-item"
                          onClick={() => { close(); void addTag(t.name) }}
                        >
                          <span className="truncate">#{t.name}</span>
                        </button>
                      ))}
                      {bulkTagsPresent.length > 0 ? (
                        <>
                          <div className="v-menu-sep" />
                          <div className="v-menu-empty faint">从选中项移除</div>
                          {bulkTagsPresent.map((t) => (
                            <button
                              key={`del-${t}`}
                              type="button"
                              className="v-menu-item"
                              onClick={() => { close(); void removeTag(t) }}
                            >
                              <span className="truncate">#{t}</span>
                            </button>
                          ))}
                        </>
                      ) : null}
                    </div>
                  )}
                </Popover>

                <span className="v-focus-sep" aria-hidden="true" />

                <Button small onClick={() => void runAction('归档', (o) => api.updateObject(o.id, { archived: true }))}>归档</Button>
                <Button small variant="danger" onClick={() => setBulkConfirm('delete')}>删除</Button>
              </>
            )}

            <div className="v-toolbar-spacer" />

            <Button small variant="ghost" disabled={batchBusy !== null} onClick={() => setChecked(new Set())}>清除选择</Button>
          </div>
        ) : (
        <div className="v-toolbar-row">
          <Popover
            triggerClassName={`chip ${filters.status.length ? 'chip-active' : ''}`.trim()}
            trigger={filters.status.length ? `状态 · ${filters.status.length}` : '状态'}
            width={190}
          >
            {() => (
              <div className="v-menu">
                {statusOptions.length === 0 ? <div className="v-menu-empty faint">无可选状态</div> : null}
                {statusOptions.map((s) => (
                  <label className="v-check" key={s.key}>
                    <input
                      type="checkbox"
                      checked={filters.status.includes(s.key)}
                      onChange={() => setFilters({ status: toggleIn(filters.status, s.key) })}
                    />
                    <ColorDot color={s.color} />{s.label}
                  </label>
                ))}
                {allTypes && statusOptions.length > 0
                  ? <div className="v-menu-empty faint">全部类型作用域：以上是所有类型状态的并集</div>
                  : null}
              </div>
            )}
          </Popover>

          <Popover
            triggerClassName={`chip ${filters.priority.length ? 'chip-active' : ''}`.trim()}
            trigger={filters.priority.length ? `优先级 · ${filters.priority.join(' ')}` : '优先级'}
            width={170}
          >
            {() => (
              <div className="v-menu">
                {priorityOptions.map((p) => (
                  <label className="v-check" key={p.key}>
                    <input
                      type="checkbox"
                      checked={filters.priority.includes(p.key)}
                      onChange={() => setFilters({ priority: toggleIn(filters.priority, p.key) })}
                    />
                    <PriorityTag value={p.key} />
                    {p.label ? <span className="faint truncate">{p.label}</span> : null}
                  </label>
                ))}
              </div>
            )}
          </Popover>

          {/* filters.ownerId 是干系人 id（后端按 owner_id 筛），显示给人看的是名字。
              选项来自名册而不是「当前结果里出现过的负责人」——后者筛完一次就只剩一个人可选了。 */}
          <Popover
            triggerClassName={`chip ${filters.ownerId ? 'chip-active' : ''}`.trim()}
            trigger={filters.ownerId ? `负责人 · ${ownerFilterName}` : '负责人'}
            width={230}
          >
            {(close) => (
              <OwnerMenu
                value={filters.ownerId || null}
                valueName={ownerFilterName}
                emptyLabel="全部"
                hideEmptyHint
                showCounts
                onPick={(id) => { close(); setFilters({ ownerId: id }) }}
              />
            )}
          </Popover>

          {/* 标签：多选，后端是 AND 语义（同时带全部所选标签才命中） */}
          <Popover
            triggerClassName={`chip ${filters.tags.length ? 'chip-active' : ''}`.trim()}
            trigger={filters.tags.length ? `标签 · ${filters.tags.length}` : '标签'}
            width={210}
          >
            {() => (
              <div className="v-menu">
                {tagOptions.length === 0 ? <div className="v-menu-empty faint">还没有标签</div> : null}
                {tagOptions.map((t) => (
                  <label className="v-check" key={t.id}>
                    <input
                      type="checkbox"
                      checked={filters.tags.includes(t.name)}
                      onChange={() => setFilters({ tags: toggleIn(filters.tags, t.name) })}
                    />
                    <span className="truncate">#{t.name}</span>
                    <span className="badge v-tag-count">{t.count}</span>
                  </label>
                ))}
                {tagOptions.length > 0
                  ? <div className="v-menu-empty faint">多选为「同时满足」</div>
                  : null}
              </div>
            )}
          </Popover>

          {filters.tags.length > 0 ? (
            <div className="v-filter-chips">
              {filters.tags.map((t) => (
                <TagChip key={t} name={t} onRemove={() => setFilters({ tags: filters.tags.filter((x) => x !== t) })} />
              ))}
            </div>
          ) : null}

          {hasFilters ? <Button small variant="ghost" onClick={resetFilters}>清空筛选</Button> : null}

          <div className="v-toolbar-spacer" />

          <Popover trigger={`分组：${groupLabel}`} align="right" width={140}>
            {(close) => (
              <div className="v-menu">
                {groupOptions.map((g) => (
                  <button
                    key={g.key}
                    type="button"
                    className={`v-menu-item ${effGroup === g.key ? 'v-menu-item-active' : ''}`.trim()}
                    onClick={() => {
                      close()
                      if (allTypes) setCrossGroup(g.key as CrossGroupKey)
                      else setGroupBy(g.key as GroupKey)
                    }}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            )}
          </Popover>

          <Popover trigger={`排序：${sortLabel} ${sortDesc ? '↓' : '↑'}`} align="right" width={170}>
            {() => (
              <div className="v-menu">
                {SORT_FIELDS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    className={`v-menu-item ${sortField === f.key ? 'v-menu-item-active' : ''}`.trim()}
                    onClick={() => pickSort(f.key)}
                  >
                    <span>{f.label}</span>
                    {sortField === f.key ? <span className="faint">{sortDesc ? '降序' : '升序'}</span> : null}
                  </button>
                ))}
                <div className="v-menu-empty faint">再点当前项可切换升降序</div>
              </div>
            )}
          </Popover>

          <Button small disabled title="另存为视图将在 M2 支持">另存为视图</Button>
        </div>
        )}
      </div>

      {editFail ? (
        <div className="v-batch-note v-batch-note-bad">
          <span>
            <span className="mono faint v-ref">{editFail.ref}</span>
            {` 改${FIELD_LABEL[editFail.field]}没成功，已改回原值：${editFail.message}`}
          </span>
          <div className="v-toolbar-spacer" />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label="关闭提示"
            onClick={() => setEditFail(null)}
          >
            ×
          </button>
        </div>
      ) : null}

      {batchOutcome ? (
        <div className={`v-batch-note ${batchOutcome.failures.length > 0 ? 'v-batch-note-bad' : ''}`.trim()}>
          <span>
            {batchOutcome.failures.length === 0
              ? `${batchOutcome.label} 完成：已更新 ${batchOutcome.ok} 项`
              : `${batchOutcome.label}：${batchOutcome.ok + batchOutcome.failures.length} 项中 ${batchOutcome.failures.length} 项失败`}
          </span>
          {batchOutcome.failures.length > 0 ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowFailures((v) => !v)}>
              {showFailures ? '收起' : '查看失败原因'}
            </button>
          ) : null}
          <div className="v-toolbar-spacer" />
          <button type="button" className="btn btn-ghost btn-sm" aria-label="关闭提示" onClick={() => setBatchOutcome(null)}>×</button>
        </div>
      ) : null}

      {batchOutcome && showFailures ? (
        <div className="v-batch-fails">
          {batchOutcome.failures.map((f) => (
            <div className="v-batch-fail" key={f.id}>
              <span className="mono faint v-ref">{f.ref}</span>
              <span className="truncate">{f.title}</span>
              {/* 后端错误原文照搬：跨类型改状态这种失败，用户需要知道是哪条为什么 */}
              <span className="v-batch-fail-msg">{f.message}</span>
            </div>
          ))}
        </div>
      ) : null}

      {error ? <div className="error-banner">{error}</div> : null}
      {loading && objects.length > 0 ? <div className="loading-bar" /> : null}

      <div className="v-view-body">{body()}</div>

      <ConfirmDialog
        open={purgeTarget !== null}
        title="彻底删除"
        confirmText="彻底删除"
        danger
        busy={purging}
        error={purgeError}
        onCancel={() => setPurgeTarget(null)}
        onConfirm={() => void confirmPurge()}
      >
        <p>
          将永久删除 <span className="mono">{purgeTarget?.ref}</span>「{purgeTarget?.title}」，
          该操作不可撤销。
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={bulkConfirm === 'delete'}
        title="批量删除"
        confirmText={`删除 ${checked.size} 项`}
        danger
        onCancel={() => setBulkConfirm(null)}
        onConfirm={() => {
          setBulkConfirm(null)
          void runAction('删除', (o) => api.deleteObject(o.id))
        }}
      >
        <p>将把选中的 {checked.size} 项移到回收站，之后可在「回收站」里恢复。</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={bulkConfirm === 'purge'}
        title="批量彻底删除"
        confirmText={`彻底删除 ${checked.size} 项`}
        danger
        onCancel={() => setBulkConfirm(null)}
        onConfirm={() => {
          setBulkConfirm(null)
          void runAction('彻底删除', (o) => api.deleteObject(o.id, true))
        }}
      >
        <p>
          将永久删除选中的 {checked.size} 项及其关联与修订记录，
          <strong>删除后无法恢复</strong>，回收站里也不会再有。
        </p>
      </ConfirmDialog>
    </div>
  )
}

/* ------------------------------------------------------------------ 看板 */

interface BoardProps {
  statuses: Status[]
  objects: WorkObject[]
  selectedId: string | null
  categoryChip: (o: WorkObject) => ReactNode
  onSelect: (id: string) => void
  /** 回整个对象而不只是 id：调用方要拿它比对旧值、失败时报出是哪一条 */
  onMove: (o: WorkObject, status: string) => void
}

function BoardView({ statuses, objects, selectedId, categoryChip, onSelect, onMove }: BoardProps) {
  const [dragOver, setDragOver] = useState<string | null>(null)

  const byStatus = useMemo(() => {
    const m = new Map<string, WorkObject[]>()
    for (const s of statuses) m.set(s.key, [])
    for (const o of objects) {
      const arr = m.get(o.status)
      if (arr) arr.push(o)
    }
    return m
  }, [statuses, objects])

  // 原生 HTML5 拖拽，不引拖拽库。放下时交给外面的 commitInline：
  // 和列表里点单元格改状态走同一条路，失败同样回滚并给出提示——
  // 拖过去的卡片停在新列里、库里还是旧状态，是最难被发现的一种错。
  const handleDrop = (e: DragEvent<HTMLDivElement>, status: string) => {
    e.preventDefault()
    setDragOver(null)
    const id = e.dataTransfer.getData('text/plain')
    if (!id) return
    const obj = objects.find((o) => o.id === id)
    if (!obj || obj.status === status) return
    onMove(obj, status)
  }

  return (
    <div className="v-board">
      {statuses.map((s) => {
        const items = byStatus.get(s.key) ?? []
        return (
          <div
            key={s.key}
            className={`v-board-column ${dragOver === s.key ? 'v-board-column-over' : ''}`.trim()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(s.key) }}
            onDragLeave={() => setDragOver((k) => (k === s.key ? null : k))}
            onDrop={(e) => handleDrop(e, s.key)}
          >
            <div className="v-board-head">
              <ColorDot color={s.color} />
              <span>{s.label}</span>
              <span className="badge">{items.length}</span>
            </div>
            <div className="v-board-list">
              {items.map((o) => (
                <div
                  key={o.id}
                  role="button"
                  tabIndex={0}
                  className={`card v-board-card ${o.id === selectedId ? 'v-board-card-selected' : ''}`.trim()}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', o.id)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onClick={() => onSelect(o.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(o.id) }
                  }}
                >
                  <div className="mono faint v-ref">{o.ref}</div>
                  <div className="card-title">{o.title}</div>
                  <div className="v-board-card-meta">
                    <PriorityTag value={o.priority} />
                    {categoryChip(o)}
                    {o.due_at ? (
                      <span className={isOverdue(o.due_at) && !o.completed_at ? 'v-overdue' : 'faint'}>
                        {formatDue(o.due_at)}
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
              {items.length === 0 ? <div className="faint v-board-empty">拖到这里</div> : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
