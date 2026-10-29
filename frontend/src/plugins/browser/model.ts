// 内置浏览器的纯函数（SPEC-browser-0 到 3）：地址转换、标签种类、标题、标签的增删改和前进后退、和后端记录互转。
// 不发请求，store.ts 调它们。Drive 地址按普通网页处理（BR-01b 决策：真实 Drive 列表等连接器工具能调用后再做）
import { PROTOTYPE_STATUS, type BrowserTabKind, type BrowserTabRecord, type TerminalPrototype } from '../../core/data'

export type TabKind = Exclude<BrowserTabKind, 'drive'>

export type Tab = {
  id: string
  url: string
  title: string
  kind: TabKind
  history: string[]
  cursor: number
  pinned: boolean
  /** iframe 还没 load（只有原型、网页会是 true），不存后端 */
  loading: boolean
}

export type Tabs = { tabs: Tab[]; active: string }

export type Recent = { url: string; title: string; kind: TabKind; at: string }

export const HOME_URL = 'about:home'
export const HOME_TITLE = '新标签页'
/** 同时开的上限；后端存 50 个 */
export const MAX_TABS = 12
export const MAX_RECENT = 8
/** 后端的限制：每个标签的历史最多 100 条，标题最多 200 字，地址最长 4096 */
export const MAX_HISTORY = 100
const MAX_TITLE = 200
const MAX_URL = 4096

export const KIND_LABEL: Record<TabKind, string> = { home: '新标签页', proto: '原型', web: '网页' }

export function newId(prefix: string) {
  const b = new Uint8Array(8)
  globalThis.crypto.getRandomValues(b)
  return `${prefix}_${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]'])

export function classify(url: string): TabKind {
  if (!url || url.startsWith('about:')) return 'home'
  return LOCAL_HOSTS.has(hostOf(url)) ? 'proto' : 'web'
}

export const isFrame = (k: TabKind) => k !== 'home'

/** 白名单内的 iframe 等这么久没 load 就提示可能不允许嵌入（SPEC-browser-3.12） */
export const FRAME_TIMEOUT_MS = 8000

/** 能嵌入的判断依据：白名单主机（可以是 *. 开头）和内网域名后缀（设置里开着时才给） */
export type FrameAllow = { hosts: readonly string[]; suffix?: string }

const hostMatch = (h: string, rule: string) => {
  const r = rule.toLowerCase()
  if (r.startsWith('*.')) return h.endsWith(r.slice(1))
  return h === r
}

/** 能不能挂 iframe：本机地址总能，其余要命中后缀或白名单（跨域读不到 X-Frame-Options，只能这么判断） */
export function frameAllowed(url: string, allow: FrameAllow): boolean {
  const h = hostOf(url).toLowerCase()
  if (!h) return false
  if (LOCAL_HOSTS.has(h)) return true
  const sfx = allow.suffix?.trim().toLowerCase().replace(/^\.+/, '')
  if (sfx && (h === sfx || h.endsWith(`.${sfx}`))) return true
  return allow.hosts.some((r) => hostMatch(h, r))
}

export function portOf(url: string): number | null {
  try {
    const u = new URL(url)
    if (u.port) return Number(u.port)
    return u.protocol === 'https:' ? 443 : 80
  } catch { return null }
}

/** 地址栏输入转成地址（SPEC-browser-1.13）：有协议原样；纯端口和本机地址补 http；像域名补 https；其它当搜索词 */
export function normalize(input: string): string {
  const s = input.trim()
  if (!s) return HOME_URL
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(s) || s.startsWith('about:')) return s
  if (/^:?\d{2,5}(\/.*)?$/.test(s)) return `http://127.0.0.1:${s.replace(/^:/, '')}`
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/.*)?$/i.test(s)) return `http://${s}`
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(s)) return `http://${s}`
  // 域名部分不能有空格；路径里可以有（地址栏显示的是解码后的地址）
  if (/^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)) return `https://${s}`
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}

/** 地址栏显示：去掉协议和末尾斜杠、解码；新标签页显示空 */
export function displayUrl(url: string): string {
  if (classify(url) === 'home') return ''
  const s = url.replace(/^[a-z][a-z\d+.-]*:\/\//i, '').replace(/\/$/, '')
  try { return decodeURI(s) } catch { return s }
}

/** 同一个地址：忽略末尾斜杠和 localhost / 127.0.0.1 的差别 */
export function sameUrl(a: string, b: string): boolean {
  const k = (u: string) => u.replace(/\/+$/, '').replace('://localhost', '://127.0.0.1')
  return k(a) === k(b)
}

export const protoUrl = (p: Pick<TerminalPrototype, 'port'>) => `http://127.0.0.1:${p.port}`

/** 本机地址按端口认出登记的原型 */
export function protoFor<P extends Pick<TerminalPrototype, 'port'>>(url: string, protos: readonly P[] | undefined): P | undefined {
  if (classify(url) !== 'proto' || !protos) return undefined
  const port = portOf(url)
  return protos.find((p) => p.port === port)
}

/** 标签标题（SPEC-browser-3.1、3.6）：原型「<原型> · <项目>」，没登记的本机地址是地址；网页是主机名，Google 搜索写「<词> - 搜索」 */
export function titleOf(url: string, protos?: readonly TerminalPrototype[]): string {
  const kind = classify(url)
  if (kind === 'home') return HOME_TITLE
  if (kind === 'proto') {
    const p = protoFor(url, protos)
    return p ? `${p.name} · ${p.project_title}` : displayUrl(url)
  }
  try {
    const u = new URL(url)
    const q = u.hostname.endsWith('google.com') && u.pathname === '/search' ? u.searchParams.get('q') : null
    return q ? `${q} - 搜索` : u.hostname.replace(/^www\./, '')
  } catch { return url }
}

/** 原型状态的显示名，跟项目页同一份 */
export const protoStatusLabel = (p: Pick<TerminalPrototype, 'status'>) => PROTOTYPE_STATUS[p.status]?.label ?? p.status
export const protoStatusColor = (p: Pick<TerminalPrototype, 'status'>) => PROTOTYPE_STATUS[p.status]?.color ?? 'var(--faint)'

export function makeTab(url: string, title: string): Tab {
  const kind = classify(url)
  return { id: newId('bt'), url, title, kind, history: [url], cursor: 0, pinned: false, loading: isFrame(kind) }
}

export const homeTabs = (): Tabs => {
  const t = makeTab(HOME_URL, HOME_TITLE)
  return { tabs: [t], active: t.id }
}

export function activeTab(s: Tabs): Tab | undefined {
  return s.tabs.find((t) => t.id === s.active) ?? s.tabs[0]
}

const patch = (s: Tabs, id: string, f: (t: Tab) => Tab): Tabs => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? f(t) : t)) })

/** 在一个标签里打开地址：截掉当前位置之后的历史再接上；历史只留最后 MAX_HISTORY 条 */
export function navigate(s: Tabs, id: string, url: string, title: string): Tabs {
  const kind = classify(url)
  return patch(s, id, (t) => {
    let history = [...t.history.slice(0, t.cursor + 1), url]
    if (history.length > MAX_HISTORY) history = history.slice(history.length - MAX_HISTORY)
    return { ...t, url, kind, title, history, cursor: history.length - 1, loading: isFrame(kind) }
  })
}

/** 后退、前进一步；到头了原样返回 */
export function go(s: Tabs, id: string, delta: number, titleFor: (url: string) => string): Tabs {
  const t = s.tabs.find((x) => x.id === id)
  if (!t) return s
  const i = t.cursor + delta
  if (i < 0 || i >= t.history.length) return s
  const url = t.history[i]
  const kind = classify(url)
  return patch(s, id, (x) => ({ ...x, url, kind, cursor: i, title: titleFor(url), loading: isFrame(kind) }))
}

export const setLoading = (s: Tabs, id: string, loading: boolean): Tabs =>
  s.tabs.find((t) => t.id === id)?.loading === loading ? s : patch(s, id, (t) => ({ ...t, loading }))

/** 新开一个标签并切过去；满了改在当前标签打开。返回打开地址的那个标签 id */
export function openTab(s: Tabs, url: string, title: string): { state: Tabs; id: string } {
  if (s.tabs.length >= MAX_TABS) {
    const cur = activeTab(s)
    if (cur) return { state: navigate(s, cur.id, url, title), id: cur.id }
  }
  const t = makeTab(url, title)
  return { state: { tabs: [...s.tabs, t], active: t.id }, id: t.id }
}

/** 别的模块要打开一个地址（SPEC-browser-1.15）：有同一地址的就切过去，否则新开 */
export function openOrFocus(s: Tabs, url: string, title: string): { state: Tabs; id: string } {
  const hit = s.tabs.find((t) => sameUrl(t.url, url))
  if (hit) return { state: { ...s, active: hit.id }, id: hit.id }
  return openTab(s, url, title)
}

/** 关标签：关的是当前标签时切到它左边那个；关掉最后一个补一个新标签页（SPEC-browser-1.5） */
export function closeTab(s: Tabs, id: string): Tabs {
  const i = s.tabs.findIndex((t) => t.id === id)
  if (i < 0) return s
  const rest = s.tabs.filter((t) => t.id !== id)
  if (!rest.length) return homeTabs()
  const active = id === s.active ? rest[Math.max(0, i - 1)].id : s.active
  return { tabs: rest, active }
}

/** 关其他：固定的留着 */
export function closeOthers(s: Tabs, id: string): Tabs {
  return { tabs: s.tabs.filter((t) => t.id === id || t.pinned), active: id }
}

/** 固定、取消固定；固定的排最前 */
export function togglePin(s: Tabs, id: string): Tabs {
  const next = s.tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t))
  return { ...s, tabs: [...next.filter((t) => t.pinned), ...next.filter((t) => !t.pinned)] }
}

/** 最近打开：最新的在前，同一地址只留一条，最多 8 条；新标签页不记 */
export function remember(list: readonly Recent[], url: string, title: string, at = new Date().toISOString()): Recent[] {
  const kind = classify(url)
  if (kind === 'home') return [...list]
  return [{ url, title, kind, at }, ...list.filter((r) => !sameUrl(r.url, url))].slice(0, MAX_RECENT)
}

/** 后端认的地址：about: 开头或 http(s)，太长的不要 */
const storable = (u: string) => u.length <= MAX_URL && (u.startsWith('about:') || /^https?:\/\//i.test(u))

/** 存后端：顺序就是数组顺序；loading 不存 */
export function toRecords(s: Tabs): BrowserTabRecord[] {
  return s.tabs.map((t, i) => {
    const kept = t.history.map((u, j) => ({ u, j })).filter((x) => storable(x.u))
    const history = kept.length ? kept.map((x) => x.u) : [HOME_URL]
    const at = kept.findIndex((x) => x.j === t.cursor)
    const url = storable(t.url) ? t.url : HOME_URL
    return {
      id: t.id, url, title: t.title.slice(0, MAX_TITLE), kind: t.kind, history,
      cursor: at >= 0 ? at : history.length - 1, pinned: t.pinned, position: i, active: t.id === s.active,
    }
  })
}

/** 从后端恢复：种类按地址重算（旧的 drive 也按网页算），坏了的游标收回到范围里；一个都没有就给新标签页 */
export function fromRecords(rows: readonly BrowserTabRecord[], protos?: readonly TerminalPrototype[]): Tabs {
  const tabs: Tab[] = [...rows]
    .sort((a, b) => a.position - b.position)
    .slice(0, MAX_TABS)
    .map((r) => {
      const history = r.history?.length ? r.history : [r.url]
      const cursor = Math.min(Math.max(0, r.cursor ?? history.length - 1), history.length - 1)
      const url = history[cursor] ?? r.url
      const kind = classify(url)
      return { id: r.id, url, title: r.title || titleOf(url, protos), kind, history, cursor, pinned: !!r.pinned, loading: isFrame(kind) }
    })
  if (!tabs.length) return homeTabs()
  const pinned = tabs.filter((t) => t.pinned)
  const ordered = [...pinned, ...tabs.filter((t) => !t.pinned)]
  const active = rows.find((r) => r.active && ordered.some((t) => t.id === r.id))?.id ?? ordered[0].id
  return { tabs: ordered, active }
}

/** 要存的内容：比对用，loading、标题之外的变化才算 */
export const saveKey = (s: Tabs) => JSON.stringify(toRecords(s))

/** 「<多久前>」 */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const m = Math.floor((now - t) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(t).toLocaleDateString('zh-CN')
}

/* ---------- 新标签页的原型分组（SPEC-browser-2.2 到 2.4） ---------- */

export const PROTO_SEARCH_MIN = 8
export const PROTO_GROUP_SHOW = 6
export const PROTO_MATCH_LIMIT = 60

const RANK: Record<string, number> = { running: 0, starting: 1, crashed: 2, stopped: 3 }
export const isLive = (p: Pick<TerminalPrototype, 'status'>) => p.status === 'running' || p.status === 'starting'

export type ProtoGroup = { key: string; name: string; items: TerminalPrototype[]; running: number; failed: number; live: boolean }

/** 按项目分组：有在跑（或启动中）的组排前，其次有启动失败的；组内在跑的在前 */
export function groupProtos(protos: readonly TerminalPrototype[]): ProtoGroup[] {
  const m = new Map<string, { key: string; name: string; items: TerminalPrototype[] }>()
  for (const p of protos) {
    const g = m.get(p.project_id) ?? { key: p.project_id, name: p.project_title, items: [] }
    g.items.push(p)
    m.set(p.project_id, g)
  }
  return [...m.values()]
    .map((g) => ({
      ...g,
      items: [...g.items].sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9)),
      running: g.items.filter((p) => p.status === 'running').length,
      failed: g.items.filter((p) => p.status === 'crashed').length,
      live: g.items.some(isLive),
    }))
    .sort((a, b) => Number(b.live) - Number(a.live) || Number(b.failed > 0) - Number(a.failed > 0))
}

/** 搜索：按空格切词，名字、项目、端口里每个词都要命中 */
export function protoMatcher(q: string) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return { words, hit: (p: TerminalPrototype) => { const hay = `${p.name} ${p.project_title} ${p.port}`.toLowerCase(); return words.every((w) => hay.includes(w)) } }
}

/* ---------- Google 账号（SPEC-browser-4） ---------- */

/**
 * 授权范围的显示名，key 是后端换好的短名。按正式的两个连接器实际申请的列：Drive 连接器只申请 drive.readonly，
 * 原型里的 drive.file 没人申请，不列；日历连接器申请 calendar.readonly 和 calendar.events
 */
export const GOOGLE_SCOPES: { key: string; label: string; desc: string; conn: 'drive' | 'calendar' }[] = [
  { key: 'drive.readonly', label: '查看 Google Drive 文件', desc: '在内置浏览器里浏览、预览你的云端硬盘', conn: 'drive' },
  { key: 'calendar.readonly', label: '查看 Google 日历', desc: '读取日历和日程，同步到工作台', conn: 'calendar' },
  { key: 'calendar.events', label: '查看和编辑 Google 日历日程', desc: '把日程同步到工作台的日程页，也允许助手建日程', conn: 'calendar' },
]

/** OAuth 回调回到的地址：本机打开时给完整地址（回到当前这个前端），否则给站内路径 */
export function oauthReturnTo(loc: Pick<Location, 'origin' | 'hostname'> = globalThis.location): string {
  const local = LOCAL_HOSTS.has(loc.hostname) || loc.hostname === '::1'
  return local ? `${loc.origin}/browser` : '/browser'
}
