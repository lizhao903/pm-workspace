import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Contact } from '../../core/data'
import Page from './Page'

let seq = 0
function ct(p: Partial<Contact>): Contact {
  seq += 1
  return {
    id: `stk_${seq}`, name: `人${seq}`, role: '', email: '', note: '', color: '', sort_order: 0, archived_at: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', owned_count: 0, participating_count: 0,
    group: '', company: '', title: '', phone: '', tags: [], photo: '', starred: false, last_contact_at: null, ...p,
  }
}

// 内存里的名册：PATCH 改了再取就是新的
function fakeBackend(rows: Contact[], opts: { failPatch?: boolean } = {}) {
  const calls: string[] = []
  const patches: unknown[] = []
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status === 200 ? { data } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${u.pathname}`)
    if (u.pathname === '/api/stakeholders' && method === 'GET') return json(rows)
    const m = u.pathname.match(/^\/api\/stakeholders\/([^/]+)$/)
    if (m && method === 'PATCH') {
      patches.push(JSON.parse(String(init?.body)))
      if (opts.failPatch) return json({ error: { code: 'internal', message: '库锁住了' } }, 500)
      const c = rows.find((r) => r.id === decodeURIComponent(m[1]))!
      Object.assign(c, JSON.parse(String(init?.body)))
      return json(c)
    }
    if (u.pathname === '/api/dictionaries') return json([])
    return json({ error: { code: 'not_found', message: u.pathname } }, 404)
  }))
  return { calls, patches }
}

function mount(initial = '/contacts') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/contacts', element: <Page /> }], { initialEntries: [initial] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

const rowNames = () => screen.getAllByRole('row').filter((r) => r.hasAttribute('tabindex')).map((r) => r.getAttribute('aria-label'))
const sections = () => screen.getAllByRole('rowheader').map((h) => h.textContent)

afterEach(() => vi.unstubAllGlobals())

describe('联系人列表', () => {
  it('没联系过的人多于一半时默认按姓名排，选了「最近联系」就按选的', async () => {
    const today = new Date().toISOString()
    fakeBackend([ct({ name: '周岚' }), ct({ name: 'Bob' }), ct({ name: '许知行', last_contact_at: today })])
    mount()
    await screen.findByText('周岚')
    expect(screen.getByRole('combobox', { name: /排序/ })).toHaveValue('name')
    expect(screen.getByText('客户、合作伙伴、同事和供应商，按姓名排序')).toBeInTheDocument()
    expect(sections()).toEqual(['B', 'X', 'Z'])
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /排序/ }), 'recent')
    expect(sections()).toEqual(['今天', '未联系'])
    expect(rowNames()).toEqual(['许知行', '周岚', 'Bob'])
  })

  it('搜索覆盖备注和角色，多个词可以分别命中不同字段', async () => {
    fakeBackend([
      ct({ name: '周七', company: 'Northstar', tags: ['Acme'], note: 'Acme：fleetent 团队负责人\n别名：Randy、乐哥' }),
      ct({ name: 'Abby Chua', role: '产品 / 文案，Globex 信用卡运营执行' }),
      ct({ name: '周岚', company: 'Globex' }),
    ])
    mount()
    await screen.findByText('周七')
    const box = screen.getByRole('searchbox', { name: '搜索联系人' })
    for (const [q, want] of [['Randy', ['周七']], ['fleetent', ['周七']], ['Globex 信用卡', ['Abby Chua']], ['northstar 乐哥', ['周七']]] as const) {
      await userEvent.clear(box)
      await userEvent.type(box, q)
      expect(rowNames(), q).toEqual(want)
    }
  })

  it('按姓名排序时中文名按拼音首字母分段，和英文名混排，对不上的归到 #', async () => {
    fakeBackend(['张伟', 'Alice', '曾国强', '单雄', '李娜', '123'].map((name) => ct({ name })))
    mount()
    await screen.findByText('张伟')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /排序/ }), 'name')
    expect(sections()).toEqual(['A', 'L', 'S', 'Z', '#'])
    // 单作姓读 shan，归 S；曾读 zeng，归 Z
    expect(rowNames()).toEqual(['Alice', '李娜', '单雄', '曾国强', '张伟', '123'])
  })

  it('联系过的人不少于一半时默认按最近联系分段；搜索、分组、星标筛选，没结果时有提示', async () => {
    const today = new Date().toISOString()
    fakeBackend([
      ct({ name: '许知行', company: '远川科技', phone: '137 2233 4405', group: '客户', last_contact_at: today, starred: true }),
      ct({ name: '周岚', group: '同事' }),
      ct({ name: 'Bob', group: '', last_contact_at: today }),
      ct({ name: '周七', group: '客户、同事' }),
    ])
    mount()
    await screen.findByText('许知行')
    expect(sections()).toEqual(['今天', '未联系'])
    const seg = screen.getByRole('group', { name: '分组' })
    expect(within(seg).getByRole('button', { name: /全部\s*4/ })).toHaveAttribute('aria-pressed', 'true')
    // 多个分组的人在每个分组里各算一次，标签悬停看全部
    expect(within(seg).getByRole('button', { name: /同事\s*2/ })).toBeInTheDocument()
    const cl = screen.getAllByRole('row').find((r) => r.getAttribute('aria-label') === '周七')!
    expect(within(cl).getByTitle('客户、同事')).toBeInTheDocument()

    await userEvent.type(screen.getByRole('searchbox', { name: '搜索联系人' }), '13722')
    expect(rowNames()).toEqual(['许知行'])
    await userEvent.click(screen.getByRole('button', { name: '清空' }))
    expect(rowNames()).toHaveLength(4)

    await userEvent.click(within(seg).getByRole('button', { name: /同事/ }))
    expect(rowNames()).toEqual(['周岚', '周七'].sort((x, y) => x.localeCompare(y, 'zh-CN')))
    // 没分组的算「其他」
    await userEvent.click(within(seg).getByRole('button', { name: /其他/ }))
    expect(rowNames()).toEqual(['Bob'])
    await userEvent.click(within(seg).getByRole('button', { name: /全部/ }))

    await userEvent.click(screen.getByRole('button', { name: '只看星标' }))
    expect(rowNames()).toEqual(['许知行'])
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索联系人' }), '周')
    expect(screen.getByText('没有匹配的联系人')).toBeInTheDocument()
  })

  it('点行首星标只改 starred，不打开抽屉；点行打开抽屉，Esc 关掉', async () => {
    const { calls, patches } = fakeBackend([ct({ name: '许知行', title: 'IT 总监', company: '远川科技' })])
    const router = mount()
    await screen.findByText('许知行')
    await userEvent.click(screen.getByRole('button', { name: '加星标：许知行' }))
    await waitFor(() => expect(calls).toContain('PATCH /api/stakeholders/stk_' + seq))
    expect(patches).toEqual([{ starred: true }])
    expect(await screen.findByRole('button', { name: '取消星标：许知行' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('row', { name: '许知行' }))
    const dlg = await screen.findByRole('dialog', { name: '联系人 许知行' })
    expect(within(dlg).getByText('IT 总监 · 远川科技')).toBeInTheDocument()
    expect(router.state.location.search).toBe(`?c=stk_${seq}`)
    expect(screen.getByRole('row', { name: '许知行' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(router.state.location.search).toBe('')
  })

  it('星标保存失败时退回并提示', async () => {
    fakeBackend([ct({ name: '周岚' })], { failPatch: true })
    mount()
    await screen.findByText('周岚')
    await userEvent.click(screen.getByRole('button', { name: '加星标：周岚' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('星标没改成')
    expect(screen.getByRole('button', { name: '加星标：周岚' })).toBeInTheDocument()
  })

  it('先渲染 100 行，「显示更多」每次多 100 行，筛选一变回到前 100 行', async () => {
    fakeBackend(Array.from({ length: 250 }, (_, i) => ct({ name: `测试${String(i).padStart(3, '0')}` })))
    mount()
    await screen.findByText('测试000')
    expect(rowNames()).toHaveLength(100)
    await userEvent.click(screen.getByRole('button', { name: /显示更多\s*还有 150 人/ }))
    expect(rowNames()).toHaveLength(200)
    await userEvent.click(screen.getByRole('button', { name: /显示更多\s*还有 50 人/ }))
    expect(rowNames()).toHaveLength(250)
    expect(screen.queryByRole('button', { name: /显示更多/ })).not.toBeInTheDocument()
    // 全员没联系过，默认按姓名；换成最近联系也回到前 100 行
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /排序/ }), 'recent')
    expect(rowNames()).toHaveLength(100)
    // 展开后搜一下再清空，也回到前 100 行，不恢复成之前展开的
    await userEvent.click(screen.getByRole('button', { name: /显示更多/ }))
    expect(rowNames()).toHaveLength(200)
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索联系人' }), '测')
    await userEvent.click(screen.getByRole('button', { name: '清空' }))
    expect(rowNames()).toHaveLength(100)
    // 分段人数算的是全部，不只是已渲染的
    expect(screen.getByRole('row', { name: /^未联系\s*250$/ })).toBeInTheDocument()
  })

  it('地址里的联系人不在了：抽屉说已删除', async () => {
    fakeBackend([ct({ name: '周岚' })])
    mount('/contacts?c=stk_gone')
    expect(await screen.findByText('这个联系人已删除')).toBeInTheDocument()
  })

  it('一个都没有时显示空状态', async () => {
    fakeBackend([])
    mount()
    expect(await screen.findByText('还没有联系人')).toBeInTheDocument()
  })
})
