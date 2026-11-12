// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 左侧导航只回答一个问题：我在看哪类工作对象、哪个分类。
// 「看哪些」的条件（聚焦/标签/状态/优先级/搜索）全部在内容页工具条里，不在这里。
// 底部固定区是另一条轴：模块入口（快捷访问 / Agent 中心 / 设置），与上面的对象轴用分隔线隔开。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspace, type NavSelection } from '../hooks/workspace'
import type { Category } from '../lib/types'
import { useShortcuts } from '../views/ShortcutsPage'

const cls = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(' ')

/** 收起态图标条只放一个字，取名称首字，避免引图标库或 emoji */
function glyphOf(s: string) {
  return s ? Array.from(s)[0] : '·'
}

/** 找到某分类在树中的所有祖先 id，用于选中深层分类时自动展开父级 */
function ancestorsOf(tree: Category[], id: string, trail: string[] = []): string[] | null {
  for (const c of tree) {
    if (c.id === id) return trail
    const hit = c.children?.length ? ancestorsOf(c.children, id, [...trail, c.id]) : null
    if (hit) return hit
  }
  return null
}

export default function Sidebar({
  collapsed,
  onToggle,
  onNavigate,
}: {
  collapsed: boolean
  onToggle: () => void
  onNavigate?: () => void
}) {
  const {
    types, categories, counts, nav, setNav,
  } = useWorkspace()

  const { items: shortcuts } = useShortcuts()

  // 展开状态按 category id 存；未记录过的：顶层默认展开，深层默认收起
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const go = useCallback((n: NavSelection) => {
    setNav(n)
    onNavigate?.()
  }, [setNav, onNavigate])

  // 选中深层分类（例如来自命令面板）时把它的祖先链展开
  useEffect(() => {
    if (!nav.categoryId || !categories.length) return
    const chain = ancestorsOf(categories, nav.categoryId)
    if (!chain?.length) return
    setExpanded((prev) => {
      const next = { ...prev }
      chain.forEach((id) => { next[id] = true })
      return next
    })
  }, [nav.categoryId, categories])

  const byType = counts?.by_type ?? {}
  const totalCount = counts?.total ?? 0
  // 类型上 uncategorized_by_type 是必填，但线上可能还跑着没有这个字段的旧后端，
  // 那时它在运行时是 undefined，所以这里照样要兜一层。
  const uncatByType = counts?.uncategorized_by_type ?? {}

  const sortedTypes = useMemo(
    () => [...types].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    [types],
  )

  // typeId 为 undefined = 全部类型：跨类型视图，聚焦筛选（今日/逾期）在这个作用域下才是原本的跨类型语义
  const allTypesActive = nav.kind === 'type' && !nav.typeId

  const renderCat = (cat: Category, depth: number) => {
    const kids = cat.children ?? []
    const open = expanded[cat.id] ?? depth === 0
    const active = nav.kind === 'type' && nav.categoryId === cat.id && !nav.uncategorized
    return (
      <div key={cat.id}>
        <div className={cls('tree-node', active && 'tree-node-active')}>
          <span className="tree-indent" style={{ width: depth * 14 }} />
          {kids.length > 0 ? (
            <button
              type="button"
              className="tree-toggle"
              data-open={open}
              aria-label={open ? '收起' : '展开'}
              aria-expanded={open}
              onClick={() => setExpanded((p) => ({ ...p, [cat.id]: !open }))}
            />
          ) : (
            <span className="tree-toggle" aria-hidden="true" style={{ visibility: 'hidden' }} />
          )}
          {cat.color && <span className="cat-dot" style={{ background: cat.color }} />}
          <button
            type="button"
            className="tree-label truncate"
            title={cat.path || cat.name}
            onClick={() => go({ kind: 'type', typeId: cat.type_id, categoryId: cat.id, subtree: true })}
          >
            {cat.name}
          </button>
          <span className="badge">{cat.total_count ?? 0}</span>
        </div>
        {open && kids.length > 0 && (
          <div className="tree">{kids.map((k) => renderCat(k, depth + 1))}</div>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="side-head">
        {!collapsed && <span className="faint" style={{ fontSize: 'var(--fs-xs)', letterSpacing: '.8px' }}>导航</span>}
        <button
          type="button"
          className="icon-btn"
          onClick={onToggle}
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1.7" y="2.7" width="12.6" height="10.6" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d={collapsed ? 'M6.3 2.7v10.6' : 'M6.3 2.7v10.6M9.3 6 11.3 8l-2 2'} stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div className="side-group">工作对象</div>

      {/* 全部类型：跨类型视图的入口，放在类型列表最前 */}
      <button
        type="button"
        className={cls('nav-item', allTypesActive && 'nav-item-active')}
        title={totalCount > 0 ? `全部类型 · ${totalCount}` : '全部类型'}
        onClick={() => go({ kind: 'type' })}
      >
        <span className="nav-glyph">全</span>
        <span className="nav-label truncate">全部类型</span>
        {totalCount > 0 && <span className="badge">{totalCount}</span>}
      </button>

      {sortedTypes.map((t) => {
        const isCurrent = nav.kind === 'type' && nav.typeId === t.id
        const active = isCurrent && !nav.categoryId && !nav.uncategorized
        const uncatActive = isCurrent && !!nav.uncategorized
        return (
          <div key={t.id}>
            <button
              type="button"
              className={cls('nav-item', active && 'nav-item-active')}
              title={`${t.plural}${byType[t.id] ? ` · ${byType[t.id]}` : ''}`}
              onClick={() => go({ kind: 'type', typeId: t.id })}
            >
              <span className="nav-glyph" style={t.color ? { color: t.color } : undefined}>{glyphOf(t.plural || t.name)}</span>
              <span className="nav-label truncate">{t.plural || t.name}</span>
              {(byType[t.id] ?? 0) > 0 && <span className="badge">{byType[t.id]}</span>}
            </button>

            {/* 当前类型下展开它的分类树：分类是工作对象的主索引，跟着类型走 */}
            {isCurrent && !collapsed && (
              <div className="tree">
                {categories.map((c) => renderCat(c, 0))}

                {/* 未分类是一个真作用域（uncategorized），不是「该类型全部」 */}
                <div className={cls('tree-node', uncatActive && 'tree-node-active')}>
                  {/* 结构要和 renderCat 的顶层行逐个对齐：缩进位 + 折叠位 + 色点位。
                      少一个 flex 子元素就少一个 gap，文字会左出，看起来像层级错了。 */}
                  <span className="tree-indent" style={{ width: 0 }} />
                  <span className="tree-toggle" aria-hidden="true" style={{ visibility: 'hidden' }} />
                  <span className="cat-dot" aria-hidden="true" style={{ visibility: 'hidden' }} />
                  <button
                    type="button"
                    className="tree-label truncate"
                    title="只看未归类到任何分类的对象"
                    onClick={() => go({ kind: 'type', typeId: t.id, uncategorized: true })}
                  >
                    未分类
                  </button>
                  {/* 和分类行不同：0 时不显示徽标。分类为空是「这个分类还没东西」，
                      未分类为 0 是「都归好类了」，是个好状态，不必占位。 */}
                  {(uncatByType[t.id] ?? 0) > 0 && <span className="badge">{uncatByType[t.id]}</span>}
                </div>

                {/* 分类维护已经收进设置页，这里只负责跳过去，不再另开一个弹窗 */}
                <button
                  type="button"
                  className="side-manage"
                  onClick={() => go({ kind: 'page', page: 'settings', section: 'categories' })}
                >
                  管理分类
                </button>
              </div>
            )}
          </div>
        )
      })}

      <div className="side-foot">
        <div className="side-group">模块</div>
        <button
          type="button"
          className={cls('nav-item', nav.kind === 'page' && nav.page === 'shortcuts' && 'nav-item-active')}
          title="快捷访问"
          onClick={() => go({ kind: 'page', page: 'shortcuts' })}
        >
          <span className="nav-glyph">快</span>
          <span className="nav-label truncate">快捷访问</span>
          {shortcuts.length > 0 && <span className="badge">{shortcuts.length}</span>}
        </button>
        <button
          type="button"
          className={cls('nav-item', nav.kind === 'page' && nav.page === 'artifacts' && 'nav-item-active')}
          title="输出产物：本地文件与发到各平台的东西"
          onClick={() => go({ kind: 'page', page: 'artifacts' })}
        >
          <span className="nav-glyph">产</span>
          <span className="nav-label truncate">输出产物</span>
        </button>
        <button type="button" className="nav-item" disabled title="Agent 中心（M4）">
          <span className="nav-glyph">A</span>
          <span className="nav-label truncate">Agent 中心</span>
          <span className="badge">M4</span>
        </button>
        <button
          type="button"
          className={cls('nav-item', nav.kind === 'page' && nav.page === 'settings' && 'nav-item-active')}
          title="设置：枚举值与配置"
          onClick={() => go({ kind: 'page', page: 'settings' })}
        >
          <span className="nav-glyph">设</span>
          <span className="nav-label truncate">设置</span>
        </button>
      </div>
    </>
  )
}
