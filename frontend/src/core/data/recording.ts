// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 录音转写插件 recording（M1 + M4a + M5）：录音列表/详情、创建草稿、上传音频、重转、删除、设置、工具与模型状态、
// 纪要生成（插件内直连 Agent / SOP）、候选确认建任务、文件清单与下载、说话人识别与声纹绑定。
// 契约见 docs/api-contract.md「录音转写插件 recording」（字段名冻结，前端不改）；音频与文本全程本机，唯一联网是下载模型。
// 组件里不直接 fetch：取数写数都走这里。写操作成功后失效整个 recording 前缀：上传/重转/改文本/生成纪要/确认候选
// 都会改列表、详情、文件、设置和 meta，一起刷。轮询：转写/纪要/说话人任务在跑时列表与详情每 2 秒刷一次；
// 详情在还有待确认候选时也刷（SOP/后台可能继续写候选）。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request, requestEnvelope, requestList } from '../api'
import { apiBase, uploadFile } from '../api/client'

export type RecordingStatus = 'draft' | 'uploaded' | 'transcribing' | 'transcribed' | 'summarizing' | 'ready' | 'failed'
export type RecordingJobStatus = 'pending' | 'running' | 'done' | 'failed'

/** 最新一条未完成或最近完成的后台任务；progress 是 0–100 */
export type RecordingJob = {
  kind: string
  status: RecordingJobStatus
  progress: number
  attempts: number
  last_error: string
}

export type Segment = {
  seq: number
  start_ms: number
  end_ms: number
  text: string
  /** 说话人，M1 不展示 */
  speaker: string
}

/* ---------- M4a：结构化纪要、候选、文件 ---------- */

/** 纪要里的一条待办建议；kind 是 task 或 goal */
export type RecordingAction = {
  title: string
  detail: string
  owner: string
  due: string
  project: string
  confidence: number
  kind: string
}

/** 识别出的项目候选；project_id 是插件按名字匹配到的已有项目，没匹配到空串 */
export type RecordingProject = {
  name: string
  confidence: number
  reason: string
  project_id: string
  project_title: string
}

export type RecordingGoal = {
  title: string
  confidence: number
  reason: string
}

/** AI 没把握、留给用户确认的问题 */
export type RecordingQuestion = {
  question: string
  why: string
  confidence: number
}

/** 流程图节点，kind 为 start / process / decision / end */
export type RecordingFlowNode = {
  id: string
  label: string
  kind: string
}

export type RecordingFlowEdge = {
  from: string
  to: string
  label: string
}

export type RecordingFlow = {
  title: string
  nodes: RecordingFlowNode[]
  edges: RecordingFlowEdge[]
}

export type RecordingTreeNode = {
  label: string
  children: RecordingTreeNode[]
}

export type RecordingTree = {
  title: string
  root: RecordingTreeNode
}

/** 纪要里的流程图和树形图（前端自绘，同时导出 mermaid 源码下载） */
export type RecordingDiagrams = {
  flow: RecordingFlow
  tree: RecordingTree
}

/** 结构化纪要（minutes.json 同结构）；缺字段按空处理 */
export type RecordingMinutes = {
  summary_md: string
  conclusions: string[]
  actions: RecordingAction[]
  projects: RecordingProject[]
  goals: RecordingGoal[]
  questions: RecordingQuestion[]
  diagrams: RecordingDiagrams
  generated_at: string
  model: string
}

export type RecordingFileKind = 'transcript' | 'minutes' | 'minutes_json' | 'diagram_flow' | 'diagram_tree'

/** 录音目录里生成的文件；name 是相对录音目录的路径（如 minutes.md、diagrams/flow.mmd） */
export type RecordingFile = {
  name: string
  kind: RecordingFileKind
  bytes: number
  updated_at: string
}

export type TodoKind = 'project' | 'task' | 'goal'
export type TodoStatus = 'pending' | 'confirmed' | 'ignored'

/** 一条候选（项目/任务/目标），高置信度的推给用户确认，确认后建任务或挂项目 */
export type RecordingTodo = {
  index: number
  kind: TodoKind
  title: string
  detail: string
  confidence: number
  status: TodoStatus
  project_id: string
  project_title: string
  /** 确认后建出来的任务（项目候选为空） */
  object_id: string
  object_ref: string
  reason: string
  owner_name: string
  due_at: string
  created_at: string
  updated_at: string
}

/** POST /todos/{index}/confirm：只带要覆盖的字段；项目候选至少要 project_id */
export type TodoConfirmInput = {
  title?: string
  project_id?: string
  owner_id?: string
  priority?: string
  due_at?: string
}

/** POST /recordings/{id}/sop 的返回：发起的流程与执行 id */
export type RecordingSopResult = {
  flow: string
  run_id: string
}

/* ---------- M5：说话人与声纹 ---------- */

/** 一条录音里识别出的说话人；label 稳定（spk_1…按首次出现顺序），name 是显示名（用户改的 > 联系人名 > 「说话人 N」） */
export type RecordingSpeaker = {
  label: string
  name: string
  contact_id: string
  contact_name: string
  /** 与已登记声纹的最高余弦相似度（0–1，没匹配 0） */
  similarity: number
  /** 分到该说话人的转写段落数 */
  segments: number
  duration_ms: number
  /** true = 自动匹配到联系人（不是手动绑定） */
  detected: boolean
}

/** 已登记到联系人的声纹（一条联系人一条，来自某次录音的说话人绑定） */
export type Voiceprint = {
  contact_id: string
  contact_name: string
  model: string
  source_recording_id: string
  created_at: string
  updated_at: string
}

/** 列表项（不带 transcript/segments） */
export type RecordingSummary = {
  id: string
  title: string
  status: RecordingStatus
  model: string
  duration_ms: number
  has_audio: boolean
  audio_size: number
  project_id: string
  project_title: string
  error: string
  job: RecordingJob | null
  task_count: number
  has_minutes: boolean
  /** 待确认的候选数 */
  todos_pending: number
  /** 识别出的说话人数（没识别 0） */
  speaker_count: number
  created_at: string
  updated_at: string
}

/** 系统里能采集的一块音频设备（GET /audio-devices）；virtual 多半是虚拟声卡，录系统声音选它 */
export type RecordingAudioDevice = {
  index: number
  name: string
  default: boolean
  virtual: boolean
}

/** 设备列表 + 平台/工具信息：supported=false 时（非 macOS）本机采集不可用 */
export type RecordingAudioDeviceList = {
  devices: RecordingAudioDevice[]
  supported: boolean
  platform: string
  ffmpeg: boolean
  error: string
}

/** 一次进行中的系统音频采集（详情里的 capture 字段 / 采集状态接口） */
export type RecordingCapture = {
  running: boolean
  device: number
  device_name: string
  started_at: string
  duration_ms: number
}

/** 详情：在列表字段之外带引擎、语言、正文、纪要、候选 */
export type Recording = Omit<RecordingSummary, 'has_minutes'> & {
  engine: string
  language: string
  audio_mime: string
  transcript: string
  segments: Segment[]
  minutes: RecordingMinutes | null
  minutes_model: string
  todos: RecordingTodo[]
  speakers: RecordingSpeaker[]
  attempts: number
  /** 正在采集系统声音时才有；没有这个字段表示不在采集 */
  capture?: RecordingCapture | null
}

export type RecordingInput = {
  title?: string
  project_id?: string
  model?: string
  language?: string
}

/** PATCH /recordings/{id}：只带要改的字段（后端只认 title/project_id/transcript） */
export type RecordingPatch = {
  title?: string
  project_id?: string
  transcript?: string
}

export type RecordingListFilter = {
  status?: RecordingStatus
  project_id?: string
  q?: string
  limit?: number
  offset?: number
}

export type ToolInfo = {
  path: string
  version: string
  ok: boolean
  error: string
}

export type ModelStatus = 'missing' | 'downloading' | 'ready' | 'error'

export type ModelInfo = {
  name: string
  size: number
  status: ModelStatus
  progress: number
  downloaded_at: string
  error: string
  path: string
}

export type RecordingSettings = {
  default_engine: string
  /** base | small | medium | large-v3-turbo */
  model: string
  /** 空 = CacheDir()/models */
  model_dir: string
  /** 空 = 自动探测 */
  whisper_path: string
  ffmpeg_path: string
  /** whisper 语言码或 auto */
  language: string
  /** 0 = min(8, NumCPU) */
  threads: number
  default_project_id: string
  minutes_provider: string
  minutes_model: string
  /** 自动生成纪要时发起的 SOP 流程（id 或名称），空串 = 插件内直连 Agent */
  minutes_flow: string
  /** 高置信度阈值 0–1，默认 0.7 */
  minutes_threshold: number
  /** 转写完成后自动识别说话人 */
  auto_diarize: boolean
  /** 跑声纹 sidecar 的 Python；空串 = 自动找 python3 */
  python_path: string
  /** FunASR 模型目录；空串 = ModelScope 默认缓存（首次自动下载约 33MB） */
  voiceprint_model_dir: string
  /** 最多识别几个说话人（1–16，默认 8） */
  max_speakers: number
  /** 声纹匹配阈值 0–1（默认 0.65；0 = 全部当同一个人） */
  match_threshold: number
  auto_summarize: boolean
  retention_mode: 'keep' | 'delete_audio_after_ready'
  updated_at: string
}

/** PUT /settings 发全量，updated_at 由后端写 */
export type RecordingSettingsInput = Omit<RecordingSettings, 'updated_at'>

export type RecordingMeta = {
  tools: { whisper: ToolInfo; ffmpeg: ToolInfo }
  models: ModelInfo[]
  settings: RecordingSettings
  model_dir: string
  defaults: { model: string; language: string; threads: number }
}

export const recordingKeys = {
  all: ['recording'] as const,
  list: (f: RecordingListFilter) => ['recording', 'list', f] as const,
  detail: (id: string) => ['recording', 'detail', id] as const,
  files: (id: string, revision = '') => ['recording', 'files', id, revision] as const,
  speakers: (id: string, revision = '') => ['recording', 'speakers', id, revision] as const,
  voiceprints: ['recording', 'voiceprints'] as const,
  audioDevices: ['recording', 'audio-devices'] as const,
  meta: ['recording', 'meta'] as const,
  settings: ['recording', 'settings'] as const,
}

const base = '/api/recording'

/** 转写/纪要任务在跑时的轮询间隔（毫秒）；其余状态不轮询（返回 false） */
const POLL_MS = 2000

function qs(params: Record<string, string | number | undefined>) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v))
  return q
}

function idPath(id: string) {
  return `${base}/recordings/${encodeURIComponent(id)}`
}

export const recordingApi = {
  list: async (f: RecordingListFilter, signal?: AbortSignal) =>
    (await requestList<RecordingSummary>(`${base}/recordings`, { query: qs(f), signal })).data,
  get: (id: string, signal?: AbortSignal) => request<Recording>('GET', idPath(id), { signal }),
  /** 建草稿，title 可空 */
  create: (body: RecordingInput) => request<Recording>('POST', `${base}/recordings`, { body }),
  patch: (id: string, body: RecordingPatch) => request<Recording>('PATCH', idPath(id), { body }),
  /** 清空音频，回 {ok:true} */
  remove: (id: string) => request<{ ok: boolean }>('DELETE', idPath(id)),
  /** multipart：audio 文件 + duration_ms；后端保存后建转写任务，回 202 */
  uploadAudio: (id: string, file: Blob, durationMs: number, filename?: string) =>
    uploadFile<Recording>(`${idPath(id)}/audio`, file, { duration_ms: String(Math.max(0, Math.round(durationMs))) },
      { fileField: 'audio', filename }),
  /** 本机能采集的音频设备；meta 里带平台/ffmpeg 支持情况 */
  audioDevices: async (signal?: AbortSignal): Promise<RecordingAudioDeviceList> => {
    const res = await requestEnvelope<RecordingAudioDevice[] | null>('GET', `${base}/audio-devices`, { signal })
    const meta = (res.meta ?? {}) as unknown as { supported?: boolean; platform?: string; ffmpeg?: boolean; error?: string }
    return {
      devices: res.data ?? [],
      supported: meta.supported ?? false,
      platform: meta.platform ?? '',
      ffmpeg: meta.ffmpeg ?? false,
      error: meta.error ?? '',
    }
  },
  /** 开始采集系统音频（本机 ffmpeg + 虚拟声卡），回 202 + RecordingCapture */
  startCapture: (id: string, device: number) => request<RecordingCapture>('POST', `${idPath(id)}/capture/start`, { body: { device } }),
  /** 查采集状态；没有在采集 404（调用方当 null 处理） */
  captureStatus: (id: string, signal?: AbortSignal) => request<RecordingCapture>('GET', `${idPath(id)}/capture`, { signal }),
  /** 停止并保存；有麦克风就一起混音（multipart 字段 mic），回 202 + Recording */
  stopCapture: (id: string, opts: { mic?: Blob; durationMs: number; micOffsetMs?: number }) =>
    uploadFile<Recording>(`${idPath(id)}/capture/stop`, opts.mic, {
      duration_ms: String(Math.max(0, Math.round(opts.durationMs))),
      mic_offset_ms: String(Math.max(0, Math.round(opts.micOffsetMs ?? 0))),
    }, { fileField: 'mic', filename: 'mic.webm' }),
  /** 放弃采集，删临时文件；录音本身用 DELETE /recordings/{id} */
  cancelCapture: (id: string) => request<{ ok: boolean }>('DELETE', `${idPath(id)}/capture`),
  retranscribe: (id: string) => request<Recording>('POST', `${idPath(id)}/transcribe`, { body: {} }),
  /** 重新生成纪要（插件内直连 Agent，不等跑完），回 202 + Recording */
  generateMinutes: (id: string) => request<Recording>('POST', `${idPath(id)}/minutes`, { body: {} }),
  /** 发起纪要 SOP：flow 空串用设置里的流程，再空用内置流程 */
  startSop: (id: string, flow: string) => request<RecordingSopResult>('POST', `${idPath(id)}/sop`, { body: flow ? { flow } : {} }),
  /** 生成的文件清单（现查磁盘） */
  files: async (id: string, signal?: AbortSignal) =>
    (await requestList<RecordingFile>(`${idPath(id)}/files`, { signal })).data,
  /** 确认一条候选；项目候选挂项目，任务/目标候选建任务 */
  confirmTodo: (id: string, index: number, body: TodoConfirmInput) =>
    request<RecordingTodo>('POST', `${idPath(id)}/todos/${index}/confirm`, { body }),
  ignoreTodo: (id: string, index: number) => request<RecordingTodo>('POST', `${idPath(id)}/todos/${index}/ignore`, { body: {} }),
  /** 重新跑说话人识别（本机 Python sidecar，不等跑完），回 202 + Recording */
  diarize: (id: string) => request<Recording>('POST', `${idPath(id)}/diarize`, { body: {} }),
  /** 说话人列表（详情里也带一份，这里给独立刷新用） */
  speakers: async (id: string, signal?: AbortSignal) =>
    (await requestList<RecordingSpeaker>(`${idPath(id)}/speakers`, { signal })).data,
  /** 只改显示名，不动声纹 */
  renameSpeaker: (id: string, label: string, name: string) =>
    request<RecordingSpeaker>('PATCH', `${idPath(id)}/speakers/${encodeURIComponent(label)}`, { body: { name } }),
  /** 绑定联系人并登记声纹（已有声纹会被这次覆盖） */
  bindSpeaker: (id: string, label: string, contactId: string) =>
    request<RecordingSpeaker>('POST', `${idPath(id)}/speakers/${encodeURIComponent(label)}/bind`, { body: { contact_id: contactId } }),
  /** 已登记的联系人声纹 */
  voiceprints: async (signal?: AbortSignal) =>
    (await requestList<Voiceprint>(`${base}/voiceprints`, { signal })).data,
  deleteVoiceprint: (contactId: string) => request<{ ok: boolean }>('DELETE', `${base}/voiceprints/${encodeURIComponent(contactId)}`),
  settings: (signal?: AbortSignal) => request<RecordingSettings>('GET', `${base}/settings`, { signal }),
  saveSettings: (body: RecordingSettingsInput) => request<RecordingSettings>('PUT', `${base}/settings`, { body }),
  meta: (signal?: AbortSignal) => request<RecordingMeta>('GET', `${base}/meta`, { signal }),
  downloadModel: (name: string) => request<ModelInfo>('POST', `${base}/models/${encodeURIComponent(name)}/download`, { body: {} }),
  deleteModel: (name: string) => request<ModelInfo>('DELETE', `${base}/models/${encodeURIComponent(name)}`),
}

/** 音频流地址：<audio src> 直接用，支持 Range（拖动进度条） */
export function recordingAudioUrl(id: string): string {
  return `${apiBase()}${idPath(id)}/audio`
}

/** 文件下载地址：后端路由是单个 {name} 段，嵌套名（diagrams/flow.mmd）必须整段 %2F 编码 */
export function recordingFileUrl(id: string, name: string): string {
  return `${apiBase()}${idPath(id)}/files/${encodeURIComponent(name)}`
}

/** 状态是 uploaded/transcribing/summarizing 或后台任务在跑：列表要轮询进度（设计 §9） */
export function recordingLive(r: Pick<RecordingSummary, 'status' | 'job'>): boolean {
  return r.status === 'uploaded' || r.status === 'transcribing' || r.status === 'summarizing' || r.job?.status === 'running'
}

/** 详情/文件的轮询判断：任务在跑，或还有待确认候选（后台/SOP 可能继续写，确认后也要刷）
 *  diarize 的 pending 不算 recordingLive（录音状态不变），要单独算进来。 */
export function recordingPolling(r: Pick<RecordingSummary, 'status' | 'job' | 'todos_pending'>): boolean {
  const diarizeWaiting = r.job?.kind === 'diarize' && (r.job.status === 'pending' || r.job.status === 'running')
  return recordingLive(r) || diarizeWaiting || (r.todos_pending ?? 0) > 0
}

export function useRecordingList(filter: RecordingListFilter = {}) {
  return useQuery({
    queryKey: recordingKeys.list(filter),
    queryFn: ({ signal }) => recordingApi.list(filter, signal),
    refetchInterval: (q) => (q.state.data?.some(recordingLive) ? POLL_MS : false),
  })
}

/** 详情；id 为空不查（列表页用同一个 Page 分派） */
export function useRecording(id: string | null) {
  return useQuery({
    queryKey: recordingKeys.detail(id ?? ''),
    queryFn: ({ signal }) => recordingApi.get(id ?? '', signal),
    enabled: !!id,
    retry: false,
    refetchInterval: (q) => (q.state.data && recordingPolling(q.state.data) ? POLL_MS : false),
  })
}

/** 录音目录里的文件清单；active 时（正在生成纪要）每 2 秒刷一次等新文件出现。
 *  revision 通常传录音的 status+updated_at：任务跑完状态一变就换 key 重新取一次，避免轮询恰好停在写完前。 */
export function useRecordingFiles(id: string | null, active = false, revision = '') {
  return useQuery({
    queryKey: recordingKeys.files(id ?? '', revision),
    queryFn: ({ signal }) => recordingApi.files(id ?? '', signal),
    enabled: !!id,
    refetchInterval: active ? POLL_MS : false,
  })
}

/** 说话人列表；任务运行中每 2 秒刷一次（详情本身也带 speakers，监视轮询时机用） */
export function useRecordingSpeakers(id: string | null, active = false, revision = '') {
  return useQuery({
    queryKey: recordingKeys.speakers(id ?? '', revision),
    queryFn: ({ signal }) => recordingApi.speakers(id ?? '', signal),
    enabled: !!id,
    refetchInterval: active ? POLL_MS : false,
  })
}

/** 已登记的联系人声纹；绑定弹层里判断「这个联系人已有声纹，会被覆盖」 */
export function useVoiceprints() {
  return useQuery({ queryKey: recordingKeys.voiceprints, queryFn: ({ signal }) => recordingApi.voiceprints(signal) })
}

export function useRecordingSettings() {
  return useQuery({ queryKey: recordingKeys.settings, queryFn: ({ signal }) => recordingApi.settings(signal) })
}

/** meta 里带工具/模型/设置/默认值；有模型在下载时每 2 秒刷一次进度 */
export function useRecordingMeta() {
  return useQuery({
    queryKey: recordingKeys.meta,
    queryFn: ({ signal }) => recordingApi.meta(signal),
    refetchInterval: (q) => (q.state.data?.models.some((m) => m.status === 'downloading') ? POLL_MS : false),
  })
}

function useRecordingMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: recordingKeys.all }) })
}

/** 本机音频设备；只在选系统音频来源时才查，设备列表半分钟缓存 */
export function useRecordingAudioDevices(enabled = true) {
  return useQuery({
    queryKey: recordingKeys.audioDevices,
    queryFn: ({ signal }) => recordingApi.audioDevices(signal),
    enabled,
    staleTime: 30_000,
  })
}

export const useCreateRecording = () => useRecordingMutation((body: RecordingInput) => recordingApi.create(body))

export const useStartCapture = () =>
  useRecordingMutation(({ id, device }: { id: string; device: number }) => recordingApi.startCapture(id, device))

export const useStopCapture = () =>
  useRecordingMutation(({ id, mic, durationMs, micOffsetMs }: { id: string; mic?: Blob; durationMs: number; micOffsetMs?: number }) =>
    recordingApi.stopCapture(id, { mic, durationMs, micOffsetMs }))

export const useCancelCapture = () => useRecordingMutation((id: string) => recordingApi.cancelCapture(id))

export const useUploadAudio = () =>
  useRecordingMutation(({ id, file, durationMs }: { id: string; file: Blob; durationMs: number }) => recordingApi.uploadAudio(id, file, durationMs))

export const useRetranscribe = () => useRecordingMutation((id: string) => recordingApi.retranscribe(id))

export const usePatchRecording = () =>
  useRecordingMutation(({ id, patch }: { id: string; patch: RecordingPatch }) => recordingApi.patch(id, patch))

export const useDeleteRecording = () => useRecordingMutation((id: string) => recordingApi.remove(id))

export const useGenerateMinutes = () => useRecordingMutation((id: string) => recordingApi.generateMinutes(id))

export const useStartSop = () =>
  useRecordingMutation(({ id, flow }: { id: string; flow: string }) => recordingApi.startSop(id, flow))

export const useConfirmTodo = () =>
  useRecordingMutation(({ id, index, body }: { id: string; index: number; body: TodoConfirmInput }) =>
    recordingApi.confirmTodo(id, index, body))

export const useIgnoreTodo = () =>
  useRecordingMutation(({ id, index }: { id: string; index: number }) => recordingApi.ignoreTodo(id, index))

export const useDiarize = () => useRecordingMutation((id: string) => recordingApi.diarize(id))

export const useRenameSpeaker = () =>
  useRecordingMutation(({ id, label, name }: { id: string; label: string; name: string }) =>
    recordingApi.renameSpeaker(id, label, name))

export const useBindSpeaker = () =>
  useRecordingMutation(({ id, label, contactId }: { id: string; label: string; contactId: string }) =>
    recordingApi.bindSpeaker(id, label, contactId))

export const useDeleteVoiceprint = () =>
  useRecordingMutation((contactId: string) => recordingApi.deleteVoiceprint(contactId))

export const useSaveSettings = () => useRecordingMutation((body: RecordingSettingsInput) => recordingApi.saveSettings(body))

export const useDownloadModel = () => useRecordingMutation((name: string) => recordingApi.downloadModel(name))

export const useDeleteModel = () => useRecordingMutation((name: string) => recordingApi.deleteModel(name))
