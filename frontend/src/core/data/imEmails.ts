// 从 Slack 补联系人邮箱：IM 插件 im 的 POST /api/im/connectors/{id}/backfill-emails。
// 联系人经 IM 身份认到渠道里的人，渠道资料里有邮箱时补进联系人 email；只填空的，不覆盖已有值，不一样的列在 conflicts。
// Slack 缺 users:read.email 不算失败：200，missing_scope 为真，hint 写要做什么。
import { useMutation } from '@tanstack/react-query'
import { request } from '../api'
import { useNotifyChange } from './invalidate'

/** 联系人已有邮箱、和渠道资料里不一样的一项，不改 */
export type ImEmailConflict = { stakeholder_id: string; name: string; external_id: string; current: string; found: string }
/** 补上邮箱的一项 */
export type ImEmailFilled = { stakeholder_id: string; name: string; external_id: string; email: string }

export type ImEmailBackfillResult = {
  connector_id: string
  /** 查了几个身份 */
  checked: number
  filled: number
  /** 没补也不算差异的：已一致、资料里没邮箱、不在这个工作区、被限流没查完 */
  skipped: number
  conflicts: ImEmailConflict[]
  filled_contacts: ImEmailFilled[]
  missing_scope: boolean
  hint: string
  /** 被限流或超过单次上限没查完的个数，再点一次接着查 */
  pending: number
}

export const imEmailApi = {
  /** 连接器不在 404；渠道不支持、暂停、断开 409；渠道出错（Token 失效等）502 backfill_failed */
  backfill: async (connectorId: string) => {
    const r = await request<ImEmailBackfillResult>('POST', `/api/im/connectors/${encodeURIComponent(connectorId)}/backfill-emails`, { body: {} })
    return { ...r, conflicts: r.conflicts ?? [], filled_contacts: r.filled_contacts ?? [], hint: r.hint ?? '', pending: r.pending ?? 0 }
  },
}

/** 从渠道资料补联系人邮箱：补上了的话联系人名册要刷新 */
export function useImBackfillEmails() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (connectorId: string) => imEmailApi.backfill(connectorId),
    onSuccess: (r) => (r.filled > 0 ? notify({ kind: 'stakeholder' }) : undefined),
  })
}
