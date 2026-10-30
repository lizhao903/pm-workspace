// 消息抽屉（SPEC-messages-2）：处理状态条、发信人、会话、附件、转任务、快捷回复和回复框。照原型 web-next/src/messages.tsx MessageDrawer。
// 附件一节是附件面板（SPEC-messages-3，IM-04b）：获取、读内容、加进项目资料。
// 视频插件在跑时多一节「收进素材箱」（VID-08b，ToClipRow）和「转为商单」（VID-08e，ToDealRow）。
// 回复经后端适配器发出：发送失败时回复框保留内容，底部红字说原因，消息状态不变（SPEC-messages-2.25）。
// 发信人对不上联系人时给「关联到联系人」「新建联系人」，认上了的给「不是这个人」（IM-05，弹窗在 ContactLink）。
import { useState } from 'react'
import { errorText, useImAction, type Connector, type ImAction, type ImMessage } from '../../core/data'
import { Avatar, Button, Checkbox, Drawer, cls } from '../../core/ui'
import {
  QUICK_REPLIES, RELEVANCE, isSnoozed, replyBlocker, replyWarning, shortTime, snoozeOptions, timeAgo, whoName, type Channel, type StatusView,
} from './model'
import { AttachmentPanel } from './AttachmentPanel'
import { Caret, ChannelMark, Menu, MentionText } from './parts'
import { ToClipRow } from './ToClipRow'
import { ToDealRow } from './ToDealRow'
import type { ContactLinkMode, ContactLinkResult } from './ContactLink'

export function MessageDrawer({ msg, missing, ch, connectors, sv, photo, note, onClose, onOpenContact, onLinkContact, onToTask, onFixConnector }: {
  /** 还在加载时为 undefined */
  msg: ImMessage | undefined
  /** 取不到（已被清理、撤回） */
  missing: boolean
  ch: Channel
  connectors: Connector[] | undefined
  sv: StatusView
  photo?: string
  /** 刚关联、新建、改挂完的结果 */
  note?: ContactLinkResult
  onClose: () => void
  onOpenContact: (id: string) => void
  /** 打开认人弹窗：关联、新建、改挂或解除 */
  onLinkContact: (mode: ContactLinkMode) => void
  /** 没转过就转，转过就打开那条任务 */
  onToTask: () => void
  onFixConnector: () => void
}) {
  if (missing) {
    return (
      <Drawer open onClose={onClose} kicker="IM 消息" aria-label="消息详情" footer={<Button onClick={onClose}>关闭</Button>}>
        <div className="empty"><div className="empty-title">这条消息已不存在</div></div>
      </Drawer>
    )
  }
  if (!msg) return null
  return (
    <DrawerBody key={msg.id} msg={msg} ch={ch} connectors={connectors} sv={sv} photo={photo} note={note} onClose={onClose}
      onOpenContact={onOpenContact} onLinkContact={onLinkContact} onToTask={onToTask} onFixConnector={onFixConnector} />
  )
}

function DrawerBody({ msg, ch, connectors, sv, photo, note, onClose, onOpenContact, onLinkContact, onToTask, onFixConnector }: {
  msg: ImMessage; ch: Channel; connectors: Connector[] | undefined; sv: StatusView; photo?: string; note?: ContactLinkResult
  onClose: () => void; onOpenContact: (id: string) => void; onLinkContact: (mode: ContactLinkMode) => void; onToTask: () => void; onFixConnector: () => void
}) {
  const act = useImAction()
  const reply = useImAction()
  const [text, setText] = useState('')
  const [alsoDone, setAlsoDone] = useState(true)
  const conn = connectors?.find((c) => c.id === msg.connector_id)
  const blocker = replyBlocker(msg, connectors)
  const warning = replyWarning(msg, connectors)
  const who = whoName(msg)
  const doneLabel = sv.label('done')

  const run = (a: ImAction) => act.mutate({ id: msg.id, action: a })
  const send = (t: string, done: boolean, fromBox: boolean) => {
    const body = t.trim()
    if (!body || blocker || reply.isPending) return
    reply.mutate({ id: msg.id, action: { kind: 'reply', text: body, done } }, { onSuccess: () => { if (fromBox) setText('') } })
  }

  const snoozed = isSnoozed(msg)
  const tone = snoozed ? 'snooze' : msg.status
  const rel = msg.relevance
  const connLabel = msg.connector_id ? (conn?.name ?? '渠道已删除') : (msg.adapter || ch.label)
  const sent = msg.replies.filter((r) => r.status !== 'failed').length

  return (
    <Drawer open onClose={onClose} aria-label="消息详情" className="im-drawer"
      kicker={<span className="im-kicker"><ChannelMark ch={ch} /><span className="ellipsis">{msg.conversation || '私聊'} · {connLabel}</span></span>}
      footer={(
        <div className="im-reply-box">
          <textarea rows={2} value={text} disabled={!!blocker} aria-label="回复内容"
            placeholder={blocker ? '这个会话现在不能回复' : `回复 ${who}，⌘ Enter 发送`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(text, alsoDone, true) } }} />
          {reply.isError && <div className="im-err" role="alert">没发出去：{errorText(reply.error)}</div>}
          <div className="im-reply-bar">
            <Checkbox checked={alsoDone} disabled={!!blocker} onCheckedChange={setAlsoDone}>发送后标为{doneLabel}</Checkbox>
            <span className="spacer" />
            <Button variant="primary" disabled={!!blocker || !text.trim() || reply.isPending} onClick={() => send(text, alsoDone, true)}>
              {reply.isPending ? '发送中…' : '发送'}
            </Button>
          </div>
        </div>
      )}>
      {conn?.status === 'error' && (
        <div className="im-alert">
          <span><b>{conn.name} 连接异常</b>{conn.error}。{conn.last_sync_at && `最后一次同步在 ${timeAgo(conn.last_sync_at)}，之后这个渠道的消息没有收进来，也回复不了。`}</span>
          <button type="button" className="im-act" onClick={onFixConnector}>去修复</button>
        </div>
      )}

      {/* 处理状态是一条细条：左边是现在的状态，右边是能做的操作 */}
      <div className={cls('im-strip', `im-strip-${tone}`)}>
        <span className="im-strip-dot" style={snoozed ? undefined : { background: sv.color(msg.status) }} />
        <b>{snoozed ? '稍后提醒' : sv.label(msg.status)}</b>
        {snoozed && <span className="im-strip-sub">{shortTime(msg.snooze_until!)} 再提醒</span>}
        {rel && rel !== 'dm' && <span className="im-strip-sub">{RELEVANCE[rel]}</span>}
        {sent > 0 && <span className="im-strip-sub">已回复 {sent} 次</span>}
        <span className="spacer" />
        {msg.status === 'pending' ? (
          <>
            <button type="button" className="im-strip-act im-strip-primary" disabled={act.isPending} onClick={() => run({ kind: 'done' })}>标为{doneLabel}</button>
            <Menu className="im-strip-act" label={<>稍后<Caret /></>}>
              {(close) => snoozeOptions().map((o) => (
                <button key={o.label} type="button" role="menuitem" className="menu-item" onClick={() => { run({ kind: 'snooze', until: o.until.toISOString() }); close() }}>{o.label}</button>
              ))}
            </Menu>
            <button type="button" className="im-strip-act" disabled={act.isPending} onClick={() => run({ kind: 'ignore' })}>忽略</button>
          </>
        ) : <button type="button" className="im-strip-act" disabled={act.isPending} onClick={() => run({ kind: 'reopen' })}>重新打开</button>}
      </div>
      {act.isError && <div className="im-err" role="alert">没改成：{errorText(act.error)}</div>}

      <div className="im-sender">
        <Avatar name={who} size={40} src={photo} />
        <div className="im-sender-text">
          <div className="im-sender-name">{who}</div>
          <div className="im-muted im-mono">{ch.label} · {msg.sender_id}</div>
        </div>
        <span className="spacer" />
        {msg.stakeholder_id ? (
          <div className="im-sender-acts">
            <Button onClick={() => onOpenContact(msg.stakeholder_id!)}>查看联系人</Button>
            <button type="button" className="im-act im-act-quiet" title="认错人了：改挂到别人，或解除关联" onClick={() => onLinkContact('fix')}>不是这个人</button>
          </div>
        ) : (
          <div className="im-sender-acts">
            <Button variant="outline" onClick={() => onLinkContact('link')} title={`把 ${ch.label} 编号 ${msg.sender_id} 挂到已有联系人名下`}>关联到联系人</Button>
            <Button onClick={() => onLinkContact('create')} title="就地新建，姓名预填发信人名字">新建联系人</Button>
          </div>
        )}
      </div>
      {note && (
        <div className="im-link-note" role="status">
          <span>{note.text}</span>
          {note.created && note.contactId && <button type="button" className="im-act" onClick={() => onOpenContact(note.contactId!)}>去联系人页补全</button>}
        </div>
      )}

      <div className="im-thread">
        <div className="im-bubble im-bubble-in">
          <div><MentionText text={msg.text} /></div>
          <div className="im-bubble-meta">{shortTime(msg.at)}</div>
        </div>
        {msg.replies.map((r) => (
          <div key={r.id} className={cls('im-bubble im-bubble-out', r.status === 'failed' && 'im-bubble-failed')}>
            <div>{r.text}</div>
            <div className="im-bubble-meta">{r.status === 'failed' ? `没发出去：${r.error || '发送失败'}` : `我 · ${timeAgo(r.at)}`}</div>
          </div>
        ))}
      </div>

      <AttachmentPanel msg={msg} />

      <div className="im-section">转任务</div>
      {msg.task_id ? (
        <div className="im-act-row"><span className="im-muted">已转为任务 {msg.task_ref}</span><button type="button" className="im-act" onClick={onToTask}>打开任务</button></div>
      ) : (
        <div className="im-act-row"><button type="button" className="im-act" onClick={onToTask}>转为任务</button><span className="im-muted">原消息会记在任务里，方便回看</span></div>
      )}

      <ToClipRow msg={msg} who={who} source={`${ch.label} · ${msg.conversation || '私聊'}`} />
      <ToDealRow msg={msg} />

      <div className="im-section">反馈</div>
      {warning && !blocker && <div className="im-banner-warn">{warning}</div>}
      {blocker ? (
        <div className="im-banner-warn">{blocker}</div>
      ) : (
        <div className="im-quick">
          {QUICK_REPLIES.map((qr) => (
            <button key={qr.text} type="button" className="im-qr" disabled={reply.isPending} onClick={() => send(qr.text, qr.done, false)}
              title={qr.done ? `发送并标为${doneLabel}` : '发送'}>
              {qr.text}{qr.done && <span className="im-qr-done">并处理</span>}
            </button>
          ))}
        </div>
      )}
    </Drawer>
  )
}
