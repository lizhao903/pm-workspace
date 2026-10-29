// 项目详情的「商单」标签（SPEC-videos-16.1 到 16.3、16.15，照原型 web-next/src/videodeals.tsx 的 DealsTab）。
// 经 core/plugin 的 projectTabs 登记，项目插件只负责摆标签。抽屉用查询参数：?deal=<id> 打开一单（今日卡片跳过来也是它），
// ?new=1 新建，带 &message=<IM 消息 id> 时按这条消息预填询价人、品牌（IM 消息抽屉「转为商单」跳过来，VID-08e）。
// 新建的单挂到了别的项目时跳到那个项目的「商单」标签（SPEC-videos-16.12）
import { useNavigate, useSearchParams } from 'react-router'
import { useState } from 'react'
import { errorText, useContacts, useImMessage, useVideoDeals, useVideos, type Video, type VideoDeal } from '../../core/data'
import { Button, EmptyState, ErrorState, LoadingState, Pill, cls } from '../../core/ui'
import { DealDrawer } from './DealDrawer'
import { DEAL_STATUS, dealStats, money, payText, splitDeals } from './dealModel'
import './deals.css'

export default function DealsTab({ projectId }: { projectId: string }) {
  const deals = useVideoDeals()
  const videos = useVideos()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [showClosed, setShowClosed] = useState(false)
  const openId = params.get('deal')
  const creating = params.get('new') === '1'
  const message = params.get('message') ?? ''

  const setQuery = (next: Record<string, string>) => setParams(next, { replace: true })
  const open = (id: string) => setQuery({ deal: id })
  const close = () => setQuery({})
  const created = (d: VideoDeal) => {
    if (d.project_id === projectId) open(d.id)
    else navigate(`/projects/${encodeURIComponent(d.project_id)}/deals?deal=${encodeURIComponent(d.id)}`, { replace: true })
  }

  if (deals.isPending) return <LoadingState />
  if (deals.isError) return <ErrorState title="商单没加载出来" error={errorText(deals.error)} onRetry={() => void deals.refetch()} />
  const xs = deals.data.filter((d) => d.project_id === projectId)
  const st = dealStats(xs)
  const { open: running, closed } = splitDeals(xs)
  const vs = videos.data ?? []
  const current = openId ? deals.data.find((d) => d.id === openId) ?? null : null

  const row = (d: VideoDeal) => {
    const pt = payText(d)
    return (
      <div key={d.id} role="button" tabIndex={0} className={cls('dl-row', openId === d.id && 'sel')} aria-label={d.title}
        onClick={() => open(d.id)} onKeyDown={(e) => { if (e.key === 'Enter') open(d.id) }}>
        <span className="dl-main"><span className="dl-title ellipsis">{d.title}</span><span className="dl-muted ellipsis">{d.brand} · {d.deliverables || '交付物未填'}</span></span>
        <span><Pill label={DEAL_STATUS[d.status].label} color={DEAL_STATUS[d.status].color} /></span>
        <span className="dl-money">{money(d)}</span>
        <span className={cls('dl-due', pt.tone)}>{pt.text}</span>
        <span className="dl-muted ellipsis dl-vids">
          {d.video_ids.length ? d.video_ids.map((id) => vs.find((v) => v.id === id)?.title ?? '已删除的视频').join('、') : '还没挂视频'}
        </span>
      </div>
    )
  }

  return (
    <div className="dl-tab">
      <div className="dl-toolbar">
        <div className="dl-stats">
          <span>进行中 <b>{st.open}</b></span>
          <span>进行中金额 <b>¥{st.openSum.toLocaleString('zh-CN')}</b></span>
          <span>已收款 <b>¥{st.paidSum.toLocaleString('zh-CN')}</b></span>
          {st.due > 0 && <span className="dl-warn">{st.due} 单账期快到了</span>}
        </div>
        <span className="spacer" />
        <Button variant="primary" onClick={() => setQuery({ new: '1' })}>新建商单</Button>
      </div>
      {!xs.length ? (
        <EmptyState title="这个项目还没有商单" desc="品牌在 IM 里问报价时，新建商单可以从那条消息带出询价人和品牌；或者点右上「新建商单」" />
      ) : (
        <div className="dl-list" role="list" aria-label="商单">
          <div className="dl-row dl-th" aria-hidden="true"><span>商单</span><span>状态</span><span>报价</span><span>交付 / 账期</span><span className="dl-vids">视频</span></div>
          {running.map(row)}
          {closed.length > 0 && (
            <>
              <button type="button" className="dl-row dl-th dl-more" onClick={() => setShowClosed(!showClosed)}>
                <span>{showClosed ? '收起' : '展开'}已收款、丢单的 {closed.length} 单</span>
              </button>
              {showClosed && closed.map(row)}
            </>
          )}
        </div>
      )}
      {creating && (
        <NewDeal key={`new-${message}`} projectId={projectId} message={message} videos={vs} onClose={close} onCreated={created} />
      )}
      {!creating && current && <DealDrawer key={current.id} deal={current} videos={vs} onClose={close} onCreated={created} />}
      {!creating && openId && !current && (
        <div className="dl-gone" role="status">这条商单不存在或已删除 <Button size="sm" onClick={close}>知道了</Button></div>
      )}
    </div>
  )
}

/** 新建抽屉；带来源消息时先取消息和联系人，询价人是发信人认上的联系人，品牌取他的公司。取不到（IM 没在跑、消息删了）就只记来源 */
function NewDeal({ projectId, message, videos, onClose, onCreated }: {
  projectId: string; message: string; videos: Video[]; onClose: () => void; onCreated: (d: VideoDeal) => void
}) {
  const m = useImMessage(message || null)
  const contacts = useContacts()
  if (message && (m.isPending || contacts.isPending)) return null
  const c = m.data?.stakeholder_id ? contacts.data?.find((x) => x.id === m.data!.stakeholder_id) : undefined
  return (
    <DealDrawer deal={null} videos={videos} onClose={onClose} onCreated={onCreated}
      initial={{ project_id: projectId, source_message_id: message, contact_id: c?.id ?? '', brand: c?.company ?? '' }} />
  )
}
