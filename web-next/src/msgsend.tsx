// 主动发消息（SPEC-messages-8）：标题行「发消息」弹窗（选渠道 → 多实例选账号 → 选会话 → 写内容 → 发送）、群组管理每行「发消息」（会话带上）、
// 选中会话时列表上方的「发消息」「我发出的 N 条」（失败的能重发），消息行上的「回复了我发出的」。
// 内容框同回复框一样能 @（SPEC-messages-8.9，mention.tsx）：候选是所选会话的人（联系人在前），不默认 @ 谁。
// 原型的发件记录存在消息页的本地状态（刷新就没了），发送按连接器状态模拟：暂停、断开、只收的拦下，其余算发出。
// 正式产品见 frontend/src/plugins/im/SendDialog.tsx、SentStrip.tsx、sendModel.ts；后端 IM 插件 0.17.0（POST /api/im/send、GET /api/im/conversations/{id}/sent）。
import { useMemo, useState } from 'react'
import { IM_CHANNELS, sendAsText, type Connector, type Contact, type Message } from './data'
import { SearchSelect, type SearchOption } from './searchselect'
import { cls, timeAgo } from './ui'
import { MentionBox, composeReply, mentionMembers, type MentionPick } from './mention'

/** 发出的一条：key 是会话键（同 messages.tsx convKey），source manual 手动、sop 流程发的 */
export type Sent = { id: string; key: string; channel: string; connector_id: string; name: string; text: string; status: 'sent' | 'failed'; error: string; at: string; source: 'manual' | 'sop' }

const keyOf = (m: Message) => (m.conversation ? `g:${m.channel}|${m.conversation}` : `d:${m.channel}:${m.sender_id}`)
export const SEND_MAX = 4000

/** 发不了的原因（同回复） */
export function sendBlocker(c: Connector | undefined): string | null {
  if (!c) return '先选渠道'
  if (c.status === 'paused') return `连接器「${c.name}」已暂停`
  if (c.status === 'disconnected') return `连接器「${c.name}」已断开，去设置里重新连接`
  if (c.status === 'connecting') return `连接器「${c.name}」正在连接`
  if (c.direction === 'receive') return `连接器「${c.name}」设置为只收消息`
  return null
}

/** 来信对上我发出的：发件之后同会话第一条来信（会话键 -> 按时间排好的发件） */
export function sentReplyOf(messages: Message[], sent: Sent[]): Map<string, Sent> {
  const out = new Map<string, Sent>()
  for (const s of sent.filter((x) => x.status === 'sent')) {
    const first = messages.filter((m) => keyOf(m) === s.key && m.at >= s.at).sort((a, b) => a.at.localeCompare(b.at))[0]
    if (first && !out.has(first.id)) out.set(first.id, s)
  }
  return out
}

type Target = { key: string; name: string; channel: string }

export function SendDialog({ messages, contacts, connectors, preset, onCancel, onSend }: {
  messages: Message[]; contacts: Contact[]; connectors: Connector[]
  /** 从群组管理、会话条打开时带上的会话键 */
  preset?: string
  onCancel: () => void
  /** 发：会话、用的连接器、内容（发不了的已在弹窗里拦下） */
  onSend: (t: Target, connector: Connector, text: string) => void
}) {
  const ims = connectors.filter((c) => IM_CHANNELS.some((ch) => ch.key === c.tool))
  const tools = [...new Set(ims.map((c) => c.tool))]
  const presetMsg = preset ? messages.find((m) => keyOf(m) === preset) : undefined
  const [pickedTool, setTool] = useState('')
  const tool = presetMsg?.channel ?? (pickedTool || tools[0] || '')
  const instances = ims.filter((c) => c.tool === tool)
  const [pickedConn, setConn] = useState('')
  const conn = instances.find((c) => c.id === pickedConn) ?? instances.find((c) => c.id === presetMsg?.connector_id) ?? instances.find((c) => c.status === 'connected') ?? instances[0]
  const who = (m: Message) => contacts.find((c) => c.im[m.channel] === m.sender_id)?.name || m.sender_name
  // 能发的：这个渠道（多实例时这个账号）收到过消息的群和私聊 + Slack 监听频道里还没收过消息的
  const options = useMemo(() => {
    const seen = new Map<string, SearchOption & { at: string }>()
    for (const m of [...messages].sort((a, b) => b.at.localeCompare(a.at))) {
      if (m.channel !== tool || (instances.length > 1 && conn && m.connector_id !== conn.id)) continue
      const k = keyOf(m)
      if (!seen.has(k)) seen.set(k, { value: k, label: m.conversation || who(m), group: m.conversation ? '群聊' : '私聊', hint: timeAgo(m.at), at: m.at })
    }
    const list = [...seen.values()].sort((a, b) => (a.group === b.group ? b.at.localeCompare(a.at) : a.group === '群聊' ? -1 : 1))
    const fresh = tool === 'slack' && conn ? (conn.config.channels ?? '').split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean)
      .map((x) => (x.startsWith('#') ? x : `#${x}`)).filter((x) => !seen.has(`g:${tool}|${x}`))
      .map((x) => ({ value: `g:${tool}|${x}`, label: x, group: '还没收过消息的频道', hint: '频道', at: '' })) : []
    return [...list, ...fresh]
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, contacts, tool, conn?.id, instances.length])
  const [pickedKey, setKey] = useState('')
  const key = preset ?? pickedKey
  const name = presetMsg ? (presetMsg.conversation || who(presetMsg)) : options.find((o) => o.value === key)?.label ?? ''
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const [picked, setPicked] = useState<MentionPick[]>([])
  // 所选会话的 @ 候选：群按群名，私聊按发信人（keyOf 同一套）
  const members = key ? mentionMembers(messages, contacts, tool, (m) => keyOf(m) === key) : []
  const blocker = sendBlocker(conn)
  const sendAs = blocker ? null : sendAsText(conn)
  const len = [...text].length
  const submit = () => {
    setErr('')
    if (blocker || !conn) return
    if (!key) { setErr('先选发到哪个会话'); return }
    if (!text.trim()) { setErr('内容还没写'); return }
    if (len > SEND_MAX) { setErr(`最多 ${SEND_MAX} 字`); return }
    onSend({ key, name, channel: tool }, conn, composeReply(text, null, picked).text)
  }
  return (
    <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="qs msg-start" role="dialog" aria-label="发消息">
        <div className="qs-head"><b>发消息</b></div>
        {preset ? (
          <div>发到 <b>{name}</b><span className="muted"> · {IM_CHANNELS.find((c) => c.key === tool)?.label}{instances.length > 1 && conn ? ` · ${conn.name}` : ''}</span></div>
        ) : (
          <>
            <label className="msg-start-field"><span className="list-sub">渠道</span>
              {tools.length ? (
                <div className="seg" style={{ alignSelf: 'flex-start' }}>
                  {tools.map((t) => <button key={t} className={cls(tool === t && 'on')} onClick={() => { setTool(t); setConn(''); setKey('') }}>{IM_CHANNELS.find((c) => c.key === t)?.label ?? t}</button>)}
                </div>
              ) : <span className="muted">还没接入 IM 渠道，先到「渠道配置」里接入</span>}
            </label>
            {instances.length > 1 && (
              <label className="msg-start-field"><span className="list-sub">用哪个账号</span>
                <SearchSelect value={conn?.id ?? ''} onChange={(v) => { if (v) { setConn(v); setKey('') } }} searchPlaceholder="搜账号" aria-label="用哪个账号"
                  options={instances.map((c) => ({ value: c.id, label: c.name, hint: c.account }))} />
              </label>
            )}
            <label className="msg-start-field"><span className="list-sub">发到哪个会话（能发给收到过消息的群和私聊{tool === 'slack' ? '，以及监听频道里还没收过消息的' : ''}；不能新开私聊）</span>
              <SearchSelect value={key} onChange={setKey} placeholder="选会话" searchPlaceholder="搜群名、联系人" aria-label="发到哪个会话" options={options} emptyText="这个渠道下还没有会话" />
            </label>
          </>
        )}
        <label className="msg-start-field"><span className="list-sub">内容 {len} / {SEND_MAX}</span>
          <MentionBox className="input" rows={6} value={text} onChange={setText} onPick={(p) => setPicked((x) => [...x, p])} members={members} below label="内容"
            placeholder="不串在哪条消息下面，直接发到会话里；输入 @ 提到会话里的人"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() } }} />
        </label>
        {sendAs && <div className="muted">{sendAs}</div>}
        {blocker && conn && <div className="danger-text">{blocker}</div>}
        {err && <div className="danger-text">{err}</div>}
        <div className="act-row">
          <span className="spacer" />
          <button className="act act-quiet" onClick={onCancel}>取消</button>
          <button className="act act-primary" disabled={!!blocker} onClick={submit}>发送</button>
        </div>
      </div>
    </div>
  )
}

/** 选中会话时列表上方：「发消息」「我发出的 N 条」，点开列出来，失败的能重发 */
export function SentStrip({ sent, onSend, onResend }: { sent: Sent[]; onSend: () => void; onResend: (s: Sent) => void }) {
  const [open, setOpen] = useState(false)
  const list = [...sent].sort((a, b) => b.at.localeCompare(a.at))
  return (
    <div className="msg-group-bar sent-strip">
      <button className="btn btn-outline" onClick={onSend} title="直接发到这个会话，不串在哪条消息下面">发消息</button>
      {list.length > 0 && <button className={cls('btn btn-ghost', open && 'on')} onClick={() => setOpen(!open)}>我发出的 {list.length} 条{list.some((x) => x.status === 'failed') && <span className="danger-text">（有失败）</span>}</button>}
      {open && list.length > 0 && (
        <div className="sent-list">
          {list.map((s) => (
            <div key={s.id} className="sent-row">
              <span className="muted">{timeAgo(s.at)}</span>
              {s.source === 'sop' && <span className="state">SOP</span>}
              <span className="sent-text" title={s.text}>{s.text}</span>
              {s.status === 'failed'
                ? <><span className="danger-text" title={s.error}>发送失败</span><button className="act" onClick={() => onResend(s)}>重发</button></>
                : <span className="muted">已发出</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
