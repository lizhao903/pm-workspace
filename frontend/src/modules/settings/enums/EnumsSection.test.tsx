import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EnumsSection } from './EnumsSection'

const dict = (id: string, name: string) => ({ id, name, description: name + '的说明', scope: 'global', builtin: true, sort_order: 0, created_at: '', updated_at: '' })
const item = (dict_id: string, key: string, label: string, p: Record<string, unknown> = {}) => ({
  id: 'dit_' + key, dict_id, type_id: null, key, label, color: '#3d4fd6', description: '', sort_order: 0, meta: {}, archived_at: null,
  created_at: '', updated_at: '', usage: 0, ...p,
})
const items: Record<string, unknown[]> = {
  priority: [item('priority', 'P0', '最高', { sort_order: 10, usage: 2 }), item('priority', 'P1', '高', { sort_order: 20 }), item('priority', 'P2', '中', { sort_order: 30 })],
  link_relation: [item('link_relation', 'blocks', '阻塞'), item('link_relation', 'relates', '相关')],
}

type Call = { method: string; url: string; body: unknown }
let calls: Call[]

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url: u, body })
    const ok = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 }))
    if (method === 'GET' && u.includes('/api/dictionaries/')) return ok(items[u.split('/api/dictionaries/')[1].split('/')[0]] ?? [])
    if (method === 'GET' && u.includes('/api/dictionaries')) return ok([dict('priority', '优先级'), dict('link_relation', '关联关系')])
    if (method === 'PATCH') return ok({ ...item('priority', 'P1', body.label ?? '高'), ...body })
    if (method === 'POST' && u.endsWith('/items')) return ok(item('priority', body.key, body.label, { id: 'dit_new' }))
    return ok(null)
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><EnumsSection /></QueryClientProvider>)
}

const row = (name: string) => screen.getByRole('row', { name })

describe('设置 / 枚举值', () => {
  it('按模块分组列出字典，默认选第一个；新建枚举置灰', async () => {
    renderSection()
    const task = await screen.findByRole('group', { name: '任务' })
    expect(within(task).getByRole('button', { name: /优先级/ })).toHaveAttribute('aria-current', 'true')
    expect(within(task).getByRole('button', { name: /关联关系/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建枚举' })).toBeDisabled()
    expect(screen.getByRole('heading', { name: /优先级/ })).toBeInTheDocument()
    // 优先级没标默认时兜底 P2；使用数显示在「使用中」列
    expect(within(row('中')).getByRole('radio', { name: '默认' })).toBeChecked()
    expect(within(row('最高')).getByText('2 条')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '没有修改' })).toBeDisabled()
  })

  it('改显示名后保存，只发改了的字段；保存前空显示名不让存', async () => {
    renderSection()
    await screen.findByRole('heading', { name: /优先级/ })
    const input = within(row('高')).getByRole('textbox', { name: '显示名' })
    await userEvent.clear(input)
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(screen.getByRole('alert')).toHaveTextContent('第 2 个值没有显示名')
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
    await userEvent.type(input, '重要')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByRole('button', { name: '已保存' })).toBeInTheDocument()
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([{ method: 'PATCH', url: expect.stringContaining('/api/dict-items/dit_P1'), body: { label: '重要' } }])
  })

  it('被用过的值不能删，给出停用；没用过的直接从草稿里删', async () => {
    renderSection()
    await screen.findByRole('heading', { name: /优先级/ })
    await userEvent.click(within(row('最高')).getByRole('button', { name: '删除' }))
    expect(screen.getByRole('status')).toHaveTextContent('「最高」有 2 条数据在用，不能删除')
    await userEvent.click(within(screen.getByRole('status')).getByRole('button', { name: '停用' }))
    expect(within(row('最高')).getByRole('switch', { name: '启用' })).not.toBeChecked()
    await userEvent.click(within(row('高')).getByRole('button', { name: '删除' }))
    expect(screen.queryByRole('row', { name: '高' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByRole('button', { name: '已保存' })
    expect(calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.url.replace(/^.*\/api/, '')])).toEqual([
      ['DELETE', '/dict-items/dit_P1'], ['POST', '/dict-items/dit_P0/archive'],
    ])
  })

  it('加一个值、上移后保存：先建再整组重排', async () => {
    renderSection()
    await screen.findByRole('heading', { name: /优先级/ })
    await userEvent.click(screen.getByRole('button', { name: '加一个值' }))
    const fresh = screen.getAllByRole('row').at(-1)!
    expect(within(fresh).getByRole('textbox', { name: 'Key' })).toHaveValue('v4')
    await userEvent.type(within(fresh).getByRole('textbox', { name: '显示名' }), '低')
    await userEvent.click(within(row('中')).getByRole('button', { name: '上移' }))
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByRole('button', { name: '已保存' })
    const writes = calls.filter((c) => c.method !== 'GET')
    expect(writes[0]).toMatchObject({ method: 'POST', body: { key: 'v4', label: '低' } })
    expect(writes[1]).toMatchObject({ method: 'POST', url: expect.stringContaining('/items/reorder'), body: { ids: ['dit_P0', 'dit_P2', 'dit_P1', 'dit_new'] } })
  })

  it('关联关系全是系统值，不能停用、不能加值；有未保存的改动时切走先确认', async () => {
    renderSection()
    await screen.findByRole('heading', { name: /优先级/ })
    await userEvent.type(within(row('高')).getByRole('textbox', { name: '显示名' }), '一')
    await userEvent.click(screen.getByRole('button', { name: /关联关系/ }))
    expect(screen.getByText('有未保存的修改，切走后会丢掉')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    expect(screen.getByRole('heading', { name: /优先级/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /关联关系/ }))
    await userEvent.click(screen.getByRole('button', { name: '放弃修改' }))
    expect(screen.getByRole('heading', { name: /关联关系/ })).toBeInTheDocument()
    expect(within(row('阻塞')).getByRole('switch', { name: '启用' })).toBeDisabled()
    expect(within(row('阻塞')).getByText('系统值')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '加一个值' })).toBeDisabled()
  })
})
