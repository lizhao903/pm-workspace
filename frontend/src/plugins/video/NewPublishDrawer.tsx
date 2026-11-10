// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 新建发布（SPEC-videos-8，照原型 videopublish.tsx 的 NewPublishDrawer）：选视频、平台、账号、比例、封面，写标题简介标签，按平台规则边改边校验，
// 有一项不过就不能提交。接通了上传接口的平台才自动发（建好后马上投稿，或定时），其余只登记一条「计划中」，发完回来填链接
import { useMemo, useState, type CSSProperties } from 'react'
import {
  errorText, useCreatePublish, useVideoArtifacts, type VideoAccount, type VideoArtifact, type VideoOrientation, type VideoPlatform,
  type VideoPlatformInfo, type VideoPublish, type Video,
} from '../../core/data'
import { Button, Drawer, Field, Input, SearchSelect, Select, Textarea, cls } from '../../core/ui'
import { COVER_RATIO, coverRatioOf } from './artifactModel'
import { ORIENT, ORIENTS, videoState } from './model'
import { CoverSwatch } from './publishParts'
import {
  ACCOUNT_ROLE, PLATFORM_KEYS, PLATFORM_META, channelOf, checkPublish, coversFor, isPast, mainAccount, parseTags, ratiosText, tomorrow10,
} from './publishModel'

const pickVariant = (v: Video | undefined, k: VideoPlatform): VideoOrientation => {
  const prefer = PLATFORM_META[k].prefer
  return v?.orientations.includes(prefer) ? prefer : v?.orientations[0] ?? prefer
}

export function NewPublishDrawer({ videos, platforms, accounts, covers, defaultVideo, onClose, onCreated, onConnect }: {
  videos: Video[]
  platforms: VideoPlatformInfo[]
  accounts: VideoAccount[]
  covers: VideoArtifact[]
  defaultVideo?: string
  onClose: () => void
  /** 建好了；now 为 true 时接着投稿 */
  onCreated: (p: VideoPublish, now: boolean) => void
  /** 去设置里接入或修复连接器；tool 是平台对应的连接器工具，连接器页据此直接打开抽屉 */
  onConnect: (tool: string | undefined) => void
}) {
  const create = useCreatePublish()
  const sorted = useMemo(() => [...videos].sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [videos])
  const first = videos.find((v) => v.id === defaultVideo) ?? sorted[0]
  const [vid, setVid] = useState(first?.id ?? '')
  const [plat, setPlat] = useState<VideoPlatform>('bilibili')
  const [variant, setVariant] = useState<VideoOrientation>(() => pickVariant(first, 'bilibili'))
  const [cover, setCover] = useState('')
  const [title, setTitle] = useState(first?.title ?? '')
  const [desc, setDesc] = useState('')
  const [mode, setMode] = useState<'now' | 'later'>('now')
  const [at, setAt] = useState(() => tomorrow10())
  const [tried, setTried] = useState(false)
  const [descHint, setDescHint] = useState('')
  /** 点提交时已经过去的定时时间；改了时间提示就消失 */
  const [pastAt, setPastAt] = useState('')
  const [account, setAccount] = useState(() => mainAccount(accounts, 'bilibili') ?? '')
  const [tagText, setTagText] = useState('')
  const [category, setCategory] = useState('')
  const [collection, setCollection] = useState('')
  const arts = useVideoArtifacts(vid || null)

  const video = videos.find((v) => v.id === vid)
  const info = platforms.find((p) => p.key === plat)
  const label = info?.label ?? PLATFORM_META[plat].label
  const ratios = info?.covers ?? []
  const options = sorted.map((v) => ({ value: v.id, label: v.title || '未命名视频', hint: videoState(v).label, keywords: v.root }))
  const list = coversFor(covers, vid, ratios, variant)
  const mine = arts.data ?? []
  const descArt = mine.filter((a) => a.kind === 'description').sort((a, b) => b.version - a.version)[0]
  const prefer = PLATFORM_META[plat].prefer
  const missPrefer = video && !video.orientations.includes(prefer)

  const changeVideo = (id: string) => {
    const v = videos.find((x) => x.id === id)
    if (!title.trim() || title === (video?.title ?? '')) setTitle(v?.title ?? '')
    setVid(id); setVariant(pickVariant(v, plat)); setCover(''); setDescHint('')
  }
  const changePlat = (k: VideoPlatform) => { setPlat(k); setVariant(pickVariant(video, k)); setCover(''); setAccount(mainAccount(accounts, k) ?? ''); setCategory('') }
  const fillDesc = () => {
    if (!descArt) { setDescHint('这集还没有简介产出物，先在分发包阶段出简介，或者直接手写'); return }
    setDesc(`${video?.title ?? ''}\n\n（取自简介产出物 ${descArt.path}，第 ${descArt.version} 版，${descArt.status === 'final' || descArt.status === 'published' ? '已定稿' : '还没定稿'}）`)
    setDescHint('')
  }

  // 平台规则校验：有一项不过就不让发
  const tags = parseTags(tagText)
  const coverArt = cover ? covers.find((a) => a.id === cover) : undefined
  const duration = mine.filter((a) => a.kind === 'video' && a.variant === variant).sort((a, b) => b.version - a.version)[0]?.duration
  const checks = info ? checkPublish(info.rule, label, { title, desc, tags, cover: coverArt && coverRatioOf(coverArt), duration }) : []
  const failed = checks.filter((c) => !c.ok)
  const titleLen = [...title.trim()].length
  const plAccounts = accounts.filter((a) => a.platform === plat)
  const chan = channelOf(info)
  const auto = chan.state === 'ok'

  const when = new Date(at)
  const errors = [
    !video && '先选一个视频',
    !title.trim() && '标题必填',
    ...failed.map((c) => c.text),
    mode === 'later' && Number.isNaN(when.getTime()) && '选一个定时时间',
    mode === 'later' && pastAt === at && '定时时间要晚于现在',
  ].filter(Boolean) as string[]

  const submit = () => {
    setTried(true)
    // 定时时间早不早只在点的时候看，渲染时不读当前时间
    if (mode === 'later' && isPast(at)) { setPastAt(at); return }
    if (errors.length || create.isPending) return
    create.reset()
    create.mutate({
      video_id: vid, platform: plat, variant, cover_id: cover || undefined, title: title.trim(), desc: desc.trim(),
      status: auto && mode === 'later' ? 'scheduled' : 'planned', scheduled_at: mode === 'later' ? when.toISOString() : undefined,
      account_id: account || undefined, tags: tags.length ? tags : undefined, category: category || undefined, collection: collection.trim() || undefined,
    }, { onSuccess: (p) => onCreated(p, auto && mode === 'now') })
  }

  return (
    <Drawer open onClose={onClose} kicker="新建发布" aria-label="新建发布" className="vd-drawer vp-drawer"
      footer={(close) => (
        <>
          <span className="spacer" />
          {(tried || failed.length > 0) && errors.length > 0 && <span className="field-err" role="alert">{errors[0]}</span>}
          <Button onClick={close}>取消</Button>
          <Button variant="primary" disabled={!videos.length || failed.length > 0 || create.isPending} title={failed[0]?.text} onClick={submit}>
            {!auto ? '登记发布记录' : mode === 'now' ? '立即发布' : '定时发布'}
          </Button>
        </>
      )}>
      <div className="vd-form">
        {create.error && <div className="vd-err" role="alert">{errorText(create.error)}</div>}
        <Field label="视频" required wrap={false} hint={video && `出了 ${video.orientations.map((o) => ORIENT[o].label).join('、') || '还没定比例'}，现在在「${videoState(video).label}」`}>
          <SearchSelect variant="field" value={vid} aria-label="视频" placeholder={videos.length ? '选一个视频' : '还没有视频'} searchPlaceholder="搜标题或目录"
            options={options} emptyText="还没有视频" missingLabel={() => '已删除的视频'} disabled={!videos.length}
            onChange={(v) => { if (v) changeVideo(v) }} />
        </Field>

        <Field label="平台" wrap={false}>
          <div className="vp-chips" role="radiogroup" aria-label="平台">
            {PLATFORM_KEYS.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={plat === k} className={cls('chip vp-plat-chip', plat === k && 'chip-on')}
                style={{ '--c': PLATFORM_META[k].color } as CSSProperties} onClick={() => changePlat(k)}>
                <i aria-hidden="true" />{PLATFORM_META[k].label}<span className="seg-n">偏好{ORIENT[PLATFORM_META[k].prefer].label}</span>
              </button>
            ))}
          </div>
        </Field>

        <Field label={<>账号<span className="vd-hint">封面 A/B 用小号各发一版</span></>} wrap={false}>
          {plAccounts.length ? (
            <div className="vp-chips" role="radiogroup" aria-label="账号">
              {plAccounts.map((a) => (
                <button key={a.id} type="button" role="radio" aria-checked={account === a.id} className={cls('chip', account === a.id && 'chip-on')} onClick={() => setAccount(a.id)}>
                  {a.handle}<span className="seg-n">{ACCOUNT_ROLE[a.role]}</span>
                </button>
              ))}
            </div>
          ) : <div className="vd-col-empty">还没有{label}账号，这条记录先不挂账号；接入连接器后账号会出现在这里</div>}
        </Field>

        <Field label={<>画面比例<span className="vd-hint">只能选这集做了的比例</span></>} wrap={false}>
          <div className="vd-sort vd-seg-full" role="radiogroup" aria-label="画面比例">
            {ORIENTS.map((o) => {
              const has = !!video?.orientations.includes(o)
              return (
                <button key={o} type="button" role="radio" aria-checked={variant === o} disabled={!has} className={cls(variant === o && 'on')}
                  title={has ? undefined : '这集没做这个比例'} onClick={() => { setVariant(o); setCover('') }}>
                  {ORIENT[o].label} {ORIENT[o].ratio}{o === prefer && <span className="seg-n"> 推荐</span>}
                </button>
              )
            })}
          </div>
          {missPrefer && <div className="vp-hint">这集没出{ORIENT[prefer].label}版，{label}建议{ORIENT[prefer].label}</div>}
        </Field>

        {chan.state !== 'ok' && (
          <div className="vp-hint vp-conn" role="status">
            <span>{chan.state === 'none' ? `还没接入${label}，只能登记发布记录，不能自动上传和拉数据。`
              : chan.state === 'error' ? `${chan.name ?? label}连接异常：${chan.error || '请重新授权'}。修好之前只能登记。`
                : chan.state === 'manual' ? `${label}不开放发布接口，请在 App 或创作者中心发布后回来填链接；数据会自动拉取。`
                  : `${label}不开放发布接口，只能登记发布记录，发完回来填链接、手填数据。`}</span>
            {(chan.state === 'none' || chan.state === 'error') && <button type="button" className="vd-link" onClick={() => onConnect(info?.tool)}>{chan.state === 'none' ? '去接入' : '去修复'}</button>}
          </div>
        )}

        <Field label={<>封面<span className="vd-hint">{label}收 {ratiosText(ratios)} 的封面；这集{ORIENT[variant].label}有 {list.length} 张</span></>} wrap={false}>
          {list.length ? (
            <div className="vp-covers">
              {list.map((a) => (
                <span key={a.id} className="vp-cover-opt">
                  <CoverSwatch a={a} on={cover === a.id} onClick={() => setCover(cover === a.id ? '' : a.id)} />
                  <span className={cls('vp-cover-cap', a.status === 'published' && 'used')}>{COVER_RATIO[coverRatioOf(a)].label} · {a.status === 'published' ? '用过' : `版本 ${a.option ?? '-'}`}</span>
                </span>
              ))}
            </div>
          ) : <div className="vd-col-empty">这集还没有 {ratiosText(ratios)} 的{ORIENT[variant].label}封面，先在分发包阶段出封面；不选也能发</div>}
        </Field>

        <Field label={<>标题<span className={cls('vd-hint', info && titleLen > info.rule.title_max && 'vp-bad')}>{titleLen} / {info?.rule.title_max ?? '-'} 字</span></>} required>
          <Input value={title} invalid={(tried && !title.trim()) || (!!info && titleLen > info.rule.title_max)} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="field">
          <span className="field-label vp-label-row">
            <span>简介</span><span className="spacer" />
            <Button size="sm" onClick={fillDesc}>从简介产出物带入</Button>
          </span>
          <Textarea rows={4} aria-label="简介" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="平台显示的简介" />
          {descHint && <span className="vp-hint">{descHint}</span>}
        </div>
        <Field label={<>标签<span className="vd-hint">逗号或空格分开，{label}最多 {info?.rule.tags_max ?? '-'} 个</span></>}>
          <Input value={tagText} invalid={!!info && tags.length > info.rule.tags_max} onChange={(e) => setTagText(e.target.value)} placeholder="效率工具，待办" />
        </Field>
        <div className="vd-field-row">
          {info?.rule.categories?.length ? (
            <Field label="分区">
              <Select value={category} onValueChange={setCategory} options={[{ value: '', label: '不选' }, ...info.rule.categories.map((c) => ({ value: c, label: c }))]} />
            </Field>
          ) : null}
          <Field label="合集">
            <Input value={collection} onChange={(e) => setCollection(e.target.value)} placeholder={video?.series_id ? '比如系列名' : '可空'} />
          </Field>
        </div>

        <Field label={<>发布前校验<span className="vd-hint">按{label}的规则；有一项不过不能发</span></>} wrap={false}>
          <ul className="vp-checks" aria-label="发布前校验">
            {checks.map((c) => <li key={c.key} className={cls(!c.ok && 'bad')}><span className="vp-check-mark">{c.ok ? '通过' : '不通过'}</span>{c.text}</li>)}
          </ul>
        </Field>

        <Field label="什么时候发" wrap={false}>
          <div className="vd-sort vd-seg-full" role="radiogroup" aria-label="什么时候发">
            <button type="button" role="radio" aria-checked={mode === 'now'} className={cls(mode === 'now' && 'on')} onClick={() => setMode('now')}>立即发布</button>
            <button type="button" role="radio" aria-checked={mode === 'later'} className={cls(mode === 'later' && 'on')} onClick={() => setMode('later')}>定时发布</button>
          </div>
          {mode === 'later' && <Input type="datetime-local" aria-label="定时时间" className="vp-dt" value={at} onChange={(e) => setAt(e.target.value)} />}
        </Field>
      </div>
    </Drawer>
  )
}
