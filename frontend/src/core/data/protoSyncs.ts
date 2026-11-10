// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 原型同步（AUTO-11）：以上线代码为准回写原型库和规格，只提交到原型库的同步分支 proto-sync/<日期>。
// 项目插件记同步点（每次同步到的代码提交和同步分支的提交对应起来）、管三种触发的开关（发布成功、生产分支有新提交、每日巡检，默认都关）；
// 流程本身是 IM 插件写进 SOP 的内置流程「原型同步」，拿不准的差异在 SOP 执行页的「产品裁决」里定。
// 这里是项目档案标签里「原型同步」块用的接口。契约见 docs/api-contract.md「项目插件 / 原型同步」。
// 变化时后端发 projects.proto_sync_changed，项目插件入口据此标脏缓存。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestList } from '../api'

export type ProtoSyncStatus = 'running' | 'reviewing' | 'done' | 'no_change' | 'baseline' | 'failed' | 'cancelled'
export type ProtoSyncTrigger = 'release' | 'merge' | 'daily' | 'manual' | 'baseline'
/** 差异分类：代码有原型没有、都有但不一致、原型有代码没有、代码已删原型还在、拿不准 */
export type ProtoSyncKind = 'added' | 'changed' | 'unimplemented' | 'removed' | 'uncertain'
/** 规格的实现状态 */
export type ImplStatus = 'implemented' | 'unimplemented' | 'offline' | 'deviation' | 'pending'
/** 人工裁决：空串待裁决；design 当作新设计按代码回写；defect 当作缺陷建修复任务；ignore 暂不处理 */
export type ProtoSyncDecision = '' | 'design' | 'defect' | 'ignore'

export type ProtoSyncItem = {
  kind: ProtoSyncKind
  title: string
  detail: string
  /** 规格条目编号（SPEC-x-y），没有为空串 */
  spec: string
  /** 原型页面或路由 */
  page: string
  status: ImplStatus
  decision: ProtoSyncDecision
}

export type ProtoSyncCounts = { added: number; changed: number; unimplemented: number; removed: number; uncertain: number; pending: number }

export type ProtoSync = {
  id: string
  project_id: string
  trigger: ProtoSyncTrigger
  /** 发布 id（release）、检查到的 HEAD（merge）、日期（daily），其余空串 */
  trigger_ref: string
  status: ProtoSyncStatus
  code_dir: string
  code_branch: string
  /** 空串是首次同步（对比整个代码库） */
  base_commit: string
  head_commit: string
  files: string[]
  diff_stat: string
  ui_changed: boolean
  proto_dir: string
  proto_repo: string
  proto_branch: string
  proto_base: string
  /** 同步分支上最后的提交，原型没改为空串 */
  proto_commit: string
  proto_path: string
  items: ProtoSyncItem[]
  counts: ProtoSyncCounts
  decision: ProtoSyncDecision
  decided_at: string | null
  fix_task_id: string
  summary: string
  run_dir: string
  diff_path: string
  run_id: string
  sop_run_id: string
  error: string
  started_at: string
  finished_at: string | null
  updated_at: string
}

export type ProtoSyncSettings = {
  on_release: boolean
  on_merge: boolean
  daily: boolean
  /** 本机时间 HH:MM */
  daily_at: string
  /** 生产分支，空串时依次认 main、master、当前检出的分支 */
  branch: string
  updated_at: string | null
}
export type ProtoSyncSettingsPatch = Partial<Omit<ProtoSyncSettings, 'updated_at'>>

export type SyncPoint = { commit: string; sync_id: string; status: ProtoSyncStatus; proto_branch: string; proto_commit: string; at: string }

export type ProtoSyncState = {
  project_id: string
  settings: ProtoSyncSettings
  /** 生效的生产分支和它当前的 HEAD；取不到时为空串，原因在 head_error */
  branch: string
  head: string
  head_error: string
  point: SyncPoint | null
  last: ProtoSync | null
  active: ProtoSync | null
}

const one = (id: string) => `/api/projects/${encodeURIComponent(id)}`
const runPath = (id: string) => `/api/projects/proto-syncs/runs/${encodeURIComponent(id)}`

export const protoSyncApi = {
  state: (projectId: string, signal?: AbortSignal) => request<ProtoSyncState>('GET', `${one(projectId)}/proto-sync`, { signal }),
  saveSettings: (projectId: string, patch: ProtoSyncSettingsPatch) => request<ProtoSyncState>('PATCH', `${one(projectId)}/proto-sync`, { body: patch }),
  history: async (projectId: string, signal?: AbortSignal) =>
    (await requestList<ProtoSync>(`${one(projectId)}/proto-syncs?limit=30`, { signal })).data,
  /** sync 发起一次同步；baseline 把当前 HEAD 记成同步点、不对比 */
  trigger: (projectId: string, mode: 'sync' | 'baseline') => request<ProtoSync>('POST', `${one(projectId)}/proto-syncs`, { body: { mode } }),
  cancel: (id: string) => request<ProtoSync>('POST', `${runPath(id)}/cancel`),
}

export const protoSyncKeys = {
  all: ['protoSyncs'] as const,
  state: (projectId: string) => ['protoSyncs', 'state', projectId] as const,
  history: (projectId: string) => ['protoSyncs', 'history', projectId] as const,
}

type Every = number | false

export function useProtoSyncState(projectId: string, every?: (s: ProtoSyncState | undefined) => Every) {
  return useQuery({
    queryKey: protoSyncKeys.state(projectId),
    queryFn: ({ signal }) => protoSyncApi.state(projectId, signal),
    refetchInterval: every ? (q) => every(q.state.data) : false,
  })
}

export function useProtoSyncHistory(projectId: string) {
  return useQuery({ queryKey: protoSyncKeys.history(projectId), queryFn: ({ signal }) => protoSyncApi.history(projectId, signal) })
}

export function useSaveProtoSyncSettings(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: ProtoSyncSettingsPatch) => protoSyncApi.saveSettings(projectId, patch),
    onSuccess: (s) => qc.setQueryData(protoSyncKeys.state(projectId), s),
  })
}

export function useTriggerProtoSync(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (mode: 'sync' | 'baseline') => protoSyncApi.trigger(projectId, mode),
    onSettled: () => void qc.invalidateQueries({ queryKey: protoSyncKeys.all }),
  })
}

export function useCancelProtoSync() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => protoSyncApi.cancel(id),
    onSettled: () => void qc.invalidateQueries({ queryKey: protoSyncKeys.all }),
  })
}

export const PROTO_SYNC_STATUS_LABEL: Record<ProtoSyncStatus, string> = {
  running: '进行中', reviewing: '等产品裁决', done: '已同步', no_change: '没有界面改动', baseline: '设为基线', failed: '没成功', cancelled: '已作废',
}
export const PROTO_SYNC_TRIGGER_LABEL: Record<ProtoSyncTrigger, string> = {
  release: '发布成功', merge: '生产分支有新提交', daily: '每日巡检', manual: '手动', baseline: '设基线',
}
export const PROTO_SYNC_KIND_LABEL: Record<ProtoSyncKind, string> = {
  added: '新增', changed: '不一致', unimplemented: '未实现', removed: '已下线', uncertain: '不确定',
}
export const IMPL_STATUS_LABEL: Record<ImplStatus, string> = {
  implemented: '已实现', unimplemented: '未实现', offline: '已下线', deviation: '实现有偏差', pending: '待裁决',
}
export const DECISION_LABEL: Record<Exclude<ProtoSyncDecision, ''>, string> = {
  design: '当作新设计', defect: '当作缺陷', ignore: '暂不处理',
}

/** 状态的色调：已同步绿；没成功红；进行中蓝；等裁决黄；其余灰 */
export function protoSyncTone(s: ProtoSyncStatus): 'ok' | 'bad' | 'run' | 'warn' | 'muted' {
  if (s === 'done') return 'ok'
  if (s === 'failed') return 'bad'
  if (s === 'running') return 'run'
  if (s === 'reviewing') return 'warn'
  return 'muted'
}

/** 实现状态的色调 */
export function implTone(s: ImplStatus): 'ok' | 'bad' | 'warn' | 'muted' {
  if (s === 'implemented') return 'ok'
  if (s === 'deviation') return 'bad'
  if (s === 'pending') return 'warn'
  return 'muted'
}

export const shortSha = (sha: string) => sha.slice(0, 7)

/** 一次同步的一句话，同后端通知里的说法 */
export function protoSyncSummary(p: ProtoSync): string {
  const c = p.counts
  const counts = `新增 ${c.added}、不一致 ${c.changed}、未实现 ${c.unimplemented}、已下线 ${c.removed}、不确定 ${c.uncertain}`
  const range = `${p.base_commit ? shortSha(p.base_commit) : '首次'} → ${shortSha(p.head_commit)}`
  switch (p.status) {
    case 'done': {
      let s = `代码 ${range}：${counts}`
      if (p.decision) s += `；拿不准的${DECISION_LABEL[p.decision]}`
      s += p.proto_commit ? `。改动在 ${p.proto_branch}（${shortSha(p.proto_commit)}），看过差异清单后再合并` : '。原型和规格不用改'
      return s
    }
    case 'no_change': return p.trigger === 'daily' && p.base_commit === p.head_commit ? '自上次同步后生产分支没有新提交' : `代码 ${range} 没有涉及界面或接口的改动，同步点前移`
    case 'baseline': return `把代码 ${shortSha(p.head_commit)} 设为同步点`
    case 'reviewing': return `代码 ${range}：${counts}；${c.pending} 条拿不准，到 SOP 执行页的「产品裁决」里定`
    case 'failed': return p.error || '没成功'
    case 'cancelled': return p.error || '已作废'
  }
  return `正在对比代码 ${range}`
}

/** 规格实现状态一览：按规格编号取最近一次同步里的状态（历史新的在前），没有编号的不列 */
export function specStatuses(history: ProtoSync[]): { spec: string; title: string; status: ImplStatus; kind: ProtoSyncKind; sync_id: string; at: string }[] {
  const seen = new Map<string, { spec: string; title: string; status: ImplStatus; kind: ProtoSyncKind; sync_id: string; at: string }>()
  for (const p of history) {
    if (p.status === 'cancelled' || p.status === 'failed') continue
    for (const it of p.items) {
      const spec = it.spec.trim()
      if (!spec || seen.has(spec)) continue
      seen.set(spec, { spec, title: it.title, status: it.status, kind: it.kind, sync_id: p.id, at: p.finished_at ?? p.started_at })
    }
  }
  return [...seen.values()].sort((a, b) => a.spec.localeCompare(b.spec, 'en', { numeric: true }))
}
