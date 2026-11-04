// 原消息抽屉里的「消息列回复 N」一节（SPEC-messages-2.45）：按时间列整个消息列，每条能单独处理，点姓名打开那一条。
// 批量处理（SPEC-messages-2.51）：
// - 没勾选时标题行右边「全部标为已处理」「全部忽略」，范围是这个消息列里还没处理的回复（待处理、已过期），不含原消息；先确认再调批量接口。
// - 每条还没处理的回复前有勾选框；勾了以后标题行换成「已选 N 条」「全选 M 条」「标为已处理」「忽略」「取消选择」，照列表批量条（1.41、1.51）的文案和顺序。
// - 原消息也还没处理时标题行多一个勾选「连原消息一起」（同抽屉回复栏「发送后标为已处理」一样是动作旁边的勾选），勾上后整列和勾选的批量都把原消息带上。
// - 处理完提示「已把 N 条标为已处理，跳过 M 条（已经在别处处理过）」，勾选清掉；没改成时红字「没改成：<原因>」，勾选保留。
// 超过 500 条由 useImBatch 分批调、合并结果。批量「重新打开」没有接口，仍逐条重开。
import { useState } from 'react'
import { errorText, useImAction, useImBatch, type ImMessage } from '../../core/data'
import { Checkbox, ConfirmDialog, cls } from '../../core/ui'
import { shortTime, whoName, type StatusView } from './model'
import { MentionText } from './parts'
import { batchIds, batchNote, confirmTitle, isOpenMsg, livePicked, openReplies } from './threadBatch'

type Action = 'done' | 'ignore'

export function ThreadReplies({ parent, replies, sv, onOpen }: {
  /** 原消息（抽屉打开的这条） */
  parent: ImMessage
  /** 整个消息列的回复，按时间正序 */
  replies: ImMessage[]
  sv: StatusView
  onOpen?: (id: string) => void
}) {
  const act = useImAction()
  const batch = useImBatch()
  const [sel, setSel] = useState<Set<string>>(() => new Set())
  const [withParent, setWithParent] = useState(false)
  const [confirm, setConfirm] = useState<Action | null>(null)
  const [note, setNote] = useState('')
  const doneLabel = sv.label('done')
  const label = (a: Action) => sv.label(a === 'done' ? 'done' : 'ignored')
  const verb = (a: Action) => (a === 'done' ? `标为${doneLabel}` : '忽略')

  const open = openReplies(replies)
  const picked = livePicked(replies, sel)
  const parentOpen = isOpenMsg(parent)
  const alsoParent = withParent && parentOpen
  const busy = batch.isPending

  const run = (a: Action, replyIds: string[]) => {
    if (busy) return
    const ids = batchIds(replyIds, parent, withParent)
    if (!ids.length) return
    setNote('')
    batch.mutate({ action: a, ids }, {
      onSuccess: (r) => {
        setSel(new Set())
        setWithParent(false)
        setNote(batchNote(ids.length, r.count, label(a)))
      },
    })
  }
  const toggle = (id: string, on: boolean) => setSel((s) => {
    const n = new Set(s)
    if (on) n.add(id)
    else n.delete(id)
    return n
  })

  return (
    <>
      <div className="im-section im-thread-head">
        <span>消息列回复 <span className="seg-n">{replies.length}</span></span>
        {picked.length > 0 ? (
          <div className="im-thread-bulk" role="toolbar" aria-label="批量处理消息列回复">
            <b className="im-thread-bulk-n">已选 {picked.length} 条</b>
            {picked.length < open.length && (
              <button type="button" className="im-act im-act-quiet" onClick={() => setSel(new Set(open.map((m) => m.id)))}>全选 {open.length} 条</button>
            )}
            <span className="spacer" />
            {parentOpen && <ParentCheck checked={withParent} disabled={busy} onChange={setWithParent} />}
            <button type="button" className="im-act im-act-primary" disabled={busy} onClick={() => run('done', picked.map((m) => m.id))}>标为{doneLabel}</button>
            <button type="button" className="im-act" disabled={busy} onClick={() => run('ignore', picked.map((m) => m.id))}>忽略</button>
            <button type="button" className="im-act im-act-quiet" onClick={() => setSel(new Set())}>取消选择</button>
          </div>
        ) : open.length > 0 && (
          <div className="im-thread-bulk">
            <span className="spacer" />
            {parentOpen && <ParentCheck checked={withParent} disabled={busy} onChange={setWithParent} />}
            <button type="button" className="im-act im-act-primary" disabled={busy} title={`这个消息列里 ${open.length} 条没处理的回复都标为${doneLabel}`}
              onClick={() => setConfirm('done')}>全部标为{doneLabel}</button>
            <button type="button" className="im-act" disabled={busy} title={`这个消息列里 ${open.length} 条没处理的回复都忽略`}
              onClick={() => setConfirm('ignore')}>全部忽略</button>
          </div>
        )}
      </div>
      {note && <div className="im-thread-note" role="status">{note}</div>}
      {batch.isError && <div className="im-err" role="alert">没改成：{errorText(batch.error)}</div>}
      <div className="im-thread-list" role="list" aria-label="消息列回复">
        {replies.map((m) => {
          const o = isOpenMsg(m)
          const who = whoName(m)
          return (
            <div key={m.id} role="listitem" className={cls('im-thread-item', !o && 'im-closed', sel.has(m.id) && o && 'im-thread-picked')}>
              <div className="im-thread-item-top">
                {o ? (
                  <Checkbox className="im-thread-check" aria-label={`选择 ${who} ${shortTime(m.at)} 的回复`} checked={sel.has(m.id)}
                    onCheckedChange={(on) => toggle(m.id, on)} />
                ) : <span className="im-thread-check" aria-hidden />}
                <button type="button" className="im-thread-who" onClick={() => onOpen?.(m.id)} title="打开这一条">{who}</button>
                <span className="im-muted">{shortTime(m.at)}</span>
                {m.status !== 'pending' && <span className="im-state" style={{ color: sv.color(m.status) }}>{sv.label(m.status)}</span>}
                <span className="spacer" />
                {o ? (
                  <>
                    <button type="button" className="im-act" disabled={act.isPending || busy} onClick={() => act.mutate({ id: m.id, action: { kind: 'done' } })}>标为{doneLabel}</button>
                    <button type="button" className="im-act im-act-quiet" disabled={act.isPending || busy} onClick={() => act.mutate({ id: m.id, action: { kind: 'ignore' } })}>忽略</button>
                  </>
                ) : <button type="button" className="im-act" disabled={act.isPending || busy} onClick={() => act.mutate({ id: m.id, action: { kind: 'reopen' } })}>重新打开</button>}
              </div>
              <div className="im-thread-item-text"><MentionText text={m.text} /></div>
            </div>
          )
        })}
      </div>
      {act.isError && <div className="im-err" role="alert">没改成：{errorText(act.error)}</div>}
      <ConfirmDialog open={!!confirm} title={confirm ? confirmTitle(open.length, alsoParent, verb(confirm)) : ''}
        confirmLabel={confirm === 'ignore' ? '全部忽略' : `全部标为${doneLabel}`} busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => { if (confirm) run(confirm, open.map((m) => m.id)); setConfirm(null) }}>
        只改还没处理的（待处理、已过期）；已经在别处处理掉的会跳过。{alsoParent ? '原消息一起处理。' : '原消息不动。'}
      </ConfirmDialog>
    </>
  )
}

/** 「连原消息一起」：原消息也还没处理时才有 */
function ParentCheck({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <span title="原消息也还没处理，勾上后原消息一起标">
      <Checkbox className="im-thread-with-parent" checked={checked} disabled={disabled} onCheckedChange={onChange}>连原消息一起</Checkbox>
    </span>
  )
}
