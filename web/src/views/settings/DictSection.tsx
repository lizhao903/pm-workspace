// 通用字典编辑器。优先级、关联关系共用这一个组件，靠 dictId 区分。
// 核心约束：key 一经创建不可改（它落在业务表里），有引用的条目只能停用不能删。
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { DictItem } from '../../lib/types'
import { Button, ColorDot, ConfirmDialog, Field, TextArea, TextInput } from '../../components/ui'
import { PRESET_COLORS, SectionHead, Swatches, UsageBadge, errText, useAsyncAction } from './common'

export interface DictSectionProps {
  dictId: string
  title: string
  desc: string
  /** 引用计数的量词，如「个工作对象」「条关联」 */
  usageNoun: string
  /** key 的示例，放在新建表单的 placeholder 里 */
  keyExample: string
  labelExample: string
}

export default function DictSection({ dictId, title, desc, usageNoun, keyExample, labelExample }: DictSectionProps) {
  const { busy, error, setError, run } = useAsyncAction()

  const [items, setItems] = useState<DictItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showArchived, setShowArchived] = useState(false)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<{ item: DictItem; usage: number } | null>(null)
  const [checking, setChecking] = useState<string | null>(null)

  // 一次性把停用的也拉回来，切「显示已停用」时在前端过滤，不再打一次接口
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await api.dictItems(dictId, { includeArchived: true })
      setItems([...list].sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key)))
    } catch {
      setItems([]) // 接口还没上线时按空态处理，不弹横幅
    } finally {
      setLoading(false)
    }
  }, [dictId])

  useEffect(() => {
    setCreating(false); setEditingId(null); setError(null)
    void load()
  }, [load, setError])

  const visible = showArchived ? items : items.filter((i) => !i.archived_at)
  const archivedCount = items.filter((i) => i.archived_at).length

  /** 上下移：后端要全量有序 id，所以这里在完整列表上换位再整体提交。 */
  const move = async (item: DictItem, dir: -1 | 1) => {
    const i = items.findIndex((x) => x.id === item.id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= items.length) return
    const next = [...items]
    const tmp = next[i]
    next[i] = next[j]
    next[j] = tmp
    setItems(next) // 乐观：顺序先动，失败时下面的 load() 会把真实顺序拉回来
    await run(() => api.reorderDictItems(dictId, null, next.map((x) => x.id)))
    await load()
  }

  const askDelete = async (item: DictItem) => {
    setChecking(item.id); setError(null)
    let usage = item.usage
    try {
      usage = (await api.dictItemUsage(item.id)).usage
    } catch (e) {
      setError(errText(e))
    } finally {
      setChecking(null)
    }
    setDeleting({ item, usage })
  }

  return (
    <div className="st-sec">
      <SectionHead
        title={title}
        desc={desc}
        actions={<Button variant="primary" small onClick={() => { setCreating(true); setError(null) }}>+ 新建条目</Button>}
      />

      {error ? <div className="error-banner">{error}</div> : null}

      {creating ? (
        <div className="st-card">
          <div className="card-title">新建条目</div>
          <DictItemForm
            mode="create"
            busy={busy}
            keyExample={keyExample}
            labelExample={labelExample}
            existingKeys={items.map((i) => i.key)}
            onCancel={() => setCreating(false)}
            onSubmit={async (d) => {
              const ok = await run(() => api.createDictItem(dictId, {
                key: d.key,
                label: d.label,
                color: d.color,
                description: d.description,
                sort_order: items.length,
              }))
              if (ok) { setCreating(false); await load() }
            }}
          />
        </div>
      ) : null}

      <div className="st-toolbar">
        <label className="v-check">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          显示已停用{archivedCount > 0 ? `（${archivedCount}）` : ''}
        </label>
        <div className="v-toolbar-spacer" />
        <span className="faint">共 {items.length} 个条目</span>
      </div>

      {loading ? <div className="skeleton v-sk v-sk-title" /> : null}
      {!loading && items.length === 0 ? (
        <div className="empty-state"><p>这个字典还没有条目，新建一个吧。</p></div>
      ) : null}

      <div className="st-rows">
        {visible.map((it, idx) => (
          <div key={it.id} className={`st-row ${it.archived_at ? 'st-row-off' : ''}`.trim()}>
            {editingId === it.id ? (
              <DictItemForm
                mode="edit"
                busy={busy}
                initial={it}
                keyExample={keyExample}
                labelExample={labelExample}
                existingKeys={items.map((i) => i.key)}
                onCancel={() => { setEditingId(null); setError(null) }}
                onSubmit={async (d) => {
                  const ok = await run(() => api.updateDictItem(it.id, {
                    label: d.label,
                    color: d.color,
                    description: d.description,
                  }))
                  if (ok) { setEditingId(null); await load() }
                }}
              />
            ) : (
              <>
                <ColorDot color={it.color} />
                <span className="mono st-row-key" title="key 落在业务数据里，一经创建不可改">{it.key}</span>
                <span className="st-row-name truncate">{it.label}</span>
                {it.description ? <span className="faint truncate st-row-desc">{it.description}</span> : null}
                {it.archived_at ? <span className="tag st-tag-off">已停用</span> : null}
                <UsageBadge n={it.usage} noun={usageNoun} />
                <div className="row-actions st-row-acts">
                  <Button small onClick={() => { setEditingId(it.id); setError(null) }}>编辑</Button>
                  <Button small disabled={idx === 0 || busy} title="上移" onClick={() => void move(it, -1)}>↑</Button>
                  <Button small disabled={idx === visible.length - 1 || busy} title="下移" onClick={() => void move(it, 1)}>↓</Button>
                  <Button
                    small
                    disabled={busy}
                    title={it.archived_at ? '启用后会重新出现在下拉里' : '停用后已有数据照常显示，但新建时不再出现在下拉里'}
                    onClick={() => void run(async () => { await api.archiveDictItem(it.id, !it.archived_at); await load() })}
                  >
                    {it.archived_at ? '启用' : '停用'}
                  </Button>
                  <Button
                    small
                    variant="danger"
                    disabled={it.usage > 0 || busy || checking === it.id}
                    title={it.usage > 0 ? `被 ${it.usage} ${usageNoun}引用，只能停用` : '删除该条目'}
                    onClick={() => void askDelete(it)}
                  >
                    {checking === it.id ? '检查中…' : '删除'}
                  </Button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {!loading && items.length > 0 && visible.length === 0 ? (
        <div className="faint st-pad">条目都被停用了，勾上「显示已停用」来查看。</div>
      ) : null}

      <p className="faint st-note">
        已被数据引用的条目不能删除，只能停用——删掉会在列表里留下没有名字没有颜色的裸值，而且没人知道它从哪来。
      </p>

      {deleting ? (
        <ConfirmDialog
          open
          danger
          title="删除字典条目"
          confirmText="删除"
          busy={busy}
          error={error}
          confirmDisabled={deleting.usage > 0}
          onCancel={() => { setDeleting(null); setError(null) }}
          onConfirm={async () => {
            const ok = await run(() => api.deleteDictItem(deleting.item.id))
            if (ok) { setDeleting(null); await load() }
          }}
        >
          <p>将删除条目「{deleting.item.label}」（key: <span className="mono">{deleting.item.key}</span>）。</p>
          {deleting.usage > 0 ? (
            <p className="muted">
              它被 <b>{deleting.usage}</b> {usageNoun}引用，不能删除。请改用「停用」：已有数据照常显示，新建时不再出现在下拉里。
            </p>
          ) : (
            <p className="faint">没有数据引用它，删除是安全的。此操作不可撤销。</p>
          )}
        </ConfirmDialog>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------ 条目表单 */

interface Draft {
  key: string
  label: string
  color: string
  description: string
}

function DictItemForm({ mode, busy, initial, keyExample, labelExample, existingKeys, onCancel, onSubmit }: {
  mode: 'create' | 'edit'
  busy: boolean
  initial?: DictItem
  keyExample: string
  labelExample: string
  existingKeys: string[]
  onCancel: () => void
  onSubmit: (d: Draft) => void
}) {
  const [d, setD] = useState<Draft>({
    key: initial?.key ?? '',
    label: initial?.label ?? '',
    color: initial?.color || PRESET_COLORS[0],
    description: initial?.description ?? '',
  })
  const [err, setErr] = useState<string | null>(null)

  const submit = () => {
    if (mode === 'create') {
      const k = d.key.trim()
      if (!k) { setErr('key 必填'); return }
      if (existingKeys.includes(k)) { setErr(`key「${k}」已存在`); return }
    }
    if (!d.label.trim()) { setErr('显示名必填'); return }
    setErr(null)
    onSubmit({ ...d, key: d.key.trim(), label: d.label.trim(), description: d.description.trim() })
  }

  return (
    <div className="st-inline-form st-inline-grow">
      <div className="form-row">
        {mode === 'create' ? (
          <Field label="key" hint="落在业务数据里，一经创建不可改">
            <TextInput autoFocus value={d.key} placeholder={keyExample} onValueChange={(v) => setD({ ...d, key: v })} />
          </Field>
        ) : (
          <div className="field">
            <span className="field-label">key</span>
            <div className="st-frozen mono">{d.key}</div>
            <div className="faint v-field-hint">已经落在业务数据里，不可更改</div>
          </div>
        )}
        <Field label="显示名" error={err}>
          <TextInput
            autoFocus={mode === 'edit'}
            value={d.label}
            placeholder={labelExample}
            onValueChange={(v) => setD({ ...d, label: v })}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
          />
        </Field>
      </div>

      <Field label="颜色">
        <Swatches value={d.color} onChange={(c) => setD({ ...d, color: c })} />
      </Field>

      <Field label="说明（可选）">
        <TextArea rows={2} value={d.description} onValueChange={(v) => setD({ ...d, description: v })} />
      </Field>

      <div className="st-inline-acts">
        <Button onClick={onCancel} disabled={busy}>取消</Button>
        <Button variant="primary" onClick={submit} disabled={busy}>保存</Button>
      </div>
    </div>
  )
}
