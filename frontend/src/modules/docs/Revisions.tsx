// 文档的修订记录（SPEC-library-1.47）：最近的在前，正文改动只说字数变化，分类、状态用显示名。
import { REVISION_LIMIT, errorText, useObjectRevisions } from '../../core/data'
import { Button } from '../../core/ui'
import { docRevisionText, timeAgo } from './model'

const fmtTime = (iso: string) => {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function DocRevisions({ id, catName, statusLabel }: {
  id: string
  catName: (id: string) => string
  statusLabel: (key: string) => string
}) {
  const q = useObjectRevisions(id)
  const rows = q.data ?? []
  let body
  if (q.isPending) body = <div className="lib-revs-note">正在读取…</div>
  else if (q.isError && !q.data) body = <div className="lib-revs-note" role="alert">没读到修订：{errorText(q.error)} <Button size="sm" onClick={() => void q.refetch()}>重试</Button></div>
  else if (!rows.length) body = <div className="lib-revs-note">还没有修订记录</div>
  else {
    body = (
      <ol className="lib-revs-list">
        {rows.map((r) => (
          <li key={r.id} className="lib-rev" data-field={r.field}>
            <time className="lib-rev-at" dateTime={r.created_at} title={timeAgo(new Date(r.created_at).getTime())}>{fmtTime(r.created_at)}</time>
            <span className="lib-rev-actor ellipsis" title={r.actor}>{r.actor_name || r.actor || '未知'}</span>
            <span className="lib-rev-text">{docRevisionText(r, { cat: catName, status: statusLabel })}</span>
          </li>
        ))}
      </ol>
    )
  }
  return (
    <section className="lib-revs" aria-label="修订记录">
      <h2 className="lib-revs-title">修订记录{rows.length > 0 && ` · ${rows.length >= REVISION_LIMIT ? `最近 ${REVISION_LIMIT}` : rows.length} 条`}</h2>
      {body}
    </section>
  )
}
