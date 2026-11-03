// 附件标签的纯函数（SPEC-projects-5）：把项目消息里的附件摊成行、判断去向、分段计数、筛选。
// 去向三种：已加入资料（按资料 value 认，同 core/data attachmentAdded）、不加入（项目 props.skipped_attachments）、待决定。
// 一个附件既加过资料又记着不加入时算已加入（加入时会清掉不加入记录，这里兜底）。
import { attachmentAddedAs, skipKey, type ImAttachmentFile, type ImMessage, type ProjectMaterial } from '../../core/data'
import { whoName } from './commsModel'

export type AttState = 'todo' | 'added' | 'skipped'
export type AttKind = ImAttachmentFile['kind']

export type AttRow = {
  /** 消息 id + 附件 id，同「不加入」记录的键 */
  key: string
  m: ImMessage
  a: ImAttachmentFile
  state: AttState
  /** 已加入时是哪条资料 */
  material?: ProjectMaterial
}

export const ATT_SEGS: { key: AttState | ''; label: string }[] = [
  { key: 'todo', label: '待决定' },
  { key: 'added', label: '已加入资料' },
  { key: 'skipped', label: '不加入' },
  { key: '', label: '全部' },
]

export const ATT_KINDS: { key: AttKind; label: string }[] = [
  { key: 'image', label: '图片' },
  { key: 'file', label: '文件' },
  { key: 'link', label: '链接' },
]

export const STATE_LABEL: Record<AttState, string> = { todo: '待决定', added: '已加入资料', skipped: '不加入' }

/**
 * 项目消息里的附件，一个附件一行，按消息时间倒序；同一条消息的同一个附件只算一次
 * （绑定会话和归属项目两路取到同一条消息时）。materials 还没取到时传 undefined，全部按待决定算，调用方别急着显示
 */
export function attachmentRows(messages: readonly ImMessage[], materials: readonly ProjectMaterial[] | undefined, skipped: readonly string[]): AttRow[] {
  const skip = new Set(skipped)
  const seen = new Set<string>()
  const out: AttRow[] = []
  const sorted = [...messages].sort((x, y) => y.at.localeCompare(x.at))
  for (const m of sorted) {
    for (const a of m.attachments as ImAttachmentFile[]) {
      const key = skipKey(m.id, a.id)
      if (seen.has(key)) continue
      seen.add(key)
      const material = attachmentAddedAs(materials, a)
      out.push({ key, m, a, material, state: material ? 'added' : skip.has(key) ? 'skipped' : 'todo' })
    }
  }
  return out
}

export type AttFilter = { seg: AttState | ''; kind: AttKind | ''; q: string }

/** 搜文件名、发信人（联系人姓名和平台上的名字）、群名；按空格切词，每个词都要命中，不区分大小写 */
export function matchText(r: AttRow, q: string): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = `${r.a.name} ${whoName(r.m)} ${r.m.sender_name} ${r.m.conversation}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}

export function filterRows(rows: readonly AttRow[], f: AttFilter): AttRow[] {
  return rows.filter((r) => (!f.seg || r.state === f.seg) && (!f.kind || r.a.kind === f.kind) && matchText(r, f.q))
}

/** 分段上的数字：跟着种类和搜索走，不跟分段走 */
export function segCounts(rows: readonly AttRow[], f: Pick<AttFilter, 'kind' | 'q'>): Record<AttState | 'all', number> {
  const out = { todo: 0, added: 0, skipped: 0, all: 0 }
  for (const r of filterRows(rows, { seg: '', ...f })) {
    out[r.state] += 1
    out.all += 1
  }
  return out
}

/** 种类下拉里的数字：跟着分段和搜索走 */
export function kindCounts(rows: readonly AttRow[], f: Pick<AttFilter, 'seg' | 'q'>): Record<AttKind, number> {
  const out: Record<AttKind, number> = { image: 0, file: 0, link: 0 }
  for (const r of filterRows(rows, { kind: '', ...f })) out[r.a.kind] += 1
  return out
}

/** 待决定的个数：标签上的数字、沟通标签里的提示 */
export const todoCount = (rows: readonly AttRow[]) => rows.reduce((n, r) => n + (r.state === 'todo' ? 1 : 0), 0)

/** 获取状态一列：链接不用获取 */
export function fetchLabel(a: ImAttachmentFile): string {
  if (a.kind === 'link') return '不用获取'
  if (a.fetch === 'done') return '已获取'
  if (a.fetch === 'fetching') return '获取中'
  if (a.fetch === 'error') return '获取失败'
  return '没获取'
}

/** 批量操作能作用到的：加入资料对待决定和不加入的都行，不加入只对待决定的 */
export const canBatchAdd = (r: AttRow) => r.state !== 'added'
export const canBatchSkip = (r: AttRow) => r.state === 'todo'
