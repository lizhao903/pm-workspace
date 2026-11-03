// 内网域名设置分节的纯函数：选项文案、校验（同后端 settings.go）、目标的显示、同名、搜索、自动分配的按项目分组
import type { DomainProxy, DomainResolve, DomainRoute, DomainSettings, DomainStatusState, TerminalPrototype } from '../../core/data'

export const RESOLVE_MODE: Record<DomainResolve, { label: string; desc: string }> = {
  hosts: { label: 'hosts 文件', desc: '只对这台电脑生效；写进 /etc/hosts 要管理员权限' },
  local_dns: { label: '本机 DNS', desc: '本机跑 dnsmasq，泛解析整个后缀；局域网设备把 DNS 指到这台电脑也能用' },
  router_dns: { label: '路由器 DNS', desc: '在路由器或内网 DNS 上加一条泛解析，局域网所有设备都能用' },
}

export const PROXY_KIND: Record<DomainProxy, { label: string; desc: string }> = {
  builtin: { label: '内置代理', desc: '工作台自己监听 80 / 443 转发，不用另装软件' },
  caddy: { label: 'Caddy', desc: '生成 Caddyfile，自动签本地证书' },
  nginx: { label: 'Nginx', desc: '生成 server 配置片段' },
}

export const STATE_LABEL: Record<DomainStatusState, string> = { ok: '正常', problem: '有问题', unknown: '没检测到' }

/** 状态项的分组名，后端 group 字段 */
export const STATUS_GROUP: Record<string, string> = {
  hosts: 'hosts',
  resolve: '解析',
  pf: '端口转发',
  reach: '可达',
  cert: '证书',
}

const suffixRe = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/
const hostRe = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const ipv4Re = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/** 后缀：小写字母数字连字符、点隔开，不能是 local 或以 .local 结尾 */
export function validSuffix(s: string) {
  return s.length <= 200 && suffixRe.test(s) && s !== 'local' && !s.endsWith('.local')
}

/** 子域名：小写字母数字连字符，1 到 63 个，不以连字符开头结尾 */
export function validHost(h: string) {
  return hostRe.test(h)
}

export function validIPv4(s: string) {
  return ipv4Re.test(s)
}

/** 输入框里的后缀、子域名：去空白、转小写 */
export const normName = (s: string) => s.replace(/\s+/g, '').toLowerCase()

/** 别名框：空格、逗号、换行隔开，去重 */
export function parseAliases(text: string): string[] {
  return [...new Set(text.split(/[\s,，]+/).map(normName).filter(Boolean))]
}

/** 别名每个按后缀规则，还要带点、不重复、不等于后缀；不合法返回说明 */
export function aliasError(aliases: string[], suffix: string): string {
  const bad = aliases.find((a) => !validSuffix(a) || !a.includes('.'))
  if (bad) return `别名 ${bad} 不合法：要是带点的完整域名，也别用 .local`
  if (aliases.includes(suffix)) return '别名不能和后缀相同'
  return ''
}

export function validPort(n: number) {
  return Number.isInteger(n) && n >= 1 && n <= 65535
}

export const domainUrl = (r: DomainRoute, s: DomainSettings) => `${s.https ? 'https' : 'http'}://${r.fqdn}`

/** 目标这一列：工作台写明文口，原型写「项目 / 原型（:端口）」，地址写原文 */
export function targetLabel(r: DomainRoute, s: DomainSettings, protos: readonly TerminalPrototype[]) {
  const t = r.target
  if (t.kind === 'app') return `一人之下（:${s.http_port}）`
  if (t.kind === 'url') return t.url
  const p = protos.find((x) => x.id === t.proto_id)
  return p ? `${p.project_title} / ${p.name}（:${p.port}）` : '已删除的原型'
}

/** 目标原型没在跑（原型已删的不算，那条写「已删除的原型」） */
export function protoDown(r: DomainRoute, protos: readonly TerminalPrototype[]) {
  const a = protoAccess(r, protos)
  return a === 'starting' || a === 'down'
}

export type ProtoAccess = 'up' | 'starting' | 'down' | 'gone'

/** 目标是原型时跟着原型状态：在跑能访问，启动中、停着、崩了访问不了，原型删了另说；目标不是原型回 null */
export function protoAccess(r: DomainRoute, protos: readonly TerminalPrototype[]): ProtoAccess | null {
  if (r.target.kind !== 'proto') return null
  const id = r.target.proto_id
  const p = protos.find((x) => x.id === id)
  if (!p) return 'gone'
  return p.status === 'running' ? 'up' : p.status === 'starting' ? 'starting' : 'down'
}

export const PROTO_ACCESS: Record<ProtoAccess, string> = {
  up: '原型在运行，可以访问',
  starting: '原型启动中',
  down: '原型没在运行',
  gone: '原型已删除',
}

/** 自动分配关掉后自动行不显示（后端关掉时删掉全部自动行，SPEC-settings-20.37） */
export const visibleRoutes = (routes: readonly DomainRoute[], s: DomainSettings) => (s.auto_proto ? [...routes] : routes.filter((r) => !r.auto))

/** 自动分配开着、在跑却还没有指向它的路由的原型 id（后端收到启动事件后才建，排好序拼成一个键，变了就重新等） */
export function awaitingAuto(routes: readonly DomainRoute[] | undefined, protos: readonly TerminalPrototype[], s: DomainSettings) {
  if (!s.auto_proto || !routes) return ''
  const has = new Set(routes.flatMap((r) => (r.target.kind === 'proto' ? [r.target.proto_id] : [])))
  return protos.filter((p) => p.status === 'running' && !has.has(p.id)).map((p) => p.id).sort().join(',')
}

/** 启用的里重名的完整域名（含和工作台别名撞的） */
export function conflicts(routes: readonly DomainRoute[], aliases: readonly string[] = []): Set<string> {
  const seen = new Set<string>(aliases)
  const dup = new Set<string>()
  for (const r of routes) {
    if (!r.enabled) continue
    if (seen.has(r.fqdn)) dup.add(r.fqdn)
    seen.add(r.fqdn)
  }
  return dup
}

/** 搜索：完整域名、目标、备注，不分大小写 */
export function matchRoute(r: DomainRoute, kw: string, target: string) {
  const k = kw.trim().toLowerCase()
  return !k || `${r.fqdn} ${target} ${r.note}`.toLowerCase().includes(k)
}

/** 有问题：启用且同名，或最近一次测试失败 */
export const routeProblem = (r: DomainRoute, dup: ReadonlySet<string>) => (r.enabled && dup.has(r.fqdn)) || (!!r.check && !r.check.ok)

export type AutoGroup = { name: string; xs: DomainRoute[]; bad: number; on: number }

/** 自动分配的按项目分组，组按第一次出现的先后 */
export function groupAuto(routes: readonly DomainRoute[], protos: readonly TerminalPrototype[], dup: ReadonlySet<string>): AutoGroup[] {
  const by = new Map<string, DomainRoute[]>()
  for (const r of routes) {
    const t = r.target
    const name = t.kind === 'proto' ? protos.find((p) => p.id === t.proto_id)?.project_title ?? '已删除的项目' : '其他'
    by.set(name, [...(by.get(name) ?? []), r])
  }
  return [...by].map(([name, xs]) => ({
    name, xs, bad: xs.filter((r) => routeProblem(r, dup)).length, on: xs.filter((r) => r.enabled).length,
  }))
}

/** 加域名表单的子域名提示 */
export function hostError(host: string, routes: readonly DomainRoute[]) {
  if (!host) return ''
  if (!validHost(host)) return '只能用小写字母、数字和连字符'
  if (routes.some((r) => r.host === host)) return '已经有这个域名了'
  return ''
}

/** 相对时间：刚刚、N 分钟前、N 小时前、N 天前 */
export function timeAgo(iso: string, now = Date.now()) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const m = Math.floor((now - t) / 60_000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}
