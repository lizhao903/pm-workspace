// 流式输出（DEV-08c，DEV-09 复用）：正文连续拼成段落，工具调用和结果按 id 配成一张卡片。
import { useMemo } from 'react'
import type { RunEvent } from '../../core/api'
import { cls } from '../../core/ui'
import { foldEvents, isWriteTool, type OutBlock, type ToolState } from './runsModel'
import './runs.css'

const TOOL_STATE: Record<ToolState, string> = { pending: '执行中', ok: '成功', failed: '失败', unknown: '未完成' }

// 显示一组输出块；live 时末尾带闪烁光标
export function RunOutput({ blocks, live = false, empty = '没有输出' }: { blocks: OutBlock[]; live?: boolean; empty?: string }) {
  return (
    <div className="run-out" aria-live={live ? 'polite' : undefined}>
      {!blocks.length && !live && <div className="run-out-empty">{empty}</div>}
      {blocks.map((b, i) => (b.k === 'text'
        ? <div key={i} className="run-out-text">{b.text}</div>
        : (
          <div key={b.id + ':' + i} className={cls('run-tool', 'run-tool-' + b.state)} data-tool-id={b.id} data-state={b.state}>
            <div className="run-tool-head">
              <span className={cls('run-tool-dot', isWriteTool(b.name) && 'write')} aria-hidden="true" />
              <span className="run-tool-name">{b.name}{b.detail && <span className="run-tool-detail"> {b.detail}</span>}</span>
              <span className="run-tool-state">{TOOL_STATE[b.state]}</span>
            </div>
            {b.state === 'failed' && b.error && <div className="run-tool-err">{b.error}</div>}
          </div>
        )))}
      {live && <span className="run-caret" role="status" aria-label="输出中" />}
    </div>
  )
}

// 直接吃 SSE 事件（runObject 的 onEvent 收到的那些）
export function RunStream({ events, live = false }: { events: readonly RunEvent[]; live?: boolean }) {
  const blocks = useMemo(() => foldEvents(events), [events])
  return <RunOutput blocks={blocks} live={live} empty="还没有输出" />
}
