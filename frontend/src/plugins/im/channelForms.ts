// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 渠道配置里各渠道的表单（IM-01b 搭框架，Slack、Telegram 各一个）。没在这里的 IM 渠道去设置里的连接器页配。
import type { ComponentType } from 'react'
import type { Connector } from '../../core/data'
import { SlackForm } from './SlackForm'
import { TelegramForm } from './TelegramForm'

export type ChannelFormProps = {
  /** 已有的实例：改配置；没有时新建 */
  connector?: Connector | null
  /** 保存并测试过：带着最新的实例 */
  onSaved?: (c: Connector) => void
  onCancel?: () => void
}

export const CHANNEL_FORMS: Record<string, ComponentType<ChannelFormProps>> = {
  slack: SlackForm,
  telegram: TelegramForm,
}
