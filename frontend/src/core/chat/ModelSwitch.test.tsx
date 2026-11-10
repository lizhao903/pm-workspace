// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 会话里换模型（TSK-0720，SPEC-sessions-1.46 到 1.49）：头部显示实际用的模型；只换本会话；同时设为 Agent 默认要确认，
// 依次「换本会话 → 改 Agent → 本会话改回跟随」；正在回复时不能换。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, AgentMessage, AgentProvider, AgentSession } from '../data'
import { foldHistory, modelLabel } from './chatModel'
import { ModelSwitch } from './ModelSwitch'

const now = new Date().toISOString()
const prov = (id: string, name: string, model: string, enabled = true) =>
  ({ id, name, kind: 'ollama', model, enabled, is_default: id === 'apv_1', base_url: '', api_key_masked: '', has_api_key: false, extra: {}, created_at: now, updated_at: now }) as AgentProvider
const providers = [prov('apv_1', '本机', 'm1'), prov('apv_2', '第二家', 'p2'), prov('apv_off', '停用的', 'x', false)]
const agent = { id: 'ag_1', name: '周报助手', provider_id: 'apv_1', model: 'm1', enabled: true } as Agent
const session = (p: Partial<AgentSession> = {}): AgentSession => ({
  id: 'ags_1', title: '周报', object_id: null, provider_id: 'apv_1', model: 'm1', workdir: '', agent_id: 'ag_1', model_override: false,
  created_at: now, updated_at: now, message_count: 2, ...p,
})

let calls: { method: string; path: string; body: unknown }[] = []
beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    if (method !== 'GET' && !u.pathname.endsWith('/test')) calls.push({ method, path: u.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    // 拉模型列表走测试连接
    const data = u.pathname.endsWith('/test') ? { ok: true, latency_ms: 1, message: '', models: ['p2', 'p2-big'] } : {}
    return new Response(JSON.stringify({ data }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

function setup(s: AgentSession, busy = false, a: Agent | null = agent) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><ModelSwitch session={s} agent={a ?? undefined} providers={providers} busy={busy} /></QueryClientProvider>)
}

describe('头部的模型', () => {
  it('显示实际用的服务商和模型，标出是跟随 Agent 还是本会话单独选的', () => {
    setup(session())
    expect(screen.getByRole('button', { name: /本机 · m1/ })).toHaveTextContent('跟随 Agent')
  })

  it('换成别的服务商和模型：只改本会话，PATCH 带 provider_id 和 model', async () => {
    setup(session())
    await userEvent.click(screen.getByRole('button', { name: /本机 · m1/ }))
    const panel = screen.getByRole('dialog', { name: '换模型' })
    await userEvent.click(within(panel).getByRole('radio', { name: /这个会话单独用/ }))
    await userEvent.click(within(panel).getByRole('radio', { name: /第二家/ }))
    expect(within(panel).getByRole('radio', { name: /停用的/ })).toBeDisabled()
    await userEvent.click(within(panel).getByRole('button', { name: '切换' }))
    await waitFor(() => expect(calls).toEqual([{ method: 'PATCH', path: '/api/agent/sessions/ags_1', body: { provider_id: 'apv_2', model: 'p2' } }]))
    expect(screen.queryByRole('dialog', { name: '换模型' })).not.toBeInTheDocument()
  })

  it('同时设为 Agent 默认要确认，确认后依次改本会话、改 Agent、本会话改回跟随', async () => {
    setup(session())
    await userEvent.click(screen.getByRole('button', { name: /本机 · m1/ }))
    const panel = screen.getByRole('dialog', { name: '换模型' })
    await userEvent.click(within(panel).getByRole('radio', { name: /这个会话单独用/ }))
    await userEvent.click(within(panel).getByRole('radio', { name: /第二家/ }))
    await userEvent.click(within(panel).getByRole('checkbox', { name: /同时设为「周报助手」的默认模型/ }))
    await userEvent.click(within(panel).getByRole('button', { name: '切换' }))
    expect(calls).toEqual([])
    expect(within(panel).getByRole('alert')).toHaveTextContent('把「周报助手」的默认模型改成 第二家 · p2？')
    await userEvent.click(within(panel).getByRole('button', { name: '确定改' }))
    await waitFor(() => expect(calls).toEqual([
      { method: 'PATCH', path: '/api/agent/sessions/ags_1', body: { provider_id: 'apv_2', model: 'p2' } },
      { method: 'PATCH', path: '/api/agents/ag_1', body: { provider_id: 'apv_2', model: 'p2' } },
      { method: 'PATCH', path: '/api/agent/sessions/ags_1', body: { model_override: false } },
    ]))
  })

  it('单独选过的可以改回跟随 Agent 默认', async () => {
    setup(session({ provider_id: 'apv_2', model: 'p2', model_override: true }))
    await userEvent.click(screen.getByRole('button', { name: /第二家 · p2/ }))
    const panel = screen.getByRole('dialog', { name: '换模型' })
    await userEvent.click(within(panel).getByRole('radio', { name: /跟随 Agent 默认/ }))
    await userEvent.click(within(panel).getByRole('button', { name: '切换' }))
    await waitFor(() => expect(calls).toEqual([{ method: 'PATCH', path: '/api/agent/sessions/ags_1', body: { model_override: false } }]))
  })

  it('正在回复时不能换', async () => {
    setup(session({ model_override: true }), true)
    await userEvent.click(screen.getByRole('button', { name: /本机 · m1/ }))
    const panel = screen.getByRole('dialog', { name: '换模型' })
    await userEvent.click(within(panel).getByRole('radio', { name: /第二家/ }))
    expect(within(panel).getByRole('button', { name: '切换' })).toBeDisabled()
    expect(panel).toHaveTextContent('正在回复，等这一轮跑完再换模型')
  })

  it('不挂 Agent 的会话没有「跟随」和「设为默认」', async () => {
    setup(session({ agent_id: null }), false, null)
    await userEvent.click(screen.getByRole('button', { name: /本机 · m1/ }))
    const panel = screen.getByRole('dialog', { name: '换模型' })
    expect(within(panel).queryByRole('radio', { name: /跟随 Agent 默认/ })).not.toBeInTheDocument()
    expect(within(panel).queryByRole('checkbox')).not.toBeInTheDocument()
  })
})

describe('模型的显示', () => {
  it('服务商停用的标出来，删了的写已删除的服务商', () => {
    expect(modelLabel('apv_off', 'x', providers)).toEqual({ text: '停用的 · x（已停用）', disabled: true, gone: false })
    expect(modelLabel('apv_gone', 'y', providers)).toEqual({ text: '已删除的服务商 · y', disabled: false, gone: true })
  })

  it('切换提示单独成一条；回复带着当时用的模型', () => {
    const m = (p: Partial<AgentMessage>): AgentMessage => ({ id: 'x', session_id: 'ags_1', role: 'user', content: '', created_at: now, ...p })
    const out = foldHistory([
      m({ id: 'u1', content: '问' }),
      m({ id: 'a1', role: 'assistant', content: '答', provider_id: 'apv_1', model: 'm1' }),
      m({ id: 'n1', role: 'notice', content: '已切换到 第二家 · p2，之后的回复用它，之前的回复不变', provider_id: 'apv_2', model: 'p2' }),
      m({ id: 'a2', role: 'assistant', content: '再答' }),
    ])
    expect(out.map((v) => [v.id, v.role, v.model ?? ''])).toEqual([['u1', 'user', ''], ['a1', 'agent', 'm1'], ['n1', 'notice', ''], ['a2', 'agent', '']])
    expect(out[1].providerId).toBe('apv_1')
  })
})
