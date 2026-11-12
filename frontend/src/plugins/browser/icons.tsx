// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 浏览器页用到的小图标，照原型 web-next/src/browser.tsx
import type { ReactNode } from 'react'
import { cls } from '../../core/ui'
import type { TabKind } from './model'

const svg = (w: number, children: ReactNode, extra: Record<string, unknown> = {}) => (
  <svg viewBox="0 0 16 16" width={w} height={w} aria-hidden="true" {...extra}>{children}</svg>
)
const line = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export const IconX = ({ size = 9 }: { size?: number }) => svg(size, <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />)
export const IconPlus = () => svg(12, <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />)
export const IconPin = () => svg(10, <path d="M6 2h4l-.5 4 2.5 2.5H4L6.5 6 6 2ZM8 8.5V14" {...line} strokeWidth="1.4" />)
export const IconDown = () => svg(12, <path d="m4 6 4 4 4-4" {...line} strokeWidth="1.6" />)
export const IconBack = () => svg(14, <path d="M10 3 5 8l5 5" {...line} strokeWidth="1.6" />)
export const IconForward = () => svg(14, <path d="m6 3 5 5-5 5" {...line} strokeWidth="1.6" />)
export const IconReload = () => svg(14, <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" {...line} strokeWidth="1.5" />)
export const IconExternal = () => svg(14, <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" {...line} strokeWidth="1.5" />)
export const IconChev = ({ open }: { open: boolean }) =>
  svg(12, <path d="m6 4 4 4-4 4" {...line} strokeWidth="1.6" />, { className: cls('br-chev', open && 'on') })

export function KindIcon({ kind }: { kind: TabKind }) {
  const extra = { className: cls('br-kicon', `br-kicon-${kind}`) }
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }
  if (kind === 'home') {
    return svg(13, <g {...p}><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" /></g>, extra)
  }
  if (kind === 'proto') return svg(13, <g {...p}><rect x="1.8" y="2.8" width="12.4" height="8.4" rx="1.4" /><path d="M5.5 13.5h5M8 11.2v2.3" strokeLinecap="round" /></g>, extra)
  return svg(13, <g {...p}><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c1.8 1.8 2.6 3.8 2.6 6S9.8 12.2 8 14M8 2C6.2 3.8 5.4 5.8 5.4 8s.8 4.2 2.6 6" /></g>, extra)
}

export function TabIcon({ kind, busy }: { kind: TabKind; busy: boolean }) {
  return busy ? <span className="br-spin" aria-label="加载中" /> : <KindIcon kind={kind} />
}
/** 会话头部「浏览器」入口用，和原型项目标题行的「浏览器」按钮同一个 */
export const IconGlobe = () => svg(14, <><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c1.8 1.8 2.6 3.8 2.6 6S9.8 12.2 8 14M8 2C6.2 3.8 5.4 5.8 5.4 8s.8 4.2 2.6 6" /></>, { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 })
