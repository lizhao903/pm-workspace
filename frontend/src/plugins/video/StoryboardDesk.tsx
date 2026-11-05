// 内容编写的「分镜」视图（TSK-0456，同原型 storyboard.tsx 的 StoryboardDesk，规格 SPEC-videos-17.1 到 17.9）。
// 每期视频一份有序的分镜：序号、对应的口播段落、画面说明、时长（手填，没填按口播字数估）、B-roll。
// 「从口播稿生成」按当前口播稿（没有就用大纲）的标题或段落拆，已有分镜时先问追加还是覆盖。
// 分镜行能拖动排序（也有上移、下移），B-roll 从素材抽屉勾选加入，或者直接把文件拖到分镜上；B-roll 能排序、写备注、
// 设入点出点（视频）、拖到别的分镜、移除；文件被移走或删掉的标「缺失」。数据都走 core/data 的 storyboard。
import { useState, type DragEvent } from 'react'
import {
  errorText, isApiError, mediaThumbUrl, useAddBrolls, useAddShot, useGenerateShots, usePatchBroll, usePatchShot, useRemoveBroll, useRemoveShot,
  useReorderBrolls, useReorderShots, useShots, type Video, type VideoArtifact, type VideoBroll, type VideoShot,
} from '../../core/data'
import { Button, Input, Textarea, cls } from '../../core/ui'
import { MediaDrawer } from './MediaDrawer'
import { latestText } from './scriptModel'
import { DRAG_MEDIA, DRAG_SHOT, clipText, fmtSec, moveId, parseSec, readDragged, shotSeconds, totalSeconds } from './storyboardModel'
import './storyboard.css'

const DRAG_BROLL = 'application/x-pmw-broll'

export function StoryboardDesk({ v, arts }: { v: Video; arts: VideoArtifact[] }) {
  const shots = useShots(v.id)
  const gen = useGenerateShots(v.id)
  const addShot = useAddShot(v.id)
  const reorder = useReorderShots(v.id)
  const addBrolls = useAddBrolls(v.id)
  const patchBroll = usePatchBroll(v.id)
  const [asking, setAsking] = useState(false)
  const [drawer, setDrawer] = useState<{ target: string | null } | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [genMsg, setGenMsg] = useState('')
  const xs = shots.data ?? []
  const hasScript = !!latestText(arts, 'script', v.orientations[0]) || arts.some((a) => a.kind === 'script')
  const hasOutline = arts.some((a) => a.kind === 'outline')
  const genOff = !hasScript && !hasOutline ? '先在「文稿」里写口播稿或大纲，保存成版本' : ''

  const generate = (mode?: 'append' | 'replace') => {
    setGenMsg('')
    gen.mutate(mode ? { mode } : {}, {
      onSuccess: (r) => {
        setAsking(false)
        setGenMsg(`按${r.source.kind === 'script' ? '口播稿' : '大纲'} v${r.source.version} ${mode === 'append' ? '追加' : '生成'}了 ${r.added} 个分镜`)
      },
      onError: (e) => { if (isApiError(e, 'conflict')) setAsking(true) },
    })
  }
  const onGenerate = () => { if (xs.length) setAsking(true); else generate() }

  // 拖放：分镜行排序、素材拖进分镜、B-roll 挪到别的分镜
  const onDrop = (e: DragEvent, target: VideoShot) => {
    e.preventDefault()
    setDragOver(null)
    const sid = e.dataTransfer.getData(DRAG_SHOT)
    if (sid && sid !== target.id) {
      reorder.mutate(moveId(xs.map((s) => s.id), sid, target.no - 1))
      return
    }
    const bid = e.dataTransfer.getData(DRAG_BROLL)
    if (bid) {
      if (!target.brolls.some((b) => b.id === bid)) patchBroll.mutate({ id: bid, shot_id: target.id })
      return
    }
    const items = readDragged(e.dataTransfer.getData(DRAG_MEDIA))
    if (items.length) addBrolls.mutate({ shotId: target.id, items })
  }
  const accepts = (e: DragEvent) => [DRAG_SHOT, DRAG_MEDIA, DRAG_BROLL].some((t) => e.dataTransfer.types.includes(t))
  const writeErr = reorder.error ?? addBrolls.error ?? patchBroll.error

  return (
    <div className="sb-desk" aria-label="分镜">
      <div className="vd-desk-bar">
        <span className="vd-muted vd-wrap vd-desk-hint">
          {xs.length ? `${xs.length} 个分镜 · 约 ${fmtSec(totalSeconds(xs))}；拖动左边的把手排序，把素材拖到分镜上就能加入` : '按口播稿的段落拆成分镜，每个分镜配画面说明和 B-roll'}
        </span>
        <Button size="sm" variant="outline" onClick={() => setDrawer({ target: null })}>素材库</Button>
        <Button size="sm" variant="outline" disabled={addShot.isPending} onClick={() => addShot.mutate({})}>加一个分镜</Button>
        <Button size="sm" variant="primary" disabled={!!genOff || gen.isPending} title={genOff || `按${hasScript ? '口播稿' : '大纲'}的标题或段落拆`} onClick={onGenerate}>
          {gen.isPending ? '生成中…' : hasScript || !hasOutline ? '从口播稿生成' : '从大纲生成'}
        </Button>
      </div>
      {asking && (
        <div className="sb-ask" role="alertdialog" aria-label="已有分镜">
          <span>已经有 {xs.length} 个分镜。生成的初稿要：</span>
          <span className="spacer" />
          <Button size="sm" variant="primary" disabled={gen.isPending} onClick={() => generate('append')}>追加到后面</Button>
          <Button size="sm" variant="danger-ghost" disabled={gen.isPending} title="现有分镜和它们的 B-roll 都会删掉" onClick={() => generate('replace')}>覆盖现有分镜</Button>
          <Button size="sm" disabled={gen.isPending} onClick={() => setAsking(false)}>取消</Button>
        </div>
      )}
      {gen.isError && !isApiError(gen.error, 'conflict') && <div className="vd-err" role="alert">{errorText(gen.error)}</div>}
      {genMsg && <div className="sb-ok" role="status">{genMsg}</div>}
      {addShot.isError && <div className="vd-err" role="alert">{errorText(addShot.error)}</div>}
      {!!writeErr && <div className="vd-err" role="alert">{errorText(writeErr)}</div>}

      {shots.isPending && <div className="vd-muted">分镜加载中…</div>}
      {shots.isError && <div className="vd-err" role="alert">分镜读不出来：{errorText(shots.error)}</div>}
      {shots.isSuccess && !xs.length && (
        <div className="sb-empty">
          还没有分镜。{genOff ? '先写口播稿，再一键拆成分镜；' : '点「从口播稿生成」一键拆出初稿；'}也可以「加一个分镜」手写。
        </div>
      )}
      <ol className="sb-list">
        {xs.map((s, i) => (
          <ShotRow key={s.id} v={v} s={s} first={i === 0} last={i === xs.length - 1} over={dragOver === s.id}
            onMove={(to) => reorder.mutate(moveId(xs.map((x) => x.id), s.id, to))}
            onAddBroll={() => setDrawer({ target: s.id })}
            onDragOver={(e) => { if (accepts(e)) { e.preventDefault(); setDragOver(s.id) } }}
            onDragLeave={() => setDragOver((x) => (x === s.id ? null : x))}
            onDrop={(e) => onDrop(e, s)} />
        ))}
      </ol>
      {drawer && (
        <MediaDrawer videoId={v.id} shots={xs} target={drawer.target} onTarget={(id) => setDrawer({ target: id })} onClose={() => setDrawer(null)} />
      )}
    </div>
  )
}

/** 本地可改的值，props 变了（保存回来、别处改了）时换成新的 */
function useSynced(value: string): [string, (v: string) => void] {
  const [seen, setSeen] = useState(value)
  const [cur, setCur] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setCur(value)
  }
  return [cur, setCur]
}

/** 一个分镜：把手、序号、口播段落、画面说明、时长、B-roll */
function ShotRow({ v, s, first, last, over, onMove, onAddBroll, onDragOver, onDragLeave, onDrop }: {
  v: Video
  s: VideoShot
  first: boolean
  last: boolean
  over: boolean
  onMove: (to: number) => void
  onAddBroll: () => void
  onDragOver: (e: DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: DragEvent) => void
}) {
  const patch = usePatchShot(v.id)
  const remove = useRemoveShot(v.id)
  // 输入框先改本地，失焦再存；别处改了（生成、重新读）时跟上
  const [text, setText] = useSynced(s.text)
  const [visual, setVisual] = useSynced(s.visual)
  const [dur, setDur] = useSynced(s.duration == null ? '' : String(s.duration))
  const [confirmDel, setConfirmDel] = useState(false)
  const durBad = dur.trim() !== '' && !/^\d{1,4}$/.test(dur.trim())
  const save = (b: { text?: string; visual?: string; duration?: number | null }) => patch.mutate({ id: s.id, ...b })

  return (
    <li className={cls('sb-shot', over && 'over')} aria-label={`第 ${s.no} 个分镜`} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="sb-shot-side">
        <span className="sb-handle" draggable title="拖动排序" aria-hidden="true"
          onDragStart={(e) => { e.dataTransfer.setData(DRAG_SHOT, s.id); e.dataTransfer.effectAllowed = 'move' }}>
          <svg viewBox="0 0 10 16" width="10" height="16">{[3, 8, 13].flatMap((y) => [2.5, 7.5].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.3" fill="currentColor" />))}</svg>
        </span>
        <span className="sb-no">{s.no}</span>
        <span className="sb-dur">{fmtSec(shotSeconds(s))}</span>
        <span className="sb-moves">
          <button type="button" className="sb-mini" disabled={first} aria-label={`第 ${s.no} 个上移`} title="上移" onClick={() => onMove(s.no - 2)}>上</button>
          <button type="button" className="sb-mini" disabled={last} aria-label={`第 ${s.no} 个下移`} title="下移" onClick={() => onMove(s.no)}>下</button>
        </span>
      </div>
      <div className="sb-shot-main">
        <div className="sb-fields">
          <label className="sb-field sb-field-text">
            <span className="sb-label">口播</span>
            <Textarea autoGrow rows={2} aria-label={`第 ${s.no} 个分镜的口播段落`} placeholder="这个分镜对应的口播" value={text}
              onChange={(e) => setText(e.target.value)} onBlur={() => { if (text.trim() !== s.text) save({ text }) }} />
          </label>
          <div className="sb-field-col">
            <label className="sb-field">
              <span className="sb-label">画面</span>
              <Input aria-label={`第 ${s.no} 个分镜的画面说明`} placeholder="画面说明：录屏、空镜、图表……" value={visual}
                onChange={(e) => setVisual(e.target.value)} onBlur={() => { if (visual.trim() !== s.visual) save({ visual }) }} />
            </label>
            <label className="sb-field sb-field-dur">
              <span className="sb-label">时长</span>
              <Input invalid={durBad} inputMode="numeric" aria-label={`第 ${s.no} 个分镜的时长（秒）`} placeholder={`约 ${s.est} 秒`} value={dur}
                title={`不填按口播字数估（每分钟 240 字），现在约 ${s.est} 秒`}
                onChange={(e) => setDur(e.target.value)}
                onBlur={() => {
                  const t = dur.trim()
                  if (durBad) return
                  const n = t ? Math.max(1, Number(t)) : null
                  if (n !== s.duration) save({ duration: n })
                }} />
              <span className="vd-muted">秒</span>
            </label>
            {durBad && <span className="vd-err">时长填 1 到 3600 的整数秒，空着按口播估</span>}
          </div>
        </div>
        <div className="sb-brolls" aria-label={`第 ${s.no} 个分镜的 B-roll`}>
          {s.brolls.map((b, i) => (
            <BrollCard key={b.id} v={v} b={b} shot={s} index={i} />
          ))}
          <button type="button" className="sb-add-broll" onClick={onAddBroll}>
            加 B-roll<span className="vd-muted">{s.brolls.length ? '' : '或把素材拖到这里'}</span>
          </button>
        </div>
        {(patch.isError || remove.isError) && <div className="vd-err" role="alert">{errorText(patch.error ?? remove.error)}</div>}
      </div>
      <div className="sb-shot-end">
        {confirmDel ? (
          <span className="sb-confirm">
            <span className="vd-muted">{s.brolls.length ? `连同 ${s.brolls.length} 条 B-roll 一起删，原文件不动` : '删掉这个分镜'}</span>
            <Button size="sm" onClick={() => setConfirmDel(false)}>取消</Button>
            <Button size="sm" variant="danger-ghost" disabled={remove.isPending} onClick={() => remove.mutate(s.id)}>删除</Button>
          </span>
        ) : <Button size="sm" variant="ghost" aria-label={`删除第 ${s.no} 个分镜`} onClick={() => setConfirmDel(true)}>删除</Button>}
      </div>
    </li>
  )
}

/** 一条 B-roll：缩略图、文件名、缺失标记、备注、入出点（视频）、左右挪、移除；能拖到别的分镜 */
function BrollCard({ v, b, shot, index }: { v: Video; b: VideoBroll; shot: VideoShot; index: number }) {
  const patch = usePatchBroll(v.id)
  const remove = useRemoveBroll(v.id)
  const reorder = useReorderBrolls(v.id)
  const [note, setNote] = useSynced(b.note)
  const [inS, setIn] = useSynced(b.in == null ? '' : fmtSec(b.in))
  const [outS, setOut] = useSynced(b.out == null ? '' : fmtSec(b.out))
  const [broken, setBroken] = useState(false)
  const inV = parseSec(inS)
  const outV = parseSec(outS)
  const clipErr = inV === undefined || outV === undefined ? '入点、出点写秒数或「分:秒」' : inV != null && outV != null && outV <= inV ? '出点要晚于入点' : ''
  const ids = shot.brolls.map((x) => x.id)
  const move = (to: number) => reorder.mutate({ shotId: shot.id, ids: moveId(ids, b.id, to) })
  const saveClip = () => {
    if (clipErr) return
    if (inV !== b.in || outV !== b.out) patch.mutate({ id: b.id, in: inV ?? null, out: outV ?? null })
  }
  const err = patch.error ?? remove.error ?? reorder.error

  return (
    <div className={cls('sb-broll', b.missing && 'missing')} draggable
      onDragStart={(e) => { e.dataTransfer.setData(DRAG_BROLL, b.id); e.dataTransfer.effectAllowed = 'move' }}
      aria-label={`B-roll ${b.name}${b.missing ? '（缺失）' : ''}`}>
      <div className="sb-broll-thumb">
        {!b.missing && !broken
          ? <img src={mediaThumbUrl(b.root_id, v.id, b.path)} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} />
          : <span className="sb-thumb-none" aria-hidden="true">{b.kind === 'video' ? '视频' : '图片'}</span>}
        {b.missing && <span className="sb-missing sb-missing-tag">缺失</span>}
      </div>
      <div className="sb-broll-body">
        <span className="sb-ellipsis sb-cell-name" title={`${b.root_id === 'project' ? '工程目录' : '素材目录'}/${b.path}${b.missing ? '：文件被移走或删掉了，或素材目录已移除' : ''}`}>{b.name}</span>
        <Input className="sb-note" aria-label={`${b.name} 的备注`} placeholder="备注" value={note} maxLength={500}
          onChange={(e) => setNote(e.target.value)} onBlur={() => { if (note.trim() !== b.note) patch.mutate({ id: b.id, note }) }} />
        {b.kind === 'video' && (
          <div className="sb-clip">
            <Input invalid={inV === undefined || !!(clipErr && inV != null)} aria-label={`${b.name} 的入点`} placeholder="入点" value={inS}
              onChange={(e) => setIn(e.target.value)} onBlur={saveClip} />
            <span className="vd-muted">到</span>
            <Input invalid={outV === undefined || !!(clipErr && outV != null)} aria-label={`${b.name} 的出点`} placeholder="出点" value={outS}
              onChange={(e) => setOut(e.target.value)} onBlur={saveClip} />
          </div>
        )}
        {clipErr && <span className="vd-err">{clipErr}</span>}
        {!clipErr && b.kind === 'video' && clipText(b) && <span className="vd-muted">{clipText(b)}</span>}
        <div className="sb-broll-acts">
          <button type="button" className="sb-mini" disabled={index === 0 || reorder.isPending} aria-label={`${b.name} 往前挪`} title="往前挪" onClick={() => move(index - 1)}>前</button>
          <button type="button" className="sb-mini" disabled={index === ids.length - 1 || reorder.isPending} aria-label={`${b.name} 往后挪`} title="往后挪" onClick={() => move(index + 1)}>后</button>
          <span className="spacer" />
          <button type="button" className="sb-mini sb-mini-danger" disabled={remove.isPending} aria-label={`移除 ${b.name}`} title="从分镜里移除，原文件不动"
            onClick={() => remove.mutate(b.id)}>移除</button>
        </div>
        {!!err && <span className="vd-err">{errorText(err)}</span>}
      </div>
    </div>
  )
}
