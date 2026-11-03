import { PageTitle } from '../ui'

// 模块还没做时的占位页；标题送进顶栏，没有顶栏时原地显示
export function Placeholder({ title }: { title: string }) {
  return (
    <section className="shell-placeholder">
      <PageTitle>{title}</PageTitle>
      <p>待开发</p>
    </section>
  )
}
