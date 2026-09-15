// 工作对象类型 + 每个类型的状态集。左列选类型，右侧改它。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspace } from '../../hooks/workspace'
import { api } from '../../lib/api'
import type { ObjectType, Status } from '../../lib/types'
import { Button, ColorDot, ConfirmDialog, Field, TextInput } from '../../components/ui'
import { FrozenField, PRESET_COLORS, SectionHead, Swatches, useAsyncAction } from './common'

interface Draft {
  name: string
  plural: string
  icon: string
  color: string
  sort_order: number
  statuses: Status[]
}

const toDraft = (t: ObjectType): Draft => ({
  name: t.name,
  plural: t.plural,
  icon: t.icon,
  color: t.color || PRESET_COLORS[0],
  sort_order: t.sort_order,
  statuses: t.statuses.map((s) => ({ ...s })),
})

// 新类型至少要有一个状态（后端强约束），给一套能直接用的默认值，建完再来这一页调。
const DEFAULT_STATUSES: Status[] = [
  { key: 'todo', label: '待办', color: '#6c6c78', terminal: false },
  { key: 'doing', label: '进行中', color: '#3b5bdb', terminal: false },
  { key: 'done', label: '已完成', color: '#2b8a3e', terminal: true },
]

export default function TypesSection() {
  const { types, counts, reloadAll } = useWorkspace()
  const { busy, error, setError, run } = useAsyncAction()

  const sorted = useMemo(
    () => [...types].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    [types],
  )

  const [selectedId, setSelectedId] = useState<string>('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<ObjectType | null>(null)

  const current = sorted.find((t) => t.id === selectedId) ?? null

  // 类型列表到位后默认选第一个；选中的类型被删掉时回退
  useEffect(() => {
    if (sorted.length === 0) { setSelectedId(''); return }
    if (!sorted.some((t) => t.id === selectedId)) setSelectedId(sorted[0].id)
  }, [sorted, selectedId])

  useEffect(() => {
    setDraft(current ? toDraft(current) : null)
    setError(null)
  }, [current, setError])

  const dirty = !!current && !!draft && JSON.stringify(draft) !== JSON.stringify(toDraft(current))

  const save = useCallback(async () => {
    if (!current || !draft) return
    // 内置类型只准改 icon/color/sort_order/statuses——身份字段一起发过去会吃 403，
    // 所以这里按 builtin 裁剪补丁，而不是等后端拒绝。
    const patch: Partial<ObjectType> = {
      icon: draft.icon,
      color: draft.color,
      sort_order: draft.sort_order,
      statuses: draft.statuses,
    }
    if (!current.builtin) {
      patch.name = draft.name.trim()
      patch.plural = draft.plural.trim() || draft.name.trim()
    }
    const ok = await run(() => api.updateObjectType(current.id, patch))
    if (ok) await reloadAll()
  }, [current, draft, run, reloadAll])

  return (
    <div className="st-sec">
      <SectionHead
        title="工作对象类型"
        desc="管理需求 / 任务 / 缺陷这类工作对象的类型，以及每个类型自己的状态集。类型 id 与 ref 前缀一经创建不可更改。"
        actions={<Button variant="primary" small onClick={() => { setCreating(true); setError(null) }}>+ 新建类型</Button>}
      />

      {creating ? (
        <CreateTypeForm
          busy={busy}
          onCancel={() => setCreating(false)}
          onSubmit={async (t) => {
            const ok = await run(() => api.createObjectType(t))
            if (ok) { setCreating(false); await reloadAll(); if (t.id) setSelectedId(t.id) }
          }}
        />
      ) : null}

      <div className="st-split">
        <div className="st-list-col">
          {sorted.length === 0 ? <div className="faint st-pad">还没有工作对象类型。</div> : null}
          {sorted.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tree-node st-list-item ${t.id === selectedId ? 'tree-node-active' : ''}`.trim()}
              onClick={() => setSelectedId(t.id)}
            >
              <ColorDot color={t.color} />
              <span className="truncate">{t.plural || t.name}</span>
              {t.builtin ? <span className="tag st-tag-builtin">内置</span> : null}
              <span className="badge">{counts?.by_type?.[t.id] ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="st-edit-col">
          {!draft || !current ? (
            <div className="empty-state"><p>选中左侧一个类型来编辑。</p></div>
          ) : (
            <>
              {error ? <div className="error-banner">{error}</div> : null}

              <div className="st-card">
                <div className="card-title">基本信息</div>
                {current.builtin ? (
                  <p className="faint st-note">
                    这是内置类型，只能改图标、颜色、排序和状态集；名称与前缀被历史编号和界面依赖，不开放修改。
                  </p>
                ) : null}

                <div className="form-row">
                  <FrozenField label="类型 id" value={current.id} why="落在 objects.type_id 里，改了历史数据就找不到类型了" />
                  <FrozenField label="ref 前缀" value={current.ref_prefix} why={`已经发出去的编号形如 ${current.ref_prefix}-12，改了对不上`} />
                </div>

                <div className="form-row">
                  <Field label="名称">
                    <TextInput
                      value={draft.name}
                      disabled={current.builtin}
                      onValueChange={(v) => setDraft({ ...draft, name: v })}
                    />
                  </Field>
                  <Field label="复数名" hint="侧栏与列表标题用这个">
                    <TextInput
                      value={draft.plural}
                      disabled={current.builtin}
                      onValueChange={(v) => setDraft({ ...draft, plural: v })}
                    />
                  </Field>
                </div>

                <div className="form-row">
                  <Field label="图标字符" hint="收起态侧栏显示的单字，留空则取名称首字">
                    <TextInput
                      value={draft.icon}
                      maxLength={2}
                      onValueChange={(v) => setDraft({ ...draft, icon: v })}
                    />
                  </Field>
                  <Field label="排序">
                    <TextInput
                      type="number"
                      value={String(draft.sort_order)}
                      onValueChange={(v) => setDraft({ ...draft, sort_order: Number(v) || 0 })}
                    />
                  </Field>
                </div>

                <Field label="颜色">
                  <Swatches value={draft.color} onChange={(c) => setDraft({ ...draft, color: c })} />
                </Field>
              </div>

              <StatusEditor
                typeId={current.id}
                statuses={draft.statuses}
                onChange={(statuses) => setDraft({ ...draft, statuses })}
              />

              <div className="st-foot-actions">
                <Button
                  variant="danger"
                  disabled={current.builtin || busy}
                  title={current.builtin ? '内置类型不可删除' : '删除该类型'}
                  onClick={() => setDeleting(current)}
                >
                  删除类型
                </Button>
                <div className="v-toolbar-spacer" />
                <span className="faint">{dirty ? '有未保存的改动' : '已是最新'}</span>
                <Button disabled={!dirty || busy} onClick={() => setDraft(toDraft(current))}>重置</Button>
                <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>保存</Button>
              </div>
            </>
          )}
        </div>
      </div>

      {deleting ? (
        <ConfirmDialog
          open
          danger
          title="删除工作对象类型"
          confirmText="删除类型"
          busy={busy}
          error={error}
          onCancel={() => { setDeleting(null); setError(null) }}
          onConfirm={async () => {
            const ok = await run(() => api.deleteObjectType(deleting.id))
            if (ok) { setDeleting(null); await reloadAll() }
          }}
        >
          <p>
            将删除类型「{deleting.plural || deleting.name}」及其全部分类定义。
            该类型下现有 {counts?.by_type?.[deleting.id] ?? 0} 个工作对象。
          </p>
          <p className="muted">下挂对象不为 0 时后端会拒绝删除；请先把对象移走或删除。此操作不可撤销。</p>
        </ConfirmDialog>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------ 状态集编辑 */

function StatusEditor({ typeId, statuses, onChange }: {
  typeId: string
  statuses: Status[]
  onChange: (s: Status[]) => void
}) {
  const [adding, setAdding] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [err, setErr] = useState<string | null>(null)
  // 删除前先数一数有多少对象正处于该状态，数到了再弹确认
  const [pending, setPending] = useState<{ status: Status; count: number } | null>(null)
  const [checking, setChecking] = useState<string | null>(null)

  const patch = (i: number, p: Partial<Status>) =>
    onChange(statuses.map((s, j) => (j === i ? { ...s, ...p } : s)))

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= statuses.length) return
    const next = [...statuses]
    const tmp = next[i]
    next[i] = next[j]
    next[j] = tmp
    onChange(next)
  }

  const askRemove = async (s: Status) => {
    if (statuses.length <= 1) { setErr('至少要保留一个状态'); return }
    setChecking(s.key); setErr(null)
    let count = 0
    try {
      // 状态值落在 objects.status 里，删掉定义后这些对象就成了没有标签没有颜色的裸值
      const r = await api.objects({ type: [typeId], status: [s.key], limit: 1 })
      count = r.total
    } catch {
      count = -1 // 查不到就当未知，确认文案里说明
    } finally {
      setChecking(null)
    }
    setPending({ status: s, count })
  }

  const add = () => {
    const key = newKey.trim()
    if (!key) { setErr('状态 key 必填'); return }
    if (statuses.some((s) => s.key === key)) { setErr(`状态 key「${key}」已存在`); return }
    setErr(null)
    onChange([...statuses, { key, label: newLabel.trim() || key, color: PRESET_COLORS[0], terminal: false }])
    setNewKey(''); setNewLabel(''); setAdding(false)
  }

  return (
    <div className="st-card">
      <div className="card-title">
        状态集
        <span className="faint st-title-note">该类型的工作对象能处在哪些状态；终态表示「不再需要推进」，逾期与停滞统计会跳过它</span>
      </div>

      {err ? <div className="error-banner">{err}</div> : null}

      <div className="st-status-list">
        {statuses.map((s, i) => (
          <div key={s.key} className="st-status-row">
            <span className="mono st-status-key" title="key 落在 objects.status 里，创建后不可改">{s.key}</span>
            <TextInput
              className="st-status-label"
              value={s.label}
              aria-label={`${s.key} 的显示名`}
              onValueChange={(v) => patch(i, { label: v })}
            />
            <Swatches value={s.color} onChange={(c) => patch(i, { color: c })} />
            <label className="v-check st-status-term">
              <input type="checkbox" checked={s.terminal} onChange={(e) => patch(i, { terminal: e.target.checked })} />
              终态
            </label>
            <div className="row-actions st-status-acts">
              <Button small disabled={i === 0} title="上移" onClick={() => move(i, -1)}>↑</Button>
              <Button small disabled={i === statuses.length - 1} title="下移" onClick={() => move(i, 1)}>↓</Button>
              <Button small variant="danger" disabled={checking === s.key} onClick={() => void askRemove(s)}>
                {checking === s.key ? '检查中…' : '删除'}
              </Button>
            </div>
          </div>
        ))}
      </div>

      {adding ? (
        <div className="st-inline-form">
          <Field label="key" hint="落在 objects.status 里，一经创建不可改；用小写英文如 blocked">
            <TextInput autoFocus value={newKey} placeholder="blocked" onValueChange={setNewKey} />
          </Field>
          <Field label="显示名">
            <TextInput value={newLabel} placeholder="受阻" onValueChange={setNewLabel} />
          </Field>
          <div className="st-inline-acts">
            <Button onClick={() => { setAdding(false); setErr(null) }}>取消</Button>
            <Button variant="primary" onClick={add}>添加</Button>
          </div>
        </div>
      ) : (
        <Button small onClick={() => { setAdding(true); setErr(null) }}>+ 新增状态</Button>
      )}

      <p className="faint st-note">状态集的改动和上面的基本信息一起，点「保存」才写入。</p>

      {pending ? (
        <ConfirmDialog
          open
          danger
          title="删除状态"
          confirmText="仍然删除"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            onChange(statuses.filter((s) => s.key !== pending.status.key))
            setPending(null)
          }}
        >
          <p>将从状态集里移除「{pending.status.label || pending.status.key}」（key: {pending.status.key}）。</p>
          {pending.count > 0 ? (
            <p className="muted">
              当前有 <b>{pending.count}</b> 个工作对象正处于该状态。删除后它们的 status 仍是 <span className="mono">{pending.status.key}</span>，
              但列表里会显示成没有颜色、没有名字的裸值，且无法再被筛选。建议先把这些对象改到别的状态。
            </p>
          ) : pending.count === 0 ? (
            <p className="faint">当前没有工作对象处于该状态，可以放心删除。</p>
          ) : (
            <p className="muted">没能查到有多少对象正处于该状态（接口不可用），请自行确认。</p>
          )}
        </ConfirmDialog>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------ 新建类型 */

function CreateTypeForm({ busy, onCancel, onSubmit }: {
  busy: boolean
  onCancel: () => void
  onSubmit: (t: Partial<ObjectType>) => void
}) {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [plural, setPlural] = useState('')
  const [prefix, setPrefix] = useState('')
  const [color, setColor] = useState(PRESET_COLORS[0])
  const [err, setErr] = useState<string | null>(null)

  const submit = () => {
    const tid = id.trim().toLowerCase()
    if (!/^[a-z0-9_-]{2,32}$/.test(tid)) { setErr('id 需为 2-32 位小写字母、数字、- 或 _'); return }
    if (!name.trim()) { setErr('名称必填'); return }
    if (!prefix.trim()) { setErr('ref 前缀必填'); return }
    setErr(null)
    onSubmit({
      id: tid,
      name: name.trim(),
      plural: plural.trim() || name.trim(),
      ref_prefix: prefix.trim().toUpperCase(),
      color,
      sort_order: 100,
      statuses: DEFAULT_STATUSES.map((s) => ({ ...s })),
    })
  }

  return (
    <div className="st-card st-create">
      <div className="card-title">新建工作对象类型</div>
      {err ? <div className="error-banner">{err}</div> : null}
      <div className="form-row">
        <Field label="类型 id" hint="小写英文，创建后不可改">
          <TextInput autoFocus value={id} placeholder="decision" onValueChange={setId} />
        </Field>
        <Field label="ref 前缀" hint="编号前缀，如 DEC-1；创建后不可改">
          <TextInput value={prefix} placeholder="DEC" onValueChange={setPrefix} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="名称">
          <TextInput value={name} placeholder="决策" onValueChange={setName} />
        </Field>
        <Field label="复数名（可选）">
          <TextInput value={plural} placeholder="决策记录" onValueChange={setPlural} />
        </Field>
      </div>
      <Field label="颜色">
        <Swatches value={color} onChange={setColor} />
      </Field>
      <p className="faint st-note">
        会先带上「待办 / 进行中 / 已完成」三个默认状态（后端要求至少一个状态），建好后可在状态集里改。
      </p>
      <div className="st-inline-acts">
        <Button onClick={onCancel} disabled={busy}>取消</Button>
        <Button variant="primary" onClick={submit} disabled={busy}>创建</Button>
      </div>
    </div>
  )
}
