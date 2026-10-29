// 配置页右边的调试对话（AG-02b，SPEC-settings-9.31、9.32、9.42），接 AG-02c 的 /api/agents/debug/chat。
// 用当前（没保存的）配置跑，不写会话；对话只在这个面板里，「清空」就是前端清掉。停用的 Agent 照常能调。
// 需确认的调用出「确认执行 / 拒绝」，点了走 /api/agent/tool-calls/{dbg_id}，接着的回复另起一条。
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { errorText, streamDebugChat, streamDecision, type ChatDone, type ChatEvent, type DebugChatRequest, type StreamOptions } from '../../../core/data'
import { Button, cls, IconChevronRight } from '../../../core/ui'
import {
  DEBUG_EXAMPLES, NO_GRANT, abilityOf, canDecide, failMsg, finishMsg, isThinking, isWriteTool, markDecided, reduceEvent, toolLabel, transcript,
  type DbgCall, type DbgMsg,
} from './debugModel'

const STATE_LABEL = { running: '执行中', done: '已执行', pending: '等你确认', confirmed: '已确认执行', rejected: '已拒绝' } as const

function prettyArgs(args: string): string {
  if (!args.trim()) return ''
  try {
    return JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    return args
  }
}

/** 调用卡片：头部圆点（写操作着色）、工具名、状态，等你确认的默认展开（同 SPEC-sessions-1.17） */
export function DbgCallCard({ call, children }: { call: DbgCall; children?: ReactNode }) {
  const [open, setOpen] = useState(call.state === 'pending')
  const args = prettyArgs(call.args)
  return (
    <div className={cls('ag-call', 'ag-call-' + call.state)} data-tool={call.name} data-call={call.id}>
      <button type="button" className="ag-call-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={cls('ag-call-dot', isWriteTool(call.name) && 'write')} aria-hidden="true" />
        <span className="ag-call-name">{toolLabel(call.name)}</span>
        <span className="ag-call-state">{STATE_LABEL[call.state]}</span>
        <span className={cls('ag-call-chev', open && 'open')} aria-hidden="true"><IconChevronRight /></span>
      </button>
      {open && (
        <div className="ag-call-body">
          <div className="ag-call-k">输入</div>
          <pre>{args || '（无）'}</pre>
          {call.summary !== undefined && (
            <>
              <div className="ag-call-k">结果</div>
              <pre>{call.summary || '（无）'}</pre>
            </>
          )}
          {children}
        </div>
      )}
    </div>
  )
}

type Start = (opts: StreamOptions<ChatEvent>) => { done: Promise<ChatDone> }

export function DebugChat({ config, name, avatar, folded, onFold, onGoTools }: {
  /** 当前（没保存的）配置，不含 messages */
  config: Omit<DebugChatRequest, 'messages'>
  /** 输入框占位里的名字 */
  name: string
  avatar: ReactNode
  folded: boolean
  onFold: (folded: boolean) => void
  /** 授权没开时「可以在左边「工具与权限」里打开」点了切过去 */
  onGoTools: () => void
}) {
  const [msgs, setMsgs] = useState<DbgMsg[]>([])
  const [text, setText] = useState('')
  const seq = useRef(0)
  const ac = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const busy = !canDecide(msgs)

  // 离开配置页就不再听；后端照样跑完，产出照常落库
  useEffect(() => () => ac.current?.abort(), [])
  const scrollKey = msgs.map((m) => `${m.id}:${m.text.length}:${m.calls.length}:${m.streaming ? 1 : 0}`).join(',')
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [scrollKey])

  const run = (target: number, start: Start) => {
    const ctrl = new AbortController()
    ac.current = ctrl
    const { done } = start({ signal: ctrl.signal, onEvent: (e) => setMsgs((ms) => reduceEvent(ms, target, e)) })
    done.then(
      () => setMsgs((ms) => finishMsg(ms, target)),
      (err: unknown) => {
        if (ctrl.signal.aborted) return
        setMsgs((ms) => failMsg(ms, target, errorText(err)))
      },
    )
  }

  const send = (t: string) => {
    const msg = t.trim()
    if (!msg || busy) return false
    const user: DbgMsg = { id: ++seq.current, role: 'user', text: msg, calls: [], files: [] }
    const reply: DbgMsg = { id: ++seq.current, role: 'agent', text: '', calls: [], files: [], streaming: true }
    const next = [...msgs, user]
    const messages = transcript(next)
    setMsgs([...next, reply])
    run(reply.id, (opts) => streamDebugChat({ ...config, messages }, opts))
    return true
  }
  const submit = () => { if (send(text)) setText('') }

  const decide = (msgId: number, callId: string, approve: boolean) => {
    if (busy) return
    const reply: DbgMsg = { id: ++seq.current, role: 'agent', text: '', calls: [], files: [], streaming: true, decide: { msgId, callId, approve } }
    setMsgs([...markDecided(msgs, msgId, callId, approve), reply])
    run(reply.id, (opts) => streamDecision(callId, approve, undefined, opts))
  }

  const clear = () => {
    ac.current?.abort()
    ac.current = null
    setMsgs([])
  }

  return (
    <aside className={cls('ag-debug', folded && 'folded')} aria-label="调试">
      <div className="ag-debug-head">
        {avatar}
        <span className="ag-debug-title">调试</span>
        <span className="ag-sub">用当前配置试一试，不留会话记录</span>
        <span className="spacer" />
        {msgs.length > 0 && !folded && <Button size="sm" onClick={clear}>清空</Button>}
        {/* 只在窄屏出现：调试面板默认收成一条 */}
        <Button size="sm" className="ag-debug-toggle" aria-expanded={!folded} onClick={() => onFold(!folded)}>{folded ? '展开调试' : '收起'}</Button>
      </div>
      <div className="ag-dbg-msgs" ref={listRef} aria-live="polite">
        {!msgs.length && (
          <div className="ag-dbg-examples">
            <div className="ag-dbg-examples-title">试着问它</div>
            {DEBUG_EXAMPLES.map((e) => <button key={e} type="button" className="ag-dbg-example" onClick={() => send(e)}>{e}</button>)}
          </div>
        )}
        {msgs.map((m) => (m.role === 'user' ? (
          <div key={m.id} className="ag-dbg-msg user" data-role="user"><div className="ag-dbg-bubble">{m.text}</div></div>
        ) : (
          <div key={m.id} className="ag-dbg-msg agent" data-role="agent">
            {avatar}
            <div className="ag-dbg-bubble">
              {m.calls.length > 0 && (
                <div className="ag-dbg-calls">
                  {m.calls.map((c, i) => (
                    <DbgCallCard key={c.id ?? i} call={c}>
                      {c.state === 'pending' && c.id && (
                        <div className="ag-row">
                          <Button size="sm" variant="primary" disabled={busy} onClick={() => decide(m.id, c.id!, true)}>确认执行</Button>
                          <Button size="sm" disabled={busy} onClick={() => decide(m.id, c.id!, false)}>拒绝</Button>
                        </div>
                      )}
                      {c.summary && NO_GRANT.test(c.summary) && (
                        <div className="ag-sub">
                          这件事要用到「{abilityOf(c.name)}」，这个 Agent 没开这项权限，
                          <button type="button" className="ag-link" onClick={onGoTools}>可以在左边「工具与权限」里打开</button>
                        </div>
                      )}
                    </DbgCallCard>
                  ))}
                </div>
              )}
              {m.text}
              {m.files.length > 0 && <div className="ag-sub">写出文件 {m.files.join('、')}</div>}
              {isThinking(m) && <span className="ag-dbg-typing" role="status">正在回复…</span>}
              {m.error && <div className="ag-dbg-err" role="alert">{m.decide ? '没能接着跑' : '回复失败'}：{m.error}</div>}
            </div>
          </div>
        )))}
      </div>
      <div className="ag-dbg-input">
        <div className="ag-dbg-box">
          <textarea rows={2} value={text} aria-label="调试消息" placeholder={`和${name || '这个 Agent'}对话…`} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
            }} />
          <div className="ag-dbg-foot">
            <span className="ag-sub">调试对话不保存；产出照常落到数据上</span>
            <Button size="sm" variant="primary" disabled={!text.trim() || busy} onClick={submit}>发送</Button>
          </div>
        </div>
      </div>
    </aside>
  )
}
