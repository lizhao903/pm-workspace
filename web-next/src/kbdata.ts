import { useSyncExternalStore } from 'react'
import { seedContent } from './data'
import { newId } from './ids'
import { kindOf, type Provider, type ProviderKind } from './modeldata'

// 知识库里的每一篇资料、切分和检索的模拟，以及每个知识库的设置
// 原型阶段放在模块级的小 store 里：切出设置页再回来，改动还在

export type KbDocSource = 'library' | 'dir' | 'upload' | 'link' | 'note'
export const KB_DOC_SOURCE: Record<KbDocSource, string> = { library: '工作台文档', dir: '本地目录文件', upload: '上传的文件', link: '网页链接', note: '手写笔记' }

export type KbDocStatus = 'indexed' | 'pending' | 'failed'
export const KB_DOC_STATUS: Record<KbDocStatus, { label: string; color: string }> = {
  indexed: { label: '已索引', color: '#2f7d43' },
  pending: { label: '待索引', color: '#b0570b' },
  failed: { label: '失败', color: '#c0352b' },
}

export interface KbDoc {
  id: string
  kb_id: string
  title: string
  /** ref：文档 id、目录里的文件路径、上传的文件名、网址；手写笔记没有 */
  source: { type: KbDocSource; ref?: string }
  text: string
  /** 上次索引切出来的段数；设置里的段长改了，要重新索引才会变 */
  chunks: number
  status: KbDocStatus
  /** 暂时不参与检索，资料还留着 */
  excluded: boolean
  /** 失败原因 */
  error?: string
  updated_at: string
}

export interface KbDir { path: string; auto_sync: boolean; synced_at?: string }

export interface KbSettings {
  kb_id: string
  /** 来源里的文档分类有新文档时自动收进来 */
  auto_sync: boolean
  dirs: KbDir[]
  /** 每段多少字 */
  chunk_size: number
  /** 相邻两段重叠多少字 */
  overlap: number
  embed: { provider_id: string; model: string }
}

/** 各家服务商提供的向量化模型 */
export const EMBED_MODELS: Partial<Record<ProviderKind, string[]>> = {
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
export const embedOptions = (providers: Provider[]) => providers.filter((p) => p.enabled && EMBED_MODELS[p.kind]).flatMap((p) =>
  EMBED_MODELS[p.kind]!.map((m) => ({ provider: p, model: m, label: kindOf(p.kind).label })))

/* ---------- 切分 ---------- */

export interface Chunk { start: number; end: number }

/** 按段长切；尽量在换行、句号处断开，相邻两段重叠 overlap 字 */
export function splitChunks(text: string, size: number, overlap: number): Chunk[] {
  const out: Chunk[] = []
  const n = text.length
  if (!text.trim()) return out
  const ov = Math.max(0, Math.min(overlap, Math.floor(size / 2)))
  let start = 0
  while (start < n) {
    let end = Math.min(start + size, n)
    if (end < n) {
      const win = text.slice(start + Math.floor(size * 0.6), end)
      const cut = Math.max(win.lastIndexOf('\n'), win.lastIndexOf('。'), win.lastIndexOf('；'))
      if (cut >= 0) end = start + Math.floor(size * 0.6) + cut + 1
    }
    out.push({ start, end })
    if (end >= n) break
    start = Math.max(end - ov, start + 1)
  }
  return out
}

/* ---------- 检索（模拟） ---------- */

const STOP = new Set(['什么', '怎么', '哪些', '哪个', '是不', '不是', '能不', '不能', '可以', '一下', '我们', '这个', '那个', '有没', '没有', '多久', '要不', '的时', '时候', '一个', '现在', '还是', '了吗', '是什', '么时', '要做', '做到', '到哪', '哪一', '一步'])

/** 问题拆成检索词：英文按词，中文按两字一组 */
export function queryTerms(q: string): string[] {
  const terms = new Set<string>()
  for (const w of q.toLowerCase().match(/[a-z0-9][a-z0-9.-]+/g) ?? []) terms.add(w)
  for (const run of q.match(/[一-鿿]+/g) ?? []) {
    if (run.length === 1) continue
    for (let i = 0; i < run.length - 1; i += 1) { const b = run.slice(i, i + 2); if (!STOP.has(b)) terms.add(b) }
  }
  return [...terms]
}

export interface KbHit { doc: KbDoc; index: number; chunk: Chunk; score: number; terms: string[] }

/** 按检索词重合度打分：命中的词占比，标题也命中再加一点；只算已索引、没排除的 */
export function searchKb(docs: KbDoc[], settings: KbSettings, q: string, top = 5): KbHit[] {
  const terms = queryTerms(q)
  if (!terms.length) return []
  const hits: KbHit[] = []
  for (const d of docs) {
    if (d.excluded || d.status !== 'indexed') continue
    const title = d.title.toLowerCase()
    splitChunks(d.text, settings.chunk_size, settings.overlap).forEach((c, index) => {
      const body = d.text.slice(c.start, c.end).toLowerCase()
      const got = terms.filter((t) => body.includes(t))
      if (!got.length) return
      const bonus = terms.some((t) => title.includes(t)) ? 0.08 : 0
      const score = Math.min(1, got.length / terms.length + bonus)
      if (score >= 0.15) hits.push({ doc: d, index, chunk: c, score, terms: got })
    })
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, top)
}

/* ---------- store ---------- */

const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString()
const DEFAULT = { chunk_size: 300, overlap: 50 }
export const defaultSettings = (kb_id: string): KbSettings => ({ kb_id, auto_sync: true, dirs: [], ...DEFAULT, embed: { provider_id: 'pv_ollama', model: 'bge-m3' } })

const fromLib = (kb_id: string, id: string, extra: Partial<KbDoc> = {}): KbDoc => {
  const c = seedContent.find((x) => x.id === id)!
  return { id: `kd_${kb_id.slice(3)}_${id}`, kb_id, title: c.title, source: { type: 'library', ref: id }, text: c.body, chunks: 0, status: 'indexed', excluded: false, updated_at: c.updated_at, ...extra }
}
let n = 0
const own = (kb_id: string, title: string, source: KbDoc['source'], text: string, mins: number, extra: Partial<KbDoc> = {}): KbDoc =>
  ({ id: `kd_${kb_id.slice(3)}_${(n += 1)}`, kb_id, title, source, text, chunks: 0, status: 'indexed', excluded: false, updated_at: minsAgo(mins), ...extra })

const PMW_DOCS = '/Volumes/project/0xBroleez/pm-workspace/docs'
const PMW_WEB = '/Volumes/project/0xBroleez/pm-workspace/web-next'
const YC_DOCS = '/Volumes/project/clients/yuanchuan-permission/docs'
const YC_CLIENT = '/Volumes/docs/客户/远川科技'

const seedDocs: KbDoc[] = [
  // 产品文档库：PRD、方案、例会，加上两个项目目录里的说明文件
  fromLib('kb_product', 'dc_001'),
  fromLib('kb_product', 'dc_002'),
  fromLib('kb_product', 'dc_006'),
  fromLib('kb_product', 'dc_003'),
  own('kb_product', 'api-contract.md', { type: 'dir', ref: `${PMW_DOCS}/api-contract.md` }, `# 接口契约

## 角色

- POST /api/roles 新建角色，name 不能和内置角色重名
- PATCH /api/roles/:id 改权限点，返回生效时间 effective_at
- DELETE /api/roles/:id 删除角色，持有该角色的成员要带 fallback_role

## 权限变更生效

权限点改完写入变更队列，网关缓存按租户失效。目标是 1 分钟内全部节点生效，超过 1 分钟要在审计日志里记一条延迟告警。

## 导出

- POST /api/exports 发起导出，异步执行，返回 job_id
- 导出要校验 object.export 权限点，每次导出都写审计日志
- 超过 5 万行的导出拆成多个文件；目前大租户会超时，后端在查慢查询`, 60 * 24 * 2),
  own('kb_product', 'README.md', { type: 'dir', ref: `${PMW_WEB}/README.md` }, `# 新版前端信息架构

一级菜单只放每天要用的：今天、消息、任务、项目、文档。设置收进左下角，二级菜单紧贴侧栏。

## 约定

- 页面标题、说明、主要操作统一放顶栏
- 列表页的错误不再用整条横幅，改成行内提示
- 详情用右侧抽屉，手机上抽屉铺满全屏`, 60 * 3, { status: 'pending' }),
  own('kb_product', 'permission-ux.md', { type: 'dir', ref: `${YC_DOCS}/permission-ux.md` }, `# 权限配置交互说明

## 角色列表

内置的管理员、成员、访客排在最前面，只读，鼠标悬停提示「内置角色不能修改」。自定义角色按部门分组。

## 勾选权限点

按「工作对象 / 成员管理 / 系统设置」三组展示，组标题上可以一键全选。导出单独一行，默认不勾，避免财务只读角色误开导出。

## 保存后

顶部提示「权限变更 1 分钟内生效」，并给出审计日志的入口。`, 60 * 20),
  fromLib('kb_product', 'dc_w43r'),
  own('kb_product', '旧版用起来的问题清单', { type: 'note' }, `侧栏太宽，笔记本屏幕上内容区只剩一半。

列表页错误横幅太占地方，一出错整页往下推。

设置项散落在各页，找连接器要翻三个地方。`, 60 * 30),
  own('kb_product', '角色管理设计稿-v4.pdf', { type: 'upload', ref: '角色管理设计稿-v4.pdf' }, '', 60 * 24, { status: 'failed', error: 'PDF 是扫描出来的图片，没有可提取的文字；导出成带文字的 PDF 再传' }),
  own('kb_product', 'Q4 路线图初稿', { type: 'link', ref: 'https://wiki.pmw.local/roadmap/q4' }, '', 60 * 5, { status: 'failed', error: '抓到的是登录页：这个链接要登录才能看，换成能公开访问的地址或把正文贴成笔记' }),

  // 客户反馈库：IM 里摘出来的原话，加上远川的访谈纪要
  fromLib('kb_feedback', 'dc_004'),
  fromLib('kb_feedback', 'dc_005'),
  own('kb_feedback', 'interview-1020.md', { type: 'dir', ref: `${YC_CLIENT}/interview-1020.md` }, `# 远川科技访谈纪要 10/20

参与：许知行（信息部负责人）、梁晚晴（采购经理）

## 许知行

- 现在三种角色不够用，财务、法务、销售要各管各的数据
- 月底演示一定要能按部门新建角色，老板会看
- 权限改完要马上生效，之前用的系统要等第二天，被投诉过

## 梁晚晴

- 采购走年框，试点期间先开 20 个账号
- 财务部想先试审批流，金额大于 5 万要总监审批
- 报价单和服务协议要走法务，大概两周`, 60 * 24 * 8),
  own('kb_feedback', '远川财务部审批流诉求.docx', { type: 'upload', ref: '远川财务部审批流诉求.docx' }, `# 财务部审批流诉求

1. 报销、采购两类单据都要走审批
2. 金额大于 5 万元的，部门负责人审批后还要总监审批
3. 驳回后申请人可以修改再提交，历史版本要能看到
4. 审批超过 48 小时没处理，提醒审批人；超过 72 小时自动转给代理人

明天先用试点账号试一遍报销审批。`, 94, { status: 'failed', error: '向量化超时：本机 Ollama 30 秒没有响应，重新索引试试' }),
  own('kb_feedback', '导出慢的几条反馈', { type: 'note' }, `Slack #feedback 里这周有三条说导出慢：

- 大租户导出一年的工单要等十几分钟，中途还失败过一次
- 导出完成没有通知，只能一直开着页面
- 希望能按字段选要导出的列

前两条跟后端在查的导出超时是一件事。`, 60 * 6),

  // 个人笔记：工作日志、周报、零散想法
  fromLib('kb_notes', 'dc_003'),
  fromLib('kb_notes', 'dc_007'),
  fromLib('kb_notes', 'dc_w43', { excluded: true }),
  fromLib('kb_notes', 'dc_w43r'),
  own('kb_notes', '合规口径备忘', { type: 'note' }, `顾北辰的建议：

- 审计日志至少保留 180 天，欧盟租户按客户合同可以更长
- 运维访问生产数据要走工单，留下访问记录，客户要能导出
- 欧盟租户的备份不能出境，和 Mia 那边的要求一致

等法务口径回来后，把这几条写进权限模型 PRD 的「不做」和「待确认」里。`, 60 * 24 * 2),
]

const seedSettings: KbSettings[] = [
  { kb_id: 'kb_product', auto_sync: true, chunk_size: 200, overlap: 30, embed: { provider_id: 'pv_ollama', model: 'bge-m3' },
    dirs: [{ path: PMW_DOCS, auto_sync: true, synced_at: minsAgo(25) }, { path: PMW_WEB, auto_sync: true, synced_at: minsAgo(25) }, { path: YC_DOCS, auto_sync: false, synced_at: minsAgo(60 * 20) }] },
  { kb_id: 'kb_feedback', auto_sync: true, chunk_size: 200, overlap: 30, embed: { provider_id: 'pv_ollama', model: 'bge-m3' },
    dirs: [{ path: YC_CLIENT, auto_sync: true, synced_at: minsAgo(60 * 3) }] },
  { kb_id: 'kb_notes', auto_sync: true, chunk_size: 300, overlap: 50, embed: { provider_id: 'pv_ollama', model: 'nomic-embed-text' }, dirs: [] },
]

const sized = (d: KbDoc, s: KbSettings) => ({ ...d, chunks: d.status === 'failed' ? 0 : splitChunks(d.text, s.chunk_size, s.overlap).length })
const settingsOf0 = (id: string) => seedSettings.find((s) => s.kb_id === id) ?? defaultSettings(id)

/** busy：正在索引的文档 id；待索引但还没开始的不算 */
let state: { docs: KbDoc[]; settings: KbSettings[]; busy: string[] } = {
  docs: seedDocs.map((d) => sized(d, settingsOf0(d.kb_id))),
  settings: seedSettings,
  busy: [],
}
const subs = new Set<() => void>()
const emit = (next: typeof state) => { state = next; subs.forEach((f) => f()) }
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }

export function useKbStore() {
  return useSyncExternalStore(subscribe, () => state)
}
export const settingsOf = (id: string) => state.settings.find((s) => s.kb_id === id) ?? defaultSettings(id)

const emptyReason = (d: KbDoc) => {
  if (d.source.type !== 'upload') return '没有正文可以索引'
  return /\.pdf$/i.test(d.source.ref ?? '') ? 'PDF 里没有可提取的文字' : '这种格式还提取不了文字，转成 .md 或 .txt 再传'
}

export const kbStore = {
  addDocs(docs: Omit<KbDoc, 'id' | 'chunks' | 'status' | 'excluded' | 'updated_at'>[]) {
    const made = docs.map((d) => ({ ...d, id: newId('kd'), chunks: 0, status: 'pending' as const, excluded: false, updated_at: new Date().toISOString() }))
    emit({ ...state, docs: [...made, ...state.docs] })
    return made.map((d) => d.id)
  },
  patchDoc(id: string, p: Partial<KbDoc>) {
    emit({ ...state, docs: state.docs.map((d) => (d.id === id ? { ...d, ...p } : d)) })
  },
  removeDoc(id: string) {
    emit({ ...state, docs: state.docs.filter((d) => d.id !== id) })
  },
  /** 先标成待索引，几百毫秒后出结果：没有正文、向量化服务商连不上的失败，其余变已索引 */
  reindex(ids: string[], providers: Provider[]) {
    if (!ids.length) return
    emit({ ...state, busy: [...new Set([...state.busy, ...ids])], docs: state.docs.map((d) => (ids.includes(d.id) ? { ...d, status: 'pending', error: undefined } : d)) })
    ids.forEach((id, i) => window.setTimeout(() => {
      const d = state.docs.find((x) => x.id === id)
      emit({ ...state, busy: state.busy.filter((x) => x !== id) })
      if (!d || d.status !== 'pending') return
      const s = settingsOf(d.kb_id)
      const pv = providers.find((p) => p.id === s.embed.provider_id)
      const prev = seedDocs.find((x) => x.id === id)
      const error = !pv || !pv.enabled ? '向量化用的服务商已停用或删除，到「设置」里换一个模型'
        : pv.status === 'error' ? `向量化失败：${pv.name} ${pv.error ?? '连接异常'}`
        : !d.text.trim() ? (prev?.error ?? emptyReason(d))
        : undefined
      kbStore.patchDoc(id, error ? { status: 'failed', error, chunks: 0 } : { status: 'indexed', error: undefined, chunks: splitChunks(d.text, s.chunk_size, s.overlap).length })
    }, 350 + i * 120 + Math.random() * 250))
  },
  setSettings(s: KbSettings) {
    emit({ ...state, settings: state.settings.some((x) => x.kb_id === s.kb_id) ? state.settings.map((x) => (x.kb_id === s.kb_id ? s : x)) : [...state.settings, s] })
  },
  /** 换了向量化模型：已有的向量都作废，全部标成待索引 */
  setEmbed(kb_id: string, embed: KbSettings['embed']) {
    const s = settingsOf(kb_id)
    emit({
      ...state,
      settings: state.settings.some((x) => x.kb_id === kb_id) ? state.settings.map((x) => (x.kb_id === kb_id ? { ...s, embed } : x)) : [...state.settings, { ...s, embed }],
      docs: state.docs.map((d) => (d.kb_id === kb_id && d.status === 'indexed' ? { ...d, status: 'pending' } : d)),
    })
  },
  /** 移除本地目录：从这个目录收进来的文件一起移出 */
  removeDir(kb_id: string, path: string) {
    const s = settingsOf(kb_id)
    emit({
      ...state,
      settings: state.settings.map((x) => (x.kb_id === kb_id ? { ...s, dirs: s.dirs.filter((d) => d.path !== path) } : x)),
      docs: state.docs.filter((d) => !(d.kb_id === kb_id && d.source.type === 'dir' && d.source.ref?.startsWith(`${path}/`))),
    })
  },
}

/** 目录下的文件：ref 以「目录/」开头 */
export const inDir = (d: KbDoc, path: string) => d.source.type === 'dir' && !!d.source.ref?.startsWith(`${path}/`)
