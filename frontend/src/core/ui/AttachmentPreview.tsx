// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 附件预览弹窗（SPEC-messages-3.16）放在 core：项目的「附件」标签要用，插件之间不能 import IM 插件里那份。
// 行为同 IM 消息抽屉的预览：图片、PDF、音视频按 inline 读，文本读前 512K 字节，别的只给下载；还没获取的先获取再看。
// 和 IM 那份的差别只在列表：这里传一串「消息 + 附件」，可以跨消息左右切（项目附件标签按当前筛选的结果切）。
// ← → 切换，Esc、点遮罩关；焦点关在弹窗里，关掉后回到打开前的位置。IM 插件以后可以改用这份，删掉自己的。
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ATTACH_KIND, TEXT_PREVIEW_MAX, attachmentHref, fmtBytes, attachmentPreviewHref, errorText, needsFetch, previewKind, useAttachmentText,
  useFetchAttachment, type ImAttachmentFile, type ImMessage,
} from '../data'
import { cls } from './cls'
import { focusables, restoreFocus, trapTab } from './focus'
import { IconClose } from './icons'
import './attachmentPreview.css'

export type PreviewItem = { key: string; msg: ImMessage; a: ImAttachmentFile }

/** 附件种类图标：链接、图片、文件 */
export function AttachmentKindIcon({ kind, size = 12 }: { kind: ImAttachmentFile['kind']; size?: number }) {
  const d = kind === 'link' ? 'M6.5 9.5 9.5 6.5M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1'
    : kind === 'image' ? 'M3 3.5h10v9H3zM3 10.5l3-3 2.5 2.5L10 8.5l3 3' : 'M4 2.5h5l3 3v8H4zM9 2.5v3h3'
  return <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

/** items 里的链接不在这里看，会被跳过 */
export function AttachmentPreview({ items, startKey, onClose }: { items: readonly PreviewItem[]; startKey: string; onClose: () => void }) {
  const list = items.filter((x) => x.a.kind !== 'link')
  const [key, setKey] = useState(startKey)
  const i = Math.max(0, list.findIndex((x) => x.key === key))
  const cur = list[i]
  const ref = useRef<HTMLDivElement>(null)
  const [prev] = useState(() => document.activeElement)
  const closeFn = useRef(onClose)
  useEffect(() => { closeFn.current = onClose })
  const go = (d: number) => { if (list.length > 1) setKey(list[(i + d + list.length) % list.length].key) }
  const goFn = useRef(go)
  useEffect(() => { goFn.current = go })

  useEffect(() => {
    ref.current?.focus()
    // 捕获阶段拦下，外层抽屉的 Esc 收不到
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current
      if (!el) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeFn.current()
      } else if (e.key === 'Tab') {
        trapTab(el, e)
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !(e.target instanceof HTMLMediaElement)) {
        e.preventDefault()
        e.stopPropagation()
        goFn.current(e.key === 'ArrowLeft' ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      restoreFocus(prev)
    }
  }, [prev])

  if (!cur) return null
  const a = cur.a
  const download = attachmentHref(a)
  const inline = attachmentPreviewHref(a)
  const kind = previewKind(a)

  return createPortal(
    <div className="dialog-scrim att-pv-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={ref} className="att-pv" role="dialog" aria-modal="true" aria-label={`预览 ${a.name}`} tabIndex={-1}
        onFocus={() => { if (ref.current && !focusables(ref.current).length) ref.current.focus() }}>
        <div className="att-pv-head">
          <span className={cls('att-pv-ico', `att-pv-k-${a.kind}`)}><AttachmentKindIcon kind={a.kind} /></span>
          <span className="att-pv-title">
            <b className="ellipsis" title={a.name}>{a.name}</b>
            <span className="att-pv-sub">{[ATTACH_KIND[a.kind] ?? a.kind, fmtBytes(a.size), list.length > 1 ? `${i + 1} / ${list.length}` : ''].filter(Boolean).join(' · ')}</span>
          </span>
          <span className="spacer" />
          {inline && kind !== 'none' && kind !== 'text' && (
            <a className="btn btn-ghost btn-sm" href={inline} target="_blank" rel="noopener noreferrer">新窗口打开</a>
          )}
          {download && <a className="btn btn-outline btn-sm" href={download} download={a.name}>下载</a>}
          <button type="button" className="icon-btn" aria-label="关闭预览" title="关闭 (Esc)" onClick={onClose}><IconClose /></button>
        </div>
        <div className="att-pv-body">
          {list.length > 1 && (
            <button type="button" className="att-pv-nav att-pv-prev" aria-label="上一个附件" title="上一个 (←)" onClick={() => go(-1)}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          )}
          <PreviewBody key={cur.key} msg={cur.msg} a={a} />
          {list.length > 1 && (
            <button type="button" className="att-pv-nav att-pv-next" aria-label="下一个附件" title="下一个 (→)" onClick={() => go(1)}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function PreviewBody({ msg, a }: { msg: ImMessage; a: ImAttachmentFile }) {
  const fetchM = useFetchAttachment()
  const kind = previewKind(a)
  const src = attachmentPreviewHref(a)
  const [zoom, setZoom] = useState(false)
  const [broken, setBroken] = useState(false)

  if (needsFetch(a)) {
    const err = a.fetch === 'error' ? a.error || '获取失败' : fetchM.isError ? errorText(fetchM.error) : ''
    return (
      <div className="att-pv-empty">
        <div>{fetchM.isPending ? '获取中…' : err ? `没取到：${err}` : '这个附件还在平台上，获取到本地后就能看'}</div>
        <button type="button" className="btn btn-primary btn-sm" disabled={fetchM.isPending}
          onClick={() => fetchM.mutate({ messageId: msg.id, attachmentId: a.id })}>
          {fetchM.isPending ? '获取中' : err ? '重试' : '获取并预览'}
        </button>
      </div>
    )
  }
  if (!src || kind === 'none') {
    return <div className="att-pv-empty">这种文件不能在页面里看，点右上角「下载」用本机的应用打开</div>
  }
  if (broken) {
    return <div className="att-pv-empty">打不开这个文件，可能不是它扩展名说的格式；点右上角「下载」看看</div>
  }
  switch (kind) {
    case 'image':
      return (
        <div className={cls('att-pv-img', zoom && 'att-pv-zoom')}>
          <img src={src} alt={a.name} title={zoom ? '点击适应窗口' : '点击看原始大小'} onClick={() => setZoom(!zoom)} onError={() => setBroken(true)} />
        </div>
      )
    case 'pdf':
      return <iframe className="att-pv-frame" src={src} title={a.name} />
    case 'video':
      return <video className="att-pv-media" src={src} controls onError={() => setBroken(true)} />
    case 'audio':
      return <div className="att-pv-empty"><audio src={src} controls onError={() => setBroken(true)} /></div>
    case 'text':
      return <TextPreview src={src} />
  }
}

function TextPreview({ src }: { src: string }) {
  const q = useAttachmentText(src)
  if (q.isPending) return <div className="att-pv-empty">读取中…</div>
  if (q.isError) return <div className="att-pv-empty">没读出来：{errorText(q.error)}</div>
  return (
    <div className="att-pv-text">
      <pre>{q.data.text}</pre>
      {q.data.cut && <div className="att-pv-cut">只显示了前 {TEXT_PREVIEW_MAX / 1024}KB，下载看全文</div>}
    </div>
  )
}
