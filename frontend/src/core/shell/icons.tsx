import type { ReactNode } from 'react'

// 一级菜单和外壳按钮的图标，线条照原型 web-next/src/App.tsx 的 icons；跟 currentColor 走
const svg = (children: ReactNode) => (
  <svg className="side-icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">{children}</svg>
)
const line = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 } as const
const round = { ...line, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

const MODULE_ICONS: Record<string, ReactNode> = {
  today: svg(<><circle cx="8" cy="8" r="5.8" {...line} /><path d="M8 4.8V8l2.2 1.4" {...round} /></>),
  tasks: svg(<><rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.4" {...line} /><path d="m5.2 8.2 2 2 3.8-4.2" {...round} strokeWidth="1.5" /></>),
  docs: svg(<><path d="M4 1.8h5.5L12.5 5v9.2H4Z" {...line} strokeLinejoin="round" /><path d="M9.3 2v3.2h3M6 8h4.5M6 10.5h4.5" {...line} strokeLinecap="round" /></>),
  contacts: svg(<><circle cx="6" cy="5.5" r="2.5" {...line} /><path d="M1.5 13.5c.6-2.4 2.3-3.6 4.5-3.6s3.9 1.2 4.5 3.6M11 3.2a2.4 2.4 0 0 1 0 4.6M12.6 10.2c1 .5 1.6 1.6 1.9 3.3" {...line} strokeLinecap="round" /></>),
  conversations: svg(<><path d="M2 3.5h8.5v5.5H6l-2.5 2V9H2Z" {...line} strokeLinejoin="round" /><path d="M10.5 6H14v5.5h-1.5v2l-2.5-2H7.5V9" {...line} strokeLinejoin="round" /></>),
  settings: svg(<><circle cx="8" cy="8" r="2.2" {...line} /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" {...line} strokeLinecap="round" /></>),
}

// 插件模块没有专门的图标时用这个
const FALLBACK = svg(<><rect x="2.2" y="2.2" width="5" height="5" rx="1.2" {...line} /><rect x="8.8" y="2.2" width="5" height="5" rx="1.2" {...line} /><rect x="2.2" y="8.8" width="5" height="5" rx="1.2" {...line} /><rect x="8.8" y="8.8" width="5" height="5" rx="1.2" {...line} /></>)

export function ModuleIcon({ id }: { id: string }) {
  return MODULE_ICONS[id] ?? FALLBACK
}

export const IconSideToggle = ({ collapsed }: { collapsed: boolean }) => (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <rect x="2" y="2.5" width="12" height="11" rx="2" {...line} /><path d="M6 2.5v11" {...line} />
    {collapsed ? <path d="m9 6.5 1.8 1.5L9 9.5" {...round} /> : <path d="M10.8 6.5 9 8l1.8 1.5" {...round} />}
  </svg>
)

export const IconMenu = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" {...line} strokeWidth="1.5" strokeLinecap="round" /></svg>
)

export const IconSectionChevron = () => (
  <svg className="side-sec-chev" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="m6 4 4 4-4 4" {...round} strokeWidth="1.8" /></svg>
)
