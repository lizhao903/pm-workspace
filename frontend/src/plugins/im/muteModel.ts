// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 自动忽略发信人（IM 0.27.0，TSK-0495）的显示口径：管理列表、取消确认、消息详情里的说明共用。
import type { ImMessage, ImMute } from '../../core/data'

/** 标的是谁：渠道身份写「Slack · B0…」（认上联系人的带上联系人名），联系人写「联系人 X 的全部 IM 身份」 */
export function muteWhoText(m: ImMute, chLabel = m.channel) {
  if (m.kind === 'contact') return `联系人「${m.contact_name || m.name}」的全部 IM 身份`
  return `${chLabel} · ${m.sender_id}${m.contact_name && m.contact_name !== m.name ? `（联系人 ${m.contact_name}）` : ''}`
}

/** 范围：全部会话，或只在某个会话里（会话删了、私聊写「只在一个会话里」） */
export function muteScopeText(m: ImMute) {
  if (!m.conversation_id) return '全部会话'
  return m.conversation ? `只在「${m.conversation}」里` : '只在一个会话里'
}

/** 消息详情里的原因；不是被自动忽略的回空串 */
export function muteReason(msg: Pick<ImMessage, 'muted'>) {
  const x = msg.muted
  if (!x) return ''
  return `因发信人 ${x.name} 被设为自动忽略${x.active ? '' : '（已取消自动忽略）'}`
}
