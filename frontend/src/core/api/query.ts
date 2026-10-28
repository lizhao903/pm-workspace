// query 参数生成，严格按 docs/api-contract.md 的参数表。
// 表里没有的参数后端会静默丢弃，所以这里只认表里的名字。

import type { ArtifactListParams, ObjectListParams, ObjectPatch, WorkObject } from './types'

// 多选：去空白、去空串后逗号拼接，空数组不出现
function csv(qs: URLSearchParams, key: string, values?: readonly string[]) {
  const v = (values ?? []).map((s) => s.trim()).filter(Boolean)
  if (v.length) qs.set(key, v.join(','))
}

function str(qs: URLSearchParams, key: string, value?: string) {
  const v = value?.trim()
  if (v) qs.set(key, v)
}

// 布尔开关：只在 true 时出现，false 与不传等价
function flag(qs: URLSearchParams, key: string, value?: boolean) {
  if (value) qs.set(key, 'true')
}

// 三态：undefined 不出现，true / false 原样传
function tri(qs: URLSearchParams, key: string, value?: boolean) {
  if (value !== undefined) qs.set(key, String(value))
}

function num(qs: URLSearchParams, key: string, value?: number) {
  if (value !== undefined && Number.isFinite(value)) qs.set(key, String(Math.trunc(value)))
}

export function objectListQuery(p: ObjectListParams = {}): URLSearchParams {
  const qs = new URLSearchParams()
  csv(qs, 'type', p.type)
  str(qs, 'category', p.category)
  flag(qs, 'subtree', p.subtree)
  flag(qs, 'uncategorized', p.uncategorized)
  csv(qs, 'status', p.status)
  csv(qs, 'priority', p.priority)
  // tag 是重复参数，不是逗号拼接：标签名里可能本来就有逗号
  for (const t of p.tag ?? []) {
    const v = t.trim()
    if (v) qs.append('tag', v)
  }
  str(qs, 'owner_id', p.owner_id)
  str(qs, 'project', p.project)
  csv(qs, 'source', p.source)
  str(qs, 'q', p.q)
  // 纯日期原样传，由后端按上下界分别补时；前端不要自己补
  str(qs, 'due_after', p.due_after)
  str(qs, 'due_before', p.due_before)
  flag(qs, 'stalled', p.stalled)
  flag(qs, 'not_terminal', p.not_terminal)
  flag(qs, 'overdue', p.overdue)
  flag(qs, 'inbox', p.inbox)
  flag(qs, 'archived', p.archived)
  flag(qs, 'deleted', p.deleted)
  str(qs, 'sort', p.sort)
  num(qs, 'limit', p.limit)
  num(qs, 'offset', p.offset)
  return qs
}

export function artifactListQuery(p: ArtifactListParams = {}): URLSearchParams {
  const qs = new URLSearchParams()
  str(qs, 'object_id', p.object_id)
  flag(qs, 'unscoped', p.unscoped)
  str(qs, 'session_id', p.session_id)
  str(qs, 'run_id', p.run_id)
  str(qs, 'platform', p.platform)
  str(qs, 'source', p.source)
  tri(qs, 'has_url', p.has_url)
  tri(qs, 'has_path', p.has_path)
  str(qs, 'q', p.q)
  num(qs, 'limit', p.limit)
  num(qs, 'offset', p.offset)
  return qs
}

// 本地时区的 YYYY-MM-DD，给 due_after / due_before 用
export function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export type Focus = 'today' | 'week' | 'overdue' | 'stalled'

// 聚焦视图的查询条件，口径与 /api/counts 的同名计数器逐字一致（见契约「今日」「本周」「停滞」表）。
export function focusParams(focus: Focus, now: Date = new Date()): ObjectListParams {
  switch (focus) {
    case 'today':
      return { due_after: localDay(now), due_before: localDay(now), not_terminal: true }
    case 'week': {
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7)
      return { due_after: localDay(now), due_before: localDay(end), not_terminal: true }
    }
    case 'overdue':
      return { overdue: true }
    case 'stalled':
      return { stalled: true }
  }
}

function sameJSON(a: unknown, b: unknown) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function sameSet(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && sameJSON([...a].sort(), [...b].sort())
}

// 从编辑草稿里挑出真正改了的字段，PATCH 只传这些。草稿里没出现的字段视为不改。
export function changedFields(before: WorkObject, draft: ObjectPatch): ObjectPatch {
  const out: ObjectPatch = {}
  const put = <K extends keyof ObjectPatch>(k: K, changed: boolean) => {
    if (draft[k] !== undefined && changed) out[k] = draft[k]
  }
  put('title', draft.title !== before.title)
  put('body', draft.body !== before.body)
  put('status', draft.status !== before.status)
  put('priority', draft.priority !== before.priority)
  put('owner_id', draft.owner_id !== (before.owner_id ?? ''))
  put('participant_ids', !sameSet(draft.participant_ids ?? [], before.participants.map((p) => p.id)))
  put('category_id', draft.category_id !== before.category_id)
  put('project_id', draft.project_id !== before.project_id)
  put('source', draft.source !== before.source)
  put('props', !sameJSON(draft.props, before.props))
  put('workdir', draft.workdir !== before.workdir)
  put('due_at', !sameDue(draft.due_at, before.due_at))
  put('tags', !sameSet(draft.tags ?? [], before.tags))
  put('archived', draft.archived !== (before.archived_at !== null))
  return out
}

// 到期日按时刻比较：同一时刻的不同写法（时区、毫秒）不算改动
function sameDue(a: string | null | undefined, b: string | null) {
  if (!a || !b) return (a ?? null) === b
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  return Number.isNaN(ta) || Number.isNaN(tb) ? a === b : ta === tb
}
