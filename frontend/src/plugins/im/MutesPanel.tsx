// 自动忽略的管理列表（IM 0.27.0，TSK-0495，SPEC-messages-9）：消息页标题行「自动忽略」打开的右侧抽屉，地址记 ?mutes=1。
// 每行是一条自动忽略：名字、标的是谁（渠道身份 / 联系人）、范围、已自动忽略了几条；
// 「看消息」回到消息页的「已忽略」并按名字搜（取消后也能这样把要改回的找出来），「取消」确认后取消，已忽略的不恢复。
import { useState } from 'react'
import { errorText, useConnectorDefs, useImMutes, type ImMute } from '../../core/data'
import { Drawer, ErrorState, LoadingState } from '../../core/ui'
import { channelOf, channelTable, timeAgo } from './model'
import { UnmuteDialog } from './MuteDialog'
import { muteScopeText, muteWhoText } from './muteModel'
import './mutes.css'
import './groupAdmin.css'

export function MutesDrawer({ onClose, onShowMessages }: {
  onClose: () => void
  /** 「看消息」：回到消息列表的「已忽略」，按这个名字搜 */
  onShowMessages: (name: string) => void
}) {
  const mutes = useImMutes()
  const defs = useConnectorDefs()
  const channels = channelTable(defs.data)
  const [cancel, setCancel] = useState<ImMute | null>(null)
  const [note, setNote] = useState('')
  const list = mutes.data ?? []
  let body
  if (mutes.isError && !mutes.data) {
    body = <ErrorState title="自动忽略没加载出来" error={errorText(mutes.error)} onRetry={() => void mutes.refetch()} />
  } else if (mutes.isPending) {
    body = <LoadingState />
  } else if (!list.length) {
    body = (
      <div className="empty empty-compact">
        <div className="empty-title">还没有自动忽略的发信人</div>
        <div className="empty-desc">在消息详情的发信人处、群组管理的「成员」里、联系人页点「自动忽略」</div>
      </div>
    )
  } else {
    body = (
      <div className="im-mute-list" role="list" aria-label="自动忽略的发信人">
        {list.map((m) => (
          <div key={m.id} role="listitem" className="im-mute-item" aria-label={m.name}>
            <div className="im-mute-main">
              <div className="im-mute-name ellipsis">{m.name}</div>
              <div className="im-muted im-mute-sub">
                <span className="ellipsis">{muteWhoText(m, m.channel ? channelOf(channels, m.channel).label : '')}</span>
                <span>{muteScopeText(m)}</span>
              </div>
              <div className="im-muted im-mute-sub">
                <span>{m.ignored > 0 ? `已自动忽略 ${m.ignored} 条${m.last_at ? `，最近 ${timeAgo(m.last_at)}` : ''}` : '还没忽略过消息'}</span>
                <span title={new Date(m.created_at).toLocaleString('zh-CN')}>{timeAgo(m.created_at)}标记</span>
              </div>
            </div>
            <div className="im-mute-acts">
              <button type="button" className="im-act" onClick={() => onShowMessages(m.name)} title="回到消息页「已忽略」，按这个名字搜">看消息</button>
              <button type="button" className="im-act im-act-quiet" aria-label={`取消自动忽略 ${m.name}`} onClick={() => setCancel(m)}>取消</button>
            </div>
          </div>
        ))}
      </div>
    )
  }
  return (
    <Drawer open onClose={onClose} kicker="IM 消息" aria-label="自动忽略" className="im-mutedrawer">
      <h2 className="im-chhead">自动忽略</h2>
      <p className="im-ga-desc">这些发信人的消息一收到就进「已忽略」：已读、不计未读、不通知，也不触发 SOP 的 IM 流程和 Agent 的 IM 触发。取消后新消息恢复正常，已忽略的不自动恢复。</p>
      {note && <div className="im-ga-note" role="status">{note}</div>}
      {body}
      {cancel && <UnmuteDialog mute={cancel} onClose={() => setCancel(null)} onDone={setNote} />}
    </Drawer>
  )
}
