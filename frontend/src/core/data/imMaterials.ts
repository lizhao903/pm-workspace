// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 消息转项目资料（0009）：一条消息或合并显示的一组，正文按时间拼成一段对话记录，存成项目的一条笔记（kind=note）。
// 插件之间不能互调，由这里组合请求：先 POST /api/projects/{id}/materials 建笔记，再 POST /api/im/materials 记出处（消息 id、渠道、会话、发信人、时间）；
// 选了「连附件一起加入资料」的，逐个走附件面板同一条路径（addAttachmentToProject：没获取的先获取，加上后记出处 kind=attachment），
// 已经在这个项目资料里的附件跳过。记出处失败时笔记已经建了，照样能用（只是两边看不到来源），结果里带上原因。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isApiError } from '../api'
import { addAttachmentToProject, attachmentAdded } from './attachments'
import { imApi, type ImMessage } from './im'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'
import { projectMaterialsApi, type ProjectMaterial } from './materials'

/** 转成的笔记打的标签 */
export const IM_MATERIAL_TAG = 'IM 消息'
/** 笔记正文的上限（契约：note 最多 5000 字） */
export const IM_NOTE_MAX = 5000

export type ImToMaterialInput = {
  /** 这条消息，或合并显示的一组 */
  messages: readonly ImMessage[]
  projectId: string
  title: string
  body: string
  /** 一起加进资料的附件 */
  attachments: { messageId: string; attachmentId: string }[]
}

export type ImToMaterialResult = {
  material: ProjectMaterial
  /** 记出处没成功的原因；成功为 null */
  linkError: unknown
  /** 附件：加上的、本来就在这个项目资料里跳过的、没加上的（带原因），都是附件名 */
  attachments: { added: string[]; skipped: string[]; failed: { name: string; error: unknown }[] }
}

/** 转项目资料：建笔记、记出处，再按需加附件；成败都刷消息和这个项目的资料 */
export function useImToMaterial() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: async (input: ImToMaterialInput): Promise<ImToMaterialResult> => {
      const ids = [...input.messages].sort((a, b) => a.at.localeCompare(b.at)).map((m) => m.id)
      const material = await projectMaterialsApi.add(input.projectId, {
        kind: 'note', name: input.title.trim(), value: input.body.trim(), tags: [IM_MATERIAL_TAG],
      })
      let linkError: unknown = null
      await imApi.linkMaterial({ material_id: material.id, project_id: input.projectId, message_ids: ids, title: material.name, kind: 'messages' })
        .catch((e: unknown) => { linkError = e })
      const out: ImToMaterialResult['attachments'] = { added: [], skipped: [], failed: [] }
      if (input.attachments.length) {
        const existing = await projectMaterialsApi.list(input.projectId).catch(() => [] as ProjectMaterial[])
        // 获取过附件的消息换成响应里的新消息（带 local），同一条消息后面的附件用最新的
        const latest = new Map(input.messages.map((m) => [m.id, m]))
        for (const ref of input.attachments) {
          const msg = latest.get(ref.messageId)
          const a = msg?.attachments.find((x) => x.id === ref.attachmentId)
          if (!msg || !a) continue
          if (attachmentAdded(existing, a)) { out.skipped.push(a.name); continue }
          try {
            const r = await addAttachmentToProject(qc, notify, { message: msg, attachmentId: a.id, projectId: input.projectId })
            latest.set(r.message.id, r.message)
            out.added.push(a.name)
          } catch (e) {
            out.failed.push({ name: a.name, error: e })
          }
        }
      }
      return { material, linkError, attachments: out }
    },
    onSettled: (_r, _e, v) => Promise.all([notify({ kind: 'project-material', projectId: v.projectId }), notify({ kind: 'im-message' })]),
  })
}

/** 插件没装或停用时接口 404，不重试 */
const noRetry404 = (n: number, e: unknown) => !isApiError(e, 'not_found') && n < 2

/** 项目里来自消息的资料的出处（资料页显示「来自 IM 消息」）；IM 插件没在跑时不取 */
export function useImMaterialSources(projectId: string, enabled = true) {
  return useQuery({
    queryKey: dataKeys.im.materials(projectId),
    queryFn: ({ signal }) => imApi.materialSources(projectId, signal),
    enabled: enabled && !!projectId,
    retry: noRetry404,
  })
}

/** 资料移除后清掉出处；没记过（404）不算错 */
export function useUnlinkImMaterial() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (materialId: string) => imApi.unlinkMaterial(materialId).catch((e: unknown) => {
      if (!isApiError(e, 'not_found')) throw e
      return null
    }),
    onSettled: () => notify({ kind: 'im-message' }),
  })
}
