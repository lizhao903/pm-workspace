// Telegram 渠道的纯函数（IM-01c）：Token、公网地址的校验，口径和后端 internal/plugins/im/telegram.go 一致。
import type { Connector } from '../../core/data'

export const TELEGRAM_TOOL = 'telegram'

/** Bot Token 形如 123456789:AA…，和后端的检查一致 */
export const telegramTokenOk = (s: string) => /^[0-9]{3,20}:[A-Za-z0-9_-]{20,100}$/.test(s.trim())

/** 公网地址：空，或 https://域名（不带路径） */
export function webhookUrlError(s: string): string | undefined {
  const v = s.trim()
  if (!v) return undefined
  try {
    const u = new URL(v)
    if (u.protocol !== 'https:') return 'Telegram 只推 https 地址'
    if ((u.pathname && u.pathname !== '/') || u.search) return '只填 https://域名，不带路径'
  } catch {
    return '地址不对'
  }
  return undefined
}

/** 渠道卡片上的收法：Telegram 不看同步间隔，没填公网地址时一直长轮询 */
export const telegramModeLabel = (c: Pick<Connector, 'config'>) => (c.config.webhook_url?.trim() ? '经 webhook 推送' : '长轮询，随到随收')
