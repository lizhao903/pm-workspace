// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 录音转写插件（recording 0.3.0）的原型数据和模拟引擎。正式产品：前端 frontend/src/plugins/recording/、
// 数据层 frontend/src/core/data/recording.ts、后端 internal/plugins/recording/。字段名照抄正式产品的类型。
// 原型没有后端和麦克风：录音按时间走秒，停止后按「待转写 → 转写中 → 已转写 →（说话人识别）→（生成纪要）→ 已完成」
// 确定性推进，转写文本、纪要、候选都是虚构的演示内容。
// 录音状态放在模块级 store（同正式产品的 recorder.ts 常驻）：切到别的模块也继续录，外壳状态条读同一份。
import { useSyncExternalStore } from 'react'

export type RecordingStatus = 'draft' | 'uploaded' | 'transcribing' | 'transcribed' | 'summarizing' | 'ready' | 'failed'
export type RecordingJobStatus = 'pending' | 'running' | 'done' | 'failed'
export type RecordingJob = { kind: 'transcribe' | 'summarize' | 'diarize'; status: RecordingJobStatus; progress: number; attempts: number; last_error: string }
export type Segment = { seq: number; start_ms: number; end_ms: number; text: string; speaker: string }

export type RecordingAction = { title: string; detail: string; owner: string; due: string; project: string; confidence: number; kind: string }
export type RecordingQuestion = { question: string; why: string; confidence: number }
export type RecordingFlow = { title: string; nodes: { id: string; label: string; kind: string }[]; edges: { from: string; to: string; label: string }[] }
export type RecordingTreeNode = { label: string; children: RecordingTreeNode[] }
export type RecordingDiagrams = { flow: RecordingFlow; tree: { title: string; root: RecordingTreeNode } }
export type RecordingMinutes = {
  summary_md: string; conclusions: string[]; actions: RecordingAction[]; questions: RecordingQuestion[]
  diagrams: RecordingDiagrams; generated_at: string; model: string
}
export type TodoKind = 'project' | 'task' | 'goal'
export type TodoStatus = 'pending' | 'confirmed' | 'ignored'
export type RecordingTodo = {
  index: number; kind: TodoKind; title: string; detail: string; confidence: number; status: TodoStatus
  project_id: string; project_title: string; object_id: string; object_ref: string; reason: string; owner_name: string; due_at: string
}
export type RecordingSpeaker = {
  label: string; name: string; contact_id: string; contact_name: string; similarity: number; segments: number; duration_ms: number; detected: boolean
}
export type Voiceprint = { contact_id: string; contact_name: string; model: string; source_recording_id: string; created_at: string }
export type RecordingFileKind = 'transcript' | 'minutes' | 'minutes_json' | 'diagram_flow' | 'diagram_tree'
export type RecordingFile = { name: string; kind: RecordingFileKind; bytes: number; updated_at: string; body: string }

export type Recording = {
  id: string; title: string; status: RecordingStatus; model: string; language: string; duration_ms: number; has_audio: boolean
  project_id: string; project_title: string; error: string; job: RecordingJob | null
  transcript: string; segments: Segment[]; minutes: RecordingMinutes | null; todos: RecordingTodo[]; speakers: RecordingSpeaker[]
  /** 录音来源，原型多记一个字段方便详情里说明；正式产品在 audio_mime / 采集记录里 */
  source: CaptureSource
  created_at: string; updated_at: string
}

export type ModelStatus = 'missing' | 'downloading' | 'ready' | 'error'
export type ModelInfo = { name: string; size: number; status: ModelStatus; progress: number; error: string }
export type ToolInfo = { path: string; version: string; ok: boolean; error: string }

export type RecordingSettings = {
  default_engine: string; model: string; model_dir: string; whisper_path: string; ffmpeg_path: string; language: string; threads: number
  default_project_id: string; minutes_provider: string; minutes_model: string; minutes_flow: string; minutes_threshold: number
  auto_diarize: boolean; python_path: string; voiceprint_model_dir: string; max_speakers: number; match_threshold: number
  auto_summarize: boolean; retention_mode: 'keep' | 'delete_audio_after_ready'
}

/* ---------- 常量与格式化（同 frontend/src/plugins/recording/model.ts） ---------- */

export const STATUS_TEXT: Record<RecordingStatus, string> = {
  draft: '草稿', uploaded: '待转写', transcribing: '转写中', transcribed: '已转写', summarizing: '生成纪要中', ready: '已完成', failed: '失败',
}
export const statusTone = (s: RecordingStatus) =>
  s === 'transcribing' || s === 'summarizing' ? 'var(--warn)' : s === 'transcribed' || s === 'ready' ? 'var(--ok)' : s === 'uploaded' ? 'var(--accent)' : s === 'failed' ? 'var(--danger)' : 'var(--faint)'

export function jobText(job: RecordingJob | null): string {
  if (!job) return ''
  const verb = job.kind === 'summarize' ? '生成纪要' : job.kind === 'diarize' ? '说话人识别' : '转写'
  return job.status === 'pending' ? `排队等待${verb}` : job.status === 'running' ? `${verb}中 ${Math.round(job.progress)}%` : job.status === 'done' ? `${verb}完成` : `${verb}失败`
}

export function fmtDuration(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`
}
export function fmtAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
export function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}

export const LIST_FILTERS = [
  { key: '', label: '全部' }, { key: 'transcribing', label: '转写中' }, { key: 'done', label: '已完成' }, { key: 'failed', label: '失败' },
] as const
export type ListFilter = (typeof LIST_FILTERS)[number]['key']
/** 转写中含待转写/转写中/生成纪要，已完成含已转写/已完成 */
export function matchesFilter(f: ListFilter, s: RecordingStatus) {
  return f === 'transcribing' ? s === 'uploaded' || s === 'transcribing' || s === 'summarizing'
    : f === 'done' ? s === 'transcribed' || s === 'ready' : f === 'failed' ? s === 'failed' : true
}

export const CAPTURE_SOURCES = [
  { key: 'mic', label: '麦克风', desc: '只录你说话，最省事：口述、面对面、电话开免提都行。' },
  { key: 'share', label: '系统声音（浏览器分享）', desc: '开始后浏览器会让你分享标签页或屏幕，记得勾选「分享声音」；不用装任何东西，但只能录浏览器里的声音（网页版会议、视频、直播）。' },
  { key: 'system', label: '系统声音（本机设备）', desc: '用本机虚拟声卡录整个电脑/会议 App 的声音，需要先装 BlackHole 等虚拟声卡。' },
  { key: 'mic_system', label: '麦克风 + 系统声音', desc: '会议推荐：你的麦克风 + 电脑里对方的声音，停止后混成一条再转写。' },
] as const
export type CaptureSource = (typeof CAPTURE_SOURCES)[number]['key']
export const captureSourceText = (s: CaptureSource) => CAPTURE_SOURCES.find((x) => x.key === s)?.label ?? s
export const captureSourceShort = (s: CaptureSource) =>
  s === 'mic' ? '麦克风' : s === 'share' ? '浏览器分享的声音' : s === 'system' ? '系统声音' : '麦克风和系统声音'
/** 系统声音（本机设备）和麦克风 + 系统声音走本机采集（ffmpeg），不能暂停 */
export const isSystemSource = (s: CaptureSource) => s === 'system' || s === 'mic_system'

/** 本机音频设备（正式产品 GET /api/recording/audio-devices，macOS 用 ffmpeg avfoundation 列） */
export type AudioDevice = { index: number; name: string; default: boolean; virtual: boolean }
export const DEMO_DEVICES: AudioDevice[] = [
  { index: 0, name: 'MacBook Pro 麦克风', default: true, virtual: false },
  { index: 1, name: 'BlackHole 2ch', default: false, virtual: true },
]

export const TODO_KIND_TEXT: Record<TodoKind, string> = { project: '项目候选', task: '任务候选', goal: '目标候选' }
export const FILE_KIND_TEXT: Record<RecordingFileKind, string> = {
  transcript: '转写', minutes: '纪要', minutes_json: '纪要 JSON', diagram_flow: '流程图源码', diagram_tree: '树形图源码',
}
export const MODEL_STATUS_TEXT: Record<ModelStatus, string> = { missing: '未下载', downloading: '下载中', ready: '已下载', error: '下载失败' }
export const MODEL_OPTIONS = [
  { value: 'base', label: 'base（141MB，最快，准确率一般）' },
  { value: 'small', label: 'small（466MB，推荐先跑通）' },
  { value: 'medium', label: 'medium（1.4GB，更准）' },
  { value: 'large-v3-turbo', label: 'large-v3-turbo（1.5GB，最准）' },
]
export const LANGUAGE_OPTIONS = [
  { value: 'zh', label: '中文（zh）' }, { value: 'auto', label: '自动识别（auto）' }, { value: 'en', label: '英语（en）' }, { value: 'yue', label: '粤语（yue）' },
  { value: 'ja', label: '日语（ja）' }, { value: 'ko', label: '韩语（ko）' }, { value: 'de', label: '德语（de）' }, { value: 'fr', label: '法语（fr）' },
  { value: 'es', label: '西班牙语（es）' }, { value: 'ru', label: '俄语（ru）' },
]
export const RETENTION_OPTIONS = [
  { value: 'keep', label: '保留原始音频（推荐）' },
  { value: 'delete_audio_after_ready', label: '转写完成后删除音频（M3 生效）' },
]

export const confidencePct = (c: number) => Math.max(0, Math.min(100, Math.round(c * 100)))
export const confidenceTone = (c: number) => (c >= 0.7 ? 'var(--ok)' : c >= 0.4 ? 'var(--warn)' : 'var(--faint)')

export const SPEAKER_COLORS = ['var(--accent)', 'var(--ok)', 'var(--warn)', 'var(--danger)', '#8b5cf6', '#0ea5e9', '#d946ef', '#f97316']
export function speakerColor(label: string) {
  const m = /^spk_(\d+)$/.exec(label)
  return SPEAKER_COLORS[(m ? Number(m[1]) - 1 : label.length) % SPEAKER_COLORS.length]
}
/** 显示名：用户改的名 > 联系人名 > 「说话人 N」 */
export function speakerName(s: Pick<RecordingSpeaker, 'label' | 'name' | 'contact_name'>) {
  if (s.name.trim()) return s.name.trim()
  if (s.contact_name.trim()) return s.contact_name.trim()
  const m = /^spk_(\d+)$/.exec(s.label)
  return m ? `说话人 ${Number(m[1])}` : s.label || '说话人'
}

/* ---------- 演示内容 ---------- */

const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString()

/** 转写演示稿：每条录音按这几段循环拼，说话人轮流 */
const LINES = [
  '我们先过一下这周的进度，原型那边已经能点通主流程了。',
  '审批流的条件分支还差两种，周三前能补上。',
  '客户那边希望月底前看到一版演示，最好能带上权限配置。',
  '那演示环境谁来准备？我建议放到测试环境，数据用造的。',
  '我来负责，周四前把环境和演示数据准备好。',
  '还有一个问题，导出报表要不要做？客户提过两次了。',
  '先记下来，下次评审再定优先级。',
  '好，今天就到这，会后我把纪要发群里。',
]
function demoSegments(n: number, speakers = 2): Segment[] {
  return Array.from({ length: n }, (_, i) => ({
    seq: i + 1, start_ms: i * 9000, end_ms: i * 9000 + 8200, text: LINES[i % LINES.length], speaker: speakers ? `spk_${(i % speakers) + 1}` : '',
  }))
}
const joinText = (segs: Segment[]) => segs.map((s) => s.text).join('\n')

function demoMinutes(title: string, at: string): RecordingMinutes {
  return {
    summary_md: `**${title}** 过了本周进度：原型主流程已能点通，审批流还差两种条件分支；客户要求月底前看到带权限配置的演示。\n\n- 演示环境放测试环境，数据用造的\n- 导出报表先记下，下次评审再定`,
    conclusions: ['月底前给客户一版带权限配置的演示', '演示环境用测试环境和造的数据', '导出报表下次评审再定优先级'],
    actions: [
      { title: '补齐审批流剩下两种条件分支', detail: '周三前完成，补完在原型里走一遍', owner: '周屿', due: '周三', project: '北岸物流审批流 demo', confidence: 0.86, kind: 'task' },
      { title: '准备演示环境和演示数据', detail: '测试环境，数据用造的', owner: '林予安', due: '周四', project: '远川科技权限改造', confidence: 0.81, kind: 'task' },
      { title: '月底前完成客户演示', detail: '', owner: '', due: '月底', project: '远川科技权限改造', confidence: 0.62, kind: 'goal' },
    ],
    questions: [{ question: '导出报表要不要进这一期？', why: '客户提过两次，会上没定', confidence: 0.4 }],
    diagrams: {
      flow: {
        title: '讨论脉络',
        nodes: [
          { id: 'n1', label: '过本周进度', kind: 'start' }, { id: 'n2', label: '审批流还差两种分支', kind: 'process' },
          { id: 'n3', label: '月底前能演示吗', kind: 'decision' }, { id: 'n4', label: '准备演示环境', kind: 'process' },
          { id: 'n5', label: '导出报表待评审', kind: 'end' },
        ],
        edges: [{ from: 'n1', to: 'n2', label: '' }, { from: 'n2', to: 'n3', label: '' }, { from: 'n3', to: 'n4', label: '能' }, { from: 'n3', to: 'n5', label: '待定' }],
      },
      tree: {
        title: '项目/任务树',
        root: { label: title, children: [
          { label: '远川科技权限改造', children: [{ label: '准备演示环境和数据', children: [] }, { label: '月底客户演示', children: [] }] },
          { label: '北岸物流审批流 demo', children: [{ label: '补两种条件分支', children: [] }] },
        ] },
      },
    },
    generated_at: at, model: 'qwen3.5:4b',
  }
}
function demoTodos(): RecordingTodo[] {
  const base = { status: 'pending' as TodoStatus, object_id: '', object_ref: '', due_at: '' }
  return [
    { ...base, index: 0, kind: 'project', title: '远川科技权限改造', detail: '会上反复提到客户演示和权限配置', confidence: 0.9, project_id: 'pj_perm', project_title: '远川科技权限改造', reason: '按名字匹配到已有项目', owner_name: '' },
    { ...base, index: 1, kind: 'task', title: '补齐审批流剩下两种条件分支', detail: '周三前完成', confidence: 0.86, project_id: 'pj_beian', project_title: '北岸物流审批流 demo', reason: '', owner_name: '周屿' },
    { ...base, index: 2, kind: 'task', title: '准备演示环境和演示数据', detail: '测试环境，数据用造的', confidence: 0.81, project_id: 'pj_perm', project_title: '远川科技权限改造', reason: '', owner_name: '林予安' },
    { ...base, index: 3, kind: 'goal', title: '月底前完成客户演示', detail: '', confidence: 0.55, project_id: 'pj_perm', project_title: '远川科技权限改造', reason: '会上没说清谁负责', owner_name: '' },
  ]
}
function speakersOf(segs: Segment[], bind: Partial<Record<string, { id: string; name: string; sim: number }>> = {}): RecordingSpeaker[] {
  const labels = [...new Set(segs.map((s) => s.speaker).filter(Boolean))]
  return labels.map((label) => {
    const mine = segs.filter((s) => s.speaker === label)
    const b = bind[label]
    return {
      label, name: '', contact_id: b?.id ?? '', contact_name: b?.name ?? '', similarity: b?.sim ?? 0,
      segments: mine.length, duration_ms: mine.reduce((n, s) => n + s.end_ms - s.start_ms, 0), detected: !!b,
    }
  })
}

function seedRecordings(): Recording[] {
  const s1 = demoSegments(8)
  const s2 = demoSegments(5, 0)
  const at1 = minsAgo(60 * 26)
  return [
    {
      id: 'rec_demo1', title: '周会：审批流与客户演示', status: 'ready', model: 'small', language: 'zh', duration_ms: 8 * 9000 + 600, has_audio: true,
      project_id: 'pj_perm', project_title: '远川科技权限改造', error: '', job: null, transcript: joinText(s1), segments: s1,
      minutes: demoMinutes('周会：审批流与客户演示', minsAgo(60 * 25)), todos: demoTodos(),
      speakers: speakersOf(s1, { spk_1: { id: 'ct_001', name: '林予安', sim: 0.82 } }), source: 'mic_system', created_at: at1, updated_at: minsAgo(60 * 25),
    },
    {
      id: 'rec_demo2', title: '电话：演示环境确认', status: 'transcribed', model: 'small', language: 'zh', duration_ms: 5 * 9000, has_audio: true,
      project_id: '', project_title: '', error: '', job: null, transcript: joinText(s2), segments: s2,
      minutes: null, todos: [], speakers: [], source: 'mic', created_at: minsAgo(60 * 5), updated_at: minsAgo(60 * 5 - 3),
    },
    {
      id: 'rec_demo3', title: '', status: 'failed', model: 'medium', language: 'zh', duration_ms: 132000, has_audio: true,
      project_id: '', project_title: '', error: '模型 medium 还没下载：到 设置 / 录音转写 下载，或换成已下载的模型',
      job: { kind: 'transcribe', status: 'failed', progress: 0, attempts: 1, last_error: '模型 medium 还没下载' },
      transcript: '', segments: [], minutes: null, todos: [], speakers: [], source: 'share', created_at: minsAgo(40), updated_at: minsAgo(39),
    },
  ]
}

const DEFAULT_SETTINGS: RecordingSettings = {
  default_engine: 'whisper_local', model: 'small', model_dir: '', whisper_path: '', ffmpeg_path: '', language: 'zh', threads: 0,
  default_project_id: '', minutes_provider: '', minutes_model: '', minutes_flow: '', minutes_threshold: 0.7,
  auto_diarize: true, python_path: '', voiceprint_model_dir: '', max_speakers: 8, match_threshold: 0.65,
  auto_summarize: true, retention_mode: 'keep',
}
const MB = 1024 * 1024

/* ---------- store ---------- */

export type RecorderPhase = 'idle' | 'requesting' | 'recording' | 'paused' | 'uploading' | 'error'
export type RecorderState = {
  phase: RecorderPhase
  title: string
  source: CaptureSource
  deviceIndex: number
  /** 暂停前累计的毫秒数；录音中再加上 since 到现在 */
  accMs: number
  since: number
  error: string
  /** 演示开关：下一次开始录音时授权被拒 */
  denyNext: boolean
}
export type RecordingState = {
  recorder: RecorderState
  recordings: Recording[]
  settings: RecordingSettings
  models: ModelInfo[]
  tools: { whisper: ToolInfo; ffmpeg: ToolInfo }
  voiceprints: Voiceprint[]
  /** 保存成功的序号：录音页听它跳详情 */
  savedSeq: number
  savedId: string
}

let state: RecordingState = {
  recorder: { phase: 'idle', title: '', source: 'mic', deviceIndex: 1, accMs: 0, since: 0, error: '', denyNext: false },
  recordings: seedRecordings(),
  settings: DEFAULT_SETTINGS,
  models: [
    { name: 'base', size: 141 * MB, status: 'missing', progress: 0, error: '' },
    { name: 'small', size: 466 * MB, status: 'ready', progress: 100, error: '' },
    { name: 'medium', size: 1463 * MB, status: 'missing', progress: 0, error: '' },
    { name: 'large-v3-turbo', size: 1549 * MB, status: 'missing', progress: 0, error: '' },
  ],
  tools: {
    whisper: { path: '/opt/homebrew/bin/whisper-cli', version: '1.7.5', ok: true, error: '' },
    ffmpeg: { path: '/opt/homebrew/bin/ffmpeg', version: '7.1', ok: true, error: '' },
  },
  voiceprints: [{ contact_id: 'ct_001', contact_name: '林予安', model: 'cam++', source_recording_id: 'rec_demo1', created_at: minsAgo(60 * 25) }],
  savedSeq: 0, savedId: '',
}
const listeners = new Set<() => void>()
function set(f: (s: RecordingState) => Partial<RecordingState>) {
  state = { ...state, ...f(state) }
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export function useRecordingStore(): RecordingState {
  return useSyncExternalStore(subscribe, () => state)
}
export const elapsedOf = (r: RecorderState, now = Date.now()) => r.accMs + (r.phase === 'recording' ? now - r.since : 0)

const patchRec = (id: string, p: Partial<Recording> | ((r: Recording) => Partial<Recording>)) =>
  set((s) => ({ recordings: s.recordings.map((r) => (r.id === id ? { ...r, ...(typeof p === 'function' ? p(r) : p), updated_at: new Date().toISOString() } : r)) }))
const getRec = (id: string) => state.recordings.find((r) => r.id === id)

/* ---------- 录音引擎（模拟） ---------- */

const setRecorder = (p: Partial<RecorderState>) => set((s) => ({ recorder: { ...s.recorder, ...p } }))
export const setRecorderTitle = (title: string) => setRecorder({ title })
export const setRecorderSource = (source: CaptureSource) => setRecorder({ source })
export const setRecorderDevice = (deviceIndex: number) => setRecorder({ deviceIndex })
export const setDenyNext = (denyNext: boolean) => setRecorder({ denyNext })

export function startRecording() {
  const r = state.recorder
  if (r.phase !== 'idle' && r.phase !== 'error') return
  setRecorder({ phase: 'requesting', error: '', accMs: 0 })
  window.setTimeout(() => {
    if (state.recorder.phase !== 'requesting') return
    if (state.recorder.denyNext) {
      const src = state.recorder.source
      setRecorder({ phase: 'error', denyNext: false, error: src === 'share'
        ? '没有开始分享：可能是取消了共享，或浏览器拒绝了屏幕录制权限。点「开始录音」重试，选标签页/整个屏幕并勾选「分享声音」'
        : '麦克风权限被拒绝：点地址栏左边的图标允许使用麦克风，再点「开始录音」重试（本地录音需要用 127.0.0.1 或 localhost 打开）' })
      return
    }
    setRecorder({ phase: 'recording', since: Date.now() })
  }, 700)
}
export function pauseRecording() {
  const r = state.recorder
  if (r.phase !== 'recording' || isSystemSource(r.source)) return
  setRecorder({ phase: 'paused', accMs: elapsedOf(r) })
}
export function resumeRecording() {
  if (state.recorder.phase === 'paused') setRecorder({ phase: 'recording', since: Date.now() })
}
export function discardRecording() {
  setRecorder({ phase: 'idle', accMs: 0, error: '', title: '' })
}
export function retryRecording() {
  setRecorder({ phase: 'idle', error: '' })
  startRecording()
}
/** 停止并转写：保存成一条「待转写」录音，排队转写 */
export function stopRecording() {
  const r = state.recorder
  if (r.phase !== 'recording' && r.phase !== 'paused') return
  const ms = Math.max(1000, elapsedOf(r))
  setRecorder({ phase: 'uploading', accMs: ms })
  window.setTimeout(() => {
    const now = new Date()
    const proj = state.settings.default_project_id
    const rec: Recording = {
      id: `rec_${now.getTime().toString(36)}`, title: r.title.trim() || `录音 ${fmtAt(now.toISOString())}`, status: 'uploaded',
      model: state.settings.model, language: state.settings.language, duration_ms: ms, has_audio: true,
      project_id: proj, project_title: '', error: '', job: { kind: 'transcribe', status: 'pending', progress: 0, attempts: 0, last_error: '' },
      transcript: '', segments: [], minutes: null, todos: [], speakers: [], source: r.source,
      created_at: now.toISOString(), updated_at: now.toISOString(),
    }
    set((s) => ({ recordings: [rec, ...s.recordings], recorder: { ...s.recorder, phase: 'idle', accMs: 0, title: '' }, savedSeq: s.savedSeq + 1, savedId: rec.id }))
    runTranscribe(rec.id)
  }, 900)
}

/* ---------- 后台任务（模拟）：每 400ms 推进一次进度 ---------- */

function runJob(id: string, kind: RecordingJob['kind'], status: RecordingStatus | null, done: () => void, fail?: () => string) {
  patchRec(id, (r) => ({ job: { kind, status: 'pending', progress: 0, attempts: (r.job?.kind === kind ? r.job.attempts : 0) + 1, last_error: '' } }))
  let p = 0
  window.setTimeout(function step() {
    if (!getRec(id)) return
    if (p === 0) {
      const why = fail?.()
      if (why) {
        patchRec(id, (r) => ({ job: { ...r.job!, status: 'failed', last_error: why }, ...(kind === 'transcribe' ? { status: 'failed' as const, error: why } : {}) }))
        return
      }
      if (status) patchRec(id, { status })
    }
    p = Math.min(100, p + (kind === 'summarize' ? 12 : 18))
    patchRec(id, (r) => ({ job: { ...r.job!, status: 'running', progress: p } }))
    if (p < 100) { window.setTimeout(step, 400); return }
    patchRec(id, (r) => ({ job: { ...r.job!, status: 'done', progress: 100 } }))
    done()
  }, 600)
}

function runTranscribe(id: string) {
  runJob(id, 'transcribe', 'transcribing', () => {
    const r = getRec(id)
    if (!r) return
    const n = Math.max(2, Math.min(8, Math.round(r.duration_ms / 9000)))
    const segs = demoSegments(n, 0)
    patchRec(id, { status: 'transcribed', segments: segs, transcript: joinText(segs), error: '' })
    if (state.settings.auto_diarize) runDiarize(id, () => { if (state.settings.auto_summarize) generateMinutes(id) })
    else if (state.settings.auto_summarize) generateMinutes(id)
  }, () => {
    const r = getRec(id)
    const m = state.models.find((x) => x.name === (r?.model ?? ''))
    return m && m.status !== 'ready' ? `模型 ${m.name} 还没下载：到 设置 / 录音转写 下载，或换成已下载的模型` : ''
  })
}
export function retranscribe(id: string) {
  patchRec(id, { status: 'uploaded', error: '', model: state.settings.model, transcript: '', segments: [], speakers: [] })
  runTranscribe(id)
}

function runDiarize(id: string, then?: () => void) {
  runJob(id, 'diarize', null, () => {
    const r = getRec(id)
    if (!r) return
    const segs = r.segments.map((s, i) => ({ ...s, speaker: `spk_${(i % 2) + 1}` }))
    // 已登记声纹的联系人按相似度自动认出（演示：第一个说话人认成登记过的第一个声纹）
    const vp = state.voiceprints[0]
    patchRec(id, { segments: segs, speakers: speakersOf(segs, vp ? { spk_1: { id: vp.contact_id, name: vp.contact_name, sim: 0.79 } } : {}) })
    then?.()
  })
}
export const diarize = (id: string) => runDiarize(id)

export function generateMinutes(id: string) {
  runJob(id, 'summarize', 'summarizing', () => {
    const r = getRec(id)
    if (!r) return
    const kept = r.todos.filter((t) => t.status === 'confirmed')
    const fresh = demoTodos().filter((t) => !kept.some((k) => k.title === t.title)).map((t, i) => ({ ...t, index: kept.length + i }))
    patchRec(id, { status: 'ready', minutes: demoMinutes(r.title || '录音', new Date().toISOString()), todos: [...kept, ...fresh] })
  })
}
/** 发起纪要 SOP：原型不跑 SOP，按直连 Agent 的结果出纪要，返回流程名 */
export function startMinutesSop(id: string): string {
  generateMinutes(id)
  return state.settings.minutes_flow || '会议纪要整理'
}

/* ---------- 编辑类操作 ---------- */

export const renameRecording = (id: string, title: string) => patchRec(id, { title })
export const saveTranscript = (id: string, transcript: string) => patchRec(id, { transcript })
export const deleteRecording = (id: string) => set((s) => ({ recordings: s.recordings.filter((r) => r.id !== id) }))
export const ignoreTodo = (id: string, index: number) =>
  patchRec(id, (r) => ({ todos: r.todos.map((t) => (t.index === index ? { ...t, status: 'ignored' as const } : t)) }))
export function confirmTodo(id: string, index: number, p: Partial<RecordingTodo>) {
  patchRec(id, (r) => ({
    todos: r.todos.map((t) => (t.index === index ? { ...t, ...p, status: 'confirmed' as const } : t)),
    ...(p.project_id && r.todos.find((t) => t.index === index)?.kind === 'project' ? { project_id: p.project_id, project_title: p.project_title ?? '' } : {}),
  }))
}
export const renameSpeaker = (id: string, label: string, name: string) =>
  patchRec(id, (r) => ({ speakers: r.speakers.map((s) => (s.label === label ? { ...s, name } : s)) }))
export function bindSpeaker(id: string, label: string, contact: { id: string; name: string }) {
  patchRec(id, (r) => ({ speakers: r.speakers.map((s) => (s.label === label ? { ...s, contact_id: contact.id, contact_name: contact.name, detected: false, similarity: s.similarity || 1 } : s)) }))
  set((s) => ({ voiceprints: [{ contact_id: contact.id, contact_name: contact.name, model: 'cam++', source_recording_id: id, created_at: new Date().toISOString() },
    ...s.voiceprints.filter((v) => v.contact_id !== contact.id)] }))
}
export const deleteVoiceprint = (contactId: string) => set((s) => ({ voiceprints: s.voiceprints.filter((v) => v.contact_id !== contactId) }))
export const saveSettings = (settings: RecordingSettings) => set(() => ({ settings }))
export function downloadModel(name: string) {
  const step = () => {
    const m = state.models.find((x) => x.name === name)
    if (!m) return
    const progress = Math.min(100, m.progress + 20)
    set((s) => ({ models: s.models.map((x) => (x.name === name ? { ...x, status: progress >= 100 ? 'ready' : 'downloading', progress, error: '' } : x)) }))
    if (progress < 100) window.setTimeout(step, 500)
  }
  set((s) => ({ models: s.models.map((x) => (x.name === name ? { ...x, status: 'downloading', progress: 0 } : x)) }))
  window.setTimeout(step, 500)
}
export const deleteModel = (name: string) => set((s) => ({ models: s.models.map((x) => (x.name === name ? { ...x, status: 'missing', progress: 0 } : x)) }))

/* ---------- 文件（录音目录里随转写/纪要生成） ---------- */

function flowMermaid(f: RecordingFlow) {
  const shape = (n: RecordingFlow['nodes'][number]) => (n.kind === 'decision' ? `{${n.label}}` : n.kind === 'start' || n.kind === 'end' ? `([${n.label}])` : `[${n.label}]`)
  return ['flowchart LR', ...f.nodes.map((n) => `  ${n.id}${shape(n)}`), ...f.edges.map((e) => `  ${e.from} -->${e.label ? `|${e.label}|` : ''} ${e.to}`)].join('\n')
}
function treeMermaid(t: RecordingDiagrams['tree']) {
  const out = ['mindmap', `  root((${t.root.label}))`]
  const walk = (n: RecordingTreeNode, d: number) => n.children.forEach((c) => { out.push(`${'  '.repeat(d + 2)}${c.label}`); walk(c, d + 1) })
  walk(t.root, 0)
  return out.join('\n')
}
export function filesOf(r: Recording): RecordingFile[] {
  const out: RecordingFile[] = []
  const f = (name: string, kind: RecordingFileKind, body: string) => out.push({ name, kind, body, bytes: new Blob([body]).size, updated_at: r.updated_at })
  if (r.transcript) f('transcript.md', 'transcript', `# ${r.title || '录音'}\n\n${r.transcript}\n`)
  if (r.minutes) {
    f('minutes.md', 'minutes', `# ${r.title || '录音'} 纪要\n\n${r.minutes.summary_md}\n\n## 结论\n${r.minutes.conclusions.map((c) => `- ${c}`).join('\n')}\n`)
    f('minutes.json', 'minutes_json', JSON.stringify(r.minutes, null, 2))
    f('diagrams/flow.mmd', 'diagram_flow', flowMermaid(r.minutes.diagrams.flow))
    f('diagrams/tree.mmd', 'diagram_tree', treeMermaid(r.minutes.diagrams.tree))
  }
  return out
}
