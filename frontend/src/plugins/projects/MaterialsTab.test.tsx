import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectMaterial } from '../../core/data'
import { MaterialsTab } from './MaterialsTab'

let rows: ProjectMaterial[] = []
let calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
let seq = 0

function fakeBackend() {
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data, meta: { total: 0 } } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/agent/workdir/check') {
      const p = String(body?.path)
      return json({ path: p, exists: !p.includes('gone'), is_dir: false, writable: true, message: '' })
    }
    const m = u.pathname.match(/^\/api\/projects\/obj_p\/materials(?:\/([^/]+))?$/)
    if (!m) return json({ error: { code: 'not_found', message: 'nope' } }, 404)
    if (method === 'GET') return json(rows)
    if (method === 'POST') {
      if (String(body?.value).includes('bad')) return json({ error: { code: 'validation', message: 'value 不合法' } }, 400)
      seq += 1
      const row: ProjectMaterial = {
        id: `mt_${seq}`, project_id: 'obj_p', kind: body?.kind as ProjectMaterial['kind'], name: String(body?.name), value: String(body?.value),
        category: '', status: '', tags: (body?.tags as string[]) ?? [], source: 'manual',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }
      rows.push(row)
      return json(row, 201)
    }
    if (method === 'DELETE') {
      rows = rows.filter((r) => r.id !== decodeURIComponent(m[1]))
      return json(null)
    }
    return json({ error: { code: 'internal', message: 'x' } }, 500)
  }))
}

function Harness({ root = '/root/pj' }: { root?: string }) {
  const [adding, setAdding] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setAdding(true)}>打开表单</button>
      <MaterialsTab projectId="obj_p" root={root} adding={adding} onAdding={setAdding} />
    </>
  )
}

function renderTab(root?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><Harness root={root} /></QueryClientProvider>)
}

const mat = (p: Partial<ProjectMaterial>): ProjectMaterial => ({
  id: 'mt_x', project_id: 'obj_p', kind: 'note', name: '笔记', value: '一行\n两行', category: '', status: '', tags: [], source: 'manual',
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...p,
})

beforeEach(() => { rows = []; calls = []; seq = 0; fakeBackend() })
afterEach(() => { vi.unstubAllGlobals() })

describe('支持材料标签', () => {
  it('没有材料时是空状态，没有工具条', async () => {
    renderTab()
    expect(await screen.findByText('还没有支持材料')).toBeInTheDocument()
    expect(screen.queryByLabelText('搜索材料')).not.toBeInTheDocument()
  })

  it('加一个文件：相对路径拼上项目目录，标签按逗号拆开', async () => {
    const user = userEvent.setup()
    renderTab()
    await screen.findByText('还没有支持材料')
    await user.click(screen.getByRole('button', { name: '打开表单' }))
    const form = screen.getByRole('group', { name: '加材料' })
    const ok = within(form).getByRole('button', { name: '加上' })
    expect(ok).toBeDisabled()
    await user.type(within(form).getByLabelText('名称'), '访谈纪要')
    await user.type(within(form).getByLabelText('文件路径'), 'materials/a.md')
    await user.type(within(form).getByLabelText('标签'), '访谈，客户')
    await user.click(ok)
    await waitFor(() => expect(screen.queryByRole('group', { name: '加材料' })).not.toBeInTheDocument())
    expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/materials'))?.body).toEqual({ kind: 'file', name: '访谈纪要', value: '/root/pj/materials/a.md', tags: ['访谈', '客户'] })
    expect(await screen.findByText('/root/pj/materials/a.md')).toBeInTheDocument()
    expect(screen.getByText('#访谈 #客户')).toBeInTheDocument()
  })

  it('没设项目目录时相对路径不发请求，提示填绝对路径', async () => {
    const user = userEvent.setup()
    renderTab('')
    await screen.findByText('还没有支持材料')
    await user.click(screen.getByRole('button', { name: '打开表单' }))
    const form = screen.getByRole('group', { name: '加材料' })
    await user.click(within(form).getByRole('button', { name: '文件夹' }))
    await user.type(within(form).getByLabelText('名称'), '截图')
    await user.type(within(form).getByLabelText('文件夹路径'), 'shots')
    await user.click(within(form).getByRole('button', { name: '加上' }))
    expect(within(form).getByRole('alert')).toHaveTextContent('要填绝对路径')
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/materials'))).toBe(false)
  })

  it('保存失败保留表单，底部红字', async () => {
    const user = userEvent.setup()
    renderTab()
    await screen.findByText('还没有支持材料')
    await user.click(screen.getByRole('button', { name: '打开表单' }))
    const form = screen.getByRole('group', { name: '加材料' })
    await user.click(within(form).getByRole('button', { name: '链接' }))
    await user.type(within(form).getByLabelText('名称'), '坏链接')
    await user.type(within(form).getByLabelText('链接'), 'bad://x')
    await user.click(within(form).getByRole('button', { name: '加上' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent('没加上：value 不合法')
    expect(within(form).getByLabelText('名称')).toHaveValue('坏链接')
  })

  it('选多个文件各加一条，路径按输入框里的目录拼', async () => {
    const user = userEvent.setup()
    renderTab()
    await screen.findByText('还没有支持材料')
    await user.click(screen.getByRole('button', { name: '打开表单' }))
    const form = screen.getByRole('group', { name: '加材料' })
    await user.type(within(form).getByLabelText('文件路径'), '/data/in/')
    const input = form.querySelector('input[type=file]') as HTMLInputElement
    await user.upload(input, [new File(['a'], 'a.md'), new File(['b'], 'b.png')])
    await waitFor(() => expect(screen.queryByRole('group', { name: '加材料' })).not.toBeInTheDocument())
    expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/materials')).map((c) => c.body?.value)).toEqual(['/data/in/a.md', '/data/in/b.png'])
  })

  it('筛选、找不到文件的标记、移除', async () => {
    rows = [
      mat({ id: 'mt_a', kind: 'file', name: '需求原文', value: '/x/gone.md', tags: ['需求'] }),
      mat({ id: 'mt_b', kind: 'link', name: '竞品', value: 'https://example.com', tags: ['竞品'] }),
      mat({ id: 'mt_c', name: '想法' }),
    ]
    const user = userEvent.setup()
    renderTab()
    const list = await screen.findByRole('list', { name: '支持材料' })
    // 新加的在前
    expect(within(list).getAllByRole('listitem').map((li) => li.querySelector('b')?.textContent)).toEqual(['想法', '竞品', '需求原文'])
    expect(await screen.findByText('找不到文件')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'https://example.com' })).toHaveAttribute('target', '_blank')

    const kinds = screen.getByRole('group', { name: '种类筛选' })
    expect(within(kinds).getAllByRole('button').map((b) => b.textContent)).toEqual(['全部3', '文件1', '链接1', '笔记1'])
    await user.click(within(kinds).getByRole('button', { name: '链接1' }))
    expect(within(screen.getByRole('list', { name: '支持材料' })).getAllByRole('listitem')).toHaveLength(1)
    await user.click(within(kinds).getByRole('button', { name: '全部3' }))

    await user.click(within(screen.getByRole('group', { name: '标签筛选' })).getByRole('button', { name: '需求' }))
    expect(screen.getByText('需求原文')).toBeInTheDocument()
    expect(screen.queryByText('竞品', { selector: 'b' })).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('搜索材料'), '没有这个')
    expect(screen.getByText('没有匹配的材料')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '清空' }))
    await user.click(within(screen.getByRole('group', { name: '标签筛选' })).getByRole('button', { name: '需求' }))

    const card = screen.getByText('想法').closest('li')!
    await user.click(within(card).getByRole('button', { name: '移除' }))
    await waitFor(() => expect(screen.queryByText('想法')).not.toBeInTheDocument())
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/mt_c'))).toBe(true)
  })
})
