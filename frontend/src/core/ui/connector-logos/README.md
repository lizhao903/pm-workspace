# 连接器平台图标

TSK-0725。连接器（设置 / 连接器、Agent 工具授权等）显示的平台图标，随前端打包（Vite 把这里的 SVG 打成带 hash 的静态资源），**运行时不访问外网**。
清单与底色在同目录 `index.ts`，后端定义的 `logo` 键见 `internal/connector/logo.go`，按服务地址识别平台的域名表见 `frontend/src/core/data/connectorLogo.ts` 和规格 `web-next/docs/spec/settings.md` 的 `SPEC-settings-3`「平台图标」。

## 来源与授权

- **Simple Icons**（https://simpleicons.org ，npm 包 `simple-icons`，版本 **16.36.0**，2026-11-06 取）：图标数据以 **CC0-1.0** 发布（包内 `LICENSE.md`）。取法：在临时目录 `npm i simple-icons`，只拷出下表用到的 `icons/<slug>.svg`，**不把整个包加进 frontend 依赖**。
  处理：只保留 `<path>`，去掉 `<title>`，在 `<svg>` 上写 `fill`（品牌色上用白色；底色相对亮度不低于 0.45 时用 `#1A1A1A`），`viewBox` 不变。底色取该图标在 Simple Icons 里登记的品牌色 `hex`。
- Simple Icons 的 CC0 只覆盖图标文件本身；**商标仍属各品牌方**。这里只用来标明「这个连接器接的是哪个平台」（指称性使用），不改形、不暗示合作或背书。各品牌有自己的使用规范的，下表「品牌规范」一栏列出，改图标前先看。
- **Slack**：Simple Icons 已应品牌方要求移除 Slack 图标，所以改用 Slack 官网公开的标志：`https://a.slack-edge.com/1f40066/marketing/img/nav/logo.svg`（slack.com 页头里的官方 hash 标志，多色，原样保留，只去掉 `clip-path` 和宽高）。使用依据是 Slack 媒体资料页 https://slack.com/media-kit 与品牌规范 https://brand.slackhq.com/ ：提供这些资源是为了让人「不用另签法律协议即可使用我们的品牌与资产」，须遵守品牌规范（不改色、不变形）；用于标明与 Slack 的集成。2026-11-06 取。
- **抖音**：Simple Icons 没有抖音，用同属字节跳动、标志相同（音符）的 TikTok 图标（`tiktok.svg`，CC0）。抖音官网没有找到可直接引用、写明授权的公开品牌资源页，暂不单独放抖音字样的标志。

## 文件

| 文件 | 平台 | 底色 | 来源 | 授权 | 品牌规范 |
|---|---|---|---|---|---|
| `airtable.svg` | Airtable | `#18BFFF` | simple-icons 16.36.0 `icons/airtable.svg` | CC0-1.0（Simple Icons） | 无 |
| `anthropic.svg` | Anthropic | `#191919` | simple-icons 16.36.0 `icons/anthropic.svg` | CC0-1.0（Simple Icons） | 无 |
| `asana.svg` | Asana | `#F06A6A` | simple-icons 16.36.0 `icons/asana.svg` | CC0-1.0（Simple Icons） | https://asana.com/brand |
| `atlassian.svg` | Atlassian | `#0052CC` | simple-icons 16.36.0 `icons/atlassian.svg` | CC0-1.0（Simple Icons） | https://atlassian.design/foundations/logos |
| `bilibili.svg` | Bilibili | `#00A1D6` | simple-icons 16.36.0 `icons/bilibili.svg` | CC0-1.0（Simple Icons） | 无 |
| `binance.svg` | Binance | `#F0B90B` | simple-icons 16.36.0 `icons/binance.svg` | CC0-1.0（Simple Icons） | 无 |
| `clickup.svg` | ClickUp | `#7B68EE` | simple-icons 16.36.0 `icons/clickup.svg` | CC0-1.0（Simple Icons） | 无 |
| `cloudflare.svg` | Cloudflare | `#F38020` | simple-icons 16.36.0 `icons/cloudflare.svg` | CC0-1.0（Simple Icons） | https://www.cloudflare.com/trademark/ |
| `datadog.svg` | Datadog | `#632CA6` | simple-icons 16.36.0 `icons/datadog.svg` | CC0-1.0（Simple Icons） | https://www.datadoghq.com/about/resources/ |
| `discord.svg` | Discord | `#5865F2` | simple-icons 16.36.0 `icons/discord.svg` | CC0-1.0（Simple Icons） | https://discord.com/branding |
| `dropbox.svg` | Dropbox | `#0061FF` | simple-icons 16.36.0 `icons/dropbox.svg` | CC0-1.0（Simple Icons） | 无 |
| `figma.svg` | Figma | `#F24E1E` | simple-icons 16.36.0 `icons/figma.svg` | CC0-1.0（Simple Icons） | https://www.figma.com/using-the-figma-brand/ |
| `github.svg` | GitHub | `#181717` | simple-icons 16.36.0 `icons/github.svg` | CC0-1.0（Simple Icons） | https://github.com/logos |
| `gitlab.svg` | GitLab | `#FC6D26` | simple-icons 16.36.0 `icons/gitlab.svg` | CC0-1.0（Simple Icons） | https://about.gitlab.com/handbook/marketing/corporate-marketing/brand-activation/trademark-guidelines/ |
| `google.svg` | Google | `#4285F4` | simple-icons 16.36.0 `icons/google.svg` | CC0-1.0（Simple Icons） | https://about.google/brand-resource-center/brand-elements/ |
| `googlecalendar.svg` | Google Calendar | `#4285F4` | simple-icons 16.36.0 `icons/googlecalendar.svg` | CC0-1.0（Simple Icons） | 无 |
| `googledrive.svg` | Google Drive | `#4285F4` | simple-icons 16.36.0 `icons/googledrive.svg` | CC0-1.0（Simple Icons） | 无 |
| `grafana.svg` | Grafana | `#F46800` | simple-icons 16.36.0 `icons/grafana.svg` | CC0-1.0（Simple Icons） | 无 |
| `hubspot.svg` | HubSpot | `#FF7A59` | simple-icons 16.36.0 `icons/hubspot.svg` | CC0-1.0（Simple Icons） | https://www.hubspot.com/style-guide |
| `huggingface.svg` | Hugging Face | `#FFD21E` | simple-icons 16.36.0 `icons/huggingface.svg` | CC0-1.0（Simple Icons） | https://huggingface.co/brand |
| `intercom.svg` | Intercom | `#6AFDEF` | simple-icons 16.36.0 `icons/intercom.svg` | CC0-1.0（Simple Icons） | https://www.intercom.com/press |
| `linear.svg` | Linear | `#5E6AD2` | simple-icons 16.36.0 `icons/linear.svg` | CC0-1.0（Simple Icons） | 无 |
| `modelcontextprotocol.svg` | Model Context Protocol | `#000000` | simple-icons 16.36.0 `icons/modelcontextprotocol.svg` | CC0-1.0（Simple Icons） | 无 |
| `netlify.svg` | Netlify | `#00C7B7` | simple-icons 16.36.0 `icons/netlify.svg` | CC0-1.0（Simple Icons） | https://www.netlify.com/press/ |
| `notion.svg` | Notion | `#000000` | simple-icons 16.36.0 `icons/notion.svg` | CC0-1.0（Simple Icons） | 无 |
| `okx.svg` | OKX | `#000000` | simple-icons 16.36.0 `icons/okx.svg` | CC0-1.0（Simple Icons） | 无 |
| `openapiinitiative.svg` | OpenAPI Initiative | `#6BA539` | simple-icons 16.36.0 `icons/openapiinitiative.svg` | CC0-1.0（Simple Icons） | https://www.openapis.org/faq/style-guide |
| `pagerduty.svg` | PagerDuty | `#06AC38` | simple-icons 16.36.0 `icons/pagerduty.svg` | CC0-1.0（Simple Icons） | https://www.pagerduty.com/brand/ |
| `paypal.svg` | PayPal | `#002991` | simple-icons 16.36.0 `icons/paypal.svg` | CC0-1.0（Simple Icons） | https://newsroom.paypal-corp.com/media-resources |
| `postman.svg` | Postman | `#FF6C37` | simple-icons 16.36.0 `icons/postman.svg` | CC0-1.0（Simple Icons） | 无 |
| `sentry.svg` | Sentry | `#362D59` | simple-icons 16.36.0 `icons/sentry.svg` | CC0-1.0（Simple Icons） | 无 |
| `shopify.svg` | Shopify | `#7AB55C` | simple-icons 16.36.0 `icons/shopify.svg` | CC0-1.0（Simple Icons） | https://www.shopify.com/brand-assets |
| `stripe.svg` | Stripe | `#635BFF` | simple-icons 16.36.0 `icons/stripe.svg` | CC0-1.0（Simple Icons） | 无 |
| `supabase.svg` | Supabase | `#3FCF8E` | simple-icons 16.36.0 `icons/supabase.svg` | CC0-1.0（Simple Icons） | 无 |
| `telegram.svg` | Telegram | `#26A5E4` | simple-icons 16.36.0 `icons/telegram.svg` | CC0-1.0（Simple Icons） | 无 |
| `tiktok.svg` | TikTok | `#000000` | simple-icons 16.36.0 `icons/tiktok.svg` | CC0-1.0（Simple Icons） | 无 |
| `todoist.svg` | Todoist | `#E44332` | simple-icons 16.36.0 `icons/todoist.svg` | CC0-1.0（Simple Icons） | 无 |
| `trello.svg` | Trello | `#0052CC` | simple-icons 16.36.0 `icons/trello.svg` | CC0-1.0（Simple Icons） | https://atlassian.design/foundations/logos |
| `vercel.svg` | Vercel | `#000000` | simple-icons 16.36.0 `icons/vercel.svg` | CC0-1.0（Simple Icons） | https://vercel.com/geist/brands |
| `youtube.svg` | YouTube | `#FF0000` | simple-icons 16.36.0 `icons/youtube.svg` | CC0-1.0（Simple Icons） | https://www.youtube.com/howyoutubeworks/resources/brand-resources/#logos-icons-and-colors |
| `zapier.svg` | Zapier | `#FF4F00` | simple-icons 16.36.0 `icons/zapier.svg` | CC0-1.0（Simple Icons） | https://www.figma.com/file/NQFxTCE5pGR3dHZt0DkOyy/Zapier-Brand-Guidelines-%5BExternal%5D?type=design&node-id=101-9701&mode=design |
| `slack.svg` | Slack | `#FFFFFF` | slack.com 官网 `a.slack-edge.com/1f40066/marketing/img/nav/logo.svg` | Slack 品牌资源（按 https://slack.com/media-kit 的规范使用，非 CC0） | https://slack.com/media-kit |

## 用在哪些内置连接器

| 连接器定义 `tool` | 图标 |
|---|---|
| `gdrive` | `googledrive` |
| `gcal` | `googlecalendar` |
| `custom_mcp` | `modelcontextprotocol`（按服务地址认出平台时换成平台的） |
| `custom_openapi` | `openapiinitiative`（按接口地址、文档地址认出平台时换成平台的） |
| `slack` | `slack` |
| `telegram` | `telegram` |
| `binance_market`、`binance_account` | `binance` |
| `okx_market`、`okx_account` | `okx` |
| `bilibili`、`bilibili_web` | `bilibili` |
| `youtube` | `youtube` |
| `douyin` | `tiktok`（见上） |

## 新增图标

1. 优先在 Simple Icons 里找（CC0），按上面的处理写成 `<key>.svg`；没有的用品牌官网公开的品牌资源，并在上表写明出处与使用依据；找不到合规来源的不放，界面退回文字图标。
2. `index.ts` 的 `LOGOS` 加一行（底色）；要按地址识别的，在 `core/data/connectorLogo.ts` 的域名表加一行，并同步规格。
3. `index.test.ts` 会核对：清单、文件、本表三者一致。
