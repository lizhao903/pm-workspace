// 设置里的「运行异常」（PR-20，走查 A-09）。异常的记录和处理还没有后端（SPEC-settings-18、19），
// 今日和任务来源都会跳到这里，所以菜单留着，先写明还没有记录，不显示「待开发」。
import { EmptyState, PageTitle } from '../../../core/ui'

export function IncidentsSection() {
  return (
    <div>
      <PageTitle parent="设置" desc="系统运行中出的问题，同一个问题合并记次数；能转成研发任务去优化">运行异常</PageTitle>
      <EmptyState title="还没有运行异常记录" desc="连接器、模型服务商、Webhook、SOP、原型和页面本身出的问题都会记在这里" />
    </div>
  )
}
