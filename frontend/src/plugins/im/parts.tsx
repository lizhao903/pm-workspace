// 列表和抽屉共用的小件：弹出菜单、快捷回复菜单项、正文 @ 高亮、渠道标记、附件小标签。照原型 web-next/src/messages.tsx、attachments.tsx
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { ImAttachment } from '../../core/data'
import { cls } from '../../core/ui'
import { fmtSize, mentionParts, type Channel } from './model'
import { useQuickReplies } from './quickReplies'

export const Caret = () => <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>

export const Gear = () => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>

/** 行内和抽屉共用的小弹出菜单：点外面、按 Esc 收起；点菜单和按钮不触发行点击 */
export function Menu({ label, className, title, children }: {
  label: ReactNode; className?: string; title?: string; children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 自己吃掉 Esc，不关抽屉
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  return (
    <div className="im-menu-wrap" ref={ref} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <button type="button" className={className} title={title} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{label}</button>
      {open && <div className="menu" role="menu">{children(() => setOpen(false))}</div>}
    </div>
  )
}

export function QuickReplyItems({ doneLabel, onPick, close }: { doneLabel: string; onPick: (text: string, done: boolean) => void; close: () => void }) {
  const list = useQuickReplies()
  return (
    <>
      <div className="menu-label">快捷回复</div>
      {!list.length && <div className="menu-item im-menu-note" aria-disabled="true">没有快捷回复，到「渠道配置」里添加</div>}
      {list.map((q) => (
        <button key={q.text} type="button" role="menuitem" className="menu-item" onClick={() => { onPick(q.text, q.done); close() }}>
          <span className="ellipsis">{q.text}</span>
          {q.done && <span className="im-menu-note">并标为{doneLabel}</span>}
        </button>
      ))}
    </>
  )
}

/** 正文里的 @ 标出来，@我 和群发 @ 更醒目 */
export function MentionText({ text, me }: { text: string; me?: readonly string[] }) {
  return <>{mentionParts(text, me).map((p, i) => (typeof p === 'string' ? p : <span key={i} className={cls('im-mention', p.hot && 'im-mention-hot')}>@{p.name}</span>))}</>
}

export function ChannelMark({ ch }: { ch: Channel }) {
  return <span className="im-mark" style={{ '--c': ch.color } as CSSProperties} title={ch.label}>{ch.label}</span>
}

const ATTACH_KIND: Record<ImAttachment['kind'], string> = { file: '文件', image: '图片', link: '链接' }

function AttIcon({ kind }: { kind: ImAttachment['kind'] }) {
  const d = kind === 'link' ? 'M6.5 9.5 9.5 6.5M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1'
    : kind === 'image' ? 'M3 3.5h10v9H3zM3 10.5l3-3 2.5 2.5L10 8.5l3 3' : 'M4 2.5h5l3 3v8H4zM9 2.5v3h3'
  return <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

/** 最多 3 个，悬停「种类 · 大小」；只展示，获取和加入资料归附件面板（IM-04b） */
export function AttachmentChips({ atts, max = 3 }: { atts: readonly ImAttachment[]; max?: number }) {
  if (!atts.length) return null
  return (
    <span className="im-att-chips">
      {atts.slice(0, max).map((a) => (
        <span key={a.id} className="im-att-chip" title={`${ATTACH_KIND[a.kind] ?? a.kind}${a.size ? ` · ${fmtSize(a.size)}` : ''}`}><AttIcon kind={a.kind} />{a.name}</span>
      ))}
      {atts.length > max && <span className="im-att-chip">另外 {atts.length - max} 个</span>}
    </span>
  )
}

/**
 * 消息列回复的小标（0010）：悬停看「回复 谁：原消息前 40 字」；原消息收到了的点开原消息的抽屉（整个消息列在里面），没收到的只是标记
 */
export function ThreadTag({ hint, parentId, onOpen }: { hint: string; parentId?: string; onOpen: (id: string) => void }) {
  if (!parentId) return <span className="im-thread-tag" title={`${hint}（原消息还没收到）`}>消息列回复</span>
  return (
    <button type="button" className="im-thread-tag" title={`${hint}，点开看整个消息列`}
      onClick={(e) => { e.stopPropagation(); onOpen(parentId) }} onKeyDown={(e) => e.stopPropagation()}>消息列回复</button>
  )
}
