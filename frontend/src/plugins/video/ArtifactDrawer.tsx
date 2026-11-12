// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 产出物抽屉（SPEC-videos-12）：名称、路径边输边存（停手 600 毫秒或失焦），状态四选一，封面选用，验收（退回必须写意见），
// 升版本，预览，删除。来源是 Agent、SOP 的能跳到那次运行。预览用系统浏览器新开窗口：内置浏览器还没有插件提供
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  errorText, useBumpArtifact, useDeleteArtifact, usePatchArtifact, useReviewArtifact, type Video, type VideoArtifact, type VideoArtifactInput,
} from '../../core/data'
import { Button, Drawer, Field, Input, Pill, Textarea, cls } from '../../core/ui'
import {
  ARTIFACT_KIND, ARTIFACT_STATUS, COVER_RATIO, STATUSES, canPreview, coverRatioOf, fmtDuration, fullPath, isPicked, previewTitle, previewUrl,
  ratioText, sourceLink, sourceText,
} from './artifactModel'
import { STAGES, orientText, stageIndex, timeAgo } from './model'
import { CoverThumb, OrientShape } from './parts'

const SAVE_MS = 600

export function ArtifactDrawer({ a, v, onClose }: { a: VideoArtifact; v: Video; onClose: () => void }) {
  const navigate = useNavigate()
  const patch = usePatchArtifact()
  const review = useReviewArtifact()
  const bump = useBumpArtifact()
  const del = useDeleteArtifact()
  const [draft, setDraft] = useState({ name: a.name, path: a.path })
  const [cm, setCm] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  const latest = useRef({ a, draft })
  useEffect(() => { latest.current = { a, draft } })

  const K = ARTIFACT_KIND[a.kind] ?? { label: a.kind, stage: 'script', perVariant: false }
  const ratio = a.kind === 'cover' ? coverRatioOf(a) : undefined
  const link = sourceLink(a.source)
  const busy = review.isPending || bump.isPending || del.isPending
  const failed = patch.error ?? review.error ?? bump.error ?? del.error
  const resetAll = () => { patch.reset(); review.reset(); bump.reset(); del.reset() }

  const save = (p: VideoArtifactInput) => { if (Object.keys(p).length) { resetAll(); patch.mutate({ id: a.id, patch: p }) } }
  /** 草稿里和产出物不一样的名称、路径；路径空着不存 */
  const textChanges = (): VideoArtifactInput => {
    const { a: cur, draft: d } = latest.current
    const out: VideoArtifactInput = {}
    if (d.name.trim() && d.name.trim() !== cur.name) out.name = d.name.trim()
    if (d.path.trim() && d.path.trim() !== cur.path) out.path = d.path.trim()
    return out
  }
  useEffect(() => {
    const t = setTimeout(() => save(textChanges()), SAVE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])
  const flush = () => save(textChanges())

  const onReview = (ok: boolean) => {
    if (busy || (!ok && !cm.trim())) return
    resetAll()
    review.mutate({ id: a.id, ok, comment: cm.trim() || undefined }, { onSuccess: () => setCm('') })
  }
  const onBump = () => { if (!busy) { resetAll(); bump.mutate({ id: a.id, from: a.version }) } }
  // 删掉后列表里没有它了，抽屉会先卸载，用 mutateAsync 才能在之后清掉地址里的 ?a=
  const onDelete = () => { if (!busy) { resetAll(); del.mutateAsync({ id: a.id, videoId: a.video_id }).then(onClose, () => undefined) } }

  const kicker = [K.label, a.variant && orientText(a.variant), ratio && `封面 ${ratioText(ratio)}`, a.option && `第 ${a.option} 版`].filter(Boolean).join(' · ')
  return (
    <Drawer open onClose={onClose} kicker={kicker} aria-label={`产出物 ${a.name}`} className="vd-drawer"
      footer={(
        <>
          {confirmDel ? (
            <>
              <span className="vd-danger-text">只删记录，文件不动</span>
              <Button size="sm" onClick={() => setConfirmDel(false)}>取消</Button>
              <Button size="sm" variant="danger" disabled={busy} onClick={onDelete}>删除</Button>
            </>
          ) : <Button size="sm" onClick={() => setConfirmDel(true)}>删除</Button>}
          <span className="spacer" />
          <Button variant="outline" title="版本号加一，状态回到草稿" disabled={busy} onClick={onBump}>升版本</Button>
          {canPreview(a) && (
            <a className="btn btn-primary" href={previewUrl(v, a)} target="_blank" rel="noreferrer" title={`在新窗口打开：${previewTitle(v, a)}`}>预览</a>
          )}
        </>
      )}>
      <div className="vd-dr">
        <div className="vd-dr-head">
          {ratio && (
            <span className={cls('vd-dr-cover', COVER_RATIO[ratio].h > COVER_RATIO[ratio].w && 'tall')}><CoverThumb r={ratio} op={a.option ?? 1} big /></span>
          )}
          <div className="vd-dr-text">
            <h2 className="vd-dr-title"><span className="ellipsis">{a.name}</span><span className="vd-ver">v{a.version}</span></h2>
            <div className="vd-muted">{STAGES[stageIndex(K.stage)]?.label} · {timeAgo(a.created_at)}登记</div>
          </div>
          <Pill {...ARTIFACT_STATUS[a.status]} />
        </div>

        {failed && <div className="vd-err" role="alert">{errorText(failed)}</div>}

        <dl className="vd-props">
          <dt>完整路径</dt><dd><code className="vd-path">{fullPath(v, a)}</code></dd>
          <dt>来源</dt>
          <dd className="vd-src">
            <span>{sourceText(a.source)}</span>
            {link && <button type="button" className="vd-link" onClick={() => navigate(link.to)}>{link.label}</button>}
          </dd>
          {a.variant && <><dt>比例</dt><dd><span className="vd-otag"><OrientShape o={a.variant} />{orientText(a.variant)}</span></dd></>}
          {ratio && <><dt>封面比例</dt><dd>{ratioText(ratio)}</dd></>}
          {a.lang && <><dt>语言</dt><dd>{a.lang === 'zh' ? '中文' : a.lang}</dd></>}
          {a.duration !== undefined && <><dt>时长</dt><dd className="vd-dur">{fmtDuration(a.duration)}</dd></>}
        </dl>

        <div className="vd-field-row">
          <Field label="名称">
            <Input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} onBlur={flush} />
          </Field>
          <Field label={<>路径<span className="vd-hint">相对视频目录</span></>} error={!draft.path.trim() ? '路径必填' : undefined}>
            <Input className="vd-mono" value={draft.path} invalid={!draft.path.trim()} onChange={(e) => setDraft((d) => ({ ...d, path: e.target.value }))} onBlur={flush} />
          </Field>
        </div>

        <div className="field">
          <span className="field-label">状态<span className="vd-hint">草稿、待验收、已定稿、已发布</span></span>
          <div className="vd-sort vd-seg-full" role="group" aria-label="状态">
            {STATUSES.map((s) => (
              <button key={s} type="button" aria-pressed={a.status === s} className={cls(a.status === s && 'on')} disabled={patch.isPending}
                onClick={() => { if (a.status !== s) save({ status: s }) }}>{ARTIFACT_STATUS[s].label}</button>
            ))}
          </div>
        </div>

        {a.kind === 'cover' && (
          <div className="field">
            <span className="field-label">选用<span className="vd-hint">同一方向、同一封面比例只选一张，发布时默认用它</span></span>
            <div className="vd-act-row">
              <Button size="sm" variant={isPicked(a) ? 'ghost' : 'primary'} disabled={patch.isPending} onClick={() => save({ picked: !isPicked(a) })}>
                {isPicked(a) ? '取消选用' : '选用这张'}
              </Button>
              {isPicked(a) && <span className="vd-cp-res ok">已选用</span>}
            </div>
          </div>
        )}

        <section className="vd-review">
          <div className="vd-sec-title">验收<span className="vd-hint">退回要写意见；通过后状态变成已定稿</span></div>
          <Textarea rows={3} value={cm} placeholder="验收意见" aria-label="验收意见" onChange={(e) => setCm(e.target.value)} />
          <div className="vd-act-row">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => onReview(true)}>通过</Button>
            <Button size="sm" variant="danger-ghost" disabled={busy || !cm.trim()} title={!cm.trim() ? '退回要写意见' : undefined} onClick={() => onReview(false)}>退回</Button>
            {!cm.trim() && <span className="vd-muted">退回要写意见</span>}
          </div>
          {a.reviews.length > 0 ? (
            <ul className="vd-reviews">
              {[...a.reviews].reverse().map((r, i) => (
                <li key={`${r.at}-${i}`}>
                  <span className={cls('vd-cp-res', r.ok ? 'ok' : 'warn')}>{r.ok ? '通过' : '退回'}</span>
                  <span className="vd-ver">v{r.version}</span>
                  <span className="vd-review-text">{r.comment || '没写意见'}</span>
                  <span className="vd-muted" title={new Date(r.at).toLocaleString('zh-CN')}>{timeAgo(r.at)}</span>
                </li>
              ))}
            </ul>
          ) : <div className="vd-col-empty">还没验收过</div>}
        </section>
      </div>
    </Drawer>
  )
}
