// 群组管理「补全消息」按钮（IM 0.30.0，TSK-0724，SPEC-messages-7.14）：行上和批量条共用。
// 点开选范围（最近 7 天 / 30 天 / 全部），上次没补完的行菜单顶上多「继续补全」；渠道不支持、还没消息时置灰，悬停写原因。
import type { ImHistoryRange } from '../../core/data'
import { HISTORY_RANGES, rangeLabel, type BackfillResume } from './historyModel'
import { Caret, Menu } from './parts'

export function BackfillMenu({ label, ariaLabel, blocked, busy, resume, onPick, onContinue }: {
  label: string
  ariaLabel: string
  /** 不能补的原因；非空时置灰 */
  blocked: string
  busy: boolean
  /** 上次没补完的位置；有时菜单顶上多「继续补全」 */
  resume?: BackfillResume
  onPick: (range: ImHistoryRange) => void
  onContinue?: () => void
}) {
  const title = blocked || '回渠道拉这个会话的历史消息补进来，顺带补正文为空的；补进来的不当新消息：不触发 SOP、不计未读、不通知'
  if (blocked || busy) {
    return <button type="button" className="im-act im-ga-send" disabled aria-label={ariaLabel} title={title}>{busy ? '补全中…' : label}</button>
  }
  return (
    <Menu className="im-act im-ga-send" label={<>{label}<Caret /></>} title={title} ariaLabel={ariaLabel}>
      {(close) => (
        <>
          <div className="menu-label">补哪段时间的消息</div>
          {resume && onContinue && (
            <button type="button" role="menuitem" className="menu-item" onClick={() => { close(); onContinue() }}>
              <span>继续补全</span><span className="im-menu-note">接着上次（{rangeLabel(resume.range)}）</span>
            </button>
          )}
          {HISTORY_RANGES.map((r) => (
            <button key={r.key} type="button" role="menuitem" className="menu-item" title={r.hint} onClick={() => { close(); onPick(r.key) }}>
              <span>{r.label}</span>{r.key === 'all' && <span className="im-menu-note">至多 5000 条</span>}
            </button>
          ))}
        </>
      )}
    </Menu>
  )
}
