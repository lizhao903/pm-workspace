// 原消息抽屉「消息列回复」一节的批量处理（SPEC-messages-2.51）：整列处理、勾选批量、连原消息一起。
// 只有还没处理的（待处理、已过期）能勾、能算进「全部」；后端只改待处理的（含已过期、稍后），别的跳过，跳过数 = 送去的 - 改了的。
import type { ImMessage } from '../../core/data'

/** 还没处理：待处理（含稍后）、已过期 */
export const isOpenMsg = (m: Pick<ImMessage, 'status'>) => m.status === 'pending' || m.status === 'expired'

/** 消息列里还没处理的回复（原顺序） */
export const openReplies = (replies: ImMessage[]) => replies.filter(isOpenMsg)

/** 勾选里还在、还没处理的（别处处理掉的自动不算） */
export const livePicked = (replies: ImMessage[], sel: ReadonlySet<string>) => openReplies(replies).filter((m) => sel.has(m.id))

/** 要送去批量接口的 id：回复在前，连原消息时把原消息加在最后（原消息已处理的不加） */
export function batchIds(replyIds: string[], parent: Pick<ImMessage, 'id' | 'status'> | undefined, withParent: boolean): string[] {
  return withParent && parent && isOpenMsg(parent) ? [...replyIds, parent.id] : replyIds
}

/** 处理完的提示：「已把 N 条标为已处理」，有跳过的加「，跳过 M 条（已经在别处处理过）」 */
export function batchNote(sent: number, count: number, label: string): string {
  const skipped = Math.max(0, sent - count)
  const head = count ? `已把 ${count} 条标为${label}` : `没有要处理的消息`
  return skipped ? `${head}，跳过 ${skipped} 条（已经在别处处理过）` : head
}

/** 整列处理的确认标题；verb 是「标为已处理」「忽略」 */
export function confirmTitle(n: number, withParent: boolean, verb: string): string {
  return `把这个消息列里 ${n} 条没处理的回复${withParent ? '和原消息' : ''}${verb}？`
}
