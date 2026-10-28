// 工具调用卡片（SPEC-sessions-1.17）：头部圆点（写操作着色）、工具名、状态、展开箭头，展开看输入和结果。
// 现有后端的工具都是直接执行的，没有「等你确认」，所以只有执行中和已执行两种状态。
import { useState } from 'react'
import { cls, IconChevronRight } from '../../core/ui'
import { isWriteTool, prettyArgs, toolLabel, type CallView } from './chatModel'

const STATE_LABEL = { running: '执行中', done: '已执行' } as const

export function CallCard({ call }: { call: CallView }) {
  const [open, setOpen] = useState(false)
  const args = prettyArgs(call.args)
  return (
    <div className={cls('call-card', 'call-' + call.state)} data-tool={call.name}>
      <button type="button" className="call-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={cls('call-dot', isWriteTool(call.name) && 'write')} aria-hidden="true" />
        <span className="call-name ellipsis">{toolLabel(call.name)}</span>
        <span className="call-state">{STATE_LABEL[call.state]}</span>
        <span className={cls('call-chev', open && 'open')} aria-hidden="true"><IconChevronRight /></span>
      </button>
      {open && (
        <div className="call-body">
          <div className="call-k">输入</div>
          <pre className="io-json">{args || '（无）'}</pre>
          {call.summary !== undefined && (
            <>
              <div className="call-k">结果</div>
              <pre className="io-json">{call.summary || '（无）'}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}
