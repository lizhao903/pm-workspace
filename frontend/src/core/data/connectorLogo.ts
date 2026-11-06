// 连接器显示哪个图标（TSK-0725）。规格见 web-next/docs/spec/settings.md SPEC-settings-3「平台图标」。
// 顺序：用户自己换的图标（icon，data URL；「从网站取图标」取到的也存在这里）> 自定义连接器按服务地址认出的平台 > 定义的 logo > 文字图标。
// 认平台只看地址里的主机名，纯前端算，不出网；认不出就用定义的（MCP、OpenAPI 的通用标志）。
import type { Connector, ConnectorDef } from './connectors'

/** 已知平台的域名（主机名等于它或以「.它」结尾都算），值是 core/ui/connector-logos 里的图标键 */
export const PLATFORM_DOMAINS: ReadonlyArray<readonly [domain: string, logo: string]> = [
  ['notion.com', 'notion'], ['notion.so', 'notion'],
  ['linear.app', 'linear'],
  ['atlassian.com', 'atlassian'], ['atlassian.net', 'atlassian'],
  ['githubcopilot.com', 'github'], ['github.com', 'github'], ['githubusercontent.com', 'github'],
  ['gitlab.com', 'gitlab'],
  ['figma.com', 'figma'],
  ['slack.com', 'slack'],
  ['googleapis.com', 'google'], ['google.com', 'google'],
  ['sentry.io', 'sentry'], ['sentry.dev', 'sentry'],
  ['stripe.com', 'stripe'],
  ['cloudflare.com', 'cloudflare'], ['workers.dev', 'cloudflare'],
  ['vercel.com', 'vercel'], ['vercel.app', 'vercel'],
  ['supabase.com', 'supabase'], ['supabase.co', 'supabase'],
  ['asana.com', 'asana'],
  ['hubspot.com', 'hubspot'], ['hubapi.com', 'hubspot'],
  ['zapier.com', 'zapier'],
  ['airtable.com', 'airtable'],
  ['discord.com', 'discord'],
  ['huggingface.co', 'huggingface'],
  ['anthropic.com', 'anthropic'],
  ['postman.com', 'postman'], ['getpostman.com', 'postman'],
  ['trello.com', 'trello'],
  ['todoist.com', 'todoist'],
  ['clickup.com', 'clickup'],
  ['paypal.com', 'paypal'],
  ['shopify.com', 'shopify'], ['myshopify.com', 'shopify'],
  ['intercom.com', 'intercom'], ['intercom.io', 'intercom'],
  ['netlify.com', 'netlify'], ['netlify.app', 'netlify'],
  ['grafana.com', 'grafana'], ['grafana.net', 'grafana'],
  ['datadoghq.com', 'datadog'],
  ['pagerduty.com', 'pagerduty'],
  ['dropbox.com', 'dropbox'], ['dropboxapi.com', 'dropbox'],
  ['telegram.org', 'telegram'],
  ['binance.com', 'binance'],
  ['okx.com', 'okx'],
  ['bilibili.com', 'bilibili'],
  ['youtube.com', 'youtube'],
  ['modelcontextprotocol.io', 'modelcontextprotocol'],
]

/** 按地址认平台：取主机名，最长的域名匹配优先；不是地址或认不出回空串 */
export function detectPlatform(raw: string | undefined): string {
  const s = (raw ?? '').trim()
  if (!s) return ''
  let host: string
  try {
    host = new URL(s).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return ''
  }
  let best = ''
  let len = 0
  for (const [d, logo] of PLATFORM_DOMAINS) {
    if ((host === d || host.endsWith(`.${d}`)) && d.length > len) {
      best = logo
      len = d.length
    }
  }
  return best
}

/** 自定义连接器拿来认平台的地址字段，按先后试 */
const ADDRESS_FIELDS: Readonly<Record<string, readonly string[]>> = {
  custom_mcp: ['url'],
  custom_openapi: ['base_url', 'spec_url'],
}

/** 这个工具的哪些配置字段是认平台用的地址（不是自定义连接器为空） */
export const addressFields = (tool: string): readonly string[] => ADDRESS_FIELDS[tool] ?? []

/** 按配置认出的平台（只对自定义连接器），认不出回空串 */
export function detectedLogo(tool: string, config: Readonly<Record<string, string>> | undefined): string {
  for (const k of addressFields(tool)) {
    const hit = detectPlatform(config?.[k])
    if (hit) return hit
  }
  return ''
}

export type ConnectorLook = { label: string; color: string; logo: string; src: string }

/**
 * 一个连接器（或只有定义时）该怎么显示：交给 core/ui 的 ConnectorLogo。
 * def 缺（提供它的插件停用了）时退回实例名和灰底；config 给了就按它认平台（抽屉里还没保存的地址）。
 */
export function connectorLook(def: Pick<ConnectorDef, 'tool' | 'label' | 'color' | 'logo'> | undefined,
  c?: Pick<Connector, 'tool' | 'name' | 'icon' | 'config'>, config?: Readonly<Record<string, string>>): ConnectorLook {
  const tool = def?.tool ?? c?.tool ?? ''
  return {
    label: def?.label ?? c?.name ?? tool,
    color: def?.color ?? '',
    logo: detectedLogo(tool, config ?? c?.config) || def?.logo || '',
    src: c?.icon ?? '',
  }
}
