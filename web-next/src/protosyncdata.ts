// 原型同步（AUTO-11，SPEC-projects-15.17 到 15.28）：以上线代码为准回写原型库和规格，只提交到原型库的同步分支 proto-sync/<日期>。
// 正式产品存在项目插件的表 projects_proto_syncs（每次一行，同步点是最近一次已同步 / 没有界面改动 / 设为基线的代码 HEAD）
// 和 projects_proto_sync_settings（三种触发的开关，默认都关）。

export type ProtoSyncStatus = 'running' | 'reviewing' | 'done' | 'no_change' | 'baseline' | 'failed' | 'cancelled'
export type ProtoSyncTrigger = 'release' | 'merge' | 'daily' | 'manual' | 'baseline'
export type ProtoSyncKind = 'added' | 'changed' | 'unimplemented' | 'removed' | 'uncertain'
export type ImplStatus = 'implemented' | 'unimplemented' | 'offline' | 'deviation' | 'pending'
export type ProtoSyncDecision = '' | 'design' | 'defect' | 'ignore'

export interface ProtoSyncItem { kind: ProtoSyncKind; title: string; detail: string; spec: string; page: string; status: ImplStatus; decision: ProtoSyncDecision }

export interface ProtoSyncRun {
  id: string
  trigger: ProtoSyncTrigger
  status: ProtoSyncStatus
  base_commit: string
  head_commit: string
  proto_branch: string
  proto_commit: string
  items: ProtoSyncItem[]
  decision: ProtoSyncDecision
  fix_task: string
  summary: string
  error: string
  started_at: string
}

export interface ProtoSyncSettings { on_release: boolean; on_merge: boolean; daily: boolean; daily_at: string; branch: string }

export interface ProtoSyncInfo {
  settings: ProtoSyncSettings
  /** 生产分支现在的 HEAD（原型里写死） */
  head: string
  /** 新的在前 */
  history: ProtoSyncRun[]
}

export const EMPTY_PROTO_SYNC: ProtoSyncInfo = {
  settings: { on_release: false, on_merge: false, daily: false, daily_at: '09:00', branch: '' }, head: '9c41d2e7b0', history: [],
}

export const PS_STATUS: Record<ProtoSyncStatus, string> = {
  running: '进行中', reviewing: '等产品裁决', done: '已同步', no_change: '没有界面改动', baseline: '设为基线', failed: '没成功', cancelled: '已作废',
}
export const PS_TRIGGER: Record<ProtoSyncTrigger, string> = { release: '发布成功', merge: '生产分支有新提交', daily: '每日巡检', manual: '手动', baseline: '设基线' }
export const PS_KIND: Record<ProtoSyncKind, string> = { added: '新增', changed: '不一致', unimplemented: '未实现', removed: '已下线', uncertain: '不确定' }
export const IMPL: Record<ImplStatus, string> = { implemented: '已实现', unimplemented: '未实现', offline: '已下线', deviation: '实现有偏差', pending: '待裁决' }
export const DECISION: Record<Exclude<ProtoSyncDecision, ''>, string> = { design: '当作新设计', defect: '当作缺陷', ignore: '暂不处理' }

export const psTone = (s: ProtoSyncStatus) => (s === 'done' ? 'ok' : s === 'failed' ? 'bad' : s === 'running' ? 'run' : s === 'reviewing' ? 'warn' : 'muted')
export const implTone = (s: ImplStatus) => (s === 'implemented' ? 'ok' : s === 'deviation' ? 'bad' : s === 'pending' ? 'warn' : 'muted')
export const sha = (s: string) => s.slice(0, 7)

/** 同步点：最近一次已同步、没有界面改动、设为基线的 */
export const syncPoint = (h: ProtoSyncRun[]) => h.find((x) => x.status === 'done' || x.status === 'no_change' || x.status === 'baseline') ?? null

export function counts(items: ProtoSyncItem[]) {
  const c = { added: 0, changed: 0, unimplemented: 0, removed: 0, uncertain: 0, pending: 0 }
  for (const it of items) {
    c[it.kind]++
    if (it.kind === 'uncertain' && !it.decision) c.pending++
  }
  return c
}

export function psSummary(p: ProtoSyncRun): string {
  const c = counts(p.items)
  const cs = `新增 ${c.added}、不一致 ${c.changed}、未实现 ${c.unimplemented}、已下线 ${c.removed}、不确定 ${c.uncertain}`
  const range = `${p.base_commit ? sha(p.base_commit) : '首次'} → ${sha(p.head_commit)}`
  switch (p.status) {
    case 'done': return `代码 ${range}：${cs}${p.decision ? `；拿不准的${DECISION[p.decision]}` : ''}${p.proto_commit ? `。改动在 ${p.proto_branch}（${sha(p.proto_commit)}），看过差异清单后再合并` : '。原型和规格不用改'}`
    case 'no_change': return p.trigger === 'daily' && p.base_commit === p.head_commit ? '自上次同步后生产分支没有新提交' : `代码 ${range} 没有涉及界面或接口的改动，同步点前移`
    case 'baseline': return `把代码 ${sha(p.head_commit)} 设为同步点`
    case 'reviewing': return `代码 ${range}：${cs}；${c.pending} 条拿不准，到 SOP 执行页的「产品裁决」里定`
    case 'failed': return p.error || '没成功'
    case 'cancelled': return p.error || '已作废'
  }
  return `正在对比代码 ${range}`
}

/** 规格实现状态一览：按规格编号取最近一次同步里的状态，作废和失败的不算 */
export function specStatuses(h: ProtoSyncRun[]) {
  const seen = new Map<string, { spec: string; title: string; status: ImplStatus; at: string }>()
  for (const p of h) {
    if (p.status === 'cancelled' || p.status === 'failed') continue
    for (const it of p.items) if (it.spec && !seen.has(it.spec)) seen.set(it.spec, { spec: it.spec, title: it.title, status: it.status, at: p.started_at })
  }
  return [...seen.values()].sort((a, b) => a.spec.localeCompare(b.spec, 'en', { numeric: true }))
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

/** 立即同步后原型里模拟出来的结果：一条拿不准，等裁决 */
export const sampleItems = (): ProtoSyncItem[] => [
  { kind: 'changed', title: '任务抽屉「工作区」块加了「最近一次发布」', detail: '旧设计：只有测试结果', spec: 'SPEC-tasks-4.77', page: '/tasks', status: 'implemented', decision: '' },
  { kind: 'uncertain', title: '项目列表卡片不再显示原型数', detail: '代码里去掉了，原型和规格还有；分不清是有意改的还是漏了', spec: 'SPEC-projects-1.4', page: '/projects', status: 'pending', decision: '' },
]

export const seedProtoSync: ProtoSyncInfo = {
  settings: { on_release: true, on_merge: false, daily: true, daily_at: '09:00', branch: 'main' },
  head: '9c41d2e7b0',
  history: [
    {
      id: 'psy_3', trigger: 'release', status: 'done', base_commit: '5be0a91c44', head_commit: '9c41d2e7b0', proto_branch: 'proto-sync/20261104', proto_commit: 'e81f03a5d2',
      items: [
        { kind: 'added', title: '档案标签加了「原型同步」块', detail: '', spec: 'SPEC-projects-15.17', page: '/projects/pj_pmw/profile', status: 'implemented', decision: '' },
        { kind: 'changed', title: '发布 pipeline 的上线审批改成两个选项', detail: '旧设计：批准、驳回、改期三个选项', spec: 'SPEC-tasks-4.80', page: '/tasks', status: 'implemented', decision: '' },
        { kind: 'unimplemented', title: '任务列表批量改阶段', detail: '原型有，代码还没做', spec: 'SPEC-tasks-3.40', page: '/tasks', status: 'unimplemented', decision: '' },
        { kind: 'removed', title: '旧版「原型同步」手动按钮', detail: '代码已删', spec: 'SPEC-projects-12.30', page: '/projects/pj_pmw/prototypes', status: 'offline', decision: '' },
        { kind: 'uncertain', title: '导出只有 CSV', detail: '原型是 CSV 和 Excel 两种', spec: 'SPEC-tasks-2.14', page: '/tasks', status: 'deviation', decision: 'defect' },
      ],
      decision: 'defect', fix_task: 'TSK-0452', summary: '补了档案标签的原型同步块，改了上线审批选项；导出格式判为缺陷', error: '', started_at: hoursAgo(3),
    },
    { id: 'psy_2', trigger: 'daily', status: 'no_change', base_commit: '5be0a91c44', head_commit: '5be0a91c44', proto_branch: '', proto_commit: '', items: [], decision: '', fix_task: '', summary: '', error: '', started_at: hoursAgo(26) },
    { id: 'psy_1', trigger: 'baseline', status: 'baseline', base_commit: '', head_commit: '5be0a91c44', proto_branch: '', proto_commit: '', items: [], decision: '', fix_task: '', summary: '', error: '', started_at: hoursAgo(72) },
  ],
}
