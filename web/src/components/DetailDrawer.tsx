// 右栏抽屉：详情 / AI 助手 / 执行 / 活动 / 关联，共用一个对象上下文（对齐线框稿的 tab 次序）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspace } from '../hooks/workspace'
import type { DrawerTab } from '../hooks/workspace'
import { api } from '../lib/api'
import type { LinkView, ObjectPatch, Revision, WorkObject } from '../lib/types'
import TaskRunPanel, { WorkdirField } from './TaskRunPanel'
import ObjectAgentPanel from './agent/ObjectAgentPanel'
import { OwnerPicker, ParticipantPicker, useStakeholders } from './StakeholderPicker'
import {
  Button, CategoryPicker, ConfirmDialog, PRIORITIES, RELATIONS, RelativeTime, Select,
  StatusPill, TagChip, TextArea, TextInput, endOfDayIso, formatDate, formatDateTime,
  fromDateTimeLocal, isEndOfDay, isOverdue, toDateTimeLocal, useCategoryTree,
} from './ui'
import '../views.css'

// 「执行」只活在抽屉本地：DrawerTab 是 hooks/workspace 的公共类型，别的入口（命令面板、
// Agent 结果跳转）都在用它，为了一个抽屉内的页签去改它不值当。本地态 + 跟随全局值即可。
type LocalTab = DrawerTab | 'run'

const TABS: Array<{ key: LocalTab; label: string }> = [
  { key: 'detail', label: '详情' },
  { key: 'ai', label: 'AI 助手' },
  { key: 'run', label: '执行' },
  { key: 'activity', label: '活动' },
  { key: 'links', label: '关联' },
]

// 活动流里 revisions.field 的中文名映射
const FIELD_LABELS: Record<string, string> = {
  title: '标题', body: '正文', status: '状态', priority: '优先级', owner: '负责人',
  owner_id: '负责人', participants: '参与人', participant_ids: '参与人',
  category_id: '分类', project_id: '项目', due_at: '到期', tags: '标签', source: '来源',
  archived_at: '归档时间', deleted_at: '删除时间', started_at: '开始时间',
  completed_at: '完成时间', props: '扩展属性', created: '创建',
}

const RELATION_LABELS: Record<string, string> = Object.fromEntries(RELATIONS.map((r) => [r.value, r.label]))

export default function DetailDrawer() {
  const { drawerOpen, selected, setDrawerOpen, drawerTab, setDrawerTab, typeById } = useWorkspace()

  const [tab, setTab] = useState<LocalTab>(drawerTab)
  // 外部改了全局页签（命令面板、Agent 结果跳转）就跟过去；换对象也要跟一次——
  // select() 每次都把全局页签重置成「详情」，值没变时这个 effect 不会自己触发，
  // 少了 selected?.id 这个依赖，换对象后会一直停在「执行」上。
  useEffect(() => { setTab(drawerTab) }, [drawerTab, selected?.id])
  const pickTab = useCallback((k: LocalTab) => {
    setTab(k)
    if (k !== 'run') setDrawerTab(k)
  }, [setDrawerTab])

  if (!drawerOpen) return null

  if (!selected) {
    return (
      <div className="v-drawer">
        <div className="v-drawer-top">
          <span className="muted">详情</span>
          <button type="button" className="btn btn-ghost btn-sm" aria-label="关闭抽屉" onClick={() => setDrawerOpen(false)}>×</button>
        </div>
        <div className="empty-state"><p>选择一个工作对象查看详情。</p></div>
      </div>
    )
  }

  const type = typeById[selected.type_id]
  return (
    <div className="v-drawer">
      <div className="v-drawer-top">
        <span className="mono faint">{selected.ref}</span>
        <span className="muted truncate">{type?.name ?? selected.type_id}</span>
        <div className="v-toolbar-spacer" />
        <button type="button" className="btn btn-ghost btn-sm" aria-label="关闭抽屉" onClick={() => setDrawerOpen(false)}>×</button>
      </div>

      {/* tr-tabs 只管在页签放不下时折行，其余外观仍由 .drawer-tab 决定 */}
      <div className="drawer-tabs tr-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`drawer-tab ${tab === t.key ? 'drawer-tab-active' : ''}`.trim()}
            onClick={() => pickTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* key 保证换对象时本地草稿状态重置 */}
      {tab === 'detail' ? <DetailTab key={selected.id} object={selected} /> : null}
      {tab === 'ai' ? <AiTab object={selected} onGoDetail={() => pickTab('detail')} /> : null}
      {tab === 'run' ? <TaskRunPanel key={selected.id} object={selected} onGoDetail={() => pickTab('detail')} /> : null}
      {tab === 'activity' ? <ActivityTab key={selected.id} objectId={selected.id} /> : null}
      {tab === 'links' ? <LinksTab key={selected.id} objectId={selected.id} /> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ 详情 */

function DetailTab({ object }: { object: WorkObject }) {
  const { types, typeById, updateObject, deleteObject, select } = useWorkspace()
  const type = typeById[object.type_id]
  const categories = useCategoryTree(object.type_id)
  const roster = useStakeholders()

  const [title, setTitle] = useState(object.title)
  const [body, setBody] = useState(object.body)
  const [tagInput, setTagInput] = useState('')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [projects, setProjects] = useState<WorkObject[]>([])

  // 外部（乐观更新 / 其他入口）改了字段时同步回本地草稿
  useEffect(() => { setTitle(object.title) }, [object.title])
  useEffect(() => { setBody(object.body) }, [object.body])

  const projectTypeId = useMemo(() => types.find((t) => t.id === 'project')?.id ?? null, [types])
  useEffect(() => {
    if (!projectTypeId) { setProjects([]); return }
    let alive = true
    void api.objects({ type: [projectTypeId], limit: 200, sort: 'title' })
      .then((r) => { if (alive) setProjects(r.items) })
      .catch(() => { if (alive) setProjects([]) })
    return () => { alive = false }
  }, [projectTypeId])

  const patch = useCallback(async (p: ObjectPatch) => {
    setSaveState('saving'); setError(null)
    try {
      await updateObject(object.id, p)
      setSaveState('saved')
      window.setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSaveState('idle')
    }
  }, [object.id, updateObject])

  const commitTitle = () => {
    const v = title.trim()
    if (!v || v === object.title) { setTitle(object.title); return }
    void patch({ title: v })
  }

  const addTag = () => {
    const v = tagInput.trim()
    if (!v || object.tags.includes(v)) { setTagInput(''); return }
    setTagInput('')
    void patch({ tags: [...object.tags, v] })
  }

  return (
    <>
      <div className="drawer-body">
        {error ? <div className="error-banner">{error}</div> : null}

        <input
          className="input v-title-input"
          value={title}
          aria-label="标题"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
        />

        <div className="card">
          <div className="kv v-kv">
            <b>编号</b><span className="mono faint">{object.ref}</span>

            <b>状态</b>
            <span className="v-kv-row">
              <Select
                value={object.status}
                onValueChange={(v) => void patch({ status: v })}
                options={(type?.statuses ?? []).map((s) => ({ value: s.key, label: s.label }))}
              />
              <StatusPill status={type?.statuses.find((s) => s.key === object.status) ?? null} fallback={object.status || '—'} />
            </span>

            <b>优先级</b>
            <Select
              value={object.priority || ''}
              onValueChange={(v) => void patch({ priority: v })}
              options={[{ value: '', label: '未设置' }, ...PRIORITIES.map((p) => ({ value: p, label: p }))]}
            />

            <b>负责人</b>
            <span className="v-kv-row">
              <OwnerPicker
                value={object.owner_id}
                valueName={object.owner_name}
                onChange={(id) => void patch({ owner_id: id })}
              />
              {/* 0010 之前的自由文本负责人只读：owner_id 空而 owner 非空时把原文摆出来，
                  否则这条对象看起来像是从来没人负责过 */}
              {!object.owner_id && object.owner ? (
                <span className="faint" title="迁移前的自由文本负责人，只读。在上面选一个干系人即可接管">
                  原文「{object.owner}」
                </span>
              ) : null}
              {roster.empty ? (
                <span className="faint" title="去「设置 → 干系人」建人">名册为空</span>
              ) : null}
            </span>

            <b>参与人</b>
            {/* participants 兜一层空：名册接口上线前后端还不回这个字段，
                读不到参与人是可以接受的，整个抽屉白屏不是 */}
            <ParticipantPicker
              value={object.participants ?? []}
              excludeId={object.owner_id}
              onChange={(ids) => void patch({ participant_ids: ids })}
            />

            <b>到期</b>
            <span className="v-kv-row">
              {/* 必须是 datetime-local：Agent 能解析出「明天下午三点」这种带时刻的到期，
                  用 type="date" 既看不见时刻，onChange 又会把它写死成 23:59:59——
                  用户只是重新选了同一天，14:00 就被静默改掉了。 */}
              <input
                type="datetime-local"
                className="input"
                aria-label="到期时间"
                value={toDateTimeLocal(object.due_at)}
                onChange={(e) => {
                  const next = fromDateTimeLocal(e.target.value)
                  // 从「无到期」首次设值时，日历弹窗默认把时刻留在 00:00，
                  // 这种情况按「整天」处理落 23:59:59。已有到期后的每次编辑都原样写入，
                  // 否则用户想设 00:00 会被反复纠正。
                  const firstSet = !object.due_at && next !== null && new Date(next).getHours() === 0 && new Date(next).getMinutes() === 0
                  void patch({ due_at: firstSet ? endOfDayIso(formatDate(next)) : next })
                }}
              />
              <Button
                small
                title="设为当天 23:59:59"
                disabled={!object.due_at || isEndOfDay(object.due_at)}
                onClick={() => { if (object.due_at) void patch({ due_at: endOfDayIso(formatDate(object.due_at)) }) }}
              >
                整天
              </Button>
              {isOverdue(object.due_at) && !object.completed_at ? <span className="v-overdue">已逾期</span> : null}
            </span>

            <b>分类</b>
            <CategoryPicker
              categories={categories}
              value={object.category_id}
              onChange={(id) => void patch({ category_id: id })}
            />

            <b>项目</b>
            <Select
              value={object.project_id ?? ''}
              disabled={!projectTypeId}
              onValueChange={(v) => void patch({ project_id: v === '' ? null : v })}
              options={[{ value: '', label: '未关联项目' }, ...projects.map((p) => ({ value: p.id, label: p.title }))]}
            />

            <b>工作区</b>
            <WorkdirField object={object} onChange={(w) => void patch({ workdir: w })} />

            <b>来源</b><span className="muted">{object.source || '—'}</span>
            <b>创建</b><span><RelativeTime value={object.created_at} /></span>
            <b>更新</b><span><RelativeTime value={object.updated_at} /></span>
          </div>
        </div>

        <div className="card">
          <div className="card-title">标签</div>
          <div className="v-tag-list">
            {object.tags.length === 0 ? <span className="faint">暂无标签</span> : null}
            {object.tags.map((t) => (
              <TagChip key={t} name={t} onRemove={() => void patch({ tags: object.tags.filter((x) => x !== t) })} />
            ))}
          </div>
          <TextInput
            className="v-tag-input"
            value={tagInput}
            placeholder="输入标签后回车添加"
            onValueChange={setTagInput}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
          />
        </div>

        <div className="card">
          <div className="card-title">
            正文
            <span className="faint v-save-hint">
              {saveState === 'saving' ? '保存中…' : saveState === 'saved' ? '已保存' : ''}
            </span>
          </div>
          <TextArea
            autoGrow
            value={body}
            placeholder="写点什么…失焦自动保存"
            onValueChange={setBody}
            onBlur={() => { if (body !== object.body) void patch({ body }) }}
          />
        </div>
      </div>

      <div className="drawer-footer">
        <Button onClick={() => void patch({ archived: true })} disabled={object.archived_at !== null}>
          {object.archived_at ? '已归档' : '归档'}
        </Button>
        <Button variant="danger" onClick={() => setConfirmDelete(true)}>删除</Button>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="移到回收站"
        confirmText="删除"
        danger
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false)
          void deleteObject(object.id).then(() => select(null))
        }}
      >
        <p><span className="mono">{object.ref}</span>「{object.title}」将移到回收站，可在回收站恢复。</p>
      </ConfirmDialog>
    </>
  )
}

/* ------------------------------------------------------------------ 关联 */

function LinksTab({ objectId }: { objectId: string }) {
  const { typeById, select } = useWorkspace()
  const [links, setLinks] = useState<LinkView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [q, setQ] = useState('')
  const [results, setResults] = useState<WorkObject[]>([])
  const [target, setTarget] = useState<WorkObject | null>(null)
  const [relation, setRelation] = useState('relates')

  const load = useCallback(async () => {
    setLoading(true)
    try { setLinks(await api.links(objectId)); setError(null) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [objectId])

  useEffect(() => { void load() }, [load])

  // 搜索目标对象，防抖 250ms，避免每次按键都打后端
  useEffect(() => {
    const kw = q.trim()
    if (!kw) { setResults([]); return }
    const t = window.setTimeout(() => {
      void api.objects({ q: kw, limit: 8 })
        .then((r) => setResults(r.items.filter((o) => o.id !== objectId)))
        .catch(() => setResults([]))
    }, 250)
    return () => window.clearTimeout(t)
  }, [q, objectId])

  const submit = async () => {
    if (!target) return
    try {
      await api.createLink(objectId, target.id, relation)
      setTarget(null); setQ(''); setResults([])
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = async (linkId: string) => {
    try { await api.deleteLink(linkId); await load() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const grouped = useMemo(() => {
    const out = new Map<string, LinkView[]>()
    for (const l of links) {
      const key = `${l.direction}:${l.relation}`
      const arr = out.get(key)
      if (arr) arr.push(l)
      else out.set(key, [l])
    }
    return [...out.entries()]
  }, [links])

  return (
    <div className="drawer-body">
      {error ? <div className="error-banner">{error}</div> : null}
      {loading ? <div className="skeleton v-sk v-sk-title" /> : null}

      {!loading && links.length === 0 ? <div className="faint">还没有关联。</div> : null}

      {grouped.map(([key, items]) => {
        const [dir, rel] = key.split(':')
        return (
          <div className="card" key={key}>
            <div className="card-title">
              {dir === 'out' ? '本对象 →' : '← 指向本对象'} {RELATION_LABELS[rel] ?? rel}
              <span className="badge">{items.length}</span>
            </div>
            {items.map((l) => (
              <div className="v-link-row" key={l.id}>
                <button
                  type="button"
                  className="v-link-peer truncate"
                  disabled={!l.peer}
                  onClick={() => { if (l.peer) select(l.peer.id) }}
                >
                  <span className="mono faint">{l.peer?.ref ?? '—'}</span>
                  <span>{l.peer?.title ?? '(对端已删除)'}</span>
                </button>
                <span className="faint">{l.peer ? typeById[l.peer.type_id]?.name ?? '' : ''}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void remove(l.id)}>移除</button>
              </div>
            ))}
          </div>
        )
      })}

      <div className="card">
        <div className="card-title">添加关联</div>
        <div className="v-link-add">
          <Select
            value={relation}
            onValueChange={setRelation}
            options={RELATIONS.map((r) => ({ value: r.value, label: r.label }))}
          />
          <TextInput
            value={target ? `${target.ref} ${target.title}` : q}
            placeholder="搜索标题或正文…"
            onValueChange={(v) => { setTarget(null); setQ(v) }}
          />
          <Button variant="primary" small disabled={!target} onClick={() => void submit()}>添加</Button>
        </div>
        {results.length > 0 && !target ? (
          <div className="v-menu v-link-results">
            {results.map((o) => (
              <button key={o.id} type="button" className="v-menu-item" onClick={() => { setTarget(o); setResults([]) }}>
                <span className="mono faint">{o.ref}</span>
                <span className="truncate">{o.title}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ 活动 */

function ActivityTab({ objectId }: { objectId: string }) {
  const [items, setItems] = useState<Revision[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void api.revisions(objectId, 50)
      .then((r) => { if (alive) { setItems(r); setError(null) } })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [objectId])

  const val = (v: string) => (v === '' ? '空' : v)

  return (
    <div className="drawer-body">
      {error ? <div className="error-banner">{error}</div> : null}
      {loading ? <div className="skeleton v-sk v-sk-title" /> : null}
      {!loading && items.length === 0 ? <div className="faint">还没有变更记录。</div> : null}

      <div className="v-timeline">
        {items.map((r) => (
          <div className={`v-tl-item ${r.source === 'agent' ? 'v-tl-agent' : ''}`.trim()} key={r.id}>
            <div className="v-tl-dot" aria-hidden="true" />
            <div className="v-tl-content">
              <div className="v-tl-line">
                <b>{r.actor || '系统'}</b>
                <span className="faint" title={formatDateTime(r.created_at)}>
                  <RelativeTime value={r.created_at} />
                </span>
                {r.source === 'agent' ? <span className="badge">Agent</span> : null}
              </div>
              <div className="muted">
                {r.field === 'created'
                  ? '创建了该对象'
                  : <>把 <b>{FIELD_LABELS[r.field] ?? r.field}</b> 从「{val(r.old_value)}」改成「{val(r.new_value)}」</>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- AI 助手 */

// 对象内的对话：和底部那个全局对话框各聊各的，自己一条会话。
//
// 不共用一条的理由很具体：用户在 Dock 里问着一件无关的事，点开一个需求想让它分析，
// 共用的话历史上下文里就带着刚才那段不相干的对话——而模型会真的把它当上下文用。
//
// key 挂 object.id：换对象要换一条对话，而不是把上一个对象的消息留在这儿。
function AiTab({ object, onGoDetail }: { object: WorkObject; onGoDetail: () => void }) {
  return <ObjectAgentPanel key={object.id} object={object} onGoDetail={onGoDetail} />
}
