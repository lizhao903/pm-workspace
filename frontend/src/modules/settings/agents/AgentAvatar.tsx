// Agent 头像和头像设置，照原型 web-next/src/agents.tsx AgentAvatar、AvatarEditor（SPEC-settings-9.4）。
// 底色是 Agent 的 color（后端存的 #rrggbb），图标、文字都是白色。
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Agent, AgentAvatar as AvatarConf } from '../../../core/data'
import { cls } from '../../../core/ui'
import { AGENT_COLORS, AVATAR_ICONS, AVATAR_MAX_BYTES } from './model'

const ICON_PATH: Record<string, ReactNode> = {
  robot: <><rect x="3" y="5" width="10" height="8" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 2.5V5M6 9h.01M10 9h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></>,
  chat: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />,
  doc: <><path d="M4 1.8h5.5L12.5 5v9.2H4Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="M6 8h4.5M6 10.5h4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>,
  chart: <path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />,
  flow: <><rect x="1.8" y="2.5" width="4.4" height="3.6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" /><rect x="9.8" y="9.9" width="4.4" height="3.6" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M6.2 4.3h2a1.6 1.6 0 0 1 1.6 1.6v4" fill="none" stroke="currentColor" strokeWidth="1.4" /></>,
  search: <><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M10.2 10.2 13.5 13.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  mail: <><rect x="2" y="3.5" width="12" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="m2.5 4.5 5.5 4 5.5-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></>,
  calendar: <><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>,
  shield: <path d="M8 1.8 13 3.8v4c0 3-2.2 5.2-5 6.4-2.8-1.2-5-3.4-5-6.4v-4Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />,
  spark: <path d="M8 2 9.4 6.6 14 8 9.4 9.4 8 14 6.6 9.4 2 8 6.6 6.6Z" fill="currentColor" />,
}

type AvatarAgent = Pick<Agent, 'name' | 'color'> & { avatar?: AvatarConf }

/** 上传的图片 / 内置图标 / 文字（自定义文字，默认名字第一个字） */
export function AgentAvatar({ agent, size = 32 }: { agent: AvatarAgent; size?: number }) {
  const av = agent.avatar
  if (av?.kind === 'image' && av.value) return <img className="ag-avatar ag-avatar-img" src={av.value} alt="" style={{ width: size, height: size }} />
  return (
    <span className="ag-avatar" aria-hidden="true" style={{ width: size, height: size, background: agent.color, fontSize: size * 0.42 }}>
      {av?.kind === 'icon' && ICON_PATH[av.value]
        ? <svg viewBox="0 0 16 16" width={size * 0.56} height={size * 0.56}>{ICON_PATH[av.value]}</svg>
        : (av?.kind === 'text' && av.value) || (agent.name.trim() || 'A').slice(0, 1)}
    </span>
  )
}

/** 头像设置：文字、图标、底色、上传图片 */
export function AvatarEditor({ agent, onChange }: { agent: AvatarAgent & { avatar: AvatarConf }; onChange: (p: { avatar?: AvatarConf; color?: string }) => void }) {
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
  const upload = (f: File | undefined) => {
    if (!f) return
    if (!f.type.startsWith('image/')) { setErr('只能用图片'); return }
    if (f.size > AVATAR_MAX_BYTES) { setErr('图片不能超过 1MB'); return }
    const r = new FileReader()
    r.onload = () => { onChange({ avatar: { kind: 'image', value: String(r.result) } }); setErr('') }
    r.readAsDataURL(f)
  }
  const av = agent.avatar
  return (
    <div className="ag-menu-wrap" ref={ref}>
      <button type="button" className="ag-avatar-btn" onClick={() => setOpen(!open)} title="设置头像" aria-label="设置头像" aria-expanded={open}>
        <AgentAvatar agent={agent} size={56} />
        <span className="ag-avatar-tip">更换</span>
      </button>
      {open && (
        <div className="menu ag-avatar-menu" role="dialog" aria-label="头像设置">
          <div className="menu-label">文字</div>
          <div className="ag-avatar-text">
            <input maxLength={2} aria-label="头像文字" value={av.kind === 'text' ? av.value : ''} placeholder={(agent.name.trim() || 'A').slice(0, 1)}
              onChange={(e) => onChange({ avatar: { kind: 'text', value: e.target.value } })} />
            <span className="ag-sub">一到两个字；留空用名字的第一个字</span>
          </div>
          <div className="menu-label">图标</div>
          <div className="ag-avatar-icons">
            {AVATAR_ICONS.map((ic) => (
              <button key={ic} type="button" className={cls('ag-avatar-icon', av.kind === 'icon' && av.value === ic && 'on')} title={ic} aria-label={`图标 ${ic}`}
                aria-pressed={av.kind === 'icon' && av.value === ic} onClick={() => onChange({ avatar: { kind: 'icon', value: ic } })}>
                <AgentAvatar agent={{ ...agent, avatar: { kind: 'icon', value: ic } }} size={30} />
              </button>
            ))}
          </div>
          <div className="menu-label">底色</div>
          <div className="ag-colors">
            {AGENT_COLORS.map((c) => (
              <button key={c} type="button" className={cls('ag-color', agent.color === c && 'on')} style={{ background: c }} aria-label={`底色 ${c}`}
                aria-pressed={agent.color === c} onClick={() => onChange({ color: c })} />
            ))}
          </div>
          <div className="menu-label">图片</div>
          <div className="ag-avatar-upload">
            <label className="btn btn-outline btn-sm">
              上传图片
              <input type="file" accept="image/*" hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = '' }} />
            </label>
            {av.kind === 'image' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ avatar: { kind: 'text', value: '' } })}>移除图片</button>}
            <span className="ag-sub">PNG、JPG，1MB 以内，建议正方形</span>
          </div>
          {err && <div className="field-err">{err}</div>}
        </div>
      )}
    </div>
  )
}
