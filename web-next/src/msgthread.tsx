import { useEffect, useState } from 'react'
import type { Message } from './data'
import { cls, timeAgo } from './ui'
import { useEnumView } from './enumdata'
import { isOpenMsg } from './msggroup'
// MentionText 在 messages.tsx（两边互相引用只在渲染时用，没有初始化顺序问题）
import { MentionText } from './messages'

type MsgAct = { kind: 'done' | 'ignore' | 'reopen' }
type Action = 'done' | 'ignore'

/**
 * 原消息抽屉里的「消息列回复 N」一节（SPEC-messages-2.45）：按时间列整个消息列，每条能单独处理，点姓名打开那一条。
 * 批量处理（SPEC-messages-2.51）：没勾选时标题行右边「全部标为已处理」「全部忽略」（先确认，只算还没处理的回复，不含原消息）；
 * 勾了以后换成「已选 N 条」「全选 M 条」「标为已处理」「忽略」「取消选择」（同列表批量条）；原消息也没处理时多一个「连原消息一起」。
 * 原型逐条改本地数据，没有部分跳过、失败和分批。
 */
export function ThreadReplies({ parent, replies, onOpen, onActOther, onActParent }: {
  parent: Message
  replies: Message[]
  onOpen?: (id: string) => void
  onActOther?: (id: string, a: MsgAct) => void
  onActParent: (a: MsgAct) => void
}) {
  const msgEnum = useEnumView('msg_status')
  const doneLabel = msgEnum.label('done')
  const [sel, setSel] = useState<Set<string>>(() => new Set())
  const [withParent, setWithParent] = useState(false)
  const [confirm, setConfirm] = useState<Action | null>(null)
  const [note, setNote] = useState('')

  const open = replies.filter(isOpenMsg)
  const picked = open.filter((m) => sel.has(m.id))
  const parentOpen = isOpenMsg(parent)
  const alsoParent = withParent && parentOpen

  const run = (a: Action, ids: string[]) => {
    ids.forEach((id) => onActOther?.(id, { kind: a }))
    if (alsoParent) onActParent({ kind: a })
    const n = ids.length + (alsoParent ? 1 : 0)
    setNote(n ? `已把 ${n} 条标为${msgEnum.label(a === 'done' ? 'done' : 'ignored')}` : '没有要处理的消息')
    setSel(new Set())
    setWithParent(false)
  }
  const toggle = (id: string, on: boolean) => setSel((s) => {
    const n = new Set(s)
    if (on) n.add(id)
    else n.delete(id)
    return n
  })
  const parentCheck = parentOpen && (
    <label className="check thread-with-parent" title="原消息也还没处理，勾上后原消息一起标">
      <input type="checkbox" checked={withParent} onChange={(e) => setWithParent(e.target.checked)} />连原消息一起
    </label>
  )

  return (
    <>
      <div className="section-label thread-head">
        <span>消息列回复 <span className="seg-n">{replies.length}</span></span>
        {picked.length > 0 ? (
          <div className="thread-bulk" role="toolbar" aria-label="批量处理消息列回复">
            <b>已选 {picked.length} 条</b>
            {picked.length < open.length && <button className="act act-quiet" onClick={() => setSel(new Set(open.map((m) => m.id)))}>全选 {open.length} 条</button>}
            <span className="spacer" />
            {parentCheck}
            <button className="act act-primary" onClick={() => run('done', picked.map((m) => m.id))}>标为{doneLabel}</button>
            <button className="act" onClick={() => run('ignore', picked.map((m) => m.id))}>忽略</button>
            <button className="act act-quiet" onClick={() => setSel(new Set())}>取消选择</button>
          </div>
        ) : open.length > 0 && (
          <div className="thread-bulk">
            <span className="spacer" />
            {parentCheck}
            <button className="act act-primary" title={`这个消息列里 ${open.length} 条没处理的回复都标为${doneLabel}`} onClick={() => setConfirm('done')}>全部标为{doneLabel}</button>
            <button className="act" title={`这个消息列里 ${open.length} 条没处理的回复都忽略`} onClick={() => setConfirm('ignore')}>全部忽略</button>
          </div>
        )}
      </div>
      {note && <div className="thread-note" role="status">{note}</div>}
      <div className="thread-list">
        {replies.map((m) => {
          const o = isOpenMsg(m)
          return (
            <div key={m.id} className={cls('thread-item', !o && 'msg-closed', o && sel.has(m.id) && 'thread-picked')}>
              <div className="thread-item-top">
                {o ? <input type="checkbox" className="thread-check" aria-label={`选择 ${m.sender_name} 的回复`} checked={sel.has(m.id)} onChange={(e) => toggle(m.id, e.target.checked)} />
                  : <span className="thread-check" aria-hidden />}
                <button className="thread-who" onClick={() => onOpen?.(m.id)} title="打开这一条">{m.sender_name}</button>
                <span className="muted">{timeAgo(m.at)}</span>
                {m.status !== 'pending' && <span className="state">{msgEnum.label(m.status)}</span>}
                <span className="spacer" />
                {o ? (
                  <>
                    <button className="act" onClick={() => onActOther?.(m.id, { kind: 'done' })}>标为{doneLabel}</button>
                    <button className="act act-quiet" onClick={() => onActOther?.(m.id, { kind: 'ignore' })}>忽略</button>
                  </>
                ) : <button className="act" onClick={() => onActOther?.(m.id, { kind: 'reopen' })}>重新打开</button>}
              </div>
              <div className="thread-item-text"><MentionText text={m.text} /></div>
            </div>
          )
        })}
      </div>
      {confirm && (
        <ThreadConfirm title={`把这个消息列里 ${open.length} 条没处理的回复${alsoParent ? '和原消息' : ''}${confirm === 'done' ? `标为${doneLabel}` : '忽略'}？`}
          body={`只改还没处理的（待处理、已过期）；已经在别处处理掉的会跳过。${alsoParent ? '原消息一起处理。' : '原消息不动。'}`}
          okLabel={confirm === 'done' ? `全部标为${doneLabel}` : '全部忽略'}
          onCancel={() => setConfirm(null)}
          onOk={() => { run(confirm, open.map((m) => m.id)); setConfirm(null) }} />
      )}
    </>
  )
}

function ThreadConfirm({ title, body, okLabel, onOk, onCancel }: { title: string; body: string; okLabel: string; onOk: () => void; onCancel: () => void }) {
  useEffect(() => {
    // 捕获阶段拦下 Esc，外层抽屉收不到
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  return (
    <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }} onClick={(e) => e.stopPropagation()}>
      <div className="qs thread-confirm" role="alertdialog" aria-label={title}>
        <div className="qs-head"><b>{title}</b></div>
        <div className="list-sub">{body}</div>
        <div className="act-row">
          <span className="spacer" />
          <button className="act act-quiet" autoFocus onClick={onCancel}>取消</button>
          <button className="act act-primary" onClick={onOk}>{okLabel}</button>
        </div>
      </div>
    </div>
  )
}
