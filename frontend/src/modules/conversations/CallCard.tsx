// 工具调用卡片（SPEC-sessions-1.17）：头部圆点（写操作着色）、工具名、状态、展开箭头，展开看输入和结果。
// 会话里只有执行中和已执行；执行记录里要人确认的调用多三种状态，等你确认的默认展开（AG-01b8）。
// 确认、拒绝按钮由用的地方放进 children（AG-02b）；权限没开时 noGrant 是提示要开哪项、去哪里开。
import { useState, type ReactNode } from 'react'
import { cls, IconChevronRight } from '../../core/ui'
import { isWriteTool, prettyArgs, toolLabel, type CallView } from './chatModel'

const STATE_LABEL = { running: '执行中', done: '已执行', pending: '等你确认', confirmed: '已确认执行', rejected: '已拒绝' } as const
// 授权关了的工具，后端的结果是「<工具> 没有授权，没有执行」（SPEC-sessions-1.18）
const NO_GRANT = /没有授权/

export function CallCard({ call, children, noGrant }: { call: CallView; children?: ReactNode; noGrant?: ReactNode }) {
  const [open, setOpen] = useState(call.state === 'pending')
  const args = prettyArgs(call.args)
  return (
    <div className={cls('call-card', 'call-' + call.state)} data-tool={call.name} data-call={call.id}>
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
          {call.summary && NO_GRANT.test(call.summary) && <div className="list-sub call-no-grant">{noGrant ?? '可以到「设置 / Agent / 工具与权限」里打开'}</div>}
          {children}
        </div>
      )}
    </div>
  )
}
