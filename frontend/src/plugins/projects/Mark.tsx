// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 项目标志和标志编辑（照原型 imagepick.tsx 的 Mark、MarkEditor）：优先级 上传的图片 > 内置图标 > 文字
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { ProjectMark, ProjectView } from '../../core/data'
import { cls } from '../../core/ui'
import { ICON_GROUPS, MARK_COLORS, MARK_ICONS } from './markIcons'
import { colorOf, markText } from './model'

/** 图片限制 1MB（契约：props.mark.image 是 data:image/ 开头的 data URL，1MB 以内） */
const MAX_IMAGE = 1024 * 1024

export function MarkIconSvg({ name, size = 16, width = 2 }: { name: string; size?: number; width?: number }) {
  const ic = MARK_ICONS[name]
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d={ic?.d ?? 'M5 5h14v14H5Z'} fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ProjectMarkView({ p, size = 22 }: { p: Pick<ProjectView, 'id' | 'name' | 'color' | 'mark'>; size?: number }) {
  const style = { width: size, height: size, background: colorOf(p) } as CSSProperties
  if (p.mark.image) return <img className="pj-mark pj-mark-img" src={p.mark.image} alt="" style={style} />
  if (p.mark.icon && MARK_ICONS[p.mark.icon]) {
    return <span className="pj-mark" aria-hidden="true" style={style}><MarkIconSvg name={p.mark.icon} size={Math.round(size * 0.58)} width={size < 20 ? 2.6 : 2} /></span>
  }
  const t = markText(p)
  return <span className="pj-mark" aria-hidden="true" style={{ ...style, fontSize: size * (t.length > 1 ? 0.34 : 0.44) }}>{t}</span>
}

function readImage(f: File, onOk: (dataUrl: string) => void, onErr: (msg: string) => void) {
  if (!f.type.startsWith('image/')) { onErr('只能用图片'); return }
  if (f.size > MAX_IMAGE) { onErr('图片不能超过 1MB'); return }
  const r = new FileReader()
  r.onload = () => onOk(String(r.result))
  r.onerror = () => onErr('读取图片失败')
  r.readAsDataURL(f)
}

/** 点标志弹出编辑：图标、文字、底色、图片；改了立即生效 */
export function MarkEditor({ children, mark, color, textPlaceholder, onMark, onColor }: {
  children: ReactNode
  mark: ProjectMark
  color: string
  textPlaceholder: string
  onMark: (m: ProjectMark) => void
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
    <div className="pj-mark-edit" ref={ref}>
      <button type="button" className="pj-mark-btn" aria-expanded={open} aria-label="更换图像" title="更换图像" onClick={() => setOpen(!open)}>
        {children}
        <span className="pj-mark-tip" aria-hidden="true">更换</span>
      </button>
      {open && (
        <div className="menu pj-mark-menu" role="dialog" aria-label="标志">
          <div className="menu-label">图标<span className="pj-sub">{icon ? MARK_ICONS[icon]?.label : '没选，用文字'}</span></div>
          <div className="pj-icon-pick">
            {ICON_GROUPS.flatMap((g) => Object.entries(MARK_ICONS).filter(([, x]) => x.group === g)).map(([k, x]) => (
              <button type="button" key={k} className={cls('pj-icon-btn', icon === k && 'on')} aria-pressed={icon === k}
                title={`${x.group} · ${x.label}`} aria-label={x.label}
                onClick={() => onMark({ text: mark.text, image: mark.image, icon: icon === k ? undefined : k })}>
                <MarkIconSvg name={k} size={16} />
              </button>
            ))}
          </div>
          <div className="menu-label">文字{icon ? <span className="pj-sub">选了图标时不显示</span> : null}</div>
          <div className="pj-mark-row">
            <input className="input" maxLength={2} value={mark.text} placeholder={textPlaceholder} aria-label="标志文字"
              // 填了文字会清掉图标（SPEC-projects-13.1）
              onChange={(e) => { const text = e.target.value; onMark({ text, image: mark.image, icon: text ? undefined : icon }) }} />
            <span className="pj-sub">一到两个字；留空用「{textPlaceholder}」</span>
          </div>
          <div className="menu-label">底色</div>
          <div className="pj-colors">
            {MARK_COLORS.map((c) => (
              <button type="button" key={c} className={cls('pj-color', color === c && 'on')} aria-pressed={color === c} aria-label={`底色 ${c}`}
                style={{ background: c }} onClick={() => onColor(c)} />
            ))}
          </div>
          <div className="menu-label">图片</div>
          <div className="pj-mark-row">
            <label className="btn btn-outline btn-sm">
              上传图片
              <input type="file" accept="image/*" hidden onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) readImage(f, (u) => { onMark({ ...mark, image: u }); setErr('') }, setErr)
                e.target.value = ''
              }} />
            </label>
            {mark.image && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onMark({ text: mark.text, icon })}>移除图片</button>}
            <span className="pj-sub">PNG、JPG，1MB 以内，建议正方形</span>
          </div>
          {err && <div className="field-err" role="alert">{err}</div>}
        </div>
      )}
    </div>
  )
}
