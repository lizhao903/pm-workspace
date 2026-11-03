import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
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

const task = {
  id: 'task', name: '任务', plural: '', ref_prefix: 'TSK', icon: '', color: '', builtin: true, sort_order: 0, created_at: '', updated_at: '',
  statuses: [
    { key: 'todo', label: '未开工', color: '#868e96', terminal: false },
    { key: 'done', label: '已完成', color: '#2b8a3e', terminal: true, description: '算作完成' },
  ],
}
const cat = (id: string, name: string, p: Record<string, unknown> = {}) => ({
  id, type_id: 'doc', parent_id: null, name, slug: id, path: `/${id}/`, depth: 0, color: '#3d4fd6', description: '', sort_order: 0,
  created_at: '', updated_at: '', count: 0, total_count: 0, ...p,
})
const cats = [cat('prd', '需求文档', { sort_order: 10, total_count: 2 }), cat('meeting', '会议纪要', { sort_order: 20, children: [cat('weekly', '周会', { parent_id: 'meeting' })] }), cat('misc', '杂项', { sort_order: 30 })]

type Call = { method: string; url: string; body: unknown }
let calls: Call[]
let workspaces: unknown[]

beforeEach(() => {
  calls = []
  workspaces = []
  vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url: u, body })
    const ok = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 }))
    if (method === 'GET' && u.includes('/api/dictionaries/')) return ok(items[u.split('/api/dictionaries/')[1].split('/')[0]] ?? [])
    if (method === 'GET' && u.includes('/api/dictionaries')) return ok([dict('priority', '优先级'), dict('link_relation', '关联关系'), dict('artifact_kind', '产物种类')])
    if (method === 'GET' && u.includes('/api/object-types')) return ok([task, { ...task, id: 'doc', statuses: [] }])
    if (method === 'GET' && u.includes('/api/counts')) return ok({ by_type: {}, by_status: { 'task:todo': 4, 'task:done': 7 }, uncategorized_by_type: {} })
    if (method === 'GET' && u.includes('/api/categories')) return ok(cats)
    if (method === 'GET' && u.includes('/api/workspaces')) return ok(workspaces)
    if (method === 'PATCH' && u.includes('/api/object-types/')) return ok({ ...task, ...body })
    if (method === 'PATCH' && u.includes('/api/categories/')) return ok(cat('x', 'x'))
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
/** 默认选中的是排第一的任务状态；多数用例在优先级上做 */
async function openPrio() {
  await userEvent.click(await screen.findByRole('button', { name: /优先级/ }))
  await screen.findByRole('heading', { name: /优先级/ })
}

describe('设置 / 枚举值', () => {
  it('按模块分组列出字典，默认选第一个；新建枚举置灰', async () => {
    renderSection()
    const tasks = await screen.findByRole('group', { name: '任务' })
    expect(within(tasks).getByRole('button', { name: /任务状态/ })).toHaveAttribute('aria-current', 'true')
    expect(within(tasks).getByRole('button', { name: /关联关系/ })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '文档' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '产出物' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建枚举' })).toBeDisabled()
    await openPrio()
    // 优先级没标默认时兜底 P2；使用数显示在「使用中」列
    expect(within(row('中')).getByRole('radio', { name: '默认' })).toBeChecked()
    expect(within(row('最高')).getByText('2 条')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '没有修改' })).toBeDisabled()
  })

  it('改显示名后保存，只发改了的字段；保存前空显示名不让存', async () => {
    renderSection()
    await openPrio()
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
    await openPrio()
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
    await openPrio()
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
    await openPrio()
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

  it('任务状态：使用数来自计数，全是系统值，改说明后整组写回状态集', async () => {
    renderSection()
    expect(await screen.findByRole('heading', { name: /任务状态/ })).toBeInTheDocument()
    expect(within(row('未开工')).getByText('4 条')).toBeInTheDocument()
    expect(within(row('已完成')).getByRole('textbox', { name: '说明' })).toHaveValue('算作完成')
    expect(within(row('未开工')).getByText('系统值')).toBeInTheDocument()
    expect(within(row('未开工')).getByRole('radio', { name: '默认' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '加一个值' })).toBeDisabled()
    await userEvent.type(within(row('未开工')).getByRole('textbox', { name: '说明' }), '还没动手')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByRole('button', { name: '已保存' })
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([{
      method: 'PATCH', url: expect.stringContaining('/api/object-types/task'),
      body: { statuses: [
        { key: 'todo', label: '未开工', color: '#868e96', terminal: false, description: '还没动手' },
        { key: 'done', label: '已完成', color: '#2b8a3e', terminal: true, description: '算作完成' },
      ] },
    }])
  })

  it('文档分类：只列一级，不能停用；在用或有子分类的不能删，空的删掉后保存', async () => {
    renderSection()
    await userEvent.click(await screen.findByRole('button', { name: /文档分类/ }))
    expect(screen.queryByRole('row', { name: '周会' })).not.toBeInTheDocument()
    expect(within(row('需求文档')).getByText('2 条')).toBeInTheDocument()
    expect(within(row('需求文档')).getByRole('switch', { name: '启用' })).toBeDisabled()
    await userEvent.click(within(row('需求文档')).getByRole('button', { name: '删除' }))
    expect(screen.getByRole('status')).toHaveTextContent('「需求文档」有 2 条数据在用，不能删除')
    expect(within(screen.getByRole('status')).queryByRole('button', { name: '停用' })).not.toBeInTheDocument()
    await userEvent.click(within(row('会议纪要')).getByRole('button', { name: '删除' }))
    expect(screen.getByRole('status')).toHaveTextContent('下面还有 1 个子分类')
    await userEvent.click(within(screen.getByRole('status')).getByRole('button', { name: '知道了' }))
    await userEvent.click(within(row('杂项')).getByRole('button', { name: '删除' }))
    const name = within(row('需求文档')).getByRole('textbox', { name: '显示名' })
    await userEvent.clear(name)
    await userEvent.type(name, 'PRD')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByRole('button', { name: '已保存' })
    expect(calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.url.replace(/^.*\/api/, ''), c.body])).toEqual([
      ['DELETE', '/categories/misc', undefined], ['PATCH', '/categories/prd', { name: 'PRD' }],
    ])
  })

  it('当前工作台没开视频模块时不显示产出物这一组', async () => {
    workspaces = [{ id: 'ws_pm', name: '产品', role: '', description: '', groups: [], modules: ['tasks', 'library'], home: 'tasks', mark: null, plugins: [], template: '', position: 0, created_at: '', updated_at: '' }]
    renderSection()
    await screen.findByRole('group', { name: '任务' })
    await waitFor(() => expect(screen.queryByRole('group', { name: '产出物' })).not.toBeInTheDocument())
    expect(screen.getByRole('group', { name: '文档' })).toBeInTheDocument()
  })
})
