// SOP 的 IM 触发设置（TSK-0481，SPEC-sop-9.27 到 9.31、SPEC-sop-2.14、SPEC-sop-5.18）：按会话、与我的关系过滤，执行顺序与拦截。
// 编排页改的是草稿（draft.im），保存时随流程一起提交；顺序只在改了时提交（order 为 null 是不改，新的、刚改成 IM 的排最后）。
import { SOP_IM_RELEVANCES, type Conversation, type SopFlow, type SopIMDraft, type SopIMRelevance, type SopIMTrigger } from '../../core/data'

export const IM = 'im'

export const REL_LABEL: Record<SopIMRelevance, string> = { me: '@我', all: '@所有人', dm: '私聊', none: '无关' }

export const emptyIM = (): SopIMDraft => ({ conversations: [], relevance: [], relevance_mode: 'include', order: null, stop: false })

/** 流程的 IM 触发设置，没有时按不过滤、不拦截 */
export const imOf = (f: Pick<SopFlow, 'im'>): SopIMTrigger => f.im ?? { conversations: [], relevance: [], relevance_mode: 'include', order: 0, stop: false }

/** 编排页的初值：顺序不放进草稿（不改就不提交），显示时取流程现在的 order */
export const imDraftOf = (f: Pick<SopFlow, 'im'>): SopIMDraft => {
  const { order: _order, ...rest } = imOf(f)
  return { ...rest, conversations: [...rest.conversations], relevance: [...rest.relevance], order: null }
}

/** 勾选或取消一种关系，按固定顺序排 */
export const toggleRel = (list: readonly SopIMRelevance[], r: SopIMRelevance, on: boolean): SopIMRelevance[] =>
  SOP_IM_RELEVANCES.filter((x) => (x === r ? on : list.includes(x)))

/** 会话的显示名：群名，没有用渠道里的编号；已删除的写明 */
export function convName(id: string, convs: readonly Conversation[]): string {
  const c = convs.find((x) => x.id === id)
  if (!c) return '已删除的会话'
  return c.name ? `#${c.name.replace(/^#/, '')}` : c.external_id
}

/** 会话下拉的选项：名字，右边灰字是渠道和编号（也参与搜索，Slack 的 C0… 能直接搜到） */
export const convOptions = (convs: readonly Conversation[]) =>
  convs.map((c) => ({ value: c.id, label: c.name || c.external_id, hint: `${c.channel} · ${c.external_id}`, group: c.channel }))

/** 过滤条件写成一句（不含顺序和拦截）：「#ai-octok-platform · 除了 @我」；没有过滤为「全部消息」 */
export function filterText(im: Pick<SopIMTrigger, 'conversations' | 'relevance' | 'relevance_mode'>, convs: readonly Conversation[]): string {
  const parts: string[] = []
  if (im.conversations.length) parts.push(im.conversations.map((id) => convName(id, convs)).join('、'))
  if (im.relevance.length) parts.push(`${im.relevance_mode === 'exclude' ? '除了' : '只要'} ${im.relevance.map((r) => REL_LABEL[r] ?? r).join('、')}`)
  return parts.length ? parts.join(' · ') : '全部消息'
}

/** IM 流程按顺序排好 */
export const imFlowsOf = (flows: readonly SopFlow[]) => flows.filter((f) => f.trigger === IM).sort((a, b) => imOf(a).order - imOf(b).order)
