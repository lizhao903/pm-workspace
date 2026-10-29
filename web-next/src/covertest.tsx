import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { SearchSelect } from './searchselect'
import {
  ACCOUNT_ROLE, COVER_RATIO, COVER_TEST_MODE, COVER_TEST_STATUS, PLATFORMS, coverRatioOf, coverTestState, dayAfter, seedAccounts, seedCoverTests, seedSnapshots,
  type Artifact, type CoverTest, type CoverTestMode, type MetricSnapshot, type Metrics, type PlatformKey, type Publish, type Video,
} from './videodata'
import { CoverSwatch, PlatformTag } from './videopublish'
import { newId } from './ids'
import { cls, timeAgo } from './ui'
import './videopublish.css'

// 发布数据的按天快照和封面 A/B 测试
// 原型阶段放在模块级的小 store 里（和 kbdata 一样）：切到别的标签再回来，回填的快照和测试还在

interface PubState { snapshots: MetricSnapshot[]; tests: CoverTest[] }
let state: PubState = { snapshots: seedSnapshots, tests: seedCoverTests }
const subs = new Set<() => void>()
const emit = (s: PubState) => { state = s; subs.forEach((f) => f()) }
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }

export function usePubStore() {
  return useSyncExternalStore(subscribe, () => state)
}
export const pubStore = {
  addSnapshot(s: MetricSnapshot) { emit({ ...state, snapshots: [...state.snapshots, s] }) },
  addTest(t: CoverTest) { emit({ ...state, tests: [t, ...state.tests] }) },
  patchTest(id: string, p: Partial<CoverTest>) { emit({ ...state, tests: state.tests.map((t) => (t.id === id ? { ...t, ...p } : t)) }) },
}

export const accountOf = (id?: string) => (id ? seedAccounts.find((a) => a.id === id) : undefined)
export const accountsOf = (k: PlatformKey) => seedAccounts.filter((a) => a.platform === k)
/** 封面测试还没有登记 id 前缀，借 newId 的生成规则换成 cvt_ */
const newTestId = () => newId('pb').replace(/^pb_/, 'cvt_')

export const pct = (x: number | undefined, d = 1) => (x == null ? '-' : `${(x * 100).toFixed(d)}%`)
const num = (n: number | undefined) => (n == null ? '-' : n.toLocaleString('zh-CN'))
const wan = (n: number) => (n >= 10000 ? `${+(n / 10000).toFixed(1)} 万` : n.toLocaleString('zh-CN'))
const Pill = ({ label, color }: { label: string; color: string }) => <span className="pill" style={{ '--c': color } as React.CSSProperties}><span className="pill-dot" />{label}</span>
const CloseIcon = () => <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>

/** 测试每一张封面这会儿的数：小号分发从对应发布的数据读，原生测试读自己记的 */
export function armsOf(t: CoverTest, publishes: Publish[]) {
  return t.arms.map((a) => {
    const p = a.publish_id ? publishes.find((x) => x.id === a.publish_id) : undefined
    return { ...a, publish: p, impressions: p ? p.metrics?.impressions : a.impressions, ctr: p ? p.metrics?.ctr : a.ctr }
  })
}

/** 模拟拉取一次：曝光涨一截，点击率小幅抖动，播放按两者算 */
export function grownMetrics(m: Metrics | undefined): Metrics {
  const b = m ?? { views: 0, likes: 0, comments: 0, shares: 0, updated_at: '' }
  const up = (n: number | undefined, base: number, rate: number) => (n ?? 0) + Math.round(base * Math.random() + (n ?? 0) * rate * Math.random())
  const impressions = up(b.impressions, 2400, 0.25)
  const ctr = +Math.max(0.01, (b.ctr ?? 0.06) * (0.96 + Math.random() * 0.08)).toFixed(4)
  return {
    ...b, impressions, ctr, views: Math.max(b.views, Math.round(impressions * ctr)),
    likes: up(b.likes, 25, 0.15), comments: up(b.comments, 4, 0.12), shares: up(b.shares, 3, 0.12),
    favorites: b.favorites == null ? undefined : up(b.favorites, 10, 0.12), coins: b.coins == null ? undefined : up(b.coins, 4, 0.1),
    followers_gained: b.followers_gained == null ? undefined : up(b.followers_gained, 6, 0.1),
    updated_at: new Date().toISOString(),
  }
}
export const snapshotOf = (p: Publish, m: Metrics, source: MetricSnapshot['source']): MetricSnapshot =>
  ({ ...m, publish_id: p.id, day: dayAfter(p.published_at ?? m.updated_at, m.updated_at), source })

/** 判定进度三条：曝光、天数、点击率差距 */
function RuleChips({ t, st, n }: { t: CoverTest; st: ReturnType<typeof coverTestState>; n: number }) {
  return (
    <span className="vp-ab-rules">
      <span className={cls('vp-ab-rule', st.impOk && 'ok')}>曝光到 {wan(t.min_impressions)}：{st.reached} / {n}</span>
      <span className={cls('vp-ab-rule', st.daysOk && 'ok')}>观察天数：{Math.min(st.days, 99)} / {t.min_days}</span>
      <span className={cls('vp-ab-rule', st.gapOk && 'ok')}>点击率差距：{st.gap == null ? '-' : pct(st.gap, 0)} / {pct(t.min_gap, 0)}</span>
    </span>
  )
}

/** 发布记录页上的「封面 A/B」一节：每个测试一行，点开看详情 */
export function CoverTestSection({ tests, videos, artifacts, publishes, videoId, onOpen, onNew }: {
  tests: CoverTest[]; videos: Video[]; artifacts: Artifact[]; publishes: Publish[]
  videoId?: string
  onOpen: (id: string) => void
  onNew: () => void
}) {
  const xs = (videoId ? tests.filter((t) => t.video_id === videoId) : tests)
    .sort((a, b) => Number(a.status !== 'running') - Number(b.status !== 'running') || b.started_at.localeCompare(a.started_at))
  const titleOf = (id: string) => videos.find((v) => v.id === id)?.title ?? '已删除的视频'
  const coverOf = (id?: string) => artifacts.find((a) => a.id === id)
  return (
    <section className="hook-sec vp-ab-sec">
      <div className="vp-compare-head">
        <span className="field-group-title">封面 A/B<span className="field-hint">每张曝光到 1 万、观察满 7 天、点击率领先 20% 才判胜负</span></span>
        <span className="spacer" />
        <button className="act" onClick={onNew}>新建测试</button>
      </div>
      {xs.length ? (
        <div className="vp-ab-list">
          {xs.map((t) => {
            const arms = armsOf(t, publishes)
            const st = coverTestState(t, arms)
            const win = coverOf(t.winner_id)
            return (
              <button key={t.id} type="button" className="vp-ab-row" onClick={() => onOpen(t.id)}>
                <span className="vp-ab-covers">
                  {arms.map((a) => {
                    const c = coverOf(a.cover_id)
                    return c ? <CoverSwatch key={a.cover_id} ratio={coverRatioOf(c)} option={c.option} size="sm" title={c.name} /> : null
                  })}
                </span>
                <span className="task-main">
                  <span className="task-title"><span className="ellipsis">{titleOf(t.video_id)}</span></span>
                  <span className="task-meta"><PlatformTag k={t.platform} /><span>{COVER_TEST_MODE[t.mode].label}</span><span>{arms.length} 张封面</span></span>
                </span>
                <span className="vp-ab-prog">
                  {t.status === 'running' ? <RuleChips t={t} st={st} n={arms.length} />
                    : t.status === 'decided' ? <span className="run-muted">{win ? `${win.name} 胜出` : '已决出'}{t.ended_at ? `，${timeAgo(t.ended_at)}结束` : ''}</span>
                      : <span className="run-muted">提前结束，没有判胜负</span>}
                </span>
                <Pill {...COVER_TEST_STATUS[t.status]} />
              </button>
            )
          })}
        </div>
      ) : <div className="mount-empty">{videoId ? '这一集还没做过封面测试' : '还没有封面测试'}；同一集出了几版封面，可以用 A/B 小号各发一版比点击率</div>}
    </section>
  )
}

/** 封面 A/B 抽屉：看一个测试，或新建一个 */
export function CoverTestDrawer({ test, videos, artifacts, publishes, defaultVideo, onClose, onCreated, onPublishes, onArtifacts, onOpenPublish }: {
  /** 不传是新建 */
  test?: CoverTest
  videos: Video[]; artifacts: Artifact[]; publishes: Publish[]
  defaultVideo?: string
  onClose: () => void
  /** 新建好以后打开这个测试 */
  onCreated: (id: string) => void
  onPublishes: (fn: (xs: Publish[]) => Publish[]) => void
  /** 判定胜者后改封面：胜者设为主封面，其余归档；不传时只记在测试上 */
  onArtifacts?: (fn: (xs: Artifact[]) => Artifact[]) => void
  onOpenPublish: (id: string) => void
}) {
  const ref = useRef(onClose)
  useEffect(() => { ref.current = onClose })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') ref.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <aside className="drawer vp-drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">{test ? '封面 A/B 测试' : '新建封面测试'}</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)"><CloseIcon /></button>
      </div>
      {test ? <TestView t={test} videos={videos} artifacts={artifacts} publishes={publishes} onPublishes={onPublishes} onArtifacts={onArtifacts} onOpenPublish={onOpenPublish} />
        : <NewTest videos={videos} artifacts={artifacts} publishes={publishes} defaultVideo={defaultVideo} onClose={onClose} onCreated={onCreated} />}
    </aside>
  )
}

function TestView({ t, videos, artifacts, publishes, onPublishes, onArtifacts, onOpenPublish }: {
  t: CoverTest; videos: Video[]; artifacts: Artifact[]; publishes: Publish[]
  onPublishes: (fn: (xs: Publish[]) => Publish[]) => void
  onArtifacts?: (fn: (xs: Artifact[]) => Artifact[]) => void
  onOpenPublish: (id: string) => void
}) {
  const [confirm, setConfirm] = useState<'early' | 'stop' | null>(null)
  const video = videos.find((v) => v.id === t.video_id)
  const arms = armsOf(t, publishes)
  const st = coverTestState(t, arms)
  const ready = st.impOk && st.daysOk && st.gapOk
  const maxCtr = Math.max(0.0001, ...arms.map((a) => a.ctr ?? 0))
  const coverOf = (id?: string) => artifacts.find((a) => a.id === id)
  const leader = coverOf(st.leader)

  // 模拟拉取：有发布的改发布数据并存一条快照，原生测试改测试自己的数
  const pull = () => {
    const nextPub: Record<string, Metrics> = {}
    arms.forEach((a) => {
      if (a.publish?.status === 'published') {
        const m = grownMetrics(a.publish.metrics)
        nextPub[a.publish.id] = m
        pubStore.addSnapshot(snapshotOf(a.publish, m, 'connector'))
      }
    })
    if (Object.keys(nextPub).length) onPublishes((xs) => xs.map((x) => (nextPub[x.id] ? { ...x, metrics: nextPub[x.id] } : x)))
    if (t.mode !== 'accounts') {
      pubStore.patchTest(t.id, { arms: t.arms.map((a) => {
        const m = grownMetrics({ views: 0, likes: 0, comments: 0, shares: 0, impressions: a.impressions, ctr: a.ctr, updated_at: '' })
        return { ...a, impressions: m.impressions, ctr: m.ctr }
      }) })
    }
  }
  const decide = (winner: string) => {
    const now = new Date().toISOString()
    pubStore.patchTest(t.id, { status: 'decided', winner_id: winner, ended_at: now })
    const w = coverOf(winner)
    const ids = t.arms.map((a) => a.cover_id)
    if (w && onArtifacts) {
      // 同一方向、同一封面比例里只能选用一张；输掉的归档，不删
      const same = (a: Artifact) => a.video_id === w.video_id && a.kind === 'cover' && a.variant === w.variant && coverRatioOf(a) === coverRatioOf(w)
      onArtifacts((xs) => xs.map((a) => (a.id === winner ? { ...a, picked: true, archived: undefined }
        : ids.includes(a.id) ? { ...a, picked: same(a) ? false : a.picked, archived: true }
          : same(a) ? { ...a, picked: false } : a)))
    }
    setConfirm(null)
  }
  const stop = () => { pubStore.patchTest(t.id, { status: 'inconclusive', ended_at: new Date().toISOString() }); setConfirm(null) }

  return (
    <>
      <div className="drawer-body form">
        <div className="vp-pub-head">
          <div className="profile-text">
            <h2 className="vp-pub-title">{video?.title ?? '已删除的视频'}</h2>
            <div className="vp-pub-sub">
              <PlatformTag k={t.platform} />
              <span className="tag">{COVER_TEST_MODE[t.mode].label}</span>
              <Pill {...COVER_TEST_STATUS[t.status]} />
            </div>
          </div>
        </div>
        <div className="vp-ab-note">{COVER_TEST_MODE[t.mode].desc}；{new Date(t.started_at).toLocaleDateString('zh-CN')} 开始{t.ended_at ? `，${new Date(t.ended_at).toLocaleDateString('zh-CN')} 结束` : ''}</div>

        {t.status === 'running' && (
          <div className={cls('vp-ab-verdict', ready && 'ok')}>
            <RuleChips t={t} st={st} n={arms.length} />
            <span>{ready ? `可以判定了：${leader?.name ?? '领先的封面'}点击率领先 ${pct(st.gap, 0)}` : '条件还没全满足，先别下结论；曝光不够或天数太短时，点击率的差距可能只是噪声'}</span>
          </div>
        )}
        {t.status === 'decided' && <div className="vp-ab-verdict ok"><span><b>{coverOf(t.winner_id)?.name ?? '胜者'}</b> 胜出，已设为主封面；其余 {arms.length - 1} 张归档，留着不删</span></div>}
        {t.status === 'inconclusive' && <div className="vp-ab-verdict"><span>提前结束，没有判胜负；主封面不变</span></div>}

        <section className="field-group">
          <div className="field-group-title">各版封面</div>
          <div className="vp-ab-arms">
            {arms.map((a) => {
              const c = coverOf(a.cover_id)
              const acc = accountOf(a.publish?.account_id)
              const imp = (a.impressions ?? 0) >= t.min_impressions
              const won = t.status === 'decided' && t.winner_id === a.cover_id
              return (
                <div key={a.cover_id} className={cls('vp-ab-arm', won && 'won', t.status === 'running' && st.leader === a.cover_id && 'lead')}>
                  {c ? <CoverSwatch ratio={coverRatioOf(c)} option={c.option} title={c.path} /> : <span className="faint">封面已删除</span>}
                  <div className="vp-ab-arm-main">
                    <div className="vp-ab-arm-head">
                      <b>{c?.name ?? '已删除的封面'}</b>
                      {c && <span className="faint">{COVER_RATIO[coverRatioOf(c)].label}</span>}
                      {won && <span className="vp-ab-badge ok">主封面</span>}
                      {t.status === 'decided' && !won && <span className="vp-ab-badge">已归档</span>}
                      {t.status === 'running' && st.leader === a.cover_id && <span className="vp-ab-badge lead">领先</span>}
                    </div>
                    <div className="vp-ab-arm-sub">
                      {t.mode === 'accounts' ? (a.publish ? <>
                        <button className="link-btn" onClick={() => onOpenPublish(a.publish!.id)}>{acc ? acc.handle : '没挂账号'}</button>
                        {acc && <span className="faint">{ACCOUNT_ROLE[acc.role].label}</span>}
                      </> : <span className="faint">还没有用这张封面的发布，去新建发布选 A/B 小号发一版</span>) : <span className="faint">平台按封面分开给数据</span>}
                    </div>
                    <div className="vp-ab-bar"><span style={{ width: `${((a.ctr ?? 0) / maxCtr) * 100}%` }} /></div>
                    <div className="vp-ab-arm-nums">
                      <span>点击率 <b>{pct(a.ctr)}</b></span>
                      <span className={cls(imp ? 'vp-tone-ok' : 'vp-tone-warn')}>曝光 {num(a.impressions)}{imp ? '' : `，差 ${num(t.min_impressions - (a.impressions ?? 0))}`}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
        {!onArtifacts && t.status === 'running' && <div className="vp-ab-note">判定后胜者会设为这一集的主封面，其余封面标归档</div>}
      </div>
      {t.status === 'running' && (
        <div className="drawer-foot">
          {confirm ? (
            <>
              <span className="danger-text">{confirm === 'early' ? `条件没满足，按现在的数据采用${leader?.name ?? '领先的封面'}？` : '结束测试，不判胜负，主封面不变？'}</span>
              <div className="spacer" />
              <button className="btn btn-ghost" onClick={() => setConfirm(null)}>取消</button>
              <button className="btn btn-primary" onClick={() => (confirm === 'early' ? st.leader && decide(st.leader) : stop())}>{confirm === 'early' ? '仍然采用' : '结束'}</button>
            </>
          ) : (
            <>
              <button className="btn btn-ghost" onClick={() => setConfirm('stop')}>结束，不判胜负</button>
              <div className="spacer" />
              <button className="btn btn-outline" onClick={pull}>模拟拉取数据</button>
              {ready ? <button className="btn btn-primary" onClick={() => st.leader && decide(st.leader)}>采用胜者</button>
                : <button className="btn btn-outline" disabled={!st.leader} onClick={() => setConfirm('early')}>提前采用领先的</button>}
            </>
          )}
        </div>
      )}
    </>
  )
}

const MAX_ARMS = 5
function NewTest({ videos, artifacts, publishes, defaultVideo, onClose, onCreated }: {
  videos: Video[]; artifacts: Artifact[]; publishes: Publish[]; defaultVideo?: string; onClose: () => void; onCreated: (id: string) => void
}) {
  // 只列出了两张以上封面的集
  const hasCovers = (id: string) => artifacts.filter((a) => a.video_id === id && a.kind === 'cover').length >= 2
  const pool = videos.filter((v) => hasCovers(v.id))
  const [vid, setVid] = useState((pool.find((v) => v.id === defaultVideo) ?? pool[0])?.id ?? '')
  const [plat, setPlat] = useState<PlatformKey>('channels')
  const [mode, setMode] = useState<CoverTestMode>('accounts')
  const [picked, setPicked] = useState<string[]>([])
  const [tried, setTried] = useState(false)
  const options = [...pool].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((v) => ({ value: v.id, label: v.title || '未命名视频' }))
  const platform = PLATFORMS.find((p) => p.key === plat)!
  // 原生测试只有 YouTube 和 B 站有
  const nativeOk = plat === 'youtube' || plat === 'bilibili'
  const covers = artifacts.filter((a) => a.video_id === vid && a.kind === 'cover' && platform.cover.includes(coverRatioOf(a)))
    .sort((a, b) => platform.cover.indexOf(coverRatioOf(a)) - platform.cover.indexOf(coverRatioOf(b)) || (a.option ?? 0) - (b.option ?? 0))
  const pubOf = (coverId: string) => publishes.find((p) => p.video_id === vid && p.platform === plat && p.cover_id === coverId)
  const errors = [
    !vid && '先选一个视频',
    picked.length < 2 && '至少选 2 张封面',
    picked.length > MAX_ARMS && `最多 ${MAX_ARMS} 张封面`,
  ].filter(Boolean) as string[]

  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : picked.length >= MAX_ARMS ? picked : [...picked, id])
  const changePlat = (k: PlatformKey) => { setPlat(k); setPicked([]); if (!(k === 'youtube' || k === 'bilibili')) setMode('accounts') }
  const start = () => {
    setTried(true)
    if (errors.length) return
    const arms = picked.map((id) => (mode === 'accounts' ? { cover_id: id, publish_id: pubOf(id)?.id } : { cover_id: id, impressions: 0 }))
    const id = newTestId()
    pubStore.addTest({ id, video_id: vid, platform: plat, mode, arms, started_at: new Date().toISOString(), min_days: 7, min_impressions: 10000, min_gap: 0.2, status: 'running' })
    onCreated(id)
  }

  return (
    <>
      <div className="drawer-body form">
        <label className="field">
          <span className="field-label">视频<em>*</em><span className="field-hint">只列出了两张以上封面的集</span></span>
          <SearchSelect variant="field" value={vid} placeholder={pool.length ? '选一个视频' : '还没有出了几版封面的视频'} searchPlaceholder="搜标题"
            options={options} emptyText="还没有出了几版封面的视频" missingLabel={() => '已删除的视频'} disabled={!pool.length}
            onChange={(v) => { if (v) { setVid(v); setPicked([]) } }} />
        </label>
        <div className="field">
          <span className="field-label">平台</span>
          <div className="vp-chips">
            {PLATFORMS.map((p) => (
              <button key={p.key} type="button" className={cls('chip vp-plat-chip', plat === p.key && 'chip-on')} style={{ '--c': p.color } as React.CSSProperties} onClick={() => changePlat(p.key)}><i />{p.label}</button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field-label">怎么测</span>
          <div className="seg seg-full">
            <button className={cls(mode === 'accounts' && 'on')} onClick={() => setMode('accounts')}>{COVER_TEST_MODE.accounts.label}</button>
            <button className={cls(mode === 'native' && 'on')} disabled={!nativeOk} title={nativeOk ? undefined : `${platform.label}没有原生封面测试`} onClick={() => setMode('native')}>{COVER_TEST_MODE.native.label}</button>
          </div>
          <span className="field-hint-line">{COVER_TEST_MODE[mode].desc}{!nativeOk && `；${platform.label}没有原生测试，只能靠小号`}</span>
        </div>
        <div className="field">
          <span className="field-label">封面<em>*</em><span className="field-hint">选 2 到 {MAX_ARMS} 张，{platform.label}收 {platform.cover.map((r) => COVER_RATIO[r].label).join('、')}；已选 {picked.length} 张</span></span>
          {covers.length ? (
            <div className="vp-covers">
              {covers.map((a) => {
                const p = mode === 'accounts' ? pubOf(a.id) : undefined
                const acc = accountOf(p?.account_id)
                return (
                  <span key={a.id} className="vp-cover-opt">
                    <CoverSwatch ratio={coverRatioOf(a)} option={a.option} on={picked.includes(a.id)} title={`${a.name} · ${a.path}`} onClick={() => toggle(a.id)} />
                    <span className="vp-cover-cap">{COVER_RATIO[coverRatioOf(a)].label} · 版本 {a.option ?? '-'}</span>
                    {mode === 'accounts' && picked.includes(a.id) && <span className={cls('vp-cover-cap', p && 'used')}>{p ? acc?.handle ?? '已有发布' : '还没发'}</span>}
                  </span>
                )
              })}
            </div>
          ) : <div className="mount-empty">这集还没有 {platform.label}收的比例的封面</div>}
          {mode === 'accounts' && picked.some((id) => !pubOf(id)) && <div className="vp-hint">标「还没发」的封面，建好测试后去新建发布，选 A/B 小号各发一版；发出去才有数据</div>}
        </div>
        <div className="vp-ab-note">判定规则：每张曝光到 1 万、观察满 7 天、点击率第一领先第二 20% 以上</div>
      </div>
      <div className="drawer-foot">
        <div className="spacer" />
        {tried && errors.length > 0 && <span className="field-err">{errors[0]}</span>}
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={!pool.length} onClick={start}>开始测试</button>
      </div>
    </>
  )
}
