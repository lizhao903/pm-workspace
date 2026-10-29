// 商单抽屉（SPEC-videos-16.4 到 16.13，照原型 web-next/src/videodeals.tsx 的 DealDrawer）：来源消息、账期提示、品牌名称项目询价人、
// 状态流转、报价和交付（报价参考读后端快照）、挂视频、结案报告。改草稿、点「创建」「保存」才写，关掉时有未保存提示。
// 客户审核意见（SPEC-videos-16.10）要产出物验收记录带外部审核人，后端还没有这个字段，这一节先不做
import { useState } from 'react'
import { useNavigate } from 'react-router'
import {
  errorText, useContacts, useCreateDeal, useDealReport, useDeleteDeal, useImMessage, useImMessages, usePatchDeal, usePlugins,
  useProjectStakeholders, useProjects, useVideoQuoteRef, PROJECT_ROLES, type ImMessage, type Video, type VideoDeal,
} from '../../core/data'
import { Button, ConfirmDialog, Drawer, Field, Input, Pill, SearchSelect, Select, Textarea, cls } from '../../core/ui'
import {
  CURRENCIES, DEAL_FLOW, DEAL_STATUS, REPORT_DAYS, createBody, dealErrors, dealPatch, draftOf, historyLine, payText, quoteFill, type DealDraft,
} from './dealModel'
import { ORIENT, timeAgo, videoState } from './model'
import { PLATFORMS } from './topicModel'
import './deals.css'

const IM_PLUGIN = 'im'

export function DealDrawer({ deal, initial, videos, onClose, onCreated }: {
  /** null 是新建 */
  deal: VideoDeal | null
  /** 新建时预填：项目、从 IM 消息转来的询价人、品牌、来源 */
  initial?: Partial<DealDraft>
  videos: Video[]
  onClose: () => void
  /** 新建成功，抽屉换成这一单 */
  onCreated: (d: VideoDeal) => void
}) {
  const navigate = useNavigate()
  const creating = !deal
  const create = useCreateDeal()
  const patch = usePatchDeal()
  const del = useDeleteDeal()
  const report = useDealReport()
  const projects = useProjects()
  const contacts = useContacts()
  const plugins = usePlugins()
  const imOn = !!plugins.data?.find((p) => p.id === IM_PLUGIN)?.running
  const [d, setD] = useState<DealDraft>(() => draftOf(deal, initial))
  const [tried, setTried] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [saved, setSaved] = useState(false)
  const stakes = useProjectStakeholders(d.project_id || null)
  const ref = useVideoQuoteRef(d.platforms)

  const set = (x: Partial<DealDraft>) => { setSaved(false); setD({ ...d, ...x }) }
  const errors = dealErrors(d, deal)
  const changes = deal ? dealPatch(deal, d) : null
  const dirty = creating ? !!(d.brand.trim() || d.title.trim() || d.deliverables.trim() || d.quote || d.video_ids.length) : Object.keys(changes!).length > 0
  const busy = create.isPending || patch.isPending || del.isPending || report.isPending
  const failed = create.error ?? patch.error ?? del.error ?? report.error
  const clear = () => { create.reset(); patch.reset(); del.reset(); report.reset() }

  const allContacts = contacts.data ?? []
  const people = (stakes.data ?? []).map((s) => ({ s, c: allContacts.find((c) => c.id === s.stakeholder_id) })).filter((x) => !!x.c)
  const roleLabel = (r: string) => PROJECT_ROLES.find((x) => x.key === r)?.label ?? r
  const contactOpts = [
    ...people.map(({ s, c }) => ({ value: c!.id, label: c!.name, hint: [roleLabel(s.role), c!.company].filter(Boolean).join(' · '), group: '项目干系人' })),
    ...allContacts.filter((c) => !people.some((x) => x.c!.id === c.id)).map((c) => ({ value: c.id, label: c.name, hint: c.company || c.group || undefined, group: '其他联系人' })),
  ]
  const contactName = allContacts.find((c) => c.id === d.contact_id)?.name
  const linked = d.video_ids.map((id) => ({ id, v: videos.find((v) => v.id === id) }))
  const candidates = videos.filter((v) => !d.video_ids.includes(v.id))
  const videoOpts = [...candidates.filter((v) => v.project_id === d.project_id), ...candidates.filter((v) => v.project_id !== d.project_id)]
    .map((v) => ({ value: v.id, label: v.title || '未命名视频', hint: v.project_id === d.project_id ? '本项目' : undefined }))
  const pt = payText({ status: deal?.status ?? d.status, pay_due: deal?.pay_due, deadline: deal?.deadline })
  const lastStep = DEAL_FLOW.indexOf(d.status)
  const rs = deal?.report_state
  const reportId = deal?.report_content_id

  const save = () => {
    if (busy) return
    setTried(true)
    if (errors.length) return
    clear()
    if (!deal) {
      create.mutate(createBody(d), { onSuccess: (x) => onCreated(x) })
      return
    }
    if (!dirty) return
    patch.mutate({ id: deal.id, patch: changes! }, { onSuccess: (x) => { setD(draftOf(x)); setTried(false); setSaved(true) } })
  }
  const onDelete = () => {
    if (!deal || busy) return
    clear()
    del.mutate(deal.id, { onSuccess: () => { setConfirmDel(false); onClose() }, onError: () => setConfirmDel(false) })
  }
  const onReport = () => {
    if (!deal || busy) return
    clear()
    report.mutate(deal.id)
  }
  const openDoc = (id: string) => navigate(`/docs?doc=${encodeURIComponent(id)}`)
  // 从 IM 消息带：询价人是发信人认上的联系人，品牌取他的公司（品牌还空着时）
  const fromMessage = (m: ImMessage) => {
    const c = allContacts.find((x) => x.id === m.stakeholder_id)
    set({ source_message_id: m.id, contact_id: c?.id ?? d.contact_id, brand: d.brand.trim() || c?.company || '' })
  }

  return (
    <Drawer open onClose={onClose} kicker={creating ? '新建商单' : '商单'} aria-label={creating ? '新建商单' : deal.title} className="dl-drawer"
      headActions={deal && <Pill label={DEAL_STATUS[deal.status].label} color={DEAL_STATUS[deal.status].color} />}
      dirty={dirty} dirtyMessage="关闭后，这次改的商单内容不会保存。"
      footer={(requestClose) => (
        <>
          {deal && <Button size="sm" variant="danger-ghost" disabled={busy} onClick={() => setConfirmDel(true)}>删除</Button>}
          <span className="spacer" />
          {tried && errors.length > 0 && <span className="field-err" role="alert">{errors[0]}</span>}
          {saved && !dirty && <span className="dl-saved" role="status">已保存</span>}
          <Button onClick={requestClose}>{creating ? '取消' : '关闭'}</Button>
          <Button variant="primary" disabled={busy || (!creating && !dirty)} onClick={save}>{creating ? '创建' : '保存'}</Button>
        </>
      )}>
      <form className="dl-form" onSubmit={(e) => { e.preventDefault(); save() }}>
        {failed && <div className="dl-err" role="alert">{errorText(failed)}</div>}
        {d.source_message_id && (imOn ? <SourceMessage id={d.source_message_id} onOpen={(id) => navigate(`/messages?m=${encodeURIComponent(id)}`)} />
          : <div className="dl-src">来自一条 IM 消息（IM 插件没在跑，看不到原文）</div>)}
        {creating && imOn && !d.source_message_id && <MessagePick onPick={fromMessage} />}
        {pt.tone && (
          <div className={cls('dl-banner', pt.tone === 'danger' && 'danger')} role="status">
            {pt.text}：已交付还没收款，记得跟{contactName ?? '对方'}确认付款
          </div>
        )}

        <div className="field-row">
          <Field label="品牌" required>
            <Input value={d.brand} invalid={tried && !d.brand.trim()} maxLength={100} placeholder="比如：远川科技" onChange={(e) => set({ brand: e.target.value })} />
          </Field>
          <Field label="商单名称" required>
            <Input value={d.title} autoFocus={creating} invalid={tried && !d.title.trim()} maxLength={200} placeholder="比如：新品上线短片"
              onChange={(e) => set({ title: e.target.value })} />
          </Field>
        </div>
        <div className="field-row">
          <Field label="项目" required hint="客户、对接人用项目干系人" wrap={false}>
            <SearchSelect variant="field" value={d.project_id} placeholder="选一个项目" searchPlaceholder="搜项目" aria-label="项目"
              missingLabel={() => '已删除的项目'} options={(projects.data?.data ?? []).map((p) => ({ value: p.id, label: p.title || '未命名项目' }))}
              onChange={(v) => set({ project_id: v })} />
          </Field>
          <Field label="询价人" wrap={false}>
            <SearchSelect variant="field" value={d.contact_id} placeholder="选联系人" searchPlaceholder="搜联系人" aria-label="询价人" noneLabel="不填"
              missingLabel={() => '已删除的联系人'} options={contactOpts} onChange={(v) => set({ contact_id: v })} />
          </Field>
        </div>

        <section className="dl-group" aria-label="状态">
          <div className="dl-group-title">状态</div>
          <div className="dl-flow" role="group" aria-label="商单状态">
            {DEAL_FLOW.map((s, i) => (
              <button key={s} type="button" aria-pressed={d.status === s}
                className={cls('dl-step', d.status === s && 'cur', d.status !== 'lost' && i < lastStep && 'done')}
                onClick={() => set({ status: s })}>{DEAL_STATUS[s].label}</button>
            ))}
            <button type="button" aria-pressed={d.status === 'lost'} className={cls('dl-step', d.status === 'lost' && 'lost')}
              disabled={deal?.status === 'paid'} title={deal?.status === 'paid' ? '已收款的商单不能丢单' : undefined}
              onClick={() => set({ status: 'lost' })}>丢单</button>
          </div>
          {d.status === 'lost' && (
            <Field label="丢单原因" required>
              <Input value={d.lost_reason} invalid={tried && !d.lost_reason.trim()} maxLength={500} placeholder="比如：预算没批下来"
                onChange={(e) => set({ lost_reason: e.target.value })} />
            </Field>
          )}
          {deal && deal.history.length > 1 && <div className="dl-muted">{historyLine(deal.history, (iso) => timeAgo(iso))}</div>}
        </section>

        <section className="dl-group" aria-label="报价和交付">
          <div className="dl-group-title">报价和交付</div>
          <Field label="投放平台" wrap={false}>
            <div className="dl-chips" role="group" aria-label="投放平台">
              {PLATFORMS.map((p) => (
                <button key={p.key} type="button" aria-pressed={d.platforms.includes(p.key)} className={cls('chip', d.platforms.includes(p.key) && 'chip-on')}
                  onClick={() => set({ platforms: d.platforms.includes(p.key) ? d.platforms.filter((x) => x !== p.key) : PLATFORMS.map((x) => x.key).filter((k) => k === p.key || d.platforms.includes(k)) })}>
                  {p.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="交付物">
            <Textarea rows={2} value={d.deliverables} maxLength={2000} placeholder="比如：1 支横版 + 1 支竖版 + 置顶评论" onChange={(e) => set({ deliverables: e.target.value })} />
          </Field>
          <div className="field-row">
            <Field label="报价">
              <Input type="number" min={0} step={100} value={d.quote || ''} placeholder="0"
                onChange={(e) => set({ quote: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
            </Field>
            <Field label="币种">
              <Select value={d.currency} options={CURRENCIES} onValueChange={(v) => set({ currency: v as DealDraft['currency'] })} />
            </Field>
          </div>
          <div className="dl-ref" aria-label="报价参考">
            {ref.isError ? <span>报价参考没取到：{errorText(ref.error)}</span>
              : !ref.data ? <span>报价参考取数中…</span>
                : ref.data.n ? (
                  <>
                    <span>近 30 天 {d.platforms.length ? d.platforms.map((k) => PLATFORMS.find((p) => p.key === k)?.label ?? k).join('、') : '各平台'}均播 <b>{ref.data.avg.toLocaleString('zh-CN')}</b>（{ref.data.n} 条发布）</span>
                    <span>
                      按每千次播放 ¥{ref.data.cpm} 算，投放价值约 <b>¥{ref.data.value.toLocaleString('zh-CN')}</b>，制作费另算
                      {d.currency === 'CNY' && <button type="button" className="dl-link dl-fill" onClick={() => set({ quote: quoteFill(ref.data.value) })}>填入</button>}
                    </span>
                  </>
                ) : <span>近 30 天{d.platforms.length ? '这几个平台' : '各平台'}都没有已发布的数据，报价参考不出来</span>}
          </div>
          <div className="field-row">
            <Field label="交付截止"><Input type="date" value={d.deadline} onChange={(e) => set({ deadline: e.target.value })} /></Field>
            <Field label="账期" hint="最晚收款日"><Input type="date" value={d.pay_due} onChange={(e) => set({ pay_due: e.target.value })} /></Field>
          </div>
        </section>

        <section className="dl-group" aria-label="视频">
          <div className="dl-group-title">视频<span className="dl-hint">挂上的视频没有项目时归到这个项目</span></div>
          {linked.length ? (
            <div className="dl-videos">
              {linked.map(({ id, v }) => (
                <div key={id} className="dl-video">
                  {v ? <button type="button" className="dl-link ellipsis" onClick={() => navigate(`/videos/v/${encodeURIComponent(id)}`)}>{v.title || '未命名视频'}</button>
                    : <span className="dl-muted">已删除的视频</span>}
                  {v && <span className="dl-muted">{v.orientations.map((o) => ORIENT[o].label).join('、')}{v.orientations.length ? ' · ' : ''}{videoState(v).label}</span>}
                  <span className="spacer" />
                  <Button size="sm" variant="ghost" onClick={() => set({ video_ids: d.video_ids.filter((x) => x !== id) })}>移除</Button>
                </div>
              ))}
            </div>
          ) : <div className="dl-empty">还没挂视频</div>}
          <SearchSelect value="" placeholder="挂一个视频" searchPlaceholder="搜视频" aria-label="挂一个视频" options={videoOpts}
            onChange={(v) => v && set({ video_ids: [...d.video_ids, v] })} />
        </section>

        {deal && (
          <section className="dl-group" aria-label="结案报告">
            <div className="dl-group-title">结案报告<span className="dl-hint">发布满 {REPORT_DAYS} 天后出，存进「文档」</span></div>
            {reportId ? (
              <div className="dl-act-row">
                <span className="dl-muted">已经出过了</span>
                <Button size="sm" variant="outline" onClick={() => openDoc(reportId)}>打开结案报告</Button>
                <Button size="sm" variant="ghost" disabled={busy || !rs?.ready} title="按最新数据再出一篇，原来那篇留在文档里" onClick={onReport}>按最新数据重出</Button>
              </div>
            ) : !rs ? (
              <div className="dl-empty">挂上的视频还没有发出去；发布满 {REPORT_DAYS} 天后可以出结案报告</div>
            ) : !rs.ready ? (
              <div className="dl-empty">最早一条发布还差 {rs.left} 天满 {REPORT_DAYS} 天</div>
            ) : (
              <div className="dl-act-row">
                <Button size="sm" variant="primary" disabled={busy || dirty} title={dirty ? '先保存改动' : undefined} onClick={onReport}>出结案报告</Button>
                <span className="dl-muted">汇总各平台播放、点赞、评论、转发，写进「文档」</span>
              </div>
            )}
            {report.isSuccess && <div className="dl-muted" role="status">已生成 {report.data.doc.ref} {report.data.doc.title}</div>}
          </section>
        )}
        <button type="submit" hidden />
      </form>

      <ConfirmDialog open={confirmDel} danger title={`删除商单「${deal?.title ?? ''}」？`} confirmLabel="删除" busy={busy}
        impacts={['删除后视频和结案报告保留，只删这条商单']} onCancel={() => setConfirmDel(false)} onConfirm={onDelete} />
    </Drawer>
  )
}

/** 来源消息（SPEC-videos-16.4）：发信人、会话、时间、原话，「打开这条消息」 */
function SourceMessage({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const m = useImMessage(id)
  if (m.isPending) return <div className="dl-src">来源消息加载中…</div>
  if (!m.data) return <div className="dl-src">来自一条 IM 消息（已经删除或没取到）</div>
  const x = m.data
  return (
    <div className="dl-src" aria-label="来源消息">
      <div>来自 {x.contact_name || x.sender_name}{x.conversation ? ` · ${x.conversation}` : ' · 私聊'} · {timeAgo(x.at)}</div>
      <div className="dl-src-text">{x.text}</div>
      <button type="button" className="dl-link" onClick={() => onOpen(x.id)}>打开这条消息</button>
    </div>
  )
}

/** 新建时从一条 IM 询价带出询价人、品牌、来源（同原型消息抽屉「转为商单」） */
function MessagePick({ onPick }: { onPick: (m: ImMessage) => void }) {
  const msgs = useImMessages()
  const rows = [...(msgs.data ?? [])].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200)
  if (!rows.length) return null
  return (
    <Field label="从 IM 询价带出" hint="询价人、品牌按这条消息预填，商单记下来源" wrap={false}>
      <SearchSelect variant="field" value="" placeholder="选一条 IM 消息（可不选）" searchPlaceholder="搜发信人、内容" aria-label="来源消息"
        options={rows.map((m) => ({ value: m.id, label: `${m.contact_name || m.sender_name}：${m.text.slice(0, 60) || '（没有文字）'}`, hint: m.conversation || '私聊' }))}
        onChange={(v) => { const m = rows.find((x) => x.id === v); if (m) onPick(m) }} />
    </Field>
  )
}
