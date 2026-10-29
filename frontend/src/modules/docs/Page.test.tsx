import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Category, WorkObject } from '../../core/data'
import Page from './Page'

let seq = 0
function obj(p: Partial<WorkObject>): WorkObject {
  seq += 1
  return {
    id: `obj_${seq}`, ref: `DOC-${seq}`, type_id: 'doc', title: `文档${seq}`, body: '', status: 'draft', priority: '',
    owner: '', owner_id: null, category_id: null, project_id: null, source: 'manual', props: null, workdir: '',
    due_at: null, started_at: null, completed_at: null, archived_at: null, deleted_at: null,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', tags: [], link_count: 0, participants: [], ...p,
  } as WorkObject
}

const cat = (id: string, name: string, sort: number): Category => ({
  id, type_id: 'doc', parent_id: null, name, slug: id, path: `/${id}/`, depth: 0, color: '', description: '', sort_order: sort,
  created_at: '', updated_at: '', count: 0, total_count: 0,
})
const cats = [cat('cat_prd', '需求文档', 10), cat('cat_meet', '会议纪要', 30)]
const types = [{ id: 'doc', name: '文档', statuses: [{ key: 'draft', label: '草稿', color: '', terminal: false }] }]
const dir = { id: 'ld_1', path: '/tmp/notes', name: 'notes', position: 0, created_at: '', updated_at: '' }

type Rev = { id: string; object_id: string; field: string; old_value: string; new_value: string; actor: string; actor_name: string; session_id: string; source: string; created_at: string }

/** 内存里的后端：文档对象、分类、挂载目录；新建、编辑按字段记修订 */
function fakeBackend(rows: WorkObject[]) {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
  const revs: Rev[] = []
  const rev = (object_id: string, field: string, old_value: string, new_value: string) =>
    revs.unshift({ id: `rev_${revs.length}`, object_id, field, old_value, new_value, actor: 'me', actor_name: 'me', session_id: '', source: 'ui', created_at: '2026-10-29T10:00:00Z' })
  const json = (data: unknown, status = 200, meta?: unknown) =>
    new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/objects' && method === 'GET') {
      const want = (u.searchParams.get('type') ?? 'doc').split(',')
      const xs = rows.filter((o) => want.includes(o.type_id))
      const off = Number(u.searchParams.get('offset') ?? 0)
      return json(xs.slice(off), 200, { total: xs.length })
    }
    if (u.pathname === '/api/objects' && method === 'POST') {
      const o = obj({ ...body, title: body.title, body: body.body ?? '' })
      rows.unshift(o)
      rev(o.id, 'created', '', o.title)
      return json(o, 201)
    }
    const rm = u.pathname.match(/^\/api\/objects\/([^/]+)\/revisions$/)
    if (rm) return json(revs.filter((r) => r.object_id === rm[1]))
    const m = u.pathname.match(/^\/api\/objects\/([^/]+)$/)
    if (m) {
      const o = rows.find((r) => r.id === decodeURIComponent(m[1]))
      if (!o) return json({ error: { code: 'not_found', message: 'object not found' } }, 404)
      if (method === 'PATCH') {
        for (const [k, v] of Object.entries(body)) rev(o.id, k, String((o as Record<string, unknown>)[k] ?? ''), String(v ?? ''))
        Object.assign(o, body)
      }
      return json(o)
    }
    if (u.pathname === '/api/categories') return json(cats)
    if (u.pathname === '/api/tags') return json([])
    if (u.pathname === '/api/local-dirs') return json([dir])
    if (u.pathname === '/api/local-dirs/ld_1/files') {
      return json({ path: dir.path, skipped: 0, truncated: false, files: [{ rel: 'a.md', path: '/tmp/notes/a.md', name: 'a.md', ext: 'md', size: 3, modified: '2026-10-01T00:00:00Z' }] })
    }
    if (u.pathname === '/api/fs/read') {
      return json({ path: '/tmp/notes/a.md', name: 'a.md', ext: 'md', size: 3, modified: '2026-10-01T00:00:00Z', binary: false, truncated: false, limit: 1048576, content: '# 本地' })
    }
    if (u.pathname === '/api/object-types') return json(types)
    return json({ error: { code: 'not_found', message: u.pathname } }, 404)
  }))
  return { calls, revs }
}

function mount(initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/docs', element: <Page /> }, { path: '*', element: <div>别的页</div> }], { initialEntries: [initial] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

afterEach(() => vi.unstubAllGlobals())

describe('文档的新建和编辑', () => {
  it('新建：标题必填，保存后打开这篇的阅读，来源是手动', async () => {
    const rows = [obj({ title: '旧文档', category_id: 'cat_prd', body: '旧正文' })]
    const { calls } = fakeBackend(rows)
    const oldId = rows[0].id
    const router = mount(`/docs?doc=${oldId}`)
    await screen.findByRole('heading', { name: '旧文档' })
    await userEvent.click(screen.getByRole('button', { name: '新建文档' }))
    const form = await screen.findByRole('form', { name: '新建文档' })
    expect(within(form).getByRole('combobox', { name: '分类' })).toHaveValue('cat_prd')

    await userEvent.click(within(form).getByRole('button', { name: '保存' }))
    expect(within(form).getByText('标题不能空')).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'POST')).toBe(false)

    await userEvent.type(within(form).getByRole('textbox', { name: '标题' }), '权限 PRD')
    await userEvent.type(within(form).getByRole('textbox', { name: '正文' }), '## 背景')
    await userEvent.click(within(form).getByRole('button', { name: '预览' }))
    expect(within(form).getByRole('heading', { name: '背景' })).toBeInTheDocument()
    await userEvent.click(within(form).getByRole('button', { name: '保存' }))

    expect(await screen.findByRole('heading', { name: '权限 PRD', level: 1 })).toBeInTheDocument()
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.body).toMatchObject({ type_id: 'doc', title: '权限 PRD', body: '## 背景', category_id: 'cat_prd', source: 'manual' })
    expect(router.state.location.search).not.toContain('edit')
    expect(router.state.location.search).toBe(`?doc=${rows[0].id}`)
    expect(rows[0].id).not.toBe(oldId)
    expect(screen.queryByRole('form')).toBeNull()
  })

  it('编辑只提交改过的字段，修订里能看到', async () => {
    const d = obj({ title: '会议', category_id: 'cat_meet', body: '第一版' })
    const { calls } = fakeBackend([d])
    mount(`/docs?doc=${d.id}`)
    await screen.findByRole('heading', { name: '会议' })
    await userEvent.click(screen.getByRole('button', { name: '编辑' }))
    const form = await screen.findByRole('form', { name: '编辑「会议」' })
    const text = within(form).getByRole('textbox', { name: '正文' })
    expect(text).toHaveValue('第一版')
    await userEvent.clear(text)
    await userEvent.type(text, '第二版多几个字')
    await userEvent.click(within(form).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(screen.queryByRole('form')).toBeNull())
    const patch = calls.find((c) => c.method === 'PATCH')
    expect(patch?.body).toEqual({ body: '第二版多几个字' })
    expect(await screen.findByText('第二版多几个字')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '修订' }))
    const revs = await screen.findByRole('region', { name: '修订记录' })
    expect(await within(revs).findByText('改了正文（多 4 字）')).toBeInTheDocument()
  })

  it('有没保存的改动时切别的文档先确认，「接着写」留在编辑区', async () => {
    const a = obj({ title: '甲', category_id: 'cat_prd' })
    const b = obj({ title: '乙', category_id: 'cat_prd' })
    fakeBackend([a, b])
    mount(`/docs?doc=${a.id}&edit=1`)
    const form = await screen.findByRole('form', { name: '编辑「甲」' })
    await userEvent.type(within(form).getByRole('textbox', { name: '正文' }), '写了一半')
    await userEvent.click(screen.getByRole('button', { name: /乙/ }))
    const dlg = await screen.findByRole('alertdialog', { name: '有没保存的改动' })
    await userEvent.click(within(dlg).getByRole('button', { name: '接着写' }))
    expect(screen.getByRole('form', { name: '编辑「甲」' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    await userEvent.click(within(await screen.findByRole('alertdialog', { name: '有没保存的改动' })).getByRole('button', { name: '丢掉改动' }))
    expect(await screen.findByRole('heading', { name: '甲', level: 1 })).toBeInTheDocument()
  })

  it('本地目录里的文件只读：没有新建、编辑、修订', async () => {
    fakeBackend([obj({ title: '甲' })])
    mount('/docs?dir=ld_1&doc=ld_1:a.md')
    await screen.findByRole('heading', { name: 'a.md', level: 1 })
    expect(screen.queryByRole('button', { name: '新建文档' })).toBeNull()
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    expect(screen.queryByRole('button', { name: '修订' })).toBeNull()
  })

  it('本地目录下地址带 edit 也不进编辑区', async () => {
    fakeBackend([obj({ title: '甲' })])
    mount('/docs?dir=ld_1&doc=ld_1:a.md&edit=1')
    await screen.findByRole('heading', { name: 'a.md', level: 1 })
    expect(screen.queryByRole('form')).toBeNull()
  })
})

describe('文档按项目（C-04）', () => {
  it('顶栏按项目筛，阅读区显示所属项目，点了去项目的文档标签', async () => {
    const p = obj({ id: 'obj_p1', type_id: 'project', title: '支付改版' })
    const gone = 'obj_p9'
    const a = obj({ title: '支付 PRD', category_id: 'cat_prd', project_id: p.id, project_title: '支付改版', updated_at: '2026-10-03T00:00:00Z' })
    const b = obj({ title: '散篇', category_id: 'cat_prd', updated_at: '2026-10-02T00:00:00Z' })
    const c = obj({ title: '老项目的纪要', category_id: 'cat_meet', project_id: gone, project_title: '老项目' })
    fakeBackend([p, a, b, c])
    const router = mount(`/docs?doc=${a.id}`)
    await screen.findByRole('heading', { name: '支付 PRD', level: 1 })
    // 项目对象不算文档
    expect(screen.getByRole('button', { name: '全部3' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '按项目筛选' }))
    const list = await screen.findByRole('listbox')
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual([
      '全部项目', '支付改版1 篇', '老项目1 篇', '不属于项目1 篇',
    ])
    await userEvent.click(within(list).getByRole('option', { name: /不属于项目/ }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /支付 PRD/ })).toBeNull())
    await userEvent.click(screen.getByRole('button', { name: /散篇/ }))
    expect(await screen.findByRole('heading', { name: '散篇', level: 1 })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '按项目筛选' }))
    await userEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /老项目/ }))
    await userEvent.click(await screen.findByRole('button', { name: '会议纪要1' }))
    await userEvent.click(await screen.findByRole('button', { name: /老项目的纪要/ }))
    expect(await screen.findByRole('heading', { name: '老项目的纪要', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('老项目（已删除）')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '按项目筛选' }))
    await userEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: /支付改版/ }))
    await userEvent.click(await screen.findByRole('button', { name: /支付 PRD/ }))
    await screen.findByRole('heading', { name: '支付 PRD', level: 1 })
    await userEvent.click(screen.getByRole('button', { name: '支付改版' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/obj_p1/docs'))
  })

  it('没有项目、文档也都不属于项目时不显示项目下拉', async () => {
    const a = obj({ title: '甲' })
    fakeBackend([a])
    mount(`/docs?doc=${a.id}`)
    await screen.findByRole('heading', { name: '甲', level: 1 })
    expect(screen.queryByRole('button', { name: '按项目筛选' })).toBeNull()
  })
})
