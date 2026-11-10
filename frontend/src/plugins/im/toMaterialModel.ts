// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 转项目资料（0009）的纯函数：默认标题、按时间拼成的对话记录、能一起加的附件、以前转过没有。
// 存成项目资料的「笔记」（kind=note）：正文就是对话记录，资料页直接显示全文、能搜；不是文件（没有本机文件可指）、不是链接，
// 也不建成「文档」对象（那是要长期编辑的 PRD、方案，挂在「文档」模块里，不在资料里）。
import type { ImAttachment, ImMessage, ImMessageMaterial } from '../../core/data'
import { projectOf } from './sessionModel'
import { whoName } from './model'

export { projectOf }

/** 发信人：联系人名、渠道里的名字，都没有时用渠道编号（有的渠道拿不到名字） */
const nameOf = (m: ImMessage) => whoName(m) || m.sender_id

/** 按时间正序 */
const chrono = (xs: readonly ImMessage[]) => [...xs].sort((a, b) => a.at.localeCompare(b.at))
const pad = (n: number) => String(n).padStart(2, '0')

/** 「10月30日」；不是今年的带年份 */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`
}

/** 记录里每条的时间：「10-30 14:02」 */
export const lineTime = (iso: string) => {
  const d = new Date(iso)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 群名；私聊是对方（最新一条的发信人） */
export const whereOf = (xs: readonly ImMessage[]) => {
  const last = chrono(xs).at(-1)
  return last ? last.conversation || nameOf(last) : ''
}

/** 默认标题「<群或对方> <日期> 的消息」；跨天写「10月28日至10月30日」 */
export function materialTitle(xs: readonly ImMessage[], now = new Date()): string {
  const all = chrono(xs)
  if (!all.length) return ''
  const a = dayLabel(all[0].at, now)
  const b = dayLabel(all[all.length - 1].at, now)
  return `${whereOf(all)} ${a === b ? a : `${a}至${b}`} 的消息`
}

/**
 * 正文：头一行写渠道、群（或和谁的私聊）、条数，空一行，然后每条一段「[时间] 发信人：正文」，
 * 正文多行的后面几行缩进两格；有附件的另起一行「附件：a、b」
 */
export function materialBody(xs: readonly ImMessage[], chLabel: string): string {
  const all = chrono(xs)
  if (!all.length) return ''
  const last = all[all.length - 1]
  const head = `${chLabel} · ${last.conversation ? `群「${last.conversation}」` : `和 ${nameOf(last)} 的私聊`} · ${all.length} 条消息`
  const lines = all.map((m) => {
    const [first, ...rest] = (m.text.trim() || '（没有正文）').split('\n')
    const atts = m.attachments.length ? [`  附件：${m.attachments.map((x) => x.name).join('、')}`] : []
    return [`[${lineTime(m.at)}] ${nameOf(m)}：${first}`, ...rest.map((l) => `  ${l}`), ...atts].join('\n')
  })
  return [head, '', ...lines].join('\n')
}

export type AttachmentPick = { messageId: string; attachment: ImAttachment }

/** 这组消息里的附件，按时间先后 */
export const attachmentsOf = (xs: readonly ImMessage[]): AttachmentPick[] =>
  chrono(xs).flatMap((m) => m.attachments.map((a) => ({ messageId: m.id, attachment: a })))

/** 正文转的资料（不算附件加进的），按资料 id 去重，新的在前 */
export function noteMaterials(xs: readonly ImMessage[]): ImMessageMaterial[] {
  const seen = new Map<string, ImMessageMaterial>()
  for (const m of xs) for (const r of m.materials) if (r.kind === 'messages' && !seen.has(r.material_id)) seen.set(r.material_id, r)
  return [...seen.values()].sort((a, b) => b.at.localeCompare(a.at))
}

export type Prior = {
  /** 这组（或这一条）已经整个转过的资料：组里每条消息都在它里面 */
  same: ImMessageMaterial[]
  /** 组里有几条转进过别的资料（没整个转过时才看） */
  partial: number
}

/** 以前转过没有：整组都在一条资料里算转过；只有一部分转过的给条数 */
export function priorMaterials(xs: readonly ImMessage[]): Prior {
  const notes = noteMaterials(xs)
  const same = notes.filter((r) => xs.every((m) => m.materials.some((x) => x.material_id === r.material_id)))
  const partial = same.length ? 0 : xs.filter((m) => m.materials.some((x) => x.kind === 'messages')).length
  return { same, partial }
}

/** 资料页里打开某条资料（项目资料页按 ?mt= 高亮并滚到它） */
export const materialPath = (projectId: string, materialId: string) =>
  `/projects/${encodeURIComponent(projectId)}/materials?mt=${encodeURIComponent(materialId)}`

/** 列表行和抽屉上「已转资料」小标的提示 */
export const materialHint = (r: ImMessageMaterial) => `${r.project_name || '项目'}：${r.title || '未命名'}`
