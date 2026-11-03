// 回复、发消息里的 @（SPEC-messages-2.46、8.9）：
// - 群聊回复底部「回复时 @ 对方」开关：默认打开，改了记在本机（localStorage），打开时发送在正文开头写「@原发信人」；私聊没有开关、不加 @。
// - 输入 @ 弹出候选：联系人在前（会话里发过言、认上联系人的 → 这个渠道有 IM 身份的别的联系人，显示联系人名），
//   再是发过言、没认上联系人的人（按渠道里的名字）；能搜、上下键选、回车或 Tab 选中、Esc 收起。不去渠道拉成员列表。
// - 选中后正文写「@名字 」；发送时只有正文里还在的、从候选里选的才真正 @（后端按渠道换写法：Slack <@MemberID>，
//   Telegram @用户名或 text_mention）；手打、认不出的照原样发。工作台里显示自己发出的仍是「@名字」。
// 原型只把正文记下来，不模拟渠道写法。正式产品见 frontend/src/plugins/im/MentionBox.tsx、mentionModel.ts、useMentions.ts；
// 后端 IM 插件 0.18.0（GET /api/im/conversations/{id}/members，回复、发消息 body 带 mentions）。
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Contact, Message } from './data'
import { cls } from './ui'

/** 一个候选：id 是渠道里的编号 */
export type Member = { id: string; name: string; sub: string; source: 'contact' | 'conversation' }
export type MentionPick = { id: string; name: string }

/** 会话的候选；conv 是会话判断（同一渠道、同一群名，私聊按发信人） */
export function mentionMembers(messages: Message[], contacts: Contact[], channel: string, inConv: (m: Message) => boolean): Member[] {
  const speakers = new Map<string, { name: string; at: string }>()
  for (const m of messages) {
    if (m.channel !== channel || !inConv(m)) continue
    const cur = speakers.get(m.sender_id)
    if (!cur || cur.at < m.at) speakers.set(m.sender_id, { name: m.sender_name, at: m.at })
  }
  const recent = [...speakers.entries()].sort((a, b) => b[1].at.localeCompare(a[1].at))
  const byId = (id: string) => contacts.find((c) => c.im[channel] === id)
  const linked: Member[] = []
  const unlinked: Member[] = []
  for (const [id, s] of recent) {
    const c = byId(id)
    if (c) linked.push({ id, name: c.name, sub: s.name !== c.name ? s.name : '', source: 'conversation' })
    else unlinked.push({ id, name: s.name || id, sub: '', source: 'conversation' })
  }
  const others = contacts.filter((c) => c.im[channel] && !speakers.has(c.im[channel]))
    .map((c): Member => ({ id: c.im[channel], name: c.name, sub: '', source: 'contact' }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return [...linked, ...others, ...unlinked]
}

const STORE_KEY = 'proto.im.replyMention'

function readOn() {
  try { return localStorage.getItem(STORE_KEY) !== 'off' } catch { return true }
}

/** 列表行「回复」菜单的快捷回复（SPEC-messages-2.47）：群聊且本机开关打开时 @ 原发信人 */
export function quickReplyText(m: Message, name: string, text: string): { text: string; mentions: MentionPick[] } {
  const tag = m.conversation && readOn() ? { id: m.sender_id, name } : null
  return composeReply(text, tag, [])
}

/** 「回复时 @ 对方」开关，记在本机 */
export function useReplyMention(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readOn)
  return [on, (v) => {
    setOn(v)
    try { localStorage.setItem(STORE_KEY, v ? 'on' : 'off') } catch { /* 存不了就只管这一次 */ }
  }]
}

/** 发出去的正文：开关打开时对方拼到开头（已写了不重复）；mentions 只留正文里还在的 */
export function composeReply(text: string, tag: MentionPick | null, picked: MentionPick[]): { text: string; mentions: MentionPick[] } {
  let body = text.trim()
  if (tag && body && !body.startsWith(`@${tag.name}`)) body = `@${tag.name} ${body}`
  const seen = new Set<string>()
  const mentions = (tag ? [tag, ...picked] : picked).filter((p) => {
    const k = `${p.id}|${p.name}`
    if (seen.has(k) || !body.includes(`@${p.name}`)) return false
    seen.add(k)
    return true
  })
  return { text: body, mentions }
}

function activeAt(text: string, caret: number) {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  const query = before.slice(at + 1)
  if (query.length > 24 || /\s/.test(query) || (at > 0 && /[A-Za-z0-9_]/.test(before[at - 1]))) return null
  return { start: at, query }
}

/** 带 @ 候选的输入框；回复框（候选弹在上面）和发消息弹窗（below，弹在下面）共用 */
export function MentionBox({ value, onChange, onPick, members, rows = 2, disabled, placeholder, label, below, className, onKeyDown }: {
  value: string; onChange: (t: string) => void; onPick: (p: MentionPick) => void; members: Member[]
  rows?: number; disabled?: boolean; placeholder?: string; label: string; below?: boolean; className?: string
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [active, setActive] = useState<{ start: number; query: string } | null>(null)
  const [idx, setIdx] = useState(0)
  const [caretTo, setCaretTo] = useState<number | null>(null)
  const q = active?.query.toLowerCase() ?? ''
  const list = active ? members.filter((m) => !q || m.name.toLowerCase().includes(q) || m.sub.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)).slice(0, 8) : []
  const cur = Math.min(idx, Math.max(list.length - 1, 0))
  useEffect(() => {
    if (caretTo === null || !ref.current) return
    ref.current.focus()
    ref.current.setSelectionRange(caretTo, caretTo)
    setCaretTo(null)
  }, [caretTo])
  const track = (el: HTMLTextAreaElement) => {
    const a = el.selectionStart === el.selectionEnd ? activeAt(el.value, el.selectionStart) : null
    if (a?.start === active?.start && a?.query === active?.query) return
    setActive(a)
    setIdx(0)
  }
  const choose = (m: Member) => {
    if (!active || !ref.current) return
    const caret = ref.current.selectionStart
    const ins = `@${m.name} `
    const rest = value.slice(caret)
    onChange(`${value.slice(0, active.start)}${ins}${rest.startsWith(' ') ? rest.slice(1) : rest}`)
    onPick({ id: m.id, name: m.name })
    setActive(null)
    setCaretTo(active.start + ins.length)
  }
  return (
    <div className="mention-box">
      <textarea ref={ref} rows={rows} value={value} disabled={disabled} placeholder={placeholder} aria-label={label} className={className} aria-autocomplete="list"
        onChange={(e) => { onChange(e.target.value); track(e.target) }} onSelect={(e) => track(e.currentTarget)} onBlur={() => setActive(null)}
        onKeyDown={(e) => {
          if (active && !disabled) {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setActive(null); return }
            if (list.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setIdx((i) => (i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length); return }
            if (list.length && (e.key === 'Enter' || e.key === 'Tab') && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); choose(list[cur]); return }
          }
          onKeyDown?.(e)
        }} />
      {active && !disabled && (
        <div className={cls('mention-pop', below && 'below')} role="listbox" aria-label="@ 谁">
          {list.length ? list.map((m, i) => (
            <div key={`${m.id}|${m.name}`} role="option" aria-selected={i === cur} className={cls('mention-opt', i === cur && 'on')}
              onMouseDown={(e) => { e.preventDefault(); choose(m) }} onMouseEnter={() => setIdx(i)}>
              <b>{m.name}</b>{m.sub && <span className="muted">{m.sub}</span>}<span className="spacer" /><span className="muted">{m.source === 'contact' ? '联系人' : '发过言'}</span>
            </div>
          )) : <div className="mention-empty muted">{members.length ? `没有叫「${active.query}」的人，手打的 @ 照原样发出` : '这里没有可 @ 的人，手打的 @ 照原样发出'}</div>}
        </div>
      )}
    </div>
  )
}
