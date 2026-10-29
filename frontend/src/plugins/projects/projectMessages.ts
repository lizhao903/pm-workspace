// 项目消息（SPEC-projects-0 projectMessages）：项目绑定的会话、IM 插件在不在跑、这些会话里的消息。
// 沟通标签、概览（待回复、最新沟通）、标签条红点、干系人的最近沟通都用它，同一份缓存。
import { useMemo } from 'react'
import { useConversationMessages, useEventsLive, usePlugins, useProjectConversations } from '../../core/data'
import { IM_PLUGIN } from './commsModel'

/** 事件流断开时轮询 */
const POLL_MS = 30_000

/** 项目绑定的会话和里面的消息；IM 插件列表读不出来时照样去取消息，404 再当没装 */
export function useProjectMessages(projectId: string) {
  const live = useEventsLive()
  const plugins = usePlugins()
  const binds = useProjectConversations(projectId)
  const imInfo = plugins.data?.find((p) => p.id === IM_PLUGIN)
  const imOn = plugins.isError || !!imInfo?.running
  const bound = useMemo(() => binds.data ?? [], [binds.data])
  const boundIds = useMemo(() => bound.map((b) => b.conversation_id), [bound])
  const msgs = useConversationMessages(boundIds, { enabled: imOn, refetchInterval: live ? false : POLL_MS })
  const noIm = (!!plugins.data && !imInfo?.running) || msgs.noPlugin
  return { binds, bound, boundIds, msgs, noIm, imOn, pluginsPending: plugins.isPending }
}
