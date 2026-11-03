import { useState } from 'react'
import type { Contact, Message } from './data'
import type { Project } from './projectdata'
import { STAKE_ROLE } from './projectdata'
import { SearchSelect } from './searchselect'
import {
  ARTIFACT_KIND, DEAL_FLOW, DEAL_STATUS, ORIENT, PLATFORMS, QUOTE_CPM, REPORT_DAYS, avgViews30, localYmd, payState, reportState, videoState,
  type Artifact, type Deal, type DealStatus, type PlatformKey, type Publish, type Review, type Video,
} from './videodata'
import { cls, timeAgo } from './ui'
import { newId } from './ids'
import './videocalendar.css'

// 项目 > 商单：品牌询价转成商单，按状态流转；视频挂到商单上，客户审核意见记进产出物验收，发布满 7 天出结案报告存进文档
// 客户、对接人、决策人都用项目干系人；询价人默认取 IM 消息的发信人

const Pill = ({ s }: { s: DealStatus }) => <span className="pill" style={{ '--c': DEAL_STATUS[s].color } as React.CSSProperties}><span className="pill-dot" />{DEAL_STATUS[s].label}</span>
export const money = (d: Pick<Deal, 'quote' | 'currency'>) => `${d.currency === 'CNY' ? '¥' : '$'}${d.quote.toLocaleString('zh-CN')}`
/** 还在跑的商单：没收款、没丢单 */
export const isOpenDeal = (d: Deal) => d.status !== 'paid' && d.status !== 'lost'

/** 账期一句话 */
export function payText(d: Deal): { text: string; tone: '' | 'warn' | 'danger' } {
  const ps = payState(d)
  if (ps) return { text: ps.days < 0 ? `账期已过 ${-ps.days} 天` : ps.days === 0 ? '今天到账期' : `${ps.days} 天后到账期`, tone: ps.tone }
  if (d.status === 'paid') return { text: '已收款', tone: '' }
  if (d.deadline && isOpenDeal(d) && d.status !== 'delivered') return { text: `${d.deadline} 交付`, tone: '' }
  if (d.pay_due && d.status === 'delivered') return { text: `${d.pay_due} 前收款`, tone: '' }
  return { text: '-', tone: '' }
}

export function DealsTab({ project, deals, videos, selected, onOpen, onNew }: {
  project: Project
  deals: Deal[]
  videos: Video[]
  selected: string | null
  onOpen: (id: string) => void
  onNew: () => void
}) {
  const xs = deals.filter((d) => d.project_id === project.id)
  const [showClosed, setShowClosed] = useState(false)
  const open = xs.filter(isOpenDeal)
  const closed = xs.filter((d) => !isOpenDeal(d))
  const sum = (ys: Deal[]) => ys.filter((d) => d.currency === 'CNY').reduce((s, d) => s + d.quote, 0)
  const due = xs.filter((d) => payState(d))
  const row = (d: Deal) => {
    const pt = payText(d)
    return (
      <div key={d.id} role="button" tabIndex={0} className={cls('deal-row', selected === d.id && 'sel')} onClick={() => onOpen(d.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(d.id)}>
        <span className="deal-main"><span className="deal-title ellipsis">{d.title}</span><span className="list-sub ellipsis">{d.brand} · {d.deliverables || '交付物未填'}</span></span>
        <span><Pill s={d.status} /></span>
        <span className="deal-money">{money(d)}</span>
        <span className={cls('deal-due', pt.tone)}>{pt.text}</span>
        <span className="list-sub ellipsis">{d.video_ids.length ? d.video_ids.map((id) => videos.find((v) => v.id === id)?.title ?? '已删除的视频').join('、') : '还没挂视频'}</span>
      </div>
    )
  }
  return (
    <div className="deal-tab">
      <div className="toolbar">
        <div className="deal-stats" style={{ margin: 0 }}>
          <span>进行中 <b>{open.length}</b></span>
          <span>进行中金额 <b>¥{sum(open).toLocaleString('zh-CN')}</b></span>
          <span>已收款 <b>¥{sum(xs.filter((d) => d.status === 'paid')).toLocaleString('zh-CN')}</b></span>
          {due.length > 0 && <span className="vp-tone-warn">{due.length} 单账期快到了</span>}
        </div>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={onNew}>新建商单</button>
      </div>
      {!xs.length ? (
        <div className="empty">
          <div className="empty-title">这个项目还没有商单</div>
          <div className="list-sub">品牌在 IM 里问报价时，在消息抽屉里点「转为商单」；或者点右上「新建商单」</div>
        </div>
      ) : (
        <div className="deal-list">
          <div className="deal-row deal-th"><span>商单</span><span>状态</span><span>报价</span><span>交付 / 账期</span><span>视频</span></div>
          {open.map(row)}
          {closed.length > 0 && (
            <>
              <button className="deal-row deal-th" style={{ cursor: 'pointer' }} onClick={() => setShowClosed(!showClosed)}>
                <span>{showClosed ? '收起' : '展开'}已收款、丢单的 {closed.length} 单</span>
              </button>
              {showClosed && closed.map(row)}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export type DealDraft = Partial<Deal>

export function DealDrawer({ deal, initial, projects, contacts, videos, publishes, artifacts, message, onClose, onSave, onDelete, onReport, onOpenReport, onOpenVideo, onOpenMessage, onReview }: {
  deal: Deal | null
  /** 新建时预填：从 IM 消息转来的带上项目、询价人、品牌、来源 */
  initial?: DealDraft
  projects: Project[]
  contacts: Contact[]
  videos: Video[]
  publishes: Publish[]
  artifacts: Artifact[]
  /** 来源消息 */
  message?: Message
  onClose: () => void
  onSave: (d: Deal) => void
  onDelete: () => void
  /** 出结案报告：生成一篇文档，回填 report_content_id */
  onReport: (d: Deal) => void
  onOpenReport: (contentId: string) => void
  onOpenVideo: (id: string) => void
  onOpenMessage?: (id: string) => void
  /** 记一条客户审核意见到产出物验收 */
  onReview: (artifactId: string, r: Review) => void
}) {
  const creating = !deal
  const now = new Date().toISOString()
  const [d, setD] = useState<Deal>(() => deal ?? {
    id: newId('deal'), project_id: projects[0]?.id ?? '', brand: '', title: '', platforms: [], deliverables: '', quote: 0, currency: 'CNY', status: 'inquiry',
    video_ids: [], history: [{ status: 'inquiry', at: now }], created_at: now, updated_at: now, ...initial,
  })
  const [tried, setTried] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [rv, setRv] = useState<{ artifact: string; ok: boolean; comment: string; by: string } | null>(null)
  const set = (p: Partial<Deal>) => setD({ ...d, ...p })
  const pj = projects.find((p) => p.id === d.project_id)
  const people = pj ? pj.stakeholders.map((s) => ({ c: contacts.find((c) => c.id === s.contact_id), role: s.role })).filter((x) => x.c) : []
  const contactOpts = [
    ...people.map((x) => ({ value: x.c!.id, label: x.c!.name, hint: `${STAKE_ROLE[x.role].label} · ${x.c!.company}` })),
    ...contacts.filter((c) => !people.some((x) => x.c!.id === c.id)).map((c) => ({ value: c.id, label: c.name, hint: c.company || c.group })),
  ]
  const setStatus = (s: DealStatus) => { if (s !== d.status) set({ status: s, history: [{ status: s, at: new Date().toISOString() }, ...d.history] }) }
  const ref = avgViews30(publishes, d.platforms)
  const refQuote = Math.round((ref.avg / 1000) * QUOTE_CPM / 100) * 100
  const linked = d.video_ids.map((id) => videos.find((v) => v.id === id)).filter((v): v is Video => !!v)
  const candidates = videos.filter((v) => !d.video_ids.includes(v.id))
  const saved = deal ?? d
  const rs = reportState(saved, publishes)
  const reportId = deal?.report_content_id
  const pt = payText(d)
  // 客户审核：挂着的视频的产出物里，外部审核人留下的验收记录
  const linkedArts = artifacts.filter((a) => d.video_ids.includes(a.video_id))
  const clientReviews = linkedArts.flatMap((a) => a.reviews.filter((r) => r.by?.type === 'contact').map((r) => ({ a, r }))).sort((x, y) => y.r.at.localeCompare(x.r.at))
  const reviewable = linkedArts.filter((a) => a.status === 'review' || a.status === 'final' || a.status === 'published')
  const reviewers = people.filter((x) => x.role === 'decider' || x.role === 'contact')
  const errors = [!d.brand.trim() && '品牌必填', !d.title.trim() && '商单名称必填', !d.project_id && '选一个项目', d.status === 'lost' && !d.lost_reason?.trim() && '写一下丢单原因'].filter(Boolean) as string[]
  const save = () => { setTried(true); if (!errors.length) onSave({ ...d, brand: d.brand.trim(), title: d.title.trim(), report_content_id: deal?.report_content_id ?? d.report_content_id, updated_at: new Date().toISOString() }) }
  const lastStep = DEAL_FLOW.indexOf(d.status)

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">{creating ? '新建商单' : '商单'}</span>
        {!creating && <Pill s={deal!.status} />}
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="drawer-body form">
        {message && (
          <div className="deal-src">
            <div>来自 {message.sender_name}{message.conversation ? ` · ${message.conversation}` : ' · 私聊'} · {timeAgo(message.at)}</div>
            <div style={{ color: 'var(--text)', marginTop: 4 }}>{message.text}</div>
            {onOpenMessage && <button className="link-btn" style={{ marginTop: 4 }} onClick={() => onOpenMessage(message.id)}>打开这条消息</button>}
          </div>
        )}
        {pt.tone && <div className={cls('banner', pt.tone === 'danger' ? 'banner-danger' : 'banner-warn')}>{pt.text}：已交付还没收款，记得跟{contacts.find((c) => c.id === d.contact_id)?.name ?? '对方'}确认付款</div>}

        <div className="field-row">
          <label className="field"><span className="field-label">品牌<em>*</em></span>
            <input value={d.brand} className={cls(tried && !d.brand.trim() && 'bad')} placeholder="比如：远川科技" onChange={(e) => set({ brand: e.target.value })} />
          </label>
          <label className="field"><span className="field-label">商单名称<em>*</em></span>
            <input value={d.title} autoFocus={creating} className={cls(tried && !d.title.trim() && 'bad')} placeholder="比如：新品上线短片" onChange={(e) => set({ title: e.target.value })} />
          </label>
        </div>
        <div className="field-row">
          <div className="field"><span className="field-label">项目<em>*</em><span className="field-hint">客户、对接人用项目干系人</span></span>
            <SearchSelect variant="field" value={d.project_id} placeholder="选一个项目" searchPlaceholder="搜项目" aria-label="项目"
              options={projects.map((p) => ({ value: p.id, label: p.name }))} missingLabel={() => '已删除的项目'} onChange={(v) => set({ project_id: v })} />
          </div>
          <div className="field"><span className="field-label">询价人</span>
            <SearchSelect variant="field" value={d.contact_id ?? ''} placeholder="选联系人" searchPlaceholder="搜联系人" aria-label="询价人" noneLabel="不填"
              options={contactOpts} missingLabel={() => '已删除的联系人'} onChange={(v) => set({ contact_id: v || undefined })} />
          </div>
        </div>

        <section className="field-group">
          <div className="field-group-title">状态</div>
          <div className="deal-flow">
            {DEAL_FLOW.map((s, i) => (
              <button key={s} type="button" className={cls('deal-step', d.status === s && 'cur', d.status !== 'lost' && i < lastStep && 'done')} onClick={() => setStatus(s)}>{DEAL_STATUS[s].label}</button>
            ))}
            <button type="button" className={cls('deal-step', d.status === 'lost' && 'lost')} disabled={d.status === 'paid'} onClick={() => setStatus('lost')}>丢单</button>
          </div>
          {d.status === 'lost' && (
            <label className="field"><span className="field-label">丢单原因<em>*</em></span>
              <input value={d.lost_reason ?? ''} className={cls(tried && !d.lost_reason?.trim() && 'bad')} placeholder="比如：预算没批下来" onChange={(e) => set({ lost_reason: e.target.value })} />
            </label>
          )}
          {d.history.length > 1 && <div className="list-sub">{d.history.slice(0, 4).map((h) => `${DEAL_STATUS[h.status].label} ${timeAgo(h.at)}`).join(' · ')}</div>}
        </section>

        <section className="field-group">
          <div className="field-group-title">报价和交付</div>
          <div className="field"><span className="field-label">投放平台</span>
            <div className="seg seg-full">
              {PLATFORMS.map((p) => (
                <button key={p.key} type="button" className={cls(d.platforms.includes(p.key) && 'on')}
                  onClick={() => set({ platforms: d.platforms.includes(p.key) ? d.platforms.filter((x) => x !== p.key) : [...d.platforms, p.key as PlatformKey] })}>{p.label}</button>
              ))}
            </div>
          </div>
          <label className="field"><span className="field-label">交付物</span>
            <textarea rows={2} value={d.deliverables} placeholder="比如：1 支横版 + 1 支竖版 + 置顶评论" onChange={(e) => set({ deliverables: e.target.value })} />
          </label>
          <div className="field-row">
            <label className="field"><span className="field-label">报价</span>
              <input type="number" min={0} step={100} value={d.quote || ''} placeholder="0" onChange={(e) => set({ quote: Math.max(0, Number(e.target.value) || 0) })} />
            </label>
            <label className="field"><span className="field-label">币种</span>
              <select value={d.currency} onChange={(e) => set({ currency: e.target.value as Deal['currency'] })}><option value="CNY">人民币</option><option value="USD">美元</option></select>
            </label>
          </div>
          <div className="deal-ref">
            {ref.n ? (
              <>
                <span>近 30 天 {d.platforms.length ? d.platforms.map((k) => PLATFORMS.find((p) => p.key === k)!.label).join('、') : '各平台'}均播 <b>{ref.avg.toLocaleString('zh-CN')}</b>（{ref.n} 条发布）</span>
                <span>按每千次播放 ¥{QUOTE_CPM} 算，投放价值约 <b>¥{refQuote.toLocaleString('zh-CN')}</b>，制作费另算 {d.currency === 'CNY' && <button type="button" className="link-btn" onClick={() => set({ quote: refQuote })}>填入</button>}</span>
              </>
            ) : <span>近 30 天{d.platforms.length ? '这几个平台' : '各平台'}都没有已发布的数据，报价参考不出来</span>}
          </div>
          <div className="field-row">
            <label className="field"><span className="field-label">交付截止</span><input type="date" value={d.deadline ?? ''} onChange={(e) => set({ deadline: e.target.value || undefined })} /></label>
            <label className="field"><span className="field-label">账期<span className="field-hint">最晚收款日</span></span><input type="date" value={d.pay_due ?? ''} onChange={(e) => set({ pay_due: e.target.value || undefined })} /></label>
          </div>
        </section>

        <section className="field-group">
          <div className="field-group-title">视频<span className="field-hint">挂上的视频会归到这个项目</span></div>
          {linked.length ? (
            <div className="deal-videos">
              {linked.map((v) => (
                <div key={v.id} className="deal-video">
                  <button className="link-btn ellipsis" onClick={() => onOpenVideo(v.id)}>{v.title}</button>
                  <span className="list-sub">{v.orientations.map((o) => ORIENT[o].label).join('、')} · {videoState(v).label}</span>
                  <span className="spacer" />
                  <button className="act act-quiet" onClick={() => set({ video_ids: d.video_ids.filter((x) => x !== v.id) })}>移除</button>
                </div>
              ))}
            </div>
          ) : <div className="io-empty">还没挂视频</div>}
          <SearchSelect value="" placeholder="挂一个视频" searchPlaceholder="搜视频" aria-label="挂一个视频"
            options={[...candidates.filter((v) => v.project_id === d.project_id), ...candidates.filter((v) => v.project_id !== d.project_id)].map((v) => ({ value: v.id, label: v.title, hint: v.project_id === d.project_id ? '本项目' : undefined }))}
            onChange={(v) => v && set({ video_ids: [...d.video_ids, v] })} />
        </section>

        {!creating && (
          <section className="field-group">
            <div className="field-group-title tools-head">
              <span>客户审核<span className="field-hint">记进产出物的验收记录</span></span>
              <span className="spacer" />
              {!rv && reviewable.length > 0 && <button className="act" onClick={() => setRv({ artifact: reviewable[0].id, ok: true, comment: '', by: reviewers[0]?.c!.id ?? d.contact_id ?? '' })}>记一条意见</button>}
            </div>
            {rv && (
              <div className="form" style={{ gap: 8 }}>
                <div className="field-row">
                  <label className="field"><span className="field-label">审的哪个</span>
                    <select value={rv.artifact} onChange={(e) => setRv({ ...rv, artifact: e.target.value })}>
                      {reviewable.map((a) => <option key={a.id} value={a.id}>{videos.find((v) => v.id === a.video_id)?.title} · {ARTIFACT_KIND[a.kind].label}{a.variant ? `（${ORIENT[a.variant].label}）` : ''} v{a.version}</option>)}
                    </select>
                  </label>
                  <label className="field"><span className="field-label">审核人</span>
                    <select value={rv.by} onChange={(e) => setRv({ ...rv, by: e.target.value })}>
                      {(reviewers.length ? reviewers : people).map((x) => <option key={x.c!.id} value={x.c!.id}>{x.c!.name}（{STAKE_ROLE[x.role].label}）</option>)}
                    </select>
                  </label>
                </div>
                <div className="seg">
                  <button type="button" className={cls(rv.ok && 'on')} onClick={() => setRv({ ...rv, ok: true })}>通过</button>
                  <button type="button" className={cls(!rv.ok && 'on')} onClick={() => setRv({ ...rv, ok: false })}>要改</button>
                </div>
                <textarea rows={2} value={rv.comment} placeholder="客户原话" onChange={(e) => setRv({ ...rv, comment: e.target.value })} />
                <div className="act-row">
                  <button className="act act-primary" disabled={!rv.comment.trim() || !rv.by} onClick={() => { onReview(rv.artifact, { at: new Date().toISOString(), ok: rv.ok, comment: rv.comment.trim(), by: { type: 'contact', id: rv.by } }); setRv(null) }}>记下</button>
                  <button className="act act-quiet" onClick={() => setRv(null)}>取消</button>
                </div>
              </div>
            )}
            {clientReviews.length ? (
              <ul className="deal-reviews">
                {clientReviews.map(({ a, r }) => (
                  <li key={`${a.id}${r.at}`}>
                    <span className={r.ok ? 'ok' : 'bad'}>{r.ok ? '通过' : '要改'}</span>
                    <span className="ellipsis">{contacts.find((c) => c.id === r.by?.id)?.name ?? '外部审核人'}：{r.comment || '没写意见'}<span className="list-sub"> · {ARTIFACT_KIND[a.kind].label} v{a.version}</span></span>
                    <span className="spacer" />
                    <time className="list-sub">{timeAgo(r.at)}</time>
                  </li>
                ))}
              </ul>
            ) : !rv && <div className="io-empty">{reviewable.length ? '客户还没留审核意见' : '挂上视频、有了待验收的产出物后，可以记客户的审核意见'}</div>}
          </section>
        )}

        {!creating && (
          <section className="field-group">
            <div className="field-group-title">结案报告<span className="field-hint">发布满 {REPORT_DAYS} 天后出，存进「文档」</span></div>
            {reportId ? (
              <div className="act-row">
                <span className="list-sub">已经出过了</span>
                <button className="act" onClick={() => onOpenReport(reportId)}>打开结案报告</button>
                <button className="act act-quiet" disabled={!rs?.ready} onClick={() => onReport({ ...d, report_content_id: reportId })} title="按最新数据再出一版，覆盖原来那篇">按最新数据重出</button>
              </div>
            ) : !rs ? (
              <div className="io-empty">挂上的视频还没有发出去；发布满 {REPORT_DAYS} 天后可以出结案报告</div>
            ) : !rs.ready ? (
              <div className="io-empty">最早一条发布还差 {rs.left} 天满 {REPORT_DAYS} 天</div>
            ) : (
              <div className="act-row">
                <button className="act act-primary" onClick={() => onReport(d)}>出结案报告</button>
                <span className="list-sub">汇总各平台播放、点赞、评论、转发，写进「文档」</span>
              </div>
            )}
          </section>
        )}
      </div>
      <div className="drawer-foot">
        {confirmDel ? (
          <>
            <span className="danger-text">删除后视频和结案报告保留，只删这条商单</span>
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>取消</button>
            <button className="btn btn-danger" onClick={onDelete}>删除</button>
          </>
        ) : (
          <>
            {!creating && <button className="btn btn-ghost btn-danger-ghost" onClick={() => setConfirmDel(true)}>删除</button>}
            <div className="spacer" />
            {tried && errors.length > 0 && <span className="field-err">{errors[0]}</span>}
            <button className="btn btn-ghost" onClick={onClose}>取消</button>
            <button className="btn btn-primary" onClick={save}>{creating ? '创建' : '保存'}</button>
          </>
        )}
      </div>
    </aside>
  )
}

/** 账期今天要看的：已交付没收款、离账期不到 7 天的 */
export const dueDeals = (deals: Deal[], today = localYmd(new Date())) => deals.filter((d) => payState(d, today))
