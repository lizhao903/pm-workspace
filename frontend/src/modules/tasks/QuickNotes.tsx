// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 交给执行弹窗里附加说明上面的快捷说明（SPEC-tasks-6.40，用户 2026-11-19 提）：一排芯片，点一个把它的文字追加进附加说明
// （另起一行，已经有的不重复加），之后照常手改。列表取 GET /api/run-quick-notes，没设过是内置的一组，在设置「快捷说明」里增删改。
// Claude Code / DeepSeek 的弹窗和工作台 Agent 的弹窗共用。
import { Link } from 'react-router'
import { errorText, useRunQuickNotes } from '../../core/data'
import { InfoTip, cls } from '../../core/ui'
import { appendQuickNote } from './handoffModel'

export function QuickNotes({ value, onChange, disabled, onManage, target = '附加说明' }: {
  /** 当前的附加说明 */
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  /** 点「管理快捷说明」去设置前关掉弹窗 */
  onManage: () => void
  /** 追加到哪一格，说明里用（工作台 Agent 弹窗叫「补充说明」） */
  target?: string
}) {
  const q = useRunQuickNotes()
  const list = q.data ?? []
  return (
    <div className="ho-quick" role="group" aria-label="快捷说明">
      <div className="ho-preset-head">
        <span className="field-label">快捷说明</span>
        <InfoTip label="快捷说明的用法">点一个把它的文字追加进下面的{target}（另起一行，已经有的不重复加），之后可以再改</InfoTip>
        <span className="spacer" />
        <Link className="ho-preset-manage" to="/settings/run-quick-notes" onClick={onManage}>管理快捷说明</Link>
      </div>
      {q.isError ? (
        <span className="field-hint-line">快捷说明没取到：{errorText(q.error)}</span>
      ) : list.length ? (
        <div className="ho-quick-chips">
          {list.map((n) => {
            const used = value.includes(n.text.trim())
            return (
              <button key={n.label} type="button" className={cls('chip', used && 'chip-on')} title={used ? `已加上：${n.text}` : n.text}
                disabled={disabled} onClick={() => onChange(appendQuickNote(value, n.text))}>
                {n.label}
              </button>
            )
          })}
        </div>
      ) : q.isPending ? null : (
        <span className="field-hint-line">还没有快捷说明，在设置里加</span>
      )}
    </div>
  )
}
