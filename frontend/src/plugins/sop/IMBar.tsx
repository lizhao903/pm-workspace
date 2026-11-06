// 流程的 IM 触发一行（TSK-0481，SPEC-sop-2.14、SPEC-sop-5.18）：第几个判断、过滤条件、拦截标记。只在触发方式是 IM 时显示，不能在这里改，改到编辑里
import { useConversations, type SopFlow } from '../../core/data'
import { cls } from '../../core/ui'
import { IM, filterText, imOf } from './imtrigger'

export function IMBar({ flow, className }: { flow: Pick<SopFlow, 'trigger' | 'im'>; className?: string }) {
  const convs = useConversations({ enabled: flow.trigger === IM }).data ?? []
  if (flow.trigger !== IM) return null
  const im = imOf(flow)
  return (
    <div className={cls('sop-im-bar', className)}>
      <span className="sop-im-order" title="来一条消息时，IM 流程按这个顺序逐个判断、发起">第 {im.order} 个</span>
      <span className="sop-im-filter ellipsis" title={filterText(im, convs)}>{filterText(im, convs)}</span>
      {im.stop && <span className="sop-im-stop" title="这条流程接住的消息，排在后面的 IM 流程不再处理">拦截后续</span>}
    </div>
  )
}
