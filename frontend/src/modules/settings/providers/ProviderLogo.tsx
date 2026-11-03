import { kindOf } from './catalog'

/** 服务商标志：内置 SVG，底色加一两个字，照原型 ProviderLogo；不引图片 */
export function ProviderLogo({ kind, size = 36 }: { kind: string; size?: number }) {
  const k = kindOf(kind)
  return (
    <svg className="pv-logo" width={size} height={size} viewBox="0 0 36 36" role="img" aria-label={k.label}>
      <rect width="36" height="36" rx="10" fill={k.color} />
      <text x="18" y="18" textAnchor="middle" dominantBaseline="central" fill="#fff" fontWeight="700"
        fontSize={k.short.length > 1 ? 12 : 14}>{k.short}</text>
    </svg>
  )
}
