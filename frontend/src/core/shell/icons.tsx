// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

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
  runs: svg(<><circle cx="8" cy="8" r="5.8" {...line} /><path d="M6.6 5.4v5.2L11 8Z" {...line} strokeLinejoin="round" /></>),
  settings: svg(<><circle cx="8" cy="8" r="2.2" {...line} /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" {...line} strokeLinecap="round" /></>),
}

// 插件在清单 icon 里能挑的图标（docs/plugin-api.md 1.1），线条照原型 App.tsx 的 icons
const PLUGIN_ICONS: Readonly<Record<string, ReactNode>> = {
  folder: svg(<><path d="M2 4.5c0-.6.4-1 1-1h3.2l1.4 1.5H13c.6 0 1 .4 1 1v6.5c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1Z" {...line} strokeLinejoin="round" /><path d="M5 9h6" {...line} strokeLinecap="round" /></>),
  message: svg(<><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2Z" {...line} strokeLinejoin="round" /><path d="M5 6.5h6M5 8.5h3.5" {...line} strokeLinecap="round" /></>),
  terminal: svg(<><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.8" {...line} /><path d="m4.5 6.5 2 1.5-2 1.5M8 10h3.5" {...round} /></>),
  globe: svg(<><circle cx="8" cy="8" r="6" {...round} /><path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14M8 2C6.2 3.7 5.4 5.7 5.4 8s.8 4.3 2.6 6" {...round} /></>),
  video: svg(<><rect x="1.8" y="3.2" width="9.2" height="9.6" rx="1.8" {...round} /><path d="m11 6.6 3.2-1.8v6.4L11 9.4" {...round} /></>),
  candles: svg(<><path d="M4 3v10M4 5h-.01M12 4v8M8 6v7" {...round} /><rect x="2.8" y="5.5" width="2.4" height="4.5" rx=".5" {...round} /><rect x="6.8" y="7.5" width="2.4" height="3.5" rx=".5" {...round} /><rect x="10.8" y="5" width="2.4" height="4" rx=".5" {...round} /></>),
  pulse: svg(<path d="M1.8 8h2.6l1.6-4 3 8 1.6-4h3.6" {...round} />),
  mic: svg(<><rect x="5.9" y="1.8" width="4.2" height="7.4" rx="2.1" {...line} /><path d="M3.5 7.6a4.5 4.5 0 0 0 9 0M8 12.1v2.1M5.6 14.2h4.8" {...round} /></>),
  chart: svg(<><path d="M2 13.5h12M3.5 11l3-3.5 2.5 2 4-5" {...round} /><path d="M10.5 4.5h2.5V7" {...round} /></>),
  swap: svg(<path d="M3 5h9.5l-2.5-2.5M13 11H3.5L6 13.5" {...round} />),
  flow: svg(<><rect x="1.8" y="2" width="4.4" height="3.6" rx="1" {...line} /><rect x="9.8" y="6.2" width="4.4" height="3.6" rx="1" {...line} /><rect x="1.8" y="10.4" width="4.4" height="3.6" rx="1" {...line} /><path d="M6.2 3.8h2.2a1.4 1.4 0 0 1 1.4 1.4V8M9.8 8v2.8a1.4 1.4 0 0 1-1.4 1.4H6.2" {...line} /></>),
}

// 插件模块没有专门的图标、清单里的 icon 外壳又不认识时用这个
const FALLBACK = svg(<><rect x="2.2" y="2.2" width="5" height="5" rx="1.2" {...line} /><rect x="8.8" y="2.2" width="5" height="5" rx="1.2" {...line} /><rect x="2.2" y="8.8" width="5" height="5" rx="1.2" {...line} /><rect x="8.8" y="8.8" width="5" height="5" rx="1.2" {...line} /></>)

/** 内核模块用自己的图标；插件模块用所属插件清单里声明的 icon */
export function ModuleIcon({ id, icon }: { id: string; icon?: string }) {
  return MODULE_ICONS[id] ?? (icon ? PLUGIN_ICONS[icon] : undefined) ?? FALLBACK
}

export const IconNewSession = () => (
  <svg className="side-icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <path d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2H7l-3 2.5v-2.5h0a2 2 0 0 1-1.5-2Z" {...line} strokeLinejoin="round" />
    <path d="M8 4.8v3.6M6.2 6.6h3.6" {...line} strokeLinecap="round" />
  </svg>
)

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
