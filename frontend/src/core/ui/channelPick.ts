// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 「监听频道」的列表选择（纯函数，单元测试盯着）。值仍是一段文本：逗号、顿号、空白分隔，每项是会话编号或名字，# 可带可不带，
// 拆法同后端 internal/plugins/im/slack.go 的 splitChannels。勾选新增的写编号（改名也不丢）；
// 旧值里的 #名字 不主动改写，只要能按名字对上列表就显示成已选，取消勾选时一起去掉。
import type { ImConversationKind, ImConversationOption } from '../data'

/** 值里的一项：raw 是原文（保存时照写回去），key 去掉了开头的 # */
export type ChannelToken = { raw: string; key: string }

const SEP = /[,，、\s]+/

export function splitChannelTokens(value: string): ChannelToken[] {
  const out: ChannelToken[] = []
  for (const p of value.split(SEP)) {
    const raw = p.trim()
    const key = raw.replace(/^#/, '')
    if (key && !out.some((t) => t.key === key)) out.push({ raw, key })
  }
  return out
}

const joinTokens = (ts: ChannelToken[]) => ts.map((t) => t.raw).join(',')

/** 一项对不对得上这个会话：编号一样，或名字一样（不分大小写，同后端） */
export const tokenMatches = (t: ChannelToken, c: Pick<ImConversationOption, 'id' | 'name'>) =>
  t.key === c.id || (!!c.name && t.key.toLowerCase() === c.name.toLowerCase())

export const isPicked = (value: string, c: ImConversationOption) => splitChannelTokens(value).some((t) => tokenMatches(t, c))

/** 勾上写编号；取消时把对得上的编号和名字都去掉。别的项原样保留 */
export function toggleChannel(value: string, c: ImConversationOption, on: boolean): string {
  const ts = splitChannelTokens(value)
  if (on) return ts.some((t) => tokenMatches(t, c)) ? value : joinTokens([...ts, { raw: c.id, key: c.id }])
  return joinTokens(ts.filter((t) => !tokenMatches(t, c)))
}

export const removeToken = (value: string, key: string) => joinTokens(splitChannelTokens(value).filter((t) => t.key !== key))

/** 已选的项按值里的顺序，对上列表的带着会话；对不上的（Token 看不到、已改名、列表不完整）item 为空 */
export function resolveChannels(value: string, items: ImConversationOption[]): { token: ChannelToken; item?: ImConversationOption }[] {
  return splitChannelTokens(value).map((token) => ({ token, item: items.find((c) => tokenMatches(token, c)) }))
}

/** 显示名：频道 #名字；多人私信 mpdm-lin--zhou--me-1 显示成「lin、zhou、me」 */
export function convLabel(c: Pick<ImConversationOption, 'name' | 'kind' | 'id'>): string {
  if (c.kind === 'mpim') {
    const people = c.name.replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--').filter(Boolean)
    return people.length ? people.join('、') : c.id
  }
  return c.name ? `#${c.name}` : c.id
}

export const KIND_LABEL: Record<ImConversationKind, string> = { public: '公开频道', private: '私有频道', mpim: '多人私信' }

/** 列表里显示的：按关键字筛（名字、显示名、编号），已选的排前面，其余保持后端的顺序 */
export function orderChannels(items: ImConversationOption[], value: string, q: string): ImConversationOption[] {
  const ts = splitChannelTokens(value)
  const kw = q.trim().replace(/^#/, '').toLowerCase()
  const hit = items.filter((c) => !kw || `${c.name}\n${convLabel(c)}\n${c.id}`.toLowerCase().includes(kw))
  const picked = (c: ImConversationOption) => ts.some((t) => tokenMatches(t, c))
  return [...hit.filter(picked), ...hit.filter((c) => !picked(c))]
}

/** 列表最多画这么多行，再多提示搜索缩小范围 */
export const CHANNEL_ROWS_MAX = 200
