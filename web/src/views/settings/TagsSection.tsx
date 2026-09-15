// 标签维护：重命名、改色、合并、删除。标签是跨类型的交叉维度，和分类树正交。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspace } from '../../hooks/workspace'
import { api } from '../../lib/api'
import type { Tag } from '../../lib/types'
import {
  Button, ColorDot, ConfirmDialog, Field, RelativeTime, Select, TextInput,
} from '../../components/ui'
import { PRESET_COLORS, SectionHead, Swatches, UsageBadge, useAsyncAction } from './common'

export default function TagsSection() {
  const { reloadAll } = useWorkspace()
  const { busy, error, setError, run } = useAsyncAction()

  const [tags, setTags] = useState<Tag[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [merging, setMerging] = useState<Tag | null>(null)
  const [deleting, setDeleting] = useState<Tag | null>(null)
  const [q, setQ] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try { setTags(await api.tags()) } catch { setTags([]) } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const after = useCallback(async () => {
    await load()
    await reloadAll() // 顶栏筛选器和抽屉的标签下拉都读 workspace 里的这份
  }, [load, reloadAll])

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    const list = kw ? tags.filter((t) => t.name.toLowerCase().includes(kw)) : tags
    // 按引用数排序：用得最多的排前面，零引用的通常是打错的，单独一组
    return [...list].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }, [tags, q])

  const used = filtered.filter((t) => t.count > 0)
  const orphan = filtered.filter((t) => t.count === 0)

  const row = (t: Tag) => (
    <div key={t.id} className="st-row">
      {editingId === t.id ? (
        <TagEditForm
          tag={t}
          busy={busy}
          onCancel={() => { setEditingId(null); setError(null) }}
          onSubmit={async (name, color) => {
            const ok = await run(() => api.updateTag(t.id, { name, color }))
            if (ok) { setEditingId(null); await after() }
          }}
        />
      ) : (
        <>
          <ColorDot color={t.color} />
          <span className="st-row-name truncate">#{t.name}</span>
          <UsageBadge n={t.count} noun="个工作对象" />
          <span className="faint st-row-time"><RelativeTime value={t.created_at} /></span>
          <div className="row-actions st-row-acts">
            <Button small onClick={() => { setEditingId(t.id); setError(null) }}>重命名 / 改色</Button>
            <Button small disabled={tags.length < 2} onClick={() => { setMerging(t); setError(null) }}>合并到…</Button>
            <Button small variant="danger" onClick={() => { setDeleting(t); setError(null) }}>删除</Button>
          </div>
        </>
      )}
    </div>
  )

  return (
    <div className="st-sec">
      <SectionHead
        title="标签"
        desc="标签是跨类型的交叉维度，通常在对象详情里随手打上，久了容易出现同义词。这一页负责收敛：重命名、改色、合并、删除。"
        actions={<Button variant="primary" small onClick={() => { setCreating(true); setError(null) }}>+ 新建标签</Button>}
      />

      {error ? <div className="error-banner">{error}</div> : null}

      {creating ? (
        <div className="st-card">
          <div className="card-title">新建标签</div>
          <TagEditForm
            busy={busy}
            onCancel={() => setCreating(false)}
            onSubmit={async (name, color) => {
              const ok = await run(() => api.createTag(name, color))
              if (ok) { setCreating(false); await after() }
            }}
          />
        </div>
      ) : null}

      <div className="st-toolbar">
        <TextInput
          className="st-search"
          value={q}
          placeholder="搜索标签…"
          aria-label="搜索标签"
          onValueChange={setQ}
        />
        <span className="faint">共 {tags.length} 个标签</span>
      </div>

      {loading ? <div className="skeleton v-sk v-sk-title" /> : null}
      {!loading && tags.length === 0 ? (
        <div className="empty-state"><p>还没有标签。在工作对象详情里打标签，或者在这里先建一个。</p></div>
      ) : null}

      {used.length > 0 ? (
        <>
          <div className="st-group-title">使用中（{used.length}）</div>
          <div className="st-rows">{used.map(row)}</div>
        </>
      ) : null}

      {orphan.length > 0 ? (
        <>
          <div className="st-group-title">
            未被引用（{orphan.length}）
            <span className="faint st-title-note">没有任何工作对象在用，多半是打错或已经合并过的残留，删了不会影响数据</span>
          </div>
          <div className="st-rows">{orphan.map(row)}</div>
        </>
      ) : null}

      {merging ? (
        <MergeDialog
          source={merging}
          tags={tags}
          busy={busy}
          error={error}
          onCancel={() => { setMerging(null); setError(null) }}
          onConfirm={async (targetId) => {
            const ok = await run(() => api.mergeTags(merging.id, targetId))
            if (ok) { setMerging(null); await after() }
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          open
          danger
          title="删除标签"
          confirmText="删除标签"
          busy={busy}
          error={error}
          onCancel={() => { setDeleting(null); setError(null) }}
          onConfirm={async () => {
            const ok = await run(() => api.deleteTag(deleting.id))
            if (ok) { setDeleting(null); await after() }
          }}
        >
          <p>将删除标签「#{deleting.name}」。</p>
          {deleting.count > 0 ? (
            <p className="muted">
              当前有 <b>{deleting.count}</b> 个工作对象打着这个标签，删除后这些对象会失去该标签，且无法撤销。
              如果只是想换个名字，用「重命名」；如果是同义标签，用「合并到…」把引用保留下来。
            </p>
          ) : (
            <p className="faint">没有工作对象在用这个标签，删除不影响任何数据。</p>
          )}
        </ConfirmDialog>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------ 行内编辑 */

function TagEditForm({ tag, busy, onCancel, onSubmit }: {
  tag?: Tag
  busy: boolean
  onCancel: () => void
  onSubmit: (name: string, color: string) => void
}) {
  const [name, setName] = useState(tag?.name ?? '')
  const [color, setColor] = useState(tag?.color || PRESET_COLORS[0])
  const [err, setErr] = useState<string | null>(null)

  const submit = () => {
    if (!name.trim()) { setErr('标签名必填'); return }
    setErr(null)
    onSubmit(name.trim(), color)
  }

  return (
    <div className="st-inline-form st-inline-grow">
      <Field label="名称" error={err}>
        <TextInput
          autoFocus
          value={name}
          placeholder="如：云端"
          onValueChange={setName}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
        />
      </Field>
      <Field label="颜色">
        <Swatches value={color} onChange={setColor} />
      </Field>
      <div className="st-inline-acts">
        <Button onClick={onCancel} disabled={busy}>取消</Button>
        <Button variant="primary" onClick={submit} disabled={busy}>保存</Button>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- 合并 */

function MergeDialog({ source, tags, busy, error, onCancel, onConfirm }: {
  source: Tag
  tags: Tag[]
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (targetId: string) => void
}) {
  const [targetId, setTargetId] = useState('')
  const target = tags.find((t) => t.id === targetId) ?? null
  const options = tags
    .filter((t) => t.id !== source.id)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  return (
    <ConfirmDialog
      open
      danger
      title="合并标签"
      confirmText="合并"
      busy={busy}
      error={error}
      confirmDisabled={!targetId}
      onCancel={onCancel}
      onConfirm={() => onConfirm(targetId)}
    >
      <p>把「#{source.name}」合并到：</p>
      <Select
        value={targetId}
        aria-label="合并目标标签"
        onValueChange={setTargetId}
        options={[
          { value: '', label: '请选择目标标签' },
          ...options.map((t) => ({ value: t.id, label: `#${t.name}（${t.count}）` })),
        ]}
      />
      {target ? (
        <p className="muted st-merge-note">
          将把 <b>{source.count}</b> 个工作对象改打「#{target.name}」，然后删除「#{source.name}」。
          已经同时打了两个标签的对象不会重复计数。此操作不可撤销。
        </p>
      ) : (
        <p className="faint st-merge-note">选中目标后这里会说明会影响多少条数据。</p>
      )}
    </ConfirmDialog>
  )
}
