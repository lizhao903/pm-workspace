// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 从 Slack 补联系人邮箱：渠道配置里 Slack 渠道卡片下面的一行。联系人经 IM 身份（Slack Member ID）认到 Slack 里的人，
// 资料里有邮箱时补进联系人的邮箱：只填空的，不覆盖已有值；不一样的列出来，不改。
// Slack 缺 users:read.email 时不算失败，给出要去 Slack 后台加权限的提示。之后收到新身份、新消息时后台会顺带补。
import { errorText, useImBackfillEmails, type Connector, type ImEmailBackfillResult } from '../../core/data'
import { emailBackfillErrorText, emailBackfillText, SLACK_EMAIL_SCOPE_HINT } from './channelModel'

export function EmailBackfill({ c, disabled }: { c: Connector; disabled: boolean }) {
  const run = useImBackfillEmails()
  const r: ImEmailBackfillResult | undefined = run.data
  return (
    <div className="im-chmail">
      <div className="im-chmail-row">
        <button type="button" className="btn btn-ghost btn-sm" disabled={disabled || run.isPending} onClick={() => run.mutate(c.id)}
          title={disabled ? '停用、断开时不查' : '按联系人关联的 Slack 身份查资料里的邮箱，只填联系人邮箱为空的'}>
          {run.isPending ? '正在查 Slack…' : '从 Slack 补联系人邮箱'}
        </button>
        {r && <span className={r.missing_scope ? 'im-muted' : 'im-ok'} role="status">{emailBackfillText(r)}</span>}
        {run.isError && <span className="im-err" role="alert">{emailBackfillErrorText(run.error) || errorText(run.error)}</span>}
      </div>
      {r?.missing_scope && <div className="im-chmail-hint" role="note">{r.hint || SLACK_EMAIL_SCOPE_HINT}</div>}
      {r && r.filled_contacts.length > 0 && (
        <ul className="im-chmail-list im-muted" aria-label="补上的邮箱">
          {r.filled_contacts.map((x) => <li key={x.stakeholder_id + x.external_id}>{x.name}：{x.email}</li>)}
        </ul>
      )}
      {r && r.conflicts.length > 0 && (
        <ul className="im-chmail-list" aria-label="和名册不一样的邮箱">
          {r.conflicts.map((x) => (
            <li key={x.stakeholder_id + x.external_id}>{x.name}：名册里是 {x.current}，Slack 里是 {x.found}（没改，要换去联系人里改）</li>
          ))}
        </ul>
      )}
    </div>
  )
}
