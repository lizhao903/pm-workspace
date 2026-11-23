// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 外部插件（P1-a）前端运行时桥。
//
// 外部插件不进前端构建：后端安装、启用后，GET /api/plugins/external 会给出每一行的清单摘要和
// web 入口；这里按 <id>/<version> 动态 import 同源的 web/entry.js，插件在模块求值时调用
// window.__PMW_PLUGIN__.register({ id, api, activate, deactivate }) 登记自己。
// activate 拿到的 ctx 是 v2 语义（slots/host.call/permissions/notify/i18n/theme），这里把它映射到
// 1.x 已有的注册表（moduleStore/settingsStore/todayCardStore/命令面板），插件组件包裹
// [data-pmw-plugin] 作用域容器；React 由 import map 指到宿主同一份实例。
//
// 规范见 docs/plugin-spec-v2.md 第 8 节；第一方插件的加载路径（registry.ts）不因这里改变。
import { createElement, lazy, type ComponentType } from 'react'
import { request, requestList } from '../api'
import type { Disposable, PluginApi, PluginEntry } from './api'
import type { PluginManifest } from './manifest'
import type { PluginSource } from './registry'
import { satisfies } from './semver'
import { Button } from '../ui/Button'
import { PageTitle } from '../ui/PageTitle'

/** 宿主对外部插件承诺的 API 版本；清单 api 范围必须包含它（docs/plugin-spec-v2.md 1.2） */
export const EXTERNAL_API_VERSION = '2.0.0'

/** 外部插件管理接口前缀（docs/api-contract.md 外部插件小节） */
export const EXTERNAL_PLUGINS_PATH = '/api/plugins/external'

// ---------------------------------------------------------------------------
// 后端 JSON 形状（brief §5）。字段按 Go struct tag 的 snake_case；后端可能多给的字段标成可选，
// 这样接口对不上的部分不会让整行数据被丢掉。
// ---------------------------------------------------------------------------

export type ExternalSourceType = 'dir' | 'archive' | 'github'

export type ExternalSource = {
  type: ExternalSourceType | string
  /** dir / archive 的本地绝对路径 */
  path?: string
  /** github 的仓库、Release 或资产直链 */
  url?: string
  /** 可选，期望的包 SHA-256 */
  sha256?: string
}

/** 清单 v2 里前端用得到的字段（docs/plugin-spec-v2.md 4.2） */
export type ExternalManifestV2 = {
  manifest_version?: number
  id: string
  name: string
  description?: string
  version: string
  api: string
  pmw?: string
  license?: string
  homepage?: string
  repository?: string
  icon?: string
  provides?: Record<string, string[]>
  permissions?: string[]
  permissions_reason?: Record<string, string>
  runtime?: {
    backend?: Record<string, unknown>
    web?: { entry?: string; styles?: string[] }
  }
}

/** GET /api/plugins/external 的一行（Info + 前端需要的 web_entry） */
export type ExternalRow = {
  id: string
  name: string
  description?: string
  version: string
  /** 清单 api 范围，例 >=2.0.0 <3.0.0 */
  api: string
  pmw?: string
  license?: string
  repository?: string
  icon?: string
  /** 前端入口，包内相对路径，例 web/entry.js */
  web_entry?: string
  enabled: boolean
  running: boolean
  installed_at?: string
  source?: ExternalSource
  package_sha256?: string
  permissions?: string[]
  /** 已授予的权限（普通权限安装时确认，高风险的单独授权） */
  granted?: string[]
  provides?: Record<string, string[]>
  error?: string
  install_dir?: string
  data_dir?: string
  /** 非空表示有可回滚的上一版本 */
  previous_version?: string
  /** 信任等级：verified（发布者签名验证通过）/community（未签名） */
  tier?: string
  publisher_id?: string
  /** 后端要是把清单原文一起给了就用（样式、依赖等）；没有也能跑 */
  manifest?: ExternalManifestV2
  /** 清单 runtime.web.styles；后端 Info 没这个字段时靠 manifest 兜底 */
  web_styles?: string[]
  styles?: string[]
  depends?: Record<string, string>
  optional_depends?: Record<string, string>
  emits?: string[]
  subscribes?: string[]
}

export type ExternalMarketInstall = { type: string; url: string; sha256: string }
export type ExternalMarketVersion = {
  version: string
  published_at?: string
  compatible: boolean
  reason?: string
  install: ExternalMarketInstall
  permissions?: string[]
}
export type ExternalMarketEntry = {
  id: string
  title: string
  description?: string
  author?: string
  repository?: string
  categories?: string[]
  labels?: string[]
  versions: ExternalMarketVersion[]
}
export type ExternalMarketView = {
  title: string
  description?: string
  entries: ExternalMarketEntry[]
  signed?: boolean
  publisher?: string
}

export type ExternalCheck = { name: string; ok: boolean; detail?: string }

export type ExternalPermissionInfo = {
  name: string
  reason?: string
  /** normal | high | separate（brief §2） */
  risk?: string
  granted?: boolean
}

/** POST /api/plugins/external/resolve 的返回（brief §2 Preview） */
export type ExternalPreview = {
  tier?: string
  manifest: ExternalManifestV2
  source?: ExternalSource
  package_sha256?: string
  platform?: string
  entry?: string
  web_entry?: string
  compatible: boolean
  checks?: ExternalCheck[]
  permissions?: ExternalPermissionInfo[]
  existing?: ExternalRow | null
}

/** POST /api/plugins/external/install 的返回 */
export type ExternalInstallResult = {
  plugin: ExternalRow
  enabled: boolean
  warnings?: string[]
}

/** 入口注册的东西；插件 bundle 在求值时同步调用一次 */
export type ExternalRegistration = {
  id: string
  /** 清单 api 范围，宿主会再校验一次 */
  api?: string
  activate(ctx: ExternalCtx): void
  deactivate?: () => void
}

export type ExternalSlotKind = 'module' | 'settings.section' | 'today.card' | 'command' | 'object.section'

export type ExternalSlotSpec = {
  id?: string
  key?: string
  title?: string
  icon?: string
  order?: number
  keywords?: string
  run?: (...args: unknown[]) => unknown
  [key: string]: unknown
}

export type ExternalDisposable = { dispose(): void }

export type ExternalNotifyPayload = { level?: string; title?: string; body?: string }

export type ExternalCtx = {
  readonly id: string
  readonly version: string
  readonly apiVersion: string
  slots: {
    /** 槽位 → 1.x 注册表；组件会被包一层 [data-pmw-plugin] 容器 */
    register(kind: ExternalSlotKind, spec: ExternalSlotSpec, component?: unknown): Disposable
  }
  host: {
    /** 调宿主 broker（host.objects.list 等），非 2xx 时 reject 带 message 的 Error */
    call(method: string, params?: unknown): Promise<unknown>
  }
  permissions: {
    /** 只看已授予；仅用于展示/降级，真正的授权在宿主 broker */
    has(permission: string): boolean
  }
  notify(payload: ExternalNotifyPayload): Promise<unknown>
  /** 打开 http(s) 外链；宿主负责校验协议，其它协议直接拒绝 */
  openExternal(url: string): void
  i18n: {
    lang: string
    t(key: string, vars?: Record<string, string | number>): string
  }
  theme: {
    mode: 'light' | 'dark' | 'system'
    resolved: 'light' | 'dark'
    subscribe(cb: (resolved: 'light' | 'dark') => void): Disposable
  }
  /**
   * 宿主 UI 组件（2026-11-23 起）：PageTitle 把标题、说明和操作放进顶栏标题行，Button 是宿主按钮。
   * 渲染在 [data-pmw-plugin] 容器之外（顶栏），用宿主样式；旧宿主没有这一项，插件要自己兜底。
   */
  ui: {
    PageTitle: typeof PageTitle
    Button: typeof Button
  }
}

// window.__PMW_PLUGIN__ 的全局声明；插件脚本靠它登记
declare global {
  interface Window {
    __PMW_PLUGIN__?: { register(reg: ExternalRegistration): void }
  }
}

// ---------------------------------------------------------------------------
// 数据读取：列表失败/404 一律当没有外部插件，不能挡住内核模块启动
// ---------------------------------------------------------------------------

function isExternalRow(v: unknown): v is ExternalRow {
  return typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string'
}

/** GET /api/plugins/external；404、服务没起、超时都返回 []，不抛。
 * 传了 signal（启动时和第一方插件列表共用一个超时）就一起中止。 */
export async function fetchExternalRows(timeoutMs = 2000, signal?: AbortSignal): Promise<ExternalRow[]> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  const abort = () => ctl.abort()
  if (signal) {
    if (signal.aborted) ctl.abort()
    else signal.addEventListener('abort', abort, { once: true })
  }
  try {
    const r = await requestList<ExternalRow>(EXTERNAL_PLUGINS_PATH, { signal: ctl.signal })
    return r.data.filter(isExternalRow)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/** 宿主 API 版本是否落在插件声明的 api 范围里 */
export function apiCompatible(api: string | undefined | null): boolean {
  return typeof api === 'string' && api.trim() !== '' && satisfies(EXTERNAL_API_VERSION, api)
}

/** v2 清单摘要 → 1.x 的 PluginManifest 形态。
 *
 * external 的行在 resolvePlugins/activatePlugin 里会跳过 v1 的 parseManifest/checkManifest
 * （清单已由后端校验），这里只需要把 1.x 注册表要用的字段填上：
 * - core 放 v2 的 api 范围（不按 1.x 解释，只给 external 的兼容检查用）
 * - provides/permissions/依赖/事件原样搬过来，模块、命令、设置槽位的登记检查靠它
 */
export function externalManifest(row: ExternalRow): PluginManifest {
  const provides: PluginManifest['provides'] = {}
  for (const [key, list] of Object.entries(row.provides ?? {})) {
    if (Array.isArray(list)) provides[key as keyof PluginManifest['provides']] = list.filter((x) => typeof x === 'string')
  }
  const m: PluginManifest = {
    id: row.id,
    name: row.name || row.id,
    version: row.version || '0.0.0',
    core: (row.api ?? '').trim() || `>=${EXTERNAL_API_VERSION} <3.0.0`,
    provides,
    permissions: [...(row.permissions ?? [])],
  }
  if (row.description) m.description = row.description
  // 1.x 的 icon 是外壳内置图标 key；v2 的 icon 是包内路径，对不上的不传，菜单用默认图标
  if (row.icon && /^[a-z][a-z0-9_]*$/.test(row.icon)) m.icon = row.icon
  if (row.depends) m.depends = { ...row.depends }
  if (row.optional_depends) m.optional_depends = { ...row.optional_depends }
  if (row.emits) m.emits = [...row.emits]
  if (row.subscribes) m.subscribes = [...row.subscribes]
  return m
}

// 启动时读到的 external sources（只有启用的），activatePlugin 的默认 sources 从这里合并
let cachedExternal: PluginSource[] = []

/** 记下本次列表里启用的外部插件，activatePlugin 没显式给 sources 时用 */
export function rememberExternalSources(sources: readonly PluginSource[]): void {
  cachedExternal = [...sources]
}

/** 启动时读到的外部插件 sources */
export function cachedExternalSources(): readonly PluginSource[] {
  return cachedExternal
}

/** 一个行 → PluginSource；load 时才去拉入口脚本 */
export function externalSource(row: ExternalRow): PluginSource {
  return {
    id: row.id,
    external: true,
    manifest: externalManifest(row),
    load: () => loadExternalEntry(row),
  }
}

/** 列表 → sources。默认只要启用的（启动时按后端 enabled 加载） */
export function externalSources(rows: readonly ExternalRow[], opts: { enabledOnly?: boolean } = {}): PluginSource[] {
  const enabledOnly = opts.enabledOnly ?? true
  const out: PluginSource[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row || !isExternalRow(row)) continue
    if (enabledOnly && row.enabled !== true) continue
    if (seen.has(row.id)) continue
    seen.add(row.id)
    out.push(externalSource(row))
  }
  return out
}

// ---------------------------------------------------------------------------
// 入口脚本 URL 与加载
// ---------------------------------------------------------------------------

/** 清单里的 web 入口；后端 Info 没给时退回清单原文（如果有） */
export function externalEntryRel(row: ExternalRow): string {
  const own = typeof row.web_entry === 'string' ? row.web_entry.trim() : ''
  if (own) return own
  const fromManifest = row.manifest?.runtime?.web?.entry
  return typeof fromManifest === 'string' ? fromManifest.trim() : ''
}

/** /api/plugins/external/<id>/web/<rel>?v=<version>。
 *
 * 路由命名空间是 /web/，后端可能把 rel 解释成「web 目录内相对」或「安装目录内相对」，
 * 所以加载时会两种 URL 都试（见 externalWebUrls）。
 */
export function externalWebUrl(id: string, rel: string, version?: string): string {
  const clean = rel.trim().replace(/^\/+/, '')
  const path = clean.split('/').filter(Boolean).map((s) => encodeURIComponent(s)).join('/')
  const base = `${EXTERNAL_PLUGINS_PATH}/${encodeURIComponent(id)}/web/${path}`
  return version ? `${base}?v=${encodeURIComponent(version)}` : base
}

/** 入口脚本的候选 URL：先去 web/ 前缀（web 根相对），再保留原路径（安装目录相对） */
export function externalWebUrls(row: ExternalRow, rel = externalEntryRel(row)): string[] {
  const clean = rel.trim().replace(/^\/+/, '')
  const stripped = clean.replace(/^web\//, '')
  const rels = stripped === clean ? [clean] : [stripped, clean]
  return [...new Set(rels.filter(Boolean))].map((r) => externalWebUrl(row.id, r, row.version))
}

/** 清单 runtime.web.styles 的 URL 列表；后端 Info 有 web_styles/styles 时也收 */
export function externalStyleUrls(row: ExternalRow): string[] {
  const fromRow = [...(row.web_styles ?? []), ...(row.styles ?? [])]
  const fromManifest = row.manifest?.runtime?.web?.styles ?? []
  const rels = [...fromRow, ...fromManifest].filter((s): s is string => typeof s === 'string' && s.trim() !== '')
  return [...new Set(rels)].map((s) => externalWebUrl(row.id, s.replace(/^\/+/, '').replace(/^web\//, ''), row.version))
}

// 已求值过的入口模块：动态 import 同一 URL 只会执行一次，重新启用时直接复用登记
const moduleRegistrations = new Map<string, ExternalRegistration>()
// 加载期的登记表：入口求值时同步 register，导入完成后按 id 取走
const pendingRegistrations = new Map<string, ExternalRegistration[]>()
// 正在 import 的插件 id：register 只接受这些 id，防止插件 A 在求值时替 B 登记
const loadingIds = new Set<string>()

function registerExternalPlugin(reg: ExternalRegistration): void {
  if (!reg || typeof reg !== 'object' || typeof reg.id !== 'string' || reg.id === '') return
  // 有插件正在 import 时，只接受它自己的 id（A 不能替同时加载的 B 登记）；
  // 没有加载进行中时允许（测试/手动调用；下一次加载前会 clear，不会串到别的插件）。
  if (loadingIds.size > 0 && !loadingIds.has(reg.id)) {
    console.error(`[pmw-plugin] 拒绝登记：${reg.id} 不在本次加载中（只有当前加载的插件能 register 自己的 id）`)
    return
  }
  const list = pendingRegistrations.get(reg.id) ?? []
  list.push(reg)
  pendingRegistrations.set(reg.id, list)
}

let runtimeInstalled = false

/**
 * 注入 window.__PMW_PLUGIN__（幂等）。
 * 用不可写/不可配置属性：先加载的插件不能把全局改成自己的 register 来劫持后加载的插件。
 * 浏览器以外的环境（单测）直接跳过；若全局已被更早的版本占用，只读复用。
 */
export function installPluginRuntime(): void {
  if (typeof window === 'undefined') return
  if (window.__PMW_PLUGIN__ && typeof window.__PMW_PLUGIN__.register === 'function') {
    runtimeInstalled = true
    return
  }
  if (runtimeInstalled) return
  runtimeInstalled = true
  try {
    Object.defineProperty(window, '__PMW_PLUGIN__', {
      value: { register: registerExternalPlugin },
      writable: false,
      configurable: false,
      enumerable: false,
    })
  } catch {
    // 极端环境（旧浏览器/被提前定义）降级为普通赋值
    window.__PMW_PLUGIN__ = { register: registerExternalPlugin }
  }
}

/** 取出某个插件这次求值登记的入口（测试和加载路径共用） */
export function takeExternalRegistrations(id: string): ExternalRegistration[] {
  const list = pendingRegistrations.get(id) ?? []
  pendingRegistrations.delete(id)
  return list
}

/** 丢掉某个插件还没被取走的登记（加载失败时） */
export function clearExternalRegistrations(id: string): void {
  pendingRegistrations.delete(id)
}

/** 入口登记是否和清单一致：id、api 兼容性、activate 是否存在 */
export function validateExternalRegistration(row: ExternalRow, reg: ExternalRegistration | undefined): string[] {
  if (!reg) return [`前端入口没有调用 window.__PMW_PLUGIN__.register（插件 ${row.id}）`]
  const problems: string[] = []
  if (reg.id !== row.id) problems.push(`入口注册的 id 是 ${reg.id}，和清单 id ${row.id} 不一致`)
  if (typeof reg.api === 'string' && reg.api.trim() !== '') {
    if (!apiCompatible(reg.api)) {
      problems.push(`入口注册的 api ${reg.api} 不包含宿主 API ${EXTERNAL_API_VERSION}`)
    } else if (row.api && reg.api.trim() !== row.api.trim()) {
      problems.push(`入口注册的 api ${reg.api} 和清单 api ${row.api} 不一致`)
    }
  }
  if (typeof reg.activate !== 'function') problems.push('入口没有提供 activate(ctx)')
  return problems
}

/** 加载前的整体校验：id、api 兼容、web 入口存在 */
export function validateExternalRow(row: ExternalRow): string[] {
  const problems: string[] = []
  if (!row.id) problems.push('缺少插件 id')
  if (!apiCompatible(row.api)) {
    problems.push(`清单要求宿主 API ${row.api || '（未声明）'}，当前宿主 API ${EXTERNAL_API_VERSION}，不兼容`)
  }
  if (!externalEntryRel(row)) problems.push('没有声明前端入口（web_entry）')
  return problems
}

async function loadRegistration(row: ExternalRow): Promise<ExternalRegistration> {
  const key = `${row.id}@${row.version}`
  const cached = moduleRegistrations.get(key)
  if (cached) return cached

  installPluginRuntime()
  clearExternalRegistrations(row.id)
  loadingIds.add(row.id)
  const urls = externalWebUrls(row)
  let lastError: unknown
  try {
    for (const url of urls) {
      try {
        // 插件入口不在构建里，URL 是运行时拼的（带 ?v=<version> 破缓存）
        await import(/* @vite-ignore */ url)
        lastError = undefined
        break
      } catch (e) {
        lastError = e
      }
    }
  } finally {
    loadingIds.delete(row.id)
  }
  const registrations = takeExternalRegistrations(row.id)
  if (registrations.length > 1) {
    throw new Error(`插件 ${row.id} 的前端入口重复调用 register（${registrations.length} 次）`)
  }
  if (registrations.length === 0) {
    const detail = lastError instanceof Error ? `：${lastError.message}` : ''
    throw new Error(`插件 ${row.id} 的前端入口加载失败${detail}`)
  }
  const reg = registrations[0]
  const problems = validateExternalRegistration(row, reg)
  if (problems.length > 0) throw new Error(problems.join('；'))
  moduleRegistrations.set(key, reg)
  return reg
}

// ---------------------------------------------------------------------------
// CSS 注入：激活时挂 <link>，停用时按引用移除；不进构建、不改宿主全局样式
// ---------------------------------------------------------------------------

function injectExternalStyles(row: ExternalRow): HTMLLinkElement[] {
  if (typeof document === 'undefined') return []
  return externalStyleUrls(row).map((href) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.dataset.pmwPlugin = row.id
    document.head.appendChild(link)
    return link
  })
}

function removeExternalStyles(links: readonly HTMLLinkElement[]): void {
  for (const link of links) {
    try {
      link.remove()
    } catch {
      /* 已经不在文档里就算了 */
    }
  }
}

// ---------------------------------------------------------------------------
// ctx：v2 语义 → 1.x 注册表
// ---------------------------------------------------------------------------

function scopedComponent(row: ExternalRow, component: unknown): ComponentType<Record<string, unknown>> {
  const Inner = (component ?? (() => null)) as ComponentType<Record<string, unknown>>
  function Scoped(props: Record<string, unknown>) {
    return createElement(
      'div',
      { 'data-pmw-plugin': row.id, className: 'pmw-plugin-host' },
      createElement(Inner, props),
    )
  }
  Scoped.displayName = `PluginSlot(${row.id})`
  return Scoped
}

function lazyScoped(row: ExternalRow, component: unknown): ReturnType<typeof lazy> {
  return lazy(async () => ({ default: scopedComponent(row, component) }))
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (all, key: string) => {
    const v = vars[key]
    return v === undefined ? all : String(v)
  })
}

function currentResolvedTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

/** 一个外部插件的 ctx；槽位登记走 api 上已经按插件 id 记过账的注册表，停用时由 registry 统一撤 */
export function externalCtx(row: ExternalRow, api: PluginApi): ExternalCtx {
  const granted = new Set(row.granted ?? [])
  const call = (method: string, params?: unknown) => callExternal(row.id, method, params)

  function unsupported(kind: ExternalSlotKind): Disposable {
    // object.section 本批没有对应的 1.x 注册表，先明确说不支持，不影响其它槽位
    console.warn(`[pmw-plugin] ${row.id} 的槽位 ${kind} 在 P1-a 还不支持，已忽略`)
    return { dispose() {} }
  }

  // 外部插件的扩展点 id 必须挂在插件自己的命名空间下，防止往内核菜单/设置里塞重名项。
  function requireOwnNamespace(kind: ExternalSlotKind, value: string, separator: '_' | '.'): string {
    const ok = value !== '' && (value === row.id || value.startsWith(row.id + separator))
    if (!ok) {
      throw new Error(`[pmw-plugin] ${row.id} 的 ${kind} id ${JSON.stringify(value)} 不在插件命名空间（应为 ${row.id} 或 ${row.id}${separator}...）`)
    }
    return value
  }

  return {
    id: row.id,
    version: row.version,
    apiVersion: EXTERNAL_API_VERSION,
    slots: {
      register(kind, spec, component) {
        const s = spec ?? {}
        switch (kind) {
          case 'module': {
            const id = requireOwnNamespace('module', typeof s.id === 'string' ? s.id : '', '_')
            return api.modules.register({
              id,
              label: typeof s.title === 'string' && s.title ? s.title : id,
              // 外部模块统一放 ext- 前缀，避免和内核/第一方模块的路径撞上
              path: `ext-${id}`,
              load: async () => ({ default: scopedComponent(row, component) }),
            })
          }
          case 'settings.section': {
            const key = requireOwnNamespace('settings.section', typeof s.id === 'string' ? s.id : '', '_')
            return api.settings.register({
              key,
              label: typeof s.title === 'string' && s.title ? s.title : key,
              page: lazyScoped(row, component),
            })
          }
          case 'today.card': {
            const key = requireOwnNamespace('today.card', typeof s.key === 'string' ? s.key : typeof s.id === 'string' ? s.id : '', '_')
            return api.todayCards.register({
              key,
              title: typeof s.title === 'string' && s.title ? s.title : key,
              ...(typeof s.order === 'number' ? { order: s.order } : {}),
              render: scopedComponent(row, component) as unknown as ComponentType<{ data: unknown }>,
            })
          }
          case 'command': {
            const id = requireOwnNamespace('command', typeof s.id === 'string' ? s.id : '', '.')
            return api.commands.register({
              id,
              group: '插件',
              title: typeof s.title === 'string' && s.title ? s.title : id,
              ...(typeof s.keywords === 'string' ? { keywords: s.keywords } : {}),
              run: () => Promise.resolve(s.run?.()).then(() => undefined),
            })
          }
          default:
            return unsupported(kind)
        }
      },
    },
    host: { call },
    permissions: { has: (permission) => granted.has(permission) },
    // 需要清单声明 notify；broker 拒绝时把错误交回给插件自己 catch 降级
    notify: (payload) => call('host.notify', payload),
    openExternal: (url: string) => {
      if (typeof window === 'undefined') return
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new Error('openExternal 只接受合法的 http(s) URL')
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('openExternal 只允许 http(s) 协议')
      }
      window.open(parsed.toString(), '_blank', 'noopener,noreferrer')
    },
    i18n: {
      lang: 'zh',
      t: (key, vars) => interpolate(key, vars),
    },
    theme: {
      mode: 'system',
      resolved: currentResolvedTheme(),
      subscribe: () => ({ dispose() {} }),
    },
    ui: { PageTitle, Button },
  }
}

/** 调宿主 broker：POST /api/plugins/external/<id>/call → data；非 2xx 抛带 message 的 ApiError */
export async function callExternal(id: string, method: string, params?: unknown): Promise<unknown> {
  return request<unknown>('POST', `${EXTERNAL_PLUGINS_PATH}/${encodeURIComponent(id)}/call`, {
    body: { method, params: params ?? {} },
  })
}

/**
 * 把一个外部插件行变成 registry 能加载的入口：
 * 拉入口脚本 → 校验登记 → activate 时注入 ctx 和样式 → deactivate 时清样式。
 * 错误边界由插件模板自带（docs/plugin-spec-v2.md 8.1），宿主不再包一层。
 */
export async function loadExternalEntry(row: ExternalRow): Promise<{ default: PluginEntry }> {
  const rowProblems = validateExternalRow(row)
  if (rowProblems.length > 0) throw new Error(rowProblems.join('；'))
  const reg = await loadRegistration(row)
  let styleLinks: HTMLLinkElement[] = []

  const entry: PluginEntry = {
    activate(api) {
      styleLinks = injectExternalStyles(row)
      try {
        reg.activate(externalCtx(row, api))
      } catch (e) {
        removeExternalStyles(styleLinks)
        styleLinks = []
        throw e
      }
    },
    deactivate() {
      try {
        reg.deactivate?.()
      } catch (e) {
        console.error(`[pmw-plugin] ${row.id} deactivate 出错`, e)
      } finally {
        removeExternalStyles(styleLinks)
        styleLinks = []
      }
    },
  }
  return { default: entry }
}
