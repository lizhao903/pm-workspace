// 产出物（TSK-0497，SPEC-tasks-12）：按任务汇总的产出物清单。任务模块二级菜单「视图」组里的一项，和全部任务、阶段看板同一种切换。
// 每行一条有产出的任务：任务、状态、项目、完成时间、产出数量与类型、最近一次产出；点行展开看这条任务的每件产出物
// （提交号与说明、分支、PR、文档、原型、文件、链接），链接新窗口打开、本机文件复制路径，「在任务里看」打开抽屉的产出物面板。
// 数据来自 GET /api/artifacts/by-object（一次拿全，不受列表一页 500 条的限制，手工登记的也算）；
// 类型、来源、项目、时间在后端筛，类型按 display_kind（历史上没填 kind 的也能筛到）。
import { useMemo, useState } from 'react'
import {
  QueryState, useArtifacts, useArtifactsByObject, type Artifact, type ArtifactListParams, type ArtifactObjectSummary,
  type ArtifactSource, type ObjectStatus, type WorkObject,
} from '../../core/data'
import {
  Button, EmptyState, ErrorState, IconClose, IconSearch, ListSegMore, LoadingState, PageTitle, Pill, SearchSelect, cls,
} from '../../core/ui'
import { ArtifactRow } from './ArtifactsPanel'
import { parseArtifactNote } from './artifactNote'
import { timeAgo } from './model'
import {
  SINCE_OPTIONS, SOURCES, SOURCE_LABEL, kindLabel, kindParts, matchSummary, sinceParam, summaryText, summaryTitle,
  type KindInfo, type OutputsSince,
} from './outputSummary'
import './artifacts.css'

const PAGE = 50
// 项目筛选里「不属于项目」的值，和任务列表同一个
const NO_PROJECT = '-'
// 展开一条任务时取它的产出物；一个任务的产出一般远少于这个数
const DETAIL_LIMIT = 500

export function OutputsView({
  tasks, statuses, projects, kinds, search, onSearch, q, selected, onOpenTask, now: nowProp,
}: {
  /** 任务列表（状态、标题以它为准，汇总里的是登记时查到的） */
  tasks: WorkObject[]
  statuses: ObjectStatus[]
  projects: { id: string; title: string }[]
  kinds: readonly KindInfo[]
  search: string
  onSearch: (v: string) => void
  /** 防抖后的搜索词 */
  q: string
  selected: string | null
  /** 打开任务抽屉的产出物面板；任务不在列表里时只给 id */
  onOpenTask: (id: string, task: WorkObject | undefined) => void
  /** 测试里固定「今天」 */
  now?: Date
}) {
  const [opened] = useState(() => new Date())
  const now = nowProp ?? opened
  const [kind, setKind] = useState('')
  const [source, setSource] = useState<'' | ArtifactSource>('')
  const [proj, setProj] = useState('')
  const [since, setSince] = useState<OutputsSince>('')
  const [limit, setLimit] = useState(PAGE)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  const filter: ArtifactListParams = {
    object_type: 'task', kind: kind || undefined, source: source || undefined, project_id: proj || undefined,
    since: sinceParam(since, now),
  }
  const main = useArtifactsByObject(filter)
  // 搜索：编号、任务标题、项目名在本地比；产出物的标题、路径、链接、备注交给后端 q，两边命中的都算
  const byContent = useArtifactsByObject({ ...filter, q }, { enabled: !!q })
  const contentHit = useMemo(() => new Set((byContent.data?.objects ?? []).map((o) => o.object_id)), [byContent.data])
  const taskOf = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])

  const all = main.data?.objects ?? []
  const rows = q ? all.filter((o) => matchSummary(o, q) || contentHit.has(o.object_id)) : all
  const kindN = main.data?.by_kind ?? {}
  const kindTotal = Object.values(kindN).reduce((a, b) => a + b, 0)
  const sourceN = main.data?.by_source ?? {}
  const shownArtifacts = rows.reduce((n, o) => n + o.total, 0)
  const statusOf = (k: string) => statuses.find((s) => s.key === k)
  const filtered = !!(kind || source || proj || since || q)

  const reset = () => setLimit(PAGE)
  const clearFilters = () => { setKind(''); setSource(''); setProj(''); setSince(''); onSearch(''); reset() }
  const toggle = (id: string) => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpanded(next)
  }

  const row = (o: ArtifactObjectSummary) => {
    const t = taskOf.get(o.object_id)
    const status = t?.status ?? o.status
    const st = statusOf(status)
    const title = t?.title ?? o.object_title
    const projTitle = t?.project_title || o.project_title || (o.project_id ? projects.find((p) => p.id === o.project_id)?.title : '')
    const done = t?.completed_at ?? o.completed_at
    const parts = kindParts(o.by_kind, kinds)
    const open = expanded.has(o.object_id)
    return (
      <div key={o.object_id} className={cls('outs-item', open && 'open')} role="group" aria-label={`${o.object_ref} ${title}`}>
        <div role="button" tabIndex={0} aria-expanded={open} className={cls('outs-row', selected === o.object_id && 'sel')}
          onClick={() => toggle(o.object_id)}
          onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(o.object_id) } }}>
          <span className="outs-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="task-main">
            <span className="task-title"><span className="task-ref">{o.object_ref}</span><span className="ellipsis" title={title}>{title}</span></span>
            <span className="task-meta">
              {projTitle ? <span className="src-tag src-proj" title={projTitle}>{projTitle}</span> : <span>不属于项目</span>}
            </span>
          </span>
          <span><Pill label={st?.label ?? status} color={st?.color} /></span>
          <span className="outs-kinds" title={summaryTitle(o.total, parts)}>{summaryText(o.total, parts)}</span>
          <span className="run-muted outs-done">{done ? `${shortDay(done)} 完成` : '未完成'}</span>
          <span className="run-muted outs-last" title={new Date(o.last_at).toLocaleString()}>{timeAgo(o.last_at, now)}</span>
        </div>
        {open && (
          <OutputsDetail summary={o} filter={filter} kinds={kinds} onOpenTask={() => onOpenTask(o.object_id, t)} />
        )}
      </div>
    )
  }

  let body
  if (main.isError) body = <ErrorState title="产出物加载失败" error={main.error} onRetry={() => void main.refetch()} />
  else if (main.isPending || (q && byContent.isPending)) body = <LoadingState />
  else if (rows.length === 0) {
    body = filtered
      ? <EmptyState title="没有符合条件的产出" action={<Button variant="outline" onClick={clearFilters}>清掉筛选条件</Button>} />
      : <EmptyState title="还没有任务留下产出物" desc="交给 Claude Code 执行、Agent 回写提交和文档、在任务抽屉里手工登记的，都会出现在这里" />
  } else {
    body = (
      <div className="task-table outs-table">
        <div className="outs-row task-th" aria-hidden="true">
          <span /><span>任务</span><span>状态</span><span>产出</span><span>完成</span><span>最近产出</span>
        </div>
        {rows.slice(0, limit).map(row)}
        <ListSegMore n={rows.length - limit} onMore={() => setLimit(limit + PAGE)} text={`还有 ${rows.length - limit} 条任务`} />
      </div>
    )
  }

  const known = kinds.filter((k) => kindN[k.key]).map((k) => k.key)
  const extra = Object.keys(kindN).filter((k) => kindN[k] && !known.includes(k))
  return (
    <div className="tasks-page">
      <PageTitle parent="任务" count={main.isSuccess ? rows.length : undefined}
        desc={main.isSuccess ? `${rows.length} 条任务留下了 ${shownArtifacts} 件产出物；点一行展开看每一件，手工登记的也算` : '每条有产出的任务一行，点开看每一件产出物'}>
        产出物
      </PageTitle>
      <div className="toolbar">
        <div className="seg" role="group" aria-label="类型">
          <button type="button" className={cls(!kind && 'on')} aria-pressed={!kind} onClick={() => { setKind(''); reset() }}>
            全部{main.isSuccess && <span className="seg-n">{kindTotal}</span>}
          </button>
          {[...known, ...extra].map((k) => (
            <button key={k} type="button" className={cls(kind === k && 'on')} aria-pressed={kind === k} onClick={() => { setKind(k); reset() }}>
              {kindLabel(kinds, k)}<span className="seg-n">{kindN[k]}</span>
            </button>
          ))}
          {/* 选中的种类筛空了也要能看见、能取消 */}
          {kind && !kindN[kind] && (
            <button type="button" className="on" aria-pressed="true" onClick={() => { setKind(''); reset() }}>{kindLabel(kinds, kind)}<span className="seg-n">0</span></button>
          )}
        </div>
        <div className={cls('chip chip-select', source && 'chip-on')}>
          <select value={source} aria-label="来源" onChange={(e) => { setSource(e.target.value as '' | ArtifactSource); reset() }}>
            <option value="">全部来源</option>
            {SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}{sourceN[s] ? `（${sourceN[s]}）` : ''}</option>)}
          </select>
        </div>
        <SearchSelect value={proj} onChange={(v) => { setProj(v); reset() }} noneLabel="全部项目" placeholder="全部项目" searchPlaceholder="搜项目"
          aria-label="项目" options={[...projects.map((p) => ({ value: p.id, label: p.title })), { value: NO_PROJECT, label: '不属于项目' }]}
          missingLabel={() => '已删除的项目'} />
        <div className={cls('chip chip-select', since && 'chip-on')}>
          <select value={since} aria-label="时间" onChange={(e) => { setSince(e.target.value as OutputsSince); reset() }}>
            <option value="">全部时间</option>
            {SINCE_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </div>
        <span className="spacer" />
        <div className="search">
          <IconSearch />
          <input type="search" placeholder="搜索任务、产出物标题、路径、链接" aria-label="搜索产出物" value={search}
            onChange={(e) => { onSearch(e.target.value); reset() }}
            onKeyDown={(e) => { if (e.key === 'Escape' && search) { e.preventDefault(); onSearch('') } }} />
          {search && <button type="button" className="search-clear" aria-label="清空" title="清空" onClick={() => onSearch('')}><IconClose size={10} /></button>}
        </div>
      </div>
      {body}
    </div>
  )
}

/** 展开的一条任务：它的每件产出物，按当前的类型、来源、时间筛（和这一行的条数对得上） */
function OutputsDetail({ summary, filter, kinds, onOpenTask }: {
  summary: ArtifactObjectSummary
  filter: ArtifactListParams
  kinds: readonly KindInfo[]
  onOpenTask: () => void
}) {
  const q = useArtifacts({ object_id: summary.object_id, source: filter.source, since: filter.since, limit: DETAIL_LIMIT })
  const [copied, setCopied] = useState('')
  const copy = (a: Artifact) => {
    navigator.clipboard?.writeText(a.path).then(() => setCopied(a.id), () => setCopied(''))
  }
  return (
    <div className="outs-detail">
      <QueryState query={q} compact>{(res) => {
        // 类型在本地按 display_kind 筛：列表接口的 kind 比的是库里的值，历史上没填的会漏
        const items = res.data.filter((a) => !filter.kind || a.display_kind === filter.kind)
        return (
          <>
            {!items.length && <div className="art-empty">没有符合条件的产出物</div>}
            <ul className="art-list" aria-label={`${summary.object_ref} 的产出物`}>
              {items.map((a) => (
                <ArtifactRow key={a.id} a={a} p={parseArtifactNote(a.note)} copied={copied === a.id} onCopy={copy}
                  lead={<span className="outs-kind" data-kind={a.display_kind}>{kindLabel(kinds, a.display_kind)}</span>} />
              ))}
            </ul>
            {res.total > DETAIL_LIMIT && <div className="art-hint">只列了最近 {DETAIL_LIMIT} 件，全部请在任务里看</div>}
          </>
        )
      }}</QueryState>
      <div className="outs-detail-acts">
        <Button size="sm" onClick={onOpenTask}>在任务里看</Button>
      </div>
    </div>
  )
}

/** 完成日：今年的写月-日，往年的带年份 */
function shortDay(iso: string) {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}-${md}`
}
