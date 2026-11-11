// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 录音常驻：切页面不停、只有手动停止才保存；外壳状态条在别的页面也能看到并随时停。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shellStatusRegistry, shellStatusStore } from '../../core/plugin'
import Page from './Page'
import { ShellStatus } from '../../core/shell/ShellStatus'
import RecorderStatus from './RecorderStatus'
import { getRecorderState, resetRecorderForTest, startRecording, stopRecording } from './recorder'

const track = () => ({ stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })
const stream = (t: ReturnType<typeof track>) => ({ getTracks: () => [t], getAudioTracks: () => [t] })

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

/** 一个最小的录音后端：建草稿 + 收音频，记下调用 */
function fakeBackend() {
  const calls: string[] = []
  const uploads: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x')
    const method = (init?.method || 'GET').toUpperCase()
    calls.push(`${method} ${url.pathname}`)
    if (typeof FormData !== 'undefined' && init?.body instanceof FormData) uploads.push(url.pathname)
    const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ data, meta: {} }), { status })
    if (url.pathname === '/api/recording/recordings' && method === 'GET') return ok([])
    if (/\/(files|speakers|voiceprints)$/.test(url.pathname)) return ok([])
    if (url.pathname === '/api/recording/meta') return ok({ models: [] })
    if (url.pathname === '/api/recording/recordings' && method === 'POST') return ok({ id: 'rec_new' }, 201)
    if (url.pathname === '/api/recording/recordings/rec_new/audio') return ok({ id: 'rec_new' }, 202)
    if (url.pathname === '/api/recording/recordings/rec_new' && method === 'GET') {
      return ok({
        id: 'rec_new', title: '', status: 'uploading', model: '', duration_ms: 1000, has_audio: true, audio_size: 4,
        project_id: '', project_title: '', error: '', job: null, task_count: 0, has_minutes: false, todos_pending: 0,
        speaker_count: 0, created_at: '2026-11-11 10:00', updated_at: '2026-11-11 10:00',
        engine: '', language: '', audio_mime: 'audio/webm', transcript: '', segments: [], minutes: null,
        minutes_model: '', todos: [], speakers: [], attempts: 1,
      })
    }
    if (url.pathname === '/api/recording/settings') return ok({})
    return ok({})
  }))
  return { calls, uploads }
}

function stubMic() {
  const t = track()
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream(t)), getDisplayMedia: vi.fn() },
  })
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  return t
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const workRegion = () => screen.getByRole('region', { name: '录音工作区' })

beforeEach(() => {
  localStorage.clear()
  resetRecorderForTest()
})

afterEach(() => {
  resetRecorderForTest()
  shellStatusStore.removeOwner('recording')
  vi.unstubAllGlobals()
})

describe('录音常驻：切页面不停', () => {
  it('录着的时候切到别的模块，麦克风不关、计时继续；切回来还能手动停止并保存', async () => {
    const { uploads } = fakeBackend()
    const t = stubMic()
    const router = createMemoryRouter([
      { path: '/recording/*', element: <Page /> },
      { path: '/tasks', element: <div>任务页</div> },
    ], { initialEntries: ['/recording'] })
    wrap(<RouterProvider router={router} />)

    await userEvent.click(within(workRegion()).getByRole('button', { name: '开始录音' }))
    await waitFor(() => expect(getRecorderState().phase).toBe('recording'))
    expect(t.stop).not.toHaveBeenCalled()

    // 切到任务页：录音页卸载，但引擎在模块级，麦克风不能关
    await act(async () => { await router.navigate('/tasks') })
    expect(await screen.findByText('任务页')).toBeInTheDocument()
    expect(getRecorderState().phase).toBe('recording')
    expect(t.stop).not.toHaveBeenCalled()

    // 切回录音页：还在录音中
    await act(async () => { await router.navigate('/recording') })
    expect(await screen.findByText(/麦克风 · 录音中/)).toBeInTheDocument()

    // 只有点「停止并转写」才停并保存
    await userEvent.click(within(workRegion()).getByRole('button', { name: '停止并转写' }))
    await waitFor(() => expect(uploads).toContain('/api/recording/recordings/rec_new/audio'))
    expect(getRecorderState().phase).toBe('idle')
  })

  it('在别的页面点停止也照样保存（外壳状态条用的就是这条路径）', async () => {
    const { uploads } = fakeBackend()
    stubMic()
    const router = createMemoryRouter([
      { path: '/recording/*', element: <Page /> },
      { path: '/tasks', element: <div>任务页</div> },
    ], { initialEntries: ['/recording'] })
    wrap(<RouterProvider router={router} />)

    await userEvent.click(within(workRegion()).getByRole('button', { name: '开始录音' }))
    await waitFor(() => expect(getRecorderState().phase).toBe('recording'))
    await act(async () => { await router.navigate('/tasks') })

    act(() => stopRecording())
    await waitFor(() => expect(uploads).toContain('/api/recording/recordings/rec_new/audio'))
    expect(getRecorderState().phase).toBe('idle')
  })
})

describe('外壳状态条：任意页面可见、可停', () => {
  it('录音中显示计时和停止按钮，点停止后保存并消失', async () => {
    const { uploads } = fakeBackend()
    stubMic()
    shellStatusRegistry('recording').register({ key: 'recorder', order: 10, render: RecorderStatus })

    wrap(<MemoryRouter initialEntries={['/tasks']}><ShellStatus /></MemoryRouter>)

    await act(async () => { await startRecording() })
    expect(await screen.findByText('录音中')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '停止并转写' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '停止并转写' }))
    await waitFor(() => expect(uploads).toContain('/api/recording/recordings/rec_new/audio'))
    await waitFor(() => expect(screen.queryByText('录音中')).not.toBeInTheDocument())
  })
})
