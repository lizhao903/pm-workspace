// 插件清单的类型和校验（CORE-01b），规范见 docs/plugin-api.md。
// 后端 internal/plugin/manifest.go 是同一套规则，两边共用 docs/plugin-manifest-examples/ 的样例和期望错误，错误信息逐字一致。
import { parseRange, parseVersion, satisfies } from './semver'

// 内核对插件承诺的插件 API 版本；运行时以 GET /api/plugins 返回的为准
export const PLUGIN_API_VERSION = '1.0.0'

export type ExtensionPoint =
  | 'modules'
  | 'settings'
  | 'object_types'
  | 'connectors'
  | 'skills'
  | 'agent_tools'
  | 'sop_nodes'
  | 'today_cards'
  | 'commands'
  | 'search'
  | 'schedule_actions'

export type PluginProvides = Partial<Record<ExtensionPoint, string[]>>

export type PluginAdopts = {
  object_types?: string[]
  routes?: string[]
}

// plugin.json，字段名和清单一致（snake_case）
export type PluginManifest = {
  id: string
  name: string
  description?: string
  // 菜单图标：外壳内置图标的 key，外壳不认识的用默认图标
  icon?: string
  // 按模块给的菜单图标（模块 id 到图标 key），没给的模块用 icon
  icons?: Record<string, string>
  version: string
  core: string
  depends?: Record<string, string>
  optional_depends?: Record<string, string>
  provides: PluginProvides
  emits?: string[]
  subscribes?: string[]
  adopts?: PluginAdopts
  permissions: string[]
  migrations?: string
  table_prefix?: string
}

// 一条校验问题，field 是出错的字段路径，例 depends.projects、permissions[1]
export type ManifestIssue = { field: string; message: string }

export type ManifestResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; issues: ManifestIssue[] }

export type PluginEnv = {
  // 不传表示 PLUGIN_API_VERSION
  apiVersion?: string
  plugins: readonly PluginManifest[]
}

export function formatIssue(i: ManifestIssue): string {
  return `${i.field} ${i.message}`
}

// 内核保留字，插件 id 不能用（docs/plugin-api.md 1.4）
export const RESERVED_IDS: readonly string[] = [
  'api', 'admin', 'agent', 'agent_providers', 'agents', 'artifacts', 'audits', 'categories', 'connectors', 'contacts', 'conversations', 'core', 'counts',
  'dict_items', 'dictionaries', 'events', 'fs', 'health', 'hooks', 'kernel', 'knowledge_bases', 'library', 'links', 'notifications', 'objects', 'object_types',
  'plugins', 'revisions', 'runs', 'schedules', 'sessions', 'settings', 'shortcut_groups', 'shortcuts', 'skills', 'stakeholders',
  'stats', 'tags', 'tasks', 'today', 'webhooks', 'workspaces',
]

// 内核认的固定权限；另有 secrets:<scope>（docs/plugin-api.md 3.1）
export const PERMISSIONS: readonly string[] = [
  'fs:read:project', 'fs:write:project', 'fs:read:attachments', 'fs:write:attachments',
  'fs:read:any', 'fs:write:any',
  'network:localhost', 'network:im', 'network:media-platforms', 'network:market-data',
  'network:exchanges', 'network:any',
  'process:spawn', 'trade:live',
]

// 内核事件第一版（docs/plugin-api.md 2.10）
export const KERNEL_EVENTS: readonly string[] = [
  'object.created', 'object.updated', 'object.status_changed', 'object.stage_changed',
  'task.review_requested', 'run.finished', 'contact.identity_merged', 'object.progress_appended',
]

const kernelEventNamespaces = ['object', 'task', 'run', 'contact']

// 插件族共享表前缀的白名单：前缀到可用的插件 id。交易套件的前缀放到 M6 定，先留空
export const SHARED_TABLE_PREFIXES: Readonly<Record<string, readonly string[]>> = {}

export const MANIFEST_FIELDS: readonly string[] = [
  'id', 'name', 'description', 'icon', 'icons', 'version', 'core', 'depends', 'optional_depends', 'provides',
  'emits', 'subscribes', 'adopts', 'permissions', 'migrations', 'table_prefix',
]

export const EXTENSION_POINTS: readonly ExtensionPoint[] = [
  'modules', 'settings', 'object_types', 'connectors', 'skills',
  'agent_tools', 'sop_nodes', 'today_cards', 'commands', 'search', 'schedule_actions',
]

const adoptsFields = ['object_types', 'routes']

const idRe = /^[a-z][a-z0-9_]{1,23}$/
const keyRe = /^[a-z][a-z0-9_]*$/
const eventRe = /^([a-z][a-z0-9_]*)\.[a-z][a-z0-9_]*$/
const secretRe = /^secrets:[a-z][a-z0-9_]*$/

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function has(o: Obj, k: string): boolean {
  return Object.hasOwn(o, k)
}

function sortedKeys(o: object): string[] {
  return Object.keys(o).sort()
}

class Checker {
  issues: ManifestIssue[] = []

  add(field: string, message: string) {
    this.issues.push({ field, message })
  }

  unknownKeys(o: Obj, known: readonly string[], prefix: string, message: string) {
    for (const k of sortedKeys(o)) if (!known.includes(k)) this.add(prefix + k, message)
  }

  str(o: Obj, key: string, field: string, required: boolean): string | undefined {
    if (!has(o, key)) {
      if (required) this.add(field, '必填')
      return undefined
    }
    const v = o[key]
    if (typeof v !== 'string') {
      this.add(field, '必须是字符串')
      return undefined
    }
    return v
  }

  // 有元素不是字符串时返回 undefined，免得下标和原数组对不上
  strList(o: Obj, key: string, field: string, required: boolean): string[] | undefined {
    if (!has(o, key)) {
      if (required) this.add(field, '必填')
      return undefined
    }
    const v = o[key]
    if (!Array.isArray(v)) {
      this.add(field, '必须是字符串数组')
      return undefined
    }
    let good = true
    v.forEach((e, i) => {
      if (typeof e !== 'string') {
        this.add(`${field}[${i}]`, '必须是字符串')
        good = false
      }
    })
    return good ? (v as string[]) : undefined
  }

  object(o: Obj, key: string, field: string, required: boolean): Obj | undefined {
    if (!has(o, key)) {
      if (required) this.add(field, '必填')
      return undefined
    }
    const v = o[key]
    if (!isObj(v)) {
      this.add(field, '必须是对象')
      return undefined
    }
    return v
  }

  // 逐项检查并查重；check 返回空串表示通过
  each(field: string, list: readonly string[] | undefined, check: (s: string) => string) {
    if (!list) return
    const seen = new Set<string>()
    list.forEach((s, i) => {
      const f = `${field}[${i}]`
      const msg = check(s)
      if (msg) {
        this.add(f, `${msg}：${s}`)
        return
      }
      if (seen.has(s)) this.add(f, `重复：${s}`)
      seen.add(s)
    })
  }

  deps(o: Obj, key: string, selfId: string): Record<string, string> | undefined {
    const d = this.object(o, key, key, false)
    if (!d) return undefined
    const out: Record<string, string> = {}
    for (const dep of sortedKeys(d)) {
      const f = `${key}.${dep}`
      const rng = d[dep]
      if (!idRe.test(dep)) this.add(f, '不是合法的插件 id')
      else if (dep === selfId) this.add(f, '不能依赖自己')
      else if (typeof rng !== 'string') this.add(f, '必须是字符串')
      else if (!parseRange(rng)) this.add(f, `版本范围不合法：${rng}`)
      else out[dep] = rng
    }
    return out
  }
}

function providesItem(ep: ExtensionPoint, s: string, id: string, idOK: boolean): string {
  if (ep === 'commands') {
    if (idOK && !(s.startsWith(id + '.') && keyRe.test(s.slice(id.length + 1)))) return `必须是 ${id}.<动作>`
    return ''
  }
  if (!keyRe.test(s)) return '不合法：只能用小写字母、数字、下划线'
  if (!idOK) return ''
  switch (ep) {
    case 'object_types':
      if (s !== id && !s.startsWith(id + '_')) return `必须等于 ${id} 或以 ${id}_ 开头`
      break
    case 'skills':
      if (!s.startsWith('sk_')) return '必须以 sk_ 开头'
      break
    case 'agent_tools':
    case 'sop_nodes':
    case 'today_cards':
    case 'schedule_actions':
      if (!s.startsWith(id + '_')) return `必须以 ${id}_ 开头`
      break
  }
  return ''
}

// 插件目录内的相对路径：非空、不以 / 开头、不含 .. 段和反斜杠
function relPath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false
  return !p.split('/').includes('..')
}

function check(c: Checker, raw: unknown): PluginManifest | undefined {
  if (!isObj(raw)) {
    c.add('清单', '必须是 JSON 对象')
    return undefined
  }
  c.unknownKeys(raw, MANIFEST_FIELDS, '', '是未知字段')

  // id 不合法时跳过和 id 相关的前缀检查，免得一个错引出一串
  let idOK = false
  const id = c.str(raw, 'id', 'id', true) ?? ''
  if (has(raw, 'id') && typeof raw.id === 'string') {
    if (!idRe.test(id)) c.add('id', `不合法：必须匹配 ${idRe.source}：${id}`)
    else if (RESERVED_IDS.includes(id)) c.add('id', `是内核保留字：${id}`)
    else idOK = true
  }

  const name = c.str(raw, 'name', 'name', true)
  if (name !== undefined && name.trim() === '') c.add('name', '不能为空')
  const description = c.str(raw, 'description', 'description', false)
  const icon = c.str(raw, 'icon', 'icon', false)
  if (icon !== undefined && !keyRe.test(icon)) c.add('icon', `不合法：只能用小写字母、数字、下划线：${icon}`)
  const version = c.str(raw, 'version', 'version', true)
  if (version !== undefined && !parseVersion(version)) {
    c.add('version', `不是合法的版本号（MAJOR.MINOR.PATCH）：${version}`)
  }
  const core = c.str(raw, 'core', 'core', true)
  if (core !== undefined && !parseRange(core)) c.add('core', `版本范围不合法：${core}`)

  const depends = c.deps(raw, 'depends', id)
  const optional = c.deps(raw, 'optional_depends', id)
  if (optional) {
    for (const dep of sortedKeys(optional)) {
      if (depends && has(depends, dep)) c.add(`optional_depends.${dep}`, '已在 depends 里声明')
    }
  }

  let provides: PluginProvides | undefined
  const p = c.object(raw, 'provides', 'provides', true)
  if (p) {
    c.unknownKeys(p, EXTENSION_POINTS, 'provides.', '是未知扩展点')
    provides = {}
    for (const ep of EXTENSION_POINTS) {
      const list = c.strList(p, ep, `provides.${ep}`, false)
      if (list) provides[ep] = list
      c.each(`provides.${ep}`, list, (s) => providesItem(ep, s, id, idOK))
    }
  }

  let icons: Record<string, string> | undefined
  const ic = c.object(raw, 'icons', 'icons', false)
  if (ic) {
    icons = {}
    for (const k of sortedKeys(ic)) {
      const f = `icons.${k}`
      const v = ic[k]
      if (!(provides?.modules ?? []).includes(k)) c.add(f, `不是本插件提供的模块：${k}`)
      else if (typeof v !== 'string') c.add(f, '必须是字符串')
      else if (!keyRe.test(v)) c.add(f, `不合法：只能用小写字母、数字、下划线：${v}`)
      else icons[k] = v
    }
  }

  const emits = c.strList(raw, 'emits', 'emits', false)
  c.each('emits', emits, (s) => {
    if (!eventRe.test(s)) return '不是合法的事件类型'
    if (idOK && !s.startsWith(id + '.')) return `必须是 ${id}.<事件名>`
    return ''
  })

  const subscribes = c.strList(raw, 'subscribes', 'subscribes', false)
  c.each('subscribes', subscribes, (s) => {
    const m = eventRe.exec(s)
    if (!m) return '不是合法的事件类型'
    const ns = m[1]
    if (KERNEL_EVENTS.includes(s) || (idOK && ns === id)) return ''
    if (kernelEventNamespaces.includes(ns) || RESERVED_IDS.includes(ns)) return '是未知的内核事件'
    if ((depends && has(depends, ns)) || (optional && has(optional, ns))) return ''
    return `订阅了 ${ns} 的事件，但 ${ns} 不在 depends 或 optional_depends 里`
  })

  let adopts: PluginAdopts | undefined
  const a = c.object(raw, 'adopts', 'adopts', false)
  if (a) {
    c.unknownKeys(a, adoptsFields, 'adopts.', '是未知字段')
    adopts = {}
    const types = c.strList(a, 'object_types', 'adopts.object_types', false)
    c.each('adopts.object_types', types, (s) => (keyRe.test(s) ? '' : '不合法：只能用小写字母、数字、下划线'))
    const routes = c.strList(a, 'routes', 'adopts.routes', false)
    c.each('adopts.routes', routes, (s) => (s.startsWith('/api/') ? '' : '必须以 /api/ 开头'))
    if (types) adopts.object_types = types
    if (routes) adopts.routes = routes
  }

  const permissions = c.strList(raw, 'permissions', 'permissions', true)
  c.each('permissions', permissions, (s) => (PERMISSIONS.includes(s) || secretRe.test(s) ? '' : '是未知权限'))

  const migrations = c.str(raw, 'migrations', 'migrations', false)
  if (migrations !== undefined && !relPath(migrations)) {
    c.add('migrations', `必须是插件目录内的相对路径：${migrations}`)
  }
  const tablePrefix = c.str(raw, 'table_prefix', 'table_prefix', false)
  if (tablePrefix !== undefined) {
    if (idOK && tablePrefix !== id + '_' && !(SHARED_TABLE_PREFIXES[tablePrefix] ?? []).includes(id)) {
      c.add('table_prefix', `必须是 ${id}_：${tablePrefix}`)
    }
  } else if (!has(raw, 'table_prefix') && migrations !== undefined) {
    c.add('table_prefix', '有迁移时必填')
  }

  if (c.issues.length > 0) return undefined
  const m: PluginManifest = { id, name: name!, version: version!, core: core!, provides: provides!, permissions: permissions! }
  if (description !== undefined) m.description = description
  if (icon !== undefined) m.icon = icon
  if (icons) m.icons = icons
  if (depends) m.depends = depends
  if (optional) m.optional_depends = optional
  if (emits) m.emits = emits
  if (subscribes) m.subscribes = subscribes
  if (adopts) m.adopts = adopts
  if (migrations !== undefined) m.migrations = migrations
  if (tablePrefix !== undefined) m.table_prefix = tablePrefix
  return m
}

// 结构校验，不看别的插件。raw 是 JSON.parse 的结果，或 Vite 导入的 plugin.json
export function parseManifest(raw: unknown): ManifestResult {
  const c = new Checker()
  const m = check(c, raw)
  return m ? { ok: true, manifest: m } : { ok: false, issues: c.issues }
}

export function parseManifestText(text: string): ManifestResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, issues: [{ field: '清单', message: `不是合法的 JSON：${(e as Error).message}` }] }
  }
  return parseManifest(raw)
}

// 沿强依赖从 m 出发找回到 m 的环，返回 [m, ..., m]；按 id 排序遍历，结果稳定
function findCycle(m: PluginManifest, others: Map<string, PluginManifest>): string[] | null {
  const seen = new Set<string>()
  const walk = (id: string, path: string[]): string[] | null => {
    const deps = id === m.id ? m.depends : others.get(id)?.depends
    for (const d of sortedKeys(deps ?? {})) {
      if (d === m.id) return [...path, d]
      if (seen.has(d)) continue
      seen.add(d)
      const found = walk(d, [...path, d])
      if (found) return found
    }
    return null
  }
  return walk(m.id, [m.id])
}

// 拿环境检查 core 范围、强依赖是否存在和版本是否匹配、强依赖成环、连接器 id 冲突。
// 弱依赖没装也行，不检查。m 必须是 parseManifest 通过的清单；环境里和 m 同 id 的插件被忽略
export function checkManifest(m: PluginManifest, env: PluginEnv): ManifestIssue[] {
  const issues: ManifestIssue[] = []
  const add = (field: string, message: string) => issues.push({ field, message })
  const api = env.apiVersion || PLUGIN_API_VERSION
  if (!satisfies(api, m.core)) add('core', `不包含当前插件 API 版本 ${api}：${m.core}`)

  const others = new Map<string, PluginManifest>()
  for (const p of env.plugins) if (p.id !== m.id) others.set(p.id, p)
  for (const dep of sortedKeys(m.depends ?? {})) {
    const rng = m.depends![dep]
    const p = others.get(dep)
    if (!p) add(`depends.${dep}`, '依赖的插件不存在')
    else if (!satisfies(p.version, rng)) add(`depends.${dep}`, `要求 ${rng}，已有版本 ${p.version}`)
  }
  const cycle = findCycle(m, others)
  if (cycle) add('depends', `形成循环依赖：${cycle.join(' -> ')}`)

  const owner = new Map<string, string>()
  for (const id of [...others.keys()].sort()) {
    for (const t of others.get(id)!.provides.connectors ?? []) if (!owner.has(t)) owner.set(t, id)
  }
  ;(m.provides.connectors ?? []).forEach((t, i) => {
    const id = owner.get(t)
    if (id) add(`provides.connectors[${i}]`, `已被插件 ${id} 声明：${t}`)
  })
  return issues
}

// parseManifest 加 checkManifest；结构有问题时不做环境检查
export function validateManifest(raw: unknown, env: PluginEnv): ManifestResult {
  const r = parseManifest(raw)
  if (!r.ok) return r
  const issues = checkManifest(r.manifest, env)
  return issues.length > 0 ? { ok: false, issues } : r
}
