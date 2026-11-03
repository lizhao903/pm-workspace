// 发布记录页的小部件：平台标签、封面色块、发布状态、判定进度（照原型 videopublish.tsx 的 PlatformTag、CoverSwatch，covertest.tsx 的 RuleChips）
import type { CSSProperties } from 'react'
import type { VideoArtifact, VideoCoverTest, VideoPlatform, VideoPublishStatus } from '../../core/data'
import { Pill, cls } from '../../core/ui'
import { COVER_RATIO, coverRatioOf } from './artifactModel'
import { PLATFORM_META, PUBLISH_STATUS, pct, wan } from './publishModel'

export const PlatformTag = ({ k }: { k: VideoPlatform }) => (
  <span className="vp-plat" style={{ '--c': PLATFORM_META[k].color } as CSSProperties}><i aria-hidden="true" />{PLATFORM_META[k].label}</span>
)

export const PubStatus = ({ s, sending }: { s: VideoPublishStatus; sending?: boolean }) =>
  (sending ? <Pill label="发布中…" color="var(--accent)" /> : <Pill {...PUBLISH_STATUS[s]} />)

const HUE = [24, 205, 145, 275, 340]

/** 封面色块：按封面比例画，色调跟着第几版走；给了 onClick 是可选的按钮 */
export function CoverSwatch({ a, size = 'md', on, onClick, label, disabled }: {
  a: VideoArtifact
  size?: 'sm' | 'md'
  on?: boolean
  onClick?: () => void
  /** 按钮的读屏名字，默认「封面名 · 比例」 */
  label?: string
  disabled?: boolean
}) {
  const r = COVER_RATIO[coverRatioOf(a)]
  const style = { aspectRatio: `${r.w} / ${r.h}`, '--h': HUE[((a.option ?? 1) - 1 + HUE.length) % HUE.length] } as CSSProperties
  const title = `${a.name} · ${r.label} · ${a.path}`
  const body = <span aria-hidden="true">{a.option ?? '-'}</span>
  if (onClick) {
    return (
      <button type="button" className={cls('vp-cover', `vp-cover-${size}`, on && 'on')} style={style} title={title} aria-pressed={on}
        aria-label={label ?? `${a.name} · ${r.label}`} disabled={disabled} onClick={onClick}>{body}</button>
    )
  }
  return <span className={cls('vp-cover', `vp-cover-${size}`)} style={style} title={title}>{body}</span>
}

/** 判定进度三条：曝光、天数、点击率差距，到线的变绿 */
export function RuleChips({ t }: { t: VideoCoverTest }) {
  const st = t.state
  return (
    <span className="vp-ab-rules">
      <span className={cls('vp-ab-rule', st.imp_ok && 'ok')}>曝光到 {wan(t.min_impressions)}：{st.reached} / {t.arms.length}</span>
      <span className={cls('vp-ab-rule', st.days_ok && 'ok')}>观察天数：{Math.min(st.days, 99)} / {t.min_days}</span>
      <span className={cls('vp-ab-rule', st.gap_ok && 'ok')}>点击率差距：{st.gap == null ? '-' : pct(st.gap, 0)} / {pct(t.min_gap, 0)}</span>
    </span>
  )
}
