// 快捷访问（launchpad）独立页面。
// 数据全部走 lib/api.ts，本文件不碰 fetch、不落 localStorage（密度偏好除外，那是纯 UI 偏好）。
// 后端未上线时 GET 会失败，按「空态」处理而不是报错横幅——不挡住用户建第一条。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useWorkspace, parseView, type FocusKind, type ViewDescriptor } from '../hooks/workspace'
import type {
  ObjectType, Shortcut, ShortcutGroup, ShortcutInput, ShortcutTargetKind, WorkObject,
} from '../lib/types'

/* ────────────────── 数据层：模块级单例缓存 + 订阅 ────────────────── */
// 顶栏、命令面板、侧栏徽标、状态栏、页面本身都要这份数据，
// 各自 fetch 会打出 5 份请求，所以做成一个共享缓存。

let cache: ShortcutGroup[] | null = null
let inflight: Promise<void> | null = null
const subs = new Set<() => void>()

const emit = () => subs.forEach((f) => f())

/** 未分组是后端合成的伪组，没有未分组条目时它整个不返回。
    这里补一个空的回来：否则把最后一条拖走后未分组区消失，就再也拖不回去了。 */
function normalize(raw: ShortcutGroup[] | null): ShortcutGroup[] {
  const gs = raw ?? []
  if (gs.length === 0 || gs.some(isPseudo)) return gs
  return [...gs, {
    id: '', name: '未分组', color: '', collapsed: false, sort_order: 0,
    created_at: '', updated_at: '', items: [],
  }]
}

function load(force = false): Promise<void> {
  if (inflight) return inflight
  if (cache && !force) return Promise.resolve()
  inflight = api.shortcuts(true)
    .then((r) => { cache = normalize(r as ShortcutGroup[]) })
    .catch(() => { cache = [] }) // 后端还没上线 → 空态，不报错
    .finally(() => { inflight = null; emit() })
  return inflight
}

/** 扁平化：分组顺序在前，组内按 sort_order */
function flatten(groups: ShortcutGroup[]): Shortcut[] {
  const out: Shortcut[] = []
  for (const g of groups) {
    for (const s of [...(g.items ?? [])].sort((a, b) => a.sort_order - b.sort_order)) out.push(s)
  }
  return out
}

export function useShortcuts() {
  const [, bump] = useState(0)
  useEffect(() => {
    const f = () => bump((n) => n + 1)
    subs.add(f)
    void load()
    return () => { subs.delete(f) }
  }, [])
  const groups = cache ?? []
  const items = useMemo(() => flatten(groups), [groups])
  return { groups, items, loaded: cache !== null, reload: () => load(true) }
}

/** 伪组：后端把未分组的条目放在 id 为空串的那一组里 */
const isPseudo = (g: ShortcutGroup) => g.id === ''
const groupIdOf = (g: ShortcutGroup): string | null => (isPseudo(g) ? null : g.id)

/* ────────────────── 变量替换与安全校验 ────────────────── */

const VAR_RE = /\{\{(ref|title|id|owner|status|category|today)\}\}/g

export function hasVars(url: string): boolean {
  VAR_RE.lastIndex = 0
  return VAR_RE.test(url)
}

/** 变量值一律 encodeURIComponent，避免标题里的 & ? # 破坏 URL 结构 */
export function resolveUrl(url: string, o: WorkObject | null): string {
  return url.replace(VAR_RE, (_, key: string) => {
    if (key === 'today') return new Date().toISOString().slice(0, 10)
    if (!o) return ''
    const map: Record<string, string> = {
      ref: o.ref, title: o.title, id: o.id,
      // 取 owner_name 不取 owner：后者是 0010 之前的自由文本，新对象上恒为空。
      // 用它的话，带 {owner} 的快捷链接会静默变成空值——链接照样能点，只是少了一段。
      owner: o.owner_name ?? '', status: o.status, category: o.category_name ?? '',
    }
    return encodeURIComponent(map[key] ?? '')
  })
}

const ALLOWED_PROTOCOLS = ['http:', 'https:', 'file:']

/** 前端也挡一道：只放行 http/https/file，显式拒绝 javascript: 这类 */
export function isSafeUrl(url: string): boolean {
  try { return ALLOWED_PROTOCOLS.includes(new URL(url).protocol) } catch { return false }
}

function domainOf(url: string): string {
  try { return new URL(url).host || url } catch { return url.replace(/^\w+:\/\//, '').split('/')[0] || url }
}

const FOCUS_NAMES: Record<FocusKind, string> = {
  inbox: '收件箱', today: '今日', week: '本周', overdue: '逾期', stalled: '停滞', trash: '回收站',
}

/** 解析出来了但没有任何有效条件：applyView 后跟没点一样，属于死入口 */
export function isEmptyView(v: ViewDescriptor): boolean {
  return !Object.values(v).some((x) => (Array.isArray(x) ? x.length > 0 : x !== undefined && x !== null && x !== ''))
}

/**
 * 把视图描述符渲染成一行短标签。卡片上的目标预览只有一行，
 * 所以作用域照写、条件多于一段就折叠成计数，宁可少说也不要撑破卡片。
 */
export function describeView(v: ViewDescriptor, typeById: Record<string, ObjectType>): string {
  const scope: string[] = []
  if (v.typeId) scope.push(typeById[v.typeId]?.plural ?? v.typeId)
  if (v.uncategorized) scope.push('未分类')
  else if (v.categoryId) scope.push('某分类') // 分类名要拉该类型的分类树才知道，预览场景不值得为它发请求

  const cond: string[] = []
  if (v.focus) cond.push(FOCUS_NAMES[v.focus] ?? v.focus)
  if (v.tags?.length) cond.push(v.tags.length === 1 ? `#${v.tags[0]}` : `${v.tags.length} 个标签`)
  if (v.status?.length) cond.push(v.status.length === 1 ? v.status[0] : `${v.status.length} 个状态`)
  if (v.priority?.length) cond.push(v.priority.length === 1 ? v.priority[0] : `${v.priority.length} 个优先级`)
  // 存的是干系人 id，直接显示就是 @stk_6838aa9fa564da40。名字要查名册，
  // 和上面 categoryId 一样：预览场景不值得为它发请求。
  if (v.owner_id) cond.push('@某负责人')
  if (v.q) cond.push(`“${v.q}”`)

  if (!scope.length && !cond.length) return '未设置'
  const tail = cond.length > 1 ? [`${cond.length} 个筛选`] : cond
  return [...scope, ...tail].join(' · ')
}

/** 存库 JSON → 人能读的短标签。旧形状（kind: focus/tag/type）由 parseView 兜住 */
export function viewLabel(json: string, typeById: Record<string, ObjectType>): string {
  const v = parseView(json)
  return v ? describeView(v, typeById) : '未设置'
}

export function commandLabel(cmd: string, typeById: Record<string, ObjectType>): string {
  if (cmd === 'open:category-manager') return '管理分类'
  if (cmd.startsWith('quick-capture:')) {
    const id = cmd.slice('quick-capture:'.length)
    return `快速捕获：${typeById[id]?.name ?? id}`
  }
  return cmd || '未设置'
}

/** 目标预览：外链给域名、内跳给视图描述、动作给动作名 */
export function targetPreview(sc: Shortcut, typeById: Record<string, ObjectType>): string {
  if (sc.target_kind === 'url') return sc.url ? domainOf(sc.url) : '未设置'
  if (sc.target_kind === 'internal') return viewLabel(sc.nav, typeById)
  return commandLabel(sc.command, typeById)
}

export const KIND_LABEL: Record<ShortcutTargetKind, string> = { url: '外链', internal: '内跳', command: '动作' }

/* ────────────────── 执行 ────────────────── */

// QuickCapture 自己就读这个 key 挑默认类型，复用它即可预选（见 components/QuickCapture.tsx）
const QC_TYPE_KEY = 'pm.quick-capture.last-type'

export interface RunCtx {
  selected: WorkObject | null
  applyView: (v: ViewDescriptor) => void
  setQuickCaptureOpen: (b: boolean) => void
  setCategoryManagerOpen: (b: boolean) => void
}

/** 返回 false 表示被拦下（缺少选中对象或目标非法） */
export function runShortcut(sc: Shortcut, ctx: RunCtx): boolean {
  if (sc.target_kind === 'url') {
    if (hasVars(sc.url) && !ctx.selected) return false
    const url = resolveUrl(sc.url, ctx.selected)
    if (!isSafeUrl(url)) return false
    if (sc.open_in === 'same_tab') window.location.assign(url)
    else window.open(url, '_blank', 'noopener,noreferrer')
  } else if (sc.target_kind === 'internal') {
    const v = parseView(sc.nav)
    if (!v) return false
    ctx.applyView(v) // 一步还原作用域 + 筛选
  } else {
    if (sc.command === 'open:category-manager') ctx.setCategoryManagerOpen(true)
    else if (sc.command.startsWith('quick-capture:')) {
      const typeId = sc.command.slice('quick-capture:'.length)
      try { localStorage.setItem(QC_TYPE_KEY, typeId) } catch { /* 忽略 */ }
      ctx.setQuickCaptureOpen(true)
    } else return false
  }
  // 记使用：fire-and-forget，失败不打扰用户，成功后顺手刷新「最近使用」
  api.visitShortcut(sc.id).then(() => load(true)).catch(() => { /* 忽略 */ })
  return true
}

/** 含变量但没选中对象 → 置灰 */
export function isBlocked(sc: Shortcut, selected: WorkObject | null): boolean {
  return sc.target_kind === 'url' && hasVars(sc.url) && !selected
}

/* ────────────────── 页面 ────────────────── */

const PRESET_COLORS = ['#3b5bdb', '#2b8a3e', '#b35309', '#c92a2a', '#7048e8', '#0c8599', '#495057', '#e8590c']
const DENSITY_KEY = 'pmw.shortcutDensity'

const cls = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(' ')

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

function emptyDraft(groupId: string | null, order: number): Shortcut {
  return {
    id: '', group_id: groupId, label: '', target_kind: 'url',
    url: '', nav: '{}', command: '', icon: '', color: '', description: '',
    open_in: 'new_tab', pinned: false, sort_order: order,
    last_used_at: null, use_count: 0, created_at: '', updated_at: '',
  }
}

export default function ShortcutsPage({ lastScope }: { lastScope?: ViewDescriptor }) {
  const {
    typeById, types, applyView, currentView, selected,
    setQuickCaptureOpen, setCategoryManagerOpen,
  } = useWorkspace()
  const { groups, items, loaded, reload } = useShortcuts()

  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Shortcut | null>(null)
  const [dense, setDense] = useState(() => {
    try { return localStorage.getItem(DENSITY_KEY) === 'compact' } catch { return false }
  })
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // 拖拽源用 ref：dragstart 与 drop 可能落在同一批 React 更新里，走 state 会读到旧值
  const dragRef = useRef<string | null>(null)
  const [dropHint, setDropHint] = useState<string | null>(null)

  const ctx: RunCtx = { selected, applyView, setQuickCaptureOpen, setCategoryManagerOpen }

  // 本页的 nav 是 {kind:'page'}，currentView() 只剩筛选没有作用域；
  // 用 App 记下的「离开列表前的作用域」补回去，否则存下来的入口点回去会变成「全部类型」。
  const viewToSave = useCallback((): ViewDescriptor => {
    const v = currentView()
    if (v.typeId || v.categoryId || v.uncategorized) return v
    return { ...lastScope, ...v }
  }, [currentView, lastScope])

  const flash = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2400)
  }, [])

  /** 所有写操作的统一出口：失败给提示，成功后重拉 */
  const mutate = useCallback(async (fn: () => Promise<unknown>, failMsg: string) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      // 带上后端原文：reorder 这类强校验失败时，光说「保存失败」查不出原因
      flash(`${failMsg}：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      await reload() // 无论成败都重拉，失败时把乐观的界面拉回真实状态
      setBusy(false)
    }
  }, [reload, flash])

  const toggleDense = () => setDense((v) => {
    try { localStorage.setItem(DENSITY_KEY, v ? 'card' : 'compact') } catch { /* 忽略 */ }
    return !v
  })

  const term = q.trim().toLowerCase()
  const match = useCallback((s: Shortcut) => !term
    || s.label.toLowerCase().includes(term)
    || s.description.toLowerCase().includes(term)
    || s.url.toLowerCase().includes(term), [term])

  const recent = useMemo(
    () => items.filter((s) => s.last_used_at)
      .sort((a, b) => (b.last_used_at ?? '').localeCompare(a.last_used_at ?? ''))
      .slice(0, 8),
    [items],
  )

  const openNew = useCallback((groupId: string | null = null) => {
    setEditing(emptyDraft(groupId, items.length))
  }, [items.length])

  // 页面内快捷键：N 新建、Esc 关编辑面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && editing) { e.stopPropagation(); setEditing(null); return }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      if ((e.key === 'n' || e.key === 'N') && !editing) { e.preventDefault(); openNew() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, openNew])

  const run = (sc: Shortcut) => {
    if (!runShortcut(sc, ctx)) {
      flash(isBlocked(sc, selected) ? '需先选中一个工作对象' : '快捷入口的目标无效')
    }
  }

  /* 拖拽：同组排序 + 跨组改归属。
     reorder 是全量强校验——ids 必须列全该组当下的所有条目，少一个就 400，
     所以跨组要先改归属，再对「源组剩下的」和「目标组含新成员的」各发一次。 */
  const handleDrop = (targetGroupId: string | null, beforeId: string | null) => {
    const dragId = dragRef.current
    dragRef.current = null
    setDropHint(null)
    if (!dragId || dragId === beforeId) return
    const dragged = items.find((s) => s.id === dragId)
    if (!dragged) return

    const from = dragged.group_id ?? null
    const target = items.filter((s) => (s.group_id ?? null) === targetGroupId && s.id !== dragId)
    const at = beforeId ? target.findIndex((s) => s.id === beforeId) : target.length
    target.splice(at < 0 ? target.length : at, 0, dragged)
    const targetIds = target.map((s) => s.id)
    const sourceIds = from === targetGroupId
      ? []
      : items.filter((s) => (s.group_id ?? null) === from && s.id !== dragId).map((s) => s.id)

    void mutate(async () => {
      if (from !== targetGroupId) {
        await api.updateShortcut(dragId, { group_id: targetGroupId })
        if (sourceIds.length) await api.reorderShortcuts(from, sourceIds)
      }
      await api.reorderShortcuts(targetGroupId, targetIds)
    }, '排序保存失败')
  }

  const moveGroup = (g: ShortcutGroup, delta: number) => {
    const real = groups.filter((x) => !isPseudo(x))
    const i = real.findIndex((x) => x.id === g.id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= real.length) return
    const arr = [...real]
    const [x] = arr.splice(i, 1)
    arr.splice(j, 0, x)
    void mutate(
      () => Promise.all(arr.map((it, k) => api.updateShortcutGroup(it.id, { sort_order: k }))),
      '分组排序保存失败',
    )
  }

  const sections = groups.map((g) => ({ group: g, list: (g.items ?? []).filter(match).sort((a, b) => a.sort_order - b.sort_order) }))
  const hasAny = items.length > 0

  return (
    <div className="sc-page">
      <div className="sc-head">
        <span className="sc-title">快捷访问</span>
        <input
          className="input sc-search"
          value={q}
          placeholder="搜索入口…"
          aria-label="搜索快捷入口"
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="sc-head-actions">
          <div className="seg">
            <button type="button" className={cls('seg-item', !dense && 'seg-item-active')} onClick={() => dense && toggleDense()}>卡片</button>
            <button type="button" className={cls('seg-item', dense && 'seg-item-active')} onClick={() => !dense && toggleDense()}>紧凑</button>
          </div>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void mutate(
              () => api.createShortcutGroup({ name: '新分组', sort_order: groups.length }),
              '新建分组失败',
            )}
          >
            + 新建分组
          </button>
          <button type="button" className="btn btn-primary" onClick={() => openNew()}>+ 新建入口</button>
        </div>
      </div>

      <div className="sc-main">
      <div className="sc-body">
        {!hasAny && (
          <div className="empty-state">
            <div>{loaded ? '还没有快捷入口，添加常用的 Jira 看板、文档空间、监控面板' : '加载中…'}</div>
            {loaded && (
              <div className="sc-empty-actions">
                <button type="button" className="btn btn-primary" onClick={() => openNew()}>添加第一个</button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setEditing({
                    ...emptyDraft(null, 0), target_kind: 'internal',
                    nav: JSON.stringify(viewToSave()), label: '当前视图',
                  })}
                >
                  把当前视图存为快捷入口（含筛选）
                </button>
              </div>
            )}
          </div>
        )}

        {hasAny && recent.length > 0 && !term && (
          <section className="sc-section">
            <div className="sc-section-head"><span className="sc-group-name">最近使用</span></div>
            <div className="sc-recent">
              {recent.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={cls('sc-recent-item', isBlocked(s, selected) && 'sc-disabled')}
                  title={isBlocked(s, selected) ? '需先选中一个工作对象' : s.label}
                  onClick={() => run(s)}
                >
                  <span className="sc-icon sc-icon-sm" style={s.color ? { background: s.color } : undefined}>
                    {s.icon || s.label.slice(0, 1)}
                  </span>
                  <span className="truncate">{s.label}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {hasAny && sections.map(({ group, list }) => {
          // 未分组即使空了也要留着：它被拖空后若消失，条目就再没有能拖回去的落点。
          // 搜索态例外，那时空分区纯属噪音。
          if (isPseudo(group) && list.length === 0 && (term || groups.length <= 1)) return null
          // 搜索时强制展开，否则命中项会藏在折叠组里
          const collapsed = !term && group.collapsed
          const gid = groupIdOf(group)
          return (
            <section
              key={group.id || '__ungrouped'}
              className={cls('sc-section', dropHint === group.id && 'sc-section-over')}
              onDragOver={(e) => { e.preventDefault(); setDropHint(group.id) }}
              onDragLeave={() => setDropHint(null)}
              onDrop={(e) => { e.preventDefault(); handleDrop(gid, null) }}
            >
              <div className="sc-section-head">
                {isPseudo(group) ? (
                  <>
                    <span className="sc-group-name">未分组</span>
                    <span className="badge">{list.length}</span>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="tree-toggle"
                      data-open={!collapsed}
                      aria-label={collapsed ? '展开' : '折叠'}
                      aria-expanded={!collapsed}
                      onClick={() => void mutate(
                        () => api.updateShortcutGroup(group.id, { collapsed: !group.collapsed }),
                        '折叠状态保存失败',
                      )}
                    />
                    {group.color && <span className="cat-dot" style={{ background: group.color }} />}
                    <GroupName
                      group={group}
                      onRename={(name) => void mutate(() => api.updateShortcutGroup(group.id, { name }), '重命名失败')}
                    />
                    <span className="badge">{list.length}</span>
                    <span className="row-actions sc-group-actions">
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => moveGroup(group, -1)}>上移</button>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => moveGroup(group, 1)}>下移</button>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        title="删除分组，组内条目转为未分组"
                        onClick={() => void mutate(() => api.deleteShortcutGroup(group.id), '删除分组失败')}
                      >
                        删除
                      </button>
                    </span>
                  </>
                )}
              </div>

              {!collapsed && (
                <div className={cls('sc-grid', dense && 'sc-grid-dense')}>
                  {list.map((s) => (
                    <Card
                      key={s.id}
                      sc={s}
                      dense={dense}
                      blocked={isBlocked(s, selected)}
                      preview={targetPreview(s, typeById)}
                      onRun={() => run(s)}
                      onEdit={() => setEditing(s)}
                      onCopy={() => {
                        const text = s.target_kind === 'url' ? resolveUrl(s.url, selected) : targetPreview(s, typeById)
                        navigator.clipboard?.writeText(text).then(() => flash('已复制')).catch(() => flash('复制失败'))
                      }}
                      onPin={() => void mutate(() => api.updateShortcut(s.id, { pinned: !s.pinned }), '置顶失败')}
                      onDelete={() => void mutate(() => api.deleteShortcut(s.id), '删除失败')}
                      onDragStart={() => { dragRef.current = s.id }}
                      onDropBefore={() => handleDrop(s.group_id ?? null, s.id)}
                    />
                  ))}
                  <button type="button" className="sc-card sc-card-add" onClick={() => openNew(gid)}>
                    + 添加到{isPseudo(group) ? '未分组' : '此分组'}
                  </button>
                </div>
              )}
            </section>
          )
        })}
      </div>

      {editing && (
        <Editor
          key={editing.id || '__new'}
          draft={editing}
          groups={groups.filter((g) => !isPseudo(g))}
          types={types}
          typeById={typeById}
          selected={selected}
          currentView={viewToSave}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void reload() }}
        />
      )}
      </div>

      {toast && <div className="sc-toast">{toast}</div>}
    </div>
  )
}

/* 组名就地重命名：本地输入，失焦或回车才提交，避免每次击键一个 PATCH */
function GroupName({ group, onRename }: { group: ShortcutGroup; onRename: (name: string) => void }) {
  const [v, setV] = useState(group.name)
  useEffect(() => { setV(group.name) }, [group.name])
  const commit = () => {
    const name = v.trim()
    if (!name || name === group.name) { setV(group.name); return }
    onRename(name)
  }
  return (
    <input
      className="sc-group-name sc-group-input"
      value={v}
      aria-label="分组名称"
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
    />
  )
}

/* ────────────────── 卡片 ────────────────── */

function Card({
  sc, dense, blocked, preview, onRun, onEdit, onCopy, onPin, onDelete, onDragStart, onDropBefore,
}: {
  sc: Shortcut
  dense: boolean
  blocked: boolean
  preview: string
  onRun: () => void
  onEdit: () => void
  onCopy: () => void
  onPin: () => void
  onDelete: () => void
  onDragStart: () => void
  onDropBefore: () => void
}) {
  const [over, setOver] = useState(false)
  return (
    <div
      className={cls('sc-card', dense && 'sc-card-dense', blocked && 'sc-disabled', over && 'sc-card-over')}
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart() }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); onDropBefore() }}
      title={blocked ? '需先选中一个工作对象' : sc.label}
    >
      <button type="button" className="sc-card-main" onClick={onRun}>
        <span className="sc-icon" style={sc.color ? { background: sc.color } : undefined}>
          {sc.icon || sc.label.slice(0, 1) || '·'}
        </span>
        <span className="sc-card-text">
          <span className="sc-card-label truncate">{sc.label || '未命名'}</span>
          {!dense && sc.description && <span className="sc-card-desc truncate">{sc.description}</span>}
          <span className="sc-card-target truncate mono">{preview}</span>
        </span>
      </button>

      <span className="sc-card-tags">
        {sc.pinned && <span className="tag" title="已置顶到顶栏">顶</span>}
        <span className="tag">{KIND_LABEL[sc.target_kind]}</span>
        {sc.target_kind === 'url' && hasVars(sc.url) && (
          <span className="tag" title={blocked ? '需先选中一个工作对象' : 'URL 含变量，按当前选中对象渲染'}>变量</span>
        )}
      </span>

      <span className="row-actions sc-card-actions">
        <button type="button" className="btn btn-sm btn-ghost" onClick={onEdit}>编辑</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCopy}>复制</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onPin}>{sc.pinned ? '取消置顶' : '置顶'}</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onDelete}>删除</button>
      </span>
    </div>
  )
}

/* ────────────────── 编辑面板 ────────────────── */

const PICK_HINT = '请选择要跳转的视图，可点「存下当前视图（含筛选）」'

/** 解析交给 parseView（它同时兼容旧形状），这里只把几种失败翻译成人话 */
function navError(json: string): string | null {
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return '视图 JSON 格式不正确' }
  // 新建时默认就是 `{}`，这时候该说「去填」而不是「配置无效」
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0) return PICK_HINT
  const v = parseView(json)
  if (!v) return '视图配置无效'
  // 解析得出的空描述符不是「全部」而是「点了没反应」，别让用户存下一个死入口
  if (isEmptyView(v)) return PICK_HINT
  return null
}

/** 当前类型下目标字段的错误。保存按钮据此置灰，别让用户去撞后端 400 */
function targetError(d: Shortcut): string | null {
  if (d.target_kind === 'url') {
    if (!d.url.trim()) return '请填写链接'
    if (!isSafeUrl(d.url.trim())) return '只允许 http / https / file 链接'
    return null
  }
  if (d.target_kind === 'internal') return navError(d.nav)
  return d.command ? null : '请选择要触发的动作'
}

function toInput(d: Shortcut): ShortcutInput {
  return {
    group_id: d.group_id, label: d.label.trim(), target_kind: d.target_kind,
    url: d.url.trim(), nav: d.nav, command: d.command, icon: d.icon, color: d.color,
    description: d.description, open_in: d.open_in, pinned: d.pinned, sort_order: d.sort_order,
  }
}

function Editor({
  draft, groups, types, typeById, selected, currentView, onClose, onSaved,
}: {
  draft: Shortcut
  groups: ShortcutGroup[]
  types: ObjectType[]
  typeById: Record<string, ObjectType>
  selected: WorkObject | null
  currentView: () => ViewDescriptor
  onClose: () => void
  onSaved: () => void
}) {
  const [d, setD] = useState<Shortcut>(draft)
  const [serverErr, setServerErr] = useState<string | null>(null)
  const [touched, setTouched] = useState<{ label?: boolean; target?: boolean }>({})
  const [saving, setSaving] = useState(false)
  const firstRef = useRef<HTMLInputElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)
  const navRef = useRef<HTMLTextAreaElement>(null)
  const cmdRef = useRef<HTMLSelectElement>(null)
  // 记住上一次的类型：只有真的切了类型才抢焦点。
  // 用「跳过首帧」的布尔 ref 会被 StrictMode 的二次挂载击穿，dev 与生产表现不一致。
  const lastKind = useRef(draft.target_kind)

  useEffect(() => { firstRef.current?.focus() }, [])

  const set = (p: Partial<Shortcut>) => setD((v) => ({ ...v, ...p }))
  const touchTarget = () => setTouched((t) => (t.target ? t : { ...t, target: true }))
  const isNew = !d.id

  const labelErr = d.label.trim() ? null : '请填写名称'
  const tgtErr = targetError(d)
  const blocking = labelErr ?? tgtErr

  // 切到目标字段为空的类型时，直接把光标送过去，省得用户找
  useEffect(() => {
    if (lastKind.current === d.target_kind) return
    lastKind.current = d.target_kind
    if (!targetError(d)) return
    setTouched((t) => ({ ...t, target: true }))
    const el = d.target_kind === 'url' ? urlRef.current
      : d.target_kind === 'internal' ? navRef.current : cmdRef.current
    el?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.target_kind])

  const submit = async () => {
    if (blocking) { setTouched({ label: true, target: true }); return }
    setServerErr(null); setSaving(true)
    try {
      if (isNew) await api.createShortcut(toInput(d))
      else await api.updateShortcut(d.id, toInput(d))
      onSaved()
    } catch (e) {
      setServerErr(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally { setSaving(false) }
  }

  const preview = d.target_kind === 'url' ? resolveUrl(d.url, selected) : ''

  return (
    <aside className="sc-editor" role="dialog" aria-label="编辑快捷入口">
      <div className="sc-editor-head">
        <span>{isNew ? '新建快捷入口' : '编辑快捷入口'}</span>
        <button type="button" className="btn btn-sm btn-ghost status-push" onClick={onClose}>关闭</button>
      </div>

      <div className="sc-editor-body">
        <div className="field">
          <span className="field-label">名称</span>
          <input
            ref={firstRef}
            className="input"
            value={d.label}
            aria-invalid={!!labelErr}
            onChange={(e) => { setTouched((t) => ({ ...t, label: true })); set({ label: e.target.value }) }}
            onBlur={() => setTouched((t) => ({ ...t, label: true }))}
          />
          {labelErr && touched.label && <span className="sc-err">{labelErr}</span>}
        </div>

        <div className="field">
          <span className="field-label">类型</span>
          <div className="seg">
            {(['url', 'internal', 'command'] as ShortcutTargetKind[]).map((k) => (
              <button
                key={k}
                type="button"
                className={cls('seg-item', d.target_kind === k && 'seg-item-active')}
                onClick={() => set({ target_kind: k })}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </div>

        {d.target_kind === 'url' && (
          <>
            <div className="field">
              <span className="field-label">链接</span>
              <input
                ref={urlRef}
                className="input"
                placeholder="https://…"
                value={d.url}
                aria-invalid={!!tgtErr}
                onChange={(e) => { touchTarget(); set({ url: e.target.value }) }}
                onBlur={touchTarget}
              />
              {tgtErr && touched.target && <span className="sc-err">{tgtErr}</span>}
            </div>
            <div className="sc-hint">
              可用变量：<span className="mono">{'{{ref}} {{title}} {{id}} {{owner}} {{status}} {{category}} {{today}}'}</span>
              ，点击时用当前选中的工作对象填充。
            </div>
            {hasVars(d.url) && (
              <div className="sc-preview">
                <span className="field-label">实时预览</span>
                <div className="mono truncate" title={preview}>
                  {selected ? preview : '（当前没有选中对象，点击时会提示先选中）'}
                </div>
              </div>
            )}
            <div className="field">
              <span className="field-label">打开方式</span>
              <select className="select" value={d.open_in} onChange={(e) => set({ open_in: e.target.value as Shortcut['open_in'] })}>
                <option value="new_tab">新标签页</option>
                <option value="same_tab">当前窗口</option>
              </select>
            </div>
          </>
        )}

        {d.target_kind === 'internal' && (
          <>
            <div className="field">
              <span className="field-label">目标视图</span>
              <div className="sc-inline">
                <span className="truncate">{viewLabel(d.nav, typeById)}</span>
                <button
                  type="button"
                  className="btn btn-sm status-push"
                  title="把侧栏作用域和工具条上的筛选一起存下来"
                  onClick={() => { touchTarget(); set({ nav: JSON.stringify(currentView()) }) }}
                >
                  存下当前视图（含筛选）
                </button>
              </div>
            </div>
            <div className="field">
              <span className="field-label">视图 JSON</span>
              <textarea
                ref={navRef}
                className="textarea sc-json"
                value={d.nav}
                aria-invalid={!!tgtErr}
                onChange={(e) => { touchTarget(); set({ nav: e.target.value }) }}
                onBlur={touchTarget}
              />
              {tgtErr && touched.target && <span className="sc-err">{tgtErr}</span>}
            </div>
          </>
        )}

        {d.target_kind === 'command' && (
          <div className="field">
            <span className="field-label">动作</span>
            <select
              ref={cmdRef}
              className="select"
              value={d.command}
              aria-invalid={!!tgtErr}
              onChange={(e) => { touchTarget(); set({ command: e.target.value }) }}
              onBlur={touchTarget}
            >
              <option value="">请选择…</option>
              {types.map((t) => (
                <option key={t.id} value={`quick-capture:${t.id}`}>{`快速捕获：${t.name}`}</option>
              ))}
              <option value="open:category-manager">管理分类</option>
            </select>
            {tgtErr && touched.target && <span className="sc-err">{tgtErr}</span>}
          </div>
        )}

        <div className="form-row">
          <div className="field">
            <span className="field-label">图标文字（1-2 字）</span>
            <input className="input" maxLength={2} value={d.icon} onChange={(e) => set({ icon: e.target.value })} />
          </div>
          <div className="field">
            <span className="field-label">所属分组</span>
            <select className="select" value={d.group_id ?? ''} onChange={(e) => set({ group_id: e.target.value || null })}>
              <option value="">未分组</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
        </div>

        <div className="field">
          <span className="field-label">颜色</span>
          <div className="sc-swatches">
            <button type="button" className={cls('sc-swatch', !d.color && 'sc-swatch-on')} title="默认" onClick={() => set({ color: '' })} />
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={cls('sc-swatch', d.color === c && 'sc-swatch-on')}
                style={{ background: c }}
                title={c}
                onClick={() => set({ color: c })}
              />
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field-label">描述</span>
          <input className="input" value={d.description} onChange={(e) => set({ description: e.target.value })} />
        </div>

        <label className="sc-inline">
          <input type="checkbox" checked={d.pinned} onChange={(e) => set({ pinned: e.target.checked })} />
          <span>置顶到顶栏图标条</span>
        </label>

        {serverErr && <div className="error-banner">{serverErr}</div>}
      </div>

      <div className="sc-editor-foot">
        <button type="button" className="btn" onClick={onClose}>取消</button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || !!blocking}
          title={blocking ?? undefined}
          onClick={() => void submit()}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </aside>
  )
}
