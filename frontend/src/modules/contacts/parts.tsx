// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 联系人列表和抽屉共用的小件：星标、分组标签、IM 渠道徽标、复制按钮、换头像
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Pill, cls } from '../../core/ui'
import type { Contact } from '../../core/data'
import { IM_CHANNELS, groupColor, type GroupItem, type ImChannel } from './model'

/** 新建按钮前的加号，和项目列表「新建项目」一致 */
export function IconPlus() {
  return <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
}

/** 行首和抽屉里的星标：点了只切星标，不打开抽屉 */
export function Star({ on, name, onToggle }: { on: boolean; name: string; onToggle: () => void }) {
  const label = on ? `取消星标：${name}` : `加星标：${name}`
  return (
    <button type="button" className={cls('ct-star', on && 'on')} title={on ? '取消星标' : '加星标'} aria-label={label} aria-pressed={on}
      onClick={(e) => { e.stopPropagation(); onToggle() }}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6Z" fill={on ? 'currentColor' : 'none'}
          stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

const groupLabel = (items: GroupItem[], g: string) => items.find((i) => i.key === g)?.label ?? g

/** 分组标签：名字和颜色取分组枚举；枚举里删掉了的按原值显示、用灰。
 *  compact（表格里）只放第一个分组加「+N」，超宽截断，悬停看全部；抽屉里全部列出 */
export function GroupPills({ items, gs, compact = false }: { items: GroupItem[]; gs: string[]; compact?: boolean }) {
  const shown = compact ? gs.slice(0, 1) : gs
  return (
    <span className="ct-groups" title={gs.map((g) => groupLabel(items, g)).join('、')}>
      {shown.map((g) => <Pill key={g} className="ct-pill" label={<span className="ellipsis">{groupLabel(items, g)}</span>} color={groupColor(items, g)} />)}
      {gs.length > shown.length && <span className="ct-groups-more">+{gs.length - shown.length}</span>}
    </span>
  )
}

/** IM 列：只列有编号的渠道，悬停看编号 */
export function ImBadges({ im }: { im: NonNullable<Contact['im']> }) {
  const has = IM_CHANNELS.filter((ch) => im[ch.key])
  if (!has.length) return <span className="faint">-</span>
  return (
    <span className="ct-im">
      {has.map((ch) => (
        <span key={ch.key} className="ct-im-mark" title={`${ch.label}：${im[ch.key]}`} style={{ '--c': ch.color } as CSSProperties}>{ch.short}</span>
      ))}
    </span>
  )
}

/** 渠道徽标：抽屉里用全名，列表格子里用短名 */
export function ImMark({ ch, compact = false }: { ch: ImChannel; compact?: boolean }) {
  return <span className={cls('ct-im-mark', !compact && 'ct-im-mark-full')} style={{ '--c': ch.color } as CSSProperties}>{compact ? ch.short : ch.label}</span>
}

/** 复制按钮：成功显示「已复制」，浏览器不给剪贴板权限时显示「复制失败」 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const t = setTimeout(() => setState('idle'), 1500)
    return () => clearTimeout(t)
  }, [state])
  const copy = () => {
    if (!navigator.clipboard) { setState('fail'); return }
    navigator.clipboard.writeText(text).then(() => setState('ok'), () => setState('fail'))
  }
  return (
    <button type="button" className={cls('ct-copy', state !== 'idle' && 'ct-copy-busy', state === 'fail' && 'ct-copy-fail')} aria-label={`复制${label}`} onClick={copy}>
      {state === 'ok' ? '已复制' : state === 'fail' ? '复制失败' : '复制'}
    </button>
  )
}

/** 头像上限，和原型一致；后端的上限是 1.4MB 的 data URL */
export const PHOTO_MAX = 1024 * 1024

/** 点头像弹出「更换图像」：上传（1MB 以内）、移除（有图时才有）；选完交给 onChange */
export function PhotoPicker({ photo, onChange, children }: { photo: string; onChange: (photo: string) => void; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const file = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  const pick = (f: File | undefined) => {
    if (!f) return
    if (f.size > PHOTO_MAX) { setErr('图片不能超过 1MB'); return }
    const r = new FileReader()
    r.onload = () => { setErr(''); setOpen(false); onChange(String(r.result)) }
    r.onerror = () => setErr('图片读不出来，换一张')
    r.readAsDataURL(f)
  }
  return (
    <div className="ct-photo" ref={ref}>
      <button type="button" className="ct-photo-btn" aria-label="更换图像" aria-expanded={open} title="更换图像"
        onClick={() => { setErr(''); setOpen(!open) }}>
        {children}
      </button>
      {open && (
        <div className="ct-photo-menu" role="menu" aria-label="更换图像">
          <button type="button" role="menuitem" onClick={() => file.current?.click()}>上传图片</button>
          {photo && <button type="button" role="menuitem" onClick={() => { setOpen(false); onChange('') }}>移除图片</button>}
          <div className="ct-photo-hint">没有图片时按名字生成</div>
          {err && <div className="field-err" role="alert">{err}</div>}
          <input ref={file} type="file" accept="image/*" hidden aria-label="选择图片"
            onChange={(e) => { pick(e.target.files?.[0]); e.target.value = '' }} />
        </div>
      )}
    </div>
  )
}
