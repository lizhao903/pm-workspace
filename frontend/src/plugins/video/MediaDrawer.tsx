// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// B-roll 素材浏览抽屉（TSK-0456，同原型 storyboard.tsx 的 MediaDrawer，规格 SPEC-videos-17.10 到 17.20）。
// 左上选素材目录（工程目录默认就有，其他目录登记绝对路径或用目录选择器选），下面面包屑、子目录、类型筛选、按文件名搜、分页；
// 文件一格一个：缩略图、文件名、尺寸 / 时长 / 大小、修改时间；勾选多个加到指定分镜，也能直接拖到分镜上。
// 点文件名在抽屉下方预览：图片看原图，视频用播放器（后端支持 Range，可以拖进度）。只读，不改原文件。
import { useState } from 'react'
import {
  errorText, isApiError, mediaFileUrl, mediaThumbUrl, useAddBrolls, useAddMediaRoot, useMediaBrowse, useMediaRoots, useRemoveMediaRoot,
  type VideoMediaFile, type VideoMediaRoot, type VideoShot,
} from '../../core/data'
import { Button, Drawer, Input, cls } from '../../core/ui'
import { DirPicker } from '../../core/ui/DirPicker'
import { DRAG_MEDIA, dirCrumbs, fileMeta } from './storyboardModel'
import { timeAgo } from './model'
import './storyboard.css'

const PAGE_SIZE = 48
const TYPES = [['', '全部'], ['image', '图片'], ['video', '视频']] as const

export function MediaDrawer({ videoId, shots, target, onTarget, onClose }: {
  videoId: string
  shots: VideoShot[]
  /** 加到哪个分镜；null 时只浏览、管理目录 */
  target: string | null
  onTarget: (id: string) => void
  onClose: () => void
}) {
  const roots = useMediaRoots(videoId)
  const [rootId, setRootId] = useState<string>('')
  const [dir, setDir] = useState('')
  const [type, setType] = useState<'' | 'image' | 'video'>('')
  const [q, setQ] = useState('')
  const [typed, setTyped] = useState('')
  const [page, setPage] = useState(1)
  const [picked, setPicked] = useState<string[]>([])
  const [preview, setPreview] = useState<VideoMediaFile | null>(null)
  const [managing, setManaging] = useState(false)
  const add = useAddBrolls(videoId)
  const [msg, setMsg] = useState('')

  const list = roots.data ?? []
  const root = list.find((r) => r.id === rootId) ?? list.find((r) => r.available) ?? list[0]
  const browse = useMediaBrowse(root?.available ? { root: root.id, videoId, dir, type, q, page, pageSize: PAGE_SIZE } : null)
  const data = browse.isError ? undefined : browse.data
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1
  const targetShot = shots.find((s) => s.id === target)

  const reset = (patch: () => void) => { patch(); setPage(1); setPicked([]); setPreview(null) }
  const go = (r: VideoMediaRoot) => reset(() => { setRootId(r.id); setDir(''); setQ(''); setTyped('') })
  const toggle = (p: string) => setPicked((xs) => (xs.includes(p) ? xs.filter((x) => x !== p) : [...xs, p]))
  const items = (paths: string[]) => paths.map((path) => ({ root_id: root!.id, path }))
  const onAdd = () => {
    if (!targetShot || !picked.length || !root) return
    setMsg('')
    add.mutate({ shotId: targetShot.id, items: items(picked) }, {
      onSuccess: (xs) => {
        // 已经在这个分镜里的后端会跳过，按前后条数说加了几个
        const added = (xs.find((x) => x.id === targetShot.id)?.brolls.length ?? 0) - targetShot.brolls.length
        setMsg(added > 0 ? `已加到第 ${targetShot.no} 个分镜：${added} 个${added < picked.length ? `，${picked.length - added} 个已经在里面` : ''}` : '选的文件都已经在这个分镜里了')
        setPicked([])
      },
    })
  }

  return (
    <Drawer open onClose={onClose} kicker="B-roll 素材" aria-label="B-roll 素材" className="sb-drawer" flush
      footer={(
        <div className="sb-foot">
          <label className="sb-foot-target">
            <span className="vd-muted">加到</span>
            <select className="input sb-select" aria-label="加到哪个分镜" value={target ?? ''} onChange={(e) => onTarget(e.target.value)}>
              <option value="" disabled>选一个分镜</option>
              {shots.map((s) => <option key={s.id} value={s.id}>第 {s.no} 个{s.visual ? `：${s.visual.slice(0, 16)}` : s.text ? `：${s.text.slice(0, 16)}` : ''}</option>)}
            </select>
          </label>
          <span className="spacer" />
          {picked.length > 0 && <Button size="sm" variant="ghost" onClick={() => setPicked([])}>清空选择</Button>}
          <Button size="sm" variant="primary" disabled={!targetShot || !picked.length || add.isPending}
            title={!shots.length ? '先加一个分镜' : !targetShot ? '先选加到哪个分镜' : !picked.length ? '先勾选文件' : undefined} onClick={onAdd}>
            {add.isPending ? '加入中…' : `加入分镜${picked.length ? ` ${picked.length} 个` : ''}`}
          </Button>
        </div>
      )}>
      <div className="sb-media">
        <div className="sb-roots" role="tablist" aria-label="素材目录">
          {roots.isPending && <span className="vd-muted">加载中…</span>}
          {list.map((r) => (
            <button key={r.id} type="button" role="tab" aria-selected={root?.id === r.id} className={cls('sb-root', root?.id === r.id && 'on', !r.available && 'off')}
              title={r.available ? r.path : r.reason} onClick={() => go(r)}>
              {r.builtin ? '工程目录' : r.name}
            </button>
          ))}
          <button type="button" className={cls('sb-root sb-root-add', managing && 'on')} aria-expanded={managing} onClick={() => setManaging(!managing)}>
            {managing ? '收起目录管理' : '管理目录'}
          </button>
        </div>
        {roots.isError && <div className="vd-err" role="alert">{errorText(roots.error)}</div>}
        {managing && <RootManager roots={list.filter((r) => !r.builtin)} />}

        {root && !root.available && (
          <div className="sb-empty" role="status">
            「{root.builtin ? '工程目录' : root.name}」用不了：{root.reason || '目录不在了'}
            {root.builtin && <div className="vd-muted vd-wrap">在视频的「设置」里填工程目录，或者登记别的素材目录</div>}
          </div>
        )}

        {root?.available && (
          <>
            <div className="sb-tools">
              <nav className="sb-crumbs" aria-label="所在位置">
                <button type="button" className="sb-crumb" title={root.path} onClick={() => reset(() => setDir(''))}>{root.builtin ? '工程目录' : root.name}</button>
                {dirCrumbs(dir).map((c) => (
                  <span key={c.path} className="sb-crumb-seg">
                    <span aria-hidden="true">/</span>
                    <button type="button" className="sb-crumb" onClick={() => reset(() => setDir(c.path))}>{c.label}</button>
                  </span>
                ))}
              </nav>
              <span className="spacer" />
              <span className="vd-sort" role="group" aria-label="按类型筛选">
                {TYPES.map(([k, label]) => (
                  <button key={k} type="button" aria-pressed={type === k} className={cls(type === k && 'on')} onClick={() => reset(() => setType(k))}>{label}</button>
                ))}
              </span>
              <form className="sb-search" role="search" onSubmit={(e) => { e.preventDefault(); reset(() => setQ(typed)) }}>
                <Input aria-label="按文件名搜索" placeholder="搜文件名（含子目录）" value={typed} onChange={(e) => setTyped(e.target.value)} />
                {q && <Button size="sm" variant="ghost" onClick={() => reset(() => { setQ(''); setTyped('') })}>清除</Button>}
              </form>
            </div>
            {data && !data.tools.thumbs && (
              <div className="vd-muted vd-wrap">本机没有 ffmpeg{data.tools.probe ? '' : '、ffprobe'}（或视频插件没确认 process:spawn），视频没有缩略图{data.tools.probe ? '' : '和时长'}，只显示文件信息</div>
            )}
            {browse.isError && <div className="vd-err" role="alert">{errorText(browse.error)}</div>}
            {browse.isPending && <div className="vd-muted">加载中…</div>}
            {data && (
              <>
                {!q && (data.parent !== undefined || data.dirs.length > 0) && (
                  <div className="sb-dirs" aria-label="子目录">
                    {data.parent !== undefined && <button type="button" className="chip" onClick={() => reset(() => setDir(data.parent ?? ''))}>上一级</button>}
                    {data.dirs.map((d) => <button key={d.path} type="button" className="chip" onClick={() => reset(() => setDir(d.path))}>{d.name}/</button>)}
                  </div>
                )}
                {data.files.length === 0 ? (
                  <div className="sb-empty">{q ? `没有文件名含「${q}」的${type === 'image' ? '图片' : type === 'video' ? '视频' : '图片和视频'}` : `这个目录里没有${type === 'image' ? '图片' : type === 'video' ? '视频' : '图片和视频'}`}</div>
                ) : (
                  <ul className="sb-grid" aria-label="文件">
                    {data.files.map((f) => (
                      <MediaCell key={f.path} f={f} root={root.id} videoId={videoId} on={picked.includes(f.path)} active={preview?.path === f.path}
                        dragItems={() => JSON.stringify(items(picked.includes(f.path) ? picked : [f.path]))}
                        onToggle={() => toggle(f.path)} onPreview={() => setPreview(preview?.path === f.path ? null : f)} />
                    ))}
                  </ul>
                )}
                {data.truncated && <div className="vd-muted vd-wrap">目录太大，只搜了前 20000 项；进到子目录里再搜</div>}
                {pages > 1 && (
                  <div className="sb-pager">
                    <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => { setPage(page - 1); setPreview(null) }}>上一页</Button>
                    <span className="vd-muted">第 {page} / {pages} 页 · 共 {data.total} 个</span>
                    <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => { setPage(page + 1); setPreview(null) }}>下一页</Button>
                  </div>
                )}
                {pages <= 1 && data.total > 0 && <div className="vd-muted">共 {data.total} 个{picked.length ? `，选了 ${picked.length} 个` : ''}</div>}
              </>
            )}
            {preview && (
              <section className="sb-preview" aria-label={`预览 ${preview.name}`}>
                <div className="sb-preview-head">
                  <b className="sb-ellipsis" title={preview.path}>{preview.name}</b>
                  <span className="vd-muted">{fileMeta(preview)}</span>
                  <span className="spacer" />
                  <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>关闭预览</Button>
                </div>
                {preview.kind === 'video'
                  ? <video key={preview.path} className="sb-preview-media" controls preload="metadata" src={mediaFileUrl(root.id, videoId, preview.path)} />
                  : <img className="sb-preview-media" alt={preview.name} src={mediaFileUrl(root.id, videoId, preview.path)} />}
              </section>
            )}
          </>
        )}
        {add.isError && <div className="vd-err" role="alert">{errorText(add.error)}</div>}
        {msg && !add.isError && <div className="sb-ok" role="status">{msg}</div>}
      </div>
    </Drawer>
  )
}

/** 一个文件：勾选框、缩略图（点了预览）、文件名、尺寸时长大小、修改时间；能拖到分镜上 */
function MediaCell({ f, root, videoId, on, active, dragItems, onToggle, onPreview }: {
  f: VideoMediaFile
  root: string
  videoId: string
  on: boolean
  active: boolean
  dragItems: () => string
  onToggle: () => void
  onPreview: () => void
}) {
  const [broken, setBroken] = useState(false)
  return (
    <li className={cls('sb-cell', on && 'on', active && 'active')} draggable
      onDragStart={(e) => { e.dataTransfer.setData(DRAG_MEDIA, dragItems()); e.dataTransfer.effectAllowed = 'copy' }}>
      <button type="button" className="sb-thumb" aria-label={`预览 ${f.name}`} onClick={onPreview}>
        {f.thumb && !broken
          ? <img src={mediaThumbUrl(root, videoId, f.path)} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} />
          : <span className="sb-thumb-none" aria-hidden="true">{f.kind === 'video' ? '视频' : '图片'}</span>}
        {f.kind === 'video' && <span className="sb-badge">{f.duration ? fileMeta({ size: 0, duration: f.duration }).split(' · ')[0] : '视频'}</span>}
      </button>
      <label className="sb-cell-info">
        <input type="checkbox" checked={on} onChange={onToggle} aria-label={`选择 ${f.name}`} />
        <span className="sb-cell-text">
          <span className="sb-ellipsis sb-cell-name" title={f.path}>{f.name}</span>
          <span className="vd-muted sb-ellipsis">{fileMeta(f)}</span>
          <span className="vd-muted">{timeAgo(f.modified_at)}</span>
        </span>
      </label>
    </li>
  )
}

/** 登记、移除素材目录：填绝对路径，或者用目录选择器选 */
function RootManager({ roots }: { roots: VideoMediaRoot[] }) {
  const addRoot = useAddMediaRoot()
  const remove = useRemoveMediaRoot()
  const [path, setPath] = useState('')
  const [picking, setPicking] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const submit = (p: string) => {
    const v = p.trim()
    if (!v) return
    addRoot.mutate({ path: v }, { onSuccess: () => setPath('') })
  }
  return (
    <div className="sb-manage" aria-label="管理素材目录">
      <div className="vd-muted vd-wrap">登记本机目录当素材库，只读，不会移动、修改、删除里面的文件。读工程目录以外的目录要视频插件的「只读你登记的目录」权限。</div>
      <form className="sb-manage-add" onSubmit={(e) => { e.preventDefault(); submit(path) }}>
        <Input className="mono-input" aria-label="素材目录的绝对路径" placeholder="/Users/me/Movies/素材" spellCheck={false} value={path} onChange={(e) => setPath(e.target.value)} />
        <Button size="sm" variant="outline" onClick={() => setPicking(!picking)}>选目录</Button>
        <Button size="sm" variant="primary" type="submit" disabled={!path.trim() || addRoot.isPending}>{addRoot.isPending ? '登记中…' : '登记'}</Button>
      </form>
      {picking && <DirPicker start={path.trim()} onPick={(p) => { setPicking(false); setPath(p); submit(p) }} onClose={() => setPicking(false)} />}
      {addRoot.isError && (
        <div className="vd-err" role="alert">{isApiError(addRoot.error, 'conflict') && /权限/.test(addRoot.error.message) ? addRoot.error.message
          : isApiError(addRoot.error, 'conflict') ? '这个目录已经登记过了' : errorText(addRoot.error)}</div>
      )}
      {roots.length > 0 ? (
        <ul className="sb-manage-list">
          {roots.map((r) => (
            <li key={r.id}>
              <span className="sb-ellipsis"><b>{r.name}</b> <span className="vd-mono vd-muted">{r.path}</span></span>
              {!r.available && <span className="sb-missing">{r.reason}</span>}
              <span className="spacer" />
              {removing === r.id ? (
                <>
                  <span className="vd-muted">分镜里用到的会标缺失</span>
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>取消</Button>
                  <Button size="sm" variant="danger-ghost" disabled={remove.isPending} onClick={() => remove.mutate(r.id, { onSuccess: () => setRemoving(null) })}>移除</Button>
                </>
              ) : <Button size="sm" variant="ghost" onClick={() => setRemoving(r.id)}>移除</Button>}
            </li>
          ))}
        </ul>
      ) : <div className="vd-muted">还没登记别的目录</div>}
      {remove.isError && <div className="vd-err" role="alert">{errorText(remove.error)}</div>}
    </div>
  )
}
