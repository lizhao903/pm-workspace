// 产出结果（SPEC-sessions-3）：Agent 登记下来的产出物，对应 /api/artifacts。
// 后端的产出物没有「任务 / 文档 / IM 回复」这种类型，按来源分：内置 Agent（会话里 write_file）、任务执行、MCP 回写；
// 类型列按位置和备注标记显示（文件、链接、提交、分支、PR）。删了会话的产出物还在，来源显示「会话 · 已删除」。
import { useMemo, useState } from 'react'
import { useAgentSessions, useArtifactStats, useArtifacts, type Artifact, type ArtifactSource } from '../../core/data'
import { ErrorState, LoadingState, PageTitle, EmptyState, cls } from '../../core/ui'
import { KIND_LABEL, artifactKind, timeAgo } from './chatModel'

const PAGE = 50
// 后端单页上限
const LIMIT = 500

type Src = Exclude<ArtifactSource, 'manual'>
const SOURCES: { key: Src; label: string }[] = [
  { key: 'agent', label: '会话里的 Agent' },
  { key: 'run', label: '任务执行' },
  { key: 'mcp', label: 'MCP 回写' },
]


export function OutputsView({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const [src, setSrc] = useState<Src>('agent')
  const [limit, setLimit] = useState(PAGE)
  const list = useArtifacts({ source: src, limit: LIMIT })
  // 各来源的条数从统计的 by_source 里取，一次请求
  const stats = useArtifactStats({})
  const bySource = stats.data?.by_source
  const sessions = useAgentSessions()
  const titles = useMemo(() => new Map((sessions.data ?? []).map((s) => [s.id, s.title])), [sessions.data])
  const rows = list.data?.data ?? []
  const total = list.data?.total

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
    return <span className="list-sub ellipsis">{a.source === 'agent' ? '会话 · 已删除' : '未归属'}</span>
  }

  let body
  if (list.isPending) body = <LoadingState />
  else if (list.isError) body = <ErrorState title="产出结果加载失败" error={list.error} onRetry={() => void list.refetch()} />
  else if (!rows.length) body = <EmptyState title="还没有产出" desc="Agent 写了文件、登记了链接后会出现在这里" />
  else {
    body = (
      <div className="task-table">
        <div className="output-row task-th"><span>类型</span><span>产出</span><span>归属</span><span>来源</span><span>时间</span></div>
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
              <span className="ellipsis list-sub" title={a.object_title}>{a.object_ref ? `${a.object_ref} ${a.object_title ?? ''}` : '未归属'}</span>
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
      <PageTitle parent="会话" count={total} desc="Agent 真正落到数据上的东西，点标题直接打开，点来源回到当时的对话">产出结果</PageTitle>
      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="来源">
          {SOURCES.map((s) => (
            <button key={s.key} type="button" role="tab" aria-selected={src === s.key} className={cls(src === s.key && 'on')}
              onClick={() => { setSrc(s.key); setLimit(PAGE) }}>
              {s.label}{bySource && <span className="seg-n">{bySource[s.key] ?? 0}</span>}
            </button>
          ))}
        </div>
      </div>
      {body}
    </div>
  )
}
