// 视频插件的小部件：阶段进度条、状态胶囊、比例标签、模块标签栏、阶段分布条（照原型 videos.tsx 的 StageBar、VideosTabs、StageDist）
import type { CSSProperties } from 'react'
import { useVideoClips, type Video, type VideoCoverRatio, type VideoOrientation } from '../../core/data'
import { Pill, cls } from '../../core/ui'
import {
  ORIENT, STAGES, STAGE_FILTERS, TONE_COLOR, needsMe, orientText, stageIndex, stageLabel, stageOf, stepState, videoState, type StageFilter,
} from './model'
import { COVER_RATIO } from './artifactModel'

/** 阶段进度：8 段小条，做完的绿、当前的蓝（卡在检查点上的橙） */
export function StageBar({ v }: { v: Video }) {
  const st = videoState(v)
  return (
    <span className="vd-bar" title={`${stageIndex(v.stage) + 1} / ${STAGES.length} · ${st.label}`} aria-hidden="true">
      {STAGES.map((s, i) => {
        const x = stepState(v, i)
        return <i key={s.key} className={cls('vd-seg', x === 'done' && 'vd-seg-done', x === 'current' && (st.tone === 'warn' ? 'vd-seg-warn' : 'vd-seg-cur'))} />
      })}
    </span>
  )
}

export function VideoStatePill({ v }: { v: Video }) {
  const s = videoState(v)
  return <Pill label={s.label} color={TONE_COLOR[s.tone]} />
}

export const OrientShape = ({ o }: { o: VideoOrientation }) => (
  <i className="vd-shape" style={{ aspectRatio: `${ORIENT[o].w} / ${ORIENT[o].h}` } as CSSProperties} aria-hidden="true" />
)

export const OrientTag = ({ o, large }: { o: VideoOrientation; large?: boolean }) => (
  <span className={cls('vd-otag', large && 'vd-otag-lg')} title={orientText(o)}><OrientShape o={o} />{large ? orientText(o) : ORIENT[o].ratio}</span>
)

export type ModuleTab = 'all' | 'review' | 'topics' | 'clips' | 'series' | 'publishes'
const MODULE_TABS: { key: ModuleTab; label: string }[] = [
  { key: 'all', label: '全部视频' }, { key: 'review', label: '待我处理' }, { key: 'topics', label: '选题' }, { key: 'clips', label: '素材收件箱' },
  { key: 'series', label: '系列' }, { key: 'publishes', label: '发布记录' },
]

/** 模块标签栏：放在顶栏下面；「待我处理」后面是停在检查点或被退回的集数，「素材收件箱」后面是待整理的条数，为 0 不显示 */
export function VideosTabs({ active, videos, onSelect }: { active: ModuleTab; videos: Video[]; onSelect: (t: ModuleTab) => void }) {
  const review = videos.filter(needsMe).length
  const todo = (useVideoClips().data ?? []).filter((c) => !c.triaged).length
  return (
    <div className="vd-mtabs" role="tablist" aria-label="视频">
      {MODULE_TABS.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={active === t.key} className={cls(active === t.key && 'on')}
          title={t.key === 'review' && review ? `${review} 集停在检查点或被退回` : t.key === 'clips' && todo ? `${todo} 条素材待整理` : undefined}
          onClick={() => onSelect(t.key)}>
          {t.label}
          {t.key === 'review' && review > 0 && <span className="vd-mtab-n" aria-label={`${review} 集待处理`}>{review}</span>}
          {t.key === 'clips' && todo > 0 && <span className="vd-mtab-n" aria-label={`${todo} 条待整理`}>{todo}</span>}
        </button>
      ))}
    </div>
  )
}

/** 阶段分布条：一眼看出这批视频卡在哪；点一段或一块按这个阶段筛，再点取消。compact 只要上面那条 */
export function StageDist({ videos, value, onChange, compact, still }: {
  videos: Video[]; value: StageFilter; onChange: (s: StageFilter) => void; compact?: boolean
  /** 只看不点：系列卡片里用，整张卡片才是按钮 */
  still?: boolean
}) {
  const n = (k: StageFilter) => videos.filter((v) => stageOf(v) === k).length
  const warn = (k: StageFilter) => videos.some((v) => stageOf(v) === k && needsMe(v))
  const total = videos.length || 1
  const keys = STAGE_FILTERS.filter((k) => n(k) > 0)
  return (
    <div className="vd-dist">
      <div className="vd-dist-bar">
        {still && keys.map((k) => (
          <span key={k} className={cls('vd-dist-seg', `vd-ds-${k === 'done' ? 'done' : warn(k) ? 'warn' : 'cur'}`)} style={{ flexGrow: n(k) / total }}
            title={`${stageLabel(k)} ${n(k)} 集`} />
        ))}
        {!still && keys.map((k) => (
          <button key={k} type="button" className={cls('vd-dist-seg', `vd-ds-${k === 'done' ? 'done' : warn(k) ? 'warn' : 'cur'}`, value === k && 'on')}
            style={{ flexGrow: n(k) / total }} title={`${stageLabel(k)} ${n(k)} 集`} aria-label={`${stageLabel(k)} ${n(k)} 集`}
            tabIndex={compact ? undefined : -1} onClick={() => onChange(value === k ? '' : k)} />
        ))}
      </div>
      {!compact && !still && (
        <div className="vd-dist-legend">
          {keys.map((k) => (
            <button key={k} type="button" aria-pressed={value === k} className={cls('vd-dist-chip', value === k && 'on', warn(k) && 'warn')}
              onClick={() => onChange(value === k ? '' : k)}>
              {stageLabel(k)}<b>{n(k)}</b>
            </button>
          ))}
          {value && <button type="button" className="vd-link" onClick={() => onChange('')}>清除</button>}
        </div>
      )}
    </div>
  )
}

export const IconPlus = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
)

/** 封面色块：按封面比例画，色调跟着第几版走 */
export const CoverThumb = ({ r, op, big }: { r: VideoCoverRatio; op: number; big?: boolean }) => (
  <span className={cls('vd-thumb', big && 'vd-thumb-big')} aria-hidden="true"
    style={{ aspectRatio: `${COVER_RATIO[r].w} / ${COVER_RATIO[r].h}`, '--h': COVER_HUE[(op - 1) % COVER_HUE.length] } as CSSProperties}>{op}</span>
)
const COVER_HUE = [24, 205, 145, 275, 340]

export const IconCheckSmall = () => (
  <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
    <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
