import { cls } from './cls'
import { THEMES, useTheme } from './theme'

/** 三选一的主题切换：浅色、深色、跟随系统 */
export function ThemeSwitch({ className }: { className?: string }) {
  const { pref, setTheme } = useTheme()
  return (
    <div className={cls('theme-switch', className)} role="radiogroup" aria-label="配色方案">
      {THEMES.map((t) => (
        <button
          key={t.key}
          type="button"
          role="radio"
          aria-checked={pref === t.key}
          className={cls('theme-switch-item', pref === t.key && 'on')}
          onClick={() => setTheme(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
