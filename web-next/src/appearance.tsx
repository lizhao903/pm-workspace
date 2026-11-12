// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { PageTitle } from './topbar'
import { cls } from './ui'

export type ThemePref = 'light' | 'dark' | 'system'

const THEMES: { key: ThemePref; label: string; desc: string }[] = [
  { key: 'light', label: '浅色', desc: '暖灰底色' },
  { key: 'dark', label: '深色', desc: '夜间或暗光环境' },
  { key: 'system', label: '跟随系统', desc: '跟着操作系统的明暗设置走' },
]

/** 设置 > 外观：配色方案和一级菜单收起。偏好只存在这台电脑的浏览器里 */
export function AppearancePage({ theme, onTheme, collapsed, onCollapsed }: {
  theme: ThemePref
  onTheme: (t: ThemePref) => void
  collapsed: boolean
  onCollapsed: (c: boolean) => void
}) {
  return (
    <div className="page page-fill">
      <PageTitle parent="设置" desc="只对这台电脑上的浏览器生效">外观</PageTitle>
      <div className="section-label">配色方案</div>
      <div className="theme-grid">
        {THEMES.map((t) => (
          <button key={t.key} className={cls('theme-card', theme === t.key && 'on')} onClick={() => onTheme(t.key)} aria-pressed={theme === t.key}>
            <span className={cls('theme-preview', `tp-${t.key}`)}>
              <span className="tp-side" /><span className="tp-main"><i /><i /><i /></span>
            </span>
            <span className="theme-text"><b>{t.label}</b><span className="list-sub">{t.desc}</span></span>
          </button>
        ))}
      </div>
      <div className="section-label">布局</div>
      <label className="switch-row appearance-row">
        <span><span className="field-label">收起一级菜单</span><span className="switch-hint">只显示图标，内容区更宽；左上角的按钮也能随时切换</span></span>
        <span className="switch-line"><input type="checkbox" checked={collapsed} onChange={(e) => onCollapsed(e.target.checked)} /><span className="switch" /></span>
      </label>
    </div>
  )
}
