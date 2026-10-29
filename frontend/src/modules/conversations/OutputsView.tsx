// 产出结果（SPEC-sessions-3）：Agent 登记下来的产出物，对应 /api/artifacts。
// 后端的产出物没有「任务 / 文档 / IM 回复」这种类型，类型切换按位置和备注标记分（文件、链接、提交、分支、PR）；
// Agent 列和筛选按来源（内置 Agent、任务执行、MCP 回写）。手工登记的不算 Agent 产出，不列。
// 删了会话的产出物还在，来源显示「会话 · 已删除」。
import { useMemo, useState } from 'react'
import { useAgentSessions, useArtifacts, type Artifact, type ArtifactSource } from '../../core/data'
import { ErrorState, LoadingState, PageTitle, EmptyState, cls } from '../../core/ui'
import { KIND_LABEL, artifactKind, timeAgo, type ArtifactKind } from './chatModel'

const PAGE = 50
// 后端单页上限；类型和 Agent 的筛选、条数在前端按这一页算
const LIMIT = 500

type Producer = Exclude<ArtifactSource, 'manual'>
const PRODUCER_LABEL: Record<Producer, string> = { agent: '内置 Agent', run: '任务执行', mcp: 'MCP 回写' }
const KINDS = Object.keys(KIND_LABEL) as ArtifactKind[]

export function OutputsView({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const [kind, setKind] = useState<'' | ArtifactKind>('')
  const [producer, setProducer] = useState<'' | Producer>('')
  const [limit, setLimit] = useState(PAGE)
  const list = useArtifacts({ limit: LIMIT })
  const sessions = useAgentSessions()
  const titles = useMemo(() => new Map((sessions.data ?? []).map((s) => [s.id, s.title])), [sessions.data])
  const all = useMemo(() => (list.data?.data ?? []).filter((a) => a.source !== 'manual'), [list.data])
  const kindN = useMemo(() => {
    const m = new Map<ArtifactKind, number>()
    for (const a of all) { const k = artifactKind(a); m.set(k, (m.get(k) ?? 0) + 1) }
    return m
  }, [all])
  // Agent chip 按产出条数排，只列出现过的
  const producers = useMemo(() => {
    const m = new Map<Producer, number>()
    for (const a of all) { const p = a.source as Producer; m.set(p, (m.get(p) ?? 0) + 1) }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p)
  }, [all])
  const rows = all.filter((a) => (!kind || artifactKind(a) === kind) && (!producer || a.source === producer))
  const truncated = (list.data?.total ?? 0) > LIMIT

  const pickKind = (k: '' | ArtifactKind) => { setKind(k); setLimit(PAGE) }
  // 单选，再点一次取消
  const pickProducer = (p: '' | Producer) => { setProducer(p === producer ? '' : p); setLimit(PAGE) }

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

  let body
  if (list.isPending) body = <LoadingState />
  else if (list.isError) body = <ErrorState title="产出结果加载失败" error={list.error} onRetry={() => void list.refetch()} />
  else if (!all.length) body = <EmptyState title="还没有产出" desc="Agent 建了任务、写了文档、发了回复后会出现在这里" />
  else if (!rows.length) body = <EmptyState title="没有符合条件的产出" desc="换个类型或 Agent 看看" />
  else {
    body = (
      <div className="task-table">
        <div className="output-row task-th"><span>类型</span><span>产出</span><span>Agent</span><span>来源</span><span>时间</span></div>
        {rows.slice(0, limit).map((a) => {
          const k = artifactKind(a)
          return (
            <div key={a.id} className="output-row" data-artifact={a.id}>
              <span><span className={cls('out-kind', 'out-' + k)}>{KIND_LABEL[k]}</span></span>
              <span className="output-title">
                {a.url
                  ? <a className="link-btn ellipsis" href={a.url} target="_blank" rel="noopener noreferrer" title={a.url}>{a.title || a.url}</a>
                  : <span className="ellipsis" title={a.path}>{a.title || a.rel_path || a.path}</span>}
              </span>
              <span className="ellipsis">{PRODUCER_LABEL[a.source as Producer] ?? a.source}</span>
              <span className="ellipsis output-origin">{origin(a)}</span>
              <span className="run-muted">{timeAgo(a.created_at)}</span>
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
      <PageTitle parent="会话" count={list.isSuccess ? rows.length : undefined} desc="Agent 真正落到数据上的东西，点标题直接打开，点来源回到当时的对话或执行">产出结果</PageTitle>
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
