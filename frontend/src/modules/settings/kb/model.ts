// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 知识库页的纯函数：切块（和后端 internal/kb/chunk.go 同一套，按码点算）、整体状态、筛选、目录校验、向量化模型选项。
import type { AgentProvider, Category, KbDoc, KbDocSource, KnowledgeBase } from '../../../core/data'
import { kindOf, uiKindOf } from '../providers/catalog'
import { timeAgo } from '../providers/model'

export const KB_DOC_SOURCE: Record<KbDocSource, string> = {
  library: '工作台文档', dir: '本地目录文件', upload: '上传的文件', link: '网页链接', note: '手写笔记', file: '本机文件',
}

/** 插件同步加进来的（TSK-0721）：项目知识库同步的标「项目同步」，以项目资料为准 */
export const originLabel = (d: Pick<KbDoc, 'origin'>) => (d.origin?.startsWith('projects:') ? '项目同步' : d.origin ? '插件同步' : '')

// 文档状态是知识库自己的三态（不是字典），颜色走设计变量
export const KB_DOC_STATUS = {
  indexed: { label: '已索引', color: 'var(--ok)' },
  pending: { label: '待索引', color: 'var(--warn)' },
  failed: { label: '失败', color: 'var(--danger)' },
  busy: { label: '索引中', color: 'var(--accent)' },
} as const

export const CHUNK_SIZES = [200, 300, 500, 800, 1200]
export const OVERLAPS = [0, 30, 50, 100]

export type Chunk = { start: number; end: number }

/** 正文按码点拆开；切块、命中位置都按它算 */
export const codepoints = (text: string) => Array.from(text)

/**
 * 按段长切：尽量在段长 60% 之后的换行、句号、分号处断开，相邻两段重叠 overlap 字（不超过段长一半）。
 * 照后端 kb.Split，位置是码点。
 */
export function splitChunks(text: string, size: number, overlap: number): Chunk[] {
  const out: Chunk[] = []
  if (!text.trim() || size <= 0) return out
  const rs = codepoints(text)
  const n = rs.length
  const ov = Math.max(0, Math.min(overlap, Math.floor(size / 2)))
  const head = Math.floor((size * 6) / 10)
  let start = 0
  while (start < n) {
    let end = Math.min(start + size, n)
    if (end < n && start + head < end) {
      for (let i = end - 1; i >= start + head; i--) {
        if (rs[i] === '\n' || rs[i] === '。' || rs[i] === '；') { end = i + 1; break }
      }
    }
    out.push({ start, end })
    if (end >= n) break
    start = Math.max(end - ov, start + 1)
  }
  return out
}

/** 知识库整体的状态：有失败先报失败，其次待索引 */
export function kbState(c: Pick<KnowledgeBase['counts'], 'failed' | 'pending'>) {
  if (c.failed) return { label: `${c.failed} 篇失败`, color: KB_DOC_STATUS.failed.color }
  if (c.pending) return { label: `${c.pending} 篇待索引`, color: KB_DOC_STATUS.pending.color }
  return { label: '已索引', color: KB_DOC_STATUS.indexed.color }
}

/** 文档行的状态：待索引且正在跑的显示「索引中」 */
export const docStatus = (d: KbDoc, busy: boolean) => (d.status === 'pending' && busy ? KB_DOC_STATUS.busy : KB_DOC_STATUS[d.status])

/** 行上第二行和阅读视图里的路径或网址；工作台文档、笔记没有 */
export const docRef = (d: Pick<KbDoc, 'source'>) => (d.source.type === 'library' ? '' : d.source.ref ?? '')

/** 空格分词，每个词都要命中（不分大小写） */
export function hit(hay: string, q: string) {
  const h = hay.toLowerCase()
  return q.trim().toLowerCase().split(/\s+/).filter(Boolean).every((w) => h.includes(w))
}

export type DocFilter = '' | 'pending' | 'failed' | 'excluded'
export const DOC_FILTERS: [DocFilter, string][] = [['', '全部'], ['pending', '待索引'], ['failed', '失败'], ['excluded', '已排除']]
export const inFilter = (d: KbDoc, f: DocFilter) => (f === 'excluded' ? d.excluded : !f || d.status === f)

/** 参与检索的：已索引且没排除 */
export const searchable = (docs: KbDoc[]) => docs.filter((d) => d.status === 'indexed' && !d.excluded)

/** 目录里收进来的文件 */
export const inDir = (d: KbDoc, path: string) => d.source.type === 'dir' && !!d.source.ref?.startsWith(`${path}/`)

/** 挂目录前的校验：去掉末尾斜杠；不是绝对路径、挂过了给出原因。存不存在、有没有权限由后端判 */
export function checkDir(raw: string, dirs: { path: string }[]): { path: string; error?: string } {
  const path = raw.trim().replace(/\/+$/, '')
  if (!path.startsWith('/')) return { path, error: '填绝对路径，以 / 开头' }
  if (dirs.some((d) => d.path === path)) return { path, error: '这个目录已经挂上了' }
  return { path }
}

/** 改段长时，重叠压到不超过一半 */
export const fitOverlap = (size: number, overlap: number) => Math.min(overlap, Math.floor(size / 2))

/** 命中片段里去掉 Markdown 记号，换行压成空格 */
export const plain = (x: string) =>
  x.replace(/```/g, '').replace(/^\s*(#+|>|-|\d+\.)\s*/gm, '').replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim()

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 按检索词切开，奇数位是命中的词 */
export function markParts(text: string, terms: string[]): string[] {
  const ts = terms.filter(Boolean)
  if (!ts.length) return [text]
  return text.split(new RegExp(`(${ts.map(esc).join('|')})`, 'gi'))
}

export const ago = (iso: string | null | undefined) => (iso ? timeAgo(Date.parse(iso)) : '')

/** 删除确认里点名：最多列三个 */
export const agentNames = (list: { name: string }[]) =>
  list.length > 3 ? `${list.slice(0, 3).map((a) => a.name).join('、')} 等 ${list.length} 个 Agent` : list.map((a) => a.name).join('、')

/** 分类树拍平：每个分类带上级的名字，「产品 / PRD」 */
export function flatCategories(tree: Category[], prefix = ''): { id: string; label: string }[] {
  return tree.flatMap((c) => {
    const label = prefix ? `${prefix} / ${c.name}` : c.name
    return [{ id: c.id, label }, ...flatCategories(c.children ?? [], label)]
  })
}

/** 各服务商类型能做向量化的模型（SPEC-settings-13 的 EMBED_MODELS）；不在表里的没有向量化模型 */
export const EMBED_MODELS: Record<string, string[]> = {
  openai: ['text-embedding-3-small', 'text-embedding-3-large'],
  azure: ['text-embedding-3-small', 'text-embedding-3-large'],
  gemini: ['text-embedding-004'],
  mistral: ['mistral-embed'],
  qwen: ['text-embedding-v3'],
  zhipu: ['embedding-3'],
  doubao: ['doubao-embedding'],
  qianfan: ['embedding-v1'],
  hunyuan: ['hunyuan-embedding'],
  minimax: ['embo-01'],
  siliconflow: ['BAAI/bge-m3', 'BAAI/bge-large-zh-v1.5'],
  ollama: ['bge-m3', 'nomic-embed-text'],
  lmstudio: ['nomic-embed-text-v1.5'],
  vllm: ['bge-m3'],
  custom: ['text-embedding'],
}

/** 启用的、有向量化模型的服务商，每个模型一项 */
export function embedOptions(providers: AgentProvider[]) {
  return providers.filter((p) => p.enabled).flatMap((p) => {
    const kind = uiKindOf(p)
    return (EMBED_MODELS[kind] ?? []).map((model) => ({ provider: p, model, kindLabel: kindOf(kind).label }))
  })
}

export const embedValue = (providerId: string, model: string) => `${providerId}|${model}`
export function parseEmbed(v: string) {
  const [provider_id, ...m] = v.split('|')
  return { provider_id, model: m.join('|') }
}

/** 上传：文件转 base64（后端按 []byte 解） */
export async function fileBase64(f: Blob): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer())
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export const UPLOAD_ACCEPT = '.md,.markdown,.txt,.csv,.pdf,.docx'
export const UPLOAD_EXT = /\.(md|markdown|txt|csv|pdf|docx)$/i
/** 原文件最多 1MB（后端的上限） */
export const UPLOAD_MAX = 1 << 20
