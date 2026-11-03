// 「一人之下」的标志：上面一横是「一」，下面一个「人」；和 public/logo.svg 是同一个图形
export function AppLogo({ size = 30 }: { size?: number }) {
  return (
    <svg className="app-logo" viewBox="0 0 64 64" width={size} height={size} aria-label="一人之下" role="img">
      <rect width="64" height="64" rx="18" fill="#23221e" />
      <path d="M17 17.5h30" stroke="#e8a33d" strokeWidth="5.5" strokeLinecap="round" />
      <path d="M32.5 26 19 49" stroke="#fff" strokeWidth="5.5" strokeLinecap="round" />
      <path d="M31 33.5 45.5 49" stroke="#fff" strokeWidth="5.5" strokeLinecap="round" />
    </svg>
  )
}
