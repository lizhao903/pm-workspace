// 工作对象分类管理器：左侧切类型，右侧管该类型的分类树（增 / 改 / 移 / 删）。
import { useCallback, useEffect, useState } from 'react'
import { useWorkspace } from '../hooks/workspace'
import { api } from '../lib/api'
import type { Category } from '../lib/types'
import {
  Button, CategoryPicker, ColorDot, ConfirmDialog, Field, Modal, Popover,
  TextArea, TextInput, collectSubtreeIds, findCategory, invalidateCategoryTrees,
} from './ui'
import '../views.css'

// 预设分类色。这些是写进后端 categories.color 的**数据**，不是主题 token，所以只能是字面量。
const PRESET_COLORS = ['#3b5bdb', '#2b8a3e', '#b35309', '#c92a2a', '#7048e8', '#0c8599', '#e8590c', '#5c7cfa']

interface Draft {
  name: string
  slug: string
  color: string
  description: string
}

const emptyDraft = (): Draft => ({ name: '', slug: '', color: PRESET_COLORS[0], description: '' })

export default function CategoryManager() {
  const { categoryManagerOpen, setCategoryManagerOpen } = useWorkspace()
  if (!categoryManagerOpen) return null
  return <Manager onClose={() => setCategoryManagerOpen(false)} />
}

/**
 * 嵌入模式：不渲染 .modal 外壳，内容直接铺开，供设置页的「分类」二级页用。
 * 两处共用同一个 Manager，逻辑不会分叉——快捷入口的 open:category-manager 还在用弹窗那条路。
 */
export function CategoryManagerPanel() {
  return <Manager embedded />
}

function Manager({ onClose, embedded }: { onClose?: () => void; embedded?: boolean }) {
  const { types, nav, reloadCategories, reloadCounts } = useWorkspace()

  const [typeId, setTypeId] = useState<string>(() => nav.typeId ?? types[0]?.id ?? '')
  const [tree, setTree] = useState<Category[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [addingUnder, setAddingUnder] = useState<string | null | undefined>(undefined) // undefined=不在新增
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Category | null>(null)

  // 类型列表到位但当前 typeId 为空时兜底选第一个
  useEffect(() => {
    if (!typeId && types.length > 0) setTypeId(types[0].id)
  }, [typeId, types])

  const load = useCallback(async (tid: string) => {
    if (!tid) { setTree([]); return }
    setLoading(true)
    try {
      setTree(await api.categories(tid, { tree: true, counts: true }))
      setError(null)
    } catch (e) {
      setTree([])
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(typeId) }, [typeId, load])

  /** 所有写操作统一走这里：错误落 error-banner，成功后刷新本地树并同步侧栏。 */
  const run = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true); setError(null)
    try {
      await fn()
      invalidateCategoryTrees()
      await load(typeId)
      await Promise.all([reloadCategories(), reloadCounts()])
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }, [load, typeId, reloadCategories, reloadCounts])

  const toggle = (id: string) => setCollapsed((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const create = async (parentId: string | null, d: Draft) => {
    const ok = await run(() => api.createCategory({
      type_id: typeId,
      parent_id: parentId,
      name: d.name.trim(),
      slug: d.slug.trim() || undefined,
      color: d.color || undefined,
      description: d.description.trim() || undefined,
    }))
    if (ok) setAddingUnder(undefined)
  }

  const update = async (id: string, d: Draft) => {
    const ok = await run(() => api.updateCategory(id, {
      name: d.name.trim(),
      slug: d.slug.trim() || undefined,
      color: d.color,
      description: d.description.trim(),
    }))
    if (ok) setEditingId(null)
  }

  /** 同级上下移：换成邻居的 sort_order；若同级 sort_order 未被初始化（全相同）则退回用目标下标。 */
  const shift = (node: Category, siblings: Category[], dir: -1 | 1) => {
    const i = siblings.findIndex((s) => s.id === node.id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= siblings.length) return
    const peer = siblings[j]
    const order = peer.sort_order !== node.sort_order ? peer.sort_order : j
    void run(() => api.moveCategory(node.id, node.parent_id, order))
  }

  /** 改挂到新父分类（null=根）；追加到目标末尾。 */
  const reparent = (node: Category, parentId: string | null) => {
    const siblings = parentId ? findCategory(tree, parentId)?.children ?? [] : tree
    void run(() => api.moveCategory(node.id, parentId, siblings.length))
  }

  const renderNodes = (nodes: Category[], depth: number) => nodes.map((cat, idx) => {
    const kids = cat.children ?? []
    const isCollapsed = collapsed.has(cat.id)
    const excluded = collectSubtreeIds(cat)
    return (
      <div key={cat.id}>
        <div className={`tree-node v-cm-node ${editingId === cat.id ? 'tree-node-active' : ''}`.trim()}>
          <span className="tree-indent" style={{ width: depth * 14 }} />
          {kids.length > 0 ? (
            <button type="button" className="tree-toggle" aria-label={isCollapsed ? '展开' : '收起'} onClick={() => toggle(cat.id)}>
              <span className={`v-caret ${isCollapsed ? 'v-caret-closed' : ''}`.trim()} aria-hidden="true" />
            </button>
          ) : <span className="tree-toggle" />}

          <ColorDot color={cat.color} />
          <span className="v-cm-name truncate">{cat.name}</span>
          <span className="faint mono v-cm-slug truncate">{cat.slug}</span>
          <span className="badge" title={`本级 ${cat.count} · 含子级 ${cat.total_count}`}>{cat.total_count}</span>

          <div className="row-actions v-cm-actions">
            <Button small onClick={() => { setEditingId(null); setAddingUnder(cat.id) }} title="新增子分类">+ 子分类</Button>
            <Button small onClick={() => { setAddingUnder(undefined); setEditingId(editingId === cat.id ? null : cat.id) }}>编辑</Button>
            <Button small disabled={idx === 0 || busy} title="上移" onClick={() => shift(cat, nodes, -1)}>↑</Button>
            <Button small disabled={idx === nodes.length - 1 || busy} title="下移" onClick={() => shift(cat, nodes, 1)}>↓</Button>
            <Popover trigger="改挂到" align="right" width={230}>
              {(close) => (
                <div className="v-pop-pad">
                  <div className="faint v-pop-title">把「{cat.name}」挂到</div>
                  <CategoryPicker
                    categories={tree}
                    value={cat.parent_id}
                    emptyLabel="根目录（顶级分类）"
                    excludeIds={excluded}
                    onChange={(id) => { close(); reparent(cat, id) }}
                  />
                </div>
              )}
            </Popover>
            <Button small variant="danger" onClick={() => setDeleting(cat)}>删除</Button>
          </div>
        </div>

        {cat.description ? <div className="faint v-cm-desc" style={{ paddingLeft: depth * 14 + 34 }}>{cat.description}</div> : null}

        {editingId === cat.id ? (
          <CategoryForm
            title="编辑分类"
            depth={depth}
            busy={busy}
            initial={{ name: cat.name, slug: cat.slug, color: cat.color || PRESET_COLORS[0], description: cat.description }}
            onCancel={() => setEditingId(null)}
            onSubmit={(d) => void update(cat.id, d)}
          />
        ) : null}

        {addingUnder === cat.id ? (
          <CategoryForm
            title={`在「${cat.name}」下新增子分类`}
            depth={depth + 1}
            busy={busy}
            initial={emptyDraft()}
            onCancel={() => setAddingUnder(undefined)}
            onSubmit={(d) => void create(cat.id, d)}
          />
        ) : null}

        {kids.length > 0 && !isCollapsed ? renderNodes(kids, depth + 1) : null}
      </div>
    )
  })

  const body = (
    <>
      <div className="v-cm">
        <div className="v-cm-side">
          <div className="faint v-cm-side-title">工作对象类型</div>
          {types.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tree-node v-cm-type ${t.id === typeId ? 'tree-node-active' : ''}`.trim()}
              onClick={() => { setTypeId(t.id); setEditingId(null); setAddingUnder(undefined) }}
            >
              <ColorDot color={t.color} />
              <span className="truncate">{t.plural || t.name}</span>
            </button>
          ))}
        </div>

        <div className="v-cm-main">
          <div className="v-cm-head">
            <span className="muted">
              {types.find((t) => t.id === typeId)?.name ?? '—'} · 共 {countNodes(tree)} 个分类
            </span>
            <div className="v-toolbar-spacer" />
            <Button
              variant="primary"
              small
              disabled={!typeId || busy}
              onClick={() => { setEditingId(null); setAddingUnder(null) }}
            >
              + 新增顶级分类
            </Button>
          </div>

          {error ? <div className="error-banner">{error}</div> : null}
          {busy ? <div className="loading-bar" /> : null}

          <div className="tree v-cm-tree">
            {addingUnder === null ? (
              <CategoryForm
                title="新增顶级分类"
                depth={0}
                busy={busy}
                initial={emptyDraft()}
                onCancel={() => setAddingUnder(undefined)}
                onSubmit={(d) => void create(null, d)}
              />
            ) : null}

            {loading ? <div className="skeleton v-sk v-sk-title" /> : null}
            {!loading && tree.length === 0 && addingUnder === undefined ? (
              <div className="empty-state">
                <p>该类型还没有分类，先建一个顶级分类吧。</p>
                <Button variant="primary" onClick={() => setAddingUnder(null)}>新增顶级分类</Button>
              </div>
            ) : null}

            {renderNodes(tree, 0)}
          </div>
        </div>
      </div>

      {deleting ? (
        <DeleteCategoryDialog
          category={deleting}
          tree={tree}
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={async (reassignTo) => {
            const ok = await run(() => api.deleteCategory(deleting.id, reassignTo ?? undefined))
            if (ok) setDeleting(null)
          }}
        />
      ) : null}
    </>
  )

  if (embedded) return body
  return (
    <Modal open title="工作对象分类管理" size="lg" onClose={() => onClose?.()}>
      {body}
    </Modal>
  )
}

function countNodes(nodes: Category[]): number {
  return nodes.reduce((n, c) => n + 1 + countNodes(c.children ?? []), 0)
}

/* ------------------------------------------------------------ 行内表单 */

interface FormProps {
  title: string
  depth: number
  busy: boolean
  initial: Draft
  onCancel: () => void
  onSubmit: (d: Draft) => void
}

function CategoryForm({ title, depth, busy, initial, onCancel, onSubmit }: FormProps) {
  const [d, setD] = useState<Draft>(initial)
  const [err, setErr] = useState<string | null>(null)

  const submit = () => {
    if (!d.name.trim()) { setErr('分类名称必填'); return }
    setErr(null)
    onSubmit(d)
  }

  return (
    <div className="v-cm-form" style={{ marginLeft: depth * 14 }}>
      <div className="card-title">{title}</div>
      <div className="form-row">
        <Field label="名称" error={err}>
          <TextInput
            autoFocus
            value={d.name}
            placeholder="如：云端平台"
            onValueChange={(v) => setD({ ...d, name: v })}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
          />
        </Field>
        <Field label="slug（可选）" hint="留空由名称生成">
          <TextInput value={d.slug} placeholder="cloud-platform" onValueChange={(v) => setD({ ...d, slug: v })} />
        </Field>
      </div>

      <Field label="颜色">
        <div className="v-swatches">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`v-swatch ${d.color === c ? 'v-swatch-on' : ''}`.trim()}
              style={{ background: c }}
              aria-label={`选择颜色 ${c}`}
              onClick={() => setD({ ...d, color: c })}
            />
          ))}
        </div>
      </Field>

      <Field label="描述（可选）">
        <TextArea rows={2} value={d.description} onValueChange={(v) => setD({ ...d, description: v })} />
      </Field>

      <div className="v-cm-form-actions">
        <Button onClick={onCancel} disabled={busy}>取消</Button>
        <Button variant="primary" onClick={submit} disabled={busy}>保存</Button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ 删除确认 */

function DeleteCategoryDialog({
  category, tree, busy, onCancel, onConfirm,
}: {
  category: Category
  tree: Category[]
  busy: boolean
  onCancel: () => void
  onConfirm: (reassignTo: string | null) => void
}) {
  const [mode, setMode] = useState<'clear' | 'reassign'>('clear')
  const [reassignTo, setReassignTo] = useState<string | null>(null)
  const excluded = collectSubtreeIds(category)
  const hasObjects = category.total_count > 0

  return (
    <ConfirmDialog
      open
      title="删除分类"
      confirmText="删除"
      danger
      busy={busy}
      confirmDisabled={hasObjects && mode === 'reassign' && !reassignTo}
      onCancel={onCancel}
      onConfirm={() => onConfirm(hasObjects && mode === 'reassign' ? reassignTo : null)}
    >
      <p>将删除分类「{category.name}」。</p>
      {hasObjects ? (
        <>
          <p className="muted">该分类下有 {category.total_count} 个工作对象，需要指定去向：</p>
          <label className="v-check">
            <input type="radio" checked={mode === 'clear'} onChange={() => setMode('clear')} />
            置为未分类
          </label>
          <label className="v-check">
            <input type="radio" checked={mode === 'reassign'} onChange={() => setMode('reassign')} />
            改挂到其他分类
          </label>
          {mode === 'reassign' ? (
            <CategoryPicker
              categories={tree}
              value={reassignTo}
              emptyLabel="请选择目标分类"
              excludeIds={excluded}
              onChange={setReassignTo}
            />
          ) : null}
        </>
      ) : (
        <p className="faint">该分类下没有工作对象。</p>
      )}
    </ConfirmDialog>
  )
}
