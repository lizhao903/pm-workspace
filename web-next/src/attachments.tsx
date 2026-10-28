import { useState } from 'react'
import type { Message, MsgAttachment } from './data'
import type { Project } from './projectdata'
import { useOpenUrl } from './openurl'
import { cls, timeAgo } from './ui'

// 消息附件：在消息列表上露个名字，在消息详情里获取、加进项目资料，在项目沟通里集中挑哪些要进支持材料
// 文件和图片要先「获取」（从 IM 平台下载到本地）；链接直接就能加

export const ATTACH_KIND: Record<MsgAttachment['kind'], string> = { file: '文件', image: '图片', link: '链接' }

export function fmtSize(n?: number) {
  if (n === undefined) return ''
  return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`
}

/** 这个附件已经进了哪些项目的支持材料 */
export const addedIn = (projects: Project[], attId: string) => projects.filter((p) => p.materials.some((m) => m.from?.attachment_id === attId))

/** 列表行上的小标签：只显示名字和数量，不抢正文 */
export function AttachmentChips({ atts }: { atts?: MsgAttachment[] }) {
  if (!atts?.length) return null
  return (
    <span className="att-chips">
      {atts.slice(0, 3).map((a) => <span key={a.id} className={cls('att-chip', `att-${a.kind}`)} title={`${ATTACH_KIND[a.kind]}${a.size ? ` · ${fmtSize(a.size)}` : ''}`}><AttIcon kind={a.kind} />{a.name}</span>)}
      {atts.length > 3 && <span className="att-chip">另外 {atts.length - 3} 个</span>}
    </span>
  )
}

function AttIcon({ kind }: { kind: MsgAttachment['kind'] }) {
  const d = kind === 'link' ? 'M6.5 9.5 9.5 6.5M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1'
    : kind === 'image' ? 'M3 3.5h10v9H3zM3 10.5l3-3 2.5 2.5L10 8.5l3 3' : 'M4 2.5h5l3 3v8H4zM9 2.5v3h3'
  return <svg viewBox="0 0 16 16" width="12" height="12"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

/** 一个附件一行：获取状态 + 能做的事 */
function AttRow({ a, children }: { a: MsgAttachment; children?: React.ReactNode }) {
  const openUrl = useOpenUrl()
  return (
    <div className={cls('att-row', a.fetch === 'error' && 'att-bad')}>
      <span className={cls('att-ico', `att-${a.kind}`)}><AttIcon kind={a.kind} /></span>
      <span className="att-main">
        {a.kind === 'link' ? <button className="link-btn ellipsis" onClick={() => a.url && openUrl(a.url, a.name)}>{a.name}</button> : <b className="ellipsis">{a.name}</b>}
        <span className="list-sub ellipsis">
          {a.kind === 'link' ? a.url
            : a.fetch === 'done' ? `已获取 · ${a.local}`
              : a.fetch === 'fetching' ? '获取中…'
                : a.fetch === 'error' ? a.error ?? '获取失败'
                  : `${ATTACH_KIND[a.kind]} · ${fmtSize(a.size)} · 还在平台上，没下载`}
        </span>
      </span>
      {children}
    </div>
  )
}

/** 消息详情里的附件区：获取，选项目加进支持材料 */
export function AttachmentPanel({ msg, projects, suggested, onFetch, onAdd }: {
  msg: Message
  projects: Project[]
  /** 这条消息所在的项目（绑了它的群或私聊），默认选这些 */
  suggested: string[]
  onFetch: (attId: string) => void
  onAdd: (attId: string, projectId: string) => void
}) {
  const [pick, setPick] = useState<Record<string, string>>({})
  const atts = msg.attachments ?? []
  if (!atts.length) return null
  const def = suggested[0] ?? ''
  return (
    <>
      <div className="section-label">附件 {atts.length}</div>
      <div className="att-list">
        {atts.map((a) => {
          const inP = addedIn(projects, a.id)
          const target = pick[a.id] ?? (inP.some((p) => p.id === def) ? projects.find((p) => !inP.includes(p))?.id ?? '' : def)
          const canAdd = target && !inP.some((p) => p.id === target)
          return (
            <AttRow key={a.id} a={a}>
              <span className="att-acts">
                {a.kind !== 'link' && a.fetch !== 'done' && (
                  <button className="act" disabled={a.fetch === 'fetching'} onClick={() => onFetch(a.id)}>{a.fetch === 'error' ? '重试' : a.fetch === 'fetching' ? '获取中' : '获取'}</button>
                )}
                <select className="att-proj" value={target} onChange={(e) => setPick({ ...pick, [a.id]: e.target.value })} title="加进哪个项目的支持材料">
                  <option value="">选项目…</option>
                  {suggested.length > 0 && <optgroup label="这条消息所在的项目">{projects.filter((p) => suggested.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>}
                  <optgroup label={suggested.length ? '其他项目' : '项目'}>{projects.filter((p) => !suggested.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
                </select>
                <button className="act act-primary" disabled={!canAdd || a.fetch === 'fetching'} onClick={() => onAdd(a.id, target)}
                  title={a.kind !== 'link' && a.fetch !== 'done' ? '会先获取到本地再加入' : undefined}>
                  {a.kind !== 'link' && a.fetch !== 'done' ? '获取并加入' : '加入资料'}
                </button>
              </span>
              {inP.length > 0 && <span className="att-in">已在 {inP.map((p) => p.name).join('、')} 的支持材料里</span>}
            </AttRow>
          )
        })}
      </div>
    </>
  )
}

/** 项目沟通页顶上：这个项目消息里还没决定的附件，一条条选加不加 */
export function ProjectAttachmentInbox({ p, messages, onFetch, onAdd, onSkip, onOpenMessage }: {
  p: Project
  /** 已经是这个项目的消息 */
  messages: Message[]
  onFetch: (msgId: string, attId: string) => void
  onAdd: (msgId: string, attId: string) => void
  onSkip: (attId: string, skip: boolean) => void
  onOpenMessage: (id: string) => void
}) {
  const [showSkipped, setShowSkipped] = useState(false)
  const all = messages.flatMap((m) => (m.attachments ?? []).map((a) => ({ m, a }))).sort((x, y) => y.m.at.localeCompare(x.m.at))
  const added = (id: string) => p.materials.some((x) => x.from?.attachment_id === id)
  const skipped = (id: string) => p.skipped_attachments?.includes(id) ?? false
  const todo = all.filter((x) => !added(x.a.id) && !skipped(x.a.id))
  const skippedRows = all.filter((x) => skipped(x.a.id))
  if (!all.length) return null
  return (
    <section className="att-inbox">
      <div className="mount-head">
        <div className="field-group-title">消息里的附件<span className="field-hint">{todo.length ? `${todo.length} 个还没决定要不要放进支持材料` : '都处理过了'}</span></div>
        {skippedRows.length > 0 && <button className="act act-quiet" onClick={() => setShowSkipped(!showSkipped)}>{showSkipped ? '收起' : `看不加入的 ${skippedRows.length} 个`}</button>}
      </div>
      {todo.map(({ m, a }) => (
        <AttRow key={a.id} a={a}>
          <span className="att-acts">
            <button className="act act-quiet" onClick={() => onOpenMessage(m.id)} title={m.text}>{m.sender_name} · {timeAgo(m.at)}</button>
            {a.kind !== 'link' && a.fetch !== 'done' && a.fetch !== 'fetching' && <button className="act" onClick={() => onFetch(m.id, a.id)}>{a.fetch === 'error' ? '重试' : '获取'}</button>}
            <button className="act act-primary" disabled={a.fetch === 'fetching'} onClick={() => onAdd(m.id, a.id)}>{a.kind !== 'link' && a.fetch !== 'done' ? '获取并加入' : '加入支持材料'}</button>
            <button className="act act-quiet" onClick={() => onSkip(a.id, true)}>不加入</button>
          </span>
        </AttRow>
      ))}
      {showSkipped && skippedRows.map(({ m, a }) => (
        <AttRow key={a.id} a={a}>
          <span className="att-acts">
            <span className="run-muted">{m.sender_name} · 选了不加入</span>
            <button className="act" onClick={() => onSkip(a.id, false)}>恢复</button>
          </span>
        </AttRow>
      ))}
    </section>
  )
}
