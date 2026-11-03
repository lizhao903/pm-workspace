import { useEffect, useState } from 'react'
import type { Message, MsgAttachment } from './data'
import { cls } from './ui'

// 附件预览弹窗（SPEC-messages-3.16）：消息详情里点「预览」或图片缩略图打开。
// 原型没有真实文件：图片、PDF、文本、音视频用占位内容演示样子；正式产品读获取到本地的文件（图片、PDF、音视频 inline，文本读前 512KB）。
// 没获取的弹窗里「获取并预览」；← → 在同一条消息的文件之间切换，链接不算；Esc、点遮罩关

type Kind = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'none'
const EXT: Record<string, Kind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', pdf: 'pdf', mp4: 'video', mov: 'video', webm: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', txt: 'text', log: 'text', md: 'text', csv: 'text', json: 'text',
}
export function previewKind(a: MsgAttachment): Kind {
  if (a.kind === 'link') return 'none'
  const ext = a.name.includes('.') ? a.name.split('.').pop()!.toLowerCase() : ''
  return EXT[ext] ?? (a.kind === 'image' ? 'image' : 'none')
}

export function AttachmentPreview({ msg, startId, onFetch, onClose, pool }: {
  msg: Message; startId: string; onFetch: (attId: string) => void; onClose: () => void
  /** 左右切换的范围；不传时是这条消息的附件（项目附件标签传当前筛选出的附件，可以跨消息切） */
  pool?: MsgAttachment[]
}) {
  const list = (pool ?? msg.attachments ?? []).filter((a) => a.kind !== 'link')
  const [id, setId] = useState(startId)
  const i = Math.max(0, list.findIndex((a) => a.id === id))
  const a = list[i]
  const go = (d: number) => { if (list.length > 1) setId(list[(i + d + list.length) % list.length].id) }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); go(e.key === 'ArrowLeft' ? -1 : 1) }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  if (!a) return null
  const kind = previewKind(a)
  const ready = a.fetch === 'done'
  return (
    <div className="att-pv-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="att-pv" role="dialog" aria-modal="true" aria-label={`预览 ${a.name}`}>
        <div className="att-pv-head">
          <span className="att-pv-title"><b className="ellipsis">{a.name}</b><span className="muted">{list.length > 1 ? `${i + 1} / ${list.length}` : ''}</span></span>
          <span className="spacer" />
          {ready && kind !== 'none' && kind !== 'text' && <button className="btn btn-ghost">新窗口打开</button>}
          {ready && <button className="btn btn-outline">下载</button>}
          <button className="icon-btn" title="关闭 (Esc)" onClick={onClose}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className="att-pv-body">
          {list.length > 1 && <button className="att-pv-nav att-pv-prev" title="上一个 (←)" onClick={() => go(-1)}>&lsaquo;</button>}
          {!ready ? (
            <div className="att-pv-empty">
              <div>{a.fetch === 'fetching' ? '获取中…' : a.fetch === 'error' ? `没取到：${a.error ?? '获取失败'}` : '这个附件还在平台上，获取到本地后就能看'}</div>
              <button className="btn btn-primary" disabled={a.fetch === 'fetching'} onClick={() => onFetch(a.id)}>{a.fetch === 'error' ? '重试' : '获取并预览'}</button>
            </div>
          ) : kind === 'image' ? (
            <div className="att-pv-img"><div className="att-pv-mock-img">{a.name}<span className="muted">（原型占位图）</span></div></div>
          ) : kind === 'pdf' ? (
            <div className="att-pv-img"><div className="att-pv-mock-page"><b>{a.name}</b><span className="muted">PDF 第 1 页（原型占位）</span></div></div>
          ) : kind === 'text' ? (
            <div className="att-pv-text"><pre>{`${a.name}\n\n（原型占位：正式产品显示文件前 512KB 的内容）`}</pre></div>
          ) : kind === 'video' || kind === 'audio' ? (
            <div className="att-pv-empty"><div>{kind === 'video' ? '视频' : '音频'}播放器（原型占位）</div></div>
          ) : (
            <div className="att-pv-empty">这种文件不能在页面里看，点右上角「下载」用本机的应用打开</div>
          )}
          {list.length > 1 && <button className="att-pv-nav att-pv-next" title="下一个 (→)" onClick={() => go(1)}>&rsaquo;</button>}
        </div>
      </div>
    </div>
  )
}

/** 已获取的图片在附件行里的缩略图（原型用色块代替） */
export function AttThumb({ a, onClick }: { a: MsgAttachment; onClick: () => void }) {
  return <button className={cls('att-thumb')} title="预览" onClick={onClick} aria-label={`预览 ${a.name}`} />
}
