// 对话面板（SPEC-sessions-1.14 到 1.20、1.26、1.31）：历史消息加正在进行的这一轮，输入框，示例问题，
// Agent 的提问显示成选项按钮，点选后作为一条普通消息发出（契约「Agent 对话」的 question 事件）。
// 要人确认的调用（AG-02b）：卡片上「确认执行 / 拒绝」，点了接着跑，回复照常流式显示。调用 id 来自 confirm 事件，
// 执行记录建的会话从执行记录详情里找回；都找不到（页面刷新过）的只显示状态。
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AGENT_RUN_PAGE_MAX, errorText, useAgentMessages, useAgentProviders, useAgentRun, useAgentRunList, useRemoveAgentMessages, useStopAgentSession, type AgentSession,
} from '../data'
import { Button, ErrorState, LoadingState, cls } from '../ui'
import { CallCard } from './CallCard'
import { decideCall, dismissChat, sendChat, useCallState, useDeciding, useLiveChat } from './chatLive'
import {
  CHAT_EXAMPLES, NEW_TITLE, answerText, bubbleIds, foldHistory, foldLive, modelLabel, overlayCalls, titleFrom, toolAbility, whoName, whoUsable, type CallRef, type CallView,
  type ChatMsgView, type ChatWho, type QuestionView,
} from './chatModel'
import { WhoAvatar } from './WhoAvatar'
import './chat.css'

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

/** 等你确认的卡片下面的按钮；没有 id 的说明为什么点不了 */
function ConfirmActions({ call, sessionId, enabled }: { call: CallView; sessionId: string; enabled: boolean }) {
  const deciding = useDeciding(call.id)
  if (!call.id) return <div className="list-sub call-confirm-hint">页面刷新过，这里确认不了；可以再说一遍，让它重新提出</div>
  const id = call.id
  return (
    <div className="act-row call-confirm">
      <Button size="sm" variant="primary" disabled={!enabled || deciding} onClick={() => decideCall(sessionId, id, true)}>确认执行</Button>
      <Button size="sm" disabled={!enabled || deciding} onClick={() => decideCall(sessionId, id, false)}>拒绝</Button>
    </div>
  )
}

/**
 * 历史气泡旁的「移除」（SPEC-sessions-1.43）：悬停出现，点了就地确认；移除后这几条不再进模型的上下文，已经执行的操作不撤回。
 * 这一轮在跑时不能移除（后端也会 409）
 */
function RemoveAction({ sessionId, ids, disabled }: { sessionId: string; ids: string[]; disabled: boolean }) {
  const [asking, setAsking] = useState(false)
  const remove = useRemoveAgentMessages()
  if (!ids.length) return null
  if (!asking) {
    return (
      <button type="button" className="ai-msg-act" disabled={disabled} title={disabled ? '这一轮还在跑，跑完再移除' : '从会话里移除这条，之后不再作为上下文发给模型'}
        onClick={() => { remove.reset(); setAsking(true) }}>移除</button>
    )
  }
  return (
    <div className="ai-msg-confirm" role="group" aria-label="确认移除">
      <span>移除这条？之后不再作为上下文发给模型，已经执行的操作不会撤回</span>
      <span className="act-row">
        <Button size="sm" variant="danger" disabled={disabled || remove.isPending}
          onClick={() => remove.mutate({ sessionId, ids }, { onSuccess: () => setAsking(false) })}>{remove.isPending ? '移除中…' : '移除'}</Button>
        <Button size="sm" disabled={remove.isPending} onClick={() => setAsking(false)}>取消</Button>
      </span>
      {remove.isError && <span className="danger-text" role="alert">没移除成：{errorText(remove.error)}</span>}
    </div>
  )
}

function AgentBubble({ m, avatar, children, renderCall, noGrant, action, model }: {
  m: ChatMsgView
  avatar: ReactNode
  children?: ReactNode
  /** 这条回复用的「服务商 · 模型」（TSK-0720），悬停时在气泡底下显示；没记的不显示 */
  model?: string
  /** 气泡旁的操作（历史消息的「移除」） */
  action?: ReactNode
  /** 卡片里多放的东西（确认、拒绝按钮） */
  renderCall?: (c: CallView) => ReactNode
  noGrant?: (c: CallView) => ReactNode
}) {
  return (
    <div className="ai-msg ai-ai" data-role="agent">
      {avatar}
      <div className="ai-bubble" title={model ? `回复用的模型：${model}` : undefined}>
        {m.calls.length > 0 && (
          <div className="call-list">{m.calls.map((c, i) => <CallCard key={c.id ?? i} call={c} noGrant={noGrant?.(c)}>{renderCall?.(c)}</CallCard>)}</div>
        )}
        {m.text && <div className="pre-line">{m.text}</div>}
        {m.files && m.files.length > 0 && (
          <ul className="ai-files">{m.files.map((f) => <li key={f.path}>写出文件 <code>{f.path}</code></li>)}</ul>
        )}
        {children}
        {model && <div className="ai-msg-model">{model}</div>}
      </div>
      {action}
    </div>
  )
}

export function ChatPane({ session, who, head, autoSend, onRetitle, onOpenTools }: {
  session: AgentSession
  /** 和谁聊：Agent（停用、删除只能回看），或不挂 Agent 的旧会话的服务商 */
  who: ChatWho
  head?: ReactNode
  /** 刚建的空会话自动发出去的第一句话，只发一次 */
  autoSend?: string
  /** 第一句话发出时改标题 */
  onRetitle: (title: string) => void
  /** 权限没开时去「设置 / Agent / 工具与权限」（SPEC-sessions-1.18） */
  onOpenTools?: () => void
}) {
  const msgs = useAgentMessages(session.id)
  const providers = useAgentProviders()
  const modelOf = (m: ChatMsgView) => (m.model ? modelLabel(m.providerId ?? '', m.model, providers.data ?? []).text : undefined)
  const liveRaw = useLiveChat(session.id)
  const { refs: liveRefs, decisions } = useCallState(session.id)
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  const agentName = whoName(who)
  const avatar = <WhoAvatar who={who} size={24} />
  // Agent（或旧会话的服务商）停用、删除后只能回看：按钮、⌘Enter、示例问题、提问选项都从 send 拦
  const { usable, note } = whoUsable(who)
  const hint = who.kind === 'provider' ? '⌘Enter 发送；Agent 的工具会直接执行，提问会给出选项' : '⌘Enter 发送；写操作按权限停下来等你确认'
  const busy = liveRaw?.phase === 'streaming'
  const stop = useStopAgentSession()

  const folded = useMemo(() => foldHistory(msgs.data ?? []), [msgs.data])
  // 执行记录建的会话：等确认的调用 id 在执行记录详情里。只在有配不上 id 的等确认卡片时去找
  const needRefs = !!session.agent_id && folded.some((v) => v.calls.some((c) => c.asked && c.state === 'pending'))
  const waitingRuns = useAgentRunList({ status: ['waiting'], limit: AGENT_RUN_PAGE_MAX }, needRefs)
  const runId = needRefs ? waitingRuns.data?.data.find((r) => r.session_id === session.id)?.id ?? null : null
  const run = useAgentRun(runId, !!runId)
  const refs = useMemo<CallRef[]>(() => {
    const fromRun = (run.data?.tool_calls ?? []).map((t) => ({ id: t.id, name: t.tool, args: t.args }))
    return [...fromRun, ...liveRefs.filter((r) => !fromRun.some((x) => x.id === r.id))]
  }, [run.data, liveRefs])
  const history = useMemo(() => overlayCalls(folded, refs, decisions), [folded, refs, decisions])
  // 收尾后消息读回来、这一轮还没收起的那一下，以读回的为准，不重复显示
  const doneId = liveRaw?.events.find((e) => e.type === 'done')?.message_id
  const live = doneId && history.some((m) => m.id === doneId) ? undefined : liveRaw
  const liveMsg = useMemo(() => (live ? foldLive(live.events, !!live.decide) : null), [live])
  const last = history[history.length - 1]
  // 失败的这一轮里人说的话后端已经落库了（先存用户消息再跑模型），读回来就不再重复显示
  const liveUserSaved = !!live && (!live.text || (live.phase !== 'streaming' && last?.role === 'user' && last.text === live.text))

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
  const renderCall = (c: CallView) => (c.state === 'pending' ? <ConfirmActions call={c} sessionId={session.id} enabled={usable && !busy} /> : null)
  const noGrant = (c: CallView) => (
    <>
      这件事要用到「{toolAbility(c.name)}」，这个 Agent 没开这项权限，
      {onOpenTools ? <button type="button" className="link-btn" onClick={onOpenTools}>可以到「设置 / Agent / 工具与权限」里打开</button> : '可以到「设置 / Agent / 工具与权限」里打开'}
    </>
  )

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
        {history.map((m, i) => (m.role === 'notice'
          // 换模型这类系统提示（TSK-0720）：居中一行，不算谁说的，也不进模型的上下文
          ? <div key={m.id} className="ai-notice" role="note" data-role="notice"><span>{m.text}</span></div>
          : m.role === 'user'
          ? (
            <div key={m.id} className="ai-msg ai-user" data-role="user">
              <RemoveAction sessionId={session.id} ids={bubbleIds(m)} disabled={busy} />
              <div className="ai-bubble">{m.text}</div>
            </div>
          )
          : (
            <AgentBubble key={m.id} m={m} avatar={avatar} renderCall={renderCall} noGrant={noGrant} model={modelOf(m)}
              action={<RemoveAction sessionId={session.id} ids={bubbleIds(m)} disabled={busy} />}>
              {m.question && (
                <QuestionCard q={m.question} active={canAnswer && !live && i === history.length - 1} onAnswer={answer} />
              )}
            </AgentBubble>
          )))}
        {live && !liveUserSaved && <div className="ai-msg ai-user" data-role="user"><div className="ai-bubble">{live.text}</div></div>}
        {live && liveMsg && (liveMsg.text || liveMsg.calls.length || liveMsg.question || liveMsg.files) ? (
          <AgentBubble m={liveMsg} avatar={avatar} renderCall={renderCall} noGrant={noGrant}>
            {liveMsg.question && <QuestionCard q={liveMsg.question} active={canAnswer && questionLive} onAnswer={answer} />}
          </AgentBubble>
        ) : null}
        {busy && !liveMsg?.text && (
          <div className="ai-msg ai-ai">{avatar}
            <div className="ai-bubble ai-typing" role="status" aria-label="正在输入"><span /><span /><span /></div>
          </div>
        )}
        {live?.phase === 'failed' && (
          <div className="ai-msg ai-ai">{avatar}
            <div className="ai-bubble ai-failed" role="alert">
              <div>{live.decide ? (live.decide.approve ? '确认没成功' : '拒绝没成功') : '回复失败'}：{live.error}</div>
              <div className="act-row">
                {live.text && <Button size="sm" variant="outline" disabled={!usable} onClick={() => send(live.text)}>重试</Button>}
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
            placeholder={usable ? `和 ${agentName} 对话…` : '只能回看，不能再发消息'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
            }} />
          <div className="ai-box-foot">
            <span className="field-hint-line">{note ?? hint}</span>
            {busy ? (
              <Button size="sm" variant="danger" disabled={stop.isPending} title="停掉正在跑的这一轮；已经执行的操作不会撤回" onClick={() => stop.mutate(session.id)}>
                {stop.isPending ? '停止中…' : '停止'}
              </Button>
            ) : <Button size="sm" variant="primary" disabled={!text.trim() || !usable} title={note} onClick={submit}>发送</Button>}
          </div>
        </div>
      </div>
    </div>
  )
}
