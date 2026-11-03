// 内网域名：给本机跑的服务配好记的域名（app.pmw.lan、状态看板.pmw.lan），自己和局域网里的同事不用记端口
// 解析靠 hosts 文件、本机 DNS 或路由器 DNS；同一个 80 / 443 端口上按域名转发到各服务，靠反向代理
// 原型里只生成配置、模拟解析测试，不真的改系统

export type ResolveMode = 'hosts' | 'local_dns' | 'router_dns'
export const RESOLVE_MODE: Record<ResolveMode, { label: string; desc: string }> = {
  hosts: { label: 'hosts 文件', desc: '只对这台电脑生效；写进 /etc/hosts 要管理员权限' },
  local_dns: { label: '本机 DNS', desc: '本机跑 dnsmasq，泛解析整个后缀；局域网设备把 DNS 指到这台电脑也能用' },
  router_dns: { label: '路由器 DNS', desc: '在路由器或内网 DNS 上加一条泛解析，局域网所有设备都能用' },
}

export type ProxyKind = 'builtin' | 'caddy' | 'nginx'
export const PROXY_KIND: Record<ProxyKind, { label: string; desc: string }> = {
  builtin: { label: '内置代理', desc: '工作台自己监听 80 / 443 转发，不用另装软件' },
  caddy: { label: 'Caddy', desc: '生成 Caddyfile，自动签本地证书' },
  nginx: { label: 'Nginx', desc: '生成 server 配置片段' },
}

export interface DomainSettings {
  enabled: boolean
  /** 域名后缀，比如 pmw.lan；别用 .local（被 mDNS 占用） */
  suffix: string
  resolve: ResolveMode
  proxy: ProxyKind
  https: boolean
  /** 本地根证书装进系统钥匙串了没有；没装浏览器会报不安全 */
  ca_installed: boolean
  /** 允许局域网访问：代理监听 0.0.0.0，域名解析到本机局域网 IP */
  lan: boolean
  lan_ip: string
  /** 项目原型自动按名字分配域名 */
  auto_proto: boolean
}

export type RouteTarget =
  | { kind: 'app' }
  | { kind: 'proto'; proto_id: string }
  | { kind: 'url'; url: string }

export interface DomainRoute {
  id: string
  /** 子域名部分，完整域名 = host + '.' + suffix */
  host: string
  target: RouteTarget
  enabled: boolean
  /** 自动分配的（跟着原型走，原型删了它也删） */
  auto?: boolean
  note?: string
  /** 最近一次解析测试 */
  check?: { ok: boolean; at: string; message: string }
}

export const seedDomainSettings: DomainSettings = {
  enabled: true, suffix: 'pmw.lan', resolve: 'hosts', proxy: 'builtin', https: false, ca_installed: false, lan: false, lan_ip: '192.168.1.23', auto_proto: true,
}

export const seedDomainRoutes: DomainRoute[] = [
  { id: 'dm_app', host: 'app', target: { kind: 'app' }, enabled: true, note: '这个工作台' },
  { id: 'dm_pm', host: 'pm', target: { kind: 'url', url: 'http://127.0.0.1:7777' }, enabled: true, note: '旧版工作台（真实数据）' },
  { id: 'dm_video', host: 'video', target: { kind: 'url', url: 'http://127.0.0.1:7801' }, enabled: true, note: '视频演示工程的预览服务' },
]

/** 子域名只允许小写字母、数字、连字符；中文名转成拼音太重，原型里用 proto-<端口> 兜底 */
export function slugHost(name: string, port: number) {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s.length >= 2 ? s : `proto-${port}`
}
export const validHost = (h: string) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(h)
export const validSuffix = (s: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(s) && !/\.?local$/.test(s)

export const fqdn = (r: DomainRoute, s: DomainSettings) => `${r.host}.${s.suffix}`
export const domainUrl = (r: DomainRoute, s: DomainSettings) => `${s.https ? 'https' : 'http'}://${fqdn(r, s)}`

/** 同名的域名冲突：启用的里面有两条一样就都标出来 */
export function conflicts(routes: DomainRoute[]) {
  const seen = new Map<string, number>()
  for (const r of routes) if (r.enabled) seen.set(r.host, (seen.get(r.host) ?? 0) + 1)
  return new Set([...seen].filter(([, n]) => n > 1).map(([h]) => h))
}

/** 生成配置：hosts 行 / dnsmasq / 反向代理 */
export function renderConfig(routes: DomainRoute[], s: DomainSettings, upstream: (r: DomainRoute) => string | null) {
  const on = routes.filter((r) => r.enabled)
  const ip = s.lan ? s.lan_ip : '127.0.0.1'
  const resolve = s.resolve === 'hosts'
    ? on.map((r) => `${ip}\t${fqdn(r, s)}`).join('\n')
    : s.resolve === 'local_dns'
      ? `# /opt/homebrew/etc/dnsmasq.conf\naddress=/${s.suffix}/${ip}\n\n# /etc/resolver/${s.suffix}\nnameserver 127.0.0.1`
      : `# 在路由器的 DNS 设置里加一条泛解析\n*.${s.suffix}  A  ${s.lan_ip}`
  const listen = s.lan ? '0.0.0.0' : '127.0.0.1'
  const proxy = s.proxy === 'caddy'
    ? on.map((r) => `${s.https ? '' : 'http://'}${fqdn(r, s)} {\n  bind ${listen}\n  ${s.https ? 'tls internal\n  ' : ''}reverse_proxy ${(upstream(r) ?? '127.0.0.1:0').replace(/^https?:\/\//, '')}\n}`).join('\n\n')
    : s.proxy === 'nginx'
      ? on.map((r) => `server {\n  listen ${listen}:${s.https ? '443 ssl' : '80'};\n  server_name ${fqdn(r, s)};\n  location / {\n    proxy_pass ${upstream(r) ?? 'http://127.0.0.1:0'};\n    proxy_set_header Host $host;\n    proxy_set_header Upgrade $http_upgrade;\n    proxy_set_header Connection "upgrade";\n  }\n}`).join('\n\n')
      : on.map((r) => `${fqdn(r, s)}  ->  ${upstream(r) ?? '未运行'}`).join('\n')
  return { resolve, proxy }
}

export interface ProtoRef { id: string; name: string; project: string; port: number; status: string }

/** 实际生效的域名：手动配的 + 自动分配给原型的（没手动配过的原型才自动分配，不存，跟着原型走） */
export function allRoutes(routes: DomainRoute[], s: DomainSettings, protos: ProtoRef[]): DomainRoute[] {
  if (!s.auto_proto) return routes
  const taken = new Set(routes.map((r) => r.host))
  const auto = protos.filter((p) => !routes.some((r) => r.target.kind === 'proto' && r.target.proto_id === p.id)).map((p): DomainRoute => {
    let host = slugHost(p.name, p.port)
    if (taken.has(host)) host = `${host}-${p.port}`
    taken.add(host)
    return { id: `auto_${p.id}`, host, target: { kind: 'proto', proto_id: p.id }, enabled: true, auto: true }
  })
  return [...routes, ...auto]
}

/** 某个原型的内网域名；没开或没分配返回 null */
export function protoDomain(protoId: string, routes: DomainRoute[], s: DomainSettings, protos: ProtoRef[]) {
  if (!s.enabled) return null
  const r = allRoutes(routes, s, protos).find((x) => x.enabled && x.target.kind === 'proto' && x.target.proto_id === protoId)
  return r ? domainUrl(r, s) : null
}
