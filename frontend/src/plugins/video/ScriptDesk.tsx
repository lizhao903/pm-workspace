// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 内容编写的编辑区（VID-09b，SPEC-videos-10.31 到 10.41、10.44、10.45，照原型 videos.tsx 的 ScriptDesk、TextPane）。
// 口播稿按比例一栏一个，大纲一栏（多个比例时栏头切换），原文可选。正文读写走 GET/PUT /api/video/artifacts/{id}/content：
// 「保存为 vN」存成下一版（还没有产出物的先登记一条 v1 再写），「交给验收」把当前版标待验收。没保存的草稿记在本机（scriptModel）。
// 「按选题大纲起草」就是跑内容编写的执行器；跑完执行器把口播稿、大纲升成新版本，这里拿起草前的旧版本对比：
// 采用就留着新版本，丢弃把旧版本的正文再存成下一版（第一版是起草新登记的，丢弃就删掉这条记录，文件不动）。
// 从链接导入原文要内置浏览器抓正文，还没有接口，这里只把选题素材里的链接列出来，点了在新窗口打开。
import { useState, type ReactNode } from 'react'
import {
  errorText, useArtifactContent, useCreateArtifact, useDeleteArtifact, usePatchArtifact, usePutArtifactContent, useRunStage, videoContentApi,
  type Video, type VideoArtifact, type VideoClip, type VideoOrientation, type VideoTopic,
} from '../../core/data'
import { Button, Pill, cls } from '../../core/ui'
import { StoryboardDesk } from './StoryboardDesk'
import { ARTIFACT_STATUS, defaultName, defaultPath, fullPath, sourceText } from './artifactModel'
import { ORIENT, timeAgo } from './model'
import { OrientShape } from './parts'
import { RUNNER_TYPE, findChoice } from './runnerModel'
import type { RunnerChoices } from './runnerChoices'
import {
  SPEECH_RATE, TEXT_LABEL, deskOrients, draftKey, latestText, markHandled, paneLabel, pendingProposals, proposalKey, sectionCount, setDraft,
  speakText, textStats, useDeskStore, type TextDraft, type TextKind,
} from './scriptModel'

/** 内容编写没配执行器时起草用的，同后端 draftRunner */
const DEFAULT_RUNNER = { type: 'skill' as const, ref_id: 'sk_video' }

const PLACEHOLDER: Record<TextKind, (variant?: VideoOrientation) => string> = {
  script: (o) => (o === 'portrait' ? '## 第 1 屏\n竖版一屏一句，每屏 40 字以内' : '## 开场\n按章节写，一章一段'),
  outline: () => '# 标题\n\n## 第 1 章 ……\n- 要点',
  article: () => '粘贴原文',
}

export function ScriptDesk({ v, arts, topic, clips, choices, onOpenArt, onClose }: {
  v: Video
  arts: VideoArtifact[]
  topic: VideoTopic | undefined
  clips: VideoClip[]
  choices: RunnerChoices
  onOpenArt: (id: string) => void
  /** 内容编写已经过了（或还没到），点开看的可以收起 */
  onClose?: () => void
}) {
  const store = useDeskStore()
  const run = useRunStage()
  const putContent = usePutArtifactContent()
  const del = useDeleteArtifact()
  const [ov, setOv] = useState<VideoOrientation | null>(null)
  // 文稿、分镜两个视图（TSK-0456）
  const [view, setView] = useState<'text' | 'board'>('text')
  const [discarding, setDiscarding] = useState(false)
  const [discardErr, setDiscardErr] = useState<unknown>(null)
  const os = deskOrients(v)
  const outlineVariant = ov && os.includes(ov) ? ov : os[0]
  const article = latestText(arts, 'article')
  const hasArticleDraft = draftKey(v.id, 'article') in store.drafts
  const [articleOpen, setArticleOpen] = useState<boolean>(!!article || hasArticleDraft)

  const last = v.last_run?.stage === 'script' ? v.last_run : undefined
  const running = v.last_run?.status === 'running'
  const drafting = last?.status === 'running'
  const proposals = pendingProposals(v, arts, store.handled)
  const r = v.runners?.find((x) => x.stage === 'script') ?? DEFAULT_RUNNER
  const runnerLabel = `${RUNNER_TYPE[r.type]}「${findChoice(choices.list(r.type), r.ref_id)?.name ?? r.ref_id}」`
  const links = topic ? clips.filter((c) => topic.clip_ids.includes(c.id) && c.url) : []
  const draftOff = !topic ? '先选好选题' : v.stage !== 'script' ? '视频不在「内容编写」，起草只能在这一步做'
    : running && !drafting ? '另一个阶段正在跑，等它跑完' : ''

  const onDraft = () => {
    if (draftOff || running || run.isPending) return
    setDiscardErr(null)
    run.mutate({ id: v.id, stage: 'script' })
  }

  // 丢弃一份初稿：退回起草前的版本（再存一版），第一版的删掉记录
  const discardOne = async (a: VideoArtifact) => {
    if (a.version <= 1) {
      await del.mutateAsync({ id: a.id, videoId: v.id })
    } else {
      const old = await videoContentApi.content(a.id, a.version - 1)
      await putContent.mutateAsync({ id: a.id, content: old.content, new_version: true, from: a.version })
    }
    markHandled([proposalKey(a)])
  }
  const discard = async (xs: VideoArtifact[]) => {
    if (discarding) return
    setDiscarding(true)
    setDiscardErr(null)
    try {
      for (const a of xs) await discardOne(a)
    } catch (e) {
      setDiscardErr(e)
    } finally {
      setDiscarding(false)
    }
  }
  // 采用：新版本留着；本机没保存的草稿会被初稿替换，一起删掉
  const adopt = (xs: VideoArtifact[]) => {
    for (const a of xs) setDraft(draftKey(v.id, a.kind as TextKind, a.variant), null)
    markHandled(xs.map(proposalKey))
  }

  const pane = (kind: TextKind, variant: VideoOrientation | undefined, head: ReactNode) => (
    <TextPane key={`${kind}-${variant ?? ''}`} v={v} kind={kind} variant={variant} art={latestText(arts, kind, variant)} head={head}
      draft={store.drafts[draftKey(v.id, kind, variant)]} onOpenArt={onOpenArt} />
  )

  return (
    <div className="vd-desk" aria-label="内容编写编辑区">
      <div className="vd-desk-bar">
        <span className="vd-sort" role="tablist" aria-label="编辑区视图">
          <button type="button" role="tab" aria-selected={view === 'text'} className={cls(view === 'text' && 'on')} onClick={() => setView('text')}>文稿</button>
          <button type="button" role="tab" aria-selected={view === 'board'} className={cls(view === 'board' && 'on')} onClick={() => setView('board')}>分镜</button>
        </span>
        {view === 'board' && <span className="spacer" />}
        {view === 'board' && onClose && <Button size="sm" onClick={onClose}>收起</Button>}
        {view === 'text' && <>
        <span className="vd-muted vd-wrap vd-desk-hint">
          {topic ? `可以照选题「${topic.title || '未命名选题'}」的角度和大纲起草，也可以直接写` : '先在「选题」一步挂上选题，才能按大纲起草；也可以直接写'}
        </span>
        {onClose && <Button size="sm" onClick={onClose}>收起</Button>}
        <Button variant="primary" size="sm" disabled={!!draftOff || running || run.isPending} title={draftOff || `交给${runnerLabel}起草`} onClick={onDraft}>
          {drafting ? '起草中…' : run.isPending ? '正在发起…' : proposals.length ? '重新起草' : last?.status === 'failed' ? '重试起草' : '按选题大纲起草'}
        </Button>
        </>}
      </div>
      {view === 'board' && <StoryboardDesk v={v} arts={arts} />}
      {view === 'text' && <>
      {run.error && <div className="vd-err" role="alert">{errorText(run.error)}</div>}
      {drafting && (
        <div className="vd-runner-state" role="status">
          <i className="spinner vd-spin" aria-hidden="true" />正在起草，开始于 {timeAgo(last.started_at)}；跑完出初稿，对比后再决定用不用
        </div>
      )}
      {last?.status === 'failed' && (
        <div className="vd-cp-reject" role="status">起草失败：{last.error || '没有返回原因'}{last.ended_at && ` · ${timeAgo(last.ended_at)}`}</div>
      )}

      {proposals.length > 0 && (
        <div className="vd-proposal" aria-label="初稿对比">
          <div className="vd-proposal-head">
            <b>初稿 {proposals.length} 份</b>
            <span className="vd-muted vd-wrap">{sourceText(proposals[0].source)} · {timeAgo(last?.ended_at ?? proposals[0].updated_at)}起草；已存成新版本，丢弃的退回起草前的版本</span>
            <span className="spacer" />
            <Button variant="primary" size="sm" disabled={discarding} onClick={() => adopt(proposals)}>全部采用</Button>
            <Button size="sm" disabled={discarding} onClick={() => void discard(proposals)}>全部丢弃</Button>
          </div>
          {!!discardErr && <div className="vd-err" role="alert">{errorText(discardErr)}</div>}
          {proposals.map((a) => (
            <ProposalRow key={a.id} a={a} label={paneLabel(a.kind as TextKind, a.variant)} draft={store.drafts[draftKey(v.id, a.kind as TextKind, a.variant)]}
              busy={discarding} onAdopt={() => adopt([a])} onDiscard={() => void discard([a])} />
          ))}
        </div>
      )}

      <div className="vd-desk-cols">
        {os.map((o) => pane('script', o, <span className="vd-pane-title"><OrientShape o={o} />{ORIENT[o].label}口播稿</span>))}
        {pane('outline', outlineVariant, (
          <span className="vd-pane-title">大纲
            {os.length > 1 && (
              <span className="vd-sort" role="group" aria-label="大纲的比例">
                {os.map((o) => (
                  <button key={o} type="button" aria-pressed={outlineVariant === o} className={cls(outlineVariant === o && 'on')} onClick={() => setOv(o)}>
                    {ORIENT[o].label}
                  </button>
                ))}
              </span>
            )}
          </span>
        ))}
      </div>

      <section className="vd-article">
        <button type="button" className="vd-article-toggle" aria-expanded={articleOpen} onClick={() => setArticleOpen(!articleOpen)}>
          <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" style={{ transform: articleOpen ? 'rotate(90deg)' : undefined }}>
            <path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          原文<span className="vd-muted vd-wrap">可选；有原文的按原文改写，口播稿和大纲各自存</span>
          {article && <span className="vd-ver">v{article.version}</span>}
        </button>
        {articleOpen && (
          <div className="vd-article-body">
            {links.length > 0 && (
              <div className="vd-import-links">
                <span className="vd-muted">选题素材里的链接</span>
                {links.map((c) => (
                  <a key={c.id} className="chip" href={c.url} target="_blank" rel="noreferrer" title={`在新窗口打开 ${c.url}，把正文粘贴到下面`}>{c.title}</a>
                ))}
              </div>
            )}
            {pane('article', undefined, <span className="vd-pane-title">原文</span>)}
          </div>
        )}
      </section>
      </>}
    </div>
  )
}

/** 一栏编辑器：显示本机草稿或当前版本的正文，字数和按语速估的时长；保存存成下一版，交给验收把当前版标待验收 */
function TextPane({ v, kind, variant, art, head, draft, onOpenArt }: {
  v: Video
  kind: TextKind
  variant?: VideoOrientation
  art?: VideoArtifact
  /** 栏头左边：标签、比例切换 */
  head: ReactNode
  draft?: TextDraft
  onOpenArt: (id: string) => void
}) {
  const content = useArtifactContent(art?.id ?? null, art?.version ?? 0)
  const create = useCreateArtifact()
  const put = usePutArtifactContent()
  const patch = usePatchArtifact()
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<unknown>(null)
  const key = draftKey(v.id, kind, variant)
  const loaded = !art || content.isSuccess
  const saved = content.data?.content ?? ''
  const dirty = !!draft
  const body = draft?.body ?? saved
  const st = textStats(body)
  const empty = !body.trim()
  const next = (art?.version ?? 0) + 1
  const label = `${TEXT_LABEL[kind]}${variant && kind !== 'article' ? `（${ORIENT[variant].label}）` : ''}`
  const busy = saving || patch.isPending
  const submitLabel = dirty ? '保存并交验收' : art?.status === 'review' ? '已在待验收' : art?.status === 'final' || art?.status === 'published' ? '已定稿' : '交给验收'
  const submitOff = !loaded || empty || (!dirty && (!art || art.status !== 'draft'))
  const missing = !!art && content.isSuccess && !content.data.exists

  // 存成下一版；还没有产出物的先登记一条 v1（名称、路径同登记表单的默认），再把正文写进去
  const save = async (review: boolean) => {
    if (busy || !dirty || empty) return
    setSaving(true)
    setErr(null)
    try {
      let a: VideoArtifact
      if (art) {
        a = (await put.mutateAsync({ id: art.id, content: body, new_version: true, from: art.version })).artifact
      } else {
        const made = await create.mutateAsync({ video_id: v.id, kind, name: defaultName(kind), path: defaultPath(kind, v, variant), ...(variant && kind !== 'article' ? { variant } : {}) })
        a = (await put.mutateAsync({ id: made.id, content: body, from: made.version })).artifact
      }
      setDraft(key, null)
      if (review) await patch.mutateAsync({ id: a.id, patch: { status: 'review' } })
    } catch (e) {
      setErr(e)
    } finally {
      setSaving(false)
    }
  }
  const submit = () => {
    if (dirty) { void save(true); return }
    if (!art || busy) return
    setErr(null)
    patch.mutate({ id: art.id, patch: { status: 'review' } }, { onError: setErr })
  }

  const saveTitle = !dirty ? '没有改动' : empty ? '稿子是空的' : `存成 v${next}，状态是草稿`
  const savedAt = content.data?.modified_at ?? art?.updated_at
  return (
    <div className={cls('vd-pane', dirty && 'dirty')} aria-label={`${label}编辑器`}>
      <div className="vd-pane-head">
        {head}
        <span className="spacer" />
        {art ? (
          <button type="button" className="vd-pane-art" title="打开产出物" aria-label={`打开${label} v${art.version}`} onClick={() => onOpenArt(art.id)}>
            <span className="vd-ver">v{art.version}</span><Pill {...ARTIFACT_STATUS[art.status]} />
          </button>
        ) : <span className="vd-faint vd-pane-none">还没保存过</span>}
      </div>
      {content.isError && <div className="vd-err vd-pane-msg" role="alert">正文读不出来：{errorText(content.error)}</div>}
      <textarea className="vd-editor" value={body} aria-label={label} disabled={!loaded} spellCheck={false}
        placeholder={!loaded ? (content.isPending ? '正文加载中…' : '') : missing
          ? `v${art.version} 的正文文件 ${fullPath(v, art)} 还没写过；在这里写，保存后存成 v${next}` : PLACEHOLDER[kind](variant)}
        onChange={(e) => setDraft(key, e.target.value, saved)} />
      <div className="vd-pane-foot">
        <span className="vd-pane-stat" title={kind === 'script' ? `按每分钟 ${SPEECH_RATE} 字估` : undefined}>
          {st.chars} 字{kind === 'script' && st.chars > 0 && ` · 约 ${speakText(st.seconds)}`}
          {kind === 'outline' && sectionCount(body) > 0 && ` · ${sectionCount(body)} 节`}
        </span>
        <span className="vd-pane-save">
          {dirty ? `草稿已自动保存 · ${timeAgo(draft.at)}` : art && content.data?.exists && savedAt ? `v${art.version} 已保存 · ${timeAgo(savedAt)}` : ''}
        </span>
        <span className="spacer" />
        <Button size="sm" variant="outline" disabled={!dirty || empty || busy} title={saveTitle} onClick={() => void save(false)}>
          {saving ? '保存中…' : `保存为 v${next}`}
        </Button>
        <Button size="sm" variant="primary" disabled={submitOff || busy}
          title={empty ? '稿子是空的，不能交验收' : !dirty && !art ? '先保存成版本' : undefined} onClick={submit}>{submitLabel}</Button>
      </div>
      {!!err && <div className="vd-err vd-pane-msg" role="alert">{errorText(err)}</div>}
      {loaded && empty && art?.status !== 'review' && <div className="vd-pane-err">稿子是空的，写了才能交验收</div>}
    </div>
  )
}

/** 一份初稿：左边起草前的版本（或本机没保存的草稿），右边起草出的新版本 */
function ProposalRow({ a, label, draft, busy, onAdopt, onDiscard }: {
  a: VideoArtifact
  label: string
  draft?: TextDraft
  busy: boolean
  onAdopt: () => void
  onDiscard: () => void
}) {
  const cur = useArtifactContent(a.id, a.version)
  const kept = cur.data?.versions.includes(a.version - 1) ?? false
  const old = useArtifactContent(kept && !draft ? a.id : null, a.version - 1)
  const first = a.version <= 1
  const left = draft ? { label: '现在（没保存的草稿）', body: draft.body }
    : first ? { label: '起草前（还没写）', body: '' }
      : !cur.isSuccess ? { label: `起草前（v${a.version - 1}）`, body: '' }
        : !kept ? { label: `起草前（v${a.version - 1}）`, body: '', note: '起草前的版本没有留存' }
          : { label: `起草前（v${a.version - 1}）`, body: old.data?.content ?? '', note: old.isPending ? '加载中…' : old.isError ? errorText(old.error) : '' }
  const noBack = !first && cur.isSuccess && !kept
  const newBody = cur.data?.content ?? ''
  return (
    <div className="vd-cmp" aria-label={`${label}初稿`}>
      <div className="vd-cmp-head">
        <b>{label}</b>
        <span className="vd-ver">v{a.version}</span>
        {draft && <span className="vd-plan-warn">采用后，没保存的改动会被初稿替换</span>}
        <span className="spacer" />
        <Button size="sm" variant="outline" disabled={busy} onClick={onAdopt}>采用</Button>
        <Button size="sm" disabled={busy || noBack || !cur.isSuccess}
          title={noBack ? '起草前的版本没有留存，不能退回；不要的话直接改稿' : first ? '这一条是起草新登记的，丢弃就删掉记录，文件不动' : `退回 v${a.version - 1} 的正文，存成 v${a.version + 1}`}
          onClick={onDiscard}>丢弃</Button>
      </div>
      <div className="vd-cmp-cols">
        <div className="vd-cmp-col">
          <div className="vd-cmp-label">{left.label}</div>
          <div className={cls('vd-cmp-text', !left.body && 'vd-faint')}>{left.body || ('note' in left && left.note) || '空'}</div>
        </div>
        <div className="vd-cmp-col">
          <div className="vd-cmp-label">初稿 · {textStats(newBody).chars} 字</div>
          <div className={cls('vd-cmp-text', !newBody && 'vd-faint')}>
            {cur.isPending ? '加载中…' : cur.isError ? `正文读不出来：${errorText(cur.error)}` : newBody || '空'}
          </div>
        </div>
      </div>
    </div>
  )
}
