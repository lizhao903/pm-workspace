import { EmptyState, PageTitle } from '../../core/ui'

export default function Page() {
  return (
    <section>
      <PageTitle>项目</PageTitle>
      <EmptyState title="还没有项目" desc="项目插件已启用，项目列表还在开发中。" />
    </section>
  )
}
