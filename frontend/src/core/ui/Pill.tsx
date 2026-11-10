// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import type { CSSProperties, ReactNode } from 'react'
import { cls } from './cls'
import { IconClose } from './icons'

/**
 * 状态胶囊：圆点 + 文字，底色是 color 的 12%。
 * color 传 CSS 颜色值，一般来自后端字典（/api/dictionaries 的 color）；没有就用 --faint。
 */
export function Pill({ label, color, title, className }: { label: ReactNode; color?: string; title?: string; className?: string }) {
  return (
    <span className={cls('pill', className)} title={title} style={{ '--c': color || 'var(--faint)' } as CSSProperties}>
      <span className="pill-dot" />{label}
    </span>
  )
}

/** 标签：灰底小方块；给了 onRemove 就带一个移除按钮 */
export function Tag({ children, onRemove, removeLabel }: { children: ReactNode; onRemove?: () => void; removeLabel?: string }) {
  return (
    <span className="tag">
      <span className="ellipsis">{children}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={removeLabel ?? (typeof children === 'string' ? `移除 ${children}` : '移除')}>
          <IconClose size={10} />
        </button>
      )}
    </span>
  )
}

/** 一组标签，自动换行 */
export function Tags({ children }: { children: ReactNode }) {
  return <span className="tags">{children}</span>
}

/** 名字哈希出色相：同一个人在任何地方都是同一个颜色 */
function avatarHue(name: string) {
  return [...name].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7)
}

/** 头像：有图片用图片；没有就取英文名首字母（最多两个）或中文名最后一个字 */
export function Avatar({ name, size = 28, src, title }: { name: string; size?: number; src?: string; title?: string }) {
  if (src) return <img className="avatar avatar-img" src={src} alt={name} title={title} style={{ width: size, height: size }} />
  const glyph = /^[A-Za-z]/.test(name)
    ? name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
    : Array.from(name).slice(-1)[0] ?? '?'
  return (
    <span className="avatar" role="img" aria-label={name} title={title}
      style={{ width: size, height: size, fontSize: size * 0.4, '--h': avatarHue(name) } as CSSProperties}>
      {glyph}
    </span>
  )
}
