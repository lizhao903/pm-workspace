// 干系人名册：负责人与参与人都指向这里。
//
// 两条硬规矩，界面要把它们讲清楚而不是等后端 409 才说：
//   1. 名字全局唯一——重名保存失败时要告诉用户「已有同名干系人」，而不是「保存失败」；
//   2. 有引用的人不能删——有引用时就不给删除按钮，而不是让用户点了才知道不行。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import type { Stakeholder, StakeholderPatch } from '../../lib/types'
import { invalidateStakeholders, StakeholderAvatar } from '../../components/StakeholderPicker'
import { Button, ConfirmDialog, Field, TextArea, TextInput } from '../../components/ui'
import { PRESET_COLORS, SectionHead, Swatches, errText, useAsyncAction } from './common'

/** 排序键：先按 sort_order，再按名字，保证同 sort_order（如迁移进来的全是 0）时顺序稳定。 */
const bySort = (a: Stakeholder, b: Stakeholder) =>
  a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'zh-Hans-CN')

const refCount = (s: Stakeholder) => s.owned_count + s.participating_count

export default function StakeholdersSection() {
  const { busy, error, setError, run } = useAsyncAction()

  const [items, setItems] = useState<Stakeholder[]>([])
  const [loading, setLoading] = useState(true)
  const [showArchived, setShowArchived] = useState(false)
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Stakeholder | null>(null)

  // 一次性把已归档的也拉回来，切「显示已归档」时在前端过滤，不再打一次接口
  const load = useCallback(async () => {
    setLoading(true)
    try {
      setItems([...(await api.stakeholders(true))].sort(bySort))
    } catch {
      setItems([]) // 接口还没上线时按空态处理，不弹横幅
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /** 名册任何写操作后，抽屉/工具条里的选择器也要跟着变 */
  const reload = useCallback(async () => {
    invalidateStakeholders()
    await load()
  }, [load])

  const archivedCount = items.filter((s) => s.archived_at).length
  const visible = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return items.filter((s) => {
      if (!showArchived && s.archived_at) return false
      if (!kw) return true
      return s.name.toLowerCase().includes(kw)
        || s.role.toLowerCase().includes(kw)
        || s.email.toLowerCase().includes(kw)
    })
  }, [items, showArchived, q])

  /**
   * 上下移。没有 reorder 接口，只能逐个改 sort_order——
   * 整体重排一遍而不是只换两个人的值：迁移进来的数据 sort_order 可能全是 0，
   * 只换两个的话它们仍然并列，顺序由名字决定，看起来像「点了没反应」。
   */
  const move = async (item: Stakeholder, dir: -1 | 1) => {
    const i = visible.findIndex((x) => x.id === item.id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= visible.length) return
    const next = [...visible]
    const tmp = next[i]
    next[i] = next[j]
    next[j] = tmp
    // 被过滤掉的（已归档 / 不匹配搜索）排在后面，它们之间的相对顺序不变
    const shown = new Set(next.map((x) => x.id))
    const full = [...next, ...items.filter((x) => !shown.has(x.id))]
    setItems(full) // 乐观：顺序先动，失败时下面的 reload() 会把真实顺序拉回来
    await run(async () => {
      for (let k = 0; k < full.length; k++) {
        if (full[k].sort_order !== k) await api.updateStakeholder(full[k].id, { sort_order: k })
      }
    })
    await reload()
  }

  return (
    <div className="st-sec">
      <SectionHead
        title="干系人"
        desc="工作对象的负责人与参与人都从这份名册里选。一个对象一个负责人加若干参与人：负责人回答「这事该找谁」，参与人表达「还有谁在这件事里」。人走了用归档而不是删除——他经手过的事还要显示得出名字。"
        actions={<Button variant="primary" small onClick={() => { setCreating(true); setError(null) }}>+ 新建干系人</Button>}
      />

      {error ? <div className="error-banner">{error}</div> : null}

      {creating ? (
        <div className="st-card">
          <div className="card-title">新建干系人</div>
          <StakeholderForm
            busy={busy}
            onCancel={() => { setCreating(false); setError(null) }}
            onSubmit={async (d, fail) => {
              try {
                await api.createStakeholder({ ...d, sort_order: items.length })
                setCreating(false)
                await reload()
              } catch (e) {
                fail(conflictText(e, d.name, 'create'))
              }
            }}
          />
        </div>
      ) : null}

      <div className="st-toolbar">
        <TextInput className="st-search" value={q} placeholder="搜名字 / 角色 / 邮箱…" onValueChange={setQ} />
        <label className="v-check">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          显示已归档{archivedCount > 0 ? `（${archivedCount}）` : ''}
        </label>
        <div className="v-toolbar-spacer" />
        <span className="faint">在岗 {items.length - archivedCount} 人 · 共 {items.length} 人</span>
      </div>

      {loading ? <div className="skeleton v-sk v-sk-title" /> : null}
      {!loading && items.length === 0 ? (
        <div className="empty-state"><p>名册还没有人。新建一个，之后在详情抽屉里就能把他选成负责人。</p></div>
      ) : null}

      <div className="st-rows">
        {visible.map((s, idx) => {
          const refs = refCount(s)
          return (
            <div key={s.id} className={`st-row ${s.archived_at ? 'st-row-off' : ''}`.trim()}>
              {editingId === s.id ? (
                <StakeholderForm
                  busy={busy}
                  initial={s}
                  onCancel={() => { setEditingId(null); setError(null) }}
                  onSubmit={async (d, fail) => {
                    // 只发改动过的字段：PATCH 的语义就是「改这几个」。
                    // 名字没动也照发一遍，等于每次保存都去撞一次唯一性约束，
                    // 白白多一条「改名为自己」的变更记录
                    const patch: StakeholderPatch = {}
                    if (d.name !== s.name) patch.name = d.name
                    if (d.role !== s.role) patch.role = d.role
                    if (d.email !== s.email) patch.email = d.email
                    if (d.note !== s.note) patch.note = d.note
                    if (d.color !== s.color) patch.color = d.color
                    if (Object.keys(patch).length === 0) { setEditingId(null); return }
                    try {
                      await api.updateStakeholder(s.id, patch)
                      setEditingId(null)
                      await reload()
                    } catch (e) {
                      fail(conflictText(e, d.name, 'update'))
                    }
                  }}
                />
              ) : (
                <>
                  <StakeholderAvatar name={s.name} color={s.color} />
                  <span className="st-row-name truncate">{s.name}</span>
                  {s.role ? <span className="faint truncate st-sh-role">{s.role}</span> : null}
                  {s.email ? <span className="faint truncate st-row-desc">{s.email}</span> : null}
                  {s.archived_at ? <span className="tag st-tag-off">已归档</span> : null}

                  <span className="st-sh-counts">
                    <span
                      className={`badge ${s.owned_count === 0 ? 'v-badge-zero' : ''}`.trim()}
                      title={`作为负责人的工作对象 ${s.owned_count} 件`}
                    >
                      负责 {s.owned_count}
                    </span>
                    <span
                      className={`badge ${s.participating_count === 0 ? 'v-badge-zero' : ''}`.trim()}
                      title={`作为参与人的工作对象 ${s.participating_count} 件`}
                    >
                      参与 {s.participating_count}
                    </span>
                  </span>

                  <div className="row-actions st-row-acts">
                    <Button small onClick={() => { setEditingId(s.id); setError(null) }}>编辑</Button>
                    <Button small disabled={idx === 0 || busy} title="上移" onClick={() => void move(s, -1)}>↑</Button>
                    <Button small disabled={idx === visible.length - 1 || busy} title="下移" onClick={() => void move(s, 1)}>↓</Button>
                    <Button
                      small
                      disabled={busy}
                      title={s.archived_at
                        ? '复岗后重新出现在负责人/参与人的可选项里'
                        : '归档后已挂在他名下的工作对象照常显示他的名字，但派新活时不再出现在可选项里'}
                      onClick={() => void run(async () => {
                        await api.updateStakeholder(s.id, { archived: !s.archived_at })
                        await reload()
                      })}
                    >
                      {s.archived_at ? '复岗' : '归档'}
                    </Button>
                    {refs === 0 ? (
                      <Button
                        small
                        variant="danger"
                        disabled={busy}
                        title="没有任何工作对象引用他，删除是安全的"
                        onClick={() => { setDeleting(s); setError(null) }}
                      >
                        删除
                      </Button>
                    ) : (
                      <span
                        className="faint st-sh-nodel"
                        title={`他名下有 ${s.owned_count} 件负责的、${s.participating_count} 件参与的工作对象，删掉会在那些对象上留下一个没有名字的空位。人走了请用「归档」。`}
                      >
                        不可删除
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>

      {!loading && items.length > 0 && visible.length === 0 ? (
        <div className="faint st-pad">
          {q.trim() ? '没有匹配的干系人。' : '在岗的人都被归档了，勾上「显示已归档」来查看。'}
        </div>
      ) : null}

      <p className="faint st-note">
        名字是全局唯一的：重名会被后端拒绝。同事离职用「归档」不用「删除」——
        归档只是让他不再出现在派活的可选项里，他经手过的工作对象上仍然显示得出他的名字；
        删除则会让那些对象的负责人变成一个谁也解释不了的空值。
      </p>

      {deleting ? (
        <ConfirmDialog
          open
          danger
          title="删除干系人"
          confirmText="删除"
          busy={busy}
          error={error}
          onCancel={() => { setDeleting(null); setError(null) }}
          onConfirm={async () => {
            const ok = await run(async () => {
              try {
                await api.deleteStakeholder(deleting.id)
              } catch (e) {
                // 打开对话框之后别人给他派了活：引用计数是拉取时的快照，后端才是最终裁判
                if (e instanceof ApiError && e.status === 409) {
                  throw new Error(`「${deleting.name}」已经被工作对象引用了，不能删除。关掉这个框刷新一下能看到具体数量，人走了请改用「归档」。`)
                }
                throw e
              }
            })
            if (ok) { setDeleting(null); await reload() }
          }}
        >
          <p>将从名册中删除「{deleting.name}」。</p>
          <p className="faint">没有任何工作对象引用他，删除是安全的。此操作不可撤销。</p>
        </ConfirmDialog>
      ) : null}
    </div>
  )
}

/** 409 在这两个接口上只有一个含义：名字撞了。说清楚是哪个名字，以及归档的人也占名额。 */
function conflictText(e: unknown, name: string, mode: 'create' | 'update'): string {
  if (e instanceof ApiError && e.status === 409) {
    return mode === 'create'
      ? `已有同名干系人「${name}」——名字是全局唯一的。如果是已归档的同事回来了，勾上「显示已归档」把他复岗，别新建一个同名的。`
      : `已有同名干系人「${name}」——名字是全局唯一的，换一个写法（比如加上部门）再保存。`
  }
  return errText(e)
}

/* ------------------------------------------------------------ 干系人表单 */

interface Draft {
  name: string
  role: string
  email: string
  note: string
  color: string
}

function StakeholderForm({ busy, initial, onCancel, onSubmit }: {
  busy: boolean
  initial?: Stakeholder
  /** fail 用来把后端的 409 回填到名字那一栏——错误要落在出错的字段旁边 */
  onSubmit: (d: Draft, fail: (msg: string) => void) => void
  onCancel: () => void
}) {
  const [d, setD] = useState<Draft>({
    name: initial?.name ?? '',
    role: initial?.role ?? '',
    email: initial?.email ?? '',
    note: initial?.note ?? '',
    color: initial?.color || PRESET_COLORS[0],
  })
  const [err, setErr] = useState<string | null>(null)

  const submit = () => {
    const name = d.name.trim()
    if (!name) { setErr('名字必填'); return }
    setErr(null)
    onSubmit(
      { name, role: d.role.trim(), email: d.email.trim(), note: d.note.trim(), color: d.color },
      setErr,
    )
  }

  return (
    <div className="st-inline-form st-inline-grow">
      <div className="form-row">
        <Field label="名字" error={err} hint="全局唯一，负责人下拉里显示的就是它">
          <TextInput
            autoFocus
            value={d.name}
            placeholder="张三"
            onValueChange={(v) => setD({ ...d, name: v })}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
          />
        </Field>
        <Field label="角色（可选）" hint="产品 / 后端 / 设计…，选人时跟在名字后面">
          <TextInput value={d.role} placeholder="后端" onValueChange={(v) => setD({ ...d, role: v })} />
        </Field>
      </div>

      <Field label="邮箱（可选）">
        <TextInput type="email" value={d.email} placeholder="someone@example.com" onValueChange={(v) => setD({ ...d, email: v })} />
      </Field>

      <Field label="颜色" hint="头像与参与人标记的底色">
        <Swatches value={d.color} onChange={(c) => setD({ ...d, color: c })} />
      </Field>

      <Field label="备注（可选）">
        <TextArea rows={2} value={d.note} onValueChange={(v) => setD({ ...d, note: v })} />
      </Field>

      <div className="st-inline-acts">
        <Button onClick={onCancel} disabled={busy}>取消</Button>
        <Button variant="primary" onClick={submit} disabled={busy}>保存</Button>
      </div>
    </div>
  )
}
