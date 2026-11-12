// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 任务详情「流水线」标签名后面的状态点（AUTO-12）：有卡点（等人、失败、超时、超出上限）时红点和个数，只是还在跑时绿点
import { useSopPipeline } from '../../core/data'
import type { ObjectSectionProps } from '../../core/plugin'
import './sop.css'

export default function PipelineBadge({ object }: ObjectSectionProps) {
  const p = useSopPipeline(object.id)
  if (!p.data) return null
  const n = p.data.blockers.length
  const active = p.data.runs.filter((r) => !r.ended_at).length
  if (n > 0) return <><span className="seg-n" title={`${n} 处卡点等你处理`}>{n}</span><span className="side-dot tab-dot" title={`${n} 处卡点等你处理`} /></>
  return active > 0 ? <span className="tab-light" title={`${active} 次执行还没结束`} /> : null
}
