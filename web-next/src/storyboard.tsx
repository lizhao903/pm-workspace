import './storyboard.css'
import { useEffect, useState, useSyncExternalStore, type DragEvent } from 'react'
import { createPortal } from 'react-dom'
import { cls, timeAgo } from './ui'
import {
  MEDIA_PAGE, fmtSec, fmtSize, parseSec, seedMediaFiles, seedMediaRoots, seedShots, shotEst, shotSeconds, shotsFromText,
  type Broll, type MediaFile, type MediaRoot, type Shot,
} from './storyboarddata'
import type { Video } from './videodata'

// 视频详情「内容编写」编辑区的「分镜」视图和 B-roll 素材抽屉（TSK-0456，规格 SPEC-videos-17）。
// 数据约定在 storyboarddata.ts；分镜、登记的素材目录记在这个文件的内存 store 里（刷新回到演示数据），不进 App 的状态。

/* ---------- 内存 store ---------- */

type Store = { shots: Shot[]; roots: MediaRoot[] }
let store: Store = { shots: seedShots, roots: seedMediaRoots }
const subs = new Set<() => void>()
const useStore = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f) } }, () => store)
const commit = (fn: (s: Store) => Store) => { store = fn(store); subs.forEach((f) => f()) }
let seq = 100
const nid = (p: string) => `${p}_${(++seq).toString(36)}`

const setShots = (videoId: string, fn: (xs: Shot[]) => Shot[]) =>
  commit((s) => ({ ...s, shots: [...s.shots.filter((x) => x.video_id !== videoId), ...fn(s.shots.filter((x) => x.video_id === videoId))] }))
const patchShot = (videoId: string, id: string, fn: (x: Shot) => Shot) => setShots(videoId, (xs) => xs.map((x) => (x.id === id ? fn(x) : x)))
const move = <T,>(xs: T[], from: number, to: number) => { const a = [...xs]; const [x] = a.splice(from, 1); a.splice(Math.max(0, Math.min(to, a.length)), 0, x); return a }

const DRAG_MEDIA = 'application/x-pmw-media'
const DRAG_SHOT = 'application/x-pmw-shot'
const DRAG_BROLL = 'application/x-pmw-broll'

/** 文件在不在：演示磁盘里找得到、目录没被移除 */
const exists = (roots: MediaRoot[], b: Pick<Broll, 'root_id' | 'path'>) =>
  (b.root_id === 'project' || roots.some((r) => r.id === b.root_id)) && seedMediaFiles.some((f) => f.root_id === b.root_id && f.path === b.path)
const fileOf = (b: Pick<Broll, 'root_id' | 'path'>) => seedMediaFiles.find((f) => f.root_id === b.root_id && f.path === b.path)
const baseName = (p: string) => p.split('/').pop() ?? p

/** 按色相画一张缩略图（原型里没有真文件） */
function Thumb({ file, kind }: { file?: MediaFile; kind: 'image' | 'video' }) {
  if (!file) return <span className="sb-thumb-none">{kind === 'video' ? '视频' : '图片'}</span>
  const h = file.hue
  return (
    <svg viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" className="sb-thumb-svg" aria-hidden="true">
      <rect width="160" height="90" fill={`hsl(${h} 45% 42%)`} />
      <circle cx="120" cy="26" r="14" fill={`hsl(${(h + 40) % 360} 70% 70%)`} opacity="0.8" />
      <path d={`M0 90 L50 ${40 + (h % 20)} L90 70 L130 ${45 + (h % 15)} L160 60 V90 Z`} fill={`hsl(${(h + 180) % 360} 30% 22%)`} opacity="0.85" />
      {kind === 'video' && <path d="M72 35 L92 45 L72 55 Z" fill="#fff" opacity="0.9" />}
    </svg>
  )
}

/* ---------- 分镜视图 ---------- */

export function StoryboardDesk({ v, source }: {
  v: Video
  /** 生成用的稿子：当前口播稿（没有就是大纲）的正文，都没有为 undefined */
  source?: { kind: 'script' | 'outline'; version?: number; body: string }
}) {
  const s = useStore()
  const shots = s.shots.filter((x) => x.video_id === v.id)
  const [asking, setAsking] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [drawer, setDrawer] = useState<{ target: string | null } | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const total = shots.reduce((n, x) => n + shotSeconds(x), 0)
  const label = source?.kind === 'outline' ? '大纲' : '口播稿'
  const genOff = !source?.body.trim() ? '先在「文稿」里写口播稿或大纲，保存成版本' : ''

  const generate = (mode?: 'append' | 'replace') => {
    if (!source) return
    const drafts = shotsFromText(source.body)
    if (!drafts.length) { setErr(`${label}里没有能拆成分镜的段落`); return }
    setErr('')
    setShots(v.id, (xs) => [...(mode === 'append' ? xs : []), ...drafts.map((d) => ({ id: nid('vsh'), video_id: v.id, text: d.text, visual: d.visual, brolls: [] }))])
    setAsking(false)
    setMsg(`按${label}${source.version ? ` v${source.version}` : ''} ${mode === 'append' ? '追加' : '生成'}了 ${drafts.length} 个分镜`)
  }
  const addBrolls = (shotId: string, items: { root_id: string; path: string }[]) => patchShot(v.id, shotId, (x) => ({
    ...x, brolls: [...x.brolls, ...items.filter((it) => !x.brolls.some((b) => b.root_id === it.root_id && b.path === it.path))
      .map((it) => ({ id: nid('vbr'), ...it, kind: fileOf(it)?.kind ?? 'image', note: '' }))],
  }))
  const onDrop = (e: DragEvent, target: Shot, idx: number) => {
    e.preventDefault(); setOver(null)
    const sid = e.dataTransfer.getData(DRAG_SHOT)
    if (sid) { setShots(v.id, (xs) => move(xs, xs.findIndex((x) => x.id === sid), idx)); return }
    const bid = e.dataTransfer.getData(DRAG_BROLL)
    if (bid) {
      const from = shots.find((x) => x.brolls.some((b) => b.id === bid))
      const b = from?.brolls.find((x) => x.id === bid)
      if (from && b && from.id !== target.id) setShots(v.id, (xs) => xs.map((x) => (x.id === from.id ? { ...x, brolls: x.brolls.filter((y) => y.id !== bid) } : x.id === target.id ? { ...x, brolls: [...x.brolls, b] } : x)))
      return
    }
    try { addBrolls(target.id, JSON.parse(e.dataTransfer.getData(DRAG_MEDIA) || '[]')) } catch { /* 不是素材 */ }
  }

  return (
    <div className="sb-desk">
      <div className="vd-desk-bar">
        <span className="run-muted vd-desk-hint">
          {shots.length ? `${shots.length} 个分镜 · 约 ${fmtSec(total)}；拖动左边的把手排序，把素材拖到分镜上就能加入` : '按口播稿的段落拆成分镜，每个分镜配画面说明和 B-roll'}
        </span>
        <button className="act" onClick={() => setDrawer({ target: null })}>素材库</button>
        <button className="act" onClick={() => setShots(v.id, (xs) => [...xs, { id: nid('vsh'), video_id: v.id, text: '', visual: '', brolls: [] }])}>加一个分镜</button>
        <button className="act act-primary" disabled={!!genOff} title={genOff || `按${label}的标题或段落拆`} onClick={() => (shots.length ? setAsking(true) : generate())}>从{label}生成</button>
      </div>
      {asking && (
        <div className="sb-ask">
          <span>已经有 {shots.length} 个分镜。生成的初稿要：</span>
          <span className="spacer" />
          <button className="act act-primary" onClick={() => generate('append')}>追加到后面</button>
          <button className="act act-danger" title="现有分镜和它们的 B-roll 都会删掉" onClick={() => generate('replace')}>覆盖现有分镜</button>
          <button className="act act-quiet" onClick={() => setAsking(false)}>取消</button>
        </div>
      )}
      {err && <div className="field-err">{err}</div>}
      {msg && <div className="sb-ok">{msg}</div>}
      {!shots.length && <div className="sb-empty">还没有分镜。{genOff ? '先写口播稿，再一键拆成分镜；' : `点「从${label}生成」一键拆出初稿；`}也可以「加一个分镜」手写。</div>}
      <ol className="sb-list">
        {shots.map((x, i) => (
          <ShotRow key={x.id} v={v} s={x} no={i + 1} count={shots.length} roots={s.roots} over={over === x.id}
            onMove={(to) => setShots(v.id, (xs) => move(xs, i, to))}
            onAddBroll={() => setDrawer({ target: x.id })}
            onDragOver={(e) => { e.preventDefault(); setOver(x.id) }} onDragLeave={() => setOver((o) => (o === x.id ? null : o))}
            onDrop={(e) => onDrop(e, x, i)} />
        ))}
      </ol>
      {drawer && (
        <MediaDrawer v={v} shots={shots} roots={s.roots} target={drawer.target} onTarget={(id) => setDrawer({ target: id })}
          onAdd={addBrolls} onClose={() => setDrawer(null)} />
      )}
    </div>
  )
}

function ShotRow({ v, s, no, count, roots, over, onMove, onAddBroll, onDragOver, onDragLeave, onDrop }: {
  v: Video; s: Shot; no: number; count: number; roots: MediaRoot[]; over: boolean
  onMove: (to: number) => void
  onAddBroll: () => void
  onDragOver: (e: DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: DragEvent) => void
}) {
  const [del, setDel] = useState(false)
  const [dur, setDur] = useState(s.duration ? String(s.duration) : '')
  const durBad = dur.trim() !== '' && !/^\d{1,4}$/.test(dur.trim())
  const set = (fn: (x: Shot) => Shot) => patchShot(v.id, s.id, fn)
  return (
    <li className={cls('sb-shot', over && 'over')} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="sb-shot-side">
        <span className="sb-handle" draggable title="拖动排序" onDragStart={(e) => { e.dataTransfer.setData(DRAG_SHOT, s.id) }}>
          <svg viewBox="0 0 10 16" width="10" height="16">{[3, 8, 13].flatMap((y) => [2.5, 7.5].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.3" fill="currentColor" />))}</svg>
        </span>
        <span className="sb-no">{no}</span>
        <span className="sb-dur">{fmtSec(shotSeconds(s))}</span>
        <span className="sb-moves">
          <button className="sb-mini" disabled={no === 1} title="上移" onClick={() => onMove(no - 2)}>上</button>
          <button className="sb-mini" disabled={no === count} title="下移" onClick={() => onMove(no)}>下</button>
        </span>
      </div>
      <div className="sb-shot-main">
        <div className="sb-fields">
          <label className="sb-field"><span className="sb-label">口播</span>
            <textarea className="sb-text" rows={2} placeholder="这个分镜对应的口播" value={s.text} onChange={(e) => set((x) => ({ ...x, text: e.target.value }))} />
          </label>
          <div className="sb-field-col">
            <label className="sb-field"><span className="sb-label">画面</span>
              <input placeholder="画面说明：录屏、空镜、图表……" value={s.visual} onChange={(e) => set((x) => ({ ...x, visual: e.target.value }))} />
            </label>
            <label className="sb-field sb-field-dur"><span className="sb-label">时长</span>
              <input className={cls(durBad && 'bad')} inputMode="numeric" placeholder={`约 ${shotEst(s)} 秒`} value={dur} title={`不填按口播字数估（每分钟 240 字），现在约 ${shotEst(s)} 秒`}
                onChange={(e) => setDur(e.target.value)}
                onBlur={() => { if (!durBad) set((x) => ({ ...x, duration: dur.trim() ? Math.max(1, Number(dur)) : undefined })) }} />
              <span className="run-muted">秒</span>
            </label>
            {durBad && <span className="field-err">时长填 1 到 3600 的整数秒，空着按口播估</span>}
          </div>
        </div>
        <div className="sb-brolls">
          {s.brolls.map((b, i) => (
            <BrollCard key={b.id} b={b} missing={!exists(roots, b)} first={i === 0} last={i === s.brolls.length - 1}
              onPatch={(p) => set((x) => ({ ...x, brolls: x.brolls.map((y) => (y.id === b.id ? { ...y, ...p } : y)) }))}
              onMove={(d) => set((x) => ({ ...x, brolls: move(x.brolls, i, i + d) }))}
              onRemove={() => set((x) => ({ ...x, brolls: x.brolls.filter((y) => y.id !== b.id) }))} />
          ))}
          <button className="sb-add-broll" onClick={onAddBroll}>加 B-roll{!s.brolls.length && <span className="run-muted">或把素材拖到这里</span>}</button>
        </div>
      </div>
      <div className="sb-shot-end">
        {del ? (
          <span className="sb-confirm">
            <span className="run-muted">{s.brolls.length ? `连同 ${s.brolls.length} 条 B-roll 一起删，原文件不动` : '删掉这个分镜'}</span>
            <button className="act act-quiet" onClick={() => setDel(false)}>取消</button>
            <button className="act act-danger" onClick={() => setShots(v.id, (xs) => xs.filter((x) => x.id !== s.id))}>删除</button>
          </span>
        ) : <button className="act act-quiet" onClick={() => setDel(true)}>删除</button>}
      </div>
    </li>
  )
}

function BrollCard({ b, missing, first, last, onPatch, onMove, onRemove }: {
  b: Broll; missing: boolean; first: boolean; last: boolean
  onPatch: (p: Partial<Broll>) => void
  onMove: (d: number) => void
  onRemove: () => void
}) {
  const [inS, setIn] = useState(b.in != null ? fmtSec(b.in) : '')
  const [outS, setOut] = useState(b.out != null ? fmtSec(b.out) : '')
  const inV = parseSec(inS)
  const outV = parseSec(outS)
  const clipErr = inV === undefined || outV === undefined ? '入点、出点写秒数或「分:秒」' : inV != null && outV != null && outV <= inV ? '出点要晚于入点' : ''
  const save = () => { if (!clipErr) onPatch({ in: inV ?? undefined, out: outV ?? undefined }) }
  return (
    <div className={cls('sb-broll', missing && 'missing')} draggable onDragStart={(e) => e.dataTransfer.setData(DRAG_BROLL, b.id)}>
      <div className="sb-broll-thumb">
        <Thumb file={missing ? undefined : fileOf(b)} kind={b.kind} />
        {missing && <span className="sb-missing sb-missing-tag" title="文件被移走或删掉了，或素材目录已移除">缺失</span>}
      </div>
      <div className="sb-broll-body">
        <span className="sb-ellipsis sb-cell-name" title={b.path}>{baseName(b.path)}</span>
        <input className="sb-note" placeholder="备注" value={b.note} onChange={(e) => onPatch({ note: e.target.value })} />
        {b.kind === 'video' && (
          <div className="sb-clip">
            <input className={cls(inV === undefined && 'bad')} placeholder="入点" value={inS} onChange={(e) => setIn(e.target.value)} onBlur={save} />
            <span className="run-muted">到</span>
            <input className={cls(outV === undefined && 'bad')} placeholder="出点" value={outS} onChange={(e) => setOut(e.target.value)} onBlur={save} />
          </div>
        )}
        {clipErr && <span className="field-err">{clipErr}</span>}
        <div className="sb-broll-acts">
          <button className="sb-mini" disabled={first} title="往前挪" onClick={() => onMove(-1)}>前</button>
          <button className="sb-mini" disabled={last} title="往后挪" onClick={() => onMove(1)}>后</button>
          <span className="spacer" />
          <button className="sb-mini sb-mini-danger" title="从分镜里移除，原文件不动" onClick={onRemove}>移除</button>
        </div>
      </div>
    </div>
  )
}

/* ---------- 素材抽屉 ---------- */

const TYPES = [['', '全部'], ['image', '图片'], ['video', '视频']] as const

function MediaDrawer({ v, shots, roots, target, onTarget, onAdd, onClose }: {
  v: Video; shots: Shot[]; roots: MediaRoot[]; target: string | null
  onTarget: (id: string) => void
  onAdd: (shotId: string, items: { root_id: string; path: string }[]) => void
  onClose: () => void
}) {
  const all: MediaRoot[] = [{ id: 'project', name: '工程目录', path: v.root, builtin: true }, ...roots]
  const [rootId, setRootId] = useState('project')
  const [dir, setDir] = useState('')
  const [type, setType] = useState<'' | 'image' | 'video'>('')
  const [typed, setTyped] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [picked, setPicked] = useState<string[]>([])
  const [preview, setPreview] = useState<MediaFile | null>(null)
  const [managing, setManaging] = useState(false)
  const [msg, setMsg] = useState('')
  const root = all.find((r) => r.id === rootId) ?? all[0]
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const inRoot = seedMediaFiles.filter((f) => f.root_id === root.id && (root.id !== 'project' || v.id === 'vd3'))
  const under = (p: string) => !dir || p.startsWith(dir + '/')
  const rel = (p: string) => (dir ? p.slice(dir.length + 1) : p)
  const files = inRoot.filter((f) => under(f.path) && (q ? baseName(f.path).toLowerCase().includes(q.toLowerCase()) : !rel(f.path).includes('/')) && (!type || f.kind === type))
    .sort((a, b) => a.path.localeCompare(b.path))
  const dirs = q ? [] : [...new Set(inRoot.filter((f) => under(f.path) && rel(f.path).includes('/')).map((f) => rel(f.path).split('/')[0]))]
  const pages = Math.max(1, Math.ceil(files.length / MEDIA_PAGE))
  const shown = files.slice((page - 1) * MEDIA_PAGE, page * MEDIA_PAGE)
  const reset = (fn: () => void) => { fn(); setPage(1); setPicked([]); setPreview(null) }
  const targetShot = shots.find((x) => x.id === target)
  const kindText = type === 'image' ? '图片' : type === 'video' ? '视频' : '图片和视频'

  const el = (
    <aside className="drawer sb-drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">B-roll 素材</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="drawer-body sb-media">
        <div className="sb-roots">
          {all.map((r) => (
            <button key={r.id} className={cls('sb-root', root.id === r.id && 'on')} title={r.path} onClick={() => reset(() => { setRootId(r.id); setDir(''); setQ(''); setTyped('') })}>{r.name}</button>
          ))}
          <button className={cls('sb-root sb-root-add', managing && 'on')} onClick={() => setManaging(!managing)}>{managing ? '收起目录管理' : '管理目录'}</button>
        </div>
        {managing && <RootManager roots={roots} />}
        <div className="sb-tools">
          <nav className="sb-crumbs">
            <button className="sb-crumb" title={root.path} onClick={() => reset(() => setDir(''))}>{root.name}</button>
            {dir.split('/').filter(Boolean).map((seg, i, a) => (
              <span key={i} className="sb-crumb-seg"><span>/</span><button className="sb-crumb" onClick={() => reset(() => setDir(a.slice(0, i + 1).join('/')))}>{seg}</button></span>
            ))}
          </nav>
          <span className="spacer" />
          <span className="seg seg-sm">{TYPES.map(([k, l]) => <button key={k} className={cls(type === k && 'on')} onClick={() => reset(() => setType(k))}>{l}</button>)}</span>
          <form className="sb-search" onSubmit={(e) => { e.preventDefault(); reset(() => setQ(typed.trim())) }}>
            <input placeholder="搜文件名（含子目录）" value={typed} onChange={(e) => setTyped(e.target.value)} />
            {q && <button type="button" className="act act-quiet" onClick={() => reset(() => { setQ(''); setTyped('') })}>清除</button>}
          </form>
        </div>
        {(dir || dirs.length > 0) && !q && (
          <div className="sb-dirs">
            {dir && <button className="chip" onClick={() => reset(() => setDir(dir.split('/').slice(0, -1).join('/')))}>上一级</button>}
            {dirs.map((d) => <button key={d} className="chip" onClick={() => reset(() => setDir(dir ? `${dir}/${d}` : d))}>{d}/</button>)}
          </div>
        )}
        {shown.length === 0 ? <div className="sb-empty">{q ? `没有文件名含「${q}」的${kindText}` : `这个目录里没有${kindText}`}</div> : (
          <ul className="sb-grid">
            {shown.map((f) => {
              const on = picked.includes(f.path)
              return (
                <li key={f.path} className={cls('sb-cell', on && 'on', preview?.path === f.path && 'active')} draggable
                  onDragStart={(e) => e.dataTransfer.setData(DRAG_MEDIA, JSON.stringify((on ? picked : [f.path]).map((path) => ({ root_id: root.id, path }))))}>
                  <button className="sb-thumb" onClick={() => setPreview(preview?.path === f.path ? null : f)} title="预览">
                    <Thumb file={f} kind={f.kind} />
                    {f.kind === 'video' && f.duration && <span className="sb-badge">{fmtSec(f.duration)}</span>}
                  </button>
                  <label className="sb-cell-info">
                    <input type="checkbox" checked={on} onChange={() => setPicked((xs) => (on ? xs.filter((x) => x !== f.path) : [...xs, f.path]))} />
                    <span className="sb-cell-text">
                      <span className="sb-ellipsis sb-cell-name" title={f.path}>{baseName(f.path)}</span>
                      <span className="run-muted sb-ellipsis">{[f.width && `${f.width}×${f.height}`, f.duration && fmtSec(f.duration), fmtSize(f.size)].filter(Boolean).join(' · ')}</span>
                      <span className="run-muted">{timeAgo(f.modified_at)}</span>
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        )}
        {pages > 1 ? (
          <div className="sb-pager">
            <button className="act" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
            <span className="run-muted">第 {page} / {pages} 页 · 共 {files.length} 个</span>
            <button className="act" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</button>
          </div>
        ) : files.length > 0 && <div className="run-muted">共 {files.length} 个{picked.length ? `，选了 ${picked.length} 个` : ''}</div>}
        {preview && (
          <section className="sb-preview">
            <div className="sb-preview-head"><b className="sb-ellipsis">{baseName(preview.path)}</b><span className="spacer" /><button className="act act-quiet" onClick={() => setPreview(null)}>关闭预览</button></div>
            <div className="sb-preview-media"><Thumb file={preview} kind={preview.kind} /></div>
            {preview.kind === 'video' && <div className="run-muted">正式版用播放器播放原文件，能拖进度（后端支持 Range）；原型里只显示画面</div>}
          </section>
        )}
        {msg && <div className="sb-ok">{msg}</div>}
      </div>
      <div className="drawer-foot">
        <span className="run-muted">加到</span>
        <select className="sb-select" value={target ?? ''} onChange={(e) => onTarget(e.target.value)}>
          <option value="" disabled>选一个分镜</option>
          {shots.map((x, i) => <option key={x.id} value={x.id}>第 {i + 1} 个{x.visual ? `：${x.visual.slice(0, 16)}` : ''}</option>)}
        </select>
        <span className="spacer" />
        <button className="act act-primary" disabled={!targetShot || !picked.length}
          title={!shots.length ? '先加一个分镜' : !targetShot ? '先选加到哪个分镜' : !picked.length ? '先勾选文件' : undefined}
          onClick={() => {
            if (!targetShot) return
            onAdd(targetShot.id, picked.map((path) => ({ root_id: root.id, path })))
            setMsg(`已加到第 ${shots.indexOf(targetShot) + 1} 个分镜：${picked.length} 个`); setPicked([])
          }}>加入分镜{picked.length ? ` ${picked.length} 个` : ''}</button>
      </div>
    </aside>
  )
  const shell = typeof document !== 'undefined' ? document.querySelector('.shell') : null
  return shell ? createPortal(el, shell) : el
}

function RootManager({ roots }: { roots: MediaRoot[] }) {
  const [path, setPath] = useState('')
  const [err, setErr] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  const add = () => {
    const p = path.trim().replace(/\/+$/, '')
    if (!p.startsWith('/')) { setErr('填绝对路径，以 / 开头'); return }
    if (p === '' || p === '/') { setErr('不能登记整个磁盘的根目录，选一个具体的素材目录'); return }
    if (p.split('/').some((x) => x.startsWith('.'))) { setErr('路径里有隐藏目录，不能登记'); return }
    if (roots.some((r) => r.path === p)) { setErr('这个目录已经登记过了'); return }
    setErr('')
    commit((s) => ({ ...s, roots: [...s.roots, { id: nid('vmr'), name: p.split('/').pop() ?? p, path: p }] }))
    setPath('')
  }
  return (
    <div className="sb-manage">
      <div className="run-muted sb-wrap">登记本机目录当素材库，只读，不会移动、修改、删除里面的文件。读工程目录以外的目录要视频插件的「只读你登记的目录」权限（fs:read:registered）。</div>
      <form className="sb-manage-add" onSubmit={(e) => { e.preventDefault(); add() }}>
        <input className={cls('mono', err && 'bad')} placeholder="/Users/me/Movies/素材" value={path} onChange={(e) => { setPath(e.target.value); setErr('') }} />
        <button type="button" className="act" title="正式版打开目录选择器（同任务的工作目录）">选目录</button>
        <button type="submit" className="act act-primary" disabled={!path.trim()}>登记</button>
      </form>
      {err && <div className="field-err">{err}</div>}
      {roots.length ? (
        <ul className="sb-manage-list">
          {roots.map((r) => (
            <li key={r.id}>
              <span className="sb-ellipsis"><b>{r.name}</b> <span className="mono run-muted">{r.path}</span></span>
              <span className="spacer" />
              {removing === r.id ? (
                <>
                  <span className="run-muted">分镜里用到的会标缺失</span>
                  <button className="act act-quiet" onClick={() => setRemoving(null)}>取消</button>
                  <button className="act act-danger" onClick={() => commit((s) => ({ ...s, roots: s.roots.filter((x) => x.id !== r.id) }))}>移除</button>
                </>
              ) : <button className="act act-quiet" onClick={() => setRemoving(r.id)}>移除</button>}
            </li>
          ))}
        </ul>
      ) : <div className="run-muted">还没登记别的目录</div>}
    </div>
  )
}
