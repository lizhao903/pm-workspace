// 「我发出的」（IM 插件 0.17.0，SPEC-messages-1.62）：消息页选中一个会话时，列表上方会话条里一段：「发消息」+「我发出的 N 条」，
// 点开列出这个会话主动发出的消息（新的在前，含失败的、SOP 发的），失败的能「重发」（照原内容、原账号再发一条，原来那条留着）。
// 和同一行的「这个会话全部标为已处理」「默认归属」放在一起，都是对这个会话的操作。
// SentReplyTag 是消息行上的「回复了我发出的」：对方在我发出的那条的消息列里回复，或我发出后同会话第一条来信。
import { useState } from 'react'
import { errorText, useImSendToConversation, useImSent, type ImMessage } from '../../core/data'
import { cls } from '../../core/ui'
import { sentReplyTitle } from './sendModel'
import { timeAgo } from './model'

export function SentStrip({ conversationId, onSend }: { conversationId: string; onSend: () => void }) {
  const sent = useImSent(conversationId)
  const resend = useImSendToConversation()
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState('')
  const list = sent.data ?? []
  return (
    <div className="im-sent">
      <button type="button" className="btn btn-sm btn-outline" onClick={onSend} title="直接发到这个会话，不挂在哪条消息的消息列里">发消息</button>
      {list.length > 0 && (
        <button type="button" className={cls('btn btn-sm btn-ghost', open && 'on')} aria-expanded={open} onClick={() => setOpen(!open)}>
          我发出的 {list.length} 条{list.some((x) => x.status === 'failed') && <span className="im-sent-bad">有失败</span>}
        </button>
      )}
      {sent.isError && <span className="im-err">发出的记录没取到：{errorText(sent.error)}</span>}
      {open && list.length > 0 && (
        <div className="im-sent-list" role="list" aria-label="我发出的">
          {list.map((it) => (
            <div key={it.id} role="listitem" className={cls('im-sent-row', it.status === 'failed' && 'bad')}>
              <span className="im-sent-time" title={new Date(it.created_at).toLocaleString('zh-CN')}>{timeAgo(it.created_at)}</span>
              {it.source === 'sop' && <span className="im-state" title="SOP 节点「发消息」发的">SOP</span>}
              <span className="im-sent-text" title={it.text}>{it.text}</span>
              {it.status === 'failed' ? (
                <>
                  <span className="im-err" title={it.error}>发送失败</span>
                  <button type="button" className="im-act" disabled={resend.isPending}
                    onClick={() => { setErr(''); resend.mutate({ conversation_id: it.conversation_id, connector_id: it.connector_id || undefined, text: it.text }, { onError: (e) => setErr(`没重发成：${errorText(e)}`) }) }}>重发</button>
                </>
              ) : <span className="im-muted">已发出</span>}
            </div>
          ))}
          {err && <div className="im-err" role="alert">{err}</div>}
        </div>
      )}
    </div>
  )
}

/** 消息行上的「回复了我发出的」，悬停说明是哪条 */
export function SentReplyTag({ msgs }: { msgs: readonly ImMessage[] }) {
  const m = msgs.find((x) => x.replied_sent)
  if (!m) return null
  return <span className="im-state im-sent-tag" title={sentReplyTitle(m)}>回复了我发出的</span>
}
