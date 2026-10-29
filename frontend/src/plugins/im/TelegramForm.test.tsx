import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Connector } from '../../core/data'
import { TelegramForm } from './TelegramForm'
import { telegramModeLabel, telegramTokenOk, webhookUrlError } from './telegramModel'

const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefgh'

function conn(p: Partial<Connector> = {}): Connector {
  return {
    id: 'cn_tg', tool: 'telegram', name: 'Telegram', account: '', status: 'connecting', error: '', auth_mode: 'token',
    config: {}, secret_hints: { bot_token: '1234…efgh' }, direction: 'both', interval: 0, tools: [], tools_at: null,
    last_tested_at: null, last_sync_at: null, available: true, created_at: '', updated_at: '', ...p,
  }
}

type Call = { method: string; path: string; body?: Record<string, unknown> }

function backend(testOk = true) {
  const calls: Call[] = []
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/connectors' && method === 'POST') return json(conn({ config: body.config, direction: body.direction }), 201)
    if (u.pathname === '/api/connectors/cn_tg' && method === 'PATCH') return json(conn({ config: body.config }))
    if (u.pathname === '/api/connectors/cn_tg/test') {
      return json(testOk
        ? { ok: true, account: 'PM Bot（@pm_bot）', message: '连接正常', connector: conn({ status: 'connected', account: 'PM Bot（@pm_bot）' }) }
        : { ok: false, account: '', message: 'Telegram 返回 401：Unauthorized', connector: conn({ status: 'error' }) })
    }
    return json([])
  }))
  return calls
}

function renderForm(props: Parameters<typeof TelegramForm>[0] = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><TelegramForm {...props} /></QueryClientProvider>)
}

afterEach(() => { vi.unstubAllGlobals() })

describe('Telegram 渠道表单', () => {
  it('校验 Token 和公网地址', () => {
    expect(telegramTokenOk(TOKEN)).toBe(true)
    expect(telegramTokenOk('abc')).toBe(false)
    expect(webhookUrlError('')).toBeUndefined()
    expect(webhookUrlError('https://bro.vip')).toBeUndefined()
    expect(webhookUrlError('http://bro.vip')).toMatch(/https/)
    expect(webhookUrlError('https://bro.vip/hook')).toMatch(/路径/)
    expect(telegramModeLabel({ config: {} })).toBe('长轮询，随到随收')
    expect(telegramModeLabel({ config: { webhook_url: 'https://bro.vip' } })).toBe('经 webhook 推送')
  })

  it('新建：Token 进 secrets，保存后自动测试并显示账号', async () => {
    const calls = backend()
    const onSaved = vi.fn()
    renderForm({ onSaved })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '接入并测试' }))
    expect(screen.getByText('必填')).toBeInTheDocument()
    await user.type(screen.getByLabelText(/Bot Token/), TOKEN)
    await user.click(screen.getByRole('button', { name: '接入并测试' }))
    expect(await screen.findByText('已连上 PM Bot（@pm_bot）')).toBeInTheDocument()
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/connectors')
    expect(post?.body).toMatchObject({ tool: 'telegram', direction: 'both', secrets: { bot_token: TOKEN } })
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ status: 'connected' }))
    // 保存后明文从输入框清掉
    expect(screen.getByLabelText(/Bot Token/)).toHaveValue('')
  })

  it('修改：不填 Token 时不动凭证，只显示脱敏提示；测试失败写出原因', async () => {
    const calls = backend(false)
    renderForm({ connector: conn() })
    expect(screen.getByText(/已保存（1234…efgh）/)).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('checkbox', { name: /允许从这里回复/ }))
    await user.click(screen.getByRole('button', { name: '保存并测试' }))
    expect(await screen.findByText(/连不上：Telegram 返回 401/)).toBeInTheDocument()
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true))
    const p = calls.find((c) => c.method === 'PATCH')
    expect(p?.body).toMatchObject({ direction: 'receive', config: { webhook_url: '' } })
    expect(p?.body).not.toHaveProperty('secrets')
  })
})
