// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 贴在主工作区底部的 Agent 对话框。默认收起成一条输入条，展开后是可拖高的对话区。
// 它是 .app-main 的子节点，所以只占中间那一栏——不盖侧栏、不盖详情抽屉。
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from './ui'
import { useWorkspace } from '../hooks/workspace'
import DockControls from './agent/DockControls'
import MessageList from './agent/MessageList'
import { useAgentChat } from './agent/useAgentChat'
import '../agent.css'

const LS_OPEN = 'pmw.agent.dock-open'
const LS_HEIGHT = 'pmw.agent.dock-h'
const MIN_H = 200
/** 最多吃掉主区七成高度，剩下的留给列表 */
const MAX_RATIO = 0.7

function readOpen(): boolean {
  try { return localStorage.getItem(LS_OPEN) === '1' } catch { return false }
}

function readHeight(): number {
  try {
    const n = Number(localStorage.getItem(LS_HEIGHT))
    if (Number.isFinite(n) && n >= MIN_H) return n
  } catch { /* 忽略读取失败 */ }
  return Math.round(window.innerHeight * 0.4)
}

function clampHeight(h: number): number {
  return Math.min(Math.max(h, MIN_H), Math.round(window.innerHeight * MAX_RATIO))
}

export default function AgentDock() {
  const { reloadObjects, reloadCounts, selectedId } = useWorkspace()

  // Agent 建完对象后刷新工作台。防抖收在 useAgentChat 里，这里只给回调。
  const onDataChanged = useCallback(() => {
    void reloadObjects()
    void reloadCounts()
  }, [reloadObjects, reloadCounts])

  // 把当前选中的对象带给后端：用户在列表里点开一条再问「这个需求怎么推进」，
  // 「这个」才有确定的指向。没选中就是 null，后端按没传处理。
  const chat = useAgentChat(onDataChanged, selectedId)
  const [open, setOpen] = useState(readOpen)
  const [height, setHeight] = useState(readHeight)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const dragFrom = useRef<{ y: number; h: number } | null>(null)

  const expand = useCallback(() => setOpen(true), [])

  useEffect(() => {
    try { localStorage.setItem(LS_OPEN, open ? '1' : '0') } catch { /* 忽略写入失败 */ }
  }, [open])

  // Cmd/Ctrl+J 开合。App 的全局键盘只吃 Cmd+K，J 这条不冲突。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'j') return
      e.preventDefault()
      setOpen((v) => {
        if (!v) queueMicrotask(() => inputRef.current?.focus())
        return !v
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 窗口变矮时把高度收回合法区间，否则列表会被挤没
  useEffect(() => {
    const onResize = () => setHeight((h) => clampHeight(h))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /* ───────── 拖拽调高 ───────── */

  const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    dragFrom.current = { y: e.clientY, h: height }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const from = dragFrom.current
    if (!from) return
    setHeight(clampHeight(from.h + (from.y - e.clientY))) // 往上拖变高
  }
  const onDragEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragFrom.current) return
    dragFrom.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    try { localStorage.setItem(LS_HEIGHT, String(height)) } catch { /* 忽略写入失败 */ }
  }

  /* ───────── 发送 ───────── */

  const submit = useCallback(() => {
    const text = draft
    if (!text.trim() || chat.streaming) return
    setDraft('')
    setOpen(true)
    void chat.send(text)
  }, [draft, chat])

  // Esc 收起。挂在 dock 自己身上并阻断冒泡，免得同一个 Esc 顺带把详情抽屉也关了
  // （App 的 Esc 处理挂在 window 上，事件到不了它那儿就不会触发）。
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || !open) return
    e.stopPropagation()
    setOpen(false)
    inputRef.current?.blur()
  }

  return (
    <section
      className="ag-dock"
      data-open={open ? 'open' : 'closed'}
      style={open ? { height: `${height}px` } : undefined}
      aria-label="Agent 对话"
      onKeyDown={onKeyDown}
    >
      {open ? (
        <div
          className="ag-resize"
          role="separator"
          aria-label="拖动调整对话区高度"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        />
      ) : null}

      {open ? <DockControls chat={chat} onCollapse={() => setOpen(false)} /> : null}

      {open ? (
        <MessageList
          items={chat.items}
          streaming={chat.streaming}
          workdir={chat.workdir}
          onRetry={chat.retry}
          onPick={chat.pickOption}
          onSubmitAnswers={chat.submitAnswers}
        />
      ) : null}

      <div className="ag-compose">
        {!open ? (
          <button
            type="button"
            className="ag-toggle"
            aria-label="展开 Agent 对话"
            title="展开（Cmd+J）"
            onClick={expand}
          >
            Agent
          </button>
        ) : null}
        <textarea
          ref={inputRef}
          className="ag-input"
          rows={1}
          spellCheck={false}
          // 没配供应商也能直接发：后端首次对话会自动建一条本机 ollama 配置，
          // 所以这里不换成劝人去设置的文案，免得把开箱即用的路堵上
          placeholder="记一条任务、或让 Agent 整理到输出目录…（Enter 发送，Shift+Enter 换行）"
          value={draft}
          onFocus={expand}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {chat.streaming ? (
          <Button variant="danger" small onClick={chat.stop}>停止</Button>
        ) : (
          <Button variant="primary" small onClick={submit} disabled={!draft.trim()}>发送</Button>
        )}
      </div>
    </section>
  )
}
