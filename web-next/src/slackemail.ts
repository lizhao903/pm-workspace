// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 从 Slack 补联系人邮箱（SPEC-settings-4.7d）：联系人的 Slack 身份（Member ID）认到 Slack 里的人，资料里有邮箱时补进联系人。
// 只填联系人邮箱为空的，不覆盖已有值；不一样的列出来不改。正式产品是 POST /api/im/connectors/{id}/backfill-emails
// （Slack users.info 的 profile.email，要 users:read.email），原型用下面一份 Slack 资料种子模拟。
import type { Contact } from './data'

/** 原型里 Slack 资料上的邮箱：Member ID -> 邮箱。陈若溪资料里的和名册里不一样，用来看「不一样」的样子 */
export const SLACK_PROFILE_EMAILS: Record<string, string> = {
  U04LINYUAN: 'lin.yuan@example.com',
  U04ZHOUYU0: 'zhou.yu@example.com',
  U05CHENRX0: 'ruoxi.chen@example.com',
  U02MIAHOFF: 'mia.h@nordlicht.example',
}

/** 缺权限时的提示，同正式产品 */
export const SLACK_EMAIL_SCOPE_HINT = 'Slack 应用要加 users:read.email 权限并重新安装：OAuth & Permissions 里 Bot Token Scopes（身份是我本人时加在 User Token Scopes）加上 users:read.email，再点 Reinstall to Workspace'

export interface EmailBackfillResult {
  checked: number
  filled: number
  skipped: number
  conflicts: { id: string; name: string; current: string; found: string }[]
  filledList: { id: string; name: string; email: string }[]
  missingScope: boolean
}

/**
 * 算一次补齐：noScope 为真时模拟 Token 缺 users:read.email（原型里 Token 里带 noemail 时这样）。
 * 回结果和要写进联系人的邮箱（联系人 id -> 邮箱）。查不到资料的（不在这个工作区）算跳过
 */
export function backfillSlackEmails(contacts: Contact[], noScope: boolean): { result: EmailBackfillResult; patches: Record<string, string> } {
  const linked = contacts.filter((c) => c.im.slack?.trim())
  const result: EmailBackfillResult = { checked: linked.length, filled: 0, skipped: 0, conflicts: [], filledList: [], missingScope: noScope }
  const patches: Record<string, string> = {}
  if (noScope) return { result: { ...result, skipped: linked.length }, patches }
  for (const c of linked) {
    const found = SLACK_PROFILE_EMAILS[c.im.slack.trim()]
    const cur = (patches[c.id] ?? c.email).trim()
    if (!found || cur.toLowerCase() === found.toLowerCase()) result.skipped++
    else if (cur) result.conflicts.push({ id: c.id, name: c.name, current: cur, found })
    else {
      patches[c.id] = found
      result.filled++
      result.filledList.push({ id: c.id, name: c.name, email: found })
    }
  }
  return { result, patches }
}

/** 结果说明（一行），同正式产品 emailBackfillText */
export function emailBackfillText(r: EmailBackfillResult) {
  if (r.missingScope) return '没补：拿不到 Slack 资料里的邮箱'
  if (!r.checked) return '还没有关联到 Slack 的联系人：先在联系人里加 Slack 身份（Member ID）'
  const parts = [`查了 ${r.checked} 个 Slack 身份`, r.filled ? `补上 ${r.filled} 个邮箱` : '没有要补的']
  if (r.conflicts.length) parts.push(`${r.conflicts.length} 个和名册里不一样（没改）`)
  return parts.join('，')
}
