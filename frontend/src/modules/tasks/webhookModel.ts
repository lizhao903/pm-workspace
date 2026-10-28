// Webhook 页（SPEC-tasks-9、10）用的纯函数：映射预览、过滤预览、列表排序、配置草稿、签名。
// 映射和过滤的写法照原型 web-next/src/taskdata.ts 的 getPath、mapFields、passFilter；真正建任务以后端为准，这里只做编辑时的预览。
import type { Delivery, DeliveryResult, LastDelivery, Webhook, WebhookInput, WebhookMapping, WebhookPatch } from '../../core/data'

export const FIELDS = ['title', 'desc', 'priority', 'assignee', 'due'] as const satisfies readonly (keyof WebhookMapping)[]
export const FIELD_LABEL: Record<keyof WebhookMapping, string> = { title: '标题', desc: '描述', priority: '优先级', assignee: '负责人', due: '截止日期' }

export const RESULT: Record<DeliveryResult, { label: string; color: string }> = {
  created: { label: '已建任务', color: 'var(--ok)' },
  skipped: { label: '已忽略', color: 'var(--faint)' },
  failed: { label: '失败', color: 'var(--danger)' },
}

/** 推送记录先露几条 */
export const LOG_PAGE = 20

export type Json = Record<string, unknown>

/** 取 a.b[0].c 这类路径的值 */
export function getPath(obj: unknown, path: string): unknown {
  if (!path.trim()) return undefined
  return path.trim().replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj)
}

export const asText = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))

export function mapFields(mapping: WebhookMapping, payload: Json): Record<keyof WebhookMapping, string> {
  const out = {} as Record<keyof WebhookMapping, string>
  for (const k of FIELDS) out[k] = asText(getPath(payload, mapping[k]))
  return out
}

/** 过滤条件只支持 路径 == 值 / 路径 != 值 */
export function passFilter(filter: string, payload: Json): { pass: boolean; reason?: string } {
  if (!filter.trim()) return { pass: true }
  const m = /^\s*([\w.[\]]+)\s*(==|!=)\s*(.+?)\s*$/.exec(filter)
  if (!m) return { pass: false, reason: `过滤条件写法不对：${filter}` }
  const actual = asText(getPath(payload, m[1]))
  const want = m[3].replace(/^['"]|['"]$/g, '')
  const ok = m[2] === '==' ? actual === want : actual !== want
  return ok ? { pass: true } : { pass: false, reason: `不满足过滤条件 ${filter}（实际是「${actual || '空'}」）` }
}

export function parseJson(s: string): { ok: true; value: Json } | { ok: false; error: string } {
  try {
    const v: unknown = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? { ok: true, value: v as Json } : { ok: false, error: '推送内容要是一个 JSON 对象' }
  } catch (e) {
    return { ok: false, error: `JSON 格式不对：${(e as Error).message}` }
  }
}

/* ---------- 列表 ---------- */

export type HookFilter = '' | 'failed' | 'off'

export const isFailing = (last: LastDelivery | undefined) => last?.last?.result === 'failed'

export function matchHook(h: Webhook, kw: string) {
  const k = kw.trim().toLowerCase()
  return !k || `${h.name} ${h.token}`.toLowerCase().includes(k)
}

/** 最近失败的在前，其次启用的，再按最近推送时间，最后按名称 */
export function sortHooks(hooks: Webhook[], last: Record<string, LastDelivery | undefined>): Webhook[] {
  const at = (h: Webhook) => last[h.id]?.last?.at ?? ''
  return [...hooks].sort((a, b) => Number(isFailing(last[b.id])) - Number(isFailing(last[a.id]))
    || Number(b.enabled) - Number(a.enabled) || at(b).localeCompare(at(a)) || a.name.localeCompare(b.name))
}

/** 二级菜单「最近推送」：推送过的按最近推送时间排，最多 n 个 */
export function recentHooks(hooks: Webhook[], last: Record<string, LastDelivery | undefined>, n = 5): Webhook[] {
  return hooks.filter((h) => last[h.id]?.last).sort((a, b) => last[b.id]!.last!.at.localeCompare(last[a.id]!.last!.at)).slice(0, n)
}

/** 推送记录一行的说明：建了任务写「编号 标题」，否则写原因 */
export function deliveryText(d: Delivery): string {
  if (d.result === 'created') return `${d.task_ref || '任务'} ${d.mapped.title}`.trim()
  return d.reason || RESULT[d.result].label
}

/* ---------- 配置草稿 ---------- */

export type HookDraft = Required<Omit<WebhookInput, 'enabled'>> & { enabled: boolean }

export const DEFAULT_SAMPLE = JSON.stringify({ title: '示例：客户要求导出支持 Excel', description: '来自外部系统的说明', priority: 'high' }, null, 2)

/** 新建的默认值，照原型 newHook；默认负责人留空（后端按干系人名册对，「我」对不上） */
export function newDraft(defaultPriority = 'P2'): HookDraft {
  return {
    name: '', enabled: true,
    mapping: { title: 'title', desc: 'description', priority: 'priority', assignee: '', due: '' },
    filter: '', dedupe: '', defaults: { priority: defaultPriority, assignee: '' }, sample: DEFAULT_SAMPLE,
  }
}

export function draftOf(h: Webhook): HookDraft {
  return {
    name: h.name, enabled: h.enabled, mapping: { ...h.mapping }, filter: h.filter, dedupe: h.dedupe,
    defaults: { ...h.defaults }, sample: h.sample,
  }
}

const sameObj = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b)

/** 只挑改动的字段；mapping、defaults 整体替换 */
export function buildPatch(before: HookDraft, d: HookDraft): WebhookPatch {
  const p: WebhookPatch = {}
  if (d.name.trim() !== before.name) p.name = d.name.trim()
  if (d.enabled !== before.enabled) p.enabled = d.enabled
  if (!sameObj(trimMapping(d.mapping), before.mapping)) p.mapping = trimMapping(d.mapping)
  if (d.filter.trim() !== before.filter) p.filter = d.filter.trim()
  if (d.dedupe.trim() !== before.dedupe) p.dedupe = d.dedupe.trim()
  const defs = { priority: d.defaults.priority, assignee: d.defaults.assignee.trim() }
  if (!sameObj(defs, before.defaults)) p.defaults = defs
  if (d.sample !== before.sample) p.sample = d.sample
  return p
}

export function buildCreate(d: HookDraft): WebhookInput {
  return {
    name: d.name.trim(), enabled: d.enabled, mapping: trimMapping(d.mapping), filter: d.filter.trim(), dedupe: d.dedupe.trim(),
    defaults: { priority: d.defaults.priority, assignee: d.defaults.assignee.trim() }, sample: d.sample,
  }
}

function trimMapping(m: WebhookMapping): WebhookMapping {
  const out = {} as WebhookMapping
  for (const k of FIELDS) out[k] = m[k].trim()
  return out
}

/** 保存前的必填检查，和底栏的红字一致 */
export function draftError(d: HookDraft): string {
  if (!d.name.trim()) return '还没有名称'
  if (!d.mapping.title.trim()) return '标题映射必填'
  return ''
}

/* ---------- 密钥和签名 ---------- */

// 密钥明文只在新建、轮换的那一次响应里有。记在内存里，同一次打开里离开再回来还能测试推送；刷新页面就没了，不落任何存储
const plainSecrets = new Map<string, string>()
export const rememberSecret = (id: string, secret: string) => { plainSecrets.set(id, secret) }
export const secretOf = (id: string) => plainSecrets.get(id) ?? ''
export const forgetSecret = (id: string) => { plainSecrets.delete(id) }

export const maskSecret = (s: string) => `${s.slice(0, 6)}${'•'.repeat(12)}`

/** 浏览器能不能算 HMAC：crypto.subtle 只在安全上下文（https、localhost、127.0.0.1）里有 */
export const canSign = () => typeof globalThis.crypto?.subtle?.importKey === 'function'

/** 签名：用密钥明文对原始请求体做 HMAC-SHA256，十六进制（契约「收件和投递记录」） */
export async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)))
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 测试推送的投递 id：每次不同，没配去重字段时不会被当成重复推送（和原型一致：只按去重字段去重） */
export const testDeliveryId = (now = Date.now()) => `test-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** curl 示例：带地址、签名头和当前测试推送内容，密钥留占位不写明文；单引号按 shell 规则转义 */
export function curlExample(url: string, body: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  return [
    `SECRET='<Secret>'`,
    `BODY=${q(body)}`,
    `SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')`,
    `curl -X POST ${q(url)} \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H "X-PMW-Signature: $SIG" \\`,
    `  -d "$BODY"`,
  ].join('\n')
}
