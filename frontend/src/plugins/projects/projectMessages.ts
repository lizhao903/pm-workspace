// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 项目消息（SPEC-projects-0 projectMessages）：项目绑定的会话、IM 插件在不在跑、这些会话里的消息，加上归到这个项目的消息。
// 沟通标签、概览（待回复、最新沟通）、标签条红点、干系人的最近沟通都用它，同一份缓存。
import { useMemo } from 'react'
import { skippedAttachments, useConversationMessages, useEventsLive, usePlugins, useProject, useProjectConversations, useProjectMaterials } from '../../core/data'
import { attachmentRows } from './attachmentModel'
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
  // 绑定会话里的消息，并上归到这个项目的（消息分流）
  const msgs = useConversationMessages(boundIds, { enabled: imOn, refetchInterval: live ? false : POLL_MS, projectId })
  const noIm = (!!plugins.data && !imInfo?.running) || msgs.noPlugin
  // imRunning 只认插件列表里明确在跑的：列表读不出来时不算（附件标签据此显示，列表出错重取时不会忽隐忽现）
  return { binds, bound, boundIds, msgs, noIm, imOn, imRunning: !!imInfo?.running, pluginsPending: plugins.isPending }
}

/** 先渲染这么多行，多的点「再显示」 */
export const ATT_PAGE = 50

/** 附件标签（SPEC-projects-5）：项目消息里的附件行和去向；资料、项目都取到了才 ready */
export function useProjectAttachments(projectId: string) {
  const pm = useProjectMessages(projectId)
  const project = useProject(projectId)
  const mats = useProjectMaterials(projectId)
  const skipped = useMemo(() => skippedAttachments(project.data), [project.data])
  const rows = useMemo(() => attachmentRows(pm.msgs.data, mats.data, skipped), [pm.msgs.data, mats.data, skipped])
  const ready = !pm.noIm && !pm.msgs.isPending && !!mats.data && !!project.data
  return { ...pm, project, mats, rows, ready }
}
