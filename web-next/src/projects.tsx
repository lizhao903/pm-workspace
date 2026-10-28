import { useOpenUrl, useProtoDomain } from './openurl'
import { useMemo, useState } from 'react'
import type { Agent, Session } from './agentdata'
import { AgentAvatar } from './agents'
import type { Contact, ContentItem, Message } from './data'
import { CommsTab, ProjectAgentTab, ProjectSopTab, ProjectTasksTab, StakeholdersTab, projectMessages } from './projecttabs'
import { contactIndex } from './messages'
import { SearchSelect } from './searchselect'
import type { Sop, SopRun } from './sopflow'
import type { Task, TaskStatus } from './taskdata'
import { isOpenTask } from './taskdata'
import {
  DOC_KINDS, DOC_STATUS, MATERIAL_KIND, PROTO_STATUS, STAKE_ROLE, portConflict,
  type DocStatus, type Material, type MaterialKind, type Project, type ProjectDoc, type Prototype, type StakeRole,
} from './projectdata'
import { Mark, MarkEditor } from './imagepick'
import { Subnav } from './subnav'
import { PageTitle } from './topbar'
import { cls, timeAgo } from './ui'
import { newId } from './ids'

// 项目：把一个产品相关的东西串起来——沟通（私聊、群聊）、干系人、任务、文档、SOP、Agent、支持材料、原型、目录
// 任务和会话本身记着属于哪个项目（project_id），其余是项目这边记的关联

export type ProjectTab = 'overview' | 'comms' | 'stakeholders' | 'tasks' | 'docs' | 'sop' | 'agents' | 'materials' | 'prototypes' | 'settings'
const TABS: { key: ProjectTab; label: string }[] = [
  { key: 'overview', label: '概览' }, { key: 'comms', label: '沟通' }, { key: 'stakeholders', label: '干系人' }, { key: 'tasks', label: '任务' },
  { key: 'docs', label: '文档' }, { key: 'sop', label: 'SOP' }, { key: 'agents', label: 'Agent' },
  { key: 'materials', label: '支持材料' }, { key: 'prototypes', label: '原型' }, { key: 'settings', label: '设置' },
]
const Pill = ({ label, color }: { label: string; color: string }) => <span className="pill" style={{ '--c': color } as React.CSSProperties}><span className="pill-dot" />{label}</span>
const running = (p: Project) => p.prototypes.filter((x) => x.status === 'running').length
export const ProjectMark = ({ p, size = 22 }: { p: Project; size?: number }) => <Mark image={p.mark?.image} icon={p.mark?.icon} text={p.mark?.text || p.name.slice(0, 1) || '项'} color={p.color} size={size} />
/** 概览里露几个原型、几个干系人 */
const PROTO_PEEK = 5
const STAKE_PEEK = 6
/** 原型页签：已停止的超过这么多个就折叠 */
const STOPPED_FOLD = 6
const STAKE_ORDER: StakeRole[] = ['decider', 'contact', 'owner', 'member', 'informed']
/** 路径里的目录前缀：「materials/a.md」→「materials」；没有就默认放 materials 下 */
const dirOf = (v: string) => (v.includes('/') ? v.slice(0, v.lastIndexOf('/')) : v.trim() ? '' : 'materials')

/** 选本地文件 / 文件夹。浏览器拿不到绝对路径，只拿得到名字，路径按「项目目录下的相对路径」拼 */
function LocalPick({ kind, onPick }: { kind: 'file' | 'folder'; onPick: (names: string[]) => void }) {
  const pickFolder = async () => {
    const w = window as unknown as { showDirectoryPicker?: () => Promise<{ name: string }> }
    if (!w.showDirectoryPicker) return
    try { onPick([(await w.showDirectoryPicker()).name]) } catch { /* 用户取消 */ }
  }
  if (kind === 'folder') return <button type="button" className="act" onClick={pickFolder}>选择文件夹…</button>
  return (
    <label className="act">
      选择文件…
      <input type="file" multiple hidden onChange={(e) => { const fs = Array.from(e.target.files ?? []).map((f) => f.name); if (fs.length) onPick(fs); e.target.value = '' }} />
    </label>
  )
}

/** 二级菜单里「全部项目」的 key；App 收到它时渲染 ProjectsListPage */
export const ALL_PROJECTS = ':all'
/** 菜单里最多露几个最近打开的项目 */
const RECENT_MAX = 6

/**
 * 项目二级菜单，和视频一样只放视图和少量入口：「全部项目」+ 最近打开的几个，完整列表在 ProjectsListPage。
 * recent：最近打开的项目 id，新的在前；不足 RECENT_MAX 个时用其余项目补满。
 * 不传 recent 时退回平铺全部项目（带搜索），给还没接线的调用方用。
 */
export function ProjectsNav({ projects, current, onSelect, onNew, recent }: {
  projects: Project[]; current: string; onSelect: (id: string) => void; onNew: () => void
  recent?: string[]
}) {
  const item = (p: Project, group?: string) => ({ key: p.id, icon: <ProjectMark p={p} />, label: p.name, desc: running(p) ? `${running(p)} 个原型运行中` : p.root.split('/').pop() || '未设目录', group })
  if (!recent) {
    return (
      <Subnav title="项目" active={current} onSelect={onSelect} search={{ placeholder: '搜索项目' }} items={projects.map((p) => item(p))}>
        <NewProjectBtn onNew={onNew} />
      </Subnav>
    )
  }
  const byId = new Map(projects.map((p) => [p.id, p]))
  const ids = [...new Set([...recent, ...projects.map((p) => p.id)])].filter((id) => byId.has(id)).slice(0, RECENT_MAX)
  // 当前打开的项目总在菜单里，挤掉最后一个
  if (byId.has(current) && !ids.includes(current)) ids.splice(RECENT_MAX - 1, 1, current)
  return (
    <Subnav title="项目" active={current} onSelect={onSelect} items={[
      { key: ALL_PROJECTS, label: '全部项目', desc: `${projects.length} 个`, group: '视图' },
      ...ids.map((id) => item(byId.get(id)!, '最近打开')),
    ]}>
      <NewProjectBtn onNew={onNew} />
    </Subnav>
  )
}

function NewProjectBtn({ onNew }: { onNew: () => void }) {
  return (
    <button className="subnav-new" onClick={onNew}>
      <svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      新建项目
    </button>
  )
}

/* ---------- 全部项目：卡片网格，可搜索、按状态筛 ---------- */

type ProjFilter = '' | 'running' | 'pending' | 'other'
const PROJ_GROUPS: { key: Exclude<ProjFilter, ''>; label: string }[] = [
  { key: 'running', label: '有原型在跑' }, { key: 'pending', label: '有待回复' }, { key: 'other', label: '其他' },
]
/** 每组先露几个，多的点「显示全部」 */
const GROUP_PEEK = 12

export function ProjectsListPage({ projects, messages, contacts, tasks, recent, onOpen, onNew }: {
  projects: Project[]; messages: Message[]; contacts: Contact[]; tasks: Task[]
  /** 最近打开的项目 id，新的在前；用来排序 */
  recent?: string[]
  onOpen: (id: string) => void
  onNew: () => void
}) {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<ProjFilter>('')
  const [sort, setSort] = useState<'recent' | 'name'>(recent ? 'recent' : 'name')
  const [expanded, setExpanded] = useState<string[]>([])
  // 每个项目的待回复数、未完成任务数一次算好；联系人索引只建一次
  const stats = useMemo(() => {
    const people = contactIndex(contacts)
    const open = new Map<string, number>()
    for (const t of tasks) if (t.project_id && isOpenTask(t.status)) open.set(t.project_id, (open.get(t.project_id) ?? 0) + 1)
    return new Map(projects.map((p) => [p.id, {
      pending: projectMessages(p, messages, contacts, people).filter((m) => m.status === 'pending').length,
      tasks: open.get(p.id) ?? 0,
    }]))
  }, [projects, messages, contacts, tasks])
  const st = (p: Project) => stats.get(p.id) ?? { pending: 0, tasks: 0 }
  const groupOf = (p: Project): Exclude<ProjFilter, ''> => (running(p) ? 'running' : st(p).pending ? 'pending' : 'other')
  const rank = new Map((recent ?? []).map((id, i) => [id, i]))
  const kw = q.trim().toLowerCase()
  const rows = projects
    .filter((p) => (!filter || groupOf(p) === filter) && (!kw || `${p.name} ${p.desc} ${p.root}`.toLowerCase().includes(kw)))
    .sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name, 'zh-CN') : (a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9))
  const n = (k: Exclude<ProjFilter, ''>) => projects.filter((p) => groupOf(p) === k).length

  const card = (p: Project) => {
    const s = st(p)
    return (
      <button key={p.id} className="pl-card" onClick={() => onOpen(p.id)} title={p.name}>
        <span className="pl-card-head"><ProjectMark p={p} size={28} /><b className="pl-card-name">{p.name}</b></span>
        <span className="pl-card-desc">{p.desc || <span className="faint">没有说明</span>}</span>
        <span className="pl-card-meta">
          {p.prototypes.length > 0 && <span className={cls(running(p) > 0 && 'pl-ok')}><span className={cls('proto-light', running(p) > 0 && 'pl-running')} />原型 {running(p)}/{p.prototypes.length}</span>}
          {s.pending > 0 && <span className="pl-warn">{s.pending} 条待回复</span>}
          <span>{s.tasks ? `${s.tasks} 个未完成任务` : '没有未完成任务'}</span>
          <span className="ellipsis mono" title={p.root}>{p.root.split('/').pop() || '未设目录'}</span>
        </span>
      </button>
    )
  }

  // 没筛选、没搜索时按状态分组，每组先露 GROUP_PEEK 个
  const grouped = !filter && !kw
  return (
    <div className="page page-fill">
      <PageTitle parent="项目" count={projects.length} desc="按状态分组；点卡片打开项目" actions={
        <button className="btn btn-primary" onClick={onNew}>
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          新建项目
        </button>
      }>全部项目</PageTitle>
      <div className="toolbar">
        <div className="search">
          <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder="搜项目名、说明、目录" value={q} onChange={(e) => setQ(e.target.value)} />
          {q && <button className="search-clear" onClick={() => setQ('')} title="清空"><svg viewBox="0 0 16 16" width="12" height="12"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg></button>}
        </div>
        <div className="seg">
          <button className={cls(!filter && 'on')} onClick={() => setFilter('')}>全部<span className="seg-n">{projects.length}</span></button>
          {PROJ_GROUPS.map((g) => <button key={g.key} className={cls(filter === g.key && 'on')} onClick={() => setFilter(g.key)}>{g.label}<span className="seg-n">{n(g.key)}</span></button>)}
        </div>
        <span className="spacer" />
        <label className="sort">
          排序
          <select value={sort} onChange={(e) => setSort(e.target.value as 'recent' | 'name')}>
            {recent && <option value="recent">最近打开</option>}
            <option value="name">名称</option>
          </select>
        </label>
      </div>
      {!projects.length ? (
        <div className="empty"><div className="empty-title">还没有项目</div><div className="list-sub">把一个产品相关的沟通、干系人、任务、文档和原型串到一起</div><button className="btn btn-primary" onClick={onNew}>新建第一个项目</button></div>
      ) : !rows.length ? (
        <div className="empty"><div className="empty-title">没有匹配的项目</div><div className="list-sub">换个关键词，或清掉状态筛选</div></div>
      ) : grouped ? (
        <div className="pl-groups">
          {PROJ_GROUPS.map((g) => {
            const xs = rows.filter((p) => groupOf(p) === g.key)
            if (!xs.length) return null
            const all = expanded.includes(g.key)
            return (
              <section key={g.key} className="pl-group">
                <div className="mount-head">
                  <div className="field-group-title">{g.label}<span className="field-hint">{xs.length} 个</span></div>
                  {xs.length > GROUP_PEEK && <button className="act act-quiet" onClick={() => setExpanded(all ? expanded.filter((x) => x !== g.key) : [...expanded, g.key])}>{all ? '收起' : `显示全部 ${xs.length} 个`}</button>}
                </div>
                <div className="pl-grid">{(all ? xs : xs.slice(0, GROUP_PEEK)).map(card)}</div>
              </section>
            )
          })}
        </div>
      ) : (
        <div className="pl-grid">{rows.map(card)}</div>
      )}
    </div>
  )
}

/** 路径输入：可以手填，也可以点「选择」用系统的目录选择器（浏览器拿不到绝对路径，只能填进目录名，要补全上级） */
function PathInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const pick = async () => {
    const w = window as unknown as { showDirectoryPicker?: () => Promise<{ name: string }> }
    if (!w.showDirectoryPicker) return
    try {
      const h = await w.showDirectoryPicker()
      const parent = value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : ''
      onChange(parent ? `${parent}/${h.name}` : h.name)
    } catch { /* 用户取消 */ }
  }
  return (
    // 和页面其它输入框同一套外观：浅底、圆角、聚焦时描边加光圈；图标和「选择」按钮收在框里
    <span className="path-box">
      <svg className="path-ico" viewBox="0 0 16 16" width="14" height="14"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
      <input className="mono" value={value} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="path-pick" onClick={pick} title="浏览器只能拿到选中目录的名字，上级路径要自己补">选择</button>
    </span>
  )
}

function ProtoCard({ p, project, projects, onStart, onStop, onChange, onRemove }: {
  p: Prototype; project: Project; projects: Project[]
  onStart: () => void; onStop: () => void; onChange: (x: Prototype) => void; onRemove: () => void
}) {
  const [edit, setEdit] = useState(false)
  const [d, setD] = useState(p)
  const [logs, setLogs] = useState(false)
  const busy = p.status === 'starting' || p.status === 'stopping'
  const live = p.status === 'running'
  const conflict = !live && !busy ? portConflict(p.port, p.id, projects) : null
  const url = `http://127.0.0.1:${p.port}`
  const openUrl = useOpenUrl()
  const domain = useProtoDomain()(p.id)
  return (
    <div className={cls('proto-card', `proto-${p.status}`)}>
      <div className="proto-head">
        <span className={cls('proto-light', `pl-${p.status}`)} />
        <span className="proto-name">{p.name}</span>
        <Pill {...PROTO_STATUS[p.status]} />
        <span className="spacer" />
        {domain && <button className="proto-domain mono" onClick={() => navigator.clipboard?.writeText(domain)} title="内网域名，点一下复制">{domain.replace(/^https?:\/\//, '')}</button>}
        {live && <button className="act" onClick={() => openUrl(url, p.name)} title="在内置浏览器里打开">打开 :{p.port}</button>}
        {live || p.status === 'stopping'
          ? <button className="act" disabled={busy} onClick={onStop}>{p.status === 'stopping' ? '停止中…' : '停止'}</button>
          : <button className="act act-primary" disabled={busy || !!conflict} title={conflict ?? undefined} onClick={onStart}>{p.status === 'starting' ? '启动中…' : p.status === 'error' ? '重新启动' : '启动'}</button>}
      </div>
      <div className="proto-meta">
        <span><span className="proto-k">目录</span><code>{project.root ? `${project.root}/` : ''}{p.dir}</code></span>
        <span><span className="proto-k">命令</span><code>{p.command}</code></span>
        <span><span className="proto-k">端口</span><code>{p.port}</code></span>
        {live && p.started_at && <span><span className="proto-k">已运行</span>{timeAgo(p.started_at).replace('前', '')}</span>}
      </div>
      {conflict && <div className="proto-warn">{conflict}，换一个端口再启动</div>}
      {p.status === 'error' && p.error && <div className="proto-warn">{p.error}</div>}
      <div className="act-row">
        <button className="act act-quiet" onClick={() => setLogs(!logs)} disabled={!p.logs.length}>{logs ? '收起日志' : '看日志'}</button>
        <button className="act act-quiet" disabled={live || busy} title={live ? '先停下来再改' : undefined} onClick={() => { setD(p); setEdit(!edit) }}>{edit ? '收起设置' : '修改'}</button>
        <span className="spacer" />
        <button className="act act-quiet btn-danger-ghost" disabled={live || busy} onClick={onRemove}>移除</button>
      </div>
      {logs && <pre className="proto-logs">{p.logs.join('\n')}</pre>}
      {edit && (
        <div className="proto-edit form">
          <div className="field-row">
            <label className="field"><span className="field-label">名称</span><input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></label>
            <label className="field"><span className="field-label">端口</span><input type="number" value={d.port} onChange={(e) => setD({ ...d, port: Number(e.target.value) })} /></label>
          </div>
          <label className="field"><span className="field-label">目录<span className="field-hint">相对项目目录</span></span><input className="mono" value={d.dir} onChange={(e) => setD({ ...d, dir: e.target.value })} /></label>
          <label className="field"><span className="field-label">启动命令</span><input className="mono" value={d.command} onChange={(e) => setD({ ...d, command: e.target.value })} /></label>
          {portConflict(d.port, d.id, projects) && <span className="field-err">{portConflict(d.port, d.id, projects)}</span>}
          <div className="act-row">
            <button className="act act-primary" disabled={!d.name.trim() || !d.command.trim()} onClick={() => { onChange({ ...d, status: 'stopped', error: undefined }); setEdit(false) }}>保存</button>
            <button className="act act-quiet" onClick={() => setEdit(false)}>取消</button>
          </div>
        </div>
      )}
    </div>
  )
}

export interface ProjectLinks {
  messages: Message[]; contacts: Contact[]; tasks: Task[]; sops: Sop[]; runs: SopRun[]; sessions: Session[]
  onOpenMessage: (id: string) => void; onOpenContact: (id: string) => void
  onNewTask: () => void; onOpenTask: (id: string) => void; onTaskStatus: (id: string, s: TaskStatus) => void
  onStartSop: (id: string) => void; onOpenRun: (id: string) => void; onOpenSop: (id: string) => void
  onOpenSession: (id: string) => void
  /** 去会话页看这个项目的全部会话（会话页按项目筛）；不传就在项目里就地展开 */
  onAllSessions?: () => void
  onFetchAttachment: (msgId: string, attId: string) => void
  onAddAttachment: (projectId: string, msgId: string, attId: string) => void
}

export function ProjectPage({ project, projects, agents, content, tab, onTab, onChange, onDelete, onStart, onStop, onOpenDoc, onChat, onOpenAgent, links, delImpact, onAll }: {
  /** 顶栏「项目」点回项目列表 */
  onAll?: () => void
  links: ProjectLinks
  project: Project
  projects: Project[]
  agents: Agent[]
  content: ContentItem[]
  tab: ProjectTab
  onTab: (t: ProjectTab) => void
  onChange: (p: Project) => void
  onDelete: () => void
  /** 删除的连带影响，列在确认里 */
  delImpact?: string[]
  onStart: (protoId: string) => void
  onStop: (protoId: string) => void
  onOpenDoc: (contentId: string) => void
  onChat: (agentId: string) => void
  onOpenAgent: (agentId: string) => void
}) {
  const p = project
  const set = (x: Partial<Project>) => onChange({ ...p, ...x })
  const agent = agents.find((a) => a.id === p.agent_ids[0])
  const openUrl = useOpenUrl()
  const L = links
  const pmsgs = projectMessages(p, L.messages, L.contacts)
  const ptasks = L.tasks.filter((t) => t.project_id === p.id)
  const openTasks = ptasks.filter((t) => isOpenTask(t.status))
  const [newMat, setNewMat] = useState<Omit<Material, 'id' | 'added_at'> | null>(null)
  const [matTag, setMatTag] = useState('')
  const [newDoc, setNewDoc] = useState<{ title: string; kind: string; type: 'library' | 'file'; ref: string } | null>(null)
  const [newProto, setNewProto] = useState<{ name: string; dir: string; command: string; port: number } | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)
  const [matQ, setMatQ] = useState('')
  const [matKind, setMatKind] = useState<MaterialKind | ''>('')
  const [showStopped, setShowStopped] = useState(false)
  const tags = [...new Set(p.materials.flatMap((m) => m.tags))]
  const matKw = matQ.trim().toLowerCase()
  const matOk = (m: Material) => (!matTag || m.tags.includes(matTag)) && (!matKind || m.kind === matKind) && (!matKw || `${m.name} ${m.value} ${m.tags.join(' ')}`.toLowerCase().includes(matKw))
  const mats = p.materials.filter(matOk)
  // 原型：运行中、启动失败、启停中的排前面
  const protoRank = (x: Prototype) => (x.status === 'running' ? 0 : x.status === 'error' ? 1 : x.status === 'stopped' ? 3 : 2)
  const protos = [...p.prototypes].sort((a, b) => protoRank(a) - protoRank(b))

  const freePort = () => {
    for (let n = 7780; n < 7900; n += 1) if (!portConflict(n, '', projects) && !projects.some((x) => x.prototypes.some((y) => y.port === n))) return n
    return 7899
  }

  const actions = {
    overview: <button className="btn btn-outline" onClick={() => onTab('settings')}>项目设置</button>,
    comms: null, stakeholders: null, tasks: null, sop: null, agents: null,
    materials: <button className="btn btn-primary" onClick={() => setNewMat({ name: '', kind: 'file', value: '', tags: [] })}>加材料</button>,
    docs: <button className="btn btn-primary" onClick={() => setNewDoc({ title: '', kind: 'PRD', type: 'library', ref: content[0]?.id ?? '' })}>加文档</button>,
    prototypes: <button className="btn btn-primary" onClick={() => setNewProto({ name: '', dir: '', command: 'npm run dev', port: freePort() })}>加原型</button>,
    settings: null,
  }[tab]

  return (
    <div className="page page-fill project-page">
      <PageTitle parent={onAll ? <button className="tb-parent-btn" onClick={onAll} title="回到项目列表">项目</button> : '项目'} desc={p.desc} actions={actions} icon={<ProjectMark p={p} size={20} />}>{p.name}</PageTitle>
      <div className="project-tabs np-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={cls(tab === t.key && 'on')} onClick={() => onTab(t.key)}>
            {t.label}
            {t.key === 'prototypes' && running(p) > 0 && <span className="proto-light pl-running" />}
            {t.key === 'comms' && pmsgs.some((m) => m.status === 'pending') && <span className="side-dot" />}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="proj-overview">
          <div className="stats">
            <button className="stat stat-btn" onClick={() => onTab('comms')}><div className="stat-label">待回复消息</div><div className={cls('stat-value', pmsgs.some((m) => m.status === 'pending') && 'stat-danger')}>{pmsgs.filter((m) => m.status === 'pending').length}</div></button>
            <button className="stat stat-btn" onClick={() => onTab('tasks')}><div className="stat-label">未完成任务</div><div className="stat-value">{openTasks.length}</div></button>
            <button className="stat stat-btn" onClick={() => onTab('stakeholders')}><div className="stat-label">干系人</div><div className="stat-value">{p.stakeholders.length}</div></button>
            <button className="stat stat-btn" onClick={() => onTab('docs')}><div className="stat-label">产品文档</div><div className="stat-value">{p.docs.length}</div></button>
            <button className="stat stat-btn" onClick={() => onTab('prototypes')}><div className="stat-label">原型运行中</div><div className="stat-value stat-ok">{running(p)} / {p.prototypes.length}</div></button>
          </div>
          <div className="proj-grid">
            <section className="hook-sec">
              <div className="mount-head"><div className="field-group-title">最新沟通</div><button className="act act-quiet" onClick={() => onTab('comms')}>全部</button></div>
              {pmsgs.length ? [...pmsgs].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 4).map((m) => (
                <button key={m.id} className="proj-proto-line" onClick={() => L.onOpenMessage(m.id)}>
                  <span className={cls('today-dot', m.status === 'pending' ? 'td-info' : 'td-done')} /><b className="pt-who">{m.sender_name}</b><span className="ellipsis">{m.text}</span><span className="spacer" /><span className="run-muted">{timeAgo(m.at)}</span>
                </button>
              )) : <div className="mount-empty">还没绑定沟通渠道。<button className="link-btn" onClick={() => onTab('comms')}>去绑定</button></div>}
            </section>
            <section className="hook-sec">
              <div className="mount-head"><div className="field-group-title">进行中的任务</div><button className="act act-quiet" onClick={() => onTab('tasks')}>全部</button></div>
              {openTasks.length ? openTasks.sort((a, b) => a.priority.localeCompare(b.priority)).slice(0, 5).map((t) => (
                <button key={t.id} className="proj-proto-line" onClick={() => L.onOpenTask(t.id)}>
                  <span className="task-ref">{t.ref}</span><span className="ellipsis">{t.title}</span><span className="spacer" /><span className="run-muted">{t.assignee}</span>
                </button>
              )) : <div className="mount-empty">没有未完成的任务</div>}
            </section>
            <section className="hook-sec">
              <div className="mount-head"><div className="field-group-title">干系人</div><button className="act act-quiet" onClick={() => onTab('stakeholders')}>全部</button></div>
              {p.stakeholders.length ? <div className="proj-stakes">{[...p.stakeholders].sort((a, b) => STAKE_ORDER.indexOf(a.role) - STAKE_ORDER.indexOf(b.role)).slice(0, STAKE_PEEK).map((x) => {
                const c = L.contacts.find((y) => y.id === x.contact_id)
                return c && <button key={x.contact_id} className="tag kb-user" onClick={() => L.onOpenContact(c.id)} title={x.focus ? `${c.name}：${x.focus}` : c.name}><span className="kb-user-name">{c.name} · {STAKE_ROLE[x.role].label}</span></button>
              })}{p.stakeholders.length > STAKE_PEEK && <button className="tag" onClick={() => onTab('stakeholders')} title="看全部干系人">+{p.stakeholders.length - STAKE_PEEK}</button>}</div> : <div className="mount-empty">还没有干系人</div>}
            </section>
            <section className="hook-sec">
              <div className="field-group-title">项目目录</div>
              <code className="proj-root">{p.root || '还没设置'}</code>
              {p.related.length > 0 && <div className="proj-related">{p.related.map((r) => <span key={r.path} className="tag" title={r.path}>{r.label}</span>)}</div>}
            </section>
            <section className="hook-sec">
              <div className="mount-head"><div className="field-group-title">项目 Agent</div><button className="act act-quiet" onClick={() => onTab('agents')}>全部</button></div>
              {agent ? (
                <div className="proj-agent">
                  <AgentAvatar agent={agent} size={36} />
                  <span className="mount-text"><b>{agent.name}</b><span className="list-sub">{agent.desc}</span></span>
                  <button className="act act-primary" disabled={!agent.enabled} onClick={() => onChat(agent.id)}>和它对话</button>
                </div>
              ) : <div className="mount-empty">还没设置。<button className="link-btn" onClick={() => onTab('settings')}>去设置</button></div>}
            </section>
            <section className="hook-sec">
              <div className="mount-head"><div className="field-group-title">原型{p.prototypes.length > PROTO_PEEK && <span className="field-hint">共 {p.prototypes.length} 个</span>}</div>{p.prototypes.length > 0 && <button className="act act-quiet" onClick={() => onTab('prototypes')}>全部</button>}</div>
              {protos.length ? protos.slice(0, PROTO_PEEK).map((x) => (
                <div key={x.id} className="proj-proto-line">
                  <span className={cls('proto-light', `pl-${x.status}`)} /><span className="ellipsis">{x.name}</span><code>:{x.port}</code>
                  <span className="spacer" />
                  {x.status === 'running' ? <><button className="act act-quiet" onClick={() => openUrl(`http://127.0.0.1:${x.port}`, x.name)}>打开</button><button className="act" onClick={() => onStop(x.id)}>停止</button></>
                    : <button className="act" disabled={x.status === 'starting' || x.status === 'stopping' || !!portConflict(x.port, x.id, projects)} onClick={() => onStart(x.id)}>{PROTO_STATUS[x.status].label === '已停止' ? '启动' : PROTO_STATUS[x.status].label}</button>}
                </div>
              )) : <div className="mount-empty">还没有原型</div>}
            </section>
            <section className="hook-sec">
              <div className="field-group-title">最近的文档和材料</div>
              {[...p.docs.map((x) => ({ k: `d${x.id}`, t: x.title, at: x.updated_at, tag: x.kind })), ...p.materials.map((x) => ({ k: `m${x.id}`, t: x.name, at: x.added_at, tag: MATERIAL_KIND[x.kind] }))]
                .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5).map((x) => (
                  <div key={x.k} className="proj-proto-line"><span className="tag">{x.tag}</span><span className="ellipsis">{x.t}</span><span className="spacer" /><span className="run-muted">{timeAgo(x.at)}</span></div>
                ))}
            </section>
          </div>
        </div>
      )}

      {tab === 'comms' && <CommsTab p={p} messages={L.messages} contacts={L.contacts} onChange={set} onOpenMessage={L.onOpenMessage}
        onFetchAttachment={L.onFetchAttachment} onAddAttachment={(mid, aid) => L.onAddAttachment(p.id, mid, aid)} />}
      {tab === 'stakeholders' && <StakeholdersTab p={p} contacts={L.contacts} messages={L.messages} onChange={set} onOpenContact={L.onOpenContact} onOpenMessage={L.onOpenMessage} />}
      {tab === 'tasks' && <ProjectTasksTab p={p} tasks={L.tasks} onNew={L.onNewTask} onOpen={L.onOpenTask} onStatus={L.onTaskStatus} />}
      {tab === 'sop' && <ProjectSopTab p={p} sops={L.sops} runs={L.runs} onChange={set} onStart={L.onStartSop} onOpenRun={L.onOpenRun} onOpenSop={L.onOpenSop} />}
      {tab === 'agents' && <ProjectAgentTab p={p} agents={agents} sessions={L.sessions} onChange={set} onChat={onChat} onOpenAgent={onOpenAgent} onOpenSession={L.onOpenSession} onAllSessions={L.onAllSessions} />}
      {tab === 'materials' && (
        <>
          {newMat && (
            <div className="inline-form">
              <div className="seg seg-sm">{(Object.keys(MATERIAL_KIND) as MaterialKind[]).map((k) => <button key={k} className={cls(newMat.kind === k && 'on')} onClick={() => setNewMat({ ...newMat, kind: k })}>{MATERIAL_KIND[k]}</button>)}</div>
              <input value={newMat.name} placeholder="名称，比如：客户访谈纪要 10/20" onChange={(e) => setNewMat({ ...newMat, name: e.target.value })} />
              {newMat.kind === 'note' ? (
                <textarea rows={3} value={newMat.value} placeholder="内容" onChange={(e) => setNewMat({ ...newMat, value: e.target.value })} />
              ) : newMat.kind === 'link' ? (
                <input className="mono" value={newMat.value} placeholder="https://…" onChange={(e) => setNewMat({ ...newMat, value: e.target.value })} />
              ) : (
                <>
                  <span className="secret-line">
                    <input className="mono" value={newMat.value} placeholder={newMat.kind === 'file' ? '相对项目目录的路径，比如 materials/interview.md' : '相对项目目录的路径，比如 materials/screenshots'} onChange={(e) => setNewMat({ ...newMat, value: e.target.value })} />
                    <LocalPick kind={newMat.kind} onPick={(names) => {
                      const dir = dirOf(newMat.value)
                      const path = (n: string) => (dir ? `${dir}/${n}` : n)
                      // 一次选了好几个文件：每个文件各加一条材料，直接加上
                      if (names.length > 1) {
                        const now = new Date().toISOString()
                        set({ materials: [...names.map((n) => ({ id: newId('mt'), name: n, kind: 'file' as const, value: path(n), tags: newMat.tags, added_at: now })), ...p.materials] })
                        setNewMat(null)
                        return
                      }
                      setNewMat({ ...newMat, value: path(names[0]), name: newMat.name || names[0] })
                    }} />
                  </span>
                  <span className="list-sub">浏览器只拿得到{newMat.kind === 'file' ? '文件' : '文件夹'}名，路径按项目目录下的相对路径拼{p.root ? `：${p.root}/…` : ''}；选多个文件会各加一条</span>
                </>
              )}
              <input value={newMat.tags.join(', ')} placeholder="标签，逗号隔开" onChange={(e) => setNewMat({ ...newMat, tags: e.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean) })} />
              <div className="act-row">
                <button className="act act-primary" disabled={!newMat.name.trim() || !newMat.value.trim()} onClick={() => { set({ materials: [{ ...newMat, id: newId('mt'), added_at: new Date().toISOString() }, ...p.materials] }); setNewMat(null) }}>加上</button>
                <button className="act act-quiet" onClick={() => setNewMat(null)}>取消</button>
              </div>
            </div>
          )}
          {p.materials.length > 0 && (
            <div className="toolbar">
              <div className="search">
                <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                <input placeholder="搜名称、路径、链接、内容" value={matQ} onChange={(e) => setMatQ(e.target.value)} />
                {matQ && <button className="search-clear" onClick={() => setMatQ('')} title="清空"><svg viewBox="0 0 16 16" width="12" height="12"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg></button>}
              </div>
              <div className="seg seg-sm">
                <button className={cls(!matKind && 'on')} onClick={() => setMatKind('')}>全部<span className="seg-n">{p.materials.length}</span></button>
                {(Object.keys(MATERIAL_KIND) as MaterialKind[]).filter((k) => p.materials.some((m) => m.kind === k)).map((k) => (
                  <button key={k} className={cls(matKind === k && 'on')} onClick={() => setMatKind(k)}>{MATERIAL_KIND[k]}<span className="seg-n">{p.materials.filter((m) => m.kind === k).length}</span></button>
                ))}
              </div>
            </div>
          )}
          {tags.length > 0 && (
            <div className="filter-row proj-filter">
              <button className={cls('fchip', !matTag && 'on')} onClick={() => setMatTag('')}>全部标签</button>
              {tags.map((t) => <button key={t} className={cls('fchip', matTag === t && 'on')} onClick={() => setMatTag(matTag === t ? '' : t)}>{t}</button>)}
            </div>
          )}
          <div className="mat-list">
            {mats.map((m) => (
              <div key={m.id} className="mount-card">
                <span className={`mat-kind mk-${m.kind}`}>{MATERIAL_KIND[m.kind]}</span>
                <span className="mount-text">
                  <b>{m.name}</b>
                  {m.kind === 'note' ? <span className="list-sub pre-line">{m.value}</span>
                    : m.kind === 'link' && /^https?:/.test(m.value) ? <a className="link-btn ellipsis mat-link" href={m.value} target="_blank" rel="noreferrer" title={m.value}>{m.value}</a>
                      : <code className="mat-path">{(m.kind === 'file' || m.kind === 'folder') && p.root && !m.from ? `${p.root}/` : ''}{m.value}{m.kind === 'folder' ? '/' : ''}</code>}
                  <span className="mount-uses">{m.tags.map((t) => `#${t}`).join(' ')} {timeAgo(m.added_at)}加入
                    {m.from && <> · 来自 <button className="link-btn" onClick={() => L.onOpenMessage(m.from!.message_id)}>{m.from.sender}（{m.from.conversation}）的消息</button></>}</span>
                </span>
                <button className="icon-btn icon-btn-sm" title="移除" onClick={() => set({ materials: p.materials.filter((x) => x.id !== m.id) })}>
                  <svg viewBox="0 0 16 16" width="11" height="11"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                </button>
              </div>
            ))}
            {p.materials.length > 0 && !mats.length && (
              <div className="empty"><div className="empty-title">没有匹配的材料</div><div className="list-sub">换个关键词，或清掉类型和标签筛选</div></div>
            )}
            {!p.materials.length && !newMat && <div className="empty"><div className="empty-title">还没有支持材料</div><div className="list-sub">访谈纪要、竞品截图、需求原文、参考链接都可以放这里</div></div>}
          </div>
        </>
      )}

      {tab === 'docs' && (
        <>
          {newDoc && (
            <div className="inline-form">
              <div className="seg seg-sm">
                <button className={cls(newDoc.type === 'library' && 'on')} onClick={() => setNewDoc({ ...newDoc, type: 'library', ref: content[0]?.id ?? '' })}>关联「文档」里的</button>
                <button className={cls(newDoc.type === 'file' && 'on')} onClick={() => setNewDoc({ ...newDoc, type: 'file', ref: '' })}>项目目录里的文件</button>
              </div>
              {newDoc.type === 'library' ? (
                <SearchSelect variant="field" value={newDoc.ref} placeholder="选一篇文档" searchPlaceholder="搜文档标题" missingLabel={() => '已删除的文档'}
                  options={content.map((c) => ({ value: c.id, label: c.title, hint: p.docs.some((d) => d.source.type === 'library' && d.source.content_id === c.id) ? '已关联' : undefined }))}
                  emptyText="「文档」里还没有文档"
                  onChange={(v) => setNewDoc({ ...newDoc, ref: v, title: newDoc.title || content.find((c) => c.id === v)?.title || '' })} />
              ) : <input className="mono" value={newDoc.ref} placeholder="相对项目目录的路径，比如 docs/prd.md" onChange={(e) => setNewDoc({ ...newDoc, ref: e.target.value })} />}
              <div className="field-row">
                <input value={newDoc.title} placeholder="标题（留空用文档原标题）" onChange={(e) => setNewDoc({ ...newDoc, title: e.target.value })} />
                <select value={newDoc.kind} onChange={(e) => setNewDoc({ ...newDoc, kind: e.target.value })}>{DOC_KINDS.map((k) => <option key={k}>{k}</option>)}</select>
              </div>
              <div className="act-row">
                <button className="act act-primary" disabled={!newDoc.ref.trim()} onClick={() => {
                  const title = newDoc.title.trim() || (newDoc.type === 'library' ? content.find((c) => c.id === newDoc.ref)?.title ?? '' : newDoc.ref.split('/').pop() ?? '')
                  const doc: ProjectDoc = { id: newId('pd'), title, kind: newDoc.kind, status: 'draft', source: newDoc.type === 'library' ? { type: 'library', content_id: newDoc.ref } : { type: 'file', path: newDoc.ref }, updated_at: new Date().toISOString() }
                  set({ docs: [doc, ...p.docs] }); setNewDoc(null)
                }}>加上</button>
                <button className="act act-quiet" onClick={() => setNewDoc(null)}>取消</button>
              </div>
            </div>
          )}
          {p.docs.length ? (
            <div className="task-table">
              <div className="pdoc-row task-th"><span>文档</span><span>类型</span><span>来源</span><span>状态</span><span>更新</span><span /></div>
              {p.docs.map((x) => (
                <div key={x.id} className="pdoc-row">
                  <span className="ellipsis">{x.source.type === 'library' ? <button className="link-btn" onClick={() => onOpenDoc((x.source as { content_id: string }).content_id)}>{x.title}</button> : x.title}</span>
                  <span><span className="tag">{x.kind}</span></span>
                  <span className="run-muted ellipsis">{x.source.type === 'library' ? '文档库' : <code>{x.source.path}</code>}</span>
                  <span>
                    <select className="pdoc-status" value={x.status} style={{ '--c': DOC_STATUS[x.status].color } as React.CSSProperties}
                      onChange={(e) => set({ docs: p.docs.map((y) => (y.id === x.id ? { ...y, status: e.target.value as DocStatus, updated_at: new Date().toISOString() } : y)) })}>
                      {(Object.keys(DOC_STATUS) as DocStatus[]).map((k) => <option key={k} value={k}>{DOC_STATUS[k].label}</option>)}
                    </select>
                  </span>
                  <span className="run-muted">{timeAgo(x.updated_at)}</span>
                  <span><button className="act act-quiet" onClick={() => set({ docs: p.docs.filter((y) => y.id !== x.id) })}>移除</button></span>
                </div>
              ))}
            </div>
          ) : !newDoc && <div className="empty"><div className="empty-title">还没有产品文档</div><div className="list-sub">可以关联「文档」里的 PRD，也可以指向项目目录里的文件</div></div>}
        </>
      )}

      {tab === 'prototypes' && (
        <>
          {!p.root && <div className="mount-empty">先在「设置」里填项目目录，原型的目录相对它来算</div>}
          {newProto && (
            <div className="inline-form">
              <div className="field-row">
                <input value={newProto.name} placeholder="原型名称，比如：权限配置原型" onChange={(e) => setNewProto({ ...newProto, name: e.target.value })} />
                <input type="number" value={newProto.port} onChange={(e) => setNewProto({ ...newProto, port: Number(e.target.value) })} />
              </div>
              <input className="mono" value={newProto.dir} placeholder="目录（相对项目目录），比如 prototype" onChange={(e) => setNewProto({ ...newProto, dir: e.target.value })} />
              <input className="mono" value={newProto.command} placeholder="启动命令" onChange={(e) => setNewProto({ ...newProto, command: e.target.value })} />
              {portConflict(newProto.port, '', projects) && <span className="field-err">{portConflict(newProto.port, '', projects)}</span>}
              <div className="act-row">
                <button className="act act-primary" disabled={!newProto.name.trim() || !newProto.command.trim()} onClick={() => { set({ prototypes: [...p.prototypes, { ...newProto, id: newId('pt'), status: 'stopped', logs: [] }] }); setNewProto(null) }}>加上</button>
                <button className="act act-quiet" onClick={() => setNewProto(null)}>取消</button>
                <span className="list-sub">端口默认给一个没被占用的</span>
              </div>
            </div>
          )}
          <div className="proto-list">
            {(() => {
              // 已停止的超过 STOPPED_FOLD 个时折叠成一行，点开再展
              const stopped = protos.filter((x) => x.status === 'stopped')
              const fold = stopped.length > STOPPED_FOLD
              const card = (x: Prototype) => (
                <ProtoCard key={x.id} p={x} project={p} projects={projects} onStart={() => onStart(x.id)} onStop={() => onStop(x.id)}
                  onChange={(y) => set({ prototypes: p.prototypes.map((z) => (z.id === y.id ? y : z)) })}
                  onRemove={() => set({ prototypes: p.prototypes.filter((z) => z.id !== x.id) })} />
              )
              return (
                <>
                  {protos.filter((x) => !fold || x.status !== 'stopped').map(card)}
                  {fold && (
                    <button className="proto-fold" onClick={() => setShowStopped(!showStopped)} aria-expanded={showStopped}>
                      <span className="proto-light" />已停止 {stopped.length} 个<span className="spacer" /><span className="run-muted">{showStopped ? '收起' : '展开'}</span>
                    </button>
                  )}
                  {fold && showStopped && stopped.map(card)}
                </>
              )
            })()}
            {!p.prototypes.length && !newProto && <div className="empty"><div className="empty-title">还没有原型</div><div className="list-sub">配好目录、启动命令和端口，就能在这里一键启停</div></div>}
          </div>
        </>
      )}

      {tab === 'settings' && (
        <div className="form proj-settings">
          <section className="hook-sec">
            <div className="field-group-title">基本信息</div>
            <div className="name-with-mark">
              <MarkEditor image={p.mark?.image} icon={p.mark?.icon} text={p.mark?.text} color={p.color} textPlaceholder={p.name.slice(0, 1)}
                onIcon={(icon) => set({ mark: { text: p.mark?.text ?? '', ...p.mark, icon } })}
                onImage={(image) => set({ mark: { text: p.mark?.text ?? '', image } })}
                onText={(text) => set({ mark: { ...p.mark, text, icon: text ? undefined : p.mark?.icon } })}
                onColor={(color) => set({ color })}>
                <ProjectMark p={p} size={48} />
              </MarkEditor>
              <label className="field"><span className="field-label">名称</span><input value={p.name} onChange={(e) => set({ name: e.target.value })} /></label>
            </div>
            <label className="field"><span className="field-label">说明</span><input value={p.desc} onChange={(e) => set({ desc: e.target.value })} /></label>
          </section>
          <section className="hook-sec">
            <div className="field-group-title">本地项目目录<span className="field-hint">原型、文件类材料和文档的路径都相对它</span></div>
            <PathInput value={p.root} placeholder="/Users/me/projects/xxx" onChange={(v) => set({ root: v })} />
          </section>
          <section className="hook-sec">
            <div className="mount-head">
              <div className="field-group-title">关联目录<span className="field-hint">和这个项目相关、但不在项目目录里的地方：设计稿、客户资料、别的仓库</span></div>
              <button className="act" onClick={() => set({ related: [...p.related, { path: '', label: '' }] })}>加一个</button>
            </div>
            {p.related.map((r, i) => (
              <div key={i} className="related-row">
                <input className="text-box" value={r.label} placeholder="名称" onChange={(e) => set({ related: p.related.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)) })} />
                <PathInput value={r.path} placeholder="/Volumes/…" onChange={(v) => set({ related: p.related.map((y, j) => (j === i ? { ...y, path: v } : y)) })} />
                <button className="icon-btn icon-btn-sm" title="删除这个关联目录" onClick={() => set({ related: p.related.filter((_, j) => j !== i) })}>
                  <svg viewBox="0 0 16 16" width="11" height="11"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                </button>
              </div>
            ))}
            {!p.related.length && <div className="mount-empty">没有关联目录</div>}
          </section>
          <section className="hook-sec danger-zone">
            <div className="field-group-title">删除项目</div>
            {confirmDel ? (
              <div className="act-row"><span className="danger-text">只删项目记录，本地目录和文件不动{delImpact?.length ? `；${delImpact.join('；')}` : ''}</span><button className="act act-quiet" onClick={() => setConfirmDel(false)}>取消</button><button className="act btn-danger" onClick={onDelete}>删除</button></div>
            ) : <div className="act-row"><span className="list-sub">本地目录和文件不会被删</span><button className="act btn-danger-ghost" onClick={() => setConfirmDel(true)}>删除项目</button></div>}
          </section>
        </div>
      )}
    </div>
  )
}
