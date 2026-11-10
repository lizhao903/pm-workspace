// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 快捷回复取设置里的（GET /api/im/settings 的 quick_replies），抽屉「反馈」和列表「回复」菜单共用。
import { useImSettings } from '../../core/data'
import { QUICK_REPLIES } from './model'

/** 设置里的快捷回复；设置还没取回来（或取失败）时先用内置的几条，免得菜单空着 */
export function useQuickReplies(): readonly { text: string; done: boolean }[] {
  const s = useImSettings()
  return s.data?.quick_replies ?? QUICK_REPLIES
}
