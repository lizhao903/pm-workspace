// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cls } from './ui'
import { ICON_GROUPS, MARK_ICONS, MarkIconSvg } from './markicons'

// 通用的「图标 / 头像」编辑：点图像弹出面板，能上传图片、改文字、选底色
// 用在联系人头像、项目标志、工作台标志、自定义连接器图标上；Agent 头像多一套内置图标，用的是自己的 AvatarEditor

export const MARK_COLORS = ['#3d4fd6', '#7a4fd6', '#0f8a8a', '#2f7d43', '#b0570b', '#c0352b', '#e8590c', '#23221e']
/** 原型里图片存成 data URL，太大会让数据很重，限制 1MB */
export const MAX_IMAGE = 1024 * 1024

export function readImage(f: File, onOk: (dataUrl: string) => void, onErr: (msg: string) => void) {
  if (!f.type.startsWith('image/')) { onErr('只能用图片'); return }
  if (f.size > MAX_IMAGE) { onErr('图片不能超过 1MB'); return }
  const r = new FileReader()
  r.onload = () => onOk(String(r.result))
  r.onerror = () => onErr('读取图片失败')
  r.readAsDataURL(f)
}

/** 一个方形标志：有图用图，没图用文字 + 底色 */
export function Mark({ image, icon, text, color, size = 32, round = false }: { image?: string; icon?: string; text: string; color: string; size?: number; round?: boolean }) {
  const style = { width: size, height: size, borderRadius: round ? '50%' : '28%' }
  // 优先级：上传的图片 > 内置图标 > 文字
  if (image) return <img className="mark mark-img" src={image} alt="" style={style} />
  if (icon && MARK_ICONS[icon]) return <span className="mark" style={{ ...style, background: color }}><MarkIconSvg name={icon} size={Math.round(size * 0.58)} stroke="#fff" width={size < 20 ? 2.6 : 2} /></span>
  return <span className="mark" style={{ ...style, background: color, fontSize: size * (text.length > 1 ? 0.34 : 0.44) }}>{text}</span>
}

export function MarkEditor({ children, image, icon, text, color, textPlaceholder, onImage, onIcon, onText, onColor, hint }: {
  /** 显示在按钮里的当前图像 */
  children: ReactNode
  image?: string
  /** 内置图标；不传 onIcon 就不给选 */
  icon?: string
  onIcon?: (k: string | undefined) => void
  text?: string
  color?: string
  textPlaceholder?: string
  onImage: (dataUrl: string | undefined) => void
  /** 不传就不给改文字（比如联系人，文字跟着名字走） */
  onText?: (t: string) => void
  /** 不传就不给选底色 */
  onColor?: (c: string) => void
  hint?: string
}) {
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', off)
    return () => window.removeEventListener('mousedown', off)
  }, [open])
  return (
    <div className="menu-wrap mark-edit" ref={ref}>
      <button type="button" className="avatar-btn" onClick={() => setOpen(!open)} title="更换图像">
        {children}
        <span className="avatar-btn-tip">更换</span>
      </button>
      {open && (
        <div className="menu avatar-menu">
          {onIcon && (
            <>
              <div className="menu-label">图标<span className="list-sub">{icon ? MARK_ICONS[icon]?.label : '没选，用文字'}</span></div>
              <div className="icon-pick">
                {ICON_GROUPS.flatMap((g) => Object.entries(MARK_ICONS).filter(([, x]) => x.group === g)).map(([k, x]) => (
                  <button type="button" key={k} className={cls('icon-pick-btn', icon === k && 'on')} title={`${x.group} · ${x.label}`} onClick={() => onIcon(icon === k ? undefined : k)}>
                    <MarkIconSvg name={k} size={16} />
                  </button>
                ))}
              </div>
            </>
          )}
          {onText && (
            <>
              <div className="menu-label">文字{onIcon && icon ? <span className="list-sub">选了图标时不显示</span> : null}</div>
              <div className="avatar-text-row">
                <input maxLength={2} value={text ?? ''} placeholder={textPlaceholder} onChange={(e) => onText(e.target.value)} />
                <span className="list-sub">一到两个字{textPlaceholder ? `；留空用「${textPlaceholder}」` : ''}</span>
              </div>
            </>
          )}
          {onColor && (
            <>
              <div className="menu-label">底色</div>
              <div className="agent-colors">
                {MARK_COLORS.map((c) => <button type="button" key={c} className={cls('color-dot', color === c && 'on')} style={{ background: c }} onClick={() => onColor(c)} />)}
              </div>
            </>
          )}
          <div className="menu-label">图片</div>
          <div className="avatar-upload">
            <label className="act">
              上传图片
              <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) readImage(f, (u) => { onImage(u); setErr('') }, setErr); e.target.value = '' }} />
            </label>
            {image && <button type="button" className="act act-quiet" onClick={() => onImage(undefined)}>移除图片</button>}
            <span className="list-sub">{hint ?? 'PNG、JPG，1MB 以内，建议正方形'}</span>
          </div>
          {err && <div className="field-err">{err}</div>}
        </div>
      )}
    </div>
  )
}
