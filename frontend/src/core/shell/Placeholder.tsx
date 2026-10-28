// 模块还没做时的占位页
export function Placeholder({ title }: { title: string }) {
  return (
    <section className="shell-placeholder">
      <h1>{title}</h1>
      <p>待开发</p>
    </section>
  )
}
