// 任务抽屉的表单值和保存时的请求体（SPEC-tasks-4 数据、DEV-07b）。
// 编辑只传改动的字段；截止日按本地日期比较，props 里的验收标准、关联仓库单独挑出来，由接口层读回再合并。
import {
  PROP_ACCEPTANCE, PROP_REPO, changedFields, type DictItem, type ObjectCreateInput, type ObjectSave, type ObjectStatus, type WorkObject,
} from '../../core/data'
import { dueDay } from './model'

export type TaskDraft = {
  title: string
  body: string
  status: string
  priority: string
  /** 空串 = 没有负责人 */
  owner_id: string
  participant_ids: string[]
  /** 本地日期 YYYY-MM-DD，空串 = 没有截止 */
  due: string
  /** 空串 = 不属于项目 */
  project_id: string
  workdir: string
  repo: string
  acceptance: string
}

const propStr = (t: WorkObject, k: string) => {
  const v = t.props?.[k]
  return typeof v === 'string' ? v : ''
}

export function draftOf(t: WorkObject): TaskDraft {
  return {
    title: t.title,
    body: t.body,
    status: t.status,
    priority: t.priority,
    owner_id: t.owner_id ?? '',
    participant_ids: t.participants.map((p) => p.id),
    due: dueDay(t) ?? '',
    project_id: t.project_id ?? '',
    workdir: t.workdir,
    repo: propStr(t, PROP_REPO),
    acceptance: propStr(t, PROP_ACCEPTANCE),
  }
}

/**
 * 新建的默认值：状态取类型状态表的第一个；优先级取字典里标了 meta.default 的，
 * 字典没标默认值时用 P2（规格 SPEC-tasks-4.2），字典里也没有 P2 就不设。
 */
export function emptyDraft(statuses: readonly ObjectStatus[], priorities: readonly DictItem[]): TaskDraft {
  const live = priorities.filter((p) => !p.archived_at)
  const prio = live.find((p) => p.meta?.default === true) ?? live.find((p) => p.key === 'P2')
  return {
    title: '', body: '', status: statuses[0]?.key ?? '', priority: prio?.key ?? '',
    owner_id: '', participant_ids: [], due: '', project_id: '', workdir: '', repo: '', acceptance: '',
  }
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n')

/** 两份草稿是否一样；首尾空白不算改动，参与人不看顺序 */
export function sameDraft(a: TaskDraft, b: TaskDraft): boolean {
  return (Object.keys(a) as (keyof TaskDraft)[]).every((k) => {
    const x = a[k], y = b[k]
    if (Array.isArray(x) && Array.isArray(y)) return sameSet(x, y)
    return String(x).trim() === String(y).trim()
  })
}

/** 编辑保存的请求：patch 只含改动字段，props 只含改动的 key（空串表示去掉） */
export function buildSave(before: WorkObject, d: TaskDraft): ObjectSave {
  const patch = changedFields(before, {
    title: d.title.trim(),
    body: d.body,
    status: d.status,
    priority: d.priority,
    owner_id: d.owner_id,
    participant_ids: d.participant_ids,
    project_id: d.project_id || null,
    workdir: d.workdir.trim(),
  })
  // 截止日：纯日期由后端落在本地当天 23:59:59，按本地日期比，不按时刻比
  if ((dueDay(before) ?? '') !== d.due) patch.due_at = d.due || null
  const props: Record<string, string | null> = {}
  const acc = d.acceptance.trim() ? d.acceptance : ''
  if (acc !== propStr(before, PROP_ACCEPTANCE)) props[PROP_ACCEPTANCE] = acc || null
  const repo = d.repo.trim()
  if (repo !== propStr(before, PROP_REPO)) props[PROP_REPO] = repo || null
  return { id: before.id, patch, props: Object.keys(props).length ? props : undefined }
}

/** 新建的请求体：空值不传，交给后端的默认。在哪个视图里新建都是人工任务（SPEC-tasks-3.4） */
export function buildCreate(d: TaskDraft): ObjectCreateInput {
  const input: ObjectCreateInput = { type_id: 'task', title: d.title.trim(), source: 'manual' }
  if (d.body) input.body = d.body
  if (d.status) input.status = d.status
  if (d.priority) input.priority = d.priority
  if (d.owner_id) input.owner_id = d.owner_id
  if (d.participant_ids.length) input.participant_ids = d.participant_ids
  if (d.due) input.due_at = d.due
  if (d.project_id) input.project_id = d.project_id
  if (d.workdir.trim()) input.workdir = d.workdir.trim()
  const props: Record<string, unknown> = {}
  if (d.acceptance.trim()) props[PROP_ACCEPTANCE] = d.acceptance
  if (d.repo.trim()) props[PROP_REPO] = d.repo.trim()
  if (Object.keys(props).length) input.props = props
  return input
}

