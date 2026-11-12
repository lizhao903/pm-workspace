// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 视频详情的产出物（SPEC-videos-11）：按类型分块（顺序同 ARTIFACT_KIND），按比例区分的类型再按比例分栏；
// 封面在每个方向下按封面比例分组，每组 5 格，缺的格点一下预填登记表单。点产出物打开抽屉（地址里记 ?a=，刷新还在）
import type { UseQueryResult } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { errorText, useCreateArtifact, type Video, type VideoArtifact, type VideoArtifactInput } from '../../core/data'
import { Button, ErrorState, Field, Input, LoadingState, Pill, Select, cls } from '../../core/ui'
import {
  ARTIFACT_KIND, ARTIFACT_STATUS, COVER_OPTIONS, COVER_RATIO, DEFAULT_COVER_RATIOS, KINDS, coverRatioOf, coverRatios, defaultName, defaultRatio,
  fmtDuration, fullPath, isPicked, newDraft, parseDuration, patchDraft, ratioText, sourceText, variantCols, type NewArt,
} from './artifactModel'
import { ArtifactDrawer } from './ArtifactDrawer'
import { ORIENTS, STAGES, orientText, stageIndex } from './model'
import { CoverThumb, OrientShape } from './parts'

const stageName = (k: VideoArtifact['kind']) => STAGES[stageIndex(ARTIFACT_KIND[k].stage)]?.label ?? ''

export function ArtifactsTab({ v, query, draft, onDraft, openId, onOpen }: {
  v: Video
  query: UseQueryResult<VideoArtifact[]>
  draft: NewArt | null
  onDraft: (d: NewArt | null) => void
  openId: string | null
  onOpen: (id: string | null) => void
}) {
  const create = useCreateArtifact()
  if (query.isPending) return <LoadingState />
  if (query.isError) return <ErrorState title="产出物没加载出来" error={errorText(query.error)} onRetry={() => void query.refetch()} />
  const mine = query.data
  const opened = openId ? mine.find((a) => a.id === openId) : undefined

  const startNew = (kind: VideoArtifact['kind'], variant?: VideoArtifact['variant'], option?: number, ratio?: VideoArtifact['ratio']) => {
    create.reset()
    onDraft(newDraft(v, mine, kind, variant, option, ratio))
  }
  const patch = (x: Partial<NewArt>) => { if (draft) onDraft(patchDraft(draft, x, v, mine)) }

  const register = () => {
    if (!draft || create.isPending) return
    const K = ARTIFACT_KIND[draft.kind]
    const body: VideoArtifactInput & { video_id: string; kind: VideoArtifact['kind'] } = {
      video_id: v.id, kind: draft.kind, name: draft.name.trim() || defaultName(draft.kind, draft.option), path: draft.path.trim(),
    }
    if (K.perVariant && draft.variant) body.variant = draft.variant
    if (draft.kind === 'cover') {
      body.option = draft.option
      // 和方向同比例的封面不传 ratio，按默认算；别的封面比例才传
      if (draft.ratio && draft.ratio !== defaultRatio(draft.variant)) body.ratio = draft.ratio
    }
    if (draft.kind === 'subtitle') body.lang = 'zh'
    if (draft.kind === 'audio' || draft.kind === 'video') {
      const d = parseDuration(draft.duration)
      if (d !== undefined) body.duration = d
    }
    create.mutate(body, { onSuccess: () => onDraft(null) })
  }

  const row = (a: VideoArtifact) => (
    <button key={a.id} type="button" className={cls('vd-art-row', openId === a.id && 'sel')} onClick={() => onOpen(a.id)}>
      <span className="vd-art-main">
        <span className="ellipsis vd-art-name">{a.name}</span>
        <code className="ellipsis vd-path" title={fullPath(v, a)}>{fullPath(v, a)}</code>
      </span>
      <span className="vd-art-meta">
        <span className="vd-ver">v{a.version}</span>
        <Pill {...ARTIFACT_STATUS[a.status]} />
        <span className="vd-src-tag ellipsis" title={a.source.label}>{sourceText(a.source)}</span>
        {a.duration !== undefined && <span className="vd-dur">{fmtDuration(a.duration)}</span>}
        {a.reviews.length > 0 && <span className="vd-muted">验收 {a.reviews.length} 次</span>}
      </span>
    </button>
  )

  const coverGroups = (o: NonNullable<VideoArtifact['variant']>, xs: VideoArtifact[]) => coverRatios(o, xs).map((r) => {
    const rs = xs.filter((a) => coverRatioOf(a) === r)
    const n = Math.max(COVER_OPTIONS, ...rs.map((a) => a.option ?? 0))
    return (
      <div key={r} className="vd-cover-group">
        <div className="vd-cover-ratio">封面 {ratioText(r)}<span className="vd-muted">{rs.length} / {COVER_OPTIONS}</span></div>
        <div className="vd-covers">
          {Array.from({ length: n }, (_, j) => j + 1).map((op) => {
            const a = rs.find((x) => x.option === op)
            return a ? (
              <button key={op} type="button" className={cls('vd-cover', openId === a.id && 'sel', isPicked(a) && 'picked')}
                title={`${a.name} · ${ratioText(r)} · ${ARTIFACT_STATUS[a.status].label}`} aria-label={`${orientText(o)} 封面 ${ratioText(r)} 第 ${op} 版`}
                onClick={() => onOpen(a.id)}>
                <CoverThumb r={r} op={op} />
                <span className="vd-cover-foot">
                  <i className="vd-dot-s" style={{ '--c': ARTIFACT_STATUS[a.status].color } as CSSProperties} />{isPicked(a) ? '选用' : `v${a.version}`}
                </span>
              </button>
            ) : (
              <button key={op} type="button" className="vd-cover vd-cover-miss" title={`${ratioText(r)} 还没有第 ${op} 版，点一下登记`}
                aria-label={`登记 ${orientText(o)} 封面 ${ratioText(r)} 第 ${op} 版`} onClick={() => startNew('cover', o, op, r)}>
                <span className="vd-thumb vd-thumb-miss" style={{ aspectRatio: `${COVER_RATIO[r].w} / ${COVER_RATIO[r].h}` }}>{op}</span>
                <span className="vd-cover-foot vd-faint">缺</span>
              </button>
            )
          })}
        </div>
      </div>
    )
  })

  const noOrient = !!draft && ARTIFACT_KIND[draft.kind].perVariant && !v.orientations.length
  return (
    <div className="vd-arts">
      {draft && (
        <form className="vd-new-art" aria-label="登记产出物" onSubmit={(e) => { e.preventDefault(); register() }}>
          <div className="vd-field-row">
            <Field label="类型">
              <Select value={draft.kind} onValueChange={(k) => patch({ kind: k as NewArt['kind'] })}
                options={KINDS.map((k) => ({ value: k, label: `${ARTIFACT_KIND[k].label}（${stageName(k)}）` }))} />
            </Field>
            {draft.kind === 'cover' ? (
              <Field label="第几版">
                <Select value={String(draft.option ?? 1)} onValueChange={(x) => patch({ option: Number(x) })}
                  options={Array.from({ length: COVER_OPTIONS }, (_, k) => ({ value: String(k + 1), label: `第 ${k + 1} 版` }))} />
              </Field>
            ) : draft.kind === 'audio' || draft.kind === 'video' ? (
              <Field label="时长" hint="mm:ss 或秒数，可不填；格式不对就不存">
                <Input value={draft.duration} placeholder="10:02" onChange={(e) => onDraft({ ...draft, duration: e.target.value })} />
              </Field>
            ) : <span />}
          </div>
          {ARTIFACT_KIND[draft.kind].perVariant && (
            <div className="field">
              <span className="field-label">比例</span>
              <div className="vd-sort" role="group" aria-label="比例">
                {(v.orientations.length ? v.orientations : ORIENTS).map((o) => (
                  <button key={o} type="button" aria-pressed={draft.variant === o} className={cls(draft.variant === o && 'on')} onClick={() => patch({ variant: o })}>
                    {orientText(o)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {draft.kind === 'cover' && draft.variant && (
            <div className="field">
              <span className="field-label">封面比例<span className="vd-hint">平台各有要求，抖音要 3:4</span></span>
              <div className="vd-sort" role="group" aria-label="封面比例">
                {DEFAULT_COVER_RATIOS[draft.variant].map((r) => (
                  <button key={r} type="button" aria-pressed={draft.ratio === r} className={cls(draft.ratio === r && 'on')} onClick={() => patch({ ratio: r })}>{ratioText(r)}</button>
                ))}
              </div>
            </div>
          )}
          {noOrient && <div className="vd-muted">还没定画面比例，先在规划检查里选好</div>}
          <Field label="名称">
            <Input value={draft.name} onChange={(e) => onDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label={<>路径<span className="vd-hint">相对视频目录 {v.root || '（未设置）'}</span></>}>
            <Input className="vd-mono" value={draft.path} onChange={(e) => onDraft({ ...draft, path: e.target.value, touched: true })} />
          </Field>
          {create.isError && <div className="vd-err" role="alert">没登记上：{errorText(create.error)}</div>}
          <div className="vd-act-row">
            <Button type="submit" variant="primary" size="sm"
              disabled={!draft.path.trim() || (ARTIFACT_KIND[draft.kind].perVariant && !draft.variant) || create.isPending}>登记</Button>
            <Button size="sm" onClick={() => { create.reset(); onDraft(null) }}>取消</Button>
            <span className="vd-muted">登记后是草稿，验收通过才算定稿</span>
          </div>
        </form>
      )}

      {!mine.length && !draft && (
        <div className="empty">
          <div className="empty-title">还没有产出物</div>
          <div className="empty-desc">文稿、演示工程、音频、成片、封面、简介、章节时间轴都登记在这里</div>
          <Button variant="primary" onClick={() => startNew('script')}>新增产出物</Button>
        </div>
      )}

      {KINDS.map((k) => {
        const items = mine.filter((a) => a.kind === k)
        if (!items.length) return null
        const K = ARTIFACT_KIND[k]
        const cols = K.perVariant ? variantCols(v, items) : []
        // 按比例区分的类型里没记比例的老数据，单独列一栏
        const loose = K.perVariant ? items.filter((a) => !a.variant) : items
        return (
          <section key={k} className="vd-art-sec" aria-label={K.label}>
            <div className="vd-art-head">
              <span className="vd-sec-title">{K.label}<span className="vd-hint">{stageName(k)} · {items.length} 个</span></span>
              <Button size="sm" onClick={() => startNew(k)}>加一个</Button>
            </div>
            {loose.length > 0 && <div className="vd-list">{loose.map(row)}</div>}
            {cols.length > 0 && (
              <div className="vd-cols">
                {cols.map((o) => {
                  const xs = items.filter((a) => a.variant === o).sort((a, b) => (a.option ?? 0) - (b.option ?? 0))
                  return (
                    <div key={o} className="vd-col" aria-label={`${K.label} ${orientText(o)}`}>
                      <div className="vd-col-head"><OrientShape o={o} />{orientText(o)}
                        {!v.orientations.includes(o) && <span className="vd-faint">（不在本工程比例里）</span>}
                      </div>
                      {k === 'cover' ? coverGroups(o, xs)
                        : xs.length ? <div className="vd-list">{xs.map(row)}</div>
                          : (
                            <div className="vd-col-empty">这个比例还没有{K.label}。
                              <button type="button" className="vd-link" onClick={() => startNew(k, o)}>登记</button>
                            </div>
                          )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        )
      })}
      {mine.length > 0 && <div className="vd-muted vd-arts-hint">没出现的类型说明还没登记，点右上角「新增产出物」</div>}

      {opened && <ArtifactDrawer key={opened.id} a={opened} v={v} onClose={() => onOpen(null)} />}
    </div>
  )
}
