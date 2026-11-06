// IM 消息（IM-02b）：IM 消息插件 im 的消息列表和处理动作。契约见 docs/api-contract.md「IM 消息插件 im」。
// 列表按页拉完（每页 200）放一份缓存，筛选、计数、会话选项都在前端算，口径和原型 MessagesPage 一致。
// 处理动作的响应是改后的整条消息，先写回缓存再按失效规则 im-message 刷一遍；转任务还建了任务，另报 object。
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { isApiError, request, requestList } from '../api'
import { agentApi, setFirstMessage, type SessionSourceRef } from './agent'
import { useNotifyChange } from './invalidate'
import { dataKeys } from './keys'
import type { ImMention } from './imGroups'
import type { ImMessageMute } from './imMutes'

/** expired 已过期（IM-07）：待处理超过设置的天数没处理，后台标的；不算待处理 */
export type ImMsgStatus = 'pending' | 'done' | 'ignored' | 'expired'
/** 与我相关的原因：@我、@所有人、私聊；无关为空串 */
export type ImRelevance = 'me' | 'all' | 'dm' | ''

export type ImAttachment = {
  id: string
  name: string
  kind: 'file' | 'image' | 'link'
  size?: number
  url?: string
  fetch?: 'idle' | 'fetching' | 'done' | 'error'
  local?: string
  error?: string
}

export type ImReply = { id: string; text: string; status: 'sent' | 'failed'; error: string; external_id: string; at: string }

export type ImMessage = {
  id: string
  channel: string
  connector_id: string
  external_id: string
  conversation_id: string | null
  conversation_external_id: string
  conversation_kind: 'group' | 'direct' | string
  /** 群名；私聊为空串 */
  conversation: string
  sender_id: string
  sender_name: string
  identity_id: string | null
  stakeholder_id: string | null
  /** 认上联系人时的姓名，认不上为空串 */
  contact_name: string
  text: string
  attachments: ImAttachment[]
  relevance: ImRelevance
  status: ImMsgStatus
  read: boolean
  snooze_until: string | null
  /** 标为已过期的时间（IM-07）；不是已过期时为 null */
  expired_at: string | null
  at: string
  received_at: string
  adapter: string
  task_id: string | null
  task_ref: string
  replies: ImReply[]
  /** 最近一次发送失败的原因，再发成功后清空 */
  reply_error: string
  /** 归到的项目（消息分流）：SOP 节点 im_set_project 或抽屉里手动设；没归、项目删了为 null 和空串。
   * 消息自己没归时按所在群组的默认项目兜底 */
  project_id: string | null
  project_name: string
  /** 归属的来源：message 消息上设的，conversation 群组默认项目，没归为空串 */
  project_source: 'message' | 'conversation' | ''
  /** 从这条消息发起的 Agent 会话，新的在前（0008）；会话删了跟着没 */
  sessions: ImMessageSession[]
  /** 会话里拆出来、来源指向这条消息的任务（不含转任务那条 task_id），软删的不列 */
  split_tasks: ImSplitTask[]
  /** 这条消息转成的项目资料（0009）：正文转的笔记、附件加进的资料，新的在前；项目删了的不列 */
  materials: ImMessageMaterial[]
  /** 消息列回复（0010，Slack 在消息列里回复的）属于哪个消息列；不是消息列回复的为 null */
  thread: ImMessageThread | null
  /** 这条作为父消息时，收到的消息列回复条数（不含我回的） */
  reply_count: number
  /** 这条来信回复的「我发出的」那条（0.17.0）：thread 是在它的消息列里回复，next 是发出后同会话第一条来信；对不上为 null */
  replied_sent?: { outbox_id: string; text: string; at: string; via: 'thread' | 'next' | string } | null
  /** 因发信人被设为自动忽略才进「已忽略」的（0.27.0，TSK-0495）：被改回待处理、标为已处理后为 null */
  muted?: ImMessageMute | null
}

/**
 * 消息列回复属于哪个消息列：parent_external_id 是父消息的渠道编号；父消息在库里时 parent_message_id 是它的 id，否则为 null。
 * parent_sender_name、parent_text 是父消息的发信人和正文摘要（至多 80 字），父消息不在库里时取到达时的快照，都没有为空串
 */
export type ImMessageThread = {
  parent_external_id: string
  parent_message_id: string | null
  parent_sender_name: string
  parent_text: string
}

/** 发起会话时的意图：chat 发起会话，split 拆分任务 */
export type ImSessionIntent = 'chat' | 'split'
export type ImMessageSession = { session_id: string; intent: ImSessionIntent | (string & {}); at: string }
export type ImSplitTask = { id: string; ref: string; title: string }
/** 资料的来源种类：messages 消息正文拼成的笔记，attachment 消息附件 */
export type ImMaterialKind = 'messages' | 'attachment'
/** 消息上的「已转资料」：那条资料在哪个项目、登记时的标题、一共来自几条消息（判断是不是同一组） */
export type ImMessageMaterial = {
  material_id: string
  project_id: string
  project_name: string
  kind: ImMaterialKind | (string & {})
  attachment_id: string
  title: string
  count: number
  at: string
}
/**
 * 一条资料的出处（0009，GET /api/im/materials?project_id=）：登记时的快照，消息以后被清理了也还在。
 * conversation 是群名，私聊为空串（这时 senders[0] 是对方）；message_ids 按时间正序
 */
export type ImMaterialSource = {
  material_id: string
  project_id: string
  kind: ImMaterialKind | (string & {})
  attachment_id: string
  title: string
  channel: string
  conversation_id: string | null
  conversation: string
  senders: string[]
  message_ids: string[]
  first_at: string
  last_at: string
  created_at: string
}
/** 把建好的资料记成来自这组消息（POST /api/im/materials）；附件 kind=attachment，带 attachment_id、只一条消息 */
export type ImMaterialLinkInput = {
  material_id: string
  project_id: string
  message_ids: string[]
  title?: string
  kind?: ImMaterialKind
  attachment_id?: string
}
export type ImMaterialLinkResult = { source: ImMaterialSource; messages: ImMessage[] }
/** 把建好的会话记到一组消息上（POST /api/im/sessions）；回记好后的这组消息 */
export type ImSessionLinkInput = { session_id: string; message_ids: string[]; intent: ImSessionIntent }
export type ImSessionLinkResult = { session_id: string; intent: ImSessionIntent; messages: ImMessage[] }

/** 群组默认归属的项目：一个会话最多一个；清除后 project_id 为 null */
export type ImConversationProject = {
  conversation_id: string
  project_id: string | null
  project_ref: string
  project_name: string
  updated_at: string
}

export type ImAction =
  | { kind: 'done' | 'ignore' | 'reopen' | 'read' }
  | { kind: 'snooze'; until: string }
  /** mentions 是正文里要真正 @ 到的人（0.18.0），没有时不带 */
  | { kind: 'reply'; text: string; done: boolean; mentions?: ImMention[] }
  /** 归到项目（项目 id、编号或名字），null 是清除 */
  | { kind: 'project'; project_id: string | null }

/** 立即同步一个渠道的结果（IM-01b）：新落库的消息 id 和已收过的条数 */
export type ImSyncResult = { connector_id: string; adapter: string; ids: string[]; duplicates: number }

/** 批量处理完或忽略（PR-03）：按 id 列表，或按会话 + 时间点之前；只改待处理的，按 id 时已过期的也改（IM-07） */
export type ImBatchInput =
  | { action: 'done' | 'ignore'; ids: string[] }
  | { action: 'done' | 'ignore'; conversation_id: string; before: string }
export type ImBatchResult = { action: 'done' | 'ignore'; ids: string[]; count: number }
/** 批量接口一次最多的 id 数（同后端校验）；更多时 useImBatch 分批调、合并结果 */
export const IM_BATCH_MAX = 500

/** 一条快捷回复；done 为真的发完同时把消息标为已处理 */
export type ImQuickReply = { text: string; done: boolean }
/**
 * IM 插件的设置：expire_days 是多少天没处理算已过期，0 为不过期（IM-07）；
 * quick_replies 是消息抽屉「反馈」和列表快捷回复菜单里的那几条，没设过后端回内置的四条，PATCH 整组替换
 */
export type ImSettings = {
  expire_days: number; quick_replies: ImQuickReply[]
  /** 手动转任务（转任务、拆分任务）后发起内置 SOP「FDE 反馈转发」，默认关（TSK-0468） */
  fde_forward: boolean
}
/** 过期天数的取值范围（同后端校验） */
export const IM_EXPIRE_DAYS_MAX = 365
/** 快捷回复的条数和每条字数上限（同后端校验） */
export const IM_QUICK_REPLIES_MAX = 20
export const IM_QUICK_REPLY_TEXT_MAX = 200

/** reply_on_done：执行完成后在原消息里回复（SPEC-messages-2.50），不传后端默认要 */
export type ImTaskInput = {
  title?: string; body?: string; priority?: string; project_id?: string; owner_id?: string; due_at?: string; done?: boolean
  reply_on_done?: boolean
}
/** 回执流程（内置 SOP「IM 任务回执」）发起结果：enabled 为假时 note 说原因 */
export type ImTaskReply = { enabled: boolean; run_id?: string; note?: string }
export type ImTaskResult = {
  message: ImMessage
  task: { id: string; ref: string; title: string; status: string; source: string }
  reply?: ImTaskReply
}

/** 一页最多 200 条（契约上限） */
export const IM_PAGE_MAX = 200

// 后端的空数组可能是 null，这里一次补齐
export const normMessage = (m: ImMessage): ImMessage => ({
  ...m, attachments: m.attachments ?? [], replies: m.replies ?? [], conversation: m.conversation ?? '', contact_name: m.contact_name ?? '',
  reply_error: m.reply_error ?? '', task_ref: m.task_ref ?? '', relevance: m.relevance ?? '', expired_at: m.expired_at ?? null,
  project_id: m.project_id ?? null, project_name: m.project_name ?? '', project_source: m.project_source ?? '',
  sessions: m.sessions ?? [], split_tasks: m.split_tasks ?? [], materials: m.materials ?? [],
  thread: m.thread ?? null, reply_count: m.reply_count ?? 0, replied_sent: m.replied_sent ?? null, muted: m.muted ?? null,
})

const path = (id: string) => `/api/im/messages/${encodeURIComponent(id)}`

export const imApi = {
  page: async (offset: number, signal?: AbortSignal) => {
    const query = new URLSearchParams({ limit: String(IM_PAGE_MAX), offset: String(offset) })
    const r = await requestList<ImMessage>('/api/im/messages', { query, signal })
    return { ...r, data: r.data.map(normMessage) }
  },
  /** 按页拉完，按发送时间倒序 */
  all: async (signal?: AbortSignal) => {
    const out: ImMessage[] = []
    for (let offset = 0; ; offset += IM_PAGE_MAX) {
      const r = await imApi.page(offset, signal)
      out.push(...r.data)
      if (!r.data.length || out.length >= r.total) return out
    }
  },
  get: async (id: string, signal?: AbortSignal) => normMessage(await request<ImMessage>('GET', path(id), { signal })),
  act: async (id: string, a: ImAction) => {
    const body = a.kind === 'snooze' ? { until: a.until } : a.kind === 'reply' ? { text: a.text, done: a.done, ...(a.mentions?.length ? { mentions: a.mentions } : {}) }
      : a.kind === 'project' ? { project_id: a.project_id } : {}
    return normMessage(await request<ImMessage>('POST', `${path(id)}/${a.kind}`, { body }))
  },
  /** 立即同步一个 IM 渠道：渠道出错回 502 sync_failed（连接器已置为异常），暂停、不能同步 409 */
  syncConnector: async (connectorId: string) => {
    const r = await request<ImSyncResult>('POST', `/api/im/connectors/${encodeURIComponent(connectorId)}/sync`, { body: {} })
    return { ...r, ids: r.ids ?? [] }
  },
  batch: async (input: ImBatchInput) => {
    const r = await request<ImBatchResult>('POST', '/api/im/messages/batch', { body: input })
    return { ...r, ids: r.ids ?? [] }
  },
  settings: (signal?: AbortSignal) => request<ImSettings>('GET', '/api/im/settings', { signal }),
  /** 天数不在 0..365 回 400 validation；改短了后端马上把超期的标为已过期 */
  patchSettings: (patch: Partial<ImSettings>) => request<ImSettings>('PATCH', '/api/im/settings', { body: patch }),
  /** 设了默认项目的群组（项目删了的不列） */
  conversationProjects: async (signal?: AbortSignal) => (await requestList<ImConversationProject>('/api/im/conversation-projects', { signal })).data,
  /** 设群组的默认项目（项目 id、编号或名字），null 是清除；项目不存在 400，会话不存在 404 */
  setConversationProject: (conversationId: string, projectId: string | null) =>
    request<ImConversationProject>('PUT', `/api/im/conversation-projects/${encodeURIComponent(conversationId)}`, { body: { project_id: projectId } }),
  /** 消息有不存在的 404，会话不存在 400；同一组再记一次不重复 */
  linkSession: async (input: ImSessionLinkInput) => {
    const r = await request<ImSessionLinkResult>('POST', '/api/im/sessions', { body: input })
    return { ...r, messages: (r.messages ?? []).map(normMessage) }
  },
  /** 记资料的出处：消息有不存在的 404；项目不存在 400；同一条资料再记 409 */
  linkMaterial: async (input: ImMaterialLinkInput) => {
    const r = await request<ImMaterialLinkResult>('POST', '/api/im/materials', { body: input })
    return { ...r, messages: (r.messages ?? []).map(normMessage) }
  },
  /** 项目里来自消息的资料的出处，新的在前 */
  materialSources: async (projectId: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ project_id: projectId })
    const rows = (await requestList<ImMaterialSource>('/api/im/materials', { query, signal })).data
    return rows.map((s) => ({ ...s, senders: s.senders ?? [], message_ids: s.message_ids ?? [] }))
  },
  /** 资料移除了，出处一起清掉；没记过 404 */
  unlinkMaterial: (materialId: string) => request<null>('DELETE', `/api/im/materials/${encodeURIComponent(materialId)}`),
  toTask: async (id: string, body: ImTaskInput) => {
    const r = await request<ImTaskResult>('POST', `${path(id)}/task`, { body })
    return { ...r, message: normMessage(r.message) }
  },
}

/** 插件没装或停用时接口 404，不重试 */
const noRetry404 = (n: number, e: unknown) => !isApiError(e, 'not_found') && n < 2

/** 全部消息；refetchInterval 给事件流断开时轮询用 */
export function useImMessages(opts: { refetchInterval?: number | false } = {}) {
  return useQuery({
    queryKey: dataKeys.im.list,
    queryFn: ({ signal }) => imApi.all(signal),
    retry: noRetry404,
    refetchInterval: opts.refetchInterval,
  })
}

/** 待处理（不含稍后、还没到点的）的条数，侧栏红点用；只取一条，读 meta.total。在 im 前缀下，消息一变跟着刷 */
export function useImPendingCount(opts: { enabled?: boolean; refetchInterval?: number } = {}) {
  return useQuery({
    queryKey: [...dataKeys.im.all, 'pending-count'] as const,
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({ status: 'pending', snoozed: 'false', limit: '1' })
      return (await requestList<ImMessage>('/api/im/messages', { query, signal })).total
    },
    enabled: opts.enabled ?? true,
    retry: noRetry404,
    refetchInterval: opts.refetchInterval,
  })
}

/** 单条；列表里没有（太旧、别处打开）时用它 */
export function useImMessage(id: string | null) {
  return useQuery({
    queryKey: dataKeys.im.detail(id ?? ''),
    queryFn: ({ signal }) => imApi.get(id!, signal),
    enabled: !!id,
    retry: noRetry404,
  })
}

/** 响应里的最新消息先写进缓存，界面不用等重新取 */
function putMessage(qc: QueryClient, m: ImMessage) {
  qc.setQueryData<ImMessage[]>(dataKeys.im.list, (old) => old?.map((x) => (x.id === m.id ? m : x)))
  qc.setQueryData(dataKeys.im.detail(m.id), m)
}

export function useImAction() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: ImAction }) => imApi.act(id, action),
    onSuccess: (m) => {
      putMessage(qc, m)
      return notify({ kind: 'im-message', id: m.id })
    },
    // 发送失败（502）时后端记了失败的回复和原因，读回来
    onError: (_e, v) => notify({ kind: 'im-message', id: v.id }),
  })
}

/**
 * 批量处理：成败都整体刷一遍（失败时可能已改了一部分）。
 * 按 id 时超过 IM_BATCH_MAX 条分批依次调，结果合并（ids 拼起来、count 相加）；中途有一批失败就停，报那一批的错
 */
export function useImBatch() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: async (input: ImBatchInput): Promise<ImBatchResult> => {
      if (!('ids' in input) || input.ids.length <= IM_BATCH_MAX) return imApi.batch(input)
      const out: ImBatchResult = { action: input.action, ids: [], count: 0 }
      for (let i = 0; i < input.ids.length; i += IM_BATCH_MAX) {
        const r = await imApi.batch({ action: input.action, ids: input.ids.slice(i, i + IM_BATCH_MAX) })
        out.ids.push(...r.ids)
        out.count += r.count
      }
      return out
    },
    onSettled: () => notify({ kind: 'im-message' }),
  })
}

export function useImToTask() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ImTaskInput }) => imApi.toTask(id, input),
    onSuccess: async (r) => {
      putMessage(qc, r.message)
      await Promise.all([notify({ kind: 'im-message', id: r.message.id }), notify({ kind: 'object', id: r.task.id })])
    },
    // 已经转过（409）时读回消息，拿到那条任务
    onError: (_e, v) => notify({ kind: 'im-message', id: v.id }),
  })
}

/** 从消息发起会话（0008）：要建的会话（挂哪个 Agent、标题、工作目录、来源）、第一句话、记到哪几条消息上 */
export type ImStartSessionInput = {
  agent_id: string
  title: string
  workdir?: string
  source_ref: SessionSourceRef
  /** 打开会话时自动发出的第一句话 */
  prompt: string
  message_ids: string[]
  intent: ImSessionIntent
}

/**
 * 从一条（或合并显示的一组）消息发起 Agent 会话：先建会话（带来源），再记到这组消息上，最后记下第一句话，
 * 会话页打开它时自动发出。记到消息上失败时会话已经建了，照样能用（只是消息上看不到「已发起会话」），错误照抛
 */
export function useImStartSession() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: async (input: ImStartSessionInput) => {
      const s = await agentApi.createSession({ agent_id: input.agent_id, title: input.title, workdir: input.workdir || undefined, source_ref: input.source_ref })
      setFirstMessage(s.id, input.prompt)
      await notify({ kind: 'agent-session' })
      const r = await imApi.linkSession({ session_id: s.id, message_ids: input.message_ids, intent: input.intent })
      for (const m of r.messages) putMessage(qc, m)
      return { session: s, messages: r.messages }
    },
    onSettled: () => notify({ kind: 'im-message' }),
  })
}

/** 立即同步一个渠道（IM-01b）：成败都会改连接器的同步时间或状态，消息和连接器都刷一遍 */
export function useImSyncConnector() {
  const notify = useNotifyChange()
  const refresh = () => Promise.all([notify({ kind: 'im-message' }), notify({ kind: 'connector' })])
  return useMutation({
    mutationFn: (connectorId: string) => imApi.syncConnector(connectorId),
    onSuccess: () => refresh(),
    onError: () => refresh(),
  })
}

/** IM 插件的设置（IM-07） */
export function useImSettings() {
  return useQuery({
    queryKey: dataKeys.im.settings,
    queryFn: ({ signal }) => imApi.settings(signal),
    retry: noRetry404,
  })
}

/** 改设置：响应写回缓存；过期天数改短时后端当场标了一批已过期，消息跟着刷 */
export function usePatchImSettings() {
  const qc = useQueryClient()
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: (patch: Partial<ImSettings>) => imApi.patchSettings(patch),
    onSuccess: (r) => {
      qc.setQueryData(dataKeys.im.settings, r)
      return notify({ kind: 'im-message' })
    },
  })
}

/** 群组默认归属的项目，按会话 id 查 */
export function useImConversationProjects(enabled = true) {
  return useQuery({
    queryKey: dataKeys.im.conversationProjects,
    queryFn: async ({ signal }) => new Map((await imApi.conversationProjects(signal)).map((x) => [x.conversation_id, x])),
    enabled,
    retry: noRetry404,
  })
}

/** 改群组的默认项目：没归项目的消息跟着变，消息和设置一起刷（都在 im 前缀下） */
export function useSetImConversationProject() {
  const notify = useNotifyChange()
  return useMutation({
    mutationFn: ({ conversationId, projectId }: { conversationId: string; projectId: string | null }) => imApi.setConversationProject(conversationId, projectId),
    onSuccess: () => notify({ kind: 'im-message' }),
  })
}
