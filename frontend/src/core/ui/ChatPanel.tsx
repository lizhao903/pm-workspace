import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from './Button'
import { Textarea } from './form'
import './chatPanel.css'

export type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string }
export type ChatPanelProps = {
  onSend: (messages: readonly ChatMessage[], signal: AbortSignal) => Promise<string>
  renderMessage?: (message: ChatMessage) => ReactNode
  initialInput?: string
  disabled?: boolean
  sendLabel?: string
  inputLabel?: string
  emptyText?: string
}

/** Ephemeral conversation UI. Transport and rich reply rendering belong to the caller. */
export function ChatPanel({ onSend, renderMessage, initialInput = '', disabled = false, sendLabel = '发送', inputLabel = '消息', emptyText = '发送消息，开始对话' }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState(initialInput)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'nearest' }) }, [messages, pending, error])
  async function send(retry = false) {
    if (controller.current || disabled || (!retry && !input.trim())) return
    const next = retry ? messages : [...messages, { id: crypto.randomUUID(), role: 'user' as const, content: input.trim() }]
    const request = new AbortController()
    controller.current = request
    setMessages(next); setInput(''); setPending(true); setError('')
    try {
      const content = await onSend(next, request.signal)
      if (!request.signal.aborted) setMessages([...next, { id: crypto.randomUUID(), role: 'assistant', content }])
    } catch (e) {
      if (!request.signal.aborted) setError(e instanceof Error ? e.message : '发送失败，请重试')
    } finally {
      if (controller.current === request) { controller.current = null; setPending(false) }
    }
  }
  return <div className="chat-panel">
    <div className="chat-panel-messages" role="log" aria-label="对话记录" aria-live="polite">
      {!messages.length && <p className="chat-panel-empty">{emptyText}</p>}
      {messages.map((message) => <article key={message.id} className={`chat-panel-message chat-panel-message--${message.role}`}>
        <div className="chat-panel-author">{message.role === 'user' ? '你' : '助手'}</div>
        <div className="chat-panel-content">{renderMessage ? renderMessage(message) : message.content}</div>
      </article>)}
      {pending && <div role="status">正在回复…</div>}
      {error && <div role="alert">{error} <Button disabled={disabled} onClick={() => void send(true)}>重试</Button></div>}
      <div ref={end} />
    </div>
    <form className="chat-panel-composer" onSubmit={(e) => { e.preventDefault(); void send() }}>
      <Textarea aria-label={inputLabel} placeholder="输入消息，Enter 发送，Shift+Enter 换行" rows={3} maxLength={2000} value={input} disabled={disabled || pending || !!error} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() }
      }} />
      <div className="chat-panel-actions"><span>Enter 发送 · Shift+Enter 换行</span><Button disabled={pending || disabled || !input.trim() || !!error} type="submit">{pending ? '回复中…' : sendLabel}</Button>
        {messages.length > 0 && <Button disabled={pending} onClick={() => { setMessages([]); setError(''); setInput('') }}>清空对话</Button>}
      </div>
    </form>
  </div>
}
