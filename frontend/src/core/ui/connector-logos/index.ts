// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 连接器的平台图标（TSK-0725）：随前端打包的静态 SVG，运行时不访问外网。
// 来源、版本与授权见同目录 README.md；新增图标时同时改 README 和这里的清单（index.test.ts 核对两边一致）。
// 键名就是连接器定义的 logo（后端 internal/connector/logo.go）和按地址识别出的平台（core/data/connectorLogo.ts）。
// bg 是图块底色（品牌色），标志的颜色已经写进 SVG（品牌色上用白色，底色很浅时用深色；Slack 是官方多色标志放白底）。

const files = import.meta.glob<string>('./*.svg', { eager: true, query: '?url', import: 'default' })

export type LogoInfo = { title: string; bg: string }

export const LOGOS: Readonly<Record<string, LogoInfo>> = {
  airtable: { title: 'Airtable', bg: '#18BFFF' },
  anthropic: { title: 'Anthropic', bg: '#191919' },
  asana: { title: 'Asana', bg: '#F06A6A' },
  atlassian: { title: 'Atlassian', bg: '#0052CC' },
  bilibili: { title: 'Bilibili', bg: '#00A1D6' },
  binance: { title: 'Binance', bg: '#F0B90B' },
  clickup: { title: 'ClickUp', bg: '#7B68EE' },
  cloudflare: { title: 'Cloudflare', bg: '#F38020' },
  datadog: { title: 'Datadog', bg: '#632CA6' },
  discord: { title: 'Discord', bg: '#5865F2' },
  dropbox: { title: 'Dropbox', bg: '#0061FF' },
  figma: { title: 'Figma', bg: '#F24E1E' },
  github: { title: 'GitHub', bg: '#181717' },
  gitlab: { title: 'GitLab', bg: '#FC6D26' },
  google: { title: 'Google', bg: '#4285F4' },
  googlecalendar: { title: 'Google Calendar', bg: '#4285F4' },
  googledrive: { title: 'Google Drive', bg: '#4285F4' },
  grafana: { title: 'Grafana', bg: '#F46800' },
  hubspot: { title: 'HubSpot', bg: '#FF7A59' },
  huggingface: { title: 'Hugging Face', bg: '#FFD21E' },
  intercom: { title: 'Intercom', bg: '#6AFDEF' },
  linear: { title: 'Linear', bg: '#5E6AD2' },
  modelcontextprotocol: { title: 'Model Context Protocol', bg: '#000000' },
  netlify: { title: 'Netlify', bg: '#00C7B7' },
  notion: { title: 'Notion', bg: '#000000' },
  okx: { title: 'OKX', bg: '#000000' },
  openapiinitiative: { title: 'OpenAPI Initiative', bg: '#6BA539' },
  pagerduty: { title: 'PagerDuty', bg: '#06AC38' },
  paypal: { title: 'PayPal', bg: '#002991' },
  postman: { title: 'Postman', bg: '#FF6C37' },
  sentry: { title: 'Sentry', bg: '#362D59' },
  shopify: { title: 'Shopify', bg: '#7AB55C' },
  slack: { title: 'Slack', bg: '#FFFFFF' },
  stripe: { title: 'Stripe', bg: '#635BFF' },
  supabase: { title: 'Supabase', bg: '#3FCF8E' },
  telegram: { title: 'Telegram', bg: '#26A5E4' },
  tiktok: { title: 'TikTok', bg: '#000000' },
  todoist: { title: 'Todoist', bg: '#E44332' },
  trello: { title: 'Trello', bg: '#0052CC' },
  vercel: { title: 'Vercel', bg: '#000000' },
  youtube: { title: 'YouTube', bg: '#FF0000' },
  zapier: { title: 'Zapier', bg: '#FF4F00' },
}

/** 图标文件的地址（打包后带 hash）；不认识的键为 undefined */
export function logoUrl(key: string | undefined): string | undefined {
  return key && Object.hasOwn(LOGOS, key) ? files[`./${key}.svg`] : undefined
}

/** 清单里登记了、目录里有文件的键（给测试核对） */
export const logoFiles = (): string[] => Object.keys(files).map((f) => f.slice(2, -4))
