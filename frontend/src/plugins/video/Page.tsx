import { EmptyState, PageTitle } from '../../core/ui'

// 视频模块的空页面：标题送进顶栏，正文一个空状态
export default function Page() {
  return (
    <section>
      <PageTitle desc="视频制作流程、产出物、系列和多平台发布">视频</PageTitle>
      <EmptyState title="还没有内容" desc="视频列表、制作流程和发布记录的页面还在开发" />
    </section>
  )
}
