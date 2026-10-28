import { ThemeSwitch, useTheme } from '..'
import './tokens-page.css'

// 设计变量对照页，只在 dev 构建里挂路由 /_dev/tokens。值从页面实际生效的样式里读，切主题跟着变。
const COLORS: { group: string; names: string[] }[] = [
  { group: '底色与线', names: ['bg', 'side', 'panel', 'panel-2', 'hover', 'line', 'line-2'] },
  { group: '文字', names: ['text', 'muted', 'faint'] },
  { group: '强调', names: ['accent', 'accent-ink', 'accent-soft', 'accent-line'] },
  { group: '状态', names: ['ok', 'warn', 'warn-soft', 'danger', 'danger-soft'] },
]
const FONT_SIZES = ['fs-3xl', 'fs-2xl', 'fs-xl', 'fs-lg', 'fs-md', 'fs', 'fs-sm', 'fs-xs', 'fs-2xs']
const SPACES = ['sp-1', 'sp-2', 'sp-3', 'sp-4', 'sp-5', 'sp-6', 'sp-7', 'sp-8', 'sp-10', 'sp-12', 'sp-16']
const RADII = ['r-sm', 'r', 'r-lg']
const SHADOWS = ['shadow-sm', 'shadow', 'shadow-lg']
const SIZES = ['side-w', 'subnav-w', 'drawer-w', 'top-h', 'foot-h']

export default function TokensPage() {
  const { pref, resolved } = useTheme()
  // 渲染时直接读变量的实际值；切主题时 data-theme 先写上再通知重渲染，读到的就是新值
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string) => cs.getPropertyValue('--' + n).trim()

  return (
    <div className="tk-page">
      <header className="tk-head">
        <div>
          <h1>设计变量</h1>
          <p className="muted">对照原型 web-next/src/styles.css 的 :root 与暗色段。当前偏好：{pref}，实际生效：{resolved}</p>
        </div>
        <ThemeSwitch />
      </header>

      {COLORS.map((g) => (
        <section key={g.group} className="tk-section">
          <h2>{g.group}</h2>
          <div className="tk-swatches">
            {g.names.map((n) => (
              <div key={n} className="tk-swatch">
                <span className="tk-chip" style={{ background: `var(--${n})` }} />
                <code>--{n}</code>
                <span className="faint" data-token={n}>{v(n)}</span>
              </div>
            ))}
          </div>
        </section>
      ))}

      <section className="tk-section">
        <h2>字阶</h2>
        <p className="muted">行高 --lh {v('lh')}；正文字体 --sans，等宽 --mono</p>
        <div className="tk-rows">
          {FONT_SIZES.map((n) => (
            <div key={n} className="tk-row">
              <code>--{n}</code>
              <span className="faint tk-val">{v(n)}</span>
              <span style={{ fontSize: `var(--${n})` }}>一人之下 产品工作台 Aa 0123</span>
            </div>
          ))}
          <div className="tk-row">
            <code>--mono</code>
            <span className="faint tk-val">{v('fs')}</span>
            <span style={{ fontFamily: 'var(--mono)' }}>const ref = 'REQ-0001'</span>
          </div>
        </div>
      </section>

      <section className="tk-section">
        <h2>间距</h2>
        <div className="tk-rows">
          {SPACES.map((n) => (
            <div key={n} className="tk-row">
              <code>--{n}</code>
              <span className="faint tk-val">{v(n)}</span>
              <span className="tk-bar" style={{ width: `var(--${n})` }} />
            </div>
          ))}
        </div>
      </section>

      <section className="tk-section">
        <h2>圆角与阴影</h2>
        <div className="tk-swatches">
          {RADII.map((n) => (
            <div key={n} className="tk-swatch">
              <span className="tk-box" style={{ borderRadius: `var(--${n})` }} />
              <code>--{n}</code>
              <span className="faint">{v(n)}</span>
            </div>
          ))}
          {SHADOWS.map((n) => (
            <div key={n} className="tk-swatch">
              <span className="tk-box" style={{ boxShadow: `var(--${n})` }} />
              <code>--{n}</code>
            </div>
          ))}
        </div>
      </section>

      <section className="tk-section">
        <h2>布局尺寸</h2>
        <div className="tk-rows">
          {SIZES.map((n) => (
            <div key={n} className="tk-row">
              <code>--{n}</code>
              <span className="faint">{v(n)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
