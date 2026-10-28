// 任务抽屉的改动痕迹（DEV-08d）：这条任务的修订按会话分组，每组标出操作者、会话 id、时间范围和字段变更。
// 会话 id 可以复制，拿去 claude --resume 接着做。进展行用 revisionSummary 显示正文，不显示元数据 JSON。
import { useEffect, useState } from 'react'
import type { WorkObject } from '../../core/api'
import { revisionSummary, shortSession } from '../../core/api/progress'
import { REVISION_LIMIT, groupRevisions, useObjectRevisions, type RevisionGroup } from '../../core/api/taskReview'
import { ErrorState } from '../../core/ui'
import { timeAgo } from './model'
import './changes.css'

const fmtTime = (iso: string) => {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const fmtRange = (a: string, b: string) => (fmtTime(a) === fmtTime(b) ? fmtTime(a) : `${fmtTime(a)} 至 ${fmtTime(b)}`)

export function ChangesPanel({ task }: { task: WorkObject }) {
  const q = useObjectRevisions(task.id)
  const rows = q.data ?? []
  const groups = groupRevisions(rows)
  const sessions = groups.filter((g) => g.session_id).length

  return (
    <section className="dev-slot chg" data-slot="changes" data-task={task.id} aria-label="改动">
      <div className="dev-slot-head">
        <span className="field-group-title">改动</span>
        {rows.length > 0 && <span className="chg-count">{rows.length} 条{sessions > 0 && `，${sessions} 个会话`}</span>}
      </div>
      {q.isPending ? (
        <div className="dev-slot-empty">加载中</div>
      ) : q.isError && !q.data ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !groups.length ? (
        <div className="dev-slot-empty">还没有改动记录。</div>
      ) : (
        <>
          {rows.length >= REVISION_LIMIT && <div className="chg-trunc">只显示最近 {REVISION_LIMIT} 条</div>}
          <ul className="chg-groups">
            {groups.map((g) => <ChangeGroup key={g.key} g={g} />)}
          </ul>
        </>
      )}
    </section>
  )
}

function ChangeGroup({ g }: { g: RevisionGroup }) {
  return (
    <li className="chg-group" data-session={g.session_id || undefined}>
      <div className="chg-head">
        <span className="chg-actor">{g.actor_name || '未知'}</span>
        {g.session_id ? <SessionId sid={g.session_id} /> : <span className="chg-nosess">没有会话</span>}
        <span className="spacer" />
        <time className="chg-range" dateTime={g.last} title={`最近一次 ${new Date(g.last).toLocaleString('zh-CN')}`}>
          {fmtRange(g.first, g.last)} · {timeAgo(g.last)}
        </time>
      </div>
      <ol className="chg-list">
        {g.rows.map((r) => (
          <li key={r.id} className="chg-row" data-field={r.field}>
            <time className="chg-at" dateTime={r.created_at}>{fmtTime(r.created_at)}</time>
            <span className="chg-text">{revisionSummary(r)}</span>
          </li>
        ))}
      </ol>
    </li>
  )
}

/** 会话 id：显示短码，点一下复制完整 id */
function SessionId({ sid }: { sid: string }) {
  const [copied, setCopied] = useState<'' | 'ok' | 'fail'>('')
  useEffect(() => {
    if (!copied) return
    const h = window.setTimeout(() => setCopied(''), 2000)
    return () => window.clearTimeout(h)
  }, [copied])
  const copy = () => {
    const p = navigator.clipboard?.writeText(sid)
    if (!p) { setCopied('fail'); return }
    p.then(() => setCopied('ok'), () => setCopied('fail'))
  }
  return (
    <button type="button" className="chg-sid" data-sid={sid} onClick={copy}
      title={`会话 ${sid}\n点一下复制，可以 claude --resume ${sid} 接着做`}
      aria-label={`复制会话 id ${sid}`}>
      {copied === 'ok' ? `已复制，claude --resume ${shortSession(sid)}…` : copied === 'fail' ? `复制失败：${sid}` : `会话 ${shortSession(sid)}`}
    </button>
  )
}
