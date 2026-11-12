// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Recording, RecordingSpeaker, Voiceprint } from '../../core/data'
import type { Contact } from '../../core/data'
import { SpeakersSection } from './Speakers'

const speaker = (over: Partial<RecordingSpeaker> = {}): RecordingSpeaker => ({
  label: 'spk_1', name: '', contact_id: '', contact_name: '', similarity: 0, segments: 1, duration_ms: 2400, detected: false,
  ...over,
})

const SPEAKERS: RecordingSpeaker[] = [
  speaker({ label: 'spk_1', name: '张三', contact_id: 'c1', contact_name: '张三', similarity: 0.86, detected: true }),
  speaker({ label: 'spk_2', segments: 2, duration_ms: 5000 }),
]

const recording = (over: Partial<Recording> = {}): Recording => ({
  id: 'rec_1', title: '周会录音', status: 'ready', model: 'small', duration_ms: 8000, audio_size: 1024, has_audio: true,
  project_id: '', project_title: '', error: '', job: null, task_count: 0, todos_pending: 0, speaker_count: 2,
  created_at: '2026-11-10T08:05:00', updated_at: '2026-11-10T09:30:00',
  engine: 'whisper_local', language: 'zh', audio_mime: 'audio/webm', transcript: '今天讨论了三件事', segments: [
    { seq: 0, start_ms: 0, end_ms: 2400, text: '今天讨论了三件事', speaker: 'spk_1' },
    { seq: 1, start_ms: 2400, end_ms: 5000, text: '预算按季度申请', speaker: 'spk_2' },
  ],
  minutes: null, minutes_model: '', todos: [], speakers: SPEAKERS, attempts: 1,
  ...over,
})

const contact = (id: string, name: string, over: Partial<Contact> = {}): Contact => ({
  id, name, role: '', email: '', note: '', color: '#888', sort_order: 0, archived_at: null,
  created_at: '2026-11-01T00:00:00', updated_at: '2026-11-01T00:00:00', owned_count: 0, participating_count: 0,
  ai_kind: '', group: '', company: '', title: '', phone: '', tags: [], photo: '', starred: false, last_contact_at: null,
  ...over,
})

const CONTACTS = [contact('c1', '张三'), contact('c2', '李四'), contact('c3', '王五', { company: '产品部' })]
const VOICEPRINTS: Voiceprint[] = [
  { contact_id: 'c3', contact_name: '王五', model: 'campplus_cn_common', source_recording_id: 'rec_0', created_at: '', updated_at: '' },
]

function fakeBackend() {
  const calls: { method: string; path: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = (init?.method || 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, path: u.pathname, body })
    const ok = (data: unknown, meta: unknown = { total: Array.isArray(data) ? data.length : 0 }) =>
      new Response(JSON.stringify({ data, meta }), { status: 200 })
    if (u.pathname === '/api/stakeholders') return ok(CONTACTS)
    if (u.pathname === '/api/recording/voiceprints') return ok(VOICEPRINTS)
    const rename = u.pathname.match(/^\/api\/recording\/recordings\/([^/]+)\/speakers\/([^/]+)$/)
    if (rename && method === 'PATCH') return ok({ ...SPEAKERS[0], name: (body as { name: string }).name })
    const bind = u.pathname.match(/^\/api\/recording\/recordings\/([^/]+)\/speakers\/([^/]+)\/bind$/)
    if (bind && method === 'POST') return ok({ ...SPEAKERS[1], contact_id: (body as { contact_id: string }).contact_id, contact_name: '王五' })
    if (/^\/api\/recording\/recordings\/[^/]+\/diarize$/.test(u.pathname)) return ok(recording(), {})
    return new Response(JSON.stringify({ error: { code: 'not_found', message: u.pathname } }), { status: 404 })
  }))
  return calls
}

function renderSection(r: Recording) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={qc}><SpeakersSection r={r} /></QueryClientProvider>)
}

describe('说话人区', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('渲染说话人行：显示名、联系人/相似度徽标、段落数与时长', () => {
    fakeBackend()
    renderSection(recording())
    expect(screen.getByText('说话人')).toBeInTheDocument()
    expect(screen.getAllByText('张三').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('说话人 2')).toBeInTheDocument()
    expect(screen.getByText('未绑定')).toBeInTheDocument()
    expect(screen.getByText('自动匹配 86%')).toBeInTheDocument()
    expect(screen.getByText(/1 段 · 0:02/)).toBeInTheDocument()
    expect(screen.getByText(/2 段 · 0:05/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新识别' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '改绑联系人' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '绑定联系人' })).toBeInTheDocument()
  })

  it('行内改名：铅笔→输入→回车，PATCH 名字', async () => {
    const calls = fakeBackend()
    renderSection(recording())
    await userEvent.click(screen.getByRole('button', { name: '改名 张三' }))
    const input = screen.getByRole('textbox', { name: '说话人显示名' })
    await userEvent.clear(input)
    await userEvent.type(input, '老王{Enter}')
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.path === '/api/recording/recordings/rec_1/speakers/spk_1')).toBe(true))
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: '老王' })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '说话人显示名' })).not.toBeInTheDocument())
  })

  it('绑定联系人：选已有声纹的联系人，提示会覆盖并显示来源录音，POST 绑定', async () => {
    const calls = fakeBackend()
    renderSection(recording())
    await userEvent.click(screen.getByRole('button', { name: '绑定联系人' }))
    expect(await screen.findByText('绑定说话人')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '选择绑定联系人' }))
    await userEvent.click(await screen.findByRole('option', { name: /王五/ }))
    expect(await screen.findByText(/这个联系人已有声纹/)).toBeInTheDocument()
    expect(screen.getByText(/rec_0/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '绑定并覆盖' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/speakers/spk_2/bind'))).toBe(true))
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ contact_id: 'c3' })
  })

  it('识别中显示进度且按钮禁用', () => {
    fakeBackend()
    renderSection(recording({
      job: { kind: 'diarize', status: 'running', progress: 40, attempts: 0, last_error: '' },
    }))
    expect(screen.getByText('说话人识别中 40%')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: '说话人识别进度' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '识别中…' })).toBeDisabled()
  })

  it('识别失败显示原因与可重试', async () => {
    const calls = fakeBackend()
    renderSection(recording({
      job: { kind: 'diarize', status: 'failed', progress: 0, attempts: 1, last_error: '缺 funasr 依赖' },
    }))
    expect(screen.getByText(/说话人识别失败/)).toBeInTheDocument()
    expect(screen.getByText(/缺 funasr 依赖/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新识别' })).toBeEnabled()
    // 已经有说话人 → 先弹确认，再 POST diarize
    await userEvent.click(screen.getByRole('button', { name: '重新识别' }))
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '重新识别' }))
    await waitFor(() => expect(calls.some((c) => c.path === '/api/recording/recordings/rec_1/diarize')).toBe(true))
  })

  it('还没识别：空提示 + 识别说话人按钮', () => {
    fakeBackend()
    renderSection(recording({ speakers: [], speaker_count: 0 }))
    expect(screen.getByText(/还没有识别说话人/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '识别说话人' })).toBeEnabled()
  })

  it('没有音频/段落时识别按钮禁用', () => {
    fakeBackend()
    renderSection(recording({ speakers: [], speaker_count: 0, has_audio: false, segments: [] }))
    expect(screen.getByRole('button', { name: '识别说话人' })).toBeDisabled()
  })
})
