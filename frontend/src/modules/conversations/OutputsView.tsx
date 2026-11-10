// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 产出结果（SPEC-sessions-3）：Agent 登记下来的产出物，对应 /api/artifacts。
// 后端的产出物没有「任务 / 文档 / IM 回复」这种类型，类型切换按位置和备注标记分（文件、链接、提交、分支、PR）；
// Agent 列和筛选按来源（内置 Agent、任务执行、MCP 回写）。手工登记的不算 Agent 产出，不列。
// 删了会话的产出物还在，来源显示「会话 · 已删除」。
// 同一次提交登记到多个任务时合并成一行（B-08）：产出显示提交号和说明，来源显示涉及的任务，多个时点开看。
import { useMemo, useState } from 'react'
import { useAgentSessions, useArtifacts, type Artifact, type ArtifactSource } from '../../core/data'
import { ErrorState, LoadingState, PageTitle, EmptyState, cls } from '../../core/ui'
import { KIND_LABEL, timeAgo, type ArtifactKind } from '../../core/chat/chatModel'
import { groupObjects, groupOutputs, type OutputGroup } from './outputsModel'

const PAGE = 50
// 后端单页上限；类型和 Agent 的筛选、条数在前端按这一页算
const LIMIT = 500

type Producer = Exclude<ArtifactSource, 'manual'>
const PRODUCER_LABEL: Record<Producer, string> = { agent: '内置 Agent', run: '任务执行', mcp: 'MCP 回写' }
const KINDS = Object.keys(KIND_LABEL) as ArtifactKind[]

export function OutputsView({ onOpenSession, onBack }: { onOpenSession: (id: string) => void; onBack?: () => void }) {
  const [kind, setKind] = useState<'' | ArtifactKind>('')
  const [producer, setProducer] = useState<'' | Producer>('')
  const [limit, setLimit] = useState(PAGE)
  // 展开看涉及任务的那几行
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const list = useArtifacts({ limit: LIMIT })
  const sessions = useAgentSessions()
  const titles = useMemo(() => new Map((sessions.data ?? []).map((s) => [s.id, s.title])), [sessions.data])
  // 条数都按合并后的行算
  const all = useMemo(() => groupOutputs((list.data?.data ?? []).filter((a) => a.source !== 'manual')), [list.data])
  const kindN = useMemo(() => {
    const m = new Map<ArtifactKind, number>()
    for (const g of all) m.set(g.kind, (m.get(g.kind) ?? 0) + 1)
    return m
  }, [all])
  // Agent chip 按产出条数排，只列出现过的
  const producers = useMemo(() => {
    const m = new Map<Producer, number>()
    for (const g of all) { const p = g.head.source as Producer; m.set(p, (m.get(p) ?? 0) + 1) }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p)
  }, [all])
  const rows = all.filter((g) => (!kind || g.kind === kind) && (!producer || g.head.source === producer))
  const truncated = (list.data?.total ?? 0) > LIMIT

  const pickKind = (k: '' | ArtifactKind) => { setKind(k); setLimit(PAGE) }
  // 单选，再点一次取消
  const pickProducer = (p: '' | Producer) => { setProducer(p === producer ? '' : p); setLimit(PAGE) }

  const toggle = (key: string) => {
    const next = new Set(expanded)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setExpanded(next)
  }

  const origin = (a: Artifact) => {
    if (a.session_id) {
      const t = titles.get(a.session_id)
      // 不在全局会话里的是挂在工作对象上的会话，去对象详情里看
      return t !== undefined
        ? <button type="button" className="link-btn link-muted ellipsis" onClick={() => onOpenSession(a.session_id!)}>会话 · {t}</button>
        : <span className="list-sub ellipsis">会话 · 在{a.object_ref ? ` ${a.object_ref} ` : '工作对象'}里</span>
    }
    if (a.run_id) return <span className="list-sub ellipsis">执行记录{a.object_ref ? ` · ${a.object_ref}` : ''}</span>
    // 内置 Agent 的产出物一定来自会话，没有 session_id 说明会话删了
    if (a.source === 'agent') return <span className="list-sub ellipsis">会话 · 已删除</span>
    return <span className="list-sub ellipsis" title={a.object_title}>{a.object_ref ? `${a.object_ref} ${a.object_title ?? ''}` : '未归属'}</span>
  }

  // 合并的提交：涉及多个任务时来源是「N 个任务」，点开在下面列出来
  const groupOrigin = (g: OutputGroup, objs: ReturnType<typeof groupObjects>, open: boolean) => {
    if (objs.length < 2) return origin(g.head)
    const first = objs[0]
    return (
      <button type="button" className="link-btn link-muted ellipsis output-expand" aria-expanded={open} onClick={() => toggle(g.key)}
        title={objs.map((o) => `${o.ref} ${o.title}`).join('\n')}>
        {objs.length} 个任务 · {first.ref} 等
      </button>
    )
  }

  const title = (g: OutputGroup) => {
    const a = g.head
    if (a.url) return <a className="link-btn ellipsis" href={a.url} target="_blank" rel="noopener noreferrer" title={a.url}>{a.title || a.url}</a>
    if (g.sha) {
      return (
        <span className="ellipsis" title={a.note}>
          <span className="mono output-sha">{g.sha}</span>{a.title ? ` ${a.title}` : ''}
        </span>
      )
    }
    return <span className="ellipsis" title={a.path}>{a.title || a.rel_path || a.path}</span>
  }

  let body
  if (list.isPending) body = <LoadingState />
  else if (list.isError) body = <ErrorState title="产出结果加载失败" error={list.error} onRetry={() => void list.refetch()} />
  else if (!all.length) body = <EmptyState title="还没有产出" desc="Agent 建了任务、写了文档、发了回复后会出现在这里" />
  else if (!rows.length) body = <EmptyState title="没有符合条件的产出" desc="换个类型或 Agent 看看" />
  else {
    body = (
      <div className="task-table">
        <div className="output-row task-th"><span>类型</span><span>产出</span><span>Agent</span><span>来源</span><span>时间</span></div>
        {rows.slice(0, limit).map((g) => {
          const a = g.head
          const objs = groupObjects(g)
          const open = objs.length > 1 && expanded.has(g.key)
          return (
            <div key={g.key} className={cls('output-item', open && 'open')}>
              <div className="output-row" data-artifact={a.id} data-count={g.items.length > 1 ? g.items.length : undefined}>
                <span><span className={cls('out-kind', 'out-' + g.kind)}>{KIND_LABEL[g.kind]}</span></span>
                <span className="output-title">{title(g)}</span>
                <span className="ellipsis">{PRODUCER_LABEL[a.source as Producer] ?? a.source}</span>
                <span className="ellipsis output-origin">{groupOrigin(g, objs, open)}</span>
                <span className="run-muted">{timeAgo(a.created_at)}</span>
              </div>
              {open && (
                <ul className="output-objs" aria-label="涉及的任务">
                  {objs.map((o) => (
                    <li key={o.id}><span className="mono list-sub">{o.ref}</span><span className="ellipsis" title={o.title}>{o.title}</span></li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
        {rows.length > limit && (
          <button type="button" className="agent-more" onClick={() => setLimit(limit + PAGE)}>显示更多（还有 {rows.length - limit} 条）</button>
        )}
      </div>
    )
  }

  return (
    <div className="conv-page">
      <PageTitle parent={onBack ? <button type="button" className="link-btn tb-back" onClick={onBack}>会话</button> : '会话'} count={list.isSuccess ? rows.length : undefined} desc="Agent 真正落到数据上的东西，点标题直接打开，点来源回到当时的对话或执行">产出结果</PageTitle>
      {all.length > 0 && (
        <div className="toolbar">
          <div className="seg" role="tablist" aria-label="类型">
            <button type="button" role="tab" aria-selected={!kind} className={cls(!kind && 'on')} onClick={() => pickKind('')}>
              全部<span className="seg-n">{all.length}</span>
            </button>
            {KINDS.filter((k) => kindN.has(k)).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={kind === k} className={cls(kind === k && 'on')} onClick={() => pickKind(k)}>
                {KIND_LABEL[k]}<span className="seg-n">{kindN.get(k)}</span>
              </button>
            ))}
          </div>
          <div className="out-agents" role="group" aria-label="Agent">
            <button type="button" className={cls('chip', !producer && 'chip-on')} aria-pressed={!producer} onClick={() => pickProducer('')}>全部 Agent</button>
            {producers.map((p) => (
              <button key={p} type="button" className={cls('chip', producer === p && 'chip-on')} aria-pressed={producer === p} onClick={() => pickProducer(p)}>
                {PRODUCER_LABEL[p] ?? p}
              </button>
            ))}
          </div>
          {truncated && <span className="list-sub">只统计最近 {LIMIT} 条</span>}
        </div>
      )}
      {body}
    </div>
  )
}
