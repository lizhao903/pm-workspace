// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 分类：复用 CategoryManager 的嵌入模式，和侧栏弹窗是同一套逻辑，不分叉。
import { CategoryManagerPanel } from '../../components/CategoryManager'
import { SectionHead } from './common'

export default function CategoriesSection() {
  return (
    <div className="st-sec">
      <SectionHead
        title="分类"
        desc="分类是工作对象的归属维度，按类型各自成一棵树，一个对象只能挂一个分类。左侧切类型，右侧增删改、调整层级与顺序。"
      />
      <div className="st-embed">
        <CategoryManagerPanel />
      </div>
    </div>
  )
}
