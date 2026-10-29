// 沟通标签顶部的「消息里的附件」（SPEC-projects-5，IM-04b）：项目消息里还没决定要不要放进支持材料的附件，逐个加入或不加入。
// 照原型 web-next/src/attachments.tsx ProjectAttachmentInbox。获取、加入和消息抽屉的附件面板是同一套（core/data 的 attachments），
// 不 import IM 插件；「已加入」按资料的 value 认，「不加入」记在项目 props.skipped_attachments。IM 插件没在跑时沟通标签不渲染这一块。
import { useState, type ReactNode } from 'react'
import {
  ATTACH_KIND, attachmentAdded, errorText, needsFetch, skipKey, skippedAttachments, useAddAttachmentToProject, useFetchAttachment,
  useProject, useProjectMaterials, useSkipAttachment, type ImAttachmentFile, type ImMessage,
} from '../../core/data'
import { cls } from '../../core/ui'
import { fmtSize, whoName } from './commsModel'
import { ago } from './model'

/** 待决定的超过这么多个就折叠，展开后也先露这么多个 */
export const PEEK = 3

type Row = { m: ImMessage; a: ImAttachmentFile }

/** 附件种类图标；沟通标签消息行的附件小标签也用（SPEC-messages-1.16） */
export function AttIcon({ kind }: { kind: ImAttachmentFile['kind'] }) {
  const d = kind === 'link' ? 'M6.5 9.5 9.5 6.5M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1'
    : kind === 'image' ? 'M3 3.5h10v9H3zM3 10.5l3-3 2.5 2.5L10 8.5l3 3' : 'M4 2.5h5l3 3v8H4zM9 2.5v3h3'
  return <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
}


function statusLine(a: ImAttachmentFile, fetching: boolean, localErr: string) {
  if (a.kind === 'link') return a.url ?? ''
  if (fetching) return '获取中…'
  if (a.fetch === 'done') return `已获取 · ${a.local ?? ''}`
  if (a.fetch === 'error') return a.error || '获取失败'
  if (localErr) return localErr
  return [ATTACH_KIND[a.kind] ?? a.kind, fmtSize(a.size), '还在平台上，没下载'].filter(Boolean).join(' · ')
}

/** 附件行：种类图标、名字、状态行，右边是操作 */
function AttRow({ a, fetching, localErr, children }: { a: ImAttachmentFile; fetching?: boolean; localErr?: string; children: ReactNode }) {
  const sub = statusLine(a, !!fetching, localErr ?? '')
  return (
    <div className={cls('pj-att-row', (a.fetch === 'error' || localErr) && !fetching && 'pj-att-bad')}>
      <span className={cls('pj-att-ico', `pj-att-${a.kind}`)}><AttIcon kind={a.kind} /></span>
      <span className="pj-att-main">
        {a.kind === 'link' && a.url
          ? <a className="pj-att-name ellipsis" href={a.url} target="_blank" rel="noopener noreferrer">{a.name}</a>
          : <b className="pj-att-name ellipsis">{a.name}</b>}
        <span className="pj-att-sub ellipsis" title={sub}>{sub}</span>
      </span>
      {children}
    </div>
  )
}

/** 一条待决定的：获取、加入支持材料、不加入 */
function TodoRow({ projectId, m, a, now, skipping, onSkip, onOpenMessage }: {
  projectId: string; m: ImMessage; a: ImAttachmentFile; now: number; skipping: boolean
  onSkip: () => void; onOpenMessage: (m: ImMessage) => void
}) {
  const fetchM = useFetchAttachment()
  const addM = useAddAttachmentToProject()
  const fetching = fetchM.isPending || (addM.isPending && needsFetch(a))
  const localErr = fetchM.isError && a.fetch !== 'error' ? errorText(fetchM.error) : ''
  const addErr = addM.isError && a.fetch !== 'error' ? errorText(addM.error) : ''
  return (
    <AttRow a={a} fetching={fetching} localErr={localErr}>
      <span className="pj-att-acts">
        <button type="button" className="pj-att-act pj-att-quiet" title={m.text} onClick={() => onOpenMessage(m)}>{whoName(m)} · {ago(m.at, now)}</button>
        {needsFetch(a) && !fetching && (
          <button type="button" className="pj-att-act" disabled={addM.isPending}
            onClick={() => { addM.reset(); fetchM.mutate({ messageId: m.id, attachmentId: a.id }) }}>
            {a.fetch === 'error' ? '重试' : '获取'}
          </button>
        )}
        <button type="button" className="pj-att-act pj-att-primary" disabled={fetching || addM.isPending}
          onClick={() => { fetchM.reset(); addM.mutate({ message: m, attachmentId: a.id, projectId }) }}>
          {needsFetch(a) ? '获取并加入' : '加入支持材料'}
        </button>
        <button type="button" className="pj-att-act pj-att-quiet" disabled={skipping || addM.isPending} onClick={onSkip}>不加入</button>
      </span>
      {addErr && <span className="pj-att-note pj-err" role="alert">没加进去：{addErr}</span>}
    </AttRow>
  )
}

export function AttachmentInbox({ projectId, messages, now, onOpenMessage }: {
  projectId: string
  /** 项目绑定的会话里的全部消息（不受渠道筛选影响），按发送时间倒序 */
  messages: readonly ImMessage[]
  now: number
  onOpenMessage: (m: ImMessage) => void
}) {
  const project = useProject(projectId)
  const mats = useProjectMaterials(projectId)
  const skip = useSkipAttachment(projectId)
  const [showSkipped, setShowSkipped] = useState(false)
  // 待决定的超过 PEEK 个时整块默认折叠成一行；open 展开露 PEEK 个，all 全部
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState(false)

  const rows: Row[] = messages.flatMap((m) => (m.attachments as ImAttachmentFile[]).map((a) => ({ m, a })))
    .sort((x, y) => y.m.at.localeCompare(x.m.at))
  if (!rows.length) return null
  const skipped = new Set(skippedAttachments(project.data))
  const isSkipped = (r: Row) => skipped.has(skipKey(r.m.id, r.a.id))
  // 资料还没取到时先不列，免得已加入的闪一下
  const todo = mats.data ? rows.filter((r) => !attachmentAdded(mats.data, r.a) && !isSkipped(r)) : []
  const skippedRows = rows.filter(isSkipped)
  const foldable = todo.length > PEEK
  const folded = foldable && !open
  const todoShown = folded ? [] : all || !foldable ? todo : todo.slice(0, PEEK)
  const setSkip = (r: Row, v: boolean) => skip.mutate({ messageId: r.m.id, attachmentId: r.a.id, skip: v })
  const hint = mats.isError ? '资料没加载出来，判断不了哪些已加入'
    : !mats.data ? '加载中' : todo.length ? `${todo.length} 个还没决定要不要放进支持材料` : '都处理过了'

  return (
    <section className={cls('pj-att-inbox', folded && 'pj-att-folded')} aria-label="消息里的附件">
      <div className="pj-att-head">
        <h2 className="pj-sec-title">消息里的附件<span className="pj-muted pj-att-hint">{hint}</span></h2>
        <span className="spacer" />
        {foldable && <button type="button" className="pj-att-act pj-att-quiet" onClick={() => { setOpen(!open); setAll(false) }}>{open ? '收起' : '逐个决定'}</button>}
        {!folded && skippedRows.length > 0 && (
          <button type="button" className="pj-att-act pj-att-quiet" onClick={() => setShowSkipped(!showSkipped)}>
            {showSkipped ? '收起不加入的' : `看不加入的 ${skippedRows.length} 个`}
          </button>
        )}
      </div>
      {mats.isError && <div className="pj-err" role="alert">{errorText(mats.error)}</div>}
      {skip.isError && <div className="pj-err" role="alert">没改成：{errorText(skip.error)}</div>}
      {todoShown.map((r) => (
        <TodoRow key={`${r.m.id}:${r.a.id}`} projectId={projectId} m={r.m} a={r.a} now={now} skipping={skip.isPending}
          onSkip={() => setSkip(r, true)} onOpenMessage={onOpenMessage} />
      ))}
      {!folded && foldable && !all && (
        <button type="button" className="pj-att-act pj-att-quiet pj-att-more" onClick={() => setAll(true)}>还有 {todo.length - PEEK} 个</button>
      )}
      {!folded && showSkipped && skippedRows.map((r) => (
        <AttRow key={`${r.m.id}:${r.a.id}`} a={r.a}>
          <span className="pj-att-acts">
            <span className="pj-muted">{whoName(r.m)} · 选了不加入</span>
            <button type="button" className="pj-att-act" disabled={skip.isPending} onClick={() => setSkip(r, false)}>恢复</button>
          </span>
        </AttRow>
      ))}
    </section>
  )
}
