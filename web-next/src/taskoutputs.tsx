// 任务产出物一览（TSK-0497，SPEC-tasks-12）：任务列表、看板卡片上的「产出 3 · 提交 2 文档 1」，
// 和任务模块二级菜单「视图」组里的「产出物」：按任务汇总，展开看每一件，「在任务里看」打开抽屉的开发任务标签。
// 正式产品的数据来自 GET /api/artifacts/by-object，种类按后端的 display_kind；原型的产出物没有 kind 列，
// 这里按同一套规则推（备注前缀 → 链接 → 扩展名 → 其他），口径见 docs/api-contract.md「显示种类 display_kind」。
import { useMemo, useState } from 'react'
import { PageTitle } from './topbar'
import { isOpenTask, parseArtifact, type Task, type TaskArtifact, type TaskStatus } from './taskdata'
import { cls, timeAgo } from './ui'
import { SearchSelect } from './searchselect'
import { useOpenUrl } from './openurl'
import './taskoutputs.css'

export const OUTPUT_KINDS: { key: string; label: string }[] = [
  { key: 'commit', label: '提交' }, { key: 'branch', label: '分支' }, { key: 'pr', label: '合并请求' },
  { key: 'doc', label: '文档' }, { key: 'prototype', label: '原型' }, { key: 'code', label: '代码' },
  { key: 'data', label: '数据' }, { key: 'other', label: '其他' },
]
const kindLabel = (k: string) => OUTPUT_KINDS.find((x) => x.key === k)?.label ?? k

const EXT: Record<string, string> = {}
for (const [kind, exts] of Object.entries({
  code: 'go ts tsx js jsx mjs cjs css scss less py rs java kt swift c h cc cpp hpp m rb php sh bash zsh sql vue svelte yaml yml toml mod sum lock gradle proto',
  doc: 'md markdown mdx txt rst pdf doc docx ppt pptx key pages rtf mmd drawio odt',
  prototype: 'html htm fig sketch xd',
  data: 'json jsonl ndjson csv tsv xls xlsx numbers parquet db db-wal db-shm sqlite sqlite3 log',
})) for (const e of exts.split(' ')) EXT[e] = kind

/** 产出物的种类：备注前缀 → 只有链接的按链接 → 本地路径按扩展名 → 其他 */
export function outputKind(a: Pick<TaskArtifact, 'note' | 'url' | 'path'>): string {
  const p = parseArtifact(a.note.trim())
  if (p.kind !== 'file') return p.kind
  if (!a.path && a.url) {
    const u = a.url.toLowerCase()
    if (/\/pull\/\d+/.test(u)) return 'pr'
    if (/\/commit\/[0-9a-f]{6,40}/.test(u)) return 'commit'
    if (u.includes('github.com') && u.includes('/tree/')) return 'branch'
    if (/atlassian\.net|confluence|feishu|larksuite|docs\.google|pagehub/.test(u)) return 'doc'
    if (u.includes('figma.com')) return 'prototype'
    return 'other'
  }
  const base = (a.path ?? '').split('/').pop()!.toLowerCase()
  const dot = base.indexOf('.')
  if (dot >= 0 && EXT[base.slice(dot + 1)]) return EXT[base.slice(dot + 1)]
  const last = base.lastIndexOf('.')
  return (last >= 0 && EXT[base.slice(last + 1)]) || 'other'
}

export type OutputSummary = { total: number; byKind: Record<string, number>; last: string }

/** 每条任务的产出汇总，没有产出的不在里面 */
export function summarize(items: readonly TaskArtifact[]): Map<string, OutputSummary> {
  const m = new Map<string, OutputSummary>()
  for (const a of items) {
    const s = m.get(a.task_id) ?? { total: 0, byKind: {}, last: a.at }
    const k = outputKind(a)
    s.total += 1
    s.byKind[k] = (s.byKind[k] ?? 0) + 1
    if (a.at > s.last) s.last = a.at
    m.set(a.task_id, s)
  }
  return m
}

/** 「3 · 提交 2 文档 1」；只有一种时写成「2 · 提交」 */
export function summaryText(s: OutputSummary): string {
  const parts = OUTPUT_KINDS.filter((k) => s.byKind[k.key]).map((k) => ({ label: k.label, n: s.byKind[k.key] }))
  if (parts.length === 1) return `${s.total} · ${parts[0].label}`
  return `${s.total} · ${parts.map((p) => `${p.label} ${p.n}`).join(' ')}`
}

/** 任务行、看板卡片上的产出标记；点它打开抽屉的产出物（开发任务标签） */
export function OutputsBadge({ s, onOpen }: { s: OutputSummary | undefined; onOpen?: () => void }) {
  if (!s) return null
  const text = summaryText(s)
  return (
    <button className="out-badge" title={`产出物 ${s.total} 件，点开看`} onClick={(e) => { e.stopPropagation(); onOpen?.() }}>产出 {text}</button>
  )
}

/** 任务列表、看板的「产出」筛选 */
export type OutputsFilter = '' | 'with' | 'without'
export const OUTPUTS_FILTERS: [OutputsFilter, string][] = [['', '全部产出'], ['with', '有产出'], ['without', '无产出']]
export const matchOutputs = (id: string, f: OutputsFilter, m: Map<string, OutputSummary>) => !f || (f === 'with' ? m.has(id) : !m.has(id))

const SOURCE_LABEL: Record<TaskArtifact['source'], string> = { agent: '内置 Agent', run: '任务执行', manual: '手工登记', mcp: 'MCP 回写' }
const SINCE: [string, string, number][] = [['7d', '最近 7 天', 7], ['30d', '最近 30 天', 30], ['90d', '最近 90 天', 90]]
const PAGE = 50

const searchIcon = <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>

/** 产出物视图：每条有产出的任务一行，点行展开看每一件 */
export function OutputsPage({ tasks, artifacts, projects, statusLabel, selected, onOpen }: {
  tasks: Task[]
  artifacts: TaskArtifact[]
  projects: { id: string; name: string }[]
  statusLabel: (s: TaskStatus) => string
  selected: string | null
  /** 打开任务抽屉的开发任务标签（产出物在那里） */
  onOpen: (id: string) => void
}) {
  const openUrl = useOpenUrl()
  const [kind, setKind] = useState('')
  const [source, setSource] = useState('')
  const [proj, setProj] = useState('')
  const [since, setSince] = useState('')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState('')
  const kw = q.trim().toLowerCase()
  const taskOf = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])
  const projName = (id?: string | null) => (id ? projects.find((p) => p.id === id)?.name : undefined)

  // 除类型、来源以外的条件：项目、时间（正式产品在后端筛）
  const days = SINCE.find((s) => s[0] === since)?.[2]
  const from = days ? new Date(Date.now() - days * 86400_000).toISOString() : ''
  const base = artifacts.filter((a) => {
    const t = taskOf.get(a.task_id)
    if (!t) return false
    if (proj && (proj === '-' ? !!t.project_id : t.project_id !== proj)) return false
    return !from || a.at >= from
  })
  const textHit = (a: TaskArtifact) => [a.note, a.url ?? '', a.path ?? ''].some((v) => v.toLowerCase().includes(kw))
  // 类型按钮上的数不受类型条件影响，来源下拉的数不受来源条件影响
  const kindN: Record<string, number> = {}
  const sourceN: Record<string, number> = {}
  for (const a of base) {
    const k = outputKind(a)
    if (!source || a.source === source) kindN[k] = (kindN[k] ?? 0) + 1
    if (!kind || k === kind) sourceN[a.source] = (sourceN[a.source] ?? 0) + 1
  }
  const hits = base.filter((a) => (!kind || outputKind(a) === kind) && (!source || a.source === source))
  const sums = summarize(hits)
  const rows = [...sums.entries()]
    .map(([id, s]) => ({ t: taskOf.get(id)!, s }))
    .filter(({ t }) => !kw || `${t.ref} ${t.title} ${projName(t.project_id) ?? ''}`.toLowerCase().includes(kw) || hits.some((a) => a.task_id === t.id && textHit(a)))
    .sort((a, b) => b.s.last.localeCompare(a.s.last))
  const total = rows.reduce((n, r) => n + r.s.total, 0)
  const filtered = !!(kind || source || proj || since || kw)
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  return (
    <div className="page page-fill">
      <PageTitle parent="任务" count={rows.length} desc={`${rows.length} 条任务留下了 ${total} 件产出物；点一行展开看每一件，手工登记的也算`}>产出物</PageTitle>
      <div className="toolbar">
        <div className="seg">
          <button className={cls(!kind && 'on')} onClick={() => { setKind(''); setLimit(PAGE) }}>全部<span className="seg-n">{Object.values(kindN).reduce((a, b) => a + b, 0)}</span></button>
          {OUTPUT_KINDS.filter((k) => kindN[k.key]).map((k) => (
            <button key={k.key} className={cls(kind === k.key && 'on')} onClick={() => { setKind(k.key); setLimit(PAGE) }}>{k.label}<span className="seg-n">{kindN[k.key]}</span></button>
          ))}
        </div>
        <div className="chip chip-select">
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">全部来源</option>
            {(Object.keys(SOURCE_LABEL) as TaskArtifact['source'][]).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}{sourceN[s] ? `（${sourceN[s]}）` : ''}</option>)}
          </select>
        </div>
        <SearchSelect value={proj} onChange={setProj} noneLabel="全部项目" searchPlaceholder="搜项目"
          options={[...projects.map((x) => ({ value: x.id, label: x.name })), { value: '-', label: '不属于项目' }]} missingLabel={() => '已删除的项目'} />
        <div className="chip chip-select">
          <select value={since} onChange={(e) => setSince(e.target.value)}>
            <option value="">全部时间</option>
            {SINCE.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        <span className="spacer" />
        <div className="search">{searchIcon}<input placeholder="搜索任务、产出物标题、路径、链接" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          <div className="empty-title">{filtered ? '没有符合条件的产出' : '还没有任务留下产出物'}</div>
          <div className="list-sub">{filtered ? '换个筛选条件试试' : '交给 Claude Code 执行、Agent 回写提交和文档、在任务抽屉里手工登记的，都会出现在这里'}</div>
        </div>
      ) : (
        <div className="task-table outs-table">
          <div className="outs-row task-th"><span /><span>任务</span><span>状态</span><span>产出</span><span>完成</span><span>最近产出</span></div>
          {rows.slice(0, limit).map(({ t, s }) => {
            const isOpen = open.has(t.id)
            const pn = projName(t.project_id)
            const mine = hits.filter((a) => a.task_id === t.id).sort((a, b) => b.at.localeCompare(a.at))
            return (
              <div key={t.id} className={cls('outs-item', isOpen && 'open')}>
                <div className={cls('outs-row', selected === t.id && 'sel')} onClick={() => toggle(t.id)}>
                  <span className="outs-caret">{isOpen ? '▾' : '▸'}</span>
                  <span className="task-main">
                    <span className="task-title"><span className="task-ref">{t.ref}</span><span className="ellipsis">{t.title}</span></span>
                    <span className="task-meta">{pn ? <span className="src-tag src-proj">{pn}</span> : <span>不属于项目</span>}</span>
                  </span>
                  <span><span className="src-tag">{statusLabel(t.status)}</span></span>
                  <span className="outs-kinds">{summaryText(s)}</span>
                  {/* 原型的任务没有 completed_at，已结束的用最后修改时间代；正式产品用 completed_at */}
                  <span className="list-sub">{isOpenTask(t.status) ? '未完成' : `${t.updated_at.slice(5, 10)} 完成`}</span>
                  <span className="list-sub">{timeAgo(s.last)}</span>
                </div>
                {isOpen && (
                  <div className="outs-detail">
                    {mine.map((a) => {
                      const p = parseArtifact(a.note)
                      return (
                        <div key={a.id} className="dev-art">
                          <span className="outs-kind">{kindLabel(outputKind(a))}</span>
                          <span className="dev-art-main">
                            {p.kind === 'commit' && <span className="mono dev-sha">{p.sha?.slice(0, 7)}</span>}
                            {p.branch && <span className="tag mono">{p.branch}</span>}
                            {a.url
                              ? <a className="ellipsis dev-art-link" href={a.url} onClick={(e) => { e.preventDefault(); openUrl(a.url!, p.text || a.url) }}>{p.text || a.url}</a>
                              : <span className="ellipsis">{p.kind === 'file' ? (a.rel_path ?? a.path) : p.text}</span>}
                          </span>
                          <span className="src-tag">{SOURCE_LABEL[a.source]}</span>
                          {a.path && !a.url && <button className="act act-quiet" title={a.path} onClick={() => { navigator.clipboard?.writeText(a.path!); setCopied(a.id) }}>{copied === a.id ? '已复制' : '复制路径'}</button>}
                          <span className="list-sub dev-art-at">{timeAgo(a.at)}</span>
                        </div>
                      )
                    })}
                    <div><button className="btn btn-ghost" onClick={() => onOpen(t.id)}>在任务里看</button></div>
                  </div>
                )}
              </div>
            )
          })}
          {rows.length > limit && <button className="list-seg-more" onClick={() => setLimit(limit + PAGE)}>还有 {rows.length - limit} 条任务</button>}
        </div>
      )}
    </div>
  )
}
