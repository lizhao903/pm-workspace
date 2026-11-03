// 群组管理（IM 插件 0.15.0）的纯逻辑：显示名、筛选、勾选、按群名关键字建议项目、批量请求的切分。
// 数据来自 GET /api/im/conversations/summary（core/data/imGroups.ts），每行一个会话（群或私聊）。
import type { ImConvProjectBatchInput, ImConvProjectBatchResult, ImConversationSummary } from '../../core/data'

/** 一次批量最多几个会话（同后端 /api/im/conversation-projects 上限） */
export const GROUP_BATCH_MAX = 200
/** 列表先渲染这么多行，底部「加载更多」再加这么多 */
export const GROUP_PAGE = 100

export type GroupKindFilter = '' | 'group' | 'direct'
export type GroupFilter = { channel: string; kind: GroupKindFilter; q: string; unset: boolean }
/** 项目下拉和建议用到的项目字段 */
export type ProjectLite = { id: string; title: string; ref?: string }

const isDirect = (s: ImConversationSummary) => s.kind === 'direct'

/** Slack 多人私信的会话名都是这个，光看名字分不出是哪个 */
const MPIM_NAME = '多人私信'

/**
 * 列表里显示的名字：群用群名（Slack 多人私信带上前三个人「多人私信：甲、乙、丙 等」），
 * 私聊显示对方（发过消息的人里第一个，认上联系人的是联系人名），都没有时用渠道里的编号。
 */
export function displayName(s: ImConversationSummary): string {
  if (isDirect(s)) return s.participants[0] || s.external_id || '私聊'
  if (s.name === MPIM_NAME && s.participants.length) {
    return `${MPIM_NAME}：${s.participants.slice(0, 3).join('、')}${s.participants.length > 3 ? ' 等' : ''}`
  }
  return s.name || s.external_id || '未命名的群'
}

/** 按渠道、群聊/私聊、只看没设归属、搜索（群名、成员、编号、项目名）筛；顺序不变（后端按最近一条消息倒序） */
export function filterGroups(rows: readonly ImConversationSummary[], f: GroupFilter): ImConversationSummary[] {
  const kw = f.q.trim().toLowerCase()
  return rows.filter((s) => (!f.channel || s.channel === f.channel)
    && (!f.kind || (f.kind === 'direct' ? isDirect(s) : !isDirect(s)))
    && (!f.unset || !s.project_id)
    && (!kw || [displayName(s), s.name, s.external_id, s.project_name, s.project_ref, ...s.participants].some((v) => v.toLowerCase().includes(kw))))
}

/** 出现过的渠道（按第一次出现的顺序） */
export const groupChannels = (rows: readonly ImConversationSummary[]) => [...new Set(rows.map((s) => s.channel))]

// ---- 勾选 ----

export function togglePick(sel: ReadonlySet<string>, id: string): Set<string> {
  const n = new Set(sel)
  if (n.has(id)) n.delete(id)
  else if (n.size < GROUP_BATCH_MAX) n.add(id)
  return n
}

/** 全选当前筛出来的（最多 GROUP_BATCH_MAX 个，按列表顺序取前面的） */
export const pickAllGroups = (rows: readonly ImConversationSummary[]) => new Set(rows.slice(0, GROUP_BATCH_MAX).map((s) => s.conversation_id))

/** 勾选里还在当前列表里的（换了筛选，看不见的不算） */
export const pickedGroups = (rows: readonly ImConversationSummary[], sel: ReadonlySet<string>) => rows.filter((s) => sel.has(s.conversation_id))

// ---- 按群名关键字建议项目 ----

/**
 * 内置的关键字规则：群名里有 keyword 就建议 projects 里第一个存在的项目（按项目名或编号认，不分大小写）。
 * 关键字匹配前群名先规整：转小写、去掉开头的 #、空白和下划线换成 -，两头补上 -，
 * 所以「-ns-」能认出 #fde-bi-ns-support、#ns-ops，认不出 #dns、#ins。
 */
export const SUGGEST_RULES: { keyword: string; projects: string[] }[] = [
  { keyword: 'octok', projects: ['Octok'] },
  { keyword: 'xaue', projects: ['XAUE'] },
  { keyword: '-ns-', projects: ['NS 系统', 'NS'] },
]
/** 项目名本身也当关键字，太短的（少于 3 个字）不算，免得误认 */
export const TITLE_KEYWORD_MIN = 3

export type Suggestion = {
  /** 候选项目 id，按在群名里出现的先后；一个时能直接采纳，多个时让人挑 */
  ids: string[]
  /** 命中的关键字，悬停时说明为什么这样建议 */
  hits: string[]
}

const normName = (name: string) => `-${name.toLowerCase().replace(/^#/, '').replace(/[\s_]+/g, '-')}-`

const findProject = (projects: readonly ProjectLite[], key: string) => {
  const k = key.toLowerCase()
  return projects.find((p) => p.title.toLowerCase() === k) ?? projects.find((p) => p.ref?.toLowerCase() === k)
}

/**
 * 一个会话的建议：只给没设归属、有名字的群（私聊、Slack 多人私信不建议）。规则三条，命中的都算候选：
 * 1. SUGGEST_RULES 的关键字；2. 项目编号（PRJ-0009）；3. 项目名（不少于 3 个字）。
 * 候选去重后按在群名里出现的位置排；没有候选回 null。
 */
export function suggestFor(s: ImConversationSummary, projects: readonly ProjectLite[]): Suggestion | null {
  if (s.project_id || isDirect(s) || !s.name || s.name === MPIM_NAME) return null
  const name = normName(s.name)
  const found = new Map<string, { at: number; hits: string[] }>()
  const hit = (p: ProjectLite | undefined, kw: string) => {
    if (!p) return
    const at = name.indexOf(kw)
    if (at < 0) return
    const x = found.get(p.id)
    if (x) { x.at = Math.min(x.at, at); if (!x.hits.includes(kw)) x.hits.push(kw) } else found.set(p.id, { at, hits: [kw] })
  }
  for (const r of SUGGEST_RULES) {
    const p = r.projects.map((k) => findProject(projects, k)).find(Boolean)
    hit(p, r.keyword)
  }
  for (const p of projects) {
    if (p.ref) hit(p, p.ref.toLowerCase())
    if ([...p.title].length >= TITLE_KEYWORD_MIN) hit(p, normName(p.title).slice(1, -1))
  }
  if (!found.size) return null
  const ids = [...found.entries()].sort((a, b) => a[1].at - b[1].at).map(([id]) => id)
  return { ids, hits: [...new Set(ids.flatMap((id) => found.get(id)!.hits))] }
}

/** 一批会话的建议（会话 id -> 建议），没有建议的不放 */
export function suggestAll(rows: readonly ImConversationSummary[], projects: readonly ProjectLite[]): Map<string, Suggestion> {
  const out = new Map<string, Suggestion>()
  for (const s of rows) {
    const x = suggestFor(s, projects)
    if (x) out.set(s.conversation_id, x)
  }
  return out
}

/** 「全部采纳」：只采纳只有一个候选的；有多个候选的要人挑，不在里面 */
export function adoptable(rows: readonly ImConversationSummary[], sugg: ReadonlyMap<string, Suggestion>): ImConvProjectBatchInput {
  return rows.flatMap((s) => {
    const x = sugg.get(s.conversation_id)
    return x && x.ids.length === 1 ? [{ conversation_id: s.conversation_id, project_id: x.ids[0] }] : []
  })
}

/** 把建议说成一句：「群名里有「octok」」，悬停用 */
export const suggestReason = (x: Suggestion) => `群名里有${x.hits.map((h) => `「${h}」`).join('、')}`

// ---- 批量请求 ----

/** 超过上限的切成几批，按顺序一批批发 */
export function chunks<T>(xs: readonly T[], size = GROUP_BATCH_MAX): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

/** 合并几批的结果 */
export const mergeResults = (rs: readonly ImConvProjectBatchResult[]): ImConvProjectBatchResult =>
  ({ updated: rs.flatMap((r) => r.updated), failed: rs.flatMap((r) => r.failed) })

/** 批量结果的一句话；verb 是「设为 Octok」「清除归属」「采纳建议」这类 */
export function resultText(r: ImConvProjectBatchResult, verb: string, nameOf: (id: string) => string): { text: string; bad: boolean } {
  const ok = r.updated.length
  if (!r.failed.length) return { text: `已${verb}：${ok} 个会话`, bad: false }
  const why = r.failed.slice(0, 3).map((f) => `${nameOf(f.conversation_id) || f.conversation_id || '（没填会话）'}：${f.message}`).join('；')
  return { text: `${ok ? `已${verb}：${ok} 个会话；` : ''}${r.failed.length} 个没设成：${why}${r.failed.length > 3 ? ' 等' : ''}`, bad: true }
}
