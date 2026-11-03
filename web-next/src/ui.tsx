import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react'
import { IM_CHANNELS, type Contact, type Group, type ImChannel } from './data'
import { useEnum } from './enumdata'

// 页面之间共用的小部件。

export const cls = (...xs: (string | false | undefined | null)[]) => xs.filter(Boolean).join(' ')

/**
 * 高度随内容撑开的多行输入（SPEC-tasks-4.10）：不出内部滚动条、不给手动拉，粘贴长文也跟着长；rows 是最小高度。
 * 量高度时先设回 auto，抽屉的滚动位置要还原，不然打字时会跳。正式前端是 core/ui 的 Textarea autoGrow
 */
export function GrowArea({ className, value, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const box = el.closest('.drawer-body') as HTMLElement | null
    const top = box?.scrollTop
    el.style.height = 'auto'
    const cs = getComputedStyle(el)
    el.style.height = `${el.scrollHeight + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0)}px`
    if (box && top !== undefined) box.scrollTop = top
  }, [value])
  return <textarea ref={ref} className={cls('grow-area', className)} value={value} {...rest} />
}

export function ago(iso: string | null) {
  if (!iso) return null
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (d <= 0) return '今天'
  if (d === 1) return '昨天'
  if (d < 30) return `${d} 天前`
  if (d < 365) return `${Math.floor(d / 30)} 个月前`
  return `${Math.floor(d / 365)} 年前`
}

/** 头像色只吃名字哈希：同一个人在任何地方、刷新多少次都是同一个颜色 */
/** 消息、同步时间这类要精确到分钟的 */
export function timeAgo(iso: string) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  if (m < 1440) return `${Math.floor(m / 60)} 小时前`
  if (m < 2880) return '昨天'
  return `${Math.floor(m / 1440)} 天前`
}

export function Avatar({ name, size = 28, src }: { name: string; size?: number; src?: string }) {
  if (src) return <img className="avatar avatar-img" src={src} alt="" style={{ width: size, height: size }} />
  const hue = [...name].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7)
  const glyph = /^[A-Za-z]/.test(name) ? name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() : Array.from(name).slice(-1)[0] ?? '?'
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4, ['--h' as string]: hue }}>{glyph}</span>
  )
}

export const GROUP_COLOR: Partial<Record<Group, string>> = {
  客户: '#3d4fd6', 合作伙伴: '#0c8599', 同事: '#e8590c', 供应商: '#7048e8', 其他: '#868e96',
}

export function GroupPill({ g }: { g: Group }) {
  // 显示名和颜色取「联系人分组」枚举；枚举里删掉了的老值按原样显示
  const item = useEnum('contact_group').find((i) => i.key === g)
  return <span className="pill" style={{ ['--c' as string]: item?.color ?? GROUP_COLOR[g] ?? '#868e96' }}><i className="pill-dot" />{item?.label ?? g}</span>
}

/** 渠道标记：品牌色底 + 渠道名，不引图标库 */
export function ImMark({ ch, compact = false }: { ch: ImChannel; compact?: boolean }) {
  return (
    <span className={cls('im-mark', compact && 'im-mark-compact')} style={{ ['--c' as string]: ch.color }}>
      {compact ? ch.short : ch.label}
    </span>
  )
}

/** 列表里那一格：只列有编号的渠道，悬停看编号 */
export function ImBadges({ im }: { im: Contact['im'] }) {
  const has = IM_CHANNELS.filter((ch) => im[ch.key])
  if (!has.length) return <span className="faint">-</span>
  return (
    <span className="im-badges">
      {has.map((ch) => <span key={ch.key} title={`${ch.label}：${im[ch.key]}`}><ImMark ch={ch} compact /></span>)}
    </span>
  )
}

export function Star({ on, onClick }: { on: boolean; onClick?: () => void }) {
  return (
    <button className={cls('star', on && 'on')} title={on ? '取消星标' : '加星标'}
      onClick={(e) => { e.stopPropagation(); onClick?.() }}>
      <svg viewBox="0 0 16 16" width="14" height="14"><path d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6Z" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
    </button>
  )
}
