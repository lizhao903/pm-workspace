// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskRun, WorkObject } from '../../core/data'
import { HandOffButton } from './HandOff'
import { RunsBlock } from './Runs'
import { resetLiveRuns } from './runLive'

// TSK-0460：任务交给工作台 Agent。打桩 fetch：Agent、场景、服务商、执行记录、发起执行（回一段带确认的 SSE）、确认接口

const task = { id: 'obj_1', ref: 'TSK-0001', title: '整理竞品' } as WorkObject

const agents = [
  { id: 'ag_off', name: '停了的', enabled: false, provider_id: 'apv_1', model: 'm1', desc: '' },
  { id: 'ag_a', name: '分诊', enabled: true, provider_id: 'apv_1', model: 'm1', desc: '' },
  { id: 'ag_b', name: '执行助手', enabled: true, provider_id: 'apv_1', model: 'm1', desc: '专门执行任务' },
]

function stub(opts: { rows?: TaskRun[]; scenario?: string; events?: unknown[]; hold?: Promise<void> } = {}) {
  const bodies: { url: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url.endsWith('/api/agents')) return json(agents)
    if (url.endsWith('/api/agents/scenarios')) return json([{ key: 'task_run', label: '执行任务', desc: '', agent_id: opts.scenario ?? '' }])
    if (url.endsWith('/api/agent-providers')) return json([{ id: 'apv_1', name: '本机', kind: 'ollama', model: 'm1', enabled: true, is_default: true, extra: {} }])
    if (url.endsWith('/api/objects/obj_1/run')) {
      bodies.push({ url, body: JSON.parse(String(init?.body)) })
      const events = opts.events ?? [
        { type: 'start', run_id: 'run_a1', workdir: '', session_id: 'ses_1' },
        { type: 'delta', text: '读完了' },
        { type: 'done', run_id: 'run_a1', exit_code: 0 },
      ]
      const enc = new TextEncoder()
      const stream = new ReadableStream({
        async start(c) {
          for (const e of events) {
            if ((e as { type: string }).type === 'decision' && opts.hold) await opts.hold
            c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
          }
          c.close()
        },
      })
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    const dec = /\/api\/agent\/tool-calls\/([^/]+)\/(confirm|reject)$/.exec(url)
    if (dec) {
      bodies.push({ url, body: dec[2] })
      return new Response(`data: ${JSON.stringify({ type: 'done', session_id: 'ses_1' })}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (url.endsWith('/api/run-prompts')) return json([{ id: 'rp_ro', scene: '分类', content: '只分类', permission: 'read_only', default: false }])
    if (url.includes('/api/objects/obj_1/runs')) return json(opts.rows ?? [])
    return json([])
  }))
  return bodies
}

function renderUI() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/tasks']}>
        <HandOffButton task={task} workdir="" />
        <RunsBlock task={task} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetLiveRuns()
})

describe('交给工作台 Agent', () => {
  it('默认选场景「执行任务」的 Agent；发起的请求体带 harness=agent、Agent、角色、补充说明', async () => {
    const bodies = stub({ scenario: 'ag_b' })
    renderUI()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '交给执行' }))
    await user.click(screen.getByRole('radio', { name: '工作台 Agent' }))
    const pick = await screen.findByRole('combobox', { name: 'Agent' })
    await waitFor(() => expect(pick).toHaveValue('ag_b'))
    // 停用的不在下拉里
    expect(screen.queryByRole('option', { name: '停了的' })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '接着上次的会话' })).toBeDisabled()
    await user.selectOptions(screen.getByRole('combobox', { name: '角色' }), 'rp_ro')
    expect(screen.getByText(/只读角色：只给 Agent 读的工具/)).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: '补充说明' }), '先看 A 家')
    await user.click(screen.getByRole('button', { name: '开始执行' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].body).toEqual({ harness: 'agent', agent_id: 'ag_b', preset_id: 'rp_ro', extra_prompt: '先看 A 家' })
    expect(screen.queryByRole('dialog', { name: '交给工作台 Agent' })).not.toBeInTheDocument()
  })

  it('没选场景时用第一个启用的；有上次的会话能勾续跑，续跑不带 agent_id', async () => {
    const rows = [{ id: 'run_old', object_id: 'obj_1', status: 'done', harness: 'agent', harness_session: 'ses_0', mode: 'stream', output: '', error: '', prompt: '', workdir: '', exit_code: 0, started_at: '2026-11-05T08:00:00Z', finished_at: '2026-11-05T08:01:00Z' }] as TaskRun[]
    const bodies = stub({ rows })
    renderUI()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '交给执行' }))
    await user.click(screen.getByRole('radio', { name: '工作台 Agent' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Agent' })).toHaveValue('ag_a'))
    const resume = screen.getByRole('checkbox', { name: '接着上次的会话' })
    await waitFor(() => expect(resume).toBeEnabled())
    await user.click(resume)
    expect(screen.queryByRole('combobox', { name: 'Agent' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '接着上次执行' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].body).toEqual({ harness: 'agent', resume_session: true })
    // 执行记录里标执行器、有「打开会话继续」
    expect(await screen.findByText('工作台 Agent')).toBeInTheDocument()
  })

  it('流里的确认卡片：点确认走确认接口，决定回来后卡片变成已确认', async () => {
    let release = () => {}
    const hold = new Promise<void>((r) => { release = r })
    const bodies = stub({
      hold,
      events: [
        { type: 'start', run_id: 'run_a2', workdir: '', session_id: 'ses_2' },
        { type: 'confirm', id: 'atc_1', name: 'update_object', args: '{}', summary: '修改 TSK-0001', deadline: new Date(Date.now() + 5 * 60000).toISOString() },
        { type: 'decision', id: 'atc_1', approved: true, reason: 'user' },
        { type: 'tool', id: 't1', name: 'update_object', detail: '' },
        { type: 'tool_result', id: 't1', name: 'update_object', ok: true, error: '', summary: '已修改 TSK-0001' },
        { type: 'done', run_id: 'run_a2', exit_code: 0 },
      ],
    })
    renderUI()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '交给执行' }))
    await user.click(screen.getByRole('radio', { name: '工作台 Agent' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '开始执行' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '开始执行' }))
    const card = await screen.findByRole('group', { name: '等你确认的操作' })
    expect(card).toHaveTextContent('修改 TSK-0001')
    expect(card).toHaveTextContent(/分钟内没确认按拒绝处理/)
    await user.click(screen.getByRole('button', { name: '确认执行' }))
    await waitFor(() => expect(bodies.some((b) => b.url.endsWith('/api/agent/tool-calls/atc_1/confirm'))).toBe(true))
    release()
    // 列表桩一直是空的：流收尾后这条从「正在启动」里撤掉，所以只看决定回来、收尾之前那一刻
    await waitFor(() => expect(bodies.some((b) => b.url.endsWith('/run'))).toBe(true))
  })
})
