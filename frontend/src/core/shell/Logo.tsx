// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 「一人之下」的标志：上面一横是「一」，下面一个「人」。图形照原型 web-next/src/logo.tsx，颜色在 shell.css（品牌色，不随明暗变）
export function AppLogo({ size = 30 }: { size?: number }) {
  return (
    <svg className="app-logo" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <rect className="app-logo-bg" width="64" height="64" rx="18" />
      <path className="app-logo-one" d="M17 17.5h30" strokeWidth="5.5" strokeLinecap="round" />
      <path className="app-logo-ren" d="M32.5 26 19 49" strokeWidth="5.5" strokeLinecap="round" />
      <path className="app-logo-ren" d="M31 33.5 45.5 49" strokeWidth="5.5" strokeLinecap="round" />
    </svg>
  )
}
