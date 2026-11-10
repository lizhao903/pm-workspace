// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 交易页几处共用的小件：页面顶部的提示条内容、没有模拟盘账户时的入口
import { errorText, useCreateTradeAccount } from '../../core/data'
import { Button, EmptyState } from '../../core/ui'

export type TradeNotice = { tone: 'ok' | 'danger'; text: string; detail?: string[]; retry?: () => void } | null

/** 没有模拟盘账户：交易账户页（TRD-07b）还没做，就地建一个默认的模拟盘账户 */
export function NoAccount({ compact }: { compact?: boolean }) {
  const create = useCreateTradeAccount()
  return (
    <EmptyState compact={compact} title="还没有模拟盘账户"
      desc={<>模拟盘只在本地撮合，不连交易所。默认初始资金 100,000 USD、只做数币、手续费万分之 5、滑点 1 跳。{create.error ? <span className="danger-text"> 没建成：{errorText(create.error)}</span> : null}</>}
      action={<Button variant="primary" disabled={create.isPending} onClick={() => create.mutate()}>建一个模拟盘账户</Button>} />
  )
}
