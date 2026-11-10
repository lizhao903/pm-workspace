// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 视频详情（SPEC-videos-10、11、13）：制作流程、产出物（VID-01d）、设置三个标签。
// 制作流程是 9 个阶段的竖向时间线：没有检查点的阶段点「这一步做完了」往下走；4 个检查点通过、退回（必须写意见）、
// 音频合成可以跳过；规划检查里选画面比例，通过后锁定。阶段和检查点都由后端校验，冲突（别处推进过）照后端的话提示。
// VID-02b：每个阶段下面列这一步的产出物（字幕在录屏渲染，封面带封面比例），第一章验收列演示工程；点一条打开抽屉（?a=），登记跳到产出物标签
// VID-03c：能跑的阶段下面是执行器（Runner.tsx），同一时间只改一个阶段的；有执行在跑时轮询这个视频
// VID-09b：第一步选题（TopicStep.tsx）挑、换、新建选题；内容编写是当前阶段时直接展开编辑区（ScriptDesk.tsx），别的时候点开；
// 规划检查顶上列内容编写里保存的文稿版本，只提醒不拦
import { useState } from 'react'
import {
  errorText, projectView, useAdvanceVideo, useDecideCheckpoint, usePatchVideo, useVideoArtifacts, useVideoClips, useVideoPublishes, useVideoTopics, useWatchVideoRun,
  type Video, type VideoArtifact,
  type VideoArtifactKind, type VideoCheckpointStage, type VideoCheckpointState, type VideoSeries, type VideoStageRunner,
} from '../../core/data'
import { Button, PageTitle, Pill, Textarea, cls } from '../../core/ui'
import {
  ORIENT, ORIENTS, STAGES, cpOf, isFinished, needsMe, orientLocked, orientText, seriesLine, stepState, timeAgo, videoState,
} from './model'
import { IconCheckSmall, OrientShape, VideosTabs, type ModuleTab } from './parts'
import { SettingsTab } from './SettingsTab'
import { ArtifactsTab } from './ArtifactsTab'
import { ArtifactDrawer } from './ArtifactDrawer'
import {
  ARTIFACT_KIND, ARTIFACT_STATUS, KINDS, canPreview, coverRatioOf, kindForStage, newDraft, previewTitle, previewUrl, ratioText, type NewArt,
} from './artifactModel'
import { RUNNABLE } from './runnerModel'
import { RunnerBox } from './Runner'
import { useRunnerChoices } from './runnerChoices'
import { TopicStep } from './TopicStep'
import { ScriptDesk } from './ScriptDesk'
import { planDocs, useDeskStore } from './scriptModel'

export type DetailTab = 'flow' | 'artifacts' | 'settings'
const TABS: { key: DetailTab; label: string }[] = [{ key: 'flow', label: '制作流程' }, { key: 'artifacts', label: '产出物' }, { key: 'settings', label: '设置' }]

export function Detail({ video, videos, series, projects, tab, from, openArt, onTab, onOpenArt, onModuleTab, onOpenSeries, onOpenPublishes, onDeleted }: {
  video: Video
  videos: Video[]
  series: VideoSeries[]
  projects: ReturnType<typeof projectView>[]
  tab: DetailTab
  /** 从哪个标签点进来的，标签栏高亮它 */
  from: ModuleTab
  /** 产出物标签里打开抽屉的那一条（地址里的 ?a=） */
  openArt: string | null
  onTab: (t: DetailTab) => void
  onOpenArt: (id: string | null) => void
  onModuleTab: (t: ModuleTab) => void
  onOpenSeries: (id: string) => void
  /** 发布记录只看这一集（SPEC-videos-10.12）；不传不显示按钮 */
  onOpenPublishes?: (id: string) => void
  onDeleted: () => void
}) {
  const v = video
  const sr = series.find((s) => s.id === v.series_id)
  const proj = v.project_id ? projects.find((p) => p.id === v.project_id)?.name ?? '已删除的项目' : ''
  const arts = useVideoArtifacts(v.id)
  const pubCount = (useVideoPublishes({ enabled: !!onOpenPublishes }).data ?? []).filter((p) => p.video_id === v.id).length
  const mine = arts.data ?? []
  // 登记表单的草稿，右上「新增产出物」和标签里的「加一个」「缺」都往这里填
  const [draft, setDraft] = useState<NewArt | null>(null)
  // 制作流程里点「登记」：预填草稿，切到产出物标签
  const startNew = (kind: VideoArtifactKind) => { setDraft(newDraft(v, mine, kind)); onTab('artifacts') }
  const descText = [seriesLine(v, series), proj, v.orientations.map((o) => ORIENT[o].ratio).join(' / ') || '比例未定', videoState(v).label]
    .filter(Boolean).join(' · ')

  return (
    <div className="vd-page">
      <PageTitle
        parent={sr ? <button type="button" className="vd-crumb" onClick={() => onOpenSeries(sr.id)}>{sr.name}</button> : '视频'}
        desc={descText}
        actions={<>
          {pubCount > 0 && onOpenPublishes && <Button variant="outline" onClick={() => onOpenPublishes(v.id)}>发布记录<span className="seg-n">{pubCount}</span></Button>}
          {tab === 'flow' && sr ? <Button variant="outline" onClick={() => onOpenSeries(sr.id)}>查看系列</Button>
            : tab === 'artifacts' ? <Button variant="primary" disabled={!arts.data} onClick={() => setDraft(newDraft(v, mine, kindForStage(v.stage)))}>新增产出物</Button>
              : null}
        </>}
      >{v.title || '未命名视频'}</PageTitle>
      <VideosTabs active={from} videos={videos} onSelect={onModuleTab} />
      <div className="vd-dtabs" role="tablist" aria-label="视频详情">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={cls(tab === t.key && 'on')} onClick={() => onTab(t.key)}>
            {t.label}
            {t.key === 'flow' && needsMe(v) && <span className="side-dot" title="等你处理" />}
            {t.key === 'artifacts' && arts.data && <span className="vd-tab-n">{mine.length}</span>}
          </button>
        ))}
      </div>
      {tab === 'flow' && <Flow key={v.id} v={v} arts={arts.data} series={series} openId={openArt} onOpen={onOpenArt} onNew={startNew} />}
      {tab === 'artifacts' && (
        <ArtifactsTab key={v.id} v={v} query={arts} draft={draft} onDraft={setDraft} openId={openArt} onOpen={onOpenArt} />
      )}
      {tab === 'settings' && <SettingsTab key={v.id} v={v} series={series} projects={projects} onDeleted={onDeleted} />}
    </div>
  )
}

function Flow({ v, arts, series, openId, onOpen, onNew }: {
  v: Video
  series: VideoSeries[]
  /** 还没取回来时不列产出物 */
  arts: VideoArtifact[] | undefined
  openId: string | null
  onOpen: (id: string | null) => void
  onNew: (kind: VideoArtifactKind) => void
}) {
  const advance = useAdvanceVideo()
  const decide = useDecideCheckpoint()
  const patch = usePatchVideo()
  const [rejecting, setRejecting] = useState<VideoCheckpointStage | null>(null)
  const [note, setNote] = useState('')
  // 正在配执行器的阶段和草稿
  const [runEdit, setRunEdit] = useState<VideoStageRunner | null>(null)
  const choices = useRunnerChoices()
  useWatchVideoRun(v)
  const topics = useVideoTopics()
  const clips = useVideoClips()
  const desk = useDeskStore()
  const [deskOpen, setDeskOpen] = useState(false)
  const [topicOpen, setTopicOpen] = useState(false)
  const topic = v.topic_id ? topics.data?.find((t) => t.id === v.topic_id) : undefined
  const hasDraft = Object.keys(desk.drafts).some((k) => k.startsWith(`${v.id}:`))
  const locked = orientLocked(v)
  const busy = advance.isPending || decide.isPending
  const failed = advance.error ?? decide.error ?? patch.error
  const mine = arts ?? []
  const opened = openId ? mine.find((a) => a.id === openId) : undefined
  const pres = mine.filter((a) => a.kind === 'presentation')

  const artLine = (a: VideoArtifact) => (
    <div key={a.id} className={cls('vd-art-line', openId === a.id && 'sel')}>
      <button type="button" className="vd-art-open" aria-label={[ARTIFACT_KIND[a.kind]?.label, a.name, a.variant && orientText(a.variant),
        a.kind === 'cover' && `封面 ${ratioText(coverRatioOf(a))}`].filter(Boolean).join(' ')} onClick={() => onOpen(a.id)}>
        <span className="tag">{ARTIFACT_KIND[a.kind]?.label ?? a.kind}</span>
        <span className="ellipsis vd-art-name">{a.name}</span>
        {a.variant && <span className="vd-otag"><OrientShape o={a.variant} />{ORIENT[a.variant].ratio}</span>}
        {a.kind === 'cover' && <span className="vd-otag" title="封面比例">封面 {ratioText(coverRatioOf(a))}</span>}
        <span className="vd-ver">v{a.version}</span>
        <Pill {...ARTIFACT_STATUS[a.status]} />
      </button>
      {canPreview(a) && a.kind !== 'audio' && (
        <a className="btn btn-ghost btn-sm" href={previewUrl(v, a)} target="_blank" rel="noreferrer" title={`在新窗口打开：${previewTitle(v, a)}`}>预览</a>
      )}
    </div>
  )

  const onDecide = (stage: VideoCheckpointStage, state: Exclude<VideoCheckpointState, 'pending'>, why?: string) => {
    if (busy) return
    advance.reset()
    patch.reset()
    decide.mutate({ id: v.id, stage, state, note: why?.trim() || undefined }, {
      onSuccess: () => { setRejecting(null); setNote('') },
    })
  }
  const onAdvance = () => {
    if (busy) return
    decide.reset()
    patch.reset()
    advance.mutate({ id: v.id, from: v.stage })
  }
  const toggleOrient = (o: (typeof ORIENTS)[number]) => {
    if (locked) return
    const on = v.orientations.includes(o)
    advance.reset()
    decide.reset()
    patch.mutate({ id: v.id, patch: { orientations: ORIENTS.filter((x) => (x === o ? !on : v.orientations.includes(x))) } })
  }

  return (
    <>
      {failed && <div className="vd-err" role="alert">{errorText(failed)}</div>}
      <ol className="vd-flow">
        {STAGES.map((s, i) => {
          const state = stepState(v, i)
          const cp = s.checkpoint ? cpOf(v, s.key) : undefined
          const cur = state === 'current' && !isFinished(v)
          const open = cur && s.checkpoint && cp?.state !== 'passed' && cp?.state !== 'skipped'
          const stage = s.key as VideoCheckpointStage
          const noOrient = s.key === 'plan' && !v.orientations.length
          const items = mine.filter((a) => ARTIFACT_KIND[a.kind]?.stage === s.key)
          const firstKind = KINDS.find((k) => ARTIFACT_KIND[k].stage === s.key)
          const showDesk = s.key === 'script' && (cur || deskOpen)
          return (
            <li key={s.key} aria-label={s.label} aria-current={cur ? 'step' : undefined}
              className={cls('vd-step', `vd-step-${state}`, s.checkpoint && 'vd-step-cp', cur && (cp?.state === 'pending' || cp?.state === 'rejected') && 'vd-step-wait')}>
              <span className="vd-dot">{state === 'done' ? <IconCheckSmall /> : i + 1}</span>
              <div className="vd-step-body">
                <div className="vd-step-head">
                  <b>{s.label}</b>
                  {s.checkpoint && <span className="vd-cp-tag">检查点</span>}
                  {cur && <span className="vd-now">当前</span>}
                  <span className="spacer" />
                  {cp?.state === 'passed' && <span className="vd-cp-res ok">已通过{cp.at && ` · ${timeAgo(cp.at)}`}</span>}
                  {cp?.state === 'skipped' && <span className="vd-cp-res">已跳过{s.key === 'audio' && '，不合成音频'}{cp.at && ` · ${timeAgo(cp.at)}`}</span>}
                  {cp?.state === 'rejected' && <span className="vd-cp-res warn">已退回{cp.at && ` · ${timeAgo(cp.at)}`}</span>}
                </div>
                <div className="vd-step-desc">{s.desc}</div>
                {cp?.note && cp.state !== 'rejected' && <div className="vd-cp-note">意见：{cp.note}</div>}

                {s.key === 'topic' && (
                  <TopicStep v={v} topics={topics.data} clips={clips.data ?? []} series={series} drawerOpen={topicOpen} onDrawer={setTopicOpen} />
                )}
                {arts && s.key === 'plan' && (() => {
                  const pd = planDocs(v, mine, hasDraft)
                  return (
                    <div className="vd-sub" aria-label="要对齐的文稿">
                      <div className="vd-label">要对齐的文稿<span className="vd-hint">内容编写里保存的版本</span></div>
                      {pd.docs.length ? pd.docs.map(artLine) : (
                        <div className="vd-col-empty">还没有文稿。<button type="button" className="vd-link" onClick={() => setDeskOpen(true)}>去内容编写</button></div>
                      )}
                      {pd.warns.map((w) => <div key={w} className="vd-plan-warn">{w}</div>)}
                    </div>
                  )
                })()}

                {s.key === 'plan' && (
                  <div className="vd-plan">
                    <div className="vd-label">画面比例<span className="vd-hint">{locked ? '已锁定' : '可多选，每个比例是一个独立的演示工程'}</span></div>
                    <div className="vd-orients">
                      {ORIENTS.map((o) => {
                        const on = v.orientations.includes(o)
                        if (locked && !on) return null
                        return (
                          <button key={o} type="button" aria-pressed={on} className={cls('chip vd-orient', on && 'chip-on', locked && 'vd-orient-locked')}
                            disabled={locked || patch.isPending} onClick={() => toggleOrient(o)}>
                            <OrientShape o={o} />{orientText(o)}
                          </button>
                        )
                      })}
                    </div>
                    {locked && <div className="vd-step-desc">比例定了不能改，要换比例得新开工程</div>}
                  </div>
                )}

                {arts && s.key === 'ch1' && (cur || pres.length > 0) && (
                  <div className="vd-sub" aria-label="要验收的演示工程">
                    <div className="vd-label">要验收的演示工程<span className="vd-hint">第 1 章是后面所有章节的样板，按比例逐个看</span></div>
                    {pres.length ? pres.map(artLine) : (
                      <div className="vd-col-empty">还没登记演示工程。<button type="button" className="vd-link" onClick={() => onNew('presentation')}>去登记</button></div>
                    )}
                  </div>
                )}
                {items.length > 0 && !showDesk && <div className="vd-sub" aria-label={`${s.label}的产出物`}>{items.map(artLine)}</div>}
                {s.key === 'script' && !showDesk && (
                  <div className="vd-act-row"><button type="button" className="vd-link" onClick={() => setDeskOpen(true)}>打开编辑区改文稿</button></div>
                )}
                {RUNNABLE.includes(s.key) && !isFinished(v) && (
                  <RunnerBox v={v} stage={s.key} cur={cur} choices={choices} edit={runEdit?.stage === s.key ? runEdit : null} onEdit={setRunEdit} />
                )}
                {arts && showDesk && (
                  <ScriptDesk v={v} arts={mine} topic={topic} clips={clips.data ?? []} choices={choices} onOpenArt={(id) => onOpen(id)}
                    onClose={cur ? undefined : () => setDeskOpen(false)} />
                )}
                {arts && cur && !items.length && firstKind && !s.checkpoint && s.key !== 'script' && (
                  <div className="vd-col-empty">这一步还没登记产出物。<button type="button" className="vd-link" onClick={() => onNew(firstKind)}>登记一个</button></div>
                )}

                {open && (
                  <div className="vd-cp-box">
                    {cp?.state === 'rejected' && <div className="vd-cp-reject">退回意见：{cp.note || '没写意见'}</div>}
                    {rejecting === stage ? (
                      <>
                        <Textarea rows={3} autoFocus value={note} placeholder="哪里不行、要怎么改" aria-label="退回意见" onChange={(e) => setNote(e.target.value)} />
                        <div className="vd-act-row">
                          <Button variant="danger" size="sm" disabled={!note.trim() || busy} onClick={() => onDecide(stage, 'rejected', note)}>确认退回</Button>
                          <Button size="sm" onClick={() => { setRejecting(null); setNote('') }}>取消</Button>
                          {!note.trim() && <span className="vd-muted">退回要写意见</span>}
                        </div>
                      </>
                    ) : (
                      <div className="vd-act-row">
                        <Button variant="primary" size="sm" disabled={noOrient || busy} title={noOrient ? '先选至少一个画面比例' : undefined}
                          onClick={() => onDecide(stage, 'passed')}>{cp?.state === 'rejected' ? '改好了，通过' : '通过'}</Button>
                        <Button variant="outline" size="sm" disabled={busy} onClick={() => { setRejecting(stage); setNote('') }}>
                          {cp?.state === 'rejected' ? '再次退回' : '退回'}
                        </Button>
                        {s.key === 'audio' && <Button size="sm" disabled={busy} onClick={() => onDecide(stage, 'skipped')}>跳过（不合成音频）</Button>}
                        {noOrient && <span className="vd-muted">先选至少一个画面比例</span>}
                        {s.key === 'plan' && !noOrient && <span className="vd-muted">通过后比例锁定</span>}
                      </div>
                    )}
                  </div>
                )}
                {cur && s.key === 'topic' && (
                  <div className="vd-act-row vd-adv">
                    <Button variant="primary" size="sm" disabled={busy || !topic} title={!topic ? '先选一个选题或新建一个' : undefined} onClick={onAdvance}>
                      确认选题，进入「{STAGES[i + 1].label}」
                    </Button>
                    {!topic && <span className="vd-muted">先选一个选题或新建一个</span>}
                  </div>
                )}
                {cur && !s.checkpoint && s.key !== 'topic' && i < STAGES.length - 1 && (
                  <div className="vd-act-row vd-adv">
                    <Button variant="primary" size="sm" disabled={busy} onClick={onAdvance}>这一步做完了，进入「{STAGES[i + 1].label}」</Button>
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
      {opened && <ArtifactDrawer key={opened.id} a={opened} v={v} onClose={() => onOpen(null)} />}
    </>
  )
}
