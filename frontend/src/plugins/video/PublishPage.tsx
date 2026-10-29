// 发布记录（VID-05c，SPEC-videos-7，照原型 web-next/src/videopublish.tsx 的 PublishPage）：汇总数字、只看一集时的按平台对比、封面 A/B 一节、
// 搜索和平台、状态筛选，全部记录按视频分组。地址上记着 ?video=<只看的视频>、plat、st，抽屉 ?p=<发布 id 或 new>、?t=<测试 id 或 new>，刷新还在。
// 原型的「模拟发布」换成经连接器投稿（POST submit），接通了上传接口的平台才自动发，其余只登记
import { Fragment, useState, type CSSProperties } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import {
  errorText, useSubmitPublish, useVideoAccounts, useVideoCoverTests, useVideoCovers, useVideoPlatforms, useVideoPublishes,
  type Video, type VideoPlatform, type VideoPublish, type VideoPublishStatus,
} from '../../core/data'
import { Button, ErrorState, IconSearch, LoadingState, PageTitle, cls } from '../../core/ui'
import { CoverTestDrawer, CoverTestSection } from './CoverTests'
import { NewPublishDrawer } from './NewPublishDrawer'
import { ORIENT } from './model'
import { IconPlus, VideosTabs, type ModuleTab } from './parts'
import { PublishDrawer } from './PublishDrawer'
import { CoverSwatch, PlatformTag, PubStatus } from './publishParts'
import {
  BASE_METRICS, PEEK, PLATFORM_KEYS, PLATFORM_META, PUBLISH_STATUS, PUBLISH_STATUSES, fmtTime, groupByVideo, num, peekOf, sortPublishes, type BaseKey,
} from './publishModel'
import './publish.css'

/** 一次渲染多少个视频组 */
const GROUPS = 30

export function PublishPage({ videos, onModuleTab, onOpenVideo }: {
  videos: Video[]
  onModuleTab: (t: ModuleTab) => void
  onOpenVideo: (id: string) => void
}) {
  const [search, setSearch] = useSearchParams()
  const navigate = useNavigate()
  const publishes = useVideoPublishes()
  const platforms = useVideoPlatforms()
  const accounts = useVideoAccounts()
  const covers = useVideoCovers()
  const tests = useVideoCoverTests()
  const submit = useSubmitPublish()
  const [q, setQ] = useState('')
  const [metric, setMetric] = useState<BaseKey>('views')
  const [openV, setOpenV] = useState<string[]>([])
  const [glimit, setGlimit] = useState(GROUPS)

  const videoId = search.get('video') ?? ''
  const platRaw = search.get('plat') ?? ''
  const plat = (PLATFORM_KEYS as string[]).includes(platRaw) ? platRaw as VideoPlatform : ''
  const stRaw = search.get('st') ?? ''
  const st = (PUBLISH_STATUSES as string[]).includes(stRaw) ? stRaw as VideoPublishStatus : ''
  const openP = search.get('p')
  const openT = search.get('t')

  const setParams = (x: Record<string, string>, push = false) => {
    const next = new URLSearchParams(search)
    for (const [k, v] of Object.entries(x)) { if (v) next.set(k, v); else next.delete(k) }
    setSearch(next, { replace: !push })
  }
  // 发布抽屉和测试抽屉二选一
  const openPub = (id: string | null) => setParams({ p: id ?? '', t: '' }, !!id)
  const openTest = (id: string | null) => setParams({ t: id ?? '', p: '' }, !!id)
  // 去接入、去修复：带上平台的连接器工具，连接器页直接打开它的抽屉（SHELL-02）
  const goConnect = (tool: string | undefined) => void navigate(tool ? `/settings/connectors?${new URLSearchParams({ tool })}` : '/settings/connectors')

  const queries = [publishes, platforms, accounts, covers, tests]
  const head = (
    <>
      <PageTitle parent="视频" count={publishes.data ? (videoId ? publishes.data.filter((p) => p.video_id === videoId).length : publishes.data.length) : undefined}
        desc="每个平台发了哪个比例、哪张封面，发出去以后回填播放数据"
        actions={<Button variant="primary" disabled={!publishes.data} onClick={() => openPub('new')}><IconPlus />新建发布</Button>}>发布记录</PageTitle>
      <VideosTabs active="publishes" videos={videos} onSelect={onModuleTab} />
    </>
  )
  if (queries.some((x) => x.isPending)) return <div className="vd-page">{head}<LoadingState /></div>
  const bad = queries.find((x) => x.isError)
  if (bad) {
    return (
      <div className="vd-page">{head}
        <ErrorState title="发布记录没加载出来" error={errorText(bad.error)} onRetry={() => queries.forEach((x) => { if (x.isError) void x.refetch() })} />
      </div>
    )
  }
  const all = publishes.data ?? []
  const plats = platforms.data ?? []
  const accs = accounts.data ?? []
  const cvs = covers.data ?? []
  const tsts = tests.data ?? []

  const titleOf = (id: string) => videos.find((v) => v.id === id)?.title || (videos.some((v) => v.id === id) ? '未命名视频' : '已删除的视频')
  const video = videoId ? videos.find((v) => v.id === videoId) : undefined
  const base = videoId ? all.filter((p) => p.video_id === videoId) : all
  const kw = q.trim().toLowerCase()
  const rows = sortPublishes(base.filter((p) => (!plat || p.platform === plat) && (!st || p.status === st)
    && (!kw || `${p.title} ${videoId ? '' : titleOf(p.video_id)}`.toLowerCase().includes(kw))))
  const published = base.filter((p) => p.status === 'published')
  const sum = (k: BaseKey) => published.reduce((n, p) => n + (p.metrics?.[k] ?? 0), 0)
  const failed = base.filter((p) => p.status === 'failed').length
  const coverOf = (p: VideoPublish) => (p.cover_id ? cvs.find((a) => a.id === p.cover_id) : undefined)
  const sendingId = submit.isPending ? submit.variables : undefined

  const byPlat = PLATFORM_KEYS.map((k) => {
    const xs = published.filter((x) => x.platform === k)
    return { k, has: base.some((x) => x.platform === k), n: xs.length, v: xs.reduce((n, x) => n + (x.metrics?.[metric] ?? 0), 0) }
  }).filter((x) => x.has)
  const max = Math.max(1, ...byPlat.map((x) => x.v))
  const groups = groupByVideo(rows)

  const row = (p: VideoPublish) => {
    const cv = coverOf(p)
    return (
      <button key={p.id} type="button" className={cls('vp-row', openP === p.id && 'sel')} onClick={() => openPub(p.id)}>
        <span className="vp-main">
          <span className="vp-title ellipsis">{p.title || '未填标题'}</span>
          <span className="vp-sub ellipsis">{titleOf(p.video_id)}</span>
        </span>
        <span><PlatformTag k={p.platform} /></span>
        <span className="vp-var">
          <span className="vd-otag">{ORIENT[p.variant].label}</span>
          {cv ? <CoverSwatch a={cv} size="sm" /> : <span className="vd-faint">无封面</span>}
        </span>
        <span><PubStatus s={p.status} sending={sendingId === p.id} /></span>
        <span className="vp-time">
          {p.status === 'published' && p.published_at ? fmtTime(p.published_at)
            : p.status === 'scheduled' && p.scheduled_at ? `定时 ${fmtTime(p.scheduled_at)}`
              : p.status === 'failed' ? <span className="vd-danger-text ellipsis" title={p.error}>{p.error || '失败'}</span> : '-'}
        </span>
        <span className="vp-met">
          {BASE_METRICS.map((m) => <span key={m.key}><em>{m.label}</em>{p.metrics ? num(p.metrics[m.key]) : '-'}</span>)}
        </span>
      </button>
    )
  }

  const current = openP && openP !== 'new' ? all.find((p) => p.id === openP) : undefined
  const currentTest = openT && openT !== 'new' ? tsts.find((t) => t.id === openT) : undefined

  return (
    <div className="vd-page">
      {head}
      {videoId && (
        <div className="vp-only">
          <span className="vp-only-k">只看：</span>
          <button type="button" className="vd-link ellipsis" onClick={() => onOpenVideo(videoId)}>{titleOf(videoId)}</button>
          <span className="spacer" />
          <Button size="sm" onClick={() => setParams({ video: '' })}>清除，看全部</Button>
        </div>
      )}

      <div className="vp-stats">
        <div className="vp-stat"><span>已发布</span><b>{num(published.length)}</b></div>
        <div className="vp-stat"><span>总播放</span><b>{num(sum('views'))}</b></div>
        <div className="vp-stat"><span>总点赞</span><b>{num(sum('likes'))}</b></div>
        <div className="vp-stat"><span>发布失败</span><b className={cls(failed > 0 && 'vp-bad')}>{num(failed)}</b></div>
      </div>

      {videoId && (
        <section className="vd-sec" aria-label="按平台对比">
          <div className="vp-sec-head">
            <span className="vd-sec-title">按平台对比</span>
            <span className="spacer" />
            <div className="vd-sort" role="group" aria-label="对比的指标">
              {BASE_METRICS.map((m) => <button key={m.key} type="button" className={cls(metric === m.key && 'on')} aria-pressed={metric === m.key} onClick={() => setMetric(m.key)}>{m.label}</button>)}
            </div>
          </div>
          {byPlat.length ? (
            <div className="vp-bars">
              {byPlat.map(({ k, n, v }) => (
                <div key={k} className="vp-bar-row">
                  <span><PlatformTag k={k} /></span>
                  <span className="vp-bar-track">
                    {n ? <span className="vp-bar" style={{ width: `${Math.max(2, (v / max) * 100)}%`, '--c': PLATFORM_META[k].color } as CSSProperties} />
                      : <span className="vd-faint vp-bar-none">还没发出去</span>}
                  </span>
                  <span className="vp-bar-val">{n ? num(v) : '-'}</span>
                </div>
              ))}
            </div>
          ) : <div className="vd-col-empty">这一集还没有发布记录</div>}
        </section>
      )}

      <CoverTestSection tests={tsts} videos={videos} covers={cvs} videoId={videoId || undefined} onOpen={openTest} onNew={() => openTest('new')} />

      <div className="vp-filters">
        <label className="search search-sm vp-search">
          <IconSearch />
          <input type="search" aria-label="搜索发布记录" placeholder={videoId ? '搜发布标题' : '搜发布标题或视频'} value={q}
            onChange={(e) => { setQ(e.target.value); setGlimit(GROUPS) }} />
        </label>
        <div className="vp-chips" role="group" aria-label="按平台筛选">
          <button type="button" className={cls('chip', !plat && 'chip-on')} onClick={() => setParams({ plat: '' })}>全部平台</button>
          {PLATFORM_KEYS.map((k) => (
            <button key={k} type="button" className={cls('chip', plat === k && 'chip-on')} aria-pressed={plat === k} onClick={() => setParams({ plat: plat === k ? '' : k })}>
              {PLATFORM_META[k].label}<span className="seg-n">{base.filter((x) => x.platform === k).length}</span>
            </button>
          ))}
        </div>
        <div className="vp-chips" role="group" aria-label="按状态筛选">
          <button type="button" className={cls('chip', !st && 'chip-on')} onClick={() => setParams({ st: '' })}>全部状态</button>
          {PUBLISH_STATUSES.map((k) => (
            <button key={k} type="button" className={cls('chip', st === k && 'chip-on')} aria-pressed={st === k} onClick={() => setParams({ st: st === k ? '' : k })}>
              {PUBLISH_STATUS[k].label}<span className="seg-n">{base.filter((x) => x.status === k).length}</span>
            </button>
          ))}
        </div>
      </div>

      {!rows.length ? (
        <div className="empty">
          <div className="empty-title">{plat || st || kw ? '没有匹配的发布记录' : '还没有发布记录'}</div>
          <div className="empty-desc">点右上角「新建发布」，选视频、平台、比例和封面</div>
        </div>
      ) : (
        <div className="vp-table">
          <div className="vp-row vp-th" aria-hidden="true">
            <span>视频</span><span>平台</span><span>比例 / 封面</span><span>状态</span><span>时间</span>
            <span className="vp-met">{BASE_METRICS.map((m) => <span key={m.key}>{m.label}</span>)}</span>
          </div>
          {videoId ? rows.map(row) : groups.slice(0, glimit).map((g) => {
            const open = openV.includes(g.id) || g.xs.length <= PEEK
            const fail = g.xs.filter((p) => p.status === 'failed').length
            return (
              <Fragment key={g.id}>
                <div className="vp-group-row">
                  <button type="button" className="vd-link ellipsis vp-group-title" title={titleOf(g.id)} onClick={() => onOpenVideo(g.id)}>{titleOf(g.id)}</button>
                  <span className="vp-group-plats">{[...new Set(g.xs.map((p) => p.platform))].map((k) => <PlatformTag key={k} k={k} />)}</span>
                  {fail > 0 && <span className="vd-danger-text vp-group-n">{fail} 条失败</span>}
                  <span className="spacer" />
                  <span className="vd-muted">{g.xs.length} 条</span>
                  {g.xs.length > PEEK && (
                    <Button size="sm" onClick={() => setOpenV(open ? openV.filter((x) => x !== g.id) : [...openV, g.id])}>{open ? '收起' : `查看全部 ${g.xs.length} 条`}</Button>
                  )}
                </div>
                {(open ? g.xs : peekOf(g.xs)).map(row)}
              </Fragment>
            )
          })}
          {!videoId && groups.length > glimit && (
            <button type="button" className="vp-more" onClick={() => setGlimit(glimit + GROUPS)}>显示更多视频（还有 {groups.length - glimit} 个）</button>
          )}
        </div>
      )}

      {openP === 'new' && (
        <NewPublishDrawer videos={videos} platforms={plats} accounts={accs} covers={cvs} defaultVideo={video?.id}
          onClose={() => openPub(null)}
          onCreated={(p, now) => { setParams({ p: p.id, t: '' }); if (now) submit.mutate(p.id) }}
          onConnect={goConnect} />
      )}
      {current && (
        <PublishDrawer key={current.id} p={current} video={videos.find((v) => v.id === current.video_id)} platform={plats.find((x) => x.key === current.platform)}
          accounts={accs} covers={cvs} tests={tsts}
          sending={sendingId === current.id} submitError={submit.variables === current.id ? submit.error : null}
          onSubmit={() => { submit.reset(); submit.mutate(current.id) }}
          onClose={() => openPub(null)} onOpenVideo={onOpenVideo} onOpenTest={openTest}
          onOpenUrl={(url, title) => void navigate(`/browser?${new URLSearchParams({ open: url, title })}`)}
          onConnect={() => goConnect(plats.find((x) => x.key === current.platform)?.tool)} />
      )}
      {openP && openP !== 'new' && !current && (
        <div className="vp-gone" role="status">这条发布记录已经删除了<Button size="sm" onClick={() => openPub(null)}>知道了</Button></div>
      )}
      {(openT === 'new' || currentTest) && (
        <CoverTestDrawer key={openT} test={currentTest} videos={videos} covers={cvs} publishes={all} accounts={accs} platforms={plats}
          defaultVideo={video?.id} onClose={() => openTest(null)} onCreated={(id) => setParams({ t: id, p: '' })} onOpenPublish={(id) => openPub(id)} />
      )}
    </div>
  )
}
