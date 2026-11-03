// 支持材料标签的纯函数（SPEC-projects-11）：路径补全、选文件时的目录前缀、标签拆分、筛选。
import {
  MATERIAL_KINDS, MATERIAL_KIND_GROUPS, MATERIAL_NOTE_MAX, type ImMaterialSource, type MaterialKind, type ProjectMaterial, type ProjectMaterialPatch, type WorkObject,
} from '../../core/data'

/** 没填路径时选文件放在项目目录的 materials 下（同原型 dirOf） */
export const DEFAULT_DIR = 'materials'

/** 输入框里路径的目录部分：「materials/a.md」→「materials」、「/x/y/」→「/x/y」；没填时默认 materials，只有文件名时为空串 */
export function dirOf(v: string): string {
  const t = v.trim()
  if (!t) return DEFAULT_DIR
  const i = t.lastIndexOf('/')
  if (i < 0) return ''
  return i === 0 ? '/' : t.slice(0, i)
}

/** 目录前缀拼上文件名 */
export const joinPath = (dir: string, name: string) => (!dir ? name : dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`)

/**
 * 存进去的绝对路径：绝对路径原样；相对路径拼上项目目录（契约要求前端拼好再传）。
 * 没设项目目录又填了相对路径时返回 null，界面提示填绝对路径；「~」开头的交给后端报错。
 */
export function resolvePath(v: string, root: string): string | null {
  const t = v.trim()
  if (!t || t.startsWith('/') || t.startsWith('~')) return t
  const r = root.trim().replace(/\/+$/, '')
  if (!r) return null
  return `${r}/${t.replace(/^(\.\/)+/, '')}`
}

/** 标签：中英文逗号分隔，去首尾空白、去空项、去重 */
export const splitTags = (s: string): string[] => [...new Set(s.split(/[,，]/).map((x) => x.trim()).filter(Boolean))]

/** 出现过的标签，按第一次出现的顺序 */
export const allTags = (rows: ProjectMaterial[]): string[] => [...new Set(rows.flatMap((m) => m.tags))]

export type MaterialFilter = { q: string; kind: MaterialKind | ''; tag: string }

/** 搜名称、值、标签，不区分大小写；种类、标签单选 */
export function matchMaterial(m: ProjectMaterial, f: MaterialFilter): boolean {
  if (f.kind && m.kind !== f.kind) return false
  if (f.tag && !m.tags.includes(f.tag)) return false
  const kw = f.q.trim().toLowerCase()
  return !kw || `${m.name} ${m.value} ${m.tags.join(' ')}`.toLowerCase().includes(kw)
}

/** 列表新加的在前；接口按添加先后返回 */
export const newestFirst = (rows: ProjectMaterial[]) => [...rows].reverse()

export const isPathKind = (k: MaterialKind) => k === 'file' || k === 'folder'

// ---- 编辑一条资料（SPEC-projects-11.24 起） ----

/** 编辑时能换成的种类（含自己）：笔记和链接互换、文件和文件夹互换；来自消息附件的不能换（按值认已加入） */
export const switchableKinds = (k: MaterialKind, locked = false): MaterialKind[] =>
  locked ? [k] : MATERIAL_KIND_GROUPS.find((g) => g.includes(k)) ?? [k]

/** 正文字数：按字（码点）数，和后端 5000 字的口径一致 */
export const noteLength = (v: string) => Array.from(v.trim()).length

/** 按种类校验值；合法返回空串。路径类的补全在 resolvePath，这里只管笔记字数和链接格式 */
export function valueError(kind: MaterialKind, v: string): string {
  const t = v.trim()
  if (!t) return kind === 'note' ? '内容不能为空' : kind === 'link' ? '链接不能为空' : '路径不能为空'
  if (kind === 'note' && noteLength(t) > MATERIAL_NOTE_MAX) return `超过 ${MATERIAL_NOTE_MAX} 字（现在 ${noteLength(t)} 字）`
  if (kind === 'link' && !/^https?:\/\/[^\s/]+/i.test(t)) return '链接要以 http:// 或 https:// 开头'
  return ''
}

export type EditDraft = { kind: MaterialKind; name: string; value: string; tags: string }

export const editDraftOf = (m: ProjectMaterial): EditDraft => ({ kind: m.kind, name: m.name, value: m.value, tags: m.tags.join('，') })

/**
 * 编辑表单要发的 PATCH：只带改了的字段；换了种类时连 value 一起带上（后端按新种类校验）。
 * 路径类的相对路径按项目目录补全，没设项目目录时返回 { error }。什么都没改返回 {}
 */
export function editPatch(m: ProjectMaterial, d: EditDraft, root: string): ProjectMaterialPatch | { error: string } {
  const out: ProjectMaterialPatch = {}
  let value = d.value.trim()
  if (isPathKind(d.kind)) {
    const abs = resolvePath(value, root)
    if (abs === null) return { error: '没设项目目录，路径要填绝对路径（以 / 开头），或先在设置里填本地项目目录' }
    value = abs
  }
  // 种类和值都没动时不校验值（库里早先存的不合新规矩的值，只改名字、标签照样能存）
  const bad = d.kind !== m.kind || value !== m.value ? valueError(d.kind, value) : ''
  if (bad) return { error: bad }
  const name = d.name.trim()
  if (name !== m.name) out.name = name
  if (d.kind !== m.kind) {
    out.kind = d.kind
    out.value = value
  } else if (value !== m.value) out.value = value
  const tags = splitTags(d.tags)
  if (tags.join('\u0000') !== m.tags.join('\u0000')) out.tags = tags
  return out
}

// ---- 长笔记折叠、来自 IM 消息的出处（0009） ----

/** 笔记超过这么多行时先露这么多行 */
export const NOTE_FOLD_LINES = 8

/** 长笔记折叠：前几行和剩下的行数；不用折叠回 null */
export function foldNote(v: string, n = NOTE_FOLD_LINES): { head: string; rest: number } | null {
  const lines = v.split('\n')
  return lines.length > n + 1 ? { head: lines.slice(0, n).join('\n'), rest: lines.length - n } : null
}

/** 群「X」；私聊是和对方（私聊里的发信人，最多列三个） */
const whereOf = (s: ImMaterialSource) => (s.conversation ? `群「${s.conversation}」`
  : `和 ${s.senders.slice(0, 3).join('、') || '对方'}${s.senders.length > 3 ? ' 等' : ''} 的私聊`)

/**
 * 卡片上的出处：附件是「来自 <发信人>（<群名或私聊>）的消息」（SPEC-projects-11.16）；
 * 消息正文转的是「来自 IM 消息：群「X」· N 条」（一条时写发信人）
 */
export function sourceLabel(s: ImMaterialSource): string {
  if (s.kind === 'attachment') return `来自 ${s.senders[0] ?? '对方'}（${s.conversation || '私聊'}）的消息`
  const n = s.message_ids.length
  return `来自 IM 消息：${whereOf(s)} · ${n > 1 ? `${n} 条` : `${s.senders[0] ?? ''} 的一条`}`
}

/** 点出处打开哪条消息：这组里最新的（message_ids 按时间正序，已被清理的排在最前，最后一条是还在的最新一条） */
export const sourceMessage = (s: ImMaterialSource) => s.message_ids[s.message_ids.length - 1] ?? ''

// ---- 概览「最近的文档和材料」（SPEC-projects-3.8） ----

/** 露几条 */
export const RECENT_PEEK = 5

type Recent = { key: string; tag: string; title: string; at: string }

/** 文档和支持材料合在一起按时间倒序；文档按更新时间，材料按加入时间（同原型 added_at） */
export function recentDocsAndMaterials(docs: readonly WorkObject[], mats: readonly ProjectMaterial[], n = RECENT_PEEK): Recent[] {
  const kind = (k: string) => MATERIAL_KINDS.find((x) => x.key === k)?.label ?? k
  return [
    ...docs.map((d) => ({ key: `d${d.id}`, tag: d.category_name || '文档', title: d.title || '未命名', at: d.updated_at })),
    ...mats.map((m) => ({ key: `m${m.id}`, tag: m.category || kind(m.kind), title: m.name || m.value, at: m.created_at })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, n)
}
