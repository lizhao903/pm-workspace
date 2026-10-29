import { EmptyState, PageTitle } from '../../core/ui'
import { TRADE_MODULES } from './modules'

// 交易套件模块的空页面：标题送进顶栏，正文一个空状态
export function EmptyModule({ id }: { id: string }) {
  const m = TRADE_MODULES.find((x) => x.id === id)
  return (
    <section>
      <PageTitle desc={m?.desc}>{m?.label ?? id}</PageTitle>
      <EmptyState title="还没有内容" desc="交易套件只做行情、回测和模拟盘，这一页的功能还在开发" />
    </section>
  )
}
