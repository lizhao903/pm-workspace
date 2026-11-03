// 消息附件（IM-04b）：获取到本地、读内容的地址、加进项目资料、项目里选了「不加入」的记录。
// 契约见 docs/api-contract.md「IM 消息插件 im」的「附件获取」（IM-04a）。插件之间不能互调，加进资料由这里组合两次请求：
// 文件、图片还没获取的先 POST .../fetch，再 POST /api/projects/{id}/materials（value 填 local，链接填 url，打「消息附件」标签）。
// 「已加入」按 value 认（契约：同一附件重复加由前端按 value 去重）。加上后再调 POST /api/im/materials 记出处（0009，kind=attachment），
// 项目资料页据此显示「来自 <发信人>（<群名或私聊>）的消息」；记出处失败不影响已加上的资料。
// 获取的响应是改后的整条消息，先写回缓存再报 im-message；加进资料报 project-material，清掉不加入记录时另报 object。
import { useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { isApiError, objects, readRawText, request, type WorkObject } from '../api'
import { apiBase } from '../api/client'
import { imApi, normMessage, type ImAttachment, type ImMessage } from './im'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'
import { projectMaterialsApi, type ProjectMaterial, type ProjectMaterialInput } from './materials'
import { useAllObjects } from './objects'
import { PROJECT_TYPE } from './projects'
import { projectConversationsApi } from './projectConversations'

/** 获取成功后后端多给一个读内容的地址 */
export type ImAttachmentFile = ImAttachment & { download_url?: string }
export type ImAttachmentStorage = { dir: string; max_bytes: number }

/** 加进资料时打的标签（SPEC-messages-3.9） */
export const ATTACHMENT_TAG = '消息附件'
export const ATTACH_KIND: Record<ImAttachment['kind'], string> = { file: '文件', image: '图片', link: '链接' }
/** 项目 props 里「不加入」的附件 */
export const PROP_SKIPPED_ATTACHMENTS = 'skipped_attachments'

const msgPath = (id: string) => `/api/im/messages/${encodeURIComponent(id)}`

export const attachmentsApi = {
  /** 下载一个附件；已获取且文件还在的直接回 */
  fetch: async (messageId: string, attachmentId: string) =>
    normMessage(await request<ImMessage>('POST', `${msgPath(messageId)}/attachments/${encodeURIComponent(attachmentId)}/fetch`)),
  storage: (signal?: AbortSignal) => request<ImAttachmentStorage>('GET', '/api/im/attachments', { signal }),
}

/** 附件大小写成 B、KB、MB；没有时为空串 */
export const fmtBytes = (n?: number | null) => (n === undefined || n === null ? ''
  : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`)

/** 文件、图片要先获取；链接不用 */
export const needsFetch = (a: ImAttachment) => a.kind !== 'link' && a.fetch !== 'done'

/** 预览方式：按扩展名定；none 是不能在页面里看，只能下载 */
export type PreviewKind = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'none'

const PREVIEW_EXT: Record<string, PreviewKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', avif: 'image',
  pdf: 'pdf',
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', aac: 'audio', flac: 'audio',
  txt: 'text', log: 'text', md: 'text', csv: 'text', tsv: 'text', json: 'text', yaml: 'text', yml: 'text', xml: 'text', ini: 'text', conf: 'text',
}

/** 附件能怎么预览：链接不在这里看；图片类附件没认出扩展名时也按图片试 */
export function previewKind(a: ImAttachment): PreviewKind {
  if (a.kind === 'link') return 'none'
  const ext = a.name.includes('.') ? a.name.split('.').pop()!.toLowerCase() : ''
  return PREVIEW_EXT[ext] ?? (a.kind === 'image' ? 'image' : 'none')
}

/**
 * 预览用的地址：图片、PDF、音视频带 ?inline=1（后端只对这几类按 inline 回，SVG、HTML 照旧下载）；
 * 文本用普通地址由前端读出来显示。没获取的回 null
 */
export function attachmentPreviewHref(a: ImAttachmentFile): string | null {
  const href = attachmentHref(a)
  if (!href || a.kind === 'link') return null
  const k = previewKind(a)
  return k === 'image' || k === 'pdf' || k === 'video' || k === 'audio' ? `${href}${href.includes('?') ? '&' : '?'}inline=1` : href
}

/** 文本预览最多读这么多字节，再多提示下载看全文 */
export const TEXT_PREVIEW_MAX = 512 * 1024

/** 文本附件的内容（预览用），读前 TEXT_PREVIEW_MAX 字节；src 为空时不取 */
export function useAttachmentText(src: string | null) {
  return useQuery({
    queryKey: ['im-attachment-text', src ?? ''],
    queryFn: ({ signal }) => readRawText(src ?? '', TEXT_PREVIEW_MAX, signal),
    enabled: !!src,
    staleTime: Infinity,
    retry: false,
  })
}

/** 读内容的地址：获取过的文件、图片才有 */
export function attachmentHref(a: ImAttachmentFile): string | null {
  if (a.kind === 'link') return a.url || null
  if (a.fetch !== 'done' || !a.download_url) return null
  return `${apiBase()}${a.download_url}`
}

/**
 * 资料的 value 在附件目录下时，读内容走 /api/im/attachments/{channel}/{name}（契约：用最后两段拼）；不在时返回 null。
 * 附件目录不能挂载，/api/fs/read 不读它。
 */
export function attachmentContentUrl(value: string, dir: string): string | null {
  const d = dir.replace(/\/+$/, '')
  if (!d || !value.startsWith(`${d}/`)) return null
  const rest = value.slice(d.length + 1).split('/')
  if (rest.length !== 2 || !rest[0] || !rest[1]) return null
  return `${apiBase()}/api/im/attachments/${encodeURIComponent(rest[0])}/${encodeURIComponent(rest[1])}`
}

/** 加进资料的那一条；文件还没获取（没有 local）时返回 null */
export function attachmentMaterial(a: ImAttachment): ProjectMaterialInput | null {
  if (a.kind === 'link') return a.url ? { kind: 'link', value: a.url, name: a.name, tags: [ATTACHMENT_TAG] } : null
  if (a.fetch !== 'done' || !a.local) return null
  return { kind: 'file', value: a.local, name: a.name, tags: [ATTACHMENT_TAG] }
}

/** 这个附件加进去的那条资料：按 value 认，文件比 local、链接比 url；没加过返回 undefined */
export function attachmentAddedAs(materials: readonly ProjectMaterial[] | undefined, a: ImAttachment): ProjectMaterial | undefined {
  const v = a.kind === 'link' ? a.url : a.fetch === 'done' ? a.local : ''
  if (!v || !materials) return undefined
  const kind = a.kind === 'link' ? 'link' : 'file'
  return materials.find((m) => m.kind === kind && m.value === v)
}

/** 这个附件已经在这份资料里 */
export const attachmentAdded = (materials: readonly ProjectMaterial[] | undefined, a: ImAttachment): boolean => !!attachmentAddedAs(materials, a)

/** 「不加入」记录的键：消息 id + 附件 id（渠道给的附件 id 只在一条消息里唯一） */
export const skipKey = (messageId: string, attachmentId: string) => `${messageId}:${attachmentId}`

/** 项目 props 里「不加入」的附件；不是字符串数组时按空 */
export function skippedAttachments(o: WorkObject | undefined): string[] {
  const v = o?.props?.[PROP_SKIPPED_ATTACHMENTS]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** 读回最新 props 改「不加入」记录（一次可改多个），别的 key 原样留着；没变化返回 null */
async function saveSkipped(projectId: string, keys: string | readonly string[], skip: boolean): Promise<WorkObject | null> {
  const fresh = await objects.get(projectId)
  const cur = skippedAttachments(fresh)
  const want = new Set(typeof keys === 'string' ? [keys] : keys)
  const next = skip ? [...cur, ...[...want].filter((k) => !cur.includes(k))] : cur.filter((x) => !want.has(x))
  if (next.length === cur.length) return null
  return objects.patch(projectId, { props: { ...(fresh.props ?? {}), [PROP_SKIPPED_ATTACHMENTS]: next } })
}

/** 响应里的最新消息写进全部消息、单条、各会话的缓存 */
function putMessage(qc: QueryClient, m: ImMessage) {
  const swap = (old: ImMessage[] | undefined) => old?.map((x) => (x.id === m.id ? m : x))
  qc.setQueryData<ImMessage[]>(dataKeys.im.list, swap)
  qc.setQueryData(dataKeys.im.detail(m.id), m)
  qc.setQueriesData<ImMessage[]>({ queryKey: ['im', 'conversation'] }, swap)
}

/** 插件没装或停用时接口 404，不重试 */
const noRetry404 = (n: number, e: unknown) => !isApiError(e, 'not_found') && n < 2

/** 附件目录和大小上限 */
export function useImAttachmentStorage(enabled = true) {
  return useQuery({
    queryKey: dataKeys.im.attachmentStorage,
    queryFn: ({ signal }) => attachmentsApi.storage(signal),
    enabled,
    retry: noRetry404,
    staleTime: 5 * 60_000,
  })
}

export type AttachmentRef = { messageId: string; attachmentId: string }

/** 获取一个附件；失败时后端把原因记在附件上（链接、没接数据目录除外），读回来 */
export function useFetchAttachment() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ messageId, attachmentId }: AttachmentRef) => attachmentsApi.fetch(messageId, attachmentId),
    onSuccess: (m) => {
      putMessage(qc, m)
      return notify({ kind: 'im-message', id: m.id })
    },
    onError: (_e, v) => notify({ kind: 'im-message', id: v.messageId }),
  })
}

export type AddAttachmentInput = { message: ImMessage; attachmentId: string; projectId: string }
export type AddAttachmentResult = { material: ProjectMaterial; message: ImMessage }

type Notify = ReturnType<typeof useNotifyChange>

/**
 * 加进项目资料的一次完整操作，附件面板和「转项目资料」共用：没获取的先获取，成功后再加，失败则不加（SPEC-messages-3.8）；
 * 这个附件在该项目里标过「不加入」的，记录一并清掉（SPEC-messages-3.9）；加上后记出处（0009），记不上不算失败。
 * 刷新项目资料由调用方做（一次加几条时只刷一回）
 */
export async function addAttachmentToProject(qc: QueryClient, notify: Notify, { message, attachmentId, projectId }: AddAttachmentInput): Promise<AddAttachmentResult> {
  let msg = message
  let a = msg.attachments.find((x) => x.id === attachmentId)
  if (!a) throw new Error('这条消息里没有这个附件')
  if (needsFetch(a)) {
    try {
      msg = await attachmentsApi.fetch(msg.id, attachmentId)
    } finally {
      void notify({ kind: 'im-message', id: msg.id })
    }
    putMessage(qc, msg)
    a = msg.attachments.find((x) => x.id === attachmentId)
  }
  const input = a && attachmentMaterial(a)
  if (!input) throw new Error('附件还没获取到本地')
  const material = await projectMaterialsApi.add(projectId, input)
  if (await saveSkipped(projectId, skipKey(msg.id, attachmentId), false).catch(() => null)) {
    await notify({ kind: 'object', id: projectId })
  }
  const linked = await imApi.linkMaterial({
    material_id: material.id, project_id: projectId, message_ids: [msg.id], kind: 'attachment', attachment_id: attachmentId, title: material.name,
  }).then(() => true, () => false)
  if (linked) void notify({ kind: 'im-message', id: msg.id })
  return { material, message: msg }
}

/** 附件面板的「加入资料」：见 addAttachmentToProject */
export function useAddAttachmentToProject() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (input: AddAttachmentInput) => addAttachmentToProject(qc, notify, input),
    onSettled: (_r, _e, v) => notify({ kind: 'project-material', projectId: v.projectId }),
  })
}

/** 项目沟通里选「不加入」或「恢复」 */
export function useSkipAttachment(projectId: string) {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ messageId, attachmentId, skip }: AttachmentRef & { skip: boolean }) =>
      saveSkipped(projectId, skipKey(messageId, attachmentId), skip),
    onSuccess: () => notify({ kind: 'object', id: projectId }),
  })
}

/** 项目附件标签的批量「不加入」/「撤销不加入」：一次读回、一次写 props */
export function useSkipAttachments(projectId: string) {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ refs, skip }: { refs: readonly AttachmentRef[]; skip: boolean }) =>
      saveSkipped(projectId, refs.map((r) => skipKey(r.messageId, r.attachmentId)), skip),
    onSuccess: () => notify({ kind: 'object', id: projectId }),
  })
}

export type AddAttachmentsResult = { added: AddAttachmentResult[]; failed: { input: AddAttachmentInput; error: unknown }[] }

/**
 * 项目附件标签的批量「加入资料」：逐个走 addAttachmentToProject（没获取的先获取），一个失败不挡后面的；
 * 全部跑完刷一回项目资料
 */
export function useAddAttachmentsToProject() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: async (inputs: readonly AddAttachmentInput[]): Promise<AddAttachmentsResult> => {
      const out: AddAttachmentsResult = { added: [], failed: [] }
      for (const input of inputs) {
        try {
          out.added.push(await addAttachmentToProject(qc, notify, input))
        } catch (error) {
          out.failed.push({ input, error })
        }
      }
      return out
    },
    onSettled: (_r, _e, v) => {
      for (const pid of new Set(v.map((x) => x.projectId))) void notify({ kind: 'project-material', projectId: pid })
    },
  })
}

export type AttachmentProject = { id: string; name: string }

export type AttachmentTargets = {
  projects: AttachmentProject[]
  /** 绑了这个会话的项目 id，按项目列表的顺序 */
  suggested: string[]
  /** 项目 id 到资料；还没取到的没有 */
  materials: Map<string, ProjectMaterial[]>
  isPending: boolean
  isError: boolean
}

/**
 * 附件面板挑项目用：全部项目、绑了这条消息所在会话的项目（SPEC-messages-3.6）、每个项目的资料（判断已加入）。
 * enabled=false（项目插件没在跑、消息没有附件）时不发请求。资料和绑定的缓存和项目页同一份。
 */
export function useAttachmentTargets(conversationId: string | null, enabled: boolean): AttachmentTargets {
  const list = useAllObjects({ type: [PROJECT_TYPE], sort: '-updated_at' }, { enabled })
  const live = (list.data?.data ?? []).filter((o) => !o.deleted_at)
  const ids = live.map((o) => o.id)
  const binds = useQueries({
    queries: ids.map((id) => ({
      queryKey: dataKeys.projectConversations(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => projectConversationsApi.list(id, signal),
      enabled: enabled && !!conversationId,
      retry: noRetry404,
    })),
  })
  const mats = useQueries({
    queries: ids.map((id) => ({
      queryKey: dataKeys.projectMaterials(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => projectMaterialsApi.list(id, signal),
      enabled,
      retry: noRetry404,
    })),
  })
  const materials = new Map<string, ProjectMaterial[]>()
  mats.forEach((r, i) => { if (r.data) materials.set(ids[i], r.data) })
  const suggested = conversationId
    ? ids.filter((_, i) => binds[i]?.data?.some((b) => b.conversation_id === conversationId))
    : []
  return {
    projects: live.map((o) => ({ id: o.id, name: o.title })),
    suggested,
    materials,
    isPending: enabled && list.isPending,
    isError: list.isError,
  }
}
