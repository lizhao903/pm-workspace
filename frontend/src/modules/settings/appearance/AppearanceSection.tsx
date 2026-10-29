// 设置里的「外观」（ALIGN-14），照原型 web-next/src/appearance.tsx AppearancePage（SPEC-settings-21）。
// 配色用 core/ui/theme.ts 的偏好，收起和侧栏左上角的按钮是同一个状态；都只存在这台电脑的浏览器里
import { useSideCollapsed } from '../../../core/shell/sideCollapse'
import { cls, PageTitle, Switch, THEMES, useTheme, type ThemePref } from '../../../core/ui'
import './appearance.css'

const DESC: Record<ThemePref, string> = {
  light: '暖灰底色',
  dark: '夜间或暗光环境',
  system: '跟着操作系统的明暗设置走',
}

export function AppearanceSection() {
  const { pref, setTheme } = useTheme()
  const [collapsed, setCollapsed] = useSideCollapsed()
  return (
    <div className="ap-page">
      <PageTitle parent="设置" desc="只对这台电脑上的浏览器生效">外观</PageTitle>
      <div className="ap-label">配色方案</div>
      <div className="ap-grid">
        {THEMES.map((t) => (
          <button key={t.key} type="button" className={cls('ap-card', pref === t.key && 'on')} aria-pressed={pref === t.key} onClick={() => setTheme(t.key)}>
            <span className={cls('ap-preview', `ap-tp-${t.key}`)} aria-hidden="true">
              <span className="ap-tp-side" /><span className="ap-tp-main"><i /><i /><i /></span>
            </span>
            <span className="ap-text"><b>{t.label}</b><span className="ap-sub">{DESC[t.key]}</span></span>
          </button>
        ))}
      </div>
      <div className="ap-label">布局</div>
      <div className="ap-row">
        <span className="ap-row-text">
          <span className="ap-row-title">收起一级菜单</span>
          <span className="ap-sub">只显示图标，内容区更宽；左上角的按钮也能随时切换</span>
        </span>
        <Switch aria-label="收起一级菜单" checked={collapsed} onCheckedChange={setCollapsed} />
      </div>
    </div>
  )
}
