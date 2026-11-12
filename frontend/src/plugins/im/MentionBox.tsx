// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 带 @ 的输入框（IM 插件 0.18.0）：回复框（消息抽屉、合并组抽屉）和发消息弹窗共用。
// 输入 @ 弹出候选，能搜、上下键选、回车或 Tab 选中、Esc 收起，
// 选中后正文写「@名字 」并记下这个人（发送时由 composeMentions 筛出正文里还在的交给后端）。逻辑在 mentionModel。
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { ImMember } from '../../core/data'
import { cls } from '../../core/ui'
import { activeMention, filterMembers, insertMention, type MentionPick } from './mentionModel'

export function MentionBox({ value, onChange, onPick, members, membersLoading, onKeyDown, className, textareaClass, below, rows = 2, disabled, placeholder, label, autoFocus }: {
  value: string
  onChange: (text: string) => void
  /** 从候选里选中了一个人 */
  onPick: (p: MentionPick) => void
  /** @ 候选；undefined 是还没加载（或这个会话没有候选来源） */
  members: readonly ImMember[] | undefined
  membersLoading?: boolean
  /** 候选没弹出时的按键（⌘ Enter 发送等） */
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  className?: string
  /** 输入框自己的 class（弹窗里用 core/ui 的 textarea 样式） */
  textareaClass?: string
  /** 候选弹在输入框下面（弹窗里）；默认弹在上面（抽屉底部的回复框） */
  below?: boolean
  rows?: number
  disabled?: boolean
  placeholder?: string
  label: string
  autoFocus?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const listId = useId()
  const [active, setActive] = useState<{ start: number; query: string } | null>(null)
  const [idx, setIdx] = useState(0)
  const [caretTo, setCaretTo] = useState<number | null>(null)
  const list = active ? filterMembers(members ?? [], active.query) : []
  const open = !!active && !disabled

  useEffect(() => {
    if (caretTo === null || !ref.current) return
    ref.current.focus()
    ref.current.setSelectionRange(caretTo, caretTo)
    setCaretTo(null)
  }, [caretTo])

  const track = (el: HTMLTextAreaElement) => {
    const a = el.selectionStart === el.selectionEnd ? activeMention(el.value, el.selectionStart) : null
    if (a?.start === active?.start && a?.query === active?.query) return
    setActive(a)
    setIdx(0)
  }
  const choose = (m: ImMember) => {
    if (!active || !ref.current) return
    const next = insertMention(value, ref.current.selectionStart, active.start, m.name)
    onChange(next.text)
    onPick({ external_id: m.external_id, name: m.name })
    setActive(null)
    setCaretTo(next.caret)
  }
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && !e.nativeEvent.isComposing) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setActive(null); return }
      if (list.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault()
        setIdx((i) => (i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length)
        return
      }
      if (list.length && (e.key === 'Enter' || e.key === 'Tab') && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault()
        choose(list[Math.min(idx, list.length - 1)])
        return
      }
    }
    onKeyDown?.(e)
  }

  return (
    <div className={cls('im-mention-box', className)}>
      <textarea ref={ref} rows={rows} className={textareaClass} value={value} disabled={disabled} placeholder={placeholder} aria-label={label} autoFocus={autoFocus}
        aria-autocomplete="list" aria-controls={open ? listId : undefined}
        aria-activedescendant={open && list.length ? `${listId}-${Math.min(idx, list.length - 1)}` : undefined}
        onChange={(e) => { onChange(e.target.value); track(e.target) }}
        onSelect={(e) => track(e.currentTarget)}
        onBlur={() => setActive(null)}
        onKeyDown={keys} />
      {open && (
        <div className={cls('im-mention-pop', below && 'im-mention-pop-below')} id={listId} role="listbox" aria-label="@ 谁">
          {list.length ? list.map((m, i) => (
            <div key={`${m.external_id}:${m.name}`} id={`${listId}-${i}`} role="option" aria-selected={i === Math.min(idx, list.length - 1)}
              className={cls('im-mention-opt', i === Math.min(idx, list.length - 1) && 'on')}
              onMouseDown={(e) => { e.preventDefault(); choose(m) }} onMouseEnter={() => setIdx(i)}>
              <span className="im-mention-name">{m.name}</span>
              {m.sender_name && m.sender_name !== m.name && <span className="im-muted">{m.sender_name}</span>}
              <span className="spacer" />
              <span className="im-muted">{m.source === 'contact' ? '联系人' : '发过言'}</span>
            </div>
          )) : (
            <div className="im-mention-empty im-muted">
              {membersLoading ? '正在读这个会话里的人…' : members === undefined ? '这里没有可 @ 的人，手打的 @ 照原样发出' : `没有叫「${active!.query}」的人，手打的 @ 照原样发出`}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
