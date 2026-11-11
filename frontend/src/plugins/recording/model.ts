// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 录音转写页的纯函数和常量：时长/大小/时间格式化、状态文案与颜色、列表筛选、任务文案、音频地址、
// M4a 的候选/文件文案、置信度、流程图布局与树形图扁平化（Diagrams.tsx 只负责画，算都放这里测）、
// M5 的说话人颜色/显示名映射。
import type {
  RecordingAudioDeviceList, RecordingFileKind, RecordingFlow, RecordingJob, RecordingSpeaker, RecordingStatus, RecordingTodo, RecordingTree,
} from '../../core/data'

/** 列表一次取上限 200 条，在本地按状态筛（后端 status 只支持单值，转写中要含 uploaded/transcribing） */
export const LIST_LIMIT = 200

const STATUS: Record<RecordingStatus, string> = {
  draft: '草稿',
  uploaded: '待转写',
  transcribing: '转写中',
  transcribed: '已转写',
  summarizing: '生成纪要中',
  ready: '已完成',
  failed: '失败',
}

export function statusText(status: string): string {
  return STATUS[status as RecordingStatus] ?? status
}

/** 状态胶囊的颜色，走设计变量 */
export function statusTone(status: string): string {
  switch (status) {
    case 'transcribing':
    case 'summarizing':
      return 'var(--warn)'
    case 'transcribed':
    case 'ready':
      return 'var(--ok)'
    case 'uploaded':
      return 'var(--accent)'
    case 'failed':
      return 'var(--danger)'
    default:
      return 'var(--faint)'
  }
}

/** 后台任务的一句话：排队中 / 转写中 41% / 转写完成 / 转写失败；纪要任务换成「生成纪要」 */
export function jobText(job: RecordingJob | null): string {
  if (!job) return ''
  const verb = job.kind === 'summarize' ? '生成纪要' : job.kind === 'diarize' ? '说话人识别' : '转写'
  const p = clampPct(job.progress)
  switch (job.status) {
    case 'pending':
      return `排队等待${verb}`
    case 'running':
      return `${verb}中 ${p}%`
    case 'done':
      return `${verb}完成`
    case 'failed':
      return `${verb}失败`
    default:
      return ''
  }
}

/** 毫秒转 分:秒 / 时:分:秒（向下取整到秒） */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** 字节数按 MB 显示（模型大小），四舍五入到整数 */
export function fmtMB(bytes: number): string {
  const mb = Math.max(0, Number.isFinite(bytes) ? bytes : 0) / (1024 * 1024)
  return `${Math.round(mb)} MB`
}

/** RFC3339 转 月-日 时:分（本机时区）；解析不了给空串 */
export function fmtCreatedAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export const MODEL_STATUS_TEXT: Record<string, string> = {
  missing: '未下载',
  downloading: '下载中',
  ready: '已下载',
  error: '下载失败',
}

export const LIST_FILTERS = [
  { key: '', label: '全部' },
  { key: 'transcribing', label: '转写中' },
  { key: 'done', label: '已完成' },
  { key: 'failed', label: '失败' },
] as const

export type ListFilter = (typeof LIST_FILTERS)[number]['key']

/** 列表筛选：转写中含排队/转写中/生成纪要，已完成含已转写/已完成，失败只看 failed */
export function matchesFilter(filter: ListFilter, status: string): boolean {
  switch (filter) {
    case 'transcribing':
      return status === 'uploaded' || status === 'transcribing' || status === 'summarizing'
    case 'done':
      return status === 'transcribed' || status === 'ready'
    case 'failed':
      return status === 'failed'
    default:
      return true
  }
}

/** 进度限定在 0–100 的整数 */
export function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

/** 插件内路径：列表 /recording，详情 /recording/<id> */
export function recordingPath(id?: string): string {
  return id ? `/recording/${encodeURIComponent(id)}` : '/recording'
}

export const MODEL_OPTIONS = [
  { value: 'base', label: 'base（141MB，最快，准确率一般）' },
  { value: 'small', label: 'small（466MB，推荐先跑通）' },
  { value: 'medium', label: 'medium（1.4GB，更准）' },
  { value: 'large-v3-turbo', label: 'large-v3-turbo（1.5GB，最准）' },
]

/** whisper 语言码：auto 自动识别，其余按本机 whisper 支持的语言 */
export const LANGUAGE_OPTIONS = [
  { value: 'zh', label: '中文（zh）' },
  { value: 'auto', label: '自动识别（auto）' },
  { value: 'en', label: '英语（en）' },
  { value: 'yue', label: '粤语（yue）' },
  { value: 'ja', label: '日语（ja）' },
  { value: 'ko', label: '韩语（ko）' },
  { value: 'de', label: '德语（de）' },
  { value: 'fr', label: '法语（fr）' },
  { value: 'es', label: '西班牙语（es）' },
  { value: 'ru', label: '俄语（ru）' },
]

export const RETENTION_OPTIONS = [
  { value: 'keep', label: '保留原始音频（推荐）' },
  { value: 'delete_audio_after_ready', label: '转写完成后删除音频（M3 生效）' },
]

/** 取错误对象上的 name（DOMException 在 jsdom/Node 里的 constructor 不一定一样，按字段取） */
function errName(e: unknown): string {
  if (typeof e !== 'object' || e === null || !('name' in e)) return ''
  const name = (e as { name?: unknown }).name
  return typeof name === 'string' ? name : ''
}

/** getUserMedia 失败转成中文可操作提示 */
export function mediaErrorText(e: unknown): string {
  switch (errName(e)) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return '麦克风权限被拒绝：点地址栏左边的图标允许使用麦克风，再点「开始录音」重试（本地录音需要用 127.0.0.1 或 localhost 打开）'
    case 'SecurityError':
      return '浏览器不允许录音：当前页面不是安全上下文，请用 http://127.0.0.1 或 https://localhost 打开工作台'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '没有找到麦克风：插上麦克风或换一个输入设备再试'
    case 'NotReadableError':
    case 'TrackStartError':
      return '麦克风被别的程序占用：关掉占用麦克风的程序（会议软件等）再试'
    case 'OverconstrainedError':
      return '麦克风不支持当前录音参数：换一个输入设备再试'
    default:
      return `打不开麦克风：${e instanceof Error ? e.message : String(e)}`
  }
}

/* ---------- M4a：纪要、候选、文件 ---------- */

export const TODO_KIND_TEXT: Record<string, string> = { project: '项目候选', task: '任务候选', goal: '目标候选' }
export const TODO_STATUS_TEXT: Record<string, string> = { pending: '待确认', confirmed: '已确认', ignored: '已忽略' }
export const MINUTES_ACTION_KIND_TEXT: Record<string, string> = { task: '任务', goal: '目标' }

export function todoKindText(kind: string): string {
  return TODO_KIND_TEXT[kind] ?? kind
}

export function todoStatusText(status: string): string {
  return TODO_STATUS_TEXT[status] ?? status
}

export function actionKindText(kind: string): string {
  return MINUTES_ACTION_KIND_TEXT[kind] ?? (kind || '任务')
}

/** 置信度 0–1 → 0–100 的整数百分比 */
export function confidencePct(c: number): number {
  return clampPct((Number.isFinite(c) ? c : 0) * 100)
}

/** 置信度颜色：>=0.7 绿、>=0.4 黄、其余灰（和阈值无关，只是视觉分档） */
export function confidenceTone(c: number): string {
  const v = Number.isFinite(c) ? c : 0
  return v >= 0.7 ? 'var(--ok)' : v >= 0.4 ? 'var(--warn)' : 'var(--faint)'
}

/** 高置信度阈值默认 0.7（契约）；设置值不在 0–1 时回退默认 */
export const DEFAULT_MINUTES_THRESHOLD = 0.7

export function minutesThreshold(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_MINUTES_THRESHOLD
}

/** 待确认候选 */
export function pendingTodos(todos: RecordingTodo[]): RecordingTodo[] {
  return todos.filter((t) => t.status === 'pending')
}

/** 已确认候选（可跳到建出来的任务） */
export function confirmedTodos(todos: RecordingTodo[]): RecordingTodo[] {
  return todos.filter((t) => t.status === 'confirmed')
}

/** 需要你补充：置信度低于阈值的待确认候选（questions 由纪要里单列） */
export function lowConfidenceTodos(todos: RecordingTodo[], threshold: number): RecordingTodo[] {
  return pendingTodos(todos).filter((t) => t.confidence < threshold)
}

/** 已确认候选建出来的任务在任务页的链接（?t=<id> 直接打开抽屉）；没建对象给空串 */
export function todoObjectPath(t: RecordingTodo): string {
  return t.object_id ? `/tasks?t=${encodeURIComponent(t.object_id)}` : ''
}

export const FILE_KIND_TEXT: Record<string, string> = {
  transcript: '转写',
  minutes: '纪要',
  minutes_json: '纪要 JSON',
  diagram_flow: '流程图源码',
  diagram_tree: '树形图源码',
}

export function fileKindText(kind: RecordingFileKind | string): string {
  return FILE_KIND_TEXT[kind] ?? kind
}

/** 字节数按 B/KB/MB 显示（文件大小）；非有限数按 0 */
export function fmtBytes(bytes: number): string {
  const n = Math.max(0, Number.isFinite(bytes) ? bytes : 0)
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/* ---------- 图表：流程图 SVG 布局、树形图扁平化 ---------- */

export type FlowNodeKind = 'start' | 'process' | 'decision' | 'end'

export type FlowNodeBox = {
  id: string
  label: string
  kind: FlowNodeKind
  x: number
  y: number
  w: number
  h: number
  /** 换行后的文字，最多两行 */
  lines: string[]
  cx: number
  cy: number
}

export type FlowEdgeLine = {
  from: string
  to: string
  label: string
  /** SVG path 的 d，含箭头（marker 由组件加） */
  path: string
  /** 文字标注的位置 */
  lx: number
  ly: number
}

export type FlowLayout = {
  width: number
  height: number
  nodes: FlowNodeBox[]
  edges: FlowEdgeLine[]
}

const NODE_W = 148
const NODE_H = 50
const GAP_X = 66
const GAP_Y = 30
const PAD = 18
const FLOW_KINDS: readonly FlowNodeKind[] = ['start', 'process', 'decision', 'end']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function flowKind(v: unknown): FlowNodeKind {
  return typeof v === 'string' && (FLOW_KINDS as readonly string[]).includes(v) ? (v as FlowNodeKind) : 'process'
}

/** 按字符数折成最多两行；超长第二行截断加省略号 */
export function wrapLabel(label: string, max = 14): string[] {
  const text = label.trim()
  if (!text) return ['']
  const first = text.slice(0, max)
  if (text.length <= max) return [first]
  const rest = text.slice(max, max * 2)
  return text.length > max * 2 ? [first, `${rest.slice(0, max - 1)}…`] : [first, rest]
}

/**
 * 流程图布局：按 BFS 分层（roots = 没有入边的节点；纯环里取第一个节点），列=层级、行=同层顺序。
 * 数据可能来自 AI，字段缺失/类型不对/边指向不存在的节点都丢弃；节点上限 10、边上限 15（契约）。
 * 没有可用节点时返回 null，组件显示空提示。
 */
export function layoutFlow(input: RecordingFlow | null | undefined): FlowLayout | null {
  const rawNodes = isRecord(input) && Array.isArray(input.nodes) ? input.nodes : []
  const nodes: { id: string; label: string; kind: FlowNodeKind }[] = []
  const seen = new Set<string>()
  for (const raw of rawNodes.slice(0, 10)) {
    if (!isRecord(raw)) continue
    const id = str(raw.id).trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    nodes.push({ id, label: str(raw.label).trim() || id, kind: flowKind(raw.kind) })
  }
  if (!nodes.length) return null

  const rawEdges = isRecord(input) && Array.isArray(input.edges) ? input.edges : []
  const edges: { from: string; to: string; label: string }[] = []
  for (const raw of rawEdges.slice(0, 15)) {
    if (!isRecord(raw)) continue
    const from = str(raw.from).trim()
    const to = str(raw.to).trim()
    if (!from || !to || from === to || !seen.has(from) || !seen.has(to)) continue
    edges.push({ from, to, label: str(raw.label).trim() })
  }

  // BFS 分层：先找没有入边的当 roots，剩下的（纯环）按原顺序补
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]))
  for (const e of edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]))
  for (const e of edges) out.get(e.from)?.push(e.to)
  const depth = new Map<string, number>()
  const roots = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id)
  const queue = roots.length ? [...roots] : [nodes[0].id]
  for (const id of queue) depth.set(id, 0)
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    for (const next of out.get(id) ?? []) {
      if (depth.has(next)) continue
      depth.set(next, (depth.get(id) ?? 0) + 1)
      queue.push(next)
    }
  }
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, 0)

  const columns: string[][] = []
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0
    ;(columns[d] ??= []).push(n.id)
  }
  // 去掉中间空列（环可能造成空洞），列宽只按有节点的层算
  const used = columns.filter((c) => c && c.length)
  const colOf = new Map<string, number>()
  used.forEach((ids, ci) => ids.forEach((id) => colOf.set(id, ci)))

  const boxes = new Map<string, FlowNodeBox>()
  const byId = new Map(nodes.map((n) => [n.id, n]))
  used.forEach((ids, ci) => {
    ids.forEach((id, ri) => {
      const n = byId.get(id)
      if (!n) return
      const x = PAD + ci * (NODE_W + GAP_X)
      const y = PAD + ri * (NODE_H + GAP_Y)
      boxes.set(id, {
        ...n, x, y, w: NODE_W, h: NODE_H, cx: x + NODE_W / 2, cy: y + NODE_H / 2, lines: wrapLabel(n.label),
      })
    })
  })

  const lines: FlowEdgeLine[] = []
  for (const e of edges) {
    const a = boxes.get(e.from)
    const b = boxes.get(e.to)
    if (!a || !b) continue
    const ca = colOf.get(e.from) ?? 0
    const cb = colOf.get(e.to) ?? 0
    let path: string
    if (cb > ca) {
      const sx = a.x + a.w
      const tx = b.x
      const dx = Math.max(28, (tx - sx) / 2)
      path = `M ${sx} ${a.cy} C ${sx + dx} ${a.cy}, ${tx - dx} ${b.cy}, ${tx} ${b.cy}`
    } else if (cb < ca) {
      const sx = a.cx
      const tx = b.cx
      path = `M ${sx} ${a.y} C ${sx} ${a.y - 34}, ${tx} ${b.y + b.h + 34}, ${tx} ${b.y + b.h}`
    } else if (b.y > a.y) {
      const sx = a.cx
      const tx = b.cx
      path = `M ${sx} ${a.y + a.h} C ${sx} ${a.y + a.h + 24}, ${tx} ${b.y - 24}, ${tx} ${b.y}`
    } else {
      const sx = a.cx
      const tx = b.cx
      path = `M ${sx} ${a.y + a.h} C ${sx} ${a.y + a.h + 26}, ${tx} ${b.y + b.h + 26}, ${tx} ${b.y + b.h}`
    }
    lines.push({ ...e, path, lx: (a.cx + b.cx) / 2, ly: (a.cy + b.cy) / 2 - 6 })
  }

  const rows = Math.max(...used.map((c) => c.length))
  return {
    width: PAD * 2 + used.length * NODE_W + (used.length - 1) * GAP_X,
    height: PAD * 2 + rows * NODE_H + (rows - 1) * GAP_Y,
    nodes: nodes.map((n) => boxes.get(n.id)).filter((b): b is FlowNodeBox => !!b),
    edges: lines,
  }
}

export type TreeNodeRow = {
  id: string
  label: string
  depth: number
  hasChildren: boolean
}

export const TREE_MAX_DEPTH = 3
export const TREE_MAX_CHILDREN = 8

/** 树形图扁平化成行（深度最多 3 层、每层最多 8 个子项；坏数据丢弃）；根没有文字时返回空数组 */
export function treeRows(tree: RecordingTree | null | undefined): TreeNodeRow[] {
  const rows: TreeNodeRow[] = []
  const root = isRecord(tree) && isRecord(tree.root) ? tree.root : null
  const walk = (node: unknown, depth: number, id: string): void => {
    if (depth >= TREE_MAX_DEPTH || !isRecord(node)) return
    const label = str(node.label).trim()
    if (!label) return
    const children = Array.isArray(node.children) ? node.children.slice(0, TREE_MAX_CHILDREN) : []
    rows.push({ id, label, depth, hasChildren: children.length > 0 })
    children.forEach((c, i) => walk(c, depth + 1, `${id}.${i}`))
  }
  if (root) walk(root, 0, 'root')
  return rows
}

/* ---------- M5：说话人 ---------- */

/** 说话人配色：按 label 里的序号取，稳定且不同人不同色；超出调色板就循环 */
export const SPEAKER_COLORS = [
  'var(--accent)', 'var(--ok)', 'var(--warn)', 'var(--danger)', '#8b5cf6', '#0ea5e9', '#d946ef', '#f97316',
] as const

/** spk_N 取 N；不是标准 label 时用字符串哈希兜底，保证同一 label 永远同色 */
export function speakerIndex(label: string): number {
  const m = /^spk_(\d+)$/.exec(label.trim())
  if (m) return Math.max(0, Number(m[1]) - 1)
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0
  return h
}

/** 说话人的颜色（与详情页段落标签同色） */
export function speakerColor(label: string): string {
  return SPEAKER_COLORS[speakerIndex(label) % SPEAKER_COLORS.length]
}

/** 显示名：用户的改名 > 联系人现名 > 「说话人 N」（label 不是 spk_N 时退回 label 本身） */
export function speakerDisplayName(spk: Pick<RecordingSpeaker, 'label' | 'name' | 'contact_name'>): string {
  const name = (spk.name ?? '').trim()
  if (name) return name
  const contact = (spk.contact_name ?? '').trim()
  if (contact) return contact
  const label = (spk.label ?? '').trim()
  const n = /^spk_(\d+)$/.exec(label)
  return n ? `说话人 ${Number(n[1])}` : label || '说话人'
}

/** 相似度百分比（0–100 整数；坏值按 0） */
export function speakerSimilarityPct(similarity: number): number {
  return Math.round(Math.min(1, Math.max(0, Number.isFinite(similarity) ? similarity : 0)) * 100)
}

/** label → 说话人，详情页段落标签映射用；坏数据当空 */
export function speakerMap(speakers: RecordingSpeaker[] | null | undefined): Map<string, RecordingSpeaker> {
  const map = new Map<string, RecordingSpeaker>()
  if (!Array.isArray(speakers)) return map
  for (const spk of speakers) {
    if (spk && typeof spk.label === 'string' && spk.label.trim()) map.set(spk.label, spk)
  }
  return map
}


/* ---------- M6：系统音频采集来源 ---------- */

export const CAPTURE_SOURCES = [
  { key: 'mic', label: '麦克风', desc: '只录你说话，最省事：口述、面对面、电话开免提都行。' },
  { key: 'share', label: '系统声音（浏览器分享）', desc: '开始后浏览器会让你分享标签页或屏幕，记得勾选「分享声音」；不用装任何东西，但只能录浏览器里的声音（网页版会议、视频、直播）。' },
  { key: 'system', label: '系统声音（本机设备）', desc: '用本机虚拟声卡录整个电脑/会议 App 的声音，需要先装 BlackHole 等虚拟声卡。' },
  { key: 'mic_system', label: '麦克风 + 系统声音', desc: '会议推荐：你的麦克风 + 电脑里对方的声音，停止后混成一条再转写。' },
] as const

export type CaptureSource = (typeof CAPTURE_SOURCES)[number]['key']

export function captureSourceText(source: CaptureSource): string {
  return CAPTURE_SOURCES.find((s) => s.key === source)?.label ?? source
}

export function captureSourceShort(source: CaptureSource): string {
  switch (source) {
    case 'mic': return '麦克风'
    case 'share': return '浏览器分享的声音'
    case 'system': return '系统声音'
    case 'mic_system': return '麦克风和系统声音'
  }
}

/** getDisplayMedia 失败转成中文提示（和麦克风的错误名不完全一样） */
export function shareErrorText(e: unknown): string {
  switch (errName(e)) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return '没有开始分享：可能是取消了共享，或浏览器拒绝了屏幕录制权限。点「开始录音」重试，选标签页/整个屏幕并勾选「分享声音」'
    case 'SecurityError':
      return '浏览器不允许分享声音：请用 http://127.0.0.1 或 https://localhost 打开工作台'
    case 'NotReadableError':
      return '共享被系统拦住了：检查系统设置里是否允许这个浏览器录屏/录音'
    case 'AbortError':
      return '分享被中断了：再点一次「开始录音」重试'
    default:
      return `打不开系统声音分享：${e instanceof Error ? e.message : String(e)}`
  }
}

/** 系统音频设备区的一句提示：优先说清为什么用不了 / 怎么装虚拟声卡 */
export function systemDeviceHint(info: RecordingAudioDeviceList | undefined): string {
  if (!info) return '正在读取本机音频设备…'
  if (!info.supported) {
    return `系统音频（本机设备）目前只支持 macOS，当前是 ${info.platform || '其他平台'}；先用「麦克风」或「系统声音（浏览器分享）」`
  }
  if (!info.ffmpeg) return '没找到 ffmpeg，先 brew install ffmpeg，再点「重新检测」'
  if (info.error) return `读取音频设备失败：${info.error}`
  if (info.devices.length === 0) return '没有找到音频输入设备：检查系统「声音」设置里的输入设备'
  if (!info.devices.some((d) => d.virtual)) {
    return '没看到虚拟声卡，录不到整个电脑/会议 App 的声音。装一个：brew install blackhole-2ch，再用「音频 MIDI 设置」建多输出设备，把系统输出接过去；装好后点「重新检测」。只想录网页声音可以先用「系统声音（浏览器分享）」'
  }
  return '选一个虚拟声卡（标了「虚拟声卡/系统声音」的）就能录电脑里别的 App 的声音'
}
