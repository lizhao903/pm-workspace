import { Fragment, useEffect, useState, type ReactNode } from 'react'
import './topics.css'
import { PageTitle } from './topbar'
import { cls, timeAgo } from './ui'
import { newId } from './ids'
import { PLATFORMS, type PlatformKey, type Series, type Video } from './videodata'
import {
  CLIP_KIND, COMMENT_POOL, TOPIC_FLOW, TOPIC_STATUS, TREND_POOL, topicPriority,
  type Clip, type ClipKind, type Topic, type TopicScore, type TopicStatus,
} from './topicdata'

// 视频博主：选题看板 + 素材收件箱
// 素材先进收件箱「待整理」，看过的归到选题或转成新选题；选题打分排优先级，立项时生成一集视频

const now = () => new Date().toISOString()
const SCORE_LABEL: Record<keyof TopicScore, { label: string; hint: string }> = {
  demand: { label: '需求度', hint: '有多少人想看' },
  fit: { label: '契合度', hint: '和账号定位合不合' },
  effort: { label: '制作成本', hint: '越高越难做' },
}

function useEsc(fn: () => void) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); fn() } }
    window.addEventListener('keydown', on, true)
    return () => window.removeEventListener('keydown', on, true)
  }, [fn])
}

const StatusPill = ({ s }: { s: TopicStatus }) => <span className="pill" style={{ '--c': TOPIC_STATUS[s].color } as React.CSSProperties}><span className="pill-dot" />{TOPIC_STATUS[s].label}</span>
const PriorityBadge = ({ score }: { score: TopicScore }) => {
  const p = topicPriority(score)
  return <span className={cls('tp-prio', p >= 8 ? 'hi' : p >= 6 ? 'mid' : 'lo')} title="按需求度、契合度、制作成本算出的优先级，满分 10">{p.toFixed(1)}</span>
}
/** 看板每列先露几张，表格、收件箱一次渲染多少条 */
const COL_PEEK = 8
const PAGE = 50
const More = ({ left, onMore, unit = '条' }: { left: number; onMore: () => void; unit?: string }) => (left > 0 ? <button className="tp-more" onClick={onMore}>显示更多（还有 {left} {unit}）</button> : null)
/** 收进来的日子：今天 / 昨天 / 本周 / 更早 */
function dayGroup(iso: string) {
  const d = new Date(iso).getTime(), n = new Date()
  const day0 = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()
  if (d >= day0) return '今天'
  if (d >= day0 - 86400000) return '昨天'
  return d >= day0 - ((n.getDay() + 6) % 7) * 86400000 ? '本周' : '更早'
}
const SearchIcon = () => <svg viewBox="0 0 16 16" width="13" height="13"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
const KindTag = ({ k }: { k: ClipKind }) => <span className="tp-kind" style={{ '--c': CLIP_KIND[k].color } as React.CSSProperties}>{CLIP_KIND[k].label}</span>

/* ---------- 选题 ---------- */

export function TopicsPage({ topics, clips, series, videos, focus, onTopics, onClips, onMakeVideo, onOpenVideo, tabs }: {
  topics: Topic[]; clips: Clip[]; series: Series[]; videos: Video[]
  /** 外部要求打开某个选题（素材页「去选题」），n 变化触发 */
  focus: { id: string; n: number } | null
  onTopics: (fn: (xs: Topic[]) => Topic[]) => void
  onClips: (fn: (xs: Clip[]) => Clip[]) => void
  /** 立项：生成一集视频，返回视频 id */
  onMakeVideo: (t: Topic) => string
  onOpenVideo: (id: string) => void
  /** 旧接线还在传；素材收件箱改从模块标签进 */
  onOpenClips?: () => void
  /** 模块标签栏，放在顶栏下面 */
  tabs?: ReactNode
}) {
  const [view, setView] = useState<'board' | 'table'>('board')
  const [q, setQ] = useState('')
  const [sr, setSr] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [showDropped, setShowDropped] = useState(false)
  const [st, setSt] = useState<'' | TopicStatus>('')
  /** 看板上点了「展开」的列 */
  const [openCols, setOpenCols] = useState<TopicStatus[]>([])
  const [limit, setLimit] = useState(PAGE)
  const [seen, setSeen] = useState(0)
  if (focus && focus.n !== seen) { setSeen(focus.n); setOpen(focus.id) }
  const kw = q.trim().toLowerCase()
  const rows = topics.filter((t) => (!kw || `${t.title}${t.angle}${t.tags.join('')}`.toLowerCase().includes(kw)) && (!sr || (sr === '-' ? !t.series_id : t.series_id === sr))
    && (view === 'board' || !st || t.status === st))
    .sort((a, b) => topicPriority(b.score) - topicPriority(a.score) || b.updated_at.localeCompare(a.updated_at))
  const cols = TOPIC_FLOW.filter((s) => s !== 'dropped' || showDropped)
  const create = () => {
    const t: Topic = { id: newId('tp'), title: '', angle: '', audience: '', status: 'idea', score: { demand: 3, fit: 3, effort: 3 }, tags: [], platforms: [], outline: '', clip_ids: [], created_at: now(), updated_at: now() }
    onTopics((xs) => [t, ...xs]); setOpen(t.id)
  }
  const cur = topics.find((t) => t.id === open)

  const Card = ({ t }: { t: Topic }) => (
    <button className="tp-card" onClick={() => setOpen(t.id)}>
      <span className="tp-card-top"><b className="tp-card-title">{t.title || '未命名选题'}</b><PriorityBadge score={t.score} /></span>
      {t.angle && <span className="tp-card-angle">{t.angle}</span>}
      <span className="tp-card-meta">
        {t.series_id && <span className="tag">{series.find((s) => s.id === t.series_id)?.name ?? '已删除的系列'}</span>}
        {t.clip_ids.length > 0 && <span className="run-muted">{t.clip_ids.length} 条素材</span>}
        {t.planned_at && <span className="run-muted">{new Date(t.planned_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} 开做</span>}
        {t.video_id && <span className="run-muted">已立项</span>}
      </span>
    </button>
  )

  return (
    <div className="page page-fill">
      <PageTitle parent="视频" count={topics.length} desc="从收集的素材里挑题、打分、想清楚角度，可开拍了就立项成视频" actions={<>
        <button className="btn btn-primary" onClick={create}>新建选题</button>
      </>}>选题</PageTitle>
      {tabs}

      <div className="toolbar">
        <div className="search vd-search">
          <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder="搜标题、角度、标签" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE) }} />
        </div>
        {view === 'table' && (
          <div className={cls('chip chip-select', st && 'chip-on')}>
            <select value={st} onChange={(e) => { setSt(e.target.value as TopicStatus | ''); setLimit(PAGE) }}>
              <option value="">全部状态</option>
              {TOPIC_FLOW.map((s) => <option key={s} value={s}>{TOPIC_STATUS[s].label}（{topics.filter((t) => t.status === s).length}）</option>)}
            </select>
          </div>
        )}
        <div className={cls('chip chip-select', sr && 'chip-on')}>
          <select value={sr} onChange={(e) => { setSr(e.target.value); setLimit(PAGE) }}>
            <option value="">全部系列</option>
            {series.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="-">不属于系列</option>
          </select>
        </div>
        <span className="spacer" />
        {view === 'board' && <button className={cls('chip', showDropped && 'chip-on')} onClick={() => setShowDropped(!showDropped)}>显示已放弃</button>}
        <div className="seg seg-sm">
          <button className={cls(view === 'board' && 'on')} onClick={() => setView('board')}>看板</button>
          <button className={cls(view === 'table' && 'on')} onClick={() => setView('table')}>表格</button>
        </div>
      </div>

      {!topics.length ? (
        <div className="empty"><div className="empty-title">还没有选题</div><div className="list-sub">先去素材收件箱收点东西，或者直接新建一个</div></div>
      ) : view === 'board' ? (
        <div className="tp-board">
          {cols.map((s) => {
            const xs = rows.filter((t) => t.status === s)
            // 每列按优先级露前几张；已做成、已放弃的往往最多，也最不用看
            const all = openCols.includes(s)
            return (
              <section key={s} className="tp-col">
                <div className="tp-col-head"><StatusPill s={s} /><span className="run-muted">{xs.length}</span></div>
                <div className="tp-col-body">
                  {(all ? xs : xs.slice(0, COL_PEEK)).map((t) => <Card key={t.id} t={t} />)}
                  {!xs.length && <div className="tp-col-empty">{TOPIC_STATUS[s].desc}</div>}
                  {xs.length > COL_PEEK && (
                    <button className="tp-col-more" onClick={() => setOpenCols(all ? openCols.filter((x) => x !== s) : [...openCols, s])}>
                      {all ? '收起' : `还有 ${xs.length - COL_PEEK} 个`}
                    </button>
                  )}
                </div>
              </section>
            )
          })}
        </div>
      ) : (
        <div className="task-table">
          <div className="tp-row task-th"><span>优先级</span><span>选题</span><span>系列</span><span>素材</span><span>状态</span><span>更新</span></div>
          {rows.slice(0, limit).map((t) => (
            <div key={t.id} className="tp-row" onClick={() => setOpen(t.id)}>
              <span><PriorityBadge score={t.score} /></span>
              <span className="task-main"><span className="task-title"><span className="ellipsis">{t.title || '未命名选题'}</span></span>{t.angle && <span className="task-meta"><span className="ellipsis">{t.angle}</span></span>}</span>
              <span className="ellipsis run-muted">{series.find((x) => x.id === t.series_id)?.name ?? '-'}</span>
              <span className="run-muted">{t.clip_ids.length}</span>
              <span><StatusPill s={t.status} /></span>
              <span className="run-muted">{timeAgo(t.updated_at)}</span>
            </div>
          ))}
          {!rows.length && <div className="tree-empty">没有匹配的选题</div>}
          <More left={rows.length - limit} onMore={() => setLimit(limit + PAGE)} />
        </div>
      )}

      {cur && <TopicDrawer key={cur.id} t={cur} clips={clips} series={series} video={videos.find((v) => v.id === cur.video_id)}
        onClose={() => setOpen(null)}
        onSave={(t) => onTopics((xs) => xs.map((x) => (x.id === t.id ? { ...t, updated_at: now() } : x)))}
        onDelete={() => {
          onClips((xs) => xs.map((c) => ({ ...c, topic_ids: c.topic_ids.filter((x) => x !== cur.id) })))
          onTopics((xs) => xs.filter((x) => x.id !== cur.id)); setOpen(null)
        }}
        onUnlinkClip={(cid) => {
          onTopics((xs) => xs.map((x) => (x.id === cur.id ? { ...x, clip_ids: x.clip_ids.filter((c) => c !== cid) } : x)))
          onClips((xs) => xs.map((c) => (c.id === cid ? { ...c, topic_ids: c.topic_ids.filter((x) => x !== cur.id) } : c)))
        }}
        onMake={() => { const vid = onMakeVideo(cur); onTopics((xs) => xs.map((x) => (x.id === cur.id ? { ...x, status: 'made', video_id: vid, updated_at: now() } : x))); setOpen(null); onOpenVideo(vid) }}
        onOpenVideo={onOpenVideo} />}
    </div>
  )
}

function TopicDrawer({ t, clips, series, video, onClose, onSave, onDelete, onUnlinkClip, onMake, onOpenVideo }: {
  t: Topic; clips: Clip[]; series: Series[]; video?: Video
  onClose: () => void; onSave: (t: Topic) => void; onDelete: () => void; onUnlinkClip: (id: string) => void
  onMake: () => void; onOpenVideo: (id: string) => void
}) {
  useEsc(onClose)
  const [confirmDel, setConfirmDel] = useState(false)
  const set = (x: Partial<Topic>) => onSave({ ...t, ...x })
  const mine = clips.filter((c) => t.clip_ids.includes(c.id))
  const togglePlat = (k: PlatformKey) => set({ platforms: t.platforms.includes(k) ? t.platforms.filter((x) => x !== k) : [...t.platforms, k] })
  const canMake = !t.video_id && t.status !== 'dropped' && !!t.title.trim()
  return (
    <aside className="drawer tp-drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">选题</span>
        <PriorityBadge score={t.score} />
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="drawer-body form">
        <label className="field"><span className="field-label">标题</span><input value={t.title} placeholder="这一期讲什么" autoFocus={!t.title} onChange={(e) => set({ title: e.target.value })} /></label>
        <div className="field">
          <span className="field-label">状态</span>
          <div className="tp-status-row">
            {TOPIC_FLOW.map((s) => <button key={s} type="button" className={cls('chip', t.status === s && 'chip-on')} disabled={s === 'made' && !t.video_id} title={s === 'made' && !t.video_id ? '立项后自动变成已做成' : TOPIC_STATUS[s].desc} onClick={() => set({ status: s })}>{TOPIC_STATUS[s].label}</button>)}
          </div>
        </div>
        {t.status === 'dropped' && <label className="field"><span className="field-label">放弃原因</span><input value={t.drop_reason ?? ''} placeholder="以后回看时知道为什么没做" onChange={(e) => set({ drop_reason: e.target.value })} /></label>}
        {t.status === 'scheduled' && <label className="field"><span className="field-label">计划开做</span><input type="date" value={t.planned_at?.slice(0, 10) ?? ''} onChange={(e) => set({ planned_at: e.target.value ? new Date(e.target.value).toISOString() : undefined })} /></label>}
        <label className="field"><span className="field-label">切入角度</span><textarea rows={2} value={t.angle} placeholder="同一个题，从哪个角度讲和别人不一样" onChange={(e) => set({ angle: e.target.value })} /></label>
        <label className="field"><span className="field-label">目标受众</span><input value={t.audience} placeholder="讲给谁听" onChange={(e) => set({ audience: e.target.value })} /></label>

        <div className="field">
          <span className="field-label">打分<span className="field-hint">优先级 {topicPriority(t.score).toFixed(1)} / 10</span></span>
          {(Object.keys(SCORE_LABEL) as (keyof TopicScore)[]).map((k) => (
            <div key={k} className="tp-score">
              <span className="tp-score-label">{SCORE_LABEL[k].label}<span className="run-muted">{SCORE_LABEL[k].hint}</span></span>
              <span className="tp-dots">
                {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" className={cls('tp-dot', n <= t.score[k] && 'on', k === 'effort' && 'cost')} onClick={() => set({ score: { ...t.score, [k]: n } })} aria-label={`${SCORE_LABEL[k].label} ${n}`} />)}
              </span>
            </div>
          ))}
        </div>

        <div className="field-row">
          <label className="field"><span className="field-label">系列</span>
            <select value={t.series_id ?? ''} onChange={(e) => set({ series_id: e.target.value || undefined })}>
              <option value="">不属于系列</option>
              {series.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="field"><span className="field-label">标签</span><input value={t.tags.join('，')} placeholder="逗号分隔" onChange={(e) => set({ tags: e.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean) })} /></label>
        </div>
        <div className="field">
          <span className="field-label">发哪些平台</span>
          <div className="tp-status-row">{PLATFORMS.map((p) => <button key={p.key} type="button" className={cls('chip', t.platforms.includes(p.key) && 'chip-on')} onClick={() => togglePlat(p.key)}>{p.label}</button>)}</div>
        </div>
        <label className="field"><span className="field-label">大纲草稿</span><textarea rows={5} className="mono" value={t.outline} placeholder={'1. 开场问题\n2. 主体\n3. 结论'} onChange={(e) => set({ outline: e.target.value })} /></label>

        <div className="field">
          <span className="field-label">关联素材 {mine.length}<span className="field-hint">在素材收件箱里把素材归到这个选题</span></span>
          {mine.length ? mine.map((c) => (
            <div key={c.id} className="tp-clip-mini">
              <KindTag k={c.kind} /><span className="ellipsis">{c.title}</span><span className="spacer" /><span className="run-muted">{c.source}</span>
              <button className="icon-btn icon-btn-sm" title="取消关联" onClick={() => onUnlinkClip(c.id)}><svg viewBox="0 0 16 16" width="10" height="10"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg></button>
            </div>
          )) : <div className="mount-empty">还没有关联素材</div>}
        </div>
      </div>
      <div className="drawer-foot">
        {confirmDel ? (
          <><span className="danger-text">删除后不能恢复，关联的素材保留</span><div className="spacer" /><button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>取消</button><button className="btn btn-danger" onClick={onDelete}>删除</button></>
        ) : (
          <>
            <button className="btn btn-danger-ghost" onClick={() => setConfirmDel(true)}>删除</button>
            <div className="spacer" />
            {video ? <button className="btn btn-outline" onClick={() => onOpenVideo(video.id)}>打开视频：{video.title}</button>
              : <button className="btn btn-primary" disabled={!canMake} title={!t.title.trim() ? '先写标题' : t.status === 'dropped' ? '已放弃的选题不能立项' : '生成一集视频，从内容编写开始'} onClick={onMake}>立项做成视频</button>}
          </>
        )}
      </div>
    </aside>
  )
}

/* ---------- 素材收件箱 ---------- */

// 模拟拉取的进度：每次取下一批，取完就没有新的
let trendCursor = 0
let commentCursor = 0

export function ClipsPage({ clips, topics, onClips, onTopics, onOpenTopic, tabs }: {
  clips: Clip[]; topics: Topic[]
  /** 模块标签栏，放在顶栏下面 */
  tabs?: ReactNode
  onClips: (fn: (xs: Clip[]) => Clip[]) => void
  onTopics: (fn: (xs: Topic[]) => Topic[]) => void
  onOpenTopic: (id: string) => void
}) {
  const [box, setBox] = useState<'todo' | 'starred' | 'all'>('todo')
  const [kind, setKind] = useState<'' | ClipKind>('')
  const [q, setQ] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<'' | 'trend' | 'comment'>('')
  const [note, setNote] = useState('')
  const [assign, setAssign] = useState<string | null>(null)
  const [assignQ, setAssignQ] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const kw = q.trim().toLowerCase()
  const rows = clips.filter((c) => (box === 'all' || (box === 'todo' ? !c.triaged : c.starred)) && (!kind || c.kind === kind)
    && (!kw || `${c.title}${c.content}${c.source}${c.tags.join('')}`.toLowerCase().includes(kw)))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const patch = (id: string, x: Partial<Clip>) => onClips((xs) => xs.map((c) => (c.id === id ? { ...c, ...x } : c)))

  // 粘贴一行：像网址就当链接，否则当笔记
  const add = () => {
    const t = draft.trim()
    if (!t) return
    const isUrl = /^https?:\/\//.test(t)
    const c: Clip = { id: newId('cl'), kind: isUrl ? 'link' : 'note', title: isUrl ? t.replace(/^https?:\/\//, '').slice(0, 60) : t.slice(0, 40), content: isUrl ? '' : t, url: isUrl ? t : undefined,
      source: '手动添加', tags: [], starred: false, topic_ids: [], triaged: false, created_at: now() }
    onClips((xs) => [c, ...xs]); setDraft('')
  }
  const pull = (what: 'trend' | 'comment') => {
    setBusy(what); setNote('')
    window.setTimeout(() => {
      const pool = what === 'trend' ? TREND_POOL : COMMENT_POOL
      const i = what === 'trend' ? trendCursor : commentCursor
      const batch = pool[i] ?? []
      if (what === 'trend') trendCursor = i + 1; else commentCursor = i + 1
      if (batch.length) onClips((xs) => [...batch.map((x) => ({ ...x, id: newId('cl'), created_at: now() })), ...xs])
      setNote(batch.length ? `收进 ${batch.length} 条${what === 'trend' ? '热榜' : '评论'}` : `没有新的${what === 'trend' ? '热榜' : '评论'}`)
      setBusy('')
    }, 900)
  }
  const toTopic = (c: Clip) => {
    const t: Topic = { id: newId('tp'), title: c.title, angle: '', audience: '', status: 'idea', score: { demand: c.heat && c.heat > 10000 ? 4 : 3, fit: 3, effort: 3 }, tags: c.tags, platforms: [], outline: c.content, clip_ids: [c.id], created_at: now(), updated_at: now() }
    onTopics((xs) => [t, ...xs]); patch(c.id, { topic_ids: [...c.topic_ids, t.id], triaged: true }); onOpenTopic(t.id)
  }
  const link = (c: Clip, tid: string) => {
    onTopics((xs) => xs.map((t) => (t.id === tid && !t.clip_ids.includes(c.id) ? { ...t, clip_ids: [...t.clip_ids, c.id], updated_at: now() } : t)))
    patch(c.id, { topic_ids: c.topic_ids.includes(tid) ? c.topic_ids : [...c.topic_ids, tid], triaged: true }); setAssign(null)
  }
  const open = topics.filter((t) => t.status !== 'made' && t.status !== 'dropped')
  const n = (b: typeof box) => clips.filter((c) => (b === 'all' ? true : b === 'todo' ? !c.triaged : c.starred)).length

  return (
    <div className="page page-fill">
      <PageTitle parent="视频" count={clips.length} desc="评论、热榜、竞品、聊天里冒出来的点子先收进来，再挑出值得做的变成选题" actions={<>
        {note && <span className="sync-note">{note}</span>}
        <button className="btn btn-outline" disabled={!!busy} onClick={() => pull('trend')}>{busy === 'trend' ? '拉取中…' : '拉取热榜'}</button>
        <button className="btn btn-outline" disabled={!!busy} onClick={() => pull('comment')}>{busy === 'comment' ? '收集中…' : '收集评论'}</button>
      </>}>素材收件箱</PageTitle>
      {tabs}

      <div className="tp-add">
        <input value={draft} placeholder="粘贴链接，或者随手记一句想法，回车收进来" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) add() }} />
        <button className="btn btn-primary" disabled={!draft.trim()} onClick={add}>收进来</button>
      </div>

      <div className="toolbar">
        <div className="seg">
          {([['todo', '待整理'], ['starred', '收藏'], ['all', '全部']] as const).map(([k, l]) => <button key={k} className={cls(box === k && 'on')} onClick={() => { setBox(k); setLimit(PAGE) }}>{l}<span className="seg-n">{n(k)}</span></button>)}
        </div>
        <div className="search vd-search">
          <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder="搜标题、内容、来源" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE) }} />
        </div>
        <span className="spacer" />
        <div className="channel-filter">
          <button className={cls('ch-btn', !kind && 'on')} onClick={() => { setKind(''); setLimit(PAGE) }}>全部类型</button>
          {(Object.keys(CLIP_KIND) as ClipKind[]).map((k) => <button key={k} className={cls('ch-btn', kind === k && 'on')} style={{ '--c': CLIP_KIND[k].color } as React.CSSProperties} onClick={() => { setKind(kind === k ? '' : k); setLimit(PAGE) }}><i className="pill-dot" />{CLIP_KIND[k].label}</button>)}
        </div>
      </div>

      {!rows.length ? (
        <div className="empty"><div className="empty-title">{box === 'todo' ? '待整理的都处理完了' : '这里没有素材'}</div><div className="list-sub">在上面粘贴链接，或者拉取热榜、收集评论</div></div>
      ) : (
        <div className="tp-clips">
          {rows.slice(0, limit).map((c, i) => (
            <Fragment key={c.id}>
            {dayGroup(c.created_at) !== (i ? dayGroup(rows[i - 1].created_at) : '') && <div className="tp-day">{dayGroup(c.created_at)}</div>}
            <div className={cls('tp-clip', !c.triaged && 'todo')}>
              <div className="tp-clip-top">
                <KindTag k={c.kind} />
                {c.url ? <a className="link-btn ellipsis tp-clip-title" href={c.url} target="_blank" rel="noreferrer">{c.title}</a> : <b className="ellipsis tp-clip-title">{c.title}</b>}
                <span className="spacer" />
                {c.heat !== undefined && <span className="run-muted" title="热度、点赞或播放数">{c.heat.toLocaleString()}</span>}
                <span className="run-muted">{timeAgo(c.created_at)}</span>
              </div>
              {c.content && c.content !== c.title && <div className="tp-clip-text">{c.content}</div>}
              <div className="tp-clip-foot">
                <span className="run-muted ellipsis">{c.source}</span>
                {c.topic_ids.map((tid) => { const t = topics.find((x) => x.id === tid); return t && <button key={tid} className="tag tp-linked" onClick={() => onOpenTopic(tid)}>选题：{t.title || '未命名'}</button> })}
                <span className="spacer" />
                <button className={cls('act act-quiet', c.starred && 'on')} onClick={() => patch(c.id, { starred: !c.starred })}>{c.starred ? '已收藏' : '收藏'}</button>
                <button className="act" onClick={() => toTopic(c)}>转为选题</button>
                <span className="menu-wrap">
                  <button className="act" disabled={!open.length} title={open.length ? undefined : '没有进行中的选题'} onClick={() => { setAssign(assign === c.id ? null : c.id); setAssignQ('') }}>归到选题</button>
                  {assign === c.id && (
                    <div className="menu tp-assign">
                      <div className="menu-label">归到哪个选题</div>
                      {open.length > 8 && (
                        <div className="search search-sm tp-assign-search">
                          <SearchIcon />
                          <input autoFocus value={assignQ} placeholder={`搜选题，共 ${open.length} 个`} onChange={(e) => setAssignQ(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Escape') setAssign(null) }} />
                        </div>
                      )}
                      {open.filter((t) => !assignQ.trim() || `${t.title} ${t.tags.join(' ')}`.toLowerCase().includes(assignQ.trim().toLowerCase())).map((t) => <button key={t.id} className="menu-item" disabled={c.topic_ids.includes(t.id)} onClick={() => link(c, t.id)}><span className="ellipsis">{t.title || '未命名选题'}</span><span className="list-sub">{TOPIC_STATUS[t.status].label}</span></button>)}
                    </div>
                  )}
                </span>
                {!c.triaged && <button className="act act-quiet" onClick={() => patch(c.id, { triaged: true })}>看过了</button>}
                <button className="act act-quiet" onClick={() => { onClips((xs) => xs.filter((x) => x.id !== c.id)); onTopics((xs) => xs.map((t) => ({ ...t, clip_ids: t.clip_ids.filter((x) => x !== c.id) }))) }}>删除</button>
              </div>
            </div>
            </Fragment>
          ))}
          <More left={rows.length - limit} onMore={() => setLimit(limit + PAGE)} />
        </div>
      )}
    </div>
  )
}
