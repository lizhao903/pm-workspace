// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Recording, RecordingJob, RecordingMinutes, RecordingSettings } from '../../core/data'
import { MinutesSection } from './Minutes'

const settings: RecordingSettings = {
  default_engine: 'whisper_local', model: 'small', model_dir: '', whisper_path: '', ffmpeg_path: '', language: 'zh',
  threads: 0, default_project_id: '', minutes_provider: '', minutes_model: '', minutes_flow: '', minutes_threshold: 0.7,
  auto_diarize: true, python_path: '', voiceprint_model_dir: '', max_speakers: 8, match_threshold: 0.65,
  auto_summarize: false, retention_mode: 'keep', updated_at: '2026-11-10T08:00:00Z',
}

const minutes = (over: Partial<RecordingMinutes> = {}): RecordingMinutes => ({
  summary_md: '## 会议摘要\n\n讨论了三件事：排期、预算和人员。',
  conclusions: ['下周先做小样', '预算按季度申请'],
  actions: [
    { title: '找财务确认预算', detail: '需要带上去年的支出明细', owner: '张三', due: '2026-11-20', project: '产品', confidence: 0.9, kind: 'task' },
    { title: '探索声纹方案', detail: '', owner: '', due: '', project: '', confidence: 0.4, kind: 'goal' },
  ],
  projects: [], goals: [], questions: [],
  diagrams: {
    flow: { title: '讨论脉络', nodes: [{ id: 'n1', label: '现状', kind: 'start' }], edges: [] },
    tree: { title: '任务树', root: { label: '会议', children: [{ label: '排期', children: [] }] } },
  },
  generated_at: '2026-11-10T09:30:00Z',
  model: 'qwen3.5:4b',
  ...over,
})

const recording = (over: Partial<Recording> = {}): Recording => ({
  id: 'rec_1', title: '周会录音', status: 'ready', model: 'small', duration_ms: 65_000, audio_size: 1024, has_audio: true,
  project_id: '', project_title: '', error: '', job: null, task_count: 0, todos_pending: 0, speaker_count: 0,
  created_at: '2026-11-10T08:05:00Z', updated_at: '2026-11-10T09:30:00Z',
  engine: 'whisper_local', language: 'zh', audio_mime: 'audio/webm', transcript: '今天讨论了排期、预算和人员。',
  segments: [], minutes: minutes(), minutes_model: 'qwen3.5:4b', todos: [], speakers: [], attempts: 1,
  ...over,
})

function renderSection(r: Recording) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><MinutesSection r={r} /></QueryClientProvider>)
}

describe('纪要区', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: settings, meta: {} }), { status: 200 })))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('有纪要：Markdown 摘要、结论、待办建议、图表和按钮都渲染', () => {
    renderSection(recording())
    expect(screen.getByText('纪要')).toBeInTheDocument()
    expect(screen.getByText('会议摘要')).toBeInTheDocument()
    expect(screen.getByText(/讨论了三件事/)).toBeInTheDocument()
    expect(screen.getByText('结论')).toBeInTheDocument()
    expect(screen.getByText('下周先做小样')).toBeInTheDocument()
    expect(screen.getByText('待办建议')).toBeInTheDocument()
    expect(screen.getByText('找财务确认预算')).toBeInTheDocument()
    expect(screen.getByText('90%')).toBeInTheDocument()
    expect(screen.getByText('讨论脉络')).toBeInTheDocument()
    expect(screen.getByText(/qwen3\.5:4b/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新生成' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '发起纪要 SOP' })).toBeEnabled()
  })

  it('没有纪要：提示生成，按钮是「生成纪要」', () => {
    renderSection(recording({ minutes: null, status: 'transcribed' }))
    expect(screen.getByText(/还没有纪要/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成纪要' })).toBeEnabled()
  })

  it('没有转写全文：提示先转写，生成按钮禁用', () => {
    renderSection(recording({ minutes: null, status: 'transcribed', transcript: '  ' }))
    expect(screen.getByText(/还没有转写全文/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成纪要' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '发起纪要 SOP' })).toBeDisabled()
  })

  it('生成中：按钮禁用并显示生成中提示', () => {
    renderSection(recording({ minutes: null, status: 'summarizing' }))
    expect(screen.getByText(/正在生成纪要/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成中…' })).toBeDisabled()
  })

  it('生成中显示任务进度和已用时间，不再一直 0%', () => {
    const job: RecordingJob = { kind: 'summarize', status: 'running', progress: 45, attempts: 1, last_error: '' }
    renderSection(recording({ minutes: null, status: 'summarizing', job }))
    expect(screen.getByText('45%')).toBeInTheDocument()
    expect(screen.getByText(/已用 0:00/)).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: '纪要生成进度' })).toHaveAttribute('aria-valuenow', '45')
    expect(screen.getByText(/本机模型生成中/)).toBeInTheDocument()
  })

  it('排队中显示排队提示，进度为 0 也不像卡死', () => {
    const job: RecordingJob = { kind: 'summarize', status: 'pending', progress: 0, attempts: 0, last_error: '' }
    renderSection(recording({ minutes: null, status: 'transcribed', job }))
    expect(screen.getByText('排队等待生成纪要…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成中…' })).toBeDisabled()
  })
})
