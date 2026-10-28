// 对话面板（SPEC-sessions-1.14 到 1.20、1.26、1.31）：历史消息加正在进行的这一轮，输入框，示例问题，
// Agent 的提问显示成选项按钮，点选后作为一条普通消息发出（契约「Agent 对话」的 question 事件）。
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAgentMessages, type AgentProvider, type AgentSession } from '../../core/data'
import { Avatar, Button, ErrorState, LoadingState, cls } from '../../core/ui'
import { CallCard } from './CallCard'
import { dismissChat, sendChat, useLiveChat } from './chatLive'
import { CHAT_EXAMPLES, NEW_TITLE, answerText, avatarName, foldHistory, foldLive, titleFrom, type ChatMsgView, type QuestionView } from './chatModel'

function QuestionCard({ q, active, onAnswer }: { q: QuestionView; active: boolean; onAnswer: (labels: string[]) => void }) {
  const [picked, setPicked] = useState<string[]>([])
  const toggle = (l: string) => setPicked((p) => (p.includes(l) ? p.filter((x) => x !== l) : [...p, l]))
  return (
    <div className={cls('ai-question', !active && 'answered')} role="group" aria-label={q.question}>
      <div className="ai-question-title">{q.question}{q.multi && <span className="ai-question-multi">可多选</span>}</div>
      <div className="ai-question-opts">
        {q.options.map((o) => (
          <button key={o.label} type="button" className={cls('ai-option', picked.includes(o.label) && 'on')} disabled={!active}
            aria-pressed={q.multi ? picked.includes(o.label) : undefined}
            onClick={() => (q.multi ? toggle(o.label) : onAnswer([o.label]))}>
            <span className="ai-option-label">{o.label}</span>
            {o.detail && <span className="ai-option-detail">{o.detail}</span>}
          </button>
        ))}
      </div>
      {q.multi && active && (
        <div className="act-row">
          <Button size="sm" variant="primary" disabled={!picked.length} onClick={() => onAnswer(picked)}>发送所选</Button>
        </div>
      )}
    </div>
  )
}

function AgentBubble({ m, avatar, children }: { m: ChatMsgView; avatar: string; children?: ReactNode }) {
  return (
    <div className="ai-msg ai-ai" data-role="agent">
      <Avatar name={avatar} size={24} />
      <div className="ai-bubble">
        {m.calls.length > 0 && <div className="call-list">{m.calls.map((c, i) => <CallCard key={i} call={c} />)}</div>}
        {m.text && <div className="pre-line">{m.text}</div>}
        {m.files && m.files.length > 0 && (
          <ul className="ai-files">{m.files.map((f) => <li key={f.path}>写出文件 <code>{f.path}</code></li>)}</ul>
        )}
        {children}
      </div>
    </div>
  )
}

export function ChatPane({ session, provider, head, autoSend, onRetitle }: {
  session: AgentSession
  /** 会话用的服务商；undefined 表示已删除 */
  provider: AgentProvider | undefined
  head?: ReactNode
  /** 刚建的空会话自动发出去的第一句话，只发一次 */
  autoSend?: string
  /** 第一句话发出时改标题 */
  onRetitle: (title: string) => void
}) {
  const msgs = useAgentMessages(session.id)
  const liveRaw = useLiveChat(session.id)
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  const agentName = provider?.name || '已删除的服务商'
  const avatar = avatarName(provider)
  // 服务商停用、删除后只能回看：按钮、⌘Enter、示例问题、提问选项都从 send 拦
  const usable = !!provider?.enabled
  const note = !provider ? '这个服务商已删除，只能回看' : !provider.enabled ? '这个服务商已停用，只能回看' : undefined
  const busy = liveRaw?.phase === 'streaming'

  const history = useMemo(() => foldHistory(msgs.data ?? []), [msgs.data])
  // 收尾后消息读回来、这一轮还没收起的那一下，以读回的为准，不重复显示
  const doneId = liveRaw?.events.find((e) => e.type === 'done')?.message_id
  const live = doneId && history.some((m) => m.id === doneId) ? undefined : liveRaw
  const liveMsg = useMemo(() => (live ? foldLive(live.events) : null), [live])
  const last = history[history.length - 1]
  // 失败的这一轮里人说的话后端已经落库了（先存用户消息再跑模型），读回来就不再重复显示
  const liveUserSaved = !!live && live.phase !== 'streaming' && last?.role === 'user' && last.text === live.text

  const send = (t: string) => {
    const msg = t.trim()
    if (!msg || busy || !usable) return false
    if (session.title === NEW_TITLE && !session.message_count && !history.length) onRetitle(titleFrom(msg))
    dismissChat(session.id)
    return sendChat(session.id, msg)
  }
  const submit = () => {
    if (send(text)) setText('')
  }

  // 只发一次：StrictMode 下 effect 跑两遍，ref 挡住第二遍；已经有消息了也不发
  const autoSent = useRef(false)
  useEffect(() => {
    if (!autoSend || autoSent.current || !msgs.isSuccess) return
    autoSent.current = true
    if (!msgs.data.length) send(autoSend)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSend, msgs.isSuccess])

  const scrollKey = `${history.length}:${live?.events.length ?? -1}:${live?.phase ?? ''}`
  useLayoutEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [scrollKey])

  // 只有最后一条、而且后面没人回话的提问能点
  const canAnswer = usable && !busy
  const questionLive = !!liveMsg?.question && live?.phase === 'done'
  const answer = (labels: string[]) => send(answerText(labels))

  let body: ReactNode
  if (msgs.isPending) body = <LoadingState />
  else if (msgs.isError) body = <ErrorState title="消息加载失败" error={msgs.error} onRetry={() => void msgs.refetch()} compact />
  else {
    body = (
      <>
        {!history.length && !live && (
          <div className="ai-examples">
            <div className="ai-examples-title">试着问它</div>
            {CHAT_EXAMPLES.map((e) => <button key={e} type="button" className="ai-example" disabled={!usable} onClick={() => send(e)}>{e}</button>)}
          </div>
        )}
        {history.map((m, i) => (m.role === 'user'
          ? <div key={m.id} className="ai-msg ai-user" data-role="user"><div className="ai-bubble">{m.text}</div></div>
          : (
            <AgentBubble key={m.id} m={m} avatar={avatar}>
              {m.question && (
                <QuestionCard q={m.question} active={canAnswer && !live && i === history.length - 1} onAnswer={answer} />
              )}
            </AgentBubble>
          )))}
        {live && !liveUserSaved && <div className="ai-msg ai-user" data-role="user"><div className="ai-bubble">{live.text}</div></div>}
        {live && liveMsg && (liveMsg.text || liveMsg.calls.length || liveMsg.question || liveMsg.files) ? (
          <AgentBubble m={liveMsg} avatar={avatar}>
            {liveMsg.question && <QuestionCard q={liveMsg.question} active={canAnswer && questionLive} onAnswer={answer} />}
          </AgentBubble>
        ) : null}
        {busy && !liveMsg?.text && (
          <div className="ai-msg ai-ai"><Avatar name={avatar} size={24} />
            <div className="ai-bubble ai-typing" role="status" aria-label="正在输入"><span /><span /><span /></div>
          </div>
        )}
        {live?.phase === 'failed' && (
          <div className="ai-msg ai-ai"><Avatar name={avatar} size={24} />
            <div className="ai-bubble ai-failed" role="alert">
              <div>回复失败：{live.error}</div>
              <div className="act-row">
                <Button size="sm" variant="outline" disabled={!usable} onClick={() => send(live.text)}>重试</Button>
                <Button size="sm" onClick={() => dismissChat(session.id)}>收起</Button>
              </div>
            </div>
          </div>
        )}
      </>
    )
  }

  return (
    <div className="chat-pane">
      {head}
      <div className="ai-msgs" ref={listRef} aria-live="polite">{body}</div>
      <div className="ai-input">
        <div className="ai-box">
          <textarea rows={2} value={text} aria-label="消息"
            placeholder={usable ? `和${agentName}对话…` : '只能回看，不能再发消息'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
            }} />
          <div className="ai-box-foot">
            <span className="field-hint-line">{note ?? '⌘Enter 发送；Agent 的工具会直接执行，提问会给出选项'}</span>
            <Button size="sm" variant="primary" disabled={!text.trim() || busy || !usable} title={note} onClick={submit}>发送</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
