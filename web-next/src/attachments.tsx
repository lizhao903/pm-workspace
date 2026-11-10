// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useState } from 'react'
import type { Message, MsgAttachment } from './data'
import type { Project } from './projectdata'
import { AttachmentPreview, AttThumb } from './attpreview'
import { useOpenUrl } from './openurl'
import { SearchSelect } from './searchselect'
import { cls, timeAgo } from './ui'

// 消息附件：在消息列表上露个名字，在消息详情里获取、加进项目资料，在项目的「附件」标签里集中管理（挑哪些要进支持材料）
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
function AttRow({ a, onPreview, children }: { a: MsgAttachment; onPreview?: () => void; children?: React.ReactNode }) {
  const openUrl = useOpenUrl()
  return (
    <div className={cls('att-row', a.fetch === 'error' && 'att-bad')}>
      {onPreview && a.kind === 'image' && a.fetch === 'done'
        ? <AttThumb a={a} onClick={onPreview} />
        : <span className={cls('att-ico', `att-${a.kind}`)}><AttIcon kind={a.kind} /></span>}
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
  const [preview, setPreview] = useState<string | null>(null)
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
            <AttRow key={a.id} a={a} onPreview={() => setPreview(a.id)}>
              <span className="att-acts">
                {a.kind !== 'link' && <button className="act" disabled={a.fetch === 'fetching'} onClick={() => setPreview(a.id)}>预览</button>}
                {a.kind !== 'link' && a.fetch === 'done' && <button className="act act-quiet" title="下载到浏览器">下载</button>}
                {a.kind !== 'link' && a.fetch !== 'done' && (
                  <button className="act" disabled={a.fetch === 'fetching'} onClick={() => onFetch(a.id)}>{a.fetch === 'error' ? '重试' : a.fetch === 'fetching' ? '获取中' : '获取'}</button>
                )}
                <SearchSelect className="att-proj" value={target} onChange={(v) => setPick({ ...pick, [a.id]: v })} placeholder="选项目" searchPlaceholder="搜项目" active={false}
                  aria-label="加进哪个项目的支持材料" align="end" missingLabel={() => '已删除的项目'}
                  options={[
                    ...projects.filter((p) => suggested.includes(p.id)).map((p) => ({ value: p.id, label: p.name, group: '这条消息所在的项目', hint: inP.includes(p) ? '已加入' : undefined })),
                    ...projects.filter((p) => !suggested.includes(p.id)).map((p) => ({ value: p.id, label: p.name, group: suggested.length ? '其他项目' : '项目', hint: inP.includes(p) ? '已加入' : undefined })),
                  ]} />
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
      {preview && <AttachmentPreview msg={msg} startId={preview} onFetch={onFetch} onClose={() => setPreview(null)} />}
    </>
  )
}

export type AttState = 'todo' | 'added' | 'skipped'
export const ATT_STATE: Record<AttState, string> = { todo: '待决定', added: '已加入资料', skipped: '不加入' }
const ATT_SEGS: { key: AttState | ''; label: string }[] = [{ key: 'todo', label: '待决定' }, { key: 'added', label: '已加入资料' }, { key: 'skipped', label: '不加入' }, { key: '', label: '全部' }]
type AttRow = { m: Message; a: MsgAttachment; state: AttState; materialId?: string }

/** 项目消息里的附件，一个附件一行，按消息时间倒序；去向：加过资料的算已加入，记在 skipped_attachments 的算不加入，其余待决定 */
export function projectAttachmentRows(p: Project, messages: Message[]): AttRow[] {
  const seen = new Set<string>()
  return [...messages].sort((x, y) => y.at.localeCompare(x.at)).flatMap((m) => (m.attachments ?? []).flatMap((a) => {
    if (seen.has(a.id)) return []
    seen.add(a.id)
    const mat = p.materials.find((x) => x.from?.attachment_id === a.id)
    return [{ m, a, materialId: mat?.id, state: mat ? 'added' as const : p.skipped_attachments?.includes(a.id) ? 'skipped' as const : 'todo' as const }]
  }))
}

/** 沟通标签右栏顶上的一行：有待决定的附件时出现，点了去附件标签 */
export function AttachmentsHint({ p, messages, onGo }: { p: Project; messages: Message[]; onGo: () => void }) {
  const n = projectAttachmentRows(p, messages).filter((r) => r.state === 'todo').length
  if (!n) return null
  return (
    <button className="att-hint-line" onClick={onGo}>
      <AttIcon kind="file" />消息里有 {n} 个附件待决定要不要放进支持材料<span className="link-btn">去附件标签</span>
    </button>
  )
}

/**
 * 项目的「附件」标签（SPEC-projects-5）：项目沟通消息里的全部附件——待决定、已加入资料、不加入——集中管理。
 * 分段 + 种类 + 搜索筛选；每行勾选、名字和种类大小、来自（点开来源消息）、时间、获取状态、去向、操作；勾选后批量加入资料或不加入
 */
export function ProjectAttachmentsTab({ p, messages, onFetch, onAdd, onSkip, onOpenMessage, onOpenMaterial }: {
  p: Project
  /** 已经是这个项目的消息 */
  messages: Message[]
  onFetch: (msgId: string, attId: string) => void
  onAdd: (msgId: string, attId: string) => void
  /** 一次改多个，记在 skipped_attachments */
  onSkip: (attIds: string[], skip: boolean) => void
  onOpenMessage: (id: string) => void
  /** 去支持材料里看那一条 */
  onOpenMaterial: (id: string) => void
}) {
  const openUrl = useOpenUrl()
  const [seg, setSeg] = useState<AttState | ''>('todo')
  const [kind, setKind] = useState<MsgAttachment['kind'] | ''>('')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string[]>([])
  const [preview, setPreview] = useState<string | null>(null)
  const rows = projectAttachmentRows(p, messages)
  const hit = (r: AttRow) => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const hay = `${r.a.name} ${r.m.sender_name} ${r.m.conversation}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  }
  const base = rows.filter((r) => (!kind || r.a.kind === kind) && hit(r))
  const shown = base.filter((r) => !seg || r.state === seg)
  const kindN = (k: MsgAttachment['kind']) => rows.filter((r) => r.a.kind === k && (!seg || r.state === seg) && hit(r)).length
  const picked = shown.filter((r) => sel.includes(r.a.id) && r.state !== 'added')
  const pickable = shown.filter((r) => r.state !== 'added')
  const allPicked = pickable.length > 0 && pickable.every((r) => sel.includes(r.a.id))
  const narrowed = !!kind || !!q.trim()
  if (!rows.length) {
    return <div className="empty"><div className="empty-title">消息里还没有附件</div><div className="list-sub">绑定的群和私聊里、归到这个项目的消息带的文件、图片、链接会出现在这里，逐个决定要不要放进支持材料</div></div>
  }
  const fetchText = (a: MsgAttachment) => (a.kind === 'link' ? '不用获取' : a.fetch === 'done' ? '已获取' : a.fetch === 'fetching' ? '获取中…' : a.fetch === 'error' ? '获取失败' : '没获取')
  const previewMsg = preview ? rows.find((r) => r.a.id === preview)?.m : undefined
  return (
    <div className="att-tab">
      <div className="toolbar att-tools">
        <div className="seg">
          {ATT_SEGS.map((s) => (
            <button key={s.key || 'all'} className={cls(seg === s.key && 'on')} onClick={() => setSeg(s.key)}>
              {s.label}<span className="seg-n">{s.key ? base.filter((r) => r.state === s.key).length : base.length}</span>
            </button>
          ))}
        </div>
        <label className={cls('chip chip-select', kind && 'chip-on')}>
          <select value={kind} onChange={(e) => setKind(e.target.value as MsgAttachment['kind'] | '')}>
            <option value="">全部种类</option>
            {(['image', 'file', 'link'] as const).map((k) => <option key={k} value={k}>{ATTACH_KIND[k]}（{kindN(k)}）</option>)}
          </select>
        </label>
        <div className="search att-search">
          <svg viewBox="0 0 16 16" width="13" height="13"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input value={q} placeholder="搜文件名、发信人、群名" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ('') } }} />
        </div>
      </div>
      {picked.length > 0 && (
        <div className="att-bulk">
          <span>已选 {picked.length} 个</span>
          <button className="btn btn-primary btn-sm" onClick={() => { picked.forEach((r) => onAdd(r.m.id, r.a.id)); setSel([]) }}>加入资料</button>
          <button className="btn btn-outline btn-sm" disabled={!picked.some((r) => r.state === 'todo')} title="只对待决定的生效"
            onClick={() => { onSkip(picked.filter((r) => r.state === 'todo').map((r) => r.a.id), true); setSel([]) }}>不加入</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setSel([])}>取消选择</button>
        </div>
      )}
      {shown.length ? (
        <div className="att-table">
          <div className="att-tr att-th">
            <span><input type="checkbox" checked={allPicked} disabled={!pickable.length} title="全选能操作的"
              onChange={(e) => setSel(e.target.checked ? [...new Set([...sel, ...pickable.map((r) => r.a.id)])] : sel.filter((id) => !pickable.some((r) => r.a.id === id)))} /></span>
            <span>附件</span><span>来自</span><span>时间</span><span>获取</span><span>去向</span><span className="att-ops">操作</span>
          </div>
          {shown.map(({ m, a, state, materialId }) => (
            <div key={a.id} className={cls('att-tr', sel.includes(a.id) && 'on', a.fetch === 'error' && 'att-bad')}>
              <span><input type="checkbox" disabled={state === 'added'} checked={sel.includes(a.id)}
                onChange={(e) => setSel(e.target.checked ? [...sel, a.id] : sel.filter((x) => x !== a.id))} /></span>
              <span className="att-cell-name">
                <span className={cls('att-ico', `att-${a.kind}`)}><AttIcon kind={a.kind} /></span>
                <span className="att-main">
                  {a.kind === 'link' ? <button className="link-btn ellipsis" onClick={() => a.url && openUrl(a.url, a.name)}>{a.name}</button> : <b className="ellipsis">{a.name}</b>}
                  <span className="list-sub ellipsis">{ATTACH_KIND[a.kind]}{a.kind === 'link' ? ` · ${a.url}` : a.size ? ` · ${fmtSize(a.size)}` : ''}</span>
                </span>
              </span>
              <button className="att-src" title={`打开来源消息：${m.text}`} onClick={() => onOpenMessage(m.id)}>
                <b className="ellipsis">{m.sender_name}</b><span className="list-sub ellipsis">{m.conversation || '私聊'}</span>
              </button>
              <span className="run-muted">{timeAgo(m.at)}</span>
              <span className={cls('att-fetch', a.fetch === 'error' && 'att-err')} title={a.fetch === 'error' ? a.error : undefined}>{fetchText(a)}</span>
              <span>{state === 'added' && materialId ? <button className="link-btn att-state" title="到支持材料里看这一条" onClick={() => onOpenMaterial(materialId)}>已加入资料</button>
                : <span className={cls('att-state', `att-state-${state}`)}>{ATT_STATE[state]}</span>}</span>
              <span className="att-acts att-ops">
                {a.kind !== 'link' && a.fetch !== 'done' && a.fetch !== 'fetching' && <button className="act" onClick={() => onFetch(m.id, a.id)}>{a.fetch === 'error' ? '重试' : '获取'}</button>}
                {a.kind !== 'link' && <button className="act" onClick={() => setPreview(a.id)}>预览</button>}
                {a.kind !== 'link' && a.fetch === 'done' && <button className="act" title="下载到浏览器">下载</button>}
                {a.kind === 'link' && <button className="act" onClick={() => a.url && openUrl(a.url, a.name)}>打开</button>}
                {state !== 'added' && <button className="act act-primary" disabled={a.fetch === 'fetching'} onClick={() => onAdd(m.id, a.id)}>{a.kind !== 'link' && a.fetch !== 'done' ? '获取并加入' : '加入资料'}</button>}
                {state === 'todo' && <button className="act act-quiet" onClick={() => onSkip([a.id], true)}>不加入</button>}
                {state === 'skipped' && <button className="act act-quiet" onClick={() => onSkip([a.id], false)}>撤销不加入</button>}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">
          <div className="empty-title">{narrowed ? '没有匹配的附件' : seg === 'todo' ? '都处理过了' : `没有${ATT_STATE[seg || 'todo']}的附件`}</div>
          {narrowed ? <button className="btn btn-outline" onClick={() => { setQ(''); setKind('') }}>清掉筛选</button>
            : seg ? <button className="btn btn-outline" onClick={() => setSeg('')}>看全部</button> : null}
        </div>
      )}
      {preview && previewMsg && (
        <AttachmentPreview msg={previewMsg} startId={preview} pool={shown.map((r) => r.a)}
          onFetch={(attId) => { const r = rows.find((x) => x.a.id === attId); if (r) onFetch(r.m.id, attId) }} onClose={() => setPreview(null)} />
      )}
    </div>
  )
}
