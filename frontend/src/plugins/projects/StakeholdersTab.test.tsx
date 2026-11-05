import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StakeholdersTab } from './StakeholdersTab'

// 加干系人（B-05）：按分组、标签搜，多选一次加 N 人，候选按姓名拼音排
const contacts = [
  { id: 'sh_0', name: 'Zoe', company: 'Umbrella', title: '', group: '其他', tags: [] },
  { id: 'sh_1', name: '赵六', company: '', title: '', group: 'Acme', tags: [] },
  { id: 'sh_2', name: '王五', company: '', title: '', group: 'Acme、Globex', tags: [] },
  { id: 'sh_3', name: '孙七', company: '', title: '', group: '其他', tags: ['合规'] },
  { id: 'sh_4', name: '吴九', company: '', title: '', group: 'Globex', tags: [] },
].map((c) => ({ photo: '', ...c }))

function fakeBackend(stakes: { stakeholder_id: string; role: string }[], fail: string[] = []) {
  const posts: { stakeholder_id: string; role: string }[] = []
  const json = (data: unknown, status = 200, meta?: unknown) =>
    new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const sm = u.pathname.match(/^\/api\/projects\/([^/]+)\/stakeholders$/)
    if (sm) {
      const row = (x: { stakeholder_id: string; role: string }, i: number) =>
        ({ project_id: sm[1], focus: '', sort_order: i, created_at: '', updated_at: '', ...x })
      if (method === 'POST') {
        posts.push(body)
        if (fail.includes(body.stakeholder_id)) return json({ error: { code: 'conflict', message: '已经是干系人' } }, 409)
        stakes.push({ stakeholder_id: body.stakeholder_id, role: body.role })
        return json(row(stakes.at(-1)!, stakes.length - 1), 201)
      }
      return json(stakes.map(row), 200, { total: stakes.length })
    }
    if (u.pathname === '/api/stakeholders') return json(contacts)
    if (u.pathname === '/api/identities') return json([])
    if (u.pathname === '/api/plugins') return json([])
    if (u.pathname.match(/^\/api\/projects\/[^/]+\/conversations$/)) return json([])
    return json({ error: { code: 'not_found', message: u.pathname } }, 404)
  }))
  return posts
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '*', element: <StakeholdersTab projectId="obj_p" /> }])
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
}

const options = () => within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.querySelector('.ss-label')?.textContent)

afterEach(() => vi.unstubAllGlobals())

describe('加干系人', () => {
  it('候选按姓名拼音排，和联系人页一样；拉丁名不排在最前', async () => {
    fakeBackend([{ stakeholder_id: 'sh_3', role: 'member' }])
    mount()
    await screen.findByText('孙七')
    await userEvent.click(screen.getByRole('button', { name: '加干系人' }))
    expect(options()).toEqual(['王五', '吴九', '赵六', 'Zoe'])
    // 按索引字母分段
    expect(within(screen.getByRole('listbox')).getAllByRole('presentation').map((g) => g.textContent)).toEqual(['W', 'Z'])
  })

  it('能按分组、标签搜', async () => {
    fakeBackend([])
    mount()
    await screen.findByText('还没有干系人')
    await userEvent.click(screen.getByRole('button', { name: '加干系人' }))
    const q = screen.getByRole('combobox', { name: '搜姓名、公司、职位、分组、标签' })
    await userEvent.type(q, 'acme')
    expect(options()).toEqual(['王五', '赵六'])
    await userEvent.clear(q)
    await userEvent.type(q, '合规')
    expect(options()).toEqual(['孙七'])
  })

  it('多选后「加 N 人」一次加进来，按候选顺序加、角色是参与', async () => {
    const posts = fakeBackend([])
    mount()
    await screen.findByText('还没有干系人')
    await userEvent.click(screen.getByRole('button', { name: '加干系人' }))
    expect(screen.getByRole('button', { name: '先勾选要加的人' })).toBeDisabled()
    await userEvent.click(screen.getByRole('option', { name: /Zoe/ }))
    await userEvent.click(screen.getByRole('option', { name: /赵六/ }))
    await userEvent.click(screen.getByRole('option', { name: /吴九/ }))
    await userEvent.click(screen.getByRole('button', { name: '加 3 人' }))
    const table = await screen.findByRole('table', { name: '干系人' })
    expect(await within(table).findAllByRole('row')).toHaveLength(4)
    expect(posts).toEqual([
      { stakeholder_id: 'sh_4', role: 'member', focus: '' },
      { stakeholder_id: 'sh_1', role: 'member', focus: '' },
      { stakeholder_id: 'sh_0', role: 'member', focus: '' },
    ])
    // 加完下拉关掉、勾选清空
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '加干系人' }))
    expect(options()).toEqual(['孙七', '王五'])
  })

  it('有人没加上时其他人照常加，没加上的留在勾选里并说明原因', async () => {
    const posts = fakeBackend([], ['sh_1'])
    mount()
    await screen.findByText('还没有干系人')
    await userEvent.click(screen.getByRole('button', { name: '加干系人' }))
    await userEvent.click(screen.getByRole('option', { name: /赵六/ }))
    await userEvent.click(screen.getByRole('option', { name: /王五/ }))
    await userEvent.click(screen.getByRole('button', { name: '加 2 人' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('1 人没加上：赵六')
    expect(posts.map((p) => p.stakeholder_id)).toEqual(['sh_2', 'sh_1'])
    expect(await screen.findByRole('table', { name: '干系人' })).toHaveTextContent('王五')
    expect(screen.getByRole('button', { name: '加 1 人' })).toBeEnabled()
  })
})

describe('角色', () => {
  it('不认识的角色照原值显示、标红，排在最后（E-02）', async () => {
    fakeBackend([{ stakeholder_id: 'sh_3', role: 'boss' }, { stakeholder_id: 'sh_1', role: 'member' }])
    mount()
    const odd = await screen.findByRole('combobox', { name: '孙七 的角色' })
    expect(odd).toHaveValue('boss')
    expect(within(odd).getByRole('option', { selected: true })).toHaveTextContent('boss')
    expect(odd).toHaveAttribute('aria-invalid', 'true')
    expect(odd).toHaveAttribute('title', '不认识的角色「boss」，选一个改掉')
    expect(odd.className).toContain('pj-role-unknown')
    const ok = screen.getByRole('combobox', { name: '赵六 的角色' })
    expect(within(ok).getByRole('option', { selected: true })).toHaveTextContent('参与')
    expect(ok).not.toHaveAttribute('aria-invalid')
    const rows = screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].querySelector('b')?.textContent)
    expect(rows).toEqual(['赵六', '孙七'])
  })
})
