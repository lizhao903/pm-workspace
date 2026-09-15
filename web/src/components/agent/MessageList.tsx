// 消息区：每种流事件长一个样，用户右对齐、assistant 左对齐。
// question 是唯一可交互的一种——它的选项要能点，点完就作为一条普通消息发回去。
import { useEffect, useRef } from 'react'
import { useWorkspace } from '../../hooks/workspace'
import type { ChatItem } from './useAgentChat'

function formatBytes(n: number): string {
  if (!n || n < 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** tool_call 的 args 是 JSON 字符串原文，悬浮提示里缩进一下；不是 JSON 就原样显示 */
function prettyArgs(raw: string): string | undefined {
  if (!raw) return undefined
  try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
}

/** artifact 只给了相对路径，末段当文件名 */
function baseName(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

export interface MessageListProps {
  items: ChatItem[]
  streaming: boolean
  workdir: string
  onRetry: () => void
  onPick: (id: string, label: string) => void
  onSubmitAnswers: () => void
  /** 空态文案。底部全局对话框和对象内对话框的开场白不一样，其余渲染完全共用 */
  emptyTitle?: string
  emptyHint?: string
}

export default function MessageList({
  items, streaming, workdir, onRetry, onPick, onSubmitAnswers,
  emptyTitle = '和 Agent 说点什么',
  emptyHint = '它能帮你记任务、记待办，把整理好的文件写进你指定的输出目录。',
}: MessageListProps) {
  const { select, setDrawerTab } = useWorkspace()
  const boxRef = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true) // 用户往上翻过就别再抢滚动条

  useEffect(() => {
    const el = boxRef.current
    if (!el || !pinned.current) return
    el.scrollTop = el.scrollHeight
  }, [items])

  // 待答的问题。模型一次问了好几个时，要等全都选完才能一起发——
  // 只答一半，剩下的下一轮会被重新问一遍。
  const pending = items.filter((x) => x.kind === 'question' && !x.answered)
  const canSubmit = pending.length > 0 && pending.every((q) => q.picked?.length)

  const onScroll = () => {
    const el = boxRef.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  if (!items.length) {
    return (
      <div className="ag-msgs ag-empty" ref={boxRef}>
        <div className="ag-empty-title">{emptyTitle}</div>
        <div className="ag-empty-hint">{emptyHint}</div>
      </div>
    )
  }

  return (
    <div className="ag-msgs" ref={boxRef} onScroll={onScroll} role="log" aria-live="polite">
      {items.map((it) => {
        switch (it.kind) {
          case 'user':
            return (
              <div key={it.id} className="ag-row ag-row-user">
                <div className="ag-bubble ag-bubble-user">{it.text}</div>
              </div>
            )

          case 'assistant':
            return (
              <div key={it.id} className="ag-row">
                <div className="ag-bubble ag-bubble-bot">
                  {it.text}
                  {it.streaming ? <span className="ag-caret" /> : null}
                </div>
              </div>
            )

          case 'tool_call':
            return (
              <div key={it.id} className="ag-toolline" title={prettyArgs(it.text)}>
                {it.running ? <span className="ag-spin" /> : null}
                <span>正在 {it.toolName}…</span>
              </div>
            )

          case 'tool_result':
            return (
              <div key={it.id} className="ag-card">
                <div className="ag-card-head">
                  <span className="ag-card-kind">工具</span>
                  <span className="ag-card-name">{it.toolName}</span>
                </div>
                <div className="ag-card-body">{it.text || '（无输出）'}</div>
                {/* 只有 create/update 类工具会带 object_id，搜索/读取类不带，所以要判空。
                    链接文案不显示 id 本身：obj_06ga… 对人没有意义，
                    人读编号（TSK-0001）后端已经写进 summary 了。 */}
                {it.objectId ? (
                  <button
                    type="button"
                    className="ag-link"
                    title={it.objectId}
                    onClick={() => { setDrawerTab('detail'); select(it.objectId!) }}
                  >
                    打开对象
                  </button>
                ) : null}
              </div>
            )

          case 'artifact':
            return (
              <div key={it.id} className="ag-card ag-card-file">
                <div className="ag-card-head">
                  <span className="ag-card-kind">文件</span>
                  <span className="ag-card-name">{baseName(it.path ?? '')}</span>
                  <span className="ag-card-size">{formatBytes(it.size ?? 0)}</span>
                </div>
                {/* 文件就在目录根下时相对路径 === 文件名，再显示一遍是纯重复 */}
                {it.path && it.path !== baseName(it.path)
                  ? <div className="ag-card-body ag-path">{it.path}</div>
                  : null}
                <div className="ag-card-foot">
                  已写入 {workdir || '会话输出目录'}
                </div>
              </div>
            )

          case 'question': {
            const picked = it.picked ?? []
            const locked = it.answered || streaming
            // 单选且只有这一个问题时点一下就发，不需要再来个提交按钮
            const needsSubmit = !it.answered && (it.multi || pending.length > 1)
            return (
              <div key={it.id} className={`ag-card ag-ask${it.answered ? ' is-answered' : ''}`}>
                <div className="ag-card-head">
                  <span className="ag-card-kind">待确认</span>
                  {it.multi ? <span className="ag-card-size">可多选</span> : null}
                </div>
                <div className="ag-card-body ag-ask-q">{it.text}</div>
                <div className="ag-ask-opts">
                  {(it.options ?? []).map((o) => (
                    <button
                      key={o.label}
                      type="button"
                      className={`ag-opt${picked.includes(o.label) ? ' is-picked' : ''}`}
                      disabled={locked}
                      aria-pressed={picked.includes(o.label)}
                      onClick={() => onPick(it.id, o.label)}
                    >
                      <span className="ag-opt-label">{o.label}</span>
                      {/* detail 一定要渲染出来。只显示选项名等于让用户猜「选这个会怎样」，
                          那正是这个功能要避免的事。 */}
                      <span className="ag-opt-detail">{o.detail}</span>
                    </button>
                  ))}
                </div>
                <div className="ag-card-foot">
                  {it.answered ? <span>已回答：{picked.join('、')}</span> : null}
                  {needsSubmit ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={!canSubmit || streaming}
                      onClick={onSubmitAnswers}
                    >
                      {pending.length > 1 ? `一起回答（${pending.length} 个问题）` : '回答'}
                    </button>
                  ) : null}
                  {!it.answered && !needsSubmit ? <span>选一个就发出去</span> : null}
                </div>
              </div>
            )
          }

          case 'error':
            return (
              <div key={it.id} className="ag-row">
                <div className="ag-bubble ag-bubble-err">
                  <span>{it.text}</span>
                  {it.retryable && !streaming ? (
                    <button type="button" className="btn btn-sm ag-retry" onClick={onRetry}>重试</button>
                  ) : null}
                </div>
              </div>
            )

          default:
            return null
        }
      })}
    </div>
  )
}
