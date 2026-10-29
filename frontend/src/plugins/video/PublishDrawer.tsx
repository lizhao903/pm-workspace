// 发布记录抽屉（SPEC-videos-9，照原型 videopublish.tsx 的 PublishDrawer）：状态、去向、简介、数据和按天曲线。
// 失败的能重试，没发出去的能换封面；接通上传接口的平台「改为立即发布」，其余「填链接，标为已发布」（规格 9.6）；
// 已发布的能回填（存一条手动快照，不覆盖）、从连接器拉取、打开链接
import { useState } from 'react'
import {
  errorText, useDeletePublish, usePatchPublish, usePublishSnapshots, useSyncPublish,
  type VideoAccount, type VideoArtifact, type VideoCoverTest, type VideoMetricSnapshot, type VideoPlatformInfo, type VideoPublish, type Video,
} from '../../core/data'
import { Button, Drawer, Input, cls } from '../../core/ui'
import { COVER_RATIO, coverRatioOf } from './artifactModel'
import { ORIENT, timeAgo } from './model'
import { CoverSwatch, PlatformTag, PubStatus } from './publishParts'
import {
  ACCOUNT_ROLE, BASE_METRICS, EXT_METRICS, PLATFORM_META, SNAPSHOT_DAYS, badBase, badExt, canSync, channelOf, coversFor, dayAfter, fillBad, fillOf,
  fillToMetrics, fmtExt, fmtTime, num, pct, ratiosText, testOfPub, type MetricFill,
} from './publishModel'

/** 曲线能切的指标 */
type CurveKey = 'views' | 'impressions' | 'ctr' | 'completion'
const CURVE: { key: CurveKey; label: string; ratio?: boolean }[] = [
  { key: 'views', label: '播放' }, { key: 'impressions', label: '曝光' }, { key: 'ctr', label: '点击率', ratio: true }, { key: 'completion', label: '完播率', ratio: true },
]

/** 按天曲线：横轴按对数排，D1、D3、D7、D30 等距一些；线画在拉伸的 svg 里，点、数字、刻度用 HTML 叠上去 */
export function MetricCurve({ snaps, k, today }: { snaps: VideoMetricSnapshot[]; k: CurveKey; today: number }) {
  const c = CURVE.find((x) => x.key === k)!
  const pts = snaps.filter((s) => s[k] != null).map((s) => ({ d: s.day, v: s[k] as number }))
  const maxD = Math.max(30, ...pts.map((p) => p.d))
  const x = (d: number) => 2 + (Math.log(d) / Math.log(maxD)) * 95
  const maxV = Math.max(c.ratio ? 0.01 : 1, ...pts.map((p) => p.v)) * 1.15
  const y = (v: number) => 8 + (1 - v / maxV) * 90
  const fmt = (v: number) => (c.ratio ? pct(v) : num(v))
  const last = pts[pts.length - 1]
  return (
    <div className="vp-curve" role="img" aria-label={`按天曲线：${c.label}`}>
      <div className="vp-curve-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {SNAPSHOT_DAYS.map((d) => <line key={d} x1={x(d)} x2={x(d)} y1={0} y2={100} vectorEffect="non-scaling-stroke" className={cls('vp-curve-grid', d > today && 'future')} />)}
          {pts.length > 1 && <polyline points={pts.map((p) => `${x(p.d)},${y(p.v)}`).join(' ')} vectorEffect="non-scaling-stroke" className="vp-curve-line" />}
        </svg>
        {pts.map((p) => <span key={p.d} className={cls('vp-curve-dot', SNAPSHOT_DAYS.includes(p.d) && 'key')} style={{ left: `${x(p.d)}%`, top: `${y(p.v)}%` }} title={`第 ${p.d} 天：${fmt(p.v)}`} />)}
        {last && <span className="vp-curve-val" style={{ right: `${100 - x(last.d)}%`, top: `${y(last.v)}%` }}>{fmt(last.v)}</span>}
      </div>
      <div className="vp-curve-ticks" aria-hidden="true">
        {SNAPSHOT_DAYS.map((d) => <span key={d} className={cls(d > today && 'future')} style={{ left: `${x(d)}%` }}>D{d}</span>)}
      </div>
    </div>
  )
}

export function PublishDrawer({ p, video, platform, accounts, covers, tests, sending, submitError, onSubmit, onClose, onOpenVideo, onOpenTest, onOpenUrl, onConnect }: {
  p: VideoPublish
  video?: Video
  platform?: VideoPlatformInfo
  accounts: VideoAccount[]
  covers: VideoArtifact[]
  tests: VideoCoverTest[]
  /** 正在经连接器投稿 */
  sending: boolean
  submitError: unknown
  onSubmit: () => void
  onClose: () => void
  onOpenVideo: (id: string) => void
  onOpenTest: (id: string) => void
  onOpenUrl: (url: string, title: string) => void
  onConnect: () => void
}) {
  const patch = usePatchPublish()
  const del = useDeletePublish()
  const sync = useSyncPublish()
  const snaps = usePublishSnapshots(p.status === 'published' ? p.id : null)
  const [fill, setFill] = useState<MetricFill | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)
  const [curve, setCurve] = useState<CurveKey>('views')
  const [history, setHistory] = useState(false)

  const meta = PLATFORM_META[p.platform]
  const label = platform?.label ?? meta.label
  const ratios = platform?.covers ?? []
  const chan = channelOf(platform)
  const auto = chan.state === 'ok'
  const account = accounts.find((a) => a.id === p.account_id)
  const cover = p.cover_id ? covers.find((a) => a.id === p.cover_id) : undefined
  const choices = coversFor(covers, p.video_id, ratios, p.variant)
  const test = testOfPub(tests, p.id)
  const today = p.published_at ? dayAfter(p.published_at) : 0
  const days = snaps.data?.days ?? []
  const all = snaps.data?.data ?? []
  const latest = days[days.length - 1]
  const curves = CURVE.filter((c) => days.some((s) => s[c.key] != null))
  const exts = EXT_METRICS.filter((e) => p.metrics?.[e.key] != null)
  const busy = sending || patch.isPending || del.isPending || sync.isPending
  const failure = submitError ?? patch.error ?? del.error ?? sync.error
  const unsent = p.status === 'failed' || p.status === 'planned' || p.status === 'scheduled'

  const clear = () => { patch.reset(); del.reset(); sync.reset() }
  const write = (x: Parameters<typeof patch.mutate>[0]['patch'], then?: () => void) => {
    if (busy) return
    clear()
    patch.mutate({ id: p.id, patch: x }, { onSuccess: () => then?.() })
  }
  // 重试：能自动发的重新投稿（已经有稿件链接的先清掉），其余改回计划中
  const retry = () => {
    if (!auto) { write({ status: 'planned', error: null }); return }
    if (p.url) write({ status: 'planned', error: null, url: null }, onSubmit)
    else { clear(); onSubmit() }
  }
  const publishNow = () => {
    if (p.status === 'scheduled') write({ status: 'planned', scheduled_at: null }, onSubmit)
    else { clear(); onSubmit() }
  }
  const linkBad = link !== null && !/^https?:\/\/\S+$/.test(link.trim())
  const saveLink = () => {
    if (link === null || linkBad || !link.trim()) return
    write({ status: 'published', url: link.trim(), published_at: new Date().toISOString(), error: null }, () => setLink(null))
  }
  const bad = !!fill && fillBad(fill)
  const saveFill = () => {
    if (!fill || bad) return
    write({ metrics: fillToMetrics(fill) }, () => setFill(null))
  }
  const pull = () => { if (!busy) { clear(); sync.mutate(p.id) } }
  const remove = () => { if (!busy) { clear(); del.mutate(p.id, { onSuccess: onClose, onError: () => setConfirmDel(false) }) } }

  return (
    <Drawer open onClose={onClose} kicker="发布记录" aria-label={p.title || '未填标题'} className="vd-drawer vp-drawer"
      footer={confirmDel ? (
        <>
          <span className="vd-danger-text">只删这条记录，平台上已发的内容不受影响</span>
          <span className="spacer" />
          <Button onClick={() => setConfirmDel(false)}>取消</Button>
          <Button variant="danger" disabled={busy} onClick={remove}>删除</Button>
        </>
      ) : (
        <>
          <Button variant="danger-ghost" disabled={busy} onClick={() => setConfirmDel(true)}>删除</Button>
          <span className="spacer" />
          {p.status === 'failed' && <Button variant="primary" disabled={busy} onClick={retry}>重试</Button>}
          {auto && (p.status === 'scheduled' || p.status === 'planned') && <Button variant="outline" disabled={busy} onClick={publishNow}>改为立即发布</Button>}
          {!auto && (p.status === 'scheduled' || p.status === 'planned') && link === null && <Button variant="outline" disabled={busy} onClick={() => setLink(p.url ?? '')}>填链接，标为已发布</Button>}
          {p.status === 'published' && <Button variant="primary" disabled={!p.url} title={p.url ? undefined : '没有记链接'} onClick={() => p.url && onOpenUrl(p.url, p.title)}>打开链接</Button>}
        </>
      )}>
      <div className="vd-form">
        <div className="vp-pub-head">
          <h2 className="vp-pub-title">{p.title || '未填标题'}</h2>
          <div className="vp-pub-sub"><PlatformTag k={p.platform} /><PubStatus s={p.status} sending={sending} /></div>
        </div>
        {failure ? <div className="vd-err" role="alert">{errorText(failure)}</div> : null}

        {p.status === 'failed' && (
          <div className="vp-alert">
            <span><b>发布失败</b>{p.error || '平台没有返回原因'}</span>
            <Button size="sm" disabled={busy} onClick={retry}>重试</Button>
          </div>
        )}
        {link !== null && (
          <div className="vp-link-form">
            <span className="vd-label">在{label}发好以后，把稿件链接贴进来</span>
            <Input value={link} invalid={linkBad} aria-label="平台链接" placeholder="https://" autoFocus onChange={(e) => setLink(e.target.value)} />
            <div className="vd-act-row">
              <Button size="sm" variant="primary" disabled={busy || linkBad || !link.trim()} onClick={saveLink}>保存，标为已发布</Button>
              <Button size="sm" onClick={() => setLink(null)}>取消</Button>
              {linkBad && <span className="field-err">链接要以 http:// 或 https:// 开头</span>}
            </div>
          </div>
        )}

        {unsent && !sending && (
          <div className="field">
            <span className="field-label">换封面<span className="vd-hint">{label}收 {ratiosText(ratios)}{ratios[0] ? `，推荐 ${COVER_RATIO[ratios[0]].label}` : ''}</span></span>
            {choices.length ? (
              <div className="vp-covers">
                {choices.map((a) => (
                  <span key={a.id} className="vp-cover-opt">
                    <CoverSwatch a={a} on={cover?.id === a.id} disabled={busy} onClick={() => write({ cover_id: cover?.id === a.id ? null : a.id })} />
                    <span className="vp-cover-cap">{COVER_RATIO[coverRatioOf(a)].label} · 版本 {a.option ?? '-'}</span>
                  </span>
                ))}
              </div>
            ) : <div className="vd-col-empty">这集还没有 {ratiosText(ratios)} 的{ORIENT[p.variant].label}封面，去视频的产出物里登记一张</div>}
          </div>
        )}

        <dl className="vd-props vp-props">
          <dt>视频</dt>
          <dd>{video ? <button type="button" className="vd-link ellipsis" onClick={() => onOpenVideo(video.id)}>{video.title || '未命名视频'}</button> : <span className="vd-faint">已删除的视频</span>}</dd>
          <dt>平台</dt><dd>{label}<span className="vd-faint">（偏好{ORIENT[meta.prefer].label}）</span></dd>
          <dt>账号</dt>
          <dd>{account ? <>{account.handle}<span className="vd-otag">{ACCOUNT_ROLE[account.role]}</span>{!account.connector_id && <span className="vd-faint">手动登记，数据要回填</span>}</> : <span className="vd-faint">没挂账号</span>}</dd>
          <dt>比例</dt>
          <dd>{ORIENT[p.variant].label} {ORIENT[p.variant].ratio}{p.variant !== meta.prefer && <span className="vp-hint-inline">平台建议{ORIENT[meta.prefer].label}</span>}</dd>
          <dt>封面</dt>
          <dd>{cover ? <><CoverSwatch a={cover} size="sm" /><span className="vd-mono ellipsis">{cover.path}</span>
            {ratios.length > 0 && !ratios.includes(coverRatioOf(cover)) && <span className="vp-hint-inline">{label}不收 {COVER_RATIO[coverRatioOf(cover)].label}</span>}</> : <span className="vd-faint">没有选封面</span>}</dd>
          {test && <><dt>封面 A/B</dt><dd><button type="button" className="vd-link" onClick={() => onOpenTest(test.id)}>
            {test.status === 'running' ? '在测试里，进行中' : test.status === 'decided' ? (test.winner_id === p.cover_id ? '测试胜出的一版' : '测试里输掉的一版') : '测试已结束，没有结论'}
          </button></dd></>}
          {p.tags?.length ? <><dt>标签</dt><dd className="vp-tags">{p.tags.map((t) => <span key={t} className="tag">{t}</span>)}</dd></> : null}
          {p.category && <><dt>分区</dt><dd>{p.category}</dd></>}
          {p.collection && <><dt>合集</dt><dd>{p.collection}</dd></>}
          {p.scheduled_at && <><dt>定时</dt><dd>{new Date(p.scheduled_at).toLocaleString('zh-CN')}</dd></>}
          {p.published_at && <><dt>发布于</dt><dd>{new Date(p.published_at).toLocaleString('zh-CN')}<span className="vd-faint">（{timeAgo(p.published_at)}）</span></dd></>}
          <dt>链接</dt>
          <dd>{p.url ? <span className="vd-mono ellipsis" title={p.url}>{p.url}</span> : <span className="vd-faint">{p.status === 'published' ? '没有记链接' : '发布后生成'}</span>}</dd>
          {p.checks && p.checks.length > 0 && <><dt>发布前校验</dt><dd>{p.checks.every((c) => c.ok) ? <span>{p.checks.length} 项全部通过</span>
            : <span className="vd-danger-text">{p.checks.filter((c) => !c.ok).map((c) => c.text).join('；')}</span>}</dd></>}
        </dl>

        <section className="vd-sec-plain">
          <div className="vd-sec-title">简介</div>
          {p.desc ? <div className="vp-desc">{p.desc}</div> : <div className="vd-faint">没有填简介</div>}
        </section>

        {p.status === 'published' && (
          <section className="vd-sec-plain" aria-label="数据">
            <div className="vp-sec-head">
              <span className="vd-sec-title">数据<span className="vd-hint">{p.metrics?.updated_at ? `${timeAgo(p.metrics.updated_at)}更新，发布后第 ${today} 天` : '还没回填'}</span></span>
              <span className="spacer" />
              {!fill && <>
                {canSync(platform) && <Button size="sm" disabled={busy} onClick={pull}>{sync.isPending ? '拉取中…' : '拉取数据'}</Button>}
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setFill(fillOf(p.metrics))}>回填数据</Button>
              </>}
            </div>
            {chan.state === 'error' && <div className="vp-hint vp-conn"><span>{chan.name ?? label}连接异常：{chan.error || '请重新授权'}；修好之前拉不到数据，可以手动回填</span><button type="button" className="vd-link" onClick={onConnect}>去修复</button></div>}
            {fill ? (
              <>
                <div className="vp-hint vp-hint-info">记为发布后第 {today} 天，存一条新快照，之前的快照不覆盖</div>
                <div className="vp-metric-form">
                  {BASE_METRICS.map((m) => (
                    <label key={m.key} className="field">
                      <span className="field-label">{m.label}</span>
                      <Input inputMode="numeric" value={fill[m.key]} invalid={badBase(fill[m.key])} onChange={(e) => setFill({ ...fill, [m.key]: e.target.value })} />
                    </label>
                  ))}
                  {EXT_METRICS.map((e) => (
                    <label key={e.key} className="field">
                      <span className="field-label">{e.label}<span className="vd-hint">{e.kind === 'pct' ? '%' : e.kind === 'sec' ? '秒' : '可空'}</span></span>
                      <Input inputMode="decimal" value={fill[e.key]} invalid={badExt(e.kind, fill[e.key])} onChange={(ev) => setFill({ ...fill, [e.key]: ev.target.value })} />
                    </label>
                  ))}
                </div>
                <div className="vd-act-row">
                  <Button size="sm" variant="primary" disabled={bad || busy} onClick={saveFill}>保存</Button>
                  <Button size="sm" onClick={() => setFill(null)}>取消</Button>
                  {bad && <span className="field-err">播放、点赞、评论、转发只能填非负整数；百分比填 0 到 100；平台不给的留空</span>}
                </div>
              </>
            ) : (
              <div className="vp-metric-grid">
                {BASE_METRICS.map((m) => <div key={m.key} className="vp-metric"><span>{m.label}</span><b>{p.metrics ? num(p.metrics[m.key]) : '-'}</b></div>)}
                {exts.map((e) => <div key={e.key} className="vp-metric"><span>{e.label}</span><b>{fmtExt(e.kind, p.metrics?.[e.key])}</b></div>)}
              </div>
            )}
          </section>
        )}

        {p.status === 'published' && !fill && (
          <section className="vd-sec-plain" aria-label="按天曲线">
            <div className="vp-sec-head">
              <span className="vd-sec-title">按天曲线<span className="vd-hint">{latest ? `${all.length} 条快照，最新是第 ${latest.day} 天；同一天取最后一条` : snaps.isPending ? '加载中…' : '还没有快照'}</span></span>
              <span className="spacer" />
              {curves.length > 1 && (
                <div className="vd-sort" role="group" aria-label="曲线指标">
                  {curves.map((c) => <button key={c.key} type="button" aria-pressed={curve === c.key} className={cls(curve === c.key && 'on')} onClick={() => setCurve(c.key)}>{c.label}</button>)}
                </div>
              )}
            </div>
            {snaps.isError ? <div className="vd-err">{errorText(snaps.error)}</div> : latest ? (
              <>
                <MetricCurve snaps={days} k={curves.some((c) => c.key === curve) ? curve : 'views'} today={today} />
                <div className="vp-days" role="table" aria-label="关键几天的数据">
                  <span className="vp-days-row vp-days-th" role="row"><span role="columnheader" />{SNAPSHOT_DAYS.map((d) => <span key={d} role="columnheader">D{d}</span>)}<span role="columnheader">最新</span></span>
                  {curves.map((c) => (
                    <span key={c.key} className="vp-days-row" role="row">
                      <span className="vd-faint" role="rowheader">{c.label}</span>
                      {SNAPSHOT_DAYS.map((d) => {
                        const s = days.find((x) => x.day === d)
                        const v = s?.[c.key]
                        return <span key={d} role="cell" className={cls(!s && 'vd-faint')}>{d > today ? '未到' : v == null ? '-' : c.ratio ? pct(v) : num(v)}</span>
                      })}
                      <span role="cell">{latest[c.key] == null ? '-' : c.ratio ? pct(latest[c.key]) : num(latest[c.key])}</span>
                    </span>
                  ))}
                </div>
                <Button size="sm" className="vp-hist-toggle" onClick={() => setHistory(!history)}>{history ? '收起快照' : `看全部 ${all.length} 条快照`}</Button>
                {history && (
                  <div className="vp-hist">
                    {[...all].reverse().map((s, i) => (
                      <span key={`${s.created_at}-${i}`} className="vp-hist-row">
                        <span>第 {s.day} 天</span>
                        <span className="vd-faint">{s.source === 'manual' ? '手动回填' : '连接器拉取'}</span>
                        <span>播放 {num(s.views)}</span>
                        <span>{s.ctr != null ? `点击率 ${pct(s.ctr)}` : ''}</span>
                        <span className="vd-faint">{fmtTime(s.updated_at)}</span>
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : !snaps.isPending && <div className="vd-col-empty">拉取或回填一次就有第一条快照；之后每次都存一条，不覆盖</div>}
          </section>
        )}
      </div>
    </Drawer>
  )
}
