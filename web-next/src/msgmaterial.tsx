// IM 消息「转项目资料」（SPEC-messages-6）：把一条消息或合并显示的一组，按时间拼成一段对话记录，存成项目支持材料里的一条笔记。
// 正式产品见 frontend/src/plugins/im/ToMaterialDialog.tsx、toMaterialModel.ts、MaterialLinks.tsx；出处由 IM 插件记（POST /api/im/materials）。
// 原型里出处记在材料的 from 上（message_ids 是这组消息，attachment_id 为空），消息上的「已转资料」按它反查。
import { useState } from 'react'
import type { Message } from './data'
import type { Material, Project } from './projectdata'
import { SearchSelect } from './searchselect'
import { cls } from './ui'

/** 笔记正文的上限（同正式产品契约：note 最多 5000 字） */
export const NOTE_MAX = 5000
/** 转成的笔记打的标签 */
export const IM_MATERIAL_TAG = 'IM 消息'

const chrono = (xs: readonly Message[]) => [...xs].sort((a, b) => a.at.localeCompare(b.at))
const pad = (n: number) => String(n).padStart(2, '0')
const dayLabel = (iso: string) => {
  const d = new Date(iso)
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}年${md}`
}
const lineTime = (iso: string) => { const d = new Date(iso); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` }

/** 默认标题「<群或对方> <日期> 的消息」；跨天写「10月28日至10月30日」 */
export function materialTitle(xs: readonly Message[], who: (m: Message) => string): string {
  const all = chrono(xs)
  if (!all.length) return ''
  const last = all[all.length - 1]
  const a = dayLabel(all[0].at), b = dayLabel(last.at)
  return `${last.conversation || who(last)} ${a === b ? a : `${a}至${b}`} 的消息`
}

/** 正文：头一行渠道、群（或和谁的私聊）、条数；每条「[时间] 发信人：正文」，多行缩进，附件另起一行 */
export function materialBody(xs: readonly Message[], who: (m: Message) => string, chLabel: string): string {
  const all = chrono(xs)
  if (!all.length) return ''
  const last = all[all.length - 1]
  const head = `${chLabel} · ${last.conversation ? `群「${last.conversation}」` : `和 ${who(last)} 的私聊`} · ${all.length} 条消息`
  return [head, '', ...all.map((m) => {
    const [first, ...rest] = (m.text.trim() || '（没有正文）').split('\n')
    const atts = m.attachments?.length ? [`  附件：${m.attachments.map((x) => x.name).join('、')}`] : []
    return [`[${lineTime(m.at)}] ${who(m)}：${first}`, ...rest.map((l) => `  ${l}`), ...atts].join('\n')
  })].join('\n')
}

export type MaterialHit = { project: Project; material: Material }

/** 这组消息转成的笔记（不算附件加进的），新的在前 */
export function notesOf(projects: readonly Project[], ids: readonly string[]): MaterialHit[] {
  const out: MaterialHit[] = []
  for (const p of projects) for (const m of p.materials) if (m.from?.message_ids?.some((id) => ids.includes(id))) out.push({ project: p, material: m })
  return out.sort((a, b) => b.material.added_at.localeCompare(a.material.added_at))
}

/** 整组都在一条笔记里算转过；只有部分转过的给条数 */
export function priorOf(projects: readonly Project[], ids: readonly string[]) {
  const notes = notesOf(projects, ids)
  const same = notes.filter((h) => ids.every((id) => h.material.from!.message_ids!.includes(id)))
  const partial = same.length ? 0 : ids.filter((id) => notes.some((h) => h.material.from!.message_ids!.includes(id))).length
  return { same, partial }
}

/** 抽屉里「项目资料」一节（SPEC-messages-2.39、4.8）：只列转过的资料，没有时不显示；「转项目资料」在发送按钮那一行 */
export function MaterialSection({ notes, onOpen }: {
  notes: MaterialHit[]; onOpen: (projectId: string, materialId: string) => void
}) {
  if (!notes.length) return null
  return (
    <>
      <div className="section-label">项目资料</div>
      {notes.length > 0 && (
        <div className="act-row">
          <span className="muted">已转资料 {notes.length} 条</span>
          {notes.map((h) => (
            <button key={h.material.id} className="link-btn" onClick={() => onOpen(h.project.id, h.material.id)}>{h.material.name}（{h.project.name}）</button>
          ))}
        </div>
      )}
    </>
  )
}

/**
 * 转项目资料弹窗：项目默认取消息归到的项目，能换；标题、正文能改，正文最多 5000 字；可选连附件一起加入资料。
 * 以前整组转过的先提示，能打开已有的，也能「再转一份」
 */
export function ToMaterialDialog({ messages, projects, defaultProject, who, chLabel, onCancel, onSave, onOpen }: {
  messages: Message[]; projects: Project[]; defaultProject?: string; who: (m: Message) => string; chLabel: string
  onCancel: () => void
  /** markDone：存好后把这些消息里还没处理的标为已处理（SPEC-messages-6.13，默认勾上） */
  onSave: (projectId: string, title: string, body: string, withAttachments: boolean, markDone: boolean) => void
  onOpen: (projectId: string, materialId: string) => void
}) {
  const [pid, setPid] = useState(defaultProject ?? '')
  const [title, setTitle] = useState(() => materialTitle(messages, who))
  const [edited, setEdited] = useState<string | null>(null)
  const [withAtts, setWithAtts] = useState(false)
  const [markDone, setMarkDone] = useState(true)
  const openN = messages.filter((m) => m.status === 'pending' || m.status === 'expired').length
  const body = edited ?? materialBody(messages, who, chLabel)
  const len = Array.from(body.trim()).length
  const over = len > NOTE_MAX
  const atts = chrono(messages).flatMap((m) => (m.attachments ?? []).map((a) => ({ m, a })))
  const prior = priorOf(projects, messages.map((m) => m.id))
  const many = messages.length > 1
  const ok = !!pid && projects.some((p) => p.id === pid) && !!title.trim() && !!body.trim() && !over
  return (
    <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="qs msg-start" role="dialog" aria-label="转项目资料">
        <div className="qs-head"><b>转项目资料</b></div>
        {prior.same.length > 0 && (
          <div className="banner banner-warn msg-mat-prior">
            <div>{many ? '这组消息' : '这条消息'}已经转过资料：</div>
            {prior.same.map((h) => (
              <div key={h.material.id} className="act-row">
                <span className="ellipsis">{h.project.name}：{h.material.name}</span>
                <button className="link-btn" onClick={() => onOpen(h.project.id, h.material.id)}>打开已有的</button>
              </div>
            ))}
            <div className="list-sub">要再存一份就点「再转一份」</div>
          </div>
        )}
        {!prior.same.length && prior.partial > 0 && <div className="list-sub">其中 {prior.partial} 条已经转进过别的资料</div>}
        <label className="msg-start-field"><span className="list-sub">存到哪个项目{defaultProject ? (pid === defaultProject ? '（默认是消息归到的项目）' : '') : '（消息没归项目，挑一个）'}</span>
          <SearchSelect value={pid} onChange={setPid} placeholder="选项目" searchPlaceholder="搜项目" aria-label="存到哪个项目"
            options={projects.map((p) => ({ value: p.id, label: p.name, hint: p.id === defaultProject ? '消息归到的项目' : undefined }))} />
        </label>
        <label className="msg-start-field"><span className="list-sub">标题</span>
          <input className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="msg-start-field">
          <span className="list-sub">正文（{many ? `${messages.length} 条消息` : '这条消息'}，按时间拼成一段对话记录；{len} / {NOTE_MAX} 字）{edited !== null && <button className="link-btn" onClick={() => setEdited(null)}>恢复默认</button>}</span>
          <textarea className={cls('input', over && 'bad')} rows={10} value={body} onChange={(e) => setEdited(e.target.value)} />
          {over && <span className="danger-text list-sub">超过 {NOTE_MAX} 字（现在 {len} 字），删掉一些，或分几次转</span>}
        </label>
        {atts.length > 0 && (
          <div className="msg-start-field">
            <label className="check"><input type="checkbox" checked={withAtts} onChange={(e) => setWithAtts(e.target.checked)} /> 连附件一起加入资料（{atts.length} 个）</label>
            {withAtts && (
              <ul className="list-sub msg-mat-atts">
                {atts.map(({ m, a }) => (
                  <li key={`${m.id}:${a.id}`}>{a.name} · {a.kind === 'link' ? '链接' : a.fetch === 'done' ? '已获取' : a.fetch === 'error' ? `上次没取到（${a.error || '获取失败'}），会再试一次` : '还没获取，会先获取到本地'}</li>
                ))}
              </ul>
            )}
            {withAtts && <span className="list-sub">取不到的附件不加，笔记照样存；已经在这个项目资料里的跳过</span>}
          </div>
        )}
        {openN > 0 && (
          <label className="check"><input type="checkbox" checked={markDone} onChange={(e) => setMarkDone(e.target.checked)} /> 存好后标为已处理{messages.length > 1 && openN < messages.length ? `（还没处理的 ${openN} 条）` : ''}</label>
        )}
        <div className="act-row">
          <span className="spacer" />
          <button className="act act-quiet" onClick={onCancel}>取消</button>
          <button className="act act-primary" disabled={!ok} onClick={() => onSave(pid, title.trim(), body.trim(), withAtts, markDone)}>{prior.same.length ? '再转一份' : '存成资料'}</button>
        </div>
      </div>
    </div>
  )
}
