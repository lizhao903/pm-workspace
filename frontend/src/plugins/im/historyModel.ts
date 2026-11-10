// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 群组管理「补全消息」与成员「加为联系人」（IM 0.30.0，TSK-0724，SPEC-messages-7.14 起）的纯规则：
// 补全结果怎么说、批量补全的汇总、批量加联系人的候选名单。界面在 GroupAdmin.tsx、HistoryBackfill.tsx、GroupMembers.tsx、MemberContacts.tsx。
import type { ImConversationSummary, ImHistoryBackfillResult, ImHistoryRange, ImMember } from '../../core/data'

export const HISTORY_RANGES: { key: ImHistoryRange; label: string; hint: string }[] = [
  { key: '7d', label: '最近 7 天', hint: '发送时间在最近 7 天里的' },
  { key: '30d', label: '最近 30 天', hint: '发送时间在最近 30 天里的' },
  { key: 'all', label: '全部', hint: '不限时间，一个会话一轮至多翻 5000 条，更早的不补' },
]

export const rangeLabel = (r: ImHistoryRange | string) => HISTORY_RANGES.find((x) => x.key === r)?.label ?? r

/** 一行的续补位置：上次没补完时记下范围和 cursor，行上「继续补全」带上 */
export type BackfillResume = { range: ImHistoryRange; cursor: string }

export type Note = { text: string; bad: boolean }

/** 能补全：渠道支持、有消息；不能的给原因 */
export function backfillBlock(s: Pick<ImConversationSummary, 'can_backfill' | 'backfill_note' | 'total'>): string {
  if (!s.total) return '这个会话还没收到过消息，不知道用哪个账号拉'
  if (!s.can_backfill) return s.backfill_note || '这个渠道不支持拉历史消息'
  return ''
}

/** 新补、跳过、补正文的那一句；都没有时「没有要补的消息」 */
function counts(r: Pick<ImHistoryBackfillResult, 'added' | 'expired' | 'muted' | 'duplicates' | 'bodies_filled'>): string {
  const parts: string[] = []
  if (r.added > 0) {
    const sub: string[] = []
    if (r.expired > 0) sub.push(`${r.expired} 条较早的标为已过期`)
    if (r.muted > 0) sub.push(`${r.muted} 条因自动忽略标为已忽略`)
    parts.push(`已补 ${r.added} 条${sub.length ? `（${sub.join('，')}）` : ''}`)
  }
  if (r.duplicates > 0) parts.push(`跳过 ${r.duplicates} 条已有的`)
  if (r.bodies_filled > 0) parts.push(`补上 ${r.bodies_filled} 条空正文`)
  return parts.length ? parts.join('，') : '没有要补的消息'
}

/** 单个会话补全的结果 */
export function backfillText(r: ImHistoryBackfillResult): Note {
  let tail = ''
  if (r.capped) tail = '；「全部」一次最多翻 5000 条，更早的没补'
  else if (r.limited) tail = '；渠道限流停下了，剩余的稍后点「继续补全」'
  else if (!r.complete) tail = '；还没补完，点「继续补全」接着补'
  return { text: `${rangeLabel(r.range)}：${counts(r)}${tail}`, bad: false }
}

/** 批量补全的进度和结果 */
export type BatchBackfill = {
  done: number
  total: number
  added: number
  expired: number
  muted: number
  duplicates: number
  bodies_filled: number
  /** 没补完、可在行上「继续补全」的会话数 */
  partial: number
  /** 渠道不支持、没消息跳过的 */
  skipped: number
  /** 撞上限流停下时还没开始的会话数 */
  left: number
  failed: { name: string; error: string }[]
}

export const emptyBatch = (total: number, skipped: number): BatchBackfill => ({
  done: 0, total, added: 0, expired: 0, muted: 0, duplicates: 0, bodies_filled: 0, partial: 0, skipped, left: 0, failed: [],
})

export function addToBatch(b: BatchBackfill, r: ImHistoryBackfillResult): BatchBackfill {
  return {
    ...b, done: b.done + 1, added: b.added + r.added, expired: b.expired + r.expired, muted: b.muted + r.muted,
    duplicates: b.duplicates + r.duplicates, bodies_filled: b.bodies_filled + r.bodies_filled, partial: b.partial + (r.complete ? 0 : 1),
  }
}

export function batchText(b: BatchBackfill, range: ImHistoryRange): Note {
  const parts = [`${rangeLabel(range)}补全 ${b.done} 个会话：${counts(b)}`]
  if (b.partial) parts.push(`${b.partial} 个没补完，在行上点「继续补全」`)
  if (b.left) parts.push(`渠道限流停下了，还有 ${b.left} 个会话没补，稍后再点`)
  if (b.skipped) parts.push(`${b.skipped} 个渠道不支持或还没消息，跳过`)
  if (b.failed.length) {
    const shown = b.failed.slice(0, 3).map((f) => `${f.name}：${f.error}`).join('；')
    parts.push(`${b.failed.length} 个没补成：${shown}${b.failed.length > 3 ? ' 等' : ''}`)
  }
  return { text: parts.join('；'), bad: b.failed.length > 0 && b.added === 0 && b.bodies_filled === 0 }
}

/** 「全部加为联系人」的候选：在这个会话里发过言、没认上联系人的真人（排除机器人和自己） */
export function contactCandidates(members: ImMember[] | undefined): ImMember[] {
  return (members ?? []).filter((m) => m.last_at && !m.contact_id && !m.is_bot && !m.is_self)
}

/** 成员显示名：联系人名优先，其次渠道里的名字，都没有用编号 */
export const memberName = (m: ImMember) => m.name || m.sender_name || m.external_id
