// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 附件预览弹窗（SPEC-messages-3.16）：在消息页里直接看附件，不用下载。
// 图片、PDF、音视频按 inline 读（后端只对这几类按 inline 回）；文本读出来显示前 512K 字节；别的只给下载。
// 还没获取的先获取再看。同一条消息的附件左右切（← →），Esc、点遮罩关；焦点关在弹窗里，关掉后回到打开前的位置。
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ATTACH_KIND, TEXT_PREVIEW_MAX, attachmentHref, attachmentPreviewHref, errorText, needsFetch, previewKind, useAttachmentText,
  useFetchAttachment, type ImAttachmentFile, type ImMessage,
} from '../../core/data'
import { IconClose, cls } from '../../core/ui'
import { focusables, restoreFocus, trapTab } from '../../core/ui/focus'
import { AttIcon } from './AttachmentPanel'
import { fmtSize } from './model'

/** 消息里能预览的附件：链接不在这里看 */
const previewable = (atts: readonly ImAttachmentFile[]) => atts.filter((a) => a.kind !== 'link')

export function AttachmentPreview({ msg, startId, onClose }: { msg: ImMessage; startId: string; onClose: () => void }) {
  const list = previewable(msg.attachments as ImAttachmentFile[])
  const [id, setId] = useState(startId)
  const i = Math.max(0, list.findIndex((a) => a.id === id))
  const a = list[i]
  const ref = useRef<HTMLDivElement>(null)
  const [prev] = useState(() => document.activeElement)
  const closeFn = useRef(onClose)
  useEffect(() => { closeFn.current = onClose })
  const go = (d: number) => { if (list.length > 1) setId(list[(i + d + list.length) % list.length].id) }
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

  if (!a) return null
  const download = attachmentHref(a)
  const inline = attachmentPreviewHref(a)
  const kind = previewKind(a)

  return createPortal(
    <div className="dialog-scrim im-pv-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={ref} className="im-pv" role="dialog" aria-modal="true" aria-label={`预览 ${a.name}`} tabIndex={-1}
        onFocus={() => { if (ref.current && !focusables(ref.current).length) ref.current.focus() }}>
        <div className="im-pv-head">
          <span className={cls('im-att-ico', `im-att-${a.kind}`)}><AttIcon kind={a.kind} /></span>
          <span className="im-pv-title">
            <b className="ellipsis" title={a.name}>{a.name}</b>
            <span className="im-pv-sub">{[ATTACH_KIND[a.kind] ?? a.kind, fmtSize(a.size), list.length > 1 ? `${i + 1} / ${list.length}` : ''].filter(Boolean).join(' · ')}</span>
          </span>
          <span className="spacer" />
          {inline && kind !== 'none' && kind !== 'text' && (
            <a className="btn btn-ghost btn-sm" href={inline} target="_blank" rel="noopener noreferrer">新窗口打开</a>
          )}
          {download && <a className="btn btn-outline btn-sm" href={download} download={a.name}>下载</a>}
          <button type="button" className="icon-btn" aria-label="关闭预览" title="关闭 (Esc)" onClick={onClose}><IconClose /></button>
        </div>
        <div className="im-pv-body">
          {list.length > 1 && (
            <button type="button" className="im-pv-nav im-pv-prev" aria-label="上一个附件" title="上一个 (←)" onClick={() => go(-1)}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          )}
          <PreviewBody key={a.id} msg={msg} a={a} />
          {list.length > 1 && (
            <button type="button" className="im-pv-nav im-pv-next" aria-label="下一个附件" title="下一个 (→)" onClick={() => go(1)}>
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
      <div className="im-pv-empty">
        <div>{fetchM.isPending ? '获取中…' : err ? `没取到：${err}` : '这个附件还在平台上，获取到本地后就能看'}</div>
        <button type="button" className="btn btn-primary btn-sm" disabled={fetchM.isPending}
          onClick={() => fetchM.mutate({ messageId: msg.id, attachmentId: a.id })}>
          {fetchM.isPending ? '获取中' : err ? '重试' : '获取并预览'}
        </button>
      </div>
    )
  }
  if (!src || kind === 'none') {
    return <div className="im-pv-empty">这种文件不能在页面里看，点右上角「下载」用本机的应用打开</div>
  }
  if (broken) {
    return <div className="im-pv-empty">打不开这个文件，可能不是它扩展名说的格式；点右上角「下载」看看</div>
  }
  switch (kind) {
    case 'image':
      return (
        <div className={cls('im-pv-img', zoom && 'im-pv-zoom')}>
          <img src={src} alt={a.name} title={zoom ? '点击适应窗口' : '点击看原始大小'} onClick={() => setZoom(!zoom)} onError={() => setBroken(true)} />
        </div>
      )
    case 'pdf':
      return <iframe className="im-pv-frame" src={src} title={a.name} />
    case 'video':
      return <video className="im-pv-media" src={src} controls onError={() => setBroken(true)} />
    case 'audio':
      return <div className="im-pv-empty"><audio src={src} controls onError={() => setBroken(true)} /></div>
    case 'text':
      return <TextPreview src={src} />
  }
}

function TextPreview({ src }: { src: string }) {
  const q = useAttachmentText(src)
  if (q.isPending) return <div className="im-pv-empty">读取中…</div>
  if (q.isError) return <div className="im-pv-empty">没读出来：{errorText(q.error)}</div>
  return (
    <div className="im-pv-text">
      <pre>{q.data.text}</pre>
      {q.data.cut && <div className="im-pv-cut">只显示了前 {TEXT_PREVIEW_MAX / 1024}KB，下载看全文</div>}
    </div>
  )
}
