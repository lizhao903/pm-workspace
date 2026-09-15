// 消息区：四种流事件长四个样，用户右对齐、assistant 左对齐。
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
}

export default function MessageList({ items, streaming, workdir, onRetry }: MessageListProps) {
  const { select, setDrawerTab } = useWorkspace()
  const boxRef = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true) // 用户往上翻过就别再抢滚动条

  useEffect(() => {
    const el = boxRef.current
    if (!el || !pinned.current) return
    el.scrollTop = el.scrollHeight
  }, [items])

  const onScroll = () => {
    const el = boxRef.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  if (!items.length) {
    return (
      <div className="ag-msgs ag-empty" ref={boxRef}>
        <div className="ag-empty-title">和 Agent 说点什么</div>
        <div className="ag-empty-hint">
          它能帮你记任务、记待办，把整理好的文件写进你指定的输出目录。
        </div>
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
