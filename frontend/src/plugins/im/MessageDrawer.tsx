// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 消息抽屉（SPEC-messages-2）：处理状态条、发信人、会话、附件、转任务、快捷回复和回复框。照原型 web-next/src/messages.tsx MessageDrawer。
// 附件一节是附件面板（SPEC-messages-3，IM-04b）：获取、读内容、加进项目资料。
// 视频插件在跑时多一节「收进素材箱」（VID-08b，ToClipRow）和「转为商单」（VID-08e，ToDealRow）。
// 回复经后端适配器发出：发送失败时回复框保留内容，底部红字说原因，消息状态不变（SPEC-messages-2.25）。
// 发信人对不上联系人时给「关联到联系人」「新建联系人」，认上了的给「不是这个人」（IM-05，弹窗在 ContactLink）。
// 发信人处另有「自动忽略」（TSK-0495）；被自动忽略的消息状态条写「因发信人 X 被设为自动忽略」。
// Slack 的回复框写明以谁的身份发出（IM-06）：我本人身份「以 <本人名> 身份发送」，Bot 身份「以 Bot <名> 发送」。
// 已过期（IM-07）的状态条写何时标的，给「标为已处理」「重新打开」「忽略」；不能稍后。
// 「项目」一节（消息分流）：显示归到的项目，能改、能清除；分流流程的 im_set_project 节点也改这一项。
// 消息自己没归、按群组默认项目兜底的（project_source=conversation）不给清除：清除只清消息上单设的那一项。
// 拆分任务、发起会话、转项目资料在底部发送按钮那一行（ReplyBarActions）；
// 「交给 Agent」「项目资料」两节只列发起过的会话、拆出来的任务、转过的资料，能点过去，没有时不显示。
// 「分诊建议」一节（SOP 插件在跑时才有）放在正文下面，由消息页传进来（TriageAdvice 的 TriageSection）。
// 回复框带 @（0.18.0，MentionBox）：群聊回复底部有「回复时 @ 对方」开关（默认打开、记在本机，快捷回复也跟着它），
// 输入 @ 弹出联系人和会话里发过言的人；私聊没有开关、不加 @。工作台里显示自己发出的回复仍是「@名字」。
// 消息列回复（0010）：消息列回复的抽屉在正文上面写「回复 谁：原消息」，能打开原消息；原消息的抽屉在正文下面按时间列出整个消息列，
// 每条能单独标已处理、忽略、重新打开，点开看那一条（列表上不列这些回复，只在原消息行上标未读数，详情都在这里看）；
// 也能整列处理、勾选批量处理、连原消息一起（SPEC-messages-2.51，ThreadReplies）。回复框回消息列里的消息时发到同一个消息列（后端带父消息的 thread_ts）。
import { useState, type ReactNode } from 'react'
import { errorText, useImAction, useImMembers, useProjects, type Connector, type ImAction, type ImMessage, type ImSessionIntent } from '../../core/data'
import { Avatar, Button, Checkbox, Drawer, SearchSelect, cls } from '../../core/ui'
import {
  RELEVANCE, isSnoozed, replyBlocker, replyWarning, shortTime, snoozeOptions, timeAgo, whoName, type Channel, type StatusView,
} from './model'
import { AgentSection, ReplyBarActions } from './AgentLinks'
import { AttachmentPanel } from './AttachmentPanel'
import { MaterialSection } from './MaterialLinks'
import { sendAsText } from './channelModel'
import { Caret, ChannelMark, Menu, MentionText } from './parts'
import { useQuickReplies } from './quickReplies'
import { ToClipRow } from './ToClipRow'
import { ToDealRow } from './ToDealRow'
import { ThreadReplies } from './ThreadReplies'
import type { ContactLinkMode, ContactLinkResult } from './ContactLink'
import { LinkNote, SenderContactActs } from './SenderContact'
import { threadHint } from './groupModel'
import { MentionBox } from './MentionBox'
import { defaultMention } from './mentionModel'
import { useMentions } from './useMentions'
import { muteReason } from './muteModel'

type AgentProps = {
  /** 带上这条消息发起会话、拆分任务 */
  onStart: (intent: ImSessionIntent) => void
  onOpenSession: (id: string) => void
  onOpenTask: (id: string) => void
  /** 转项目资料（0009）：打开弹窗；转过的资料点过去 */
  onToMaterial: () => void
  onOpenMaterial: (projectId: string, materialId: string) => void
  /** 这条作为原消息时整个消息列的回复（按时间正序）；不是原消息为空 */
  thread?: ImMessage[]
  /** 这条是消息列回复时，它的原消息（收到了的才有） */
  threadParent?: ImMessage
  /** 打开另一条消息（原消息、消息列里的某一条） */
  onOpenMessage?: (id: string) => void
}

export function MessageDrawer({ msg, missing, ch, connectors, sv, photo, note, triage, onClose, onOpenContact, onLinkContact, onToTask, onFixConnector, ...agent }: AgentProps & {
  /** 「分诊建议」一节；SOP 插件没在跑时不传 */
  triage?: ReactNode
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
    <DrawerBody key={msg.id} msg={msg} ch={ch} connectors={connectors} sv={sv} photo={photo} note={note} triage={triage} onClose={onClose}
      onOpenContact={onOpenContact} onLinkContact={onLinkContact} onToTask={onToTask} onFixConnector={onFixConnector} {...agent} />
  )
}

function DrawerBody({ msg, ch, connectors, sv, photo, note, triage, onClose, onOpenContact, onLinkContact, onToTask, onFixConnector, onStart, onOpenSession, onOpenTask, onToMaterial, onOpenMaterial, thread = [], threadParent, onOpenMessage }: AgentProps & {
  msg: ImMessage; ch: Channel; connectors: Connector[] | undefined; sv: StatusView; photo?: string; note?: ContactLinkResult; triage?: ReactNode
  onClose: () => void; onOpenContact: (id: string) => void; onLinkContact: (mode: ContactLinkMode) => void; onToTask: () => void; onFixConnector: () => void
}) {
  const act = useImAction()
  const reply = useImAction()
  const setProject = useImAction()
  const projects = useProjects()
  const projectOptions = (projects.data?.data ?? []).filter((p) => !p.deleted_at).map((p) => ({ value: p.id, label: p.title }))
  const [text, setText] = useState('')
  const [alsoDone, setAlsoDone] = useState(true)
  const [muteNote, setMuteNote] = useState('')
  const conn = connectors?.find((c) => c.id === msg.connector_id)
  const blocker = replyBlocker(msg, connectors)
  const warning = replyWarning(msg, connectors)
  const who = whoName(msg)
  const doneLabel = sv.label('done')
  const quick = useQuickReplies()
  const sendAs = blocker ? null : sendAsText(conn)
  const members = useImMembers(blocker ? null : msg.conversation_id)
  const ment = useMentions(defaultMention(msg))

  const run = (a: ImAction) => act.mutate({ id: msg.id, action: a })
  const send = (t: string, done: boolean, fromBox: boolean) => {
    if (!t.trim() || blocker || reply.isPending) return
    const { text: body, mentions } = ment.compose(t)
    reply.mutate({ id: msg.id, action: { kind: 'reply', text: body, done, mentions } }, {
      onSuccess: () => { if (fromBox) { setText(''); ment.clear() } },
    })
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
          <MentionBox value={text} onChange={setText} disabled={!!blocker} label="回复内容"
            members={members.data} membersLoading={members.isLoading} onPick={ment.pick}
            placeholder={blocker ? '这个会话现在不能回复' : `回复 ${who}${msg.thread ? '（发到同一个消息列）' : ''}，输入 @ 提到别人，⌘ Enter 发送`}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(text, alsoDone, true) } }} />
          {reply.isError && <div className="im-err" role="alert">没发出去：{errorText(reply.error)}</div>}
          <div className="im-reply-bar">
            <Checkbox checked={alsoDone} disabled={!!blocker} onCheckedChange={setAlsoDone}>发送后标为{doneLabel}</Checkbox>
            {ment.toggle && (
              <span title={`发送时在正文开头 @${ment.toggle.name}，对方会收到通知`}>
                <Checkbox checked={ment.on} disabled={!!blocker} onCheckedChange={ment.setOn}>回复时 @ 对方</Checkbox>
              </span>
            )}
            <span className="spacer" />
            <ReplyBarActions many={false} onStart={onStart} onToMaterial={onToMaterial} />
            {sendAs && <span className="im-muted im-send-as">{sendAs}</span>}
            <Button variant="primary" disabled={!!blocker || !text.trim() || reply.isPending} title={sendAs ?? undefined}
              onClick={() => send(text, alsoDone, true)}>
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
        {msg.status === 'expired' && msg.expired_at && <span className="im-strip-sub">{shortTime(msg.expired_at)} 超期没处理</span>}
        {rel && rel !== 'dm' && <span className="im-strip-sub">{RELEVANCE[rel]}</span>}
        {sent > 0 && <span className="im-strip-sub">已回复 {sent} 次</span>}
        {msg.muted && <span className="im-strip-sub im-strip-muted">{muteReason(msg)}</span>}
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
        ) : msg.status === 'expired' ? (
          <>
            <button type="button" className="im-strip-act im-strip-primary" disabled={act.isPending} onClick={() => run({ kind: 'done' })}>标为{doneLabel}</button>
            <button type="button" className="im-strip-act" disabled={act.isPending} onClick={() => run({ kind: 'reopen' })}>重新打开</button>
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
        <SenderContactActs msg={msg} chLabel={ch.label} onOpenContact={onOpenContact} onLinkContact={onLinkContact} onMuted={setMuteNote} />
      </div>
      {note && <LinkNote note={note} onOpenContact={onOpenContact} />}
      {muteNote && <div className="im-link-note" role="status"><span>{muteNote}</span></div>}

      {msg.thread && (
        <div className="im-thread-from">
          <span className="im-thread-tag">消息列回复</span>
          <span className="im-muted ellipsis">{threadHint(msg, threadParent)}</span>
          {threadParent && onOpenMessage && <button type="button" className="im-act" onClick={() => onOpenMessage(threadParent.id)}>打开原消息</button>}
        </div>
      )}
      <div className="im-thread">
        <div className="im-bubble im-bubble-in">
          <div><MentionText text={msg.text} /></div>
          <div className="im-bubble-meta">{shortTime(msg.at)}</div>
        </div>
        {msg.replies.map((r) => (
          <div key={r.id} className={cls('im-bubble im-bubble-out', r.status === 'failed' && 'im-bubble-failed')}>
            <div><MentionText text={r.text} /></div>
            <div className="im-bubble-meta">{r.status === 'failed' ? `没发出去：${r.error || '发送失败'}` : `我 · ${timeAgo(r.at)}`}</div>
          </div>
        ))}
      </div>

      {thread.length > 0 && <ThreadReplies parent={msg} replies={thread} sv={sv} onOpen={onOpenMessage} />}

      {triage}

      <AttachmentPanel msg={msg} />

      <div className="im-section">项目</div>
      <div className="im-act-row">
        <SearchSelect value={msg.project_id ?? ''} options={projectOptions} noneLabel="不归项目" placeholder="归到项目" searchPlaceholder="搜项目"
          aria-label="归到项目" missingLabel={() => msg.project_name || '已删除的项目'} disabled={setProject.isPending}
          emptyText={projects.isError ? '项目没加载出来' : projects.isPending ? '加载中' : '还没有项目'}
          onChange={(v) => setProject.mutate({ id: msg.id, action: { kind: 'project', project_id: v || null } })} />
        {msg.project_id && msg.project_source !== 'conversation' && (
          <button type="button" className="im-act" disabled={setProject.isPending} title="清除后按群组默认归属的项目算（没设就不归项目）"
            onClick={() => setProject.mutate({ id: msg.id, action: { kind: 'project', project_id: null } })}>清除</button>
        )}
        <span className="im-muted">{msg.project_source === 'conversation' ? '按群组默认归属；在这里改只改这一条'
          : msg.project_id ? '项目「沟通」里能看到这条' : '归到项目后，项目「沟通」里能看到这条'}</span>
      </div>
      {setProject.isError && <div className="im-err" role="alert">没改成：{errorText(setProject.error)}</div>}

      <div className="im-section">转任务</div>
      {msg.task_id ? (
        <div className="im-act-row"><span className="im-muted">已转为任务 {msg.task_ref}</span><button type="button" className="im-act" onClick={onToTask}>打开任务</button></div>
      ) : (
        <div className="im-act-row"><button type="button" className="im-act" onClick={onToTask}>转为任务</button><span className="im-muted">原消息会记在任务里，方便回看</span></div>
      )}

      <AgentSection msgs={[msg]} onOpenSession={onOpenSession} onOpenTask={onOpenTask} />
      <MaterialSection msgs={[msg]} onOpen={onOpenMaterial} />

      <ToClipRow msg={msg} who={who} source={`${ch.label} · ${msg.conversation || '私聊'}`} />
      <ToDealRow msg={msg} />

      <div className="im-section">反馈</div>
      {warning && !blocker && <div className="im-banner-warn">{warning}</div>}
      {blocker ? (
        <div className="im-banner-warn">{blocker}</div>
      ) : (
        <div className="im-quick">
          {!quick.length && <span className="im-muted">没有快捷回复，到「渠道配置」里添加</span>}
          {quick.map((qr) => (
            <button key={qr.text} type="button" className="im-qr" disabled={reply.isPending} onClick={() => send(qr.text, qr.done, false)}
              title={`${ment.tag ? `@${ment.tag.name} ` : ''}${qr.done ? `发送并标为${doneLabel}` : '发送'}`}>
              {qr.text}{qr.done && <span className="im-qr-done">并处理</span>}
            </button>
          ))}
        </div>
      )}
    </Drawer>
  )
}
