// 本机状态（SPEC-settings-20.29 到 20.32）：数据来自 GET /api/domains/status，每项一行，有问题的写怎么修、给可复制的命令
import { errorText, type DomainStatus, type DomainStatusItem } from '../../core/data'
import { Button, cls } from '../../core/ui'
import { STATE_LABEL, STATUS_GROUP, timeAgo } from './model'
import { Commands } from './parts'

export function StatusBlock({ query, copied, onCopy }: {
  query: { data?: DomainStatus; error: unknown; isError: boolean; isFetching: boolean; refetch: () => unknown }
  copied: string | null
  onCopy: (key: string, text: string) => void
}) {
  const st = query.data
  const busy = query.isFetching
  return (
    <section className="dm-sec dm-status" aria-label="本机状态">
      <div className="dm-sec-head">
        <div className="dm-title">
          本机状态
          {st && (
            <span className="dm-title-hint">
              {st.summary.problem ? `${st.summary.problem} 项有问题` : '没有问题'}
              {st.summary.unknown ? `，${st.summary.unknown} 项没检测到` : ''} · {timeAgo(st.checked_at)}检测
            </span>
          )}
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void query.refetch()}>{busy ? '检测中…' : '重新检测'}</Button>
      </div>
      {query.isError && !st && <div className="dm-err" role="alert">检测失败：{errorText(query.error)}</div>}
      {!st && !query.isError && <div className="dm-empty">检测中…</div>}
      {st && (
        <div className="dm-table" role="list">
          {st.items.map((it) => <StatusRow key={it.key} it={it} copied={copied} onCopy={onCopy} />)}
        </div>
      )}
      {st && !st.items.length && <div className="dm-empty">没有要检测的项</div>}
    </section>
  )
}

function StatusRow({ it, copied, onCopy }: { it: DomainStatusItem; copied: string | null; onCopy: (key: string, text: string) => void }) {
  return (
    <div className={cls('dm-st-row', it.state)} role="listitem" data-key={it.key}>
      <span className="dm-st-group">{STATUS_GROUP[it.group] ?? it.group}</span>
      <span className={cls('dm-st-name ellipsis', it.group === 'hosts' && 'mono')} title={it.name}>{it.name}</span>
      <span className={cls('dm-st-state', it.state)}>{STATE_LABEL[it.state] ?? it.state}</span>
      <span className="dm-st-msg">{it.message}</span>
      {it.fix && it.state !== 'ok' && (
        <div className="dm-st-fix">
          <div className="dm-hint">怎么修：{it.fix.text}</div>
          <Commands id={'fix:' + it.key} commands={it.fix.commands} copied={copied} onCopy={onCopy} />
        </div>
      )}
    </div>
  )
}
