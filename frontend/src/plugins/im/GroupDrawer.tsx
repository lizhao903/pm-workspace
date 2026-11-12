// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 合并显示的一组消息的抽屉：同一个私聊的整段对话、群里同一人连发的一段、重复消息。按时间正序看全部消息（含已处理的），
// 每条能单独标已处理、忽略、重新打开，或点「详情」打开这一条的消息抽屉（转任务、认人、附件、归项目都在那里）；
// 上面一条能把这组还没处理的全部标为已处理或忽略；「交给 Agent」带上整组发起会话、拆分任务；回复框回最新一条。
// 地址记 ?g=<组的 key>（groupModel），刷新后照样打开。
// 「转项目资料」（0009）把整组按时间拼成一段对话记录存成项目的一条笔记，转过的能点过去（MaterialLinks）。
// 回复框带 @（0.18.0）：同单条抽屉，群里有「回复时 @ 对方」开关（@ 最新一条的发信人，默认打开、记在本机），
// 输入 @ 弹出联系人和会话里发过言的人；私聊不加。
// 「分诊建议」一节（SOP 插件在跑时才有）放在发信人下面、消息列表上面，由消息页传进来（TriageAdvice 的 GroupTriageSection）。
import { useState, type ReactNode } from 'react'
import { errorText, useImAction, useImMembers, type Connector, type ImAction, type ImMessage, type ImSessionIntent } from '../../core/data'
import { Avatar, Button, Checkbox, Drawer, cls } from '../../core/ui'
import { AgentSection, ReplyBarActions } from './AgentLinks'
import { countLabel, type Row } from './groupModel'
import { MaterialSection } from './MaterialLinks'
import { isOpen, isSnoozed, replyBlocker, shortTime, timeAgo, whoName, type Channel, type StatusView } from './model'
import { AttachmentChips, ChannelMark, MentionText } from './parts'
import type { ContactLinkMode, ContactLinkResult } from './ContactLink'
import { LinkNote, SenderContactActs } from './SenderContact'
import { MentionBox } from './MentionBox'
import { defaultMention } from './mentionModel'
import { useMentions } from './useMentions'

const KIND_TITLE: Record<Row['kind'], string> = { single: '消息', dm: '私聊', burst: '连发的消息', dup: '重复的消息' }

export function GroupDrawer({ row, ch, connectors, sv, photo, note, batchBusy, triage, onClose, onBatch, onOpenMessage, onOpenContact, onLinkContact, onStart, onOpenSession, onOpenTask, onToMaterial, onOpenMaterial }: {
  /** 取不到这一组（消息清理了）时为 null */
  row: Row | null
  ch: Channel
  connectors: Connector[] | undefined
  sv: StatusView
  photo?: string
  /** 刚在这组上认完人的结果一行（同单条抽屉） */
  note?: ContactLinkResult
  batchBusy: boolean
  /** 「分诊建议」一节；SOP 插件没在跑时不传 */
  triage?: ReactNode
  /** 维护联系人（IM-05）：同一组是同一个发信人，按最新一条的发信人认；认人按 IM 身份，这个人所有消息跟着变 */
  onOpenContact: (id: string) => void
  onLinkContact: (msg: ImMessage, mode: ContactLinkMode) => void
  onClose: () => void
  /** 整组还没处理的标为已处理、忽略（按 id 批量） */
  onBatch: (action: 'done' | 'ignore', ids: string[]) => void
  onOpenMessage: (id: string) => void
  onStart: (intent: ImSessionIntent) => void
  onOpenSession: (id: string) => void
  onOpenTask: (id: string) => void
  /** 整组转项目资料（0009）；转过的资料点过去 */
  onToMaterial: () => void
  onOpenMaterial: (projectId: string, materialId: string) => void
}) {
  const act = useImAction()
  const reply = useImAction()
  const [text, setText] = useState('')
  const [alsoDone, setAlsoDone] = useState(true)
  const newest = row?.all[row.all.length - 1]
  const members = useImMembers(newest?.conversation_id)
  const ment = useMentions(newest ? defaultMention(newest) : null)
  if (!row) {
    return (
      <Drawer open onClose={onClose} kicker="IM 消息" aria-label="一组消息" footer={<Button onClick={onClose}>关闭</Button>}>
        <div className="empty"><div className="empty-title">这组消息已不存在</div></div>
      </Drawer>
    )
  }
  const all = row.all
  const last = all[all.length - 1]
  const open = all.filter(isOpen)
  const doneLabel = sv.label('done')
  const blocker = replyBlocker(last, connectors)
  const who = whoName(last)
  const run = (m: ImMessage, a: ImAction) => act.mutate({ id: m.id, action: a })
  const send = () => {
    if (!text.trim() || blocker || reply.isPending) return
    const { text: body, mentions } = ment.compose(text)
    reply.mutate({ id: last.id, action: { kind: 'reply', text: body, done: alsoDone, mentions } }, {
      onSuccess: () => {
        setText('')
        ment.clear()
        const rest = open.filter((m) => m.id !== last.id).map((m) => m.id)
        if (alsoDone && rest.length) onBatch('done', rest)
      },
    })
  }

  return (
    <Drawer open onClose={onClose} aria-label="一组消息" className="im-drawer"
      kicker={<span className="im-kicker"><ChannelMark ch={ch} /><span className="ellipsis">{last.conversation || '私聊'} · {KIND_TITLE[row.kind]}</span></span>}
      footer={(
        <div className="im-reply-box">
          <MentionBox value={text} onChange={setText} disabled={!!blocker} label="回复内容"
            members={blocker ? undefined : members.data} membersLoading={members.isLoading} onPick={ment.pick}
            placeholder={blocker ?? `回复 ${who}（回最新一条），输入 @ 提到别人，⌘ Enter 发送`}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() } }} />
          {reply.isError && <div className="im-err" role="alert">没发出去：{errorText(reply.error)}</div>}
          <div className="im-reply-bar">
            <Checkbox checked={alsoDone} disabled={!!blocker} onCheckedChange={setAlsoDone}>发送后把这组都标为{doneLabel}</Checkbox>
            {ment.toggle && (
              <span title={`发送时在正文开头 @${ment.toggle.name}，对方会收到通知`}>
                <Checkbox checked={ment.on} disabled={!!blocker} onCheckedChange={ment.setOn}>回复时 @ 对方</Checkbox>
              </span>
            )}
            <span className="spacer" />
            <ReplyBarActions many onStart={onStart} onToMaterial={onToMaterial} />
            <Button variant="primary" disabled={!!blocker || !text.trim() || reply.isPending} onClick={send}>{reply.isPending ? '发送中…' : '发送'}</Button>
          </div>
        </div>
      )}>
      <div className={cls('im-strip', open.length ? 'im-strip-pending' : `im-strip-${last.status}`)}>
        <span className="im-strip-dot" style={open.length ? undefined : { background: sv.color(last.status) }} />
        <b>{all.length} 条</b>
        <span className="im-strip-sub">{open.length ? `${open.length} 条还没处理` : `都处理过了`}{row.kind === 'dup' ? ' · 内容相同' : ''}</span>
        <span className="spacer" />
        {open.length > 0 && (
          <>
            <button type="button" className="im-strip-act im-strip-primary" disabled={batchBusy} onClick={() => onBatch('done', open.map((m) => m.id))}>全部标为{doneLabel}</button>
            <button type="button" className="im-strip-act" disabled={batchBusy} onClick={() => onBatch('ignore', open.map((m) => m.id))}>全部忽略</button>
          </>
        )}
      </div>
      {act.isError && <div className="im-err" role="alert">没改成：{errorText(act.error)}</div>}

      <div className="im-sender">
        <Avatar name={who} size={40} src={photo} />
        <div className="im-sender-text">
          <div className="im-sender-name">{row.kind === 'dm' ? `和 ${who} 的私聊` : who}</div>
          <div className="im-muted">{ch.label} · <span className="im-mono">{last.sender_id}</span> · {countLabel({ ...row, items: all }) || '1 条'} · 最近 {timeAgo(last.at)}</div>
        </div>
        <span className="spacer" />
        <SenderContactActs msg={last} chLabel={ch.label} onOpenContact={onOpenContact} onLinkContact={(mode) => onLinkContact(last, mode)} />
      </div>
      {note && <LinkNote note={note} onOpenContact={onOpenContact} />}

      {triage}

      <div className="im-group-thread" role="list" aria-label="这组消息">
        {all.map((m) => {
          const snoozed = isSnoozed(m)
          return (
            <div key={m.id} role="listitem" className={cls('im-group-item', !isOpen(m) && 'im-closed')}>
              <div className="im-group-meta">
                <span className="im-muted">{shortTime(m.at)}</span>
                {m.status !== 'pending' && <span className="im-state" style={{ color: sv.color(m.status) }}>{sv.label(m.status)}</span>}
                {snoozed && <span className="im-state im-state-snooze">{shortTime(m.snooze_until!)} 提醒</span>}
                {!m.read && <span className="im-state">未读</span>}
                {m.task_id && <span className="im-state">已转任务 {m.task_ref}</span>}
                <span className="spacer" />
                {isOpen(m) ? (
                  <>
                    <button type="button" className="im-act im-act-primary" disabled={act.isPending} onClick={() => run(m, { kind: 'done' })}>{doneLabel}</button>
                    <button type="button" className="im-act im-act-quiet" disabled={act.isPending} onClick={() => run(m, { kind: 'ignore' })}>忽略</button>
                  </>
                ) : <button type="button" className="im-act" disabled={act.isPending} onClick={() => run(m, { kind: 'reopen' })}>重新打开</button>}
                <button type="button" className="im-act" onClick={() => onOpenMessage(m.id)} title="打开这一条：转任务、附件、归项目、认人">详情</button>
              </div>
              <div className="im-bubble im-bubble-in"><MentionText text={m.text || '（没有正文）'} /></div>
              <AttachmentChips atts={m.attachments} />
              {m.replies.map((r) => (
                <div key={r.id} className={cls('im-bubble im-bubble-out', r.status === 'failed' && 'im-bubble-failed')}>
                  <div><MentionText text={r.text} /></div>
                  <div className="im-bubble-meta">{r.status === 'failed' ? `没发出去：${r.error || '发送失败'}` : `我 · ${timeAgo(r.at)}`}</div>
                </div>
              ))}
            </div>
          )
        })}
      </div>

      <AgentSection msgs={all} onOpenSession={onOpenSession} onOpenTask={onOpenTask} />
      <MaterialSection msgs={all} onOpen={onOpenMaterial} />
    </Drawer>
  )
}
