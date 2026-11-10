// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 选题和素材的小部件：状态胶囊、优先级分、素材类型（照原型 topics.tsx 的 StatusPill、PriorityBadge、KindTag）
import type { CSSProperties } from 'react'
import type { VideoClipKind, VideoTopicScore, VideoTopicStatus } from '../../core/data'
import { Pill, cls } from '../../core/ui'
import { CLIP_KIND, TOPIC_STATUS, prioTone, topicPriority } from './topicModel'

export const StatusPill = ({ s }: { s: VideoTopicStatus }) => <Pill label={TOPIC_STATUS[s].label} color={TOPIC_STATUS[s].color} title={TOPIC_STATUS[s].desc} />

export function PriorityBadge({ score }: { score: VideoTopicScore }) {
  const p = topicPriority(score)
  return <span className={cls('tp-prio', prioTone(p))} title="按需求度、契合度、制作成本算出的优先级，满分 10">{p.toFixed(1)}</span>
}

export const KindTag = ({ k }: { k: VideoClipKind }) => (
  <span className="tp-kind" style={{ '--c': CLIP_KIND[k].color } as CSSProperties}>{CLIP_KIND[k].label}</span>
)
