// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 今日卡片（VID-07b，video-creator-analysis.md P0-1）：视频待验收、视频待发布、视频发布失败，数据来自后端 VID-07a（internal/plugins/video/today.go）。
// 每条带 link（/videos/v/<id> 起），点了直接跳到视频详情、产出物抽屉或发布记录；文案里的阶段、平台名也是后端给的。
// 插件入口直接引它，所以不引 core/ui：入口测试跑在 node 环境，core/ui 加载时要用 window
import { Link } from 'react-router'
import { CARD_SHOW, platformText, scheduleText, type CardData, type TodayPublish, type TodayWaiting } from './todayModel'
import './today.css'

function Total({ n }: { n: number }) {
  return <div className="today-card-total">共 {n} 条</div>
}

function Line({ to, tone, title, sub, tag }: { to: string; tone: 'warn' | 'danger' | 'info'; title: string; sub: string; tag?: string }) {
  return (
    <Link to={to} className="today-line vt-line">
      <span className={`vt-dot ${tone}`} aria-hidden="true" />
      <span className="ellipsis vt-title">{title}</span>
      <span className="ellipsis vt-sub">{sub}</span>
      {tag && <span className={`vt-tag ${tone}`}>{tag}</span>}
    </Link>
  )
}

/** 视频待验收：检查点待验收或被退回、产出物待验收；退回的标红，点了去视频详情或产出物抽屉 */
export function WaitingCard({ data }: { data: CardData<TodayWaiting> }) {
  if (!data) return null
  return (
    <>
      <Total n={data.total} />
      {data.items.slice(0, CARD_SHOW).map((x) => {
        const rejected = x.kind === 'checkpoint' && x.state === 'rejected'
        const sub = x.kind === 'artifact' ? [x.artifact_name, x.version && `v${x.version}`].filter(Boolean).join(' ') : rejected ? x.note || x.stage_label || '' : ''
        return <Line key={`${x.kind}:${x.artifact_id ?? x.video_id}`} to={x.link} tone={rejected ? 'danger' : 'warn'} title={x.video_title} sub={sub} tag={x.label} />
      })}
    </>
  )
}

/** 视频待发布：24 小时内定时的，已过点还没发出去的标红；点了去视频详情打开这条发布 */
export function ScheduledCard({ data }: { data: CardData<TodayPublish> }) {
  if (!data) return null
  return (
    <>
      <Total n={data.total} />
      {data.items.slice(0, CARD_SHOW).map((x) => {
        const s = scheduleText(x.scheduled_at)
        return <Line key={x.id} to={x.link} tone={s.late ? 'danger' : 'info'} title={x.video_title || x.title} sub={platformText(x)} tag={s.text} />
      })}
    </>
  )
}

/** 视频发布失败：副标题是平台和失败原因；点了去视频详情打开这条发布 */
export function FailedCard({ data }: { data: CardData<TodayPublish> }) {
  if (!data) return null
  return (
    <>
      <Total n={data.total} />
      {data.items.slice(0, CARD_SHOW).map((x) => (
        <Line key={x.id} to={x.link} tone="danger" title={x.video_title || x.title} sub={[platformText(x), x.error].filter(Boolean).join('：')} />
      ))}
    </>
  )
}
