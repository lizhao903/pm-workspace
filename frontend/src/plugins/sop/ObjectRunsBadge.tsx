// 任务详情「SOP」标签名后面的计数和状态点（同项目详情标签的写法）：顶层执行条数；
// 有等你处理的（待确认、失败）时红点，同项目「沟通」标签的待回复；只是还在跑时绿点，同「原型」标签的服务在跑
import { useSopObjectRuns } from '../../core/data'
import type { ObjectSectionProps } from '../../core/plugin'
import { isEnded, isPendingRun } from './model'
import { topRuns } from './taskModel'
import './sop.css'

export default function ObjectRunsBadge({ object }: ObjectSectionProps) {
  const runs = useSopObjectRuns(object.id)
  const rows = topRuns(runs.data ?? [])
  if (!rows.length) return null
  const pending = rows.filter(isPendingRun).length
  const active = rows.filter((r) => !isEnded(r)).length
  return (
    <>
      <span className="seg-n" title={`${rows.length} 次 SOP 执行`}>{rows.length}</span>
      {pending > 0
        ? <span className="side-dot tab-dot" title={`${pending} 次执行等你处理`} />
        : active > 0 && <span className="tab-light" title={`${active} 次执行还没结束`} />}
    </>
  )
}
