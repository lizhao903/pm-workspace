import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Connector, ImEmailBackfillResult } from '../../core/data'
import { EmailBackfill } from './EmailBackfill'
import { emailBackfillText } from './channelModel'

const conn = { id: 'cn_sl', tool: 'slack', name: '公司 Slack', config: {}, secret_hints: {}, available: true } as unknown as Connector

function result(p: Partial<ImEmailBackfillResult> = {}): ImEmailBackfillResult {
  return { connector_id: 'cn_sl', checked: 0, filled: 0, skipped: 0, conflicts: [], filled_contacts: [], missing_scope: false, hint: '', pending: 0, ...p }
}

function backend(reply: () => Response) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(String(input), 'http://x').pathname}`)
    return reply()
  }))
  return calls
}

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })

function renderIt(disabled = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><EmailBackfill c={conn} disabled={disabled} /></QueryClientProvider>)
}

afterEach(() => { vi.unstubAllGlobals() })

describe('从 Slack 补联系人邮箱', () => {
  it('补上的、和名册不一样的都列出来', async () => {
    const calls = backend(() => ok(result({
      checked: 3, filled: 1, skipped: 1,
      filled_contacts: [{ stakeholder_id: 'stk_lin', name: '林原', external_id: 'U04LIN', email: 'lin@acme.com' }],
      conflicts: [{ stakeholder_id: 'stk_chen', name: '陈晨', external_id: 'U05CHEN', current: 'chen@old.com', found: 'chen@acme.com' }],
    })))
    renderIt()
    await userEvent.click(screen.getByRole('button', { name: '从 Slack 补联系人邮箱' }))
    expect(await screen.findByText('查了 3 个 Slack 身份，补上 1 个邮箱，1 个和名册里不一样（没改）')).toBeTruthy()
    expect(screen.getByText('林原：lin@acme.com')).toBeTruthy()
    expect(screen.getByText(/陈晨：名册里是 chen@old.com，Slack 里是 chen@acme.com/)).toBeTruthy()
    expect(calls).toEqual(['POST /api/im/connectors/cn_sl/backfill-emails'])
  })

  it('缺 users:read.email 不算失败，给出去 Slack 后台加权限的提示', async () => {
    backend(() => ok(result({ checked: 2, skipped: 2, missing_scope: true, hint: 'Slack 应用要加 users:read.email 权限并重新安装：…' })))
    renderIt()
    await userEvent.click(screen.getByRole('button', { name: '从 Slack 补联系人邮箱' }))
    expect((await screen.findByRole('note')).textContent).toContain('Slack 应用要加 users:read.email 权限并重新安装')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('渠道出错写出原因', async () => {
    backend(() => new Response(JSON.stringify({ error: { code: 'backfill_failed', message: '补邮箱失败：Slack 拒绝了 Token（invalid_auth）' } }), { status: 502 }))
    renderIt()
    await userEvent.click(screen.getByRole('button', { name: '从 Slack 补联系人邮箱' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Slack 拒绝了 Token（invalid_auth）')
  })

  it('停用时按钮不能点', () => {
    backend(() => ok(result()))
    renderIt(true)
    expect((screen.getByRole('button', { name: '从 Slack 补联系人邮箱' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('结果说明：没有关联身份、没查完', () => {
    expect(emailBackfillText(result())).toContain('先在联系人里加 Slack 身份')
    expect(emailBackfillText(result({ checked: 200, pending: 5 }))).toBe('查了 200 个 Slack 身份，没有要补的，还有 5 个没查完，稍后再点一次')
  })
})
