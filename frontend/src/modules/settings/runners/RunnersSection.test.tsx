import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunnerSmoke, RunnerStatus } from '../../../core/data'
import { RunnersSection } from './RunnersSection'

// TSK-0722：设置「执行器」：三张卡片、缺什么和安装步骤、「检测」跳过缓存、DeepSeek 集成检查

const base = { modes: ['stream'], mcp: true, provider_id: '', provider_name: '', model: '', problems: [], checked_at: '2026-11-06T10:00:00Z' }
const list = (dshVersion = ''): RunnerStatus[] => [
  { ...base, harness: 'claude', label: 'Claude Code', available: true, modes: ['stream', 'terminal'], bin: '/u/claude', bin_source: 'path', version: '2.1.0' } as RunnerStatus,
  {
    ...base, harness: 'deepseek', label: 'DeepSeek', available: !!dshVersion, bin: dshVersion ? '/opt/dsh' : 'dsh', bin_source: dshVersion ? 'flag' : 'path', version: dshVersion,
    provider_id: 'apv_ol', provider_name: '本机 Ollama', model: 'qwen3:4b',
    problems: dshVersion ? [] : [{ code: 'not_installed', message: '找不到 dsh 可执行文件', fix: '先装', steps: ['npm i --prefix ~/.local/share/pmw-dsh @deepseek-ai/dsh'], blocking: true }],
  } as RunnerStatus,
  { ...base, harness: 'agent', label: '工作台 Agent', available: true, bin: '', bin_source: 'builtin', version: 'dev' } as RunnerStatus,
]

const done: RunnerSmoke = {
  id: 'smk_1', harness: 'deepseek', status: 'failed', started_at: '2026-11-06T10:00:00Z', finished_at: '2026-11-06T10:01:00Z',
  bin: '/opt/dsh', version: '0.2.2-rc.1', provider_id: 'apv_ol', provider_name: '本机 Ollama', model: 'qwen3:4b', session_id: 'session-1',
  conclusion: '目录里有：README.md、probe.txt', answer: '有两个文件',
  checks: [
    { key: 'spawn', label: '起进程', status: 'pass', detail: '会话 session-1', ms: 1500 },
    { key: 'mcp', label: 'MCP 回写', status: 'fail', detail: '模型没调 pmw_finish_run', ms: 0 },
  ],
}

function stub() {
  const calls: string[] = []
  let smoke: RunnerSmoke | null = null
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { 'Content-Type': 'application/json' } })
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.includes('/api/runners/deepseek/smoke')) {
      if (init?.method === 'POST') {
        smoke = { ...done, status: 'running', finished_at: null }
        return json(smoke, 202)
      }
      const cur = smoke
      if (cur?.status === 'running') smoke = done
      return json(cur)
    }
    if (url.includes('/api/runners')) return json(url.includes('refresh=true') ? list('0.2.2-rc.1') : list())
    if (url.endsWith('/api/agent-providers')) return json([{ id: 'apv_ol', name: '本机 Ollama', kind: 'ollama', model: 'qwen3:4b', enabled: true, is_default: true, extra: {} }])
    return json([])
  }))
  return calls
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><MemoryRouter><RunnersSection /></MemoryRouter></QueryClientProvider>)
}

afterEach(() => vi.unstubAllGlobals())

describe('设置「执行器」', () => {
  it('三张卡片；没装 dsh 时写缺什么和安装步骤；「检测」带 refresh 重取', async () => {
    const calls = stub()
    renderPage()
    const ds = await screen.findByRole('region', { name: 'DeepSeek' })
    expect(within(ds).getByText('不可用')).toBeInTheDocument()
    expect(within(ds).getByText(/找不到 dsh 可执行文件/)).toBeInTheDocument()
    expect(within(ds).getByText('npm i --prefix ~/.local/share/pmw-dsh @deepseek-ai/dsh')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Claude Code' })).toHaveTextContent('2.1.0')
    expect(screen.getByRole('region', { name: '工作台 Agent' })).toHaveTextContent('后台执行')
    expect(await screen.findByText('还没跑过集成检查')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '检测' }))
    await waitFor(() => expect(within(ds).getByText('可用')).toBeInTheDocument())
    expect(calls.some((c) => c.includes('/api/runners?refresh=true'))).toBe(true)
    expect(within(ds).getByText('0.2.2-rc.1')).toBeInTheDocument()
  })

  it('跑集成检查：带选的模型发起，进行中轮询，结束后逐项显示通过与否、结论', async () => {
    const calls = stub()
    renderPage()
    const ds = await screen.findByRole('region', { name: 'DeepSeek' })
    const user = userEvent.setup()
    await user.type(within(ds).getByRole('combobox', { name: '模型' }), 'qwen3:4b')
    await user.click(within(ds).getByRole('button', { name: '跑一次集成检查' }))
    await waitFor(() => expect(calls.some((c) => c.startsWith('POST') && c.includes('/smoke'))).toBe(true))
    expect(await within(ds).findByText(/1 项没通过：MCP 回写/, {}, { timeout: 4000 })).toBeInTheDocument()
    const checks = within(ds).getByRole('list', { name: '检查项' })
    expect(within(checks).getByText('起进程').closest('li')).toHaveAttribute('data-status', 'pass')
    expect(within(checks).getByText('模型没调 pmw_finish_run')).toBeInTheDocument()
    expect(within(ds).getByText('目录里有：README.md、probe.txt')).toBeInTheDocument()
    expect(within(ds).getByRole('button', { name: '跑一次集成检查' })).toBeEnabled()
  })
})
