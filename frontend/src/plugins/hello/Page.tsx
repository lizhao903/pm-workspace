import { PageTitle } from '../../core/ui'

export default function Page() {
  return (
    <section>
      <PageTitle desc="插件目录 src/plugins/hello">示例插件</PageTitle>
      <p>这个页面来自示例插件 hello：按启用列表加载，独立打包，从启用列表里去掉后菜单和页面一起消失。</p>
    </section>
  )
}
