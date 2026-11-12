// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 今日卡片「商单账期」（video_deal_due，SPEC-videos-16.14）：已交付没收款、离账期不到 7 天或已过的单，点一条跳到项目的「商单」标签打开它
// 插件入口直接引它，所以不引 core/ui：入口测试跑在 node 环境，core/ui 加载时要用 window
import { Link } from 'react-router'
import './deals.css'

export type DealDueItem = { id: string; title: string; sub: string; tone: 'warn' | 'danger'; link: string }

export function DealDueCard({ data }: { data: { total: number; items: DealDueItem[] } | undefined }) {
  if (!data) return null
  return (
    <>
      <div className="today-card-total">共 {data.total} 单</div>
      {data.items.slice(0, 5).map((x) => (
        <Link key={x.id} to={x.link} className="today-line dl-due-line">
          <span className={`dl-due-dot ${x.tone}`} aria-hidden="true" />
          <span className="ellipsis dl-due-title">{x.title}</span>
          <span className="dl-muted ellipsis dl-due-sub">{x.sub}</span>
        </Link>
      ))}
    </>
  )
}
