// 流式输出（DEV-08c，DEV-09 复用）：正文连续拼成段落，工具调用和结果按 id 配成一张卡片。
// 工作台 Agent 的执行（TSK-0460）另有确认卡片：在等的时候给「确认」「拒绝」两个按钮（onDecide 给了才有）。
import { useLayoutEffect, useMemo, useRef } from 'react'
import type { RunEvent } from '../../core/data'
import { Button, cls } from '../../core/ui'
import { confirmStateText, foldEvents, isWriteTool, type OutBlock, type ToolState } from './runsModel'
import './runs.css'

const TOOL_STATE: Record<ToolState, string> = { pending: '执行中', ok: '成功', failed: '失败', unknown: '未完成' }

// 离底部多近算「停在底部」
const STICK_PX = 24

// 显示一组输出块；live 时末尾带闪烁光标。
// follow（DEV-09 加）：live 时跟着新输出滚到底，往上翻过就不再跟，翻回底部再接着跟
/** 确认卡片上的操作：deciding 是正在提交的那张的 id，error 是上一次没提交成的原因 */
export type DecideProps = { onDecide: (id: string, approve: boolean) => void; deciding?: string; error?: string }

export function RunOutput({ blocks, live = false, empty = '没有输出', follow = false, decide }: {
  blocks: OutBlock[]
  live?: boolean
  empty?: string
  follow?: boolean
  decide?: DecideProps
}) {
  const ref = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (follow && live && el && stuck.current) el.scrollTop = el.scrollHeight
  }, [blocks, follow, live])
  return (
    <div ref={ref} className="run-out" aria-live={live ? 'polite' : undefined}
      onScroll={follow ? (e) => {
        const el = e.currentTarget
        stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX
      } : undefined}>
      {!blocks.length && !live && <div className="run-out-empty">{empty}</div>}
      {blocks.map((b, i) => (b.k === 'text'
        ? <div key={i} className="run-out-text">{b.text}</div>
        : b.k === 'confirm'
          ? <ConfirmCard key={b.id + ':' + i} b={b} decide={live ? decide : undefined} />
          : (
          <div key={b.id + ':' + i} className={cls('run-tool', 'run-tool-' + b.state)} data-tool-id={b.id} data-state={b.state}>
            <div className="run-tool-head">
              <span className={cls('run-tool-dot', isWriteTool(b.name) && 'write')} aria-hidden="true" />
              <span className="run-tool-name">{b.name}{b.detail && <span className="run-tool-detail"> {b.detail}</span>}</span>
              <span className="run-tool-state">{TOOL_STATE[b.state]}</span>
            </div>
            {b.state === 'failed' && b.error && <div className="run-tool-err">{b.error}</div>}
            {b.state === 'ok' && b.summary && <div className="run-tool-sum">{b.summary}</div>}
          </div>
        )))}
      {live && <span className="run-caret" role="status" aria-label="输出中" />}
    </div>
  )
}

function ConfirmCard({ b, decide }: { b: Extract<OutBlock, { k: 'confirm' }>; decide?: DecideProps }) {
  const busy = decide?.deciding === b.id
  return (
    <div className={cls('run-ask', 'run-ask-' + b.state)} data-confirm-id={b.id} data-state={b.state} role="group" aria-label="等你确认的操作">
      <div className="run-ask-head">
        <span className="run-ask-title">{b.summary || b.name}</span>
        <span className="run-ask-state">{confirmStateText(b.state, b.deadline)}</span>
      </div>
      {b.state === 'pending' && decide && (
        <div className="run-ask-actions">
          <Button size="sm" variant="primary" disabled={!!decide.deciding} onClick={() => decide.onDecide(b.id, true)}>
            {busy ? '正在提交' : '确认执行'}
          </Button>
          <Button size="sm" variant="outline" disabled={!!decide.deciding} onClick={() => decide.onDecide(b.id, false)}>拒绝</Button>
          {decide.error && <span className="run-note-danger" role="alert">{decide.error}</span>}
        </div>
      )}
    </div>
  )
}

// 直接吃 SSE 事件（runObject 的 onEvent 收到的那些）
export function RunStream({ events, live = false, follow = false, decide }: {
  events: readonly RunEvent[]
  live?: boolean
  follow?: boolean
  decide?: DecideProps
}) {
  const blocks = useMemo(() => foldEvents(events), [events])
  return <RunOutput blocks={blocks} live={live} empty="还没有输出" follow={follow} decide={decide} />
}
