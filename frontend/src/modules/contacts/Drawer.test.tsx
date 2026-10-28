import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Contact, Identity } from '../../core/data'
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

// 内存里的名册和身份表，规则照后端：撞名 409、同渠道同编号 409、有引用的人不能删
function fakeBackend(rows: Contact[], ids: Identity[] = [], opts: { refs?: Set<string> } = {}) {
  const calls: string[] = []
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data } : data), { status })
  const conflict = (message: string) => json({ error: { code: 'conflict', message } }, 409)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push(`${method} ${u.pathname}`)
    if (u.pathname === '/api/stakeholders') {
      if (method === 'GET') return json(rows.filter((r) => !r.archived_at))
      if (rows.some((r) => r.name === body.name)) return conflict(`stakeholder ${body.name} already exists`)
      const c = ct(body)
      rows.push(c)
      return json(c, 201)
    }
    const m = u.pathname.match(/^\/api\/stakeholders\/([^/]+)$/)
    if (m) {
      const c = rows.find((r) => r.id === decodeURIComponent(m[1]))!
      if (method === 'PATCH') {
        const { archived, ...rest } = body
        Object.assign(c, rest, archived ? { archived_at: '2026-10-29T00:00:00Z' } : {})
        return json(c)
      }
      if (method === 'DELETE') {
        if (c.owned_count || c.participating_count || opts.refs?.has(c.id)) return conflict('stakeholder is referenced')
        rows.splice(rows.indexOf(c), 1)
        for (let i = ids.length - 1; i >= 0; i--) if (ids[i].stakeholder_id === c.id) ids.splice(i, 1)
        return json(null)
      }
    }
    if (u.pathname === '/api/im-identities') {
      if (method === 'GET') return json(ids)
      const ext = body.channel === 'telegram' ? body.external_id.replace(/^@/, '') : body.external_id
      if (ids.some((i) => i.channel === body.channel && i.external_id === ext)) return conflict('identity already belongs to someone')
      seq += 1
      const i: Identity = { id: `idn_${seq}`, display_name: '', account: '', created_at: '', updated_at: '', ...body, external_id: ext }
      ids.push(i)
      return json(i, 201)
    }
    const mi = u.pathname.match(/^\/api\/im-identities\/([^/]+)$/)
    if (mi) {
      const k = ids.findIndex((i) => i.id === mi[1])
      if (method === 'DELETE') { ids.splice(k, 1); return json(null) }
      if (method === 'PATCH') { Object.assign(ids[k], body); return json(ids[k]) }
    }
    if (u.pathname === '/api/dictionaries') return json([])
    return json({ error: { code: 'not_found', message: u.pathname } }, 404)
  }))
  return { calls, rows, ids }
}

function mount(initial = '/contacts') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/contacts', element: <Page /> }], { initialEntries: [initial] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

afterEach(() => vi.unstubAllGlobals())

describe('联系人抽屉', () => {
  it('新建联系人并填两个渠道：先存资料再建身份，存好切到查看态，列表显示渠道徽标', async () => {
    const be = fakeBackend([ct({ name: '周岚' })])
    const router = mount()
    await screen.findByText('周岚')
    await userEvent.click(screen.getByRole('button', { name: '新建联系人' }))
    const form = await screen.findByRole('dialog', { name: '新建联系人' })
    // 姓名为空提交：标红不保存
    await userEvent.click(within(form).getByRole('button', { name: '创建' }))
    expect(within(form).getByText('姓名必填')).toBeInTheDocument()
    await userEvent.type(within(form).getByPlaceholderText('例如 许知行'), ' 许知行 ')
    await userEvent.type(within(form).getByRole('textbox', { name: '微信编号' }), 'xuzhixing')
    await userEvent.type(within(form).getByRole('textbox', { name: 'Telegram编号' }), '@xuzx')
    await userEvent.type(within(form).getByRole('textbox', { name: '添加标签' }), '试点{Enter}')
    await userEvent.click(within(form).getByRole('button', { name: '创建' }))

    const view = await screen.findByRole('dialog', { name: '联系人 许知行' })
    const created = be.rows.find((r) => r.name === '许知行')!
    expect(created.tags).toEqual(['试点'])
    expect(created.group).toBe('其他')
    expect(be.ids.map((i) => [i.stakeholder_id, i.channel, i.external_id])).toEqual([
      [created.id, 'wechat', 'xuzhixing'], [created.id, 'telegram', 'xuzx'],
    ])
    expect(router.state.location.search).toBe(`?c=${created.id}`)
    const im = within(view).getByRole('list', { name: 'IM 渠道' })
    expect(within(im).getByRole('listitem', { name: '微信' })).toHaveTextContent('xuzhixing')
    expect(within(im).getByRole('listitem', { name: 'Telegram' })).toHaveTextContent('xuzx')
    expect(within(within(im).getByRole('listitem', { name: 'Telegram' })).getByRole('link', { name: '打开' })).toHaveAttribute('href', 'https://t.me/xuzx')
    expect(within(im).getByRole('listitem', { name: 'QQ' })).toHaveTextContent('未填写')
    const row = screen.getAllByRole('row').find((r) => r.getAttribute('aria-label') === '许知行')!
    expect(within(row).getByTitle('微信：xuzhixing')).toBeInTheDocument()
    expect(within(row).getByTitle('Telegram：xuzx')).toBeInTheDocument()
  })

  it('编辑：清空一个渠道就删掉这个身份，改了的改，别的资料一起存', async () => {
    const a = ct({ name: '许知行' })
    const be = fakeBackend([a], [
      { id: 'idn_w', stakeholder_id: a.id, channel: 'wechat', external_id: 'old', display_name: '', account: '', created_at: '', updated_at: '' },
      { id: 'idn_q', stakeholder_id: a.id, channel: 'qq', external_id: '10001', display_name: '', account: '', created_at: '', updated_at: '' },
    ])
    mount(`/contacts?c=${a.id}`)
    const view = await screen.findByRole('dialog', { name: '联系人 许知行' })
    await userEvent.click(within(view).getAllByRole('button', { name: '编辑' })[1])
    const form = await screen.findByRole('dialog', { name: '编辑联系人 许知行' })
    await userEvent.clear(within(form).getByRole('textbox', { name: 'QQ编号' }))
    const wx = within(form).getByRole('textbox', { name: '微信编号' })
    await userEvent.clear(wx)
    await userEvent.type(wx, 'new{Enter}')
    await screen.findByRole('dialog', { name: '联系人 许知行' })
    expect(be.ids.map((i) => [i.channel, i.external_id])).toEqual([['wechat', 'new']])
    expect(be.calls).toEqual(expect.arrayContaining(['PATCH /api/im-identities/idn_w', 'DELETE /api/im-identities/idn_q']))
  })

  it('撞名回 409 时提示加区分，表单保留', async () => {
    fakeBackend([ct({ name: '王磊' })])
    mount()
    await screen.findByText('王磊')
    await userEvent.click(screen.getByRole('button', { name: '新建联系人' }))
    const form = await screen.findByRole('dialog', { name: '新建联系人' })
    await userEvent.type(within(form).getByPlaceholderText('例如 许知行'), '王磊{Enter}')
    expect(await within(form).findByRole('alert')).toHaveTextContent('已经有叫「王磊」的联系人了，名字加个区分再保存，比如「王磊（公司）」')
  })

  it('编号已经是别人的：输入时就提示，存的时候这个渠道没存上，别的照存', async () => {
    const b = ct({ name: '周岚' })
    const be = fakeBackend([b], [
      { id: 'idn_b', stakeholder_id: b.id, channel: 'wechat', external_id: 'shared', display_name: '', account: '', created_at: '', updated_at: '' },
    ])
    mount()
    await screen.findByText('周岚')
    await userEvent.click(screen.getByRole('button', { name: '新建联系人' }))
    const form = await screen.findByRole('dialog', { name: '新建联系人' })
    await userEvent.type(within(form).getByPlaceholderText('例如 许知行'), '许知行')
    await userEvent.type(within(form).getByRole('textbox', { name: '微信编号' }), 'shared')
    await userEvent.type(within(form).getByRole('textbox', { name: 'QQ编号' }), '10001')
    expect(within(form).getByText('这个编号已经是 周岚 的')).toBeInTheDocument()
    await userEvent.click(within(form).getByRole('button', { name: '创建' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent('微信编号 shared 已经是 周岚 的，没有存上')
    const created = be.rows.find((r) => r.name === '许知行')!
    expect(be.ids.filter((i) => i.stakeholder_id === created.id).map((i) => i.channel)).toEqual(['qq'])
    // 再点保存是编辑刚建的人，不会再建一个
    expect(within(form).getByRole('button', { name: '保存' })).toBeInTheDocument()
  })

  it('有负责事项的人：删除被拦下，提示改为归档；归档后从列表消失', async () => {
    const a = ct({ name: '许知行', owned_count: 2, participating_count: 1 })
    const be = fakeBackend([a, ct({ name: '周岚' })])
    mount(`/contacts?c=${a.id}`)
    const view = await screen.findByRole('dialog', { name: '联系人 许知行' })
    expect(within(view).getByText('负责 2 · 参与 1')).toBeInTheDocument()
    await userEvent.click(within(view).getByRole('button', { name: '删除' }))
    expect(within(view).getByRole('alert')).toHaveTextContent('「许知行」还负责 2 件事、参与 1 件事，不能删除。可以改为归档')
    expect(within(view).queryByRole('button', { name: '删除' })).toBeNull()
    expect(be.calls).not.toContain(`DELETE /api/stakeholders/${a.id}`)
    await userEvent.click(within(view).getByRole('button', { name: '改为归档' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(screen.queryByText('许知行')).toBeNull())
    expect(be.calls).toContain(`PATCH /api/stakeholders/${a.id}`)
  })

  it('没有引用：确认条列出影响，确认后删除并关闭；回收站里有引用（409）时改为提示归档', async () => {
    const a = ct({ name: '许知行' })
    const b = ct({ name: '周岚' })
    const be = fakeBackend([a, b], [
      { id: 'idn_w', stakeholder_id: a.id, channel: 'wechat', external_id: 'w', display_name: '', account: '', created_at: '', updated_at: '' },
    ], { refs: new Set([b.id]) })
    const router = mount(`/contacts?c=${a.id}`)
    let view = await screen.findByRole('dialog', { name: '联系人 许知行' })
    await waitFor(() => expect(within(view).getByRole('listitem', { name: '微信' })).toHaveTextContent('w'))
    await userEvent.click(within(view).getByRole('button', { name: '删除' }))
    expect(within(view).getByText(/确定删除「许知行」？删除后 1 个 IM 身份一起删除/)).toBeInTheDocument()
    await userEvent.click(within(view).getByRole('button', { name: '取消' }))
    await userEvent.click(within(view).getByRole('button', { name: '删除' }))
    await userEvent.click(within(view).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(be.rows.map((r) => r.name)).toEqual(['周岚'])
    expect(be.ids).toEqual([])

    await router.navigate(`/contacts?c=${b.id}`)
    view = await screen.findByRole('dialog', { name: '联系人 周岚' })
    await userEvent.click(within(view).getByRole('button', { name: '删除' }))
    await userEvent.click(within(view).getByRole('button', { name: '删除' }))
    expect(await within(view).findByRole('alert')).toHaveTextContent('还被回收站里的事项引用着，不能删除。可以改为归档')
  })

  it('记一次联系：最近联系改成现在', async () => {
    const a = ct({ name: '许知行' })
    const be = fakeBackend([a])
    mount(`/contacts?c=${a.id}`)
    const view = await screen.findByRole('dialog', { name: '联系人 许知行' })
    // 没电话时置灰、没有链接
    expect(within(view).getByText('打电话')).toHaveAttribute('aria-disabled', 'true')
    expect(within(view).getByText('打电话')).not.toHaveAttribute('href')
    await userEvent.click(within(view).getByRole('button', { name: '记一次联系' }))
    await waitFor(() => expect(within(view).getByText('今天')).toBeInTheDocument())
    expect(be.rows[0].last_contact_at).not.toBeNull()
  })
})
