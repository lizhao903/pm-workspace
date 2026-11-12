// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 新会话面板：点 Agent 默认跟随它的默认模型；勾「这次指定模型」后点 Agent，带上选的服务商和模型（会话一开始就单独用它）
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, AgentProvider } from '../../core/data'
import { NewSession } from './NewSession'

const prov = (id: string, name: string, model: string, p: Partial<AgentProvider> = {}): AgentProvider => ({
  id, name, kind: 'openai', base_url: '', model, enabled: true, is_default: false, api_key_masked: '', has_api_key: true, extra: {},
  created_at: '', updated_at: '', ...p,
})
const providers = [prov('apv_1', 'NewAPI', 'deepseek-v4-flash', { is_default: true }), prov('apv_2', '本机 Ollama', 'qwen3:4b')]
const agents = [{ id: 'ag_1', name: '周报助手', desc: '', enabled: true, provider_id: 'apv_2', model: 'qwen3:4b' } as unknown as Agent]

function setup() {
  const onCreate = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}>
    <NewSession agents={agents} providers={providers} busy={false} onCreate={onCreate} onClose={() => undefined} />
  </QueryClientProvider>)
  return onCreate
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })))
})
afterEach(() => vi.unstubAllGlobals())

describe('新会话选模型', () => {
  it('不勾时点 Agent 只带 agent_id，跟随 Agent 默认', async () => {
    const onCreate = setup()
    await userEvent.click(screen.getByRole('button', { name: /周报助手/ }))
    expect(onCreate).toHaveBeenCalledWith({ agent_id: 'ag_1' }, '')
  })

  it('勾「这次指定模型」后点 Agent，带上选的服务商和它的默认模型', async () => {
    const onCreate = setup()
    await userEvent.click(screen.getByRole('checkbox', { name: /这次指定模型/ }))
    expect(screen.getByText('用哪个模型')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /周报助手/ }))
    expect(onCreate).toHaveBeenCalledWith({ agent_id: 'ag_1', provider_id: 'apv_1', model: 'deepseek-v4-flash' }, '')
  })
})
