// 标志编辑（照原型 imagepick.tsx 的 MarkEditor），从项目插件 plugins/projects/Mark.tsx 挪来一份：
// 点标志弹出编辑图标、文字、底色、图片，改了立即生效。props 和项目插件那份一致，项目插件改从这里引用时只改 import
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cls } from './cls'
import { ICON_GROUPS, MARK_COLORS, MARK_ICONS } from './markIcons'
import './mark.css'

/** 文字、内置图标、上传的图片（data URL）；优先级 图片 > 图标 > 文字 */
export type MarkValue = { text: string; icon?: string; image?: string }

/** 图片限制 1MB（契约：mark.image 是 data:image/ 开头的 data URL） */
const MAX_IMAGE = 1024 * 1024

export function MarkIconSvg({ name, size = 16, width = 2 }: { name: string; size?: number; width?: number }) {
  const ic = MARK_ICONS[name]
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d={ic?.d ?? 'M5 5h14v14H5Z'} fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function readImage(f: File, onOk: (dataUrl: string) => void, onErr: (msg: string) => void) {
  if (!f.type.startsWith('image/')) { onErr('只能用图片'); return }
  if (f.size > MAX_IMAGE) { onErr('图片不能超过 1MB'); return }
  const r = new FileReader()
  r.onload = () => onOk(String(r.result))
  r.onerror = () => onErr('读取图片失败')
  r.readAsDataURL(f)
}

export function MarkEditor({ children, mark, color, textPlaceholder, hint, onMark, onColor }: {
  /** 按钮里显示的当前标志 */
  children: ReactNode
  mark: MarkValue
  color: string
  textPlaceholder: string
  /** 图片那一行的说明，默认「PNG、JPG，1MB 以内，建议正方形」 */
  hint?: string
  onMark: (m: MarkValue) => void
  onColor: (c: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', off)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc) }
  }, [open])
  const icon = mark.icon
  return (
    <div className="mk-edit" ref={ref}>
      <button type="button" className="mk-btn" aria-expanded={open} aria-label="更换图像" title="更换图像" onClick={() => setOpen(!open)}>
        {children}
        <span className="mk-tip" aria-hidden="true">更换</span>
      </button>
      {open && (
        <div className="menu mk-menu" role="dialog" aria-label="标志">
          <div className="menu-label">图标<span className="mk-sub">{icon ? MARK_ICONS[icon]?.label : '没选，用文字'}</span></div>
          <div className="mk-icon-pick">
            {ICON_GROUPS.flatMap((g) => Object.entries(MARK_ICONS).filter(([, x]) => x.group === g)).map(([k, x]) => (
              <button type="button" key={k} className={cls('mk-icon-btn', icon === k && 'on')} aria-pressed={icon === k}
                title={`${x.group} · ${x.label}`} aria-label={x.label}
                onClick={() => onMark({ text: mark.text, image: mark.image, icon: icon === k ? undefined : k })}>
                <MarkIconSvg name={k} size={16} />
              </button>
            ))}
          </div>
          <div className="menu-label">文字{icon ? <span className="mk-sub">选了图标时不显示</span> : null}</div>
          <div className="mk-row">
            <input className="input" maxLength={2} value={mark.text} placeholder={textPlaceholder} aria-label="标志文字"
              // 填了文字会清掉图标（SPEC-projects-13.1）
              onChange={(e) => { const text = e.target.value; onMark({ text, image: mark.image, icon: text ? undefined : icon }) }} />
            <span className="mk-sub">一到两个字；留空用「{textPlaceholder}」</span>
          </div>
          <div className="menu-label">底色</div>
          <div className="mk-colors">
            {MARK_COLORS.map((c) => (
              <button type="button" key={c} className={cls('mk-color', color === c && 'on')} aria-pressed={color === c} aria-label={`底色 ${c}`}
                style={{ background: c }} onClick={() => onColor(c)} />
            ))}
          </div>
          <div className="menu-label">图片</div>
          <div className="mk-row">
            <label className="btn btn-outline btn-sm">
              上传图片
              <input type="file" accept="image/*" hidden onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) readImage(f, (u) => { onMark({ ...mark, image: u }); setErr('') }, setErr)
                e.target.value = ''
              }} />
            </label>
            {mark.image && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onMark({ text: mark.text, icon })}>移除图片</button>}
            <span className="mk-sub">{hint ?? 'PNG、JPG，1MB 以内，建议正方形'}</span>
          </div>
          {err && <div className="field-err" role="alert">{err}</div>}
        </div>
      )}
    </div>
  )
}
