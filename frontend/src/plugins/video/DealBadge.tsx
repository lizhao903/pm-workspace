// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 项目「商单」标签上的红点（SPEC-videos-16.1）：这个项目有账期快到的单
import { useVideoDeals } from '../../core/data'
import { payState } from './dealModel'

export function DealsTabBadge({ projectId }: { projectId: string }) {
  const deals = useVideoDeals()
  const n = (deals.data ?? []).filter((d) => d.project_id === projectId && payState(d)).length
  return n ? <span className="dl-dot" aria-label={`${n} 单账期快到了`} /> : null
}
