import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentProvider } from '../../../core/data'
import { kindOf, uiKindOf } from './catalog'
import { createBody, initialForm, missingFields, modelList, patchBody } from './model'
import { ProvidersSection } from './ProvidersSection'

function prov(p: Partial<AgentProvider> & { id: string }): AgentProvider {
  return {
    name: p.id, kind: 'openai', base_url: 'https://api.openai.com/v1', model: '', enabled: true, is_default: false,
    api_key_masked: '', has_api_key: false, extra: {}, created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z', ...p,
  }
}

describe('表单和请求体', () => {
  it('DeepSeek 走 openai 协议加 preset，没填地址不带 base_url', () => {
    const def = kindOf('deepseek')
    const f = { ...initialForm(def), values: { api_key: ' sk-x ', base_url: '', model_ids: '' } }
    expect(createBody(def, f)).toEqual({ name: 'DeepSeek', kind: 'openai', model: 'deepseek-chat', enabled: true, api_key: 'sk-x', extra: { preset: 'deepseek' } })
    expect(uiKindOf({ kind: 'openai', extra: { preset: 'deepseek' } })).toBe('deepseek')
  })

  it('Anthropic 是 kind=anthropic，没有 preset', () => {
    const def = kindOf('anthropic')
    expect(createBody(def, { ...initialForm(def), values: { api_key: 'k', base_url: '', model_ids: '' } }))
      .toMatchObject({ kind: 'anthropic', extra: {} })
    expect(uiKindOf({ kind: 'anthropic', extra: {} })).toBe('anthropic')
  })

  it('编辑时 API Key 空着不带；已配过的不算没填；只带改了的字段，extra 里别的键保留', () => {
    const def = kindOf('openai')
    const p = prov({ id: 'apv_a', name: 'OpenAI', model: 'gpt-5', has_api_key: true, api_key_masked: 'sk-…abcd', extra: { temperature: 0.2 } })
    const f = initialForm(def, p)
    expect(f.values.api_key).toBe('')
    expect(missingFields(def, f, p)).toEqual([])
    expect(patchBody(def, f, p)).toEqual({})
    expect(patchBody(def, { ...f, name: 'OpenAI 公司' }, p)).toEqual({ name: 'OpenAI 公司' })
    expect(patchBody(def, { ...f, values: { ...f.values, api_key: 'sk-new' } }, p)).toEqual({ api_key: 'sk-new' })
    const v = kindOf('vllm')
    const pv = prov({ id: 'apv_v', base_url: 'http://gpu:8000/v1', has_api_key: true, extra: { preset: 'vllm', temperature: 0.2 } })
    expect(patchBody(v, { ...initialForm(v, pv), values: { api_key: '', base_url: 'http://gpu:8000/v1', model_ids: 'a, b' } }, pv))
      .toEqual({ extra: { preset: 'vllm', temperature: 0.2, model_ids: 'a, b' } })
  })

  it('新建时必填的 API Key 没填就拦下', () => {
    const def = kindOf('anthropic')
    expect(missingFields(def, initialForm(def))).toEqual(['api_key'])
    expect(missingFields(kindOf('ollama'), initialForm(kindOf('ollama')))).toEqual([])
  })

  it('模型候选：测通了用返回的列表，目录里有的补上信息，当前默认模型总在里面', () => {
    const def = kindOf('anthropic')
    const f = { ...initialForm(def), model: 'claude-old' }
    const tested = modelList(def, f, { result: { ok: true, latency_ms: 5, message: '', models: ['claude-sonnet-5-5', 'x-1'] }, at: 0 })
    expect(tested.source).toBe('tested')
    expect(tested.rows.map((r) => [r.id, r.name, r.known])).toEqual([
      ['claude-old', 'claude-old', false], ['claude-sonnet-5-5', 'Claude Sonnet 5.5', true], ['x-1', 'x-1', false],
    ])
    expect(modelList(def, initialForm(def)).source).toBe('catalog')
    const c = kindOf('custom')
    expect(modelList(c, { ...initialForm(c), values: { api_key: '', base_url: '', model_ids: 'a，b c' } }).rows.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })
})

type Call = { method: string; path: string; body: unknown }

function stub(rows: AgentProvider[], models: string[] = ['qwen3.5:4b', 'deepseek-r1:1.5b']) {
  const calls: Call[] = []
  const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path, body })
    if (path === '/api/agent-providers' && method === 'GET') return new Response(JSON.stringify({ data: rows, meta: { total: rows.length } }))
    if (path === '/api/agent-providers' && method === 'POST') {
      const p = prov({ id: 'apv_new', ...body, has_api_key: !!body.api_key, api_key_masked: body.api_key ? 'sk-…1234' : '' })
      delete (p as Record<string, unknown>).api_key
      rows = [...rows, p]
      return ok(p, 201)
    }
    const m = /^\/api\/agent-providers\/([^/]+)(?:\/(\w+))?$/.exec(path)!
    const [id, action] = [m[1], m[2]]
    if (action === 'test') return ok({ ok: true, latency_ms: 12, message: '', models })
    if (method === 'PATCH') {
      rows = rows.map((r) => {
        if (r.id !== id) return r
        const { api_key: key, ...rest } = body
        const next = { ...r, ...rest }
        if (key !== undefined) Object.assign(next, { has_api_key: key !== '', api_key_masked: key ? 'sk-…new0' : '' })
        return next
      })
      return ok(rows.find((r) => r.id === id))
    }
    if (method === 'DELETE') {
      rows = rows.filter((r) => r.id !== id)
      return ok(null)
    }
    return new Response('{}', { status: 404 })
  }))
  return calls
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path, c.body])

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><ProvidersSection /></QueryClientProvider>)
}

afterEach(() => { vi.unstubAllGlobals() })

describe('模型服务商页', () => {
  it('接入 Ollama 后自动测一次，抽屉里列出模型，卡片变成连接正常', async () => {
    const calls = stub([])
    renderPage()
    expect(await screen.findByText('还没接模型服务商，从下面挑一家接入')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Ollama.*接入/ }))
    const drawer = screen.getByRole('dialog')
    expect(within(drawer).getByText('接入 Ollama')).toBeInTheDocument()
    await userEvent.click(within(drawer).getByRole('button', { name: '接入' }))
    expect(await within(screen.getByRole('dialog')).findByText(/连接成功，列出 2 个模型/)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toHaveTextContent('服务商实际返回的模型')
    expect(within(screen.getByRole('dialog')).getByRole('radio', { name: /deepseek-r1:1.5b/ })).toBeInTheDocument()
    expect(writes(calls)).toEqual([
      ['POST', '/api/agent-providers', { name: 'Ollama', kind: 'ollama', model: 'qwen3:14b', enabled: true, extra: {}, base_url: 'http://127.0.0.1:11434' }],
      ['POST', '/api/agent-providers/apv_new/test', undefined],
    ])
    const card = document.querySelector('[data-provider="apv_new"]')!
    expect(card).toHaveTextContent('连接正常')
  })

  it('编辑不填 API Key 保存时请求里不带 api_key', async () => {
    const calls = stub([prov({ id: 'apv_x', name: '自建中转站', base_url: 'https://gw.example.com/v1', model: 'm1', has_api_key: true, api_key_masked: 'sk-…35Od' })])
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: /自建中转站/ }))
    const drawer = screen.getByRole('dialog')
    expect(drawer).toHaveTextContent('当前：sk-…35Od')
    expect(within(drawer).getByPlaceholderText('不改就留空')).toHaveValue('')
    await userEvent.clear(within(drawer).getByDisplayValue('自建中转站'))
    await userEvent.type(within(drawer).getByRole('textbox', { name: /名称/ }), '公司网关')
    await userEvent.click(within(drawer).getByRole('button', { name: '保存' }))
    expect(writes(calls)).toEqual([['PATCH', '/api/agent-providers/apv_x', { name: '公司网关' }]])
    expect(await screen.findByRole('button', { name: /公司网关/ })).toBeInTheDocument()
  })

  it('清空 API Key 要确认，传空串', async () => {
    const calls = stub([prov({ id: 'apv_o', name: '本机 Ollama', kind: 'ollama', base_url: 'http://localhost:11434', model: 'qwen3.5:4b', has_api_key: true, api_key_masked: 'sk-…abcd' })])
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: /本机 Ollama/ }))
    expect(screen.getByRole('dialog')).toHaveTextContent('当前 API Key：sk-…abcd')
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '清空' }))
    const confirm = screen.getByRole('alertdialog')
    expect(confirm).toHaveTextContent('清空 API Key？')
    expect(writes(calls)).toEqual([])
    await userEvent.click(within(confirm).getByRole('button', { name: '清空' }))
    expect(writes(calls)).toEqual([['PATCH', '/api/agent-providers/apv_o', { api_key: '' }]])
  })

  it('后端存着上次的测试结论时，刚打开页面就显示它，不回到「未测试」', async () => {
    const at = new Date(Date.now() - 3 * 3600_000).toISOString()
    stub([
      prov({ id: 'apv_ok', name: 'NewAPI', has_api_key: true, last_test: { ok: true, latency_ms: 105, message: '连接成功', models: ['m1'], at } }),
      prov({ id: 'apv_bad', name: '坏的', has_api_key: true, last_test: { ok: false, latency_ms: 0, message: 'API Key 无效', at } }),
      prov({ id: 'apv_new', name: '没测过', has_api_key: true, last_test: null }),
    ])
    renderPage()
    expect(await screen.findByRole('button', { name: /NewAPI.*连接正常.*3 小时前/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /坏的.*连接异常/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /没测过.*未测试/ })).toBeInTheDocument()
  })

  it('必须有 Key 的类型不能清空；Azure 暂未支持', async () => {
    stub([prov({ id: 'apv_a', name: 'Anthropic', kind: 'anthropic', base_url: 'https://api.anthropic.com', has_api_key: true, api_key_masked: 'sk-…9999' })])
    renderPage()
    expect(await screen.findByRole('button', { name: /Azure OpenAI.*暂未支持/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Anthropic.*再接一个/ })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: /^Anthropic.*未测试/ }))
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: '清空' })).toBeDisabled()
  })

  it('删除要确认；默认服务商写明默认会转给别人', async () => {
    const calls = stub([prov({ id: 'apv_d', name: 'DeepSeek', extra: { preset: 'deepseek' }, base_url: 'https://api.deepseek.com', has_api_key: true, is_default: true })])
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: /^DeepSeek.*默认/ }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除服务商' }))
    const confirm = screen.getByRole('alertdialog')
    expect(confirm).toHaveTextContent('删除后最早接入的启用服务商成为默认')
    await userEvent.click(within(confirm).getByRole('button', { name: '删除' }))
    expect(writes(calls)).toEqual([['DELETE', '/api/agent-providers/apv_d', undefined]])
    expect(await screen.findByText('还没接模型服务商，从下面挑一家接入')).toBeInTheDocument()
  })
})
