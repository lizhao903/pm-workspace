// 主动发消息的弹窗（IM 插件 0.17.0，SPEC-messages-8）：消息页标题行「发消息」打开时先选渠道 → 渠道有多个实例时选实例 → 选会话（可搜，群和私聊，
// Slack 还列出账号所在、还没收过消息的频道）→ 写内容 → 发送；群组管理每行「发消息」打开时会话已带上，只写内容。
// 写明以谁的身份发（同回复框，sendAsText）。内容框和回复框同一套 @（0.18.0，MentionBox）：候选是所选会话里发过言的人 + 联系人里
// 在这个渠道有 IM 身份的人；还没收过消息的频道没有候选，手打的 @ 照原样发。主动发消息不默认 @ 谁。不挂在哪条消息的消息列里；发出的（含失败的）记下来，消息页选中这个会话时能看到（SentStrip）。
import { useMemo, useState } from 'react'
import {
  IM_SEND_MAX, errorText, useConnectorDefs, useConnectors, useImConversationSummary, useImConversations, useImMembers, useImSendToConversation,
  type ImOutboxItem,
} from '../../core/data'
import { ConfirmDialog, Field, SearchSelect, cls } from '../../core/ui'
import { imConnectors, sendAsText } from './channelModel'
import { displayName } from './groupAdminModel'
import { channelOf, channelTable } from './model'
import { parseTarget, sendBlocker, sendInput, sendOptions } from './sendModel'
import { MentionBox } from './MentionBox'
import { useMentions } from './useMentions'

const SLACK = 'slack'

export function SendDialog({ conversationId, onCancel, onSent }: {
  /** 从群组管理、会话条打开时带上的会话；不带时自己选 */
  conversationId?: string
  onCancel: () => void
  /** 发出去了：回发件记录和会话名（标题行提示用） */
  onSent: (item: ImOutboxItem, name: string) => void
}) {
  const summary = useImConversationSummary()
  const defs = useConnectorDefs()
  const connectors = useConnectors()
  const send = useImSendToConversation()
  const rows = useMemo(() => summary.data ?? [], [summary.data])
  const preset = conversationId ? rows.find((s) => s.conversation_id === conversationId) : undefined
  const channels = useMemo(() => channelTable(defs.data), [defs.data])
  const conns = useMemo(() => imConnectors(defs.data, connectors.data), [defs.data, connectors.data])
  const tools = [...new Set(conns.map((c) => c.tool))]

  const [pickedChannel, setChannel] = useState('')
  const channel = preset?.channel ?? (pickedChannel || tools[0] || '')
  const instances = conns.filter((c) => c.tool === channel)
  const [pickedConn, setConn] = useState('')
  const conn = instances.find((c) => c.id === pickedConn) ?? instances.find((c) => c.id === preset?.connector_id)
    ?? instances.find((c) => c.status === 'connected') ?? instances[0]
  const extra = useImConversations(conn?.id, channel === SLACK && !preset && !!conn && conn.status !== 'paused' && conn.status !== 'disconnected')
  const options = useMemo(() => sendOptions(rows, extra.data?.items ?? [], channel, conn?.id ?? '', instances.length > 1),
    [rows, extra.data, channel, conn?.id, instances.length])
  const [pickedTarget, setTarget] = useState('')
  const value = preset ? `cv:${preset.conversation_id}` : pickedTarget
  const target = parseTarget(value, options)
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const members = useImMembers(target?.kind === 'cv' ? target.id : null)
  const ment = useMentions(null)

  const blocker = sendBlocker(conn)
  const sendAs = blocker ? null : sendAsText(conn)
  const len = [...text].length
  const name = preset ? displayName(preset) : options.find((o) => o.value === value)?.label ?? ''

  const submit = () => {
    setErr('')
    if (blocker) return
    if (!target) { setErr('先选发到哪个会话'); return }
    if (!text.trim()) { setErr('内容还没写'); return }
    if (len > IM_SEND_MAX) { setErr(`最多 ${IM_SEND_MAX} 字`); return }
    const { text: body, mentions } = ment.compose(text)
    send.mutate(sendInput(target, conn?.id ?? '', body, mentions), {
      onSuccess: (it) => onSent(it, name),
      onError: (e) => setErr(`${errorText(e)}${/发送失败/.test(errorText(e)) ? '（已记下，能在发出的记录里重发）' : ''}`),
    })
  }

  return (
    <ConfirmDialog open title="发消息" busy={send.isPending} confirmLabel={send.isPending ? '正在发…' : '发送'} onConfirm={submit} onCancel={onCancel}>
      <div className="im-send">
        {preset ? (
          <div className="im-send-to">发到 <b>{name}</b><span className="im-muted"> · {channelOf(channels, preset.channel).label}{instances.length > 1 && conn ? ` · ${conn.name}` : ''}</span></div>
        ) : (
          <>
            <Field label="渠道" wrap={false}>
              {tools.length ? (
                <div className="im-seg" role="group" aria-label="渠道">
                  {tools.map((t) => (
                    <button key={t} type="button" className={cls(channel === t && 'on')} aria-pressed={channel === t}
                      onClick={() => { setChannel(t); setConn(''); setTarget('') }}>{channelOf(channels, t).label}</button>
                  ))}
                </div>
              ) : <span className="im-muted">{connectors.isPending ? '正在读渠道' : '还没接入 IM 渠道，先到「渠道配置」里接入'}</span>}
            </Field>
            {instances.length > 1 && (
              <Field label="用哪个账号" wrap={false}>
                <SearchSelect variant="field" value={conn?.id ?? ''} aria-label="用哪个账号" searchPlaceholder="搜账号"
                  options={instances.map((c) => ({ value: c.id, label: c.name, hint: c.account || undefined }))}
                  onChange={(v) => { if (v) { setConn(v); setTarget('') } }} />
              </Field>
            )}
            <Field label="发到哪个会话" wrap={false}
              hint={channel === SLACK ? (extra.isError ? `频道列表没取到（${errorText(extra.error)}），只列收到过消息的会话` : extra.isFetching ? '正在列账号所在的频道…' : '能发给收到过消息的群和私聊，以及账号所在、还没收过消息的频道；不能新开私聊')
                : '能发给收到过消息的群和私聊；不能新开私聊'}>
              <SearchSelect variant="field" value={value} aria-label="发到哪个会话" placeholder="选会话" searchPlaceholder="搜群名、联系人"
                options={options} emptyText={summary.isPending ? '加载中' : '这个渠道下还没有会话'}
                onChange={(v) => setTarget(v)} />
            </Field>
          </>
        )}
        <Field label="内容" wrap={false} hint={len > IM_SEND_MAX ? <span className="im-err">超过 {IM_SEND_MAX} 字</span> : `${len} / ${IM_SEND_MAX}`}>
          <MentionBox value={text} onChange={setText} label="内容" rows={6} textareaClass="textarea" below autoFocus={!!preset}
            members={target?.kind === 'cv' ? members.data : undefined} membersLoading={members.isLoading} onPick={ment.pick}
            placeholder="不挂在哪条消息的消息列里，直接发到会话里；输入 @ 提到会话里的人"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() } }} />
        </Field>
        {sendAs && <div className="im-muted im-send-as">{sendAs}</div>}
        {blocker && conn && <div className="im-err" role="alert">{blocker}</div>}
        {err && <div className="im-err" role="alert">{err}</div>}
      </div>
    </ConfirmDialog>
  )
}
