// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImMaterialSource, ProjectMaterial } from '../../core/data'
import { MaterialsTab } from './MaterialsTab'

let rows: ProjectMaterial[] = []
let calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
let seq = 0
/** IM 插件记的出处（0009）；imOn 为 false 时插件列表里 im 没在跑 */
let sources: ImMaterialSource[] = []
let imOn = true

function fakeBackend() {
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data, meta: { total: 0 } } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/plugins') return json([{ id: 'im', running: imOn }, { id: 'projects', running: true }])
    if (u.pathname === '/api/im/materials' && method === 'GET') return json(sources.filter((s) => s.project_id === u.searchParams.get('project_id')))
    if (u.pathname.startsWith('/api/im/materials/') && method === 'DELETE') {
      const id = decodeURIComponent(u.pathname.split('/').pop()!)
      if (!sources.some((s) => s.material_id === id)) return json({ error: { code: 'not_found', message: 'nope' } }, 404)
      sources = sources.filter((s) => s.material_id !== id)
      return json(null)
    }
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
    if (method === 'PATCH') {
      const i = rows.findIndex((r) => r.id === decodeURIComponent(m[1]))
      if (String(body?.value ?? '').includes('bad')) return json({ error: { code: 'validation', message: 'value 不合法' } }, 400)
      rows[i] = { ...rows[i], ...(body as Partial<ProjectMaterial>), updated_at: new Date().toISOString() }
      return json(rows[i])
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

function renderTab(root?: string, at = '/projects/obj_p/materials') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([
    { path: '/projects/obj_p/materials', element: <Harness root={root} /> },
    { path: '/messages', element: <div>消息页</div> },
  ], { initialEntries: [at] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

const src = (p: Partial<ImMaterialSource>): ImMaterialSource => ({
  material_id: 'mt_x', project_id: 'obj_p', kind: 'messages', attachment_id: '', title: '', channel: 'slack', conversation_id: 'cv_1',
  conversation: '#product', senders: ['林原', 'Kevin'], message_ids: ['msg_1', 'msg_2'], first_at: '2026-10-30T06:00:00Z', last_at: '2026-10-30T06:05:00Z',
  created_at: '2026-10-30T07:00:00Z', ...p,
})

const mat = (p: Partial<ProjectMaterial>): ProjectMaterial => ({
  id: 'mt_x', project_id: 'obj_p', kind: 'note', name: '笔记', value: '一行\n两行', category: '', status: '', tags: [], source: 'manual',
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...p,
})

beforeEach(() => { rows = []; calls = []; seq = 0; sources = []; imOn = true; fakeBackend() })
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

  it('来自 IM 消息的资料（0009）：卡片标出处，点了打开最新那条消息；附件写发信人和群；长笔记先露 8 行', async () => {
    const long = Array.from({ length: 12 }, (_, i) => `[10-30 14:0${i % 10}] 林原：第 ${i + 1} 句`).join('\n')
    rows = [
      mat({ id: 'mt_n', name: '#product 10月30日 的消息', value: long, tags: ['IM 消息'] }),
      mat({ id: 'mt_f', kind: 'link', name: 'Figma', value: 'https://figma.com/x', tags: ['消息附件'] }),
      mat({ id: 'mt_m', name: '手写的' }),
    ]
    sources = [src({ material_id: 'mt_n' }), src({ material_id: 'mt_f', kind: 'attachment', attachment_id: 'f1', senders: ['Kevin'], message_ids: ['msg_2'], conversation: '' })]
    const user = userEvent.setup()
    const router = renderTab()
    const list = await screen.findByRole('list', { name: '支持材料' })
    const card = (name: string) => within(list).getByText(name, { selector: 'b' }).closest('li') as HTMLElement
    expect(await within(card('Figma')).findByRole('button', { name: '来自 Kevin（私聊）的消息' })).toBeInTheDocument()
    expect(within(card('手写的')).queryByRole('button', { name: /来自/ })).not.toBeInTheDocument()
    const note = card('#product 10月30日 的消息')
    expect(note.querySelector('.pj-mat-note')?.textContent).not.toContain('第 12 句')
    await user.click(within(note).getByRole('button', { name: '展开全部（还有 4 行）' }))
    expect(note.querySelector('.pj-mat-note')?.textContent).toContain('第 12 句')
    await user.click(within(note).getByRole('button', { name: '来自 IM 消息：群「#product」 · 2 条' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/messages'))
    expect(router.state.location.search).toBe('?m=msg_2')
  })

  it('移除来自消息的资料时一并清掉出处；地址带 ?mt= 的那条高亮', async () => {
    rows = [mat({ id: 'mt_n', name: '消息记录' }), mat({ id: 'mt_m', name: '手写的' })]
    sources = [src({ material_id: 'mt_n' })]
    const user = userEvent.setup()
    renderTab(undefined, '/projects/obj_p/materials?mt=mt_n')
    const list = await screen.findByRole('list', { name: '支持材料' })
    const card = (name: string) => within(list).getByText(name, { selector: 'b' }).closest('li') as HTMLElement
    expect(card('消息记录')).toHaveClass('pj-mat-hit')
    expect(card('手写的')).not.toHaveClass('pj-mat-hit')
    await within(card('消息记录')).findByRole('button', { name: /来自 IM 消息/ })
    await user.click(within(card('手写的')).getByRole('button', { name: '移除' }))
    await waitFor(() => expect(within(list).queryByText('手写的')).not.toBeInTheDocument())
    expect(calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/api/im/materials/'))).toBe(false)
    await user.click(within(card('消息记录')).getByRole('button', { name: '移除' }))
    await waitFor(() => expect(sources).toHaveLength(0))
  })

  it('IM 插件没在跑时不取出处', async () => {
    imOn = false
    rows = [mat({ id: 'mt_n', name: '消息记录' })]
    sources = [src({ material_id: 'mt_n' })]
    renderTab()
    await screen.findByRole('list', { name: '支持材料' })
    await waitFor(() => expect(calls.some((c) => c.path === '/api/plugins')).toBe(true))
    expect(calls.some((c) => c.path === '/api/im/materials')).toBe(false)
    expect(screen.queryByRole('button', { name: /来自 IM 消息/ })).not.toBeInTheDocument()
  })

  it('编辑笔记：标题、正文、标签都能改，只发改了的；来自 IM 消息的出处还在', async () => {
    rows = [mat({ id: 'mt_n', name: '消息记录', value: '旧正文', tags: ['IM 消息'] })]
    sources = [src({ material_id: 'mt_n' })]
    const user = userEvent.setup()
    renderTab()
    const list = await screen.findByRole('list', { name: '支持材料' })
    await user.click(within(list).getByRole('button', { name: '编辑 消息记录' }))
    const form = within(list).getByRole('group', { name: '编辑 消息记录' })
    // 笔记能换成链接
    expect(within(form).getByRole('group', { name: '种类' })).toHaveTextContent('链接')
    await user.clear(within(form).getByRole('textbox', { name: '名称' }))
    await user.type(within(form).getByRole('textbox', { name: '名称' }), '评审结论')
    await user.clear(within(form).getByRole('textbox', { name: '内容' }))
    await user.type(within(form).getByRole('textbox', { name: '内容' }), '新正文')
    await user.clear(within(form).getByRole('textbox', { name: '标签' }))
    await user.type(within(form).getByRole('textbox', { name: '标签' }), 'IM 消息，评审')
    await user.click(within(form).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(within(list).queryByRole('group', { name: /^编辑/ })).not.toBeInTheDocument())
    expect(calls.find((c) => c.method === 'PATCH')).toEqual({ method: 'PATCH', path: '/api/projects/obj_p/materials/mt_n', body: { name: '评审结论', value: '新正文', tags: ['IM 消息', '评审'] } })
    const card = within(list).getByText('评审结论', { selector: 'b' }).closest('li') as HTMLElement
    expect(within(card).getByText('新正文')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: /来自 IM 消息/ })).toBeInTheDocument()
  })

  it('笔记超过 5000 字不能保存；换成链接要合法的地址，带上 kind 和 value', async () => {
    rows = [mat({ id: 'mt_n', name: '想法', value: 'figma 稿' })]
    const user = userEvent.setup()
    renderTab()
    const list = await screen.findByRole('list', { name: '支持材料' })
    await user.click(within(list).getByRole('button', { name: '编辑 想法' }))
    const form = within(list).getByRole('group', { name: '编辑 想法' })
    const body = within(form).getByRole('textbox', { name: '内容' })
    await user.clear(body)
    await user.click(body)
    await user.paste('字'.repeat(5001))
    expect(within(form).getByText('超过 5000 字（现在 5001 字），删掉一些')).toBeInTheDocument()
    await user.click(within(form).getByRole('button', { name: '保存' }))
    expect(within(form).getByRole('alert')).toHaveTextContent('超过 5000 字')
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)

    await user.click(within(within(form).getByRole('group', { name: '种类' })).getByRole('button', { name: '链接' }))
    const link = within(form).getByRole('textbox', { name: '链接' })
    await user.clear(link)
    await user.type(link, 'figma.com/x')
    await user.click(within(form).getByRole('button', { name: '保存' }))
    expect(within(form).getByRole('alert')).toHaveTextContent('链接要以 http:// 或 https:// 开头')
    await user.clear(link)
    await user.type(link, 'https://figma.com/x')
    await user.click(within(form).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ kind: 'link', value: 'https://figma.com/x' }))
    expect(await within(list).findByRole('link', { name: 'https://figma.com/x' })).toBeInTheDocument()
  })

  it('文件能改成文件夹，相对路径按项目目录补全；来自消息附件的种类和路径不能改；Esc 收起', async () => {
    rows = [
      mat({ id: 'mt_f', kind: 'file', name: 'shots', value: '/root/pj/shots' }),
      mat({ id: 'mt_a', kind: 'file', name: '清单.xlsx', value: '/d/attachments/slack/清单.xlsx', tags: ['消息附件'] }),
    ]
    sources = [src({ material_id: 'mt_a', kind: 'attachment', attachment_id: 'a1', message_ids: ['msg_1'] })]
    const user = userEvent.setup()
    renderTab()
    const list = await screen.findByRole('list', { name: '支持材料' })
    await within(list).findByRole('button', { name: /来自 林原/ })
    await user.click(within(list).getByRole('button', { name: '编辑 清单.xlsx' }))
    let form = within(list).getByRole('group', { name: '编辑 清单.xlsx' })
    expect(within(form).queryByRole('group', { name: '种类' })).not.toBeInTheDocument()
    expect(within(form).getByText('来自消息附件，种类和路径不能改')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(within(list).queryByRole('group', { name: /^编辑/ })).not.toBeInTheDocument()

    await user.click(within(list).getByRole('button', { name: '编辑 shots' }))
    form = within(list).getByRole('group', { name: '编辑 shots' })
    await user.click(within(within(form).getByRole('group', { name: '种类' })).getByRole('button', { name: '文件夹' }))
    const path = within(form).getByRole('textbox', { name: '文件夹路径' })
    await user.clear(path)
    await user.type(path, 'docs/shots')
    await user.click(within(form).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ kind: 'folder', value: '/root/pj/docs/shots' }))
  })

  it('保存失败留着表单，红字写原因', async () => {
    rows = [mat({ id: 'mt_l', kind: 'link', name: '链接', value: 'https://a.com' })]
    const user = userEvent.setup()
    renderTab()
    const list = await screen.findByRole('list', { name: '支持材料' })
    await user.click(within(list).getByRole('button', { name: '编辑 链接' }))
    const form = within(list).getByRole('group', { name: '编辑 链接' })
    const link = within(form).getByRole('textbox', { name: '链接' })
    await user.clear(link)
    await user.type(link, 'https://bad.com')
    await user.click(within(form).getByRole('button', { name: '保存' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent('没保存：value 不合法')
  })
})
