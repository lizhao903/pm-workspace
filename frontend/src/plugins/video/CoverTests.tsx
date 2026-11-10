// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 封面 A/B（SPEC-videos-7.15、SPEC-videos-14，照原型 web-next/src/covertest.tsx）：发布记录页上的「封面 A/B」一节和测试抽屉。
// 判定在后端（VID-05b）：快照落库、新建、修改、evaluate 后重算，到线了自动判出，胜者设为主封面、其余归档。
// 原型的「模拟拉取数据」换成：小号分发经连接器拉各条发布的数据，原生测试手动回填各版的曝光、点击率；
// 「提前采用领先的」「结束，不判胜负」走手动判定接口 decide（VID-05d），门槛不动
import { useMemo, useState, type CSSProperties } from 'react'
import {
  errorText, useCreateCoverTest, useDecideCoverTest, useEvaluateCoverTest, usePatchCoverTest, useSyncPublish,
  type Video, type VideoAccount, type VideoArtifact, type VideoCoverTest, type VideoCoverTestMode, type VideoPlatform, type VideoPlatformInfo, type VideoPublish,
} from '../../core/data'
import { Button, Drawer, Input, Pill, SearchSelect, cls } from '../../core/ui'
import { COVER_RATIO, coverRatioOf } from './artifactModel'
import { timeAgo } from './model'
import { CoverSwatch, PlatformTag, RuleChips } from './publishParts'
import {
  ACCOUNT_ROLE, COVER_TEST_MODE, COVER_TEST_STATUS, MAX_ARMS, PLATFORM_KEYS, PLATFORM_META, armNums, badArmCtr, badArmImp, canSync,
  coversFor, nativeTestOk, num, pct, ratiosText,
} from './publishModel'

const titleOf = (videos: Video[], id: string) => {
  const v = videos.find((x) => x.id === id)
  return v ? v.title || '未命名视频' : '已删除的视频'
}

/** 发布记录页上的「封面 A/B」一节：每个测试一行，进行中的排前面，点开看详情 */
export function CoverTestSection({ tests, videos, covers, videoId, onOpen, onNew }: {
  tests: VideoCoverTest[]
  videos: Video[]
  covers: VideoArtifact[]
  videoId?: string
  onOpen: (id: string) => void
  onNew: () => void
}) {
  const xs = (videoId ? tests.filter((t) => t.video_id === videoId) : tests)
    .sort((a, b) => Number(a.status !== 'running') - Number(b.status !== 'running') || b.started_at.localeCompare(a.started_at))
  const coverOf = (id?: string) => covers.find((a) => a.id === id)
  return (
    <section className="vd-sec" aria-label="封面 A/B">
      <div className="vp-sec-head">
        <span className="vd-sec-title">封面 A/B<span className="vd-hint">每张曝光到 1 万、观察满 7 天、点击率领先 20% 才判胜负</span></span>
        <span className="spacer" />
        <Button size="sm" variant="outline" onClick={onNew}>新建测试</Button>
      </div>
      {xs.length ? (
        <div className="vp-ab-list">
          {xs.map((t) => {
            const win = coverOf(t.winner_id)
            return (
              <button key={t.id} type="button" className="vp-ab-row" onClick={() => onOpen(t.id)}>
                <span className="vp-ab-covers">
                  {t.arms.map((a) => {
                    const c = coverOf(a.cover_id)
                    return c ? <CoverSwatch key={a.cover_id} a={c} size="sm" /> : null
                  })}
                </span>
                <span className="vp-main">
                  <span className="vp-title ellipsis">{titleOf(videos, t.video_id)}</span>
                  <span className="vp-sub vp-ab-meta"><PlatformTag k={t.platform} /><span>{COVER_TEST_MODE[t.mode].label}</span><span>{t.arms.length} 张封面</span></span>
                </span>
                <span className="vp-ab-prog">
                  {t.status === 'running' ? <RuleChips t={t} />
                    : t.status === 'decided' ? <span className="vd-muted">{win ? `${win.name} 胜出` : '已决出'}{t.ended_at ? `，${timeAgo(t.ended_at)}结束` : ''}</span>
                      : <span className="vd-muted">提前结束，没有判胜负</span>}
                </span>
                <Pill {...COVER_TEST_STATUS[t.status]} />
              </button>
            )
          })}
        </div>
      ) : <div className="vd-col-empty">{videoId ? '这一集还没做过封面测试' : '还没有封面测试'}；同一集出了几版封面，可以用 A/B 小号各发一版比点击率</div>}
    </section>
  )
}

/** 封面 A/B 抽屉：看一个测试，或新建一个 */
export function CoverTestDrawer({ test, videos, covers, publishes, accounts, platforms, defaultVideo, onClose, onCreated, onOpenPublish }: {
  /** 不传是新建 */
  test?: VideoCoverTest
  videos: Video[]
  covers: VideoArtifact[]
  publishes: VideoPublish[]
  accounts: VideoAccount[]
  platforms: VideoPlatformInfo[]
  defaultVideo?: string
  onClose: () => void
  onCreated: (id: string) => void
  onOpenPublish: (id: string) => void
}) {
  if (test) {
    return <TestView t={test} videos={videos} covers={covers} publishes={publishes} accounts={accounts} platforms={platforms} onClose={onClose} onOpenPublish={onOpenPublish} />
  }
  return <NewTest videos={videos} covers={covers} publishes={publishes} accounts={accounts} platforms={platforms} defaultVideo={defaultVideo} onClose={onClose} onCreated={onCreated} />
}

function TestView({ t, videos, covers, publishes, accounts, platforms, onClose, onOpenPublish }: {
  t: VideoCoverTest
  videos: Video[]
  covers: VideoArtifact[]
  publishes: VideoPublish[]
  accounts: VideoAccount[]
  platforms: VideoPlatformInfo[]
  onClose: () => void
  onOpenPublish: (id: string) => void
}) {
  const patch = usePatchCoverTest()
  const evaluate = useEvaluateCoverTest()
  const decide = useDecideCoverTest()
  const sync = useSyncPublish()
  const [confirm, setConfirm] = useState<'early' | 'stop' | null>(null)
  const [fill, setFill] = useState<Record<string, { imp: string; ctr: string }> | null>(null)
  const [pulling, setPulling] = useState(false)
  const [pullErr, setPullErr] = useState('')
  const st = t.state
  const ready = st.days_ok && st.imp_ok && st.gap_ok
  const coverOf = (id?: string) => covers.find((a) => a.id === id)
  const leader = coverOf(st.leader)
  const arms = t.arms.map((a) => ({ ...a, ...armNums(t, a.cover_id), publish: a.publish_id ? publishes.find((p) => p.id === a.publish_id) : undefined }))
  const maxCtr = Math.max(0.0001, ...arms.map((a) => a.ctr ?? 0))
  const busy = patch.isPending || evaluate.isPending || decide.isPending || pulling
  const failure = patch.error ?? evaluate.error ?? decide.error
  const platform = platforms.find((p) => p.key === t.platform)
  const pullable = t.mode === 'accounts' && canSync(platform) && arms.some((a) => a.publish?.status === 'published' && a.publish.url)

  const clear = () => { patch.reset(); evaluate.reset(); decide.reset(); setPullErr('') }
  // 提前采用传领先的封面，不判胜负不传
  const decideNow = (winnerId?: string) => { if (!busy) { clear(); decide.mutate({ id: t.id, winnerId }, { onSettled: () => setConfirm(null) }) } }
  const reEvaluate = () => { if (!busy) { clear(); evaluate.mutate(t.id) } }
  // 小号分发：各条已发布、有链接的发布逐条拉一次，拉到数据后端自己重算
  const pull = async () => {
    if (busy) return
    clear()
    setPulling(true)
    const errs: string[] = []
    for (const a of arms) {
      if (a.publish?.status !== 'published' || !a.publish.url) continue
      try { await sync.mutateAsync(a.publish.id) } catch (e) { errs.push(`${coverOf(a.cover_id)?.name ?? '封面'}：${errorText(e)}`) }
    }
    setPulling(false)
    setPullErr(errs.join('；'))
  }
  const startFill = () => setFill(Object.fromEntries(arms.map((a) => [a.cover_id, { imp: a.impressions == null ? '' : String(a.impressions), ctr: a.ctr == null ? '' : String(+(a.ctr * 100).toFixed(2)) }])))
  const fillBad = !!fill && Object.values(fill).some((x) => badArmImp(x.imp) || badArmCtr(x.ctr))
  const saveFill = () => {
    if (!fill || fillBad || busy) return
    clear()
    patch.mutate({
      id: t.id,
      patch: { arms: t.arms.map((a) => {
        const x = fill[a.cover_id]
        return { cover_id: a.cover_id, impressions: x.imp.trim() ? Number(x.imp) : null, ctr: x.ctr.trim() ? +(Number(x.ctr) / 100).toFixed(4) : null }
      }) },
    }, { onSuccess: () => setFill(null) })
  }

  return (
    <Drawer open onClose={onClose} kicker="封面 A/B 测试" aria-label="封面 A/B 测试" className="vd-drawer vp-drawer"
      footer={t.status !== 'running' ? undefined : confirm ? (
        <>
          <span className="vd-danger-text">{confirm === 'early' ? `条件没满足，按现在的数据采用${leader?.name ?? '领先的封面'}？` : '结束测试，不判胜负，主封面不变？'}</span>
          <span className="spacer" />
          <Button onClick={() => setConfirm(null)}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={() => decideNow(confirm === 'early' ? st.leader : undefined)}>{confirm === 'early' ? '仍然采用' : '结束'}</Button>
        </>
      ) : (
        <>
          <Button disabled={busy} onClick={() => setConfirm('stop')}>结束，不判胜负</Button>
          <span className="spacer" />
          {pullable && <Button variant="outline" disabled={busy} onClick={() => void pull()}>{pulling ? '拉取中…' : '拉取数据'}</Button>}
          {t.mode !== 'accounts' && !fill && <Button variant="outline" disabled={busy} onClick={startFill}>回填各版数据</Button>}
          {ready ? <Button variant="primary" disabled={busy} onClick={reEvaluate}>采用胜者</Button>
            : <>
              <Button disabled={busy} onClick={reEvaluate}>重新判定</Button>
              <Button variant="outline" disabled={busy || !st.leader} title={st.leader ? undefined : '还没有封面有点击率'}
                onClick={() => setConfirm('early')}>提前采用领先的</Button>
            </>}
        </>
      )}>
      <div className="vd-form">
        <div className="vp-pub-head">
          <h2 className="vp-pub-title">{titleOf(videos, t.video_id)}</h2>
          <div className="vp-pub-sub">
            <PlatformTag k={t.platform} />
            <span className="vd-otag">{COVER_TEST_MODE[t.mode].label}</span>
            <Pill {...COVER_TEST_STATUS[t.status]} />
          </div>
        </div>
        <div className="vp-ab-note">
          {COVER_TEST_MODE[t.mode].desc}；{new Date(t.started_at).toLocaleDateString('zh-CN')} 开始{t.ended_at ? `，${new Date(t.ended_at).toLocaleDateString('zh-CN')} 结束` : ''}
        </div>
        {failure ? <div className="vd-err" role="alert">{errorText(failure)}</div> : null}
        {pullErr && <div className="vd-err" role="alert">{pullErr}</div>}

        {t.status === 'running' && (
          <div className={cls('vp-ab-verdict', ready && 'ok')} role="status">
            <RuleChips t={t} />
            <span>{ready ? `可以判定了：${leader?.name ?? '领先的封面'}点击率领先 ${pct(st.gap, 0)}` : '条件还没全满足，先别下结论；曝光不够或天数太短时，点击率的差距可能只是噪声'}</span>
          </div>
        )}
        {t.status === 'decided' && <div className="vp-ab-verdict ok" role="status"><span><b>{coverOf(t.winner_id)?.name ?? '胜者'}</b> 胜出，已设为主封面；其余 {t.arms.length - 1} 张归档，留着不删</span></div>}
        {t.status === 'inconclusive' && <div className="vp-ab-verdict" role="status"><span>没有判胜负就结束了；主封面不变</span></div>}

        <section className="vd-sec-plain" aria-label="各版封面">
          <div className="vd-sec-title">各版封面</div>
          <div className="vp-ab-arms">
            {arms.map((a) => {
              const c = coverOf(a.cover_id)
              const acc = accounts.find((x) => x.id === a.publish?.account_id)
              const imp = (a.impressions ?? 0) >= t.min_impressions
              const won = t.status === 'decided' && t.winner_id === a.cover_id
              const lead = t.status === 'running' && st.leader === a.cover_id
              const f = fill?.[a.cover_id]
              return (
                <div key={a.cover_id} className={cls('vp-ab-arm', won && 'won', lead && 'lead')}>
                  {c ? <CoverSwatch a={c} /> : <span className="vd-faint">封面已删除</span>}
                  <div className="vp-ab-arm-main">
                    <div className="vp-ab-arm-head">
                      <b>{c?.name ?? '已删除的封面'}</b>
                      {c && <span className="vd-faint">{COVER_RATIO[coverRatioOf(c)].label}</span>}
                      {won && <span className="vp-ab-badge ok">主封面</span>}
                      {t.status === 'decided' && !won && <span className="vp-ab-badge">已归档</span>}
                      {lead && <span className="vp-ab-badge lead">领先</span>}
                    </div>
                    <div className="vp-ab-arm-sub">
                      {t.mode === 'accounts' ? (a.publish ? <>
                        <button type="button" className="vd-link" onClick={() => onOpenPublish(a.publish!.id)}>{acc ? acc.handle : '没挂账号'}</button>
                        {acc && <span className="vd-faint">{ACCOUNT_ROLE[acc.role]}</span>}
                      </> : <span className="vd-faint">这条发布记录已经删除，读不到数据</span>) : <span className="vd-faint">平台按封面分开给数据</span>}
                    </div>
                    {f ? (
                      <div className="vp-ab-fill">
                        <label className="field"><span className="field-label">曝光</span>
                          <Input inputMode="numeric" value={f.imp} invalid={badArmImp(f.imp)} onChange={(e) => setFill({ ...fill, [a.cover_id]: { ...f, imp: e.target.value } })} /></label>
                        <label className="field"><span className="field-label">点击率<span className="vd-hint">%</span></span>
                          <Input inputMode="decimal" value={f.ctr} invalid={badArmCtr(f.ctr)} onChange={(e) => setFill({ ...fill, [a.cover_id]: { ...f, ctr: e.target.value } })} /></label>
                      </div>
                    ) : (
                      <>
                        <div className="vp-ab-bar"><span style={{ width: `${((a.ctr ?? 0) / maxCtr) * 100}%` } as CSSProperties} /></div>
                        <div className="vp-ab-arm-nums">
                          <span>点击率 <b>{pct(a.ctr)}</b></span>
                          <span className={imp ? 'vp-ok' : 'vd-warn-text'}>曝光 {num(a.impressions)}{imp ? '' : `，差 ${num(t.min_impressions - (a.impressions ?? 0))}`}</span>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          {fill && (
            <div className="vd-act-row">
              <Button size="sm" variant="primary" disabled={fillBad || busy} onClick={saveFill}>保存并重新判定</Button>
              <Button size="sm" onClick={() => setFill(null)}>取消</Button>
              {fillBad && <span className="field-err">曝光填非负整数，点击率填 0 到 100；没有的留空</span>}
            </div>
          )}
        </section>
        {t.status === 'running' && <div className="vp-ab-note">判定后胜者会设为这一集的主封面，其余封面标归档；小号分发的数据从各条发布读，到发布记录里回填或拉取</div>}
      </div>
    </Drawer>
  )
}

function NewTest({ videos, covers, publishes, accounts, platforms, defaultVideo, onClose, onCreated }: {
  videos: Video[]
  covers: VideoArtifact[]
  publishes: VideoPublish[]
  accounts: VideoAccount[]
  platforms: VideoPlatformInfo[]
  defaultVideo?: string
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const create = useCreateCoverTest()
  // 只列出了两张以上没归档的封面的集
  const live = useMemo(() => covers.filter((a) => a.kind === 'cover' && !a.archived), [covers])
  const pool = useMemo(() => videos.filter((v) => live.filter((a) => a.video_id === v.id).length >= 2)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [videos, live])
  const [vid, setVid] = useState(() => (pool.find((v) => v.id === defaultVideo) ?? pool[0])?.id ?? '')
  const [plat, setPlat] = useState<VideoPlatform>('channels')
  const [mode, setMode] = useState<VideoCoverTestMode>('accounts')
  const [picked, setPicked] = useState<string[]>([])
  const [tried, setTried] = useState(false)
  const info = platforms.find((p) => p.key === plat)
  const label = info?.label ?? PLATFORM_META[plat].label
  const nativeOk = nativeTestOk(plat)
  const ratios = info?.covers ?? []
  const list = coversFor(live, vid, ratios)
  const pubOf = (coverId: string) => publishes.find((p) => p.video_id === vid && p.platform === plat && p.cover_id === coverId)
  const missing = mode === 'accounts' ? picked.filter((id) => !pubOf(id)) : []
  const errors = [
    !vid && '先选一个视频',
    picked.length < 2 && '至少选 2 张封面',
    picked.length > MAX_ARMS && `最多 ${MAX_ARMS} 张封面`,
    missing.length > 0 && '标「还没发」的封面先去新建发布，选 A/B 小号各发一版；小号分发每张都要有一条发布',
  ].filter(Boolean) as string[]

  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : picked.length >= MAX_ARMS ? picked : [...picked, id])
  const changePlat = (k: VideoPlatform) => { setPlat(k); setPicked([]); if (!nativeTestOk(k)) setMode('accounts') }
  const start = () => {
    setTried(true)
    if (errors.length || create.isPending) return
    create.reset()
    // 原生测试是同一条发布：这集这个平台有发布记录就挂上第一条
    const shared = publishes.find((p) => p.video_id === vid && p.platform === plat)?.id
    const arms = picked.map((id) => (mode === 'accounts' ? { cover_id: id, publish_id: pubOf(id)!.id } : { cover_id: id, publish_id: shared }))
    create.mutate({ video_id: vid, platform: plat, mode, arms }, { onSuccess: (t) => onCreated(t.id) })
  }

  return (
    <Drawer open onClose={onClose} kicker="新建封面测试" aria-label="新建封面测试" className="vd-drawer vp-drawer"
      footer={(close) => (
        <>
          <span className="spacer" />
          {tried && errors.length > 0 && <span className="field-err" role="alert">{errors[0]}</span>}
          <Button onClick={close}>取消</Button>
          <Button variant="primary" disabled={!pool.length || create.isPending} onClick={start}>开始测试</Button>
        </>
      )}>
      <div className="vd-form">
        {create.error && <div className="vd-err" role="alert">{errorText(create.error)}</div>}
        <div className="field">
          <span className="field-label">视频<em aria-hidden="true">*</em><span className="vd-hint">只列出了两张以上封面的集</span></span>
          <SearchSelect variant="field" value={vid} aria-label="视频" placeholder={pool.length ? '选一个视频' : '还没有出了几版封面的视频'} searchPlaceholder="搜标题"
            options={pool.map((v) => ({ value: v.id, label: v.title || '未命名视频' }))} emptyText="还没有出了几版封面的视频"
            missingLabel={() => '已删除的视频'} disabled={!pool.length}
            onChange={(v) => { if (v) { setVid(v); setPicked([]) } }} />
        </div>
        <div className="field">
          <span className="field-label">平台</span>
          <div className="vp-chips" role="radiogroup" aria-label="平台">
            {PLATFORM_KEYS.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={plat === k} className={cls('chip vp-plat-chip', plat === k && 'chip-on')}
                style={{ '--c': PLATFORM_META[k].color } as CSSProperties} onClick={() => changePlat(k)}><i aria-hidden="true" />{PLATFORM_META[k].label}</button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field-label">怎么测</span>
          <div className="vd-sort vd-seg-full" role="radiogroup" aria-label="怎么测">
            <button type="button" role="radio" aria-checked={mode === 'accounts'} className={cls(mode === 'accounts' && 'on')} onClick={() => setMode('accounts')}>{COVER_TEST_MODE.accounts.label}</button>
            <button type="button" role="radio" aria-checked={mode === 'native'} className={cls(mode === 'native' && 'on')} disabled={!nativeOk}
              title={nativeOk ? undefined : `${label}没有原生封面测试`} onClick={() => setMode('native')}>{COVER_TEST_MODE.native.label}</button>
          </div>
          <span className="field-hint-line">{COVER_TEST_MODE[mode].desc}{!nativeOk && `；${label}没有原生测试，只能靠小号`}</span>
        </div>
        <div className="field">
          <span className="field-label">封面<em aria-hidden="true">*</em><span className="vd-hint">选 2 到 {MAX_ARMS} 张，{label}收 {ratiosText(ratios)}；已选 {picked.length} 张</span></span>
          {list.length ? (
            <div className="vp-covers">
              {list.map((a) => {
                const p = mode === 'accounts' ? pubOf(a.id) : undefined
                const acc = accounts.find((x) => x.id === p?.account_id)
                return (
                  <span key={a.id} className="vp-cover-opt">
                    <CoverSwatch a={a} on={picked.includes(a.id)} onClick={() => toggle(a.id)} />
                    <span className="vp-cover-cap">{COVER_RATIO[coverRatioOf(a)].label} · 版本 {a.option ?? '-'}</span>
                    {mode === 'accounts' && picked.includes(a.id) && <span className={cls('vp-cover-cap', p && 'used')}>{p ? acc?.handle ?? '已有发布' : '还没发'}</span>}
                  </span>
                )
              })}
            </div>
          ) : <div className="vd-col-empty">这集还没有 {label}收的比例的封面</div>}
          {missing.length > 0 && <div className="vp-hint">标「还没发」的封面，先去新建发布，选 A/B 小号各发一版，再回来建测试；发出去才有数据</div>}
        </div>
        <div className="vp-ab-note">判定规则：每张曝光到 1 万、观察满 7 天、点击率第一领先第二 20% 以上</div>
      </div>
    </Drawer>
  )
}
