// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunnerStatus, TaskRun, WorkObject } from '../../core/data'
import { HandOffButton } from './HandOff'
import { resetLiveRuns } from './runLive'

// TSK-0722：「交给执行」一个入口，弹窗最上面选交给谁；DeepSeek 和 Claude Code 共用弹窗。

const task = { id: 'obj_1', ref: 'TSK-0001', title: '写方案' } as WorkObject

const status = (harness: RunnerStatus['harness'], over: Partial<RunnerStatus> = {}): RunnerStatus => ({
  harness, label: harness, available: true, modes: ['stream'], bin: '', bin_source: 'path', version: '1', mcp: true,
  provider_id: '', provider_name: '', model: '', problems: [], checked_at: '2026-11-06T10:00:00Z', ...over,
})

const notInstalled = status('deepseek', {
  available: false,
  problems: [{ code: 'not_installed', message: '找不到 dsh 可执行文件', fix: '先装 deepseek-harness', steps: ['npm i --prefix x @deepseek-ai/dsh'], blocking: true }],
})
const dshOK = status('deepseek', { provider_id: 'apv_ds', provider_name: 'DeepSeek', model: 'deepseek-chat' })

function stub(runners: RunnerStatus[], rows: TaskRun[] = []) {
  const bodies: unknown[] = []
  const prompts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url.endsWith('/api/runners')) return json(runners)
    if (url.endsWith('/api/agent/workdir/check')) {
      const { path } = JSON.parse(String(init?.body)) as { path: string }
      return json({ path, exists: true, is_dir: true, writable: true, message: '' })
    }
    if (url.endsWith('/api/agent-providers')) {
      return json([
        { id: 'apv_ds', name: 'DeepSeek', kind: 'openai', model: 'deepseek-chat', enabled: true, is_default: false, extra: {} },
        { id: 'apv_gm', name: 'Gemini', kind: 'gemini', model: 'g', enabled: true, is_default: false, extra: {} },
        { id: 'apv_ol', name: '本机 Ollama', kind: 'ollama', model: 'qwen3:4b', enabled: true, is_default: true, extra: {} },
      ])
    }
    if (url.endsWith('/api/objects/obj_1/run')) {
      bodies.push(JSON.parse(String(init?.body)))
      const sse = [{ type: 'start', run_id: 'run_d1', workdir: '/ok/w' }, { type: 'done', run_id: 'run_d1', exit_code: 0 }]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (url.includes('/api/objects/obj_1/run/prompt')) {
      prompts.push(url)
      return json({ prompt: '预览', workdir: '/ok/w' })
    }
    if (url.endsWith('/api/run-permissions')) return json({ write_profile: 'custom', custom: ['Bash(make:*)'], profiles: [], mcp_server: 'pmw-run' })
    if (url.includes('/api/objects/obj_1/runs')) return json(rows)
    return json([])
  }))
  return { bodies, prompts }
}

function renderButton() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/tasks']}>
        <HandOffButton task={task} workdir="/ok/w" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetLiveRuns()
})

describe('交给执行：交给谁（TSK-0722）', () => {
  it('一个入口列出三种执行器；没装 dsh 时 DeepSeek 置灰，写明缺什么并链到设置「执行器」', async () => {
    stub([status('claude', { modes: ['stream', 'terminal'] }), notInstalled, status('agent')])
    renderButton()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '交给执行' }))
    const group = await screen.findByRole('group', { name: '交给谁' })
    const ds = within(group).getByRole('radio', { name: 'DeepSeek' })
    await waitFor(() => expect(ds).toBeDisabled())
    expect(within(group).getByRole('radio', { name: 'Claude Code' })).toBeChecked()
    expect(within(group).getByRole('radio', { name: '工作台 Agent' })).toBeEnabled()
    expect(within(group).getByText(/DeepSeek 不可用：找不到 dsh 可执行文件。先装 deepseek-harness/)).toBeInTheDocument()
    expect(within(group).getByRole('link', { name: '设置 / 执行器' })).toHaveAttribute('href', '/settings/runners')
    expect(screen.getByRole('dialog', { name: '交给 Claude Code' })).toBeInTheDocument()
  })

  it('交给 DeepSeek：没有执行方式、能选服务商和模型；自定义白名单置灰、设置里默认它时退回允许改文件；请求带 harness、模型和档位', async () => {
    const { bodies, prompts } = stub([status('claude'), dshOK, status('agent')])
    renderButton()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '交给执行' }))
    await user.click(await screen.findByRole('radio', { name: 'DeepSeek' }))
    const dialog = await screen.findByRole('dialog', { name: '交给 DeepSeek' })
    // 换了执行器焦点留在「交给谁」那一排
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: 'DeepSeek' })).toHaveFocus())
    expect(within(dialog).queryByRole('group', { name: '执行方式' })).not.toBeInTheDocument()
    // 服务商：默认那项写后端挑的；只列 dsh 能接的（gemini 不在）
    const prov = within(dialog).getByRole('combobox', { name: '服务商' })
    await waitFor(() => expect(within(prov).getByRole('option', { name: '默认（DeepSeek · deepseek-chat）' })).toBeInTheDocument())
    await waitFor(() => expect(within(prov).getByRole('option', { name: '本机 Ollama' })).toBeInTheDocument())
    expect(within(prov).queryByRole('option', { name: 'Gemini' })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('checkbox', { name: '接着上次的会话' })).toBeDisabled()

    await user.type(within(dialog).getByRole('combobox', { name: '模型' }), 'deepseek-reasoner')
    await user.click(within(dialog).getByRole('checkbox', { name: '允许写入' }))
    expect(screen.getByRole('alertdialog', { name: '允许写入？' })).toHaveTextContent('workspace-write')
    await user.click(screen.getByRole('button', { name: '确认允许写入' }))
    const profile = within(dialog).getByRole('combobox', { name: '写入档位' })
    await waitFor(() => expect(profile).toHaveValue('accept_edits'))
    expect(within(profile).getByRole('option', { name: /自定义白名单（DeepSeek 没有，不可选）/ })).toBeDisabled()
    expect(within(dialog).getByText(/dsh 没有命令白名单：这一档是 workspace-write 沙箱/)).toBeInTheDocument()

    await user.click(within(dialog).getByText('提示词预览'))
    await waitFor(() => expect(prompts.some((u) => u.includes('harness=deepseek'))).toBe(true))

    await user.click(within(dialog).getByRole('button', { name: '开始执行（允许写入）' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({
      workdir: '/ok/w', extra_prompt: '', allow_writes: true, permission: 'accept_edits', harness: 'deepseek', model: 'deepseek-reasoner',
    })
  })

  it('DeepSeek 执行过、留了会话：能勾「接着上次的会话」，请求带 resume_session', async () => {
    const rows = [{ id: 'run_old', object_id: 'obj_1', status: 'done', harness: 'deepseek', harness_session: 'session-1', mode: 'stream', output: '', error: '', prompt: '', workdir: '/ok/w', exit_code: 0, started_at: '2026-11-05T08:00:00Z', finished_at: '2026-11-05T08:01:00Z' }] as TaskRun[]
    const { bodies } = stub([status('claude'), dshOK, status('agent')], rows)
    renderButton()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '交给执行' }))
    await user.click(await screen.findByRole('radio', { name: 'DeepSeek' }))
    const box = await screen.findByRole('checkbox', { name: '接着上次的会话' })
    await waitFor(() => expect(box).toBeEnabled())
    await user.click(box)
    await user.click(screen.getByRole('button', { name: '接着上次执行' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ harness: 'deepseek', resume_session: true, permission: 'read_only' })
  })
})
