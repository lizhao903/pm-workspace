// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Recording, RecordingSettings, RecordingSummary } from '../../core/data'
import Page from './Page'

const summary = (id: string, over: Partial<RecordingSummary> = {}): RecordingSummary => ({
  id, title: '', status: 'transcribed', model: 'small', duration_ms: 0, has_audio: true, audio_size: 1024,
  project_id: '', project_title: '', error: '', job: null, task_count: 0, has_minutes: false, todos_pending: 0, speaker_count: 0,
  created_at: '2026-11-10T08:05:00', updated_at: '2026-11-10T08:05:00', ...over,
})

const LIST: RecordingSummary[] = [
  summary('rec_failed', { title: '周会录音', status: 'failed', duration_ms: 65_000, project_title: '产品', error: '模型文件缺失' }),
  summary('rec_done', { title: '访谈', status: 'transcribed', duration_ms: 3_723_000, has_minutes: true, task_count: 2, todos_pending: 3, speaker_count: 2 }),
  summary('rec_live', {
    title: '临时记录', status: 'transcribing',
    job: { kind: 'transcribe', status: 'running', progress: 41, attempts: 0, last_error: '' },
  }),
]

const settings: RecordingSettings = {
  default_engine: 'whisper_local', model: 'small', model_dir: '', whisper_path: '', ffmpeg_path: '', language: 'zh',
  threads: 0, default_project_id: '', minutes_provider: '', minutes_model: '', minutes_flow: '', minutes_threshold: 0.7,
  auto_diarize: true, python_path: '', voiceprint_model_dir: '', max_speakers: 8, match_threshold: 0.65,
  auto_summarize: false, retention_mode: 'keep', updated_at: '2026-11-10T08:00:00',
}

/** 详情：列表项之外的字段补齐（契约 §4.1 + M4a） */
const toDetail = (s: RecordingSummary): Recording => {
  const { has_minutes: _ignored, ...rest } = s
  return {
    ...rest, engine: 'whisper_local', language: 'zh', audio_mime: 'audio/webm', transcript: '今天讨论了三件事',
    segments: [{ seq: 0, start_ms: 0, end_ms: 2400, text: '今天讨论了三件事', speaker: '' }],
    minutes: null, minutes_model: '', todos: [], speakers: [], attempts: 1,
  }
}

/** 详情页：有说话人的录音（段落带 label，说话人区两条） */
const SPEAKERS = [
  { label: 'spk_1', name: '张三', contact_id: 'c1', contact_name: '张三', similarity: 0.86, segments: 1, duration_ms: 2400, detected: true },
  { label: 'spk_2', name: '', contact_id: '', contact_name: '', similarity: 0, segments: 1, duration_ms: 2600, detected: false },
]

/** M6：本机音频设备（含一块虚拟声卡） */
const DEVICES = [
  { index: 0, name: 'MacBook Pro麦克风', default: true, virtual: false },
  { index: 1, name: 'WeMeet Audio Device', default: false, virtual: true },
]

function fakeBackend(opts: { empty?: boolean } = {}) {
  const calls: string[] = []
  const uploads: { path: string; form: FormData }[] = []
  const rows = opts.empty ? [] : LIST.map((r) => ({ ...r }))
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = (init?.method || 'GET').toUpperCase()
    calls.push(`${method} ${u.pathname}`)
    if (typeof FormData !== 'undefined' && init?.body instanceof FormData) uploads.push({ path: u.pathname, form: init.body })
    const ok = (data: unknown, status = 200, meta: Record<string, unknown> = {}) =>
      new Response(JSON.stringify({ data, meta }), { status })
    const fail = (status: number) => new Response(JSON.stringify({ error: { code: 'not_found', message: u.pathname } }), { status })
    if (u.pathname === '/api/recording/recordings' && method === 'GET') return ok(rows)
    if (u.pathname === '/api/recording/settings') return ok(settings)
    if (u.pathname === '/api/recording/audio-devices') {
      return ok(DEVICES, 200, { supported: true, platform: 'darwin', ffmpeg: true, error: '' })
    }
    if (u.pathname === '/api/recording/recordings' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { title?: string }
      const row = summary('rec_new', { title: body.title || '', status: 'draft', has_audio: false, audio_size: 0 })
      rows.unshift(row)
      return ok(toDetail(row), 201)
    }
    const cap = u.pathname.match(/^\/api\/recording\/recordings\/([^/]+)\/capture(?:\/(start|stop))?$/)
    if (cap) {
      const id = decodeURIComponent(cap[1])
      const row = rows.find((r) => r.id === id)
      if (method === 'POST' && cap[2] === 'start') {
        return ok({ running: true, device: 1, device_name: 'WeMeet Audio Device', started_at: '2026-11-11T10:40:00Z', duration_ms: 0 }, 202)
      }
      if (method === 'POST' && cap[2] === 'stop') {
        if (row) {
          row.status = 'uploaded'
          row.has_audio = true
        }
        return ok(toDetail(row ?? summary(id, { status: 'uploaded', has_audio: true })), 202)
      }
      if (method === 'DELETE') return ok({ ok: true })
      return fail(404)
    }
    const m = u.pathname.match(/^\/api\/recording\/recordings\/([^/]+)$/)
    if (m) {
      const id = decodeURIComponent(m[1])
      const row = rows.find((r) => r.id === id)
      if (!row) return fail(404)
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { title?: string }
        if (body.title) row.title = body.title
      }
      const detail = toDetail(row)
      if (row.speaker_count > 0) {
        detail.speakers = SPEAKERS
        detail.segments = [
          { seq: 0, start_ms: 0, end_ms: 2400, text: '今天讨论了三件事', speaker: 'spk_1' },
          { seq: 1, start_ms: 2400, end_ms: 5000, text: '预算按季度申请', speaker: 'spk_2' },
        ]
      }
      return ok(detail)
    }
    if (/^\/api\/recording\/recordings\/[^/]+\/files$/.test(u.pathname)) return ok([])
    return fail(404)
  }))
  return { calls, rows, uploads }
}

function renderAt(path = '/recording') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/recording/*" element={<Page />} />
          <Route path="*" element={<div>别的页面</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('录音列表页', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('渲染录音行：标题、状态、时长、项目、待确认/纪要标记', async () => {
    fakeBackend()
    renderAt()
    expect(await screen.findByText('周会录音')).toBeInTheDocument()
    expect(screen.getByText('访谈')).toBeInTheDocument()
    const failedRow = screen.getByText('周会录音').closest('li')!
    expect(failedRow).toHaveTextContent('失败')
    expect(failedRow).toHaveTextContent('1:05')
    expect(failedRow).toHaveTextContent('产品')
    const doneRow = screen.getByText('访谈').closest('li')!
    expect(doneRow).toHaveTextContent('1:02:03')
    expect(doneRow).toHaveTextContent('已有纪要')
    expect(doneRow).toHaveTextContent('2 位说话人')
    expect(doneRow).toHaveTextContent('2 个任务')
    expect(doneRow).toHaveTextContent('待确认 3')
  })

  it('按状态筛：转写中只看排队/转写中，失败只看失败', async () => {
    fakeBackend()
    renderAt()
    expect(await screen.findByText('临时记录')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '转写中' }))
    expect(screen.getByText('临时记录')).toBeInTheDocument()
    expect(screen.queryByText('周会录音')).not.toBeInTheDocument()
    expect(screen.queryByText('访谈')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '失败' }))
    expect(screen.getByText('周会录音')).toBeInTheDocument()
    expect(screen.queryByText('临时记录')).not.toBeInTheDocument()
  })

  it('空列表提示开始录音', async () => {
    fakeBackend({ empty: true })
    renderAt()
    expect(await screen.findByText('还没有录音')).toBeInTheDocument()
  })

  it('点标题进详情', async () => {
    const { calls } = fakeBackend()
    renderAt()
    await userEvent.click(await screen.findByRole('button', { name: /周会录音/ }))
    expect(await screen.findByText('转写全文')).toBeInTheDocument()
    await waitFor(() => expect(calls).toContain('GET /api/recording/recordings/rec_failed'))
  })

  it('详情页段落左侧显示说话人标签，说话人区同色', async () => {
    fakeBackend()
    renderAt()
    await userEvent.click(await screen.findByRole('button', { name: /访谈/ }))
    expect(await screen.findByText('转写全文')).toBeInTheDocument()
    // 说话人区一条 + 段落标签一条都叫「张三」
    expect((await screen.findAllByText('张三')).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('未绑定')).toBeInTheDocument()
    expect(screen.getByText(/86%/)).toBeInTheDocument()
  })

  it('列表行内重命名：铅笔→输入→回车，PATCH 后标题更新', async () => {
    const { calls } = fakeBackend()
    renderAt()
    const row = (await screen.findByText('周会录音')).closest('li')!
    await userEvent.click(within(row).getByRole('button', { name: '重命名' }))
    const input = within(row).getByRole('textbox', { name: '新标题' })
    await userEvent.clear(input)
    await userEvent.type(input, '周会录音（改）{Enter}')
    await waitFor(() => expect(calls.some((c) => c.startsWith('PATCH /api/recording/recordings/rec_failed'))).toBe(true))
    expect(await screen.findByText('周会录音（改）')).toBeInTheDocument()
  })
})


describe('M6 系统音频采集', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.unstubAllGlobals())

  it('选「系统声音（本机设备）」后读设备并自动挑虚拟声卡', async () => {
    const { calls } = fakeBackend()
    renderAt()
    await userEvent.click(await screen.findByRole('radio', { name: '系统声音（本机设备）' }))
    const picker = await screen.findByRole('combobox', { name: '声音设备' })
    expect(calls).toContain('GET /api/recording/audio-devices')
    expect((picker as HTMLSelectElement).value).toBe('1')
    expect(screen.getByRole('option', { name: /WeMeet Audio Device/ })).toBeInTheDocument()
  })

  it('只录系统声音：建草稿→开始采集→停止→保存进详情', async () => {
    const { calls, uploads } = fakeBackend()
    renderAt()
    const region = await screen.findByRole('region', { name: '录音工作区' })
    await userEvent.click(within(region).getByRole('radio', { name: '系统声音（本机设备）' }))
    await screen.findByRole('combobox', { name: '声音设备' })
    await userEvent.click(within(region).getByRole('button', { name: '开始录音' }))
    await waitFor(() => expect(calls).toContain('POST /api/recording/recordings/rec_new/capture/start'))
    expect(within(region).getByText(/系统声音（本机设备） · 录音中/)).toBeInTheDocument()
    await userEvent.click(within(region).getByRole('button', { name: '停止并转写' }))
    await waitFor(() => expect(calls).toContain('POST /api/recording/recordings/rec_new/capture/stop'))
    expect(await screen.findByText('转写全文')).toBeInTheDocument()
    const stop = uploads.find((u) => u.path.endsWith('/capture/stop'))
    expect(stop).toBeTruthy()
    expect(stop!.form.has('mic')).toBe(false)
    expect(stop!.form.get('duration_ms')).not.toBeNull()
  })

  it('麦克风+系统声音：停止时把麦克风音频一起提交混音', async () => {
    const track = { stop: vi.fn(), addEventListener: vi.fn() }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => stream), getDisplayMedia: vi.fn() },
    })
    class FakeRecorder {
      static isTypeSupported(): boolean { return true }
      state = 'inactive'
      mimeType = 'audio/webm'
      ondataavailable: ((e: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      start(): void { this.state = 'recording' }
      pause(): void { this.state = 'paused' }
      resume(): void { this.state = 'recording' }
      stop(): void {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['mic'], { type: 'audio/webm' }) })
        this.onstop?.()
      }
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })

    const { calls, uploads } = fakeBackend()
    renderAt()
    const region = await screen.findByRole('region', { name: '录音工作区' })
    await userEvent.click(within(region).getByRole('radio', { name: '麦克风 + 系统声音' }))
    await screen.findByRole('combobox', { name: '声音设备' })
    await userEvent.click(within(region).getByRole('button', { name: '开始录音' }))
    await waitFor(() => expect(calls).toContain('POST /api/recording/recordings/rec_new/capture/start'))
    await userEvent.click(within(region).getByRole('button', { name: '停止并转写' }))
    await waitFor(() => expect(calls).toContain('POST /api/recording/recordings/rec_new/capture/stop'))
    const stop = uploads.find((u) => u.path.endsWith('/capture/stop'))
    expect(stop).toBeTruthy()
    expect(stop!.form.has('mic')).toBe(true)
    expect(stop!.form.get('mic_offset_ms')).not.toBeNull()
  })
})
