import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { lazy } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkObject } from '../../core/data'
import { projectTabRegistry } from '../../core/plugin'
import { resetRecentMemo } from './model'
import Page from './Page'

let seq = 0
function obj(p: Partial<WorkObject>): WorkObject {
  seq += 1
  return {
    id: `obj_${seq}`, ref: `PRJ-${seq}`, type_id: 'project', title: `项目${seq}`, body: '', status: 'planning', priority: '',
    owner: '', owner_id: null, category_id: null, project_id: null, source: 'manual', props: null, workdir: '',
    due_at: null, started_at: null, completed_at: null, archived_at: null, deleted_at: null,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', tags: [], link_count: 0, participants: [], ...p,
  } as WorkObject
}

const types = [{
  id: 'project', name: '项目', statuses: [
    { key: 'planning', label: '筹备中', color: '', terminal: false },
    { key: 'active', label: '进行中', color: '', terminal: false },
  ],
}]

type Extra = { summary?: unknown[]; pending?: unknown[] }

// 内存里的对象表：POST、PATCH 改了再取就是新的；extra 给项目汇总和待处理消息（没给时汇总为空、IM 插件没装）
function fakeBackend(rows: WorkObject[], extra: Extra = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const json = (data: unknown, status = 200, meta?: unknown) =>
    new Response(JSON.stringify(status < 300 ? { data, meta } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/objects' && method === 'GET') {
      const ty = u.searchParams.get('type')
      const pj = u.searchParams.get('project')
      const xs = rows.filter((o) => o.type_id === ty && !o.deleted_at && (!pj || o.project_id === pj))
      return json(xs, 200, { total: xs.length })
    }
    if (u.pathname === '/api/objects' && method === 'POST') {
      const o = obj({ ...body, title: body.title })
      rows.push(o)
      return json(o, 201)
    }
    const m = u.pathname.match(/^\/api\/objects\/([^/]+)$/)
    if (m) {
      const o = rows.find((r) => r.id === decodeURIComponent(m[1]))
      if (!o) return json({ error: { code: 'not_found', message: 'object not found' } }, 404)
      if (method === 'PATCH') Object.assign(o, body)
      if (method === 'DELETE') o.deleted_at = '2026-10-29T00:00:00Z'
      return json(o)
    }
    if (u.pathname === '/api/object-types') return json(types)
    if (u.pathname === '/api/projects/summary') return json(extra.summary ?? [], 200, { total: extra.summary?.length ?? 0 })
    if (u.pathname === '/api/plugins') return json(extra.pending ? [{ id: 'im', running: true }] : [])
    if (u.pathname === '/api/im/messages' && extra.pending) return json(extra.pending, 200, { total: extra.pending.length })
    if (/^\/api\/projects\/[^/]+\/stakeholders$/.test(u.pathname)) return json([], 200, { total: 0 })
    if (u.pathname === '/api/stakeholders' || u.pathname.startsWith('/api/dictionaries')) return json([])
    return json({ error: { code: 'not_found', message: u.pathname } }, 404)
  }))
  return calls
}

function mount(initial = '/projects') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/projects/*', element: <Page /> }, { path: '*', element: <div>别的页</div> }], { initialEntries: [initial] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

const cardNames = () => screen.queryAllByRole('button').filter((b) => b.classList.contains('pj-card')).map((b) => b.getAttribute('title'))

beforeEach(() => {
  localStorage.clear()
  resetRecentMemo()
})
afterEach(() => vi.unstubAllGlobals())

describe('项目列表', () => {
  it('按有原型在跑、有待回复、其他分组；卡片有原型数、待回复数；搜索和筛选后不分组，数字不受搜索影响', async () => {
    const a = obj({ title: '工作台', status: 'active', workdir: '/Volumes/project/pm-workspace' })
    const b = obj({ title: '交易台', status: 'planning', body: '行情和下单' })
    const c = obj({ title: '视频号', status: 'active' })
    const d = obj({ title: '博客', status: 'active' })
    const msg = (id: string, x: object) => ({ id, channel: 'slack', status: 'pending', relevance: 'me', conversation_id: null, conversation_external_id: '', at: '2026-10-29T00:00:00Z', ...x })
    fakeBackend([a, b, c, d], {
      summary: [
        { project_id: a.id, prototypes: { total: 2, running: 1 }, conversations: [{ id: 'cv_g', channel: 'slack', external_id: 'C01' }] },
        { project_id: b.id, prototypes: { total: 1, running: 0 }, conversations: [{ id: 'cv_g', channel: 'slack', external_id: 'C01' }] },
        { project_id: c.id, prototypes: { total: 0, running: 0 }, conversations: [{ id: 'cv_d', channel: 'slack', external_id: 'D09' }] },
      ],
      // 两条认上了会话，一条没认上、按渠道和会话编号对上私聊；和我无关的群消息不算待回复（B-01）
      pending: [msg('m1', { conversation_id: 'cv_g' }), msg('m2', { conversation_id: 'cv_g' }), msg('m3', { conversation_external_id: 'D09' }),
        msg('m4', { conversation_id: 'cv_g', relevance: '' })],
    })
    mount()
    await screen.findByTitle('工作台')
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['有原型在跑', '有待回复', '其他'])
    const card = (t: string) => screen.getByTitle(t)
    expect(card('工作台')).toHaveTextContent('原型 1/2')
    expect(card('工作台')).toHaveTextContent('2 条待回复')
    expect(card('交易台')).toHaveTextContent('原型 0/1')
    expect(card('交易台')).toHaveTextContent('筹备中')
    expect(card('视频号')).toHaveTextContent('1 条待回复')
    expect(card('视频号')).not.toHaveTextContent('原型')
    expect(card('博客')).not.toHaveTextContent('待回复')
    // 常态「进行中」不标
    expect(card('工作台')).not.toHaveTextContent('进行中')
    expect(within(screen.getByRole('region', { name: '有待回复' })).getAllByRole('button').map((x) => x.getAttribute('title'))).toEqual(['交易台', '视频号'])
    expect(screen.getByText('pm-workspace')).toBeInTheDocument()
    expect(screen.getAllByText('未设目录')).toHaveLength(3)

    await userEvent.type(screen.getByRole('searchbox', { name: '搜索项目' }), '下单')
    expect(cardNames()).toEqual(['交易台'])
    expect(screen.queryByRole('region')).toBeNull()
    const seg = screen.getByRole('group', { name: '状态' })
    expect(within(seg).getByRole('button', { name: /有待回复/ })).toHaveTextContent('有待回复2')

    await userEvent.click(screen.getByRole('button', { name: '清空' }))
    await userEvent.click(within(seg).getByRole('button', { name: /其他/ }))
    expect(cardNames()).toEqual(['博客'])
  })

  it('IM 插件没装时待回复按 0，原型照汇总分组', async () => {
    const a = obj({ title: '工作台' })
    fakeBackend([a, obj({ title: '交易台' })], { summary: [{ project_id: a.id, prototypes: { total: 1, running: 1 }, conversations: [] }] })
    mount()
    await screen.findByTitle('工作台')
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['有原型在跑', '其他'])
  })

  it('打开过的项目排在前面；点进详情后顶栏「项目」回到列表', async () => {
    fakeBackend([obj({ title: '甲' }), obj({ title: '乙' }), obj({ title: '丙' })])
    const router = mount()
    await screen.findByTitle('甲')
    expect(cardNames()).toEqual(['甲', '乙', '丙'])
    await userEvent.click(screen.getByTitle('丙'))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/projects\/obj_\d+$/))
    await screen.findByRole('tab', { name: '概览', selected: true })
    await userEvent.click(screen.getByRole('button', { name: '项目' }))
    expect(router.state.location.pathname).toBe('/projects')
    await screen.findByTitle('甲')
    expect(cardNames()).toEqual(['丙', '甲', '乙'])
    expect(JSON.parse(localStorage.getItem('pmw-projects-recent')!)[0]).toMatch(/^obj_/)
  })

  it('没有项目时引导新建；新建后打开设置标签，改目录会存到 workdir', async () => {
    const calls = fakeBackend([])
    const router = mount()
    await userEvent.click(await screen.findByRole('button', { name: '新建第一个项目' }))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/projects\/obj_\d+\/settings$/))
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.body).toMatchObject({ type_id: 'project', title: '新项目', props: { mark: { text: '', icon: 'folder' } } })

    const dir = await screen.findByRole('textbox', { name: '本地项目目录' })
    await userEvent.type(dir, '/tmp/pj')
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && (c.body as { workdir?: string }).workdir === '/tmp/pj')).toBe(true), { timeout: 2000 })
  })

  // C-05：刚新建、名称没改就离开时问要不要删
  const newEmpty = async () => {
    const calls = fakeBackend([obj({ title: '已有' })])
    const router = mount()
    await userEvent.click(await screen.findByRole('button', { name: '新建项目' }))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/projects\/obj_\d+\/settings$/))
    await screen.findByRole('textbox', { name: '名称' })
    const id = router.state.location.pathname.split('/')[2]
    return { calls, router, id }
  }
  const ask = () => screen.findByRole('alertdialog', { name: '空项目' })

  it('新建后名称没改就切标签：先问，删掉后回列表', async () => {
    const { calls, router, id } = await newEmpty()
    await userEvent.click(screen.getByRole('tab', { name: '概览' }))
    expect(await ask()).toHaveTextContent('这个项目还是空的（名称还是「新项目」），要删掉吗？')
    expect(router.state.location.pathname).toBe(`/projects/${id}/settings`)
    await userEvent.click(screen.getByRole('button', { name: '删掉' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects'))
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/api/objects/${id}`)).toBe(true)
  })

  it('新建后换到别的模块：删掉后去原本要去的地方', async () => {
    const { calls, router, id } = await newEmpty()
    void router.navigate('/contacts?c=x')
    await ask()
    await userEvent.click(screen.getByRole('button', { name: '删掉' }))
    await screen.findByText('别的页')
    expect(router.state.location.pathname + router.state.location.search).toBe('/contacts?c=x')
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/api/objects/${id}`)).toBe(true)
  })

  it('选「留着」照常离开、不删，再进来不再问', async () => {
    const { calls, router, id } = await newEmpty()
    await userEvent.click(screen.getByRole('button', { name: '项目' }))
    await ask()
    await userEvent.click(screen.getByRole('button', { name: '留着' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects'))
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    await router.navigate(`/projects/${id}/settings`)
    await screen.findByRole('textbox', { name: '名称' })
    await userEvent.click(screen.getByRole('tab', { name: '概览' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${id}`))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('「继续编辑」留在设置、回到名称；改了名称再离开不问', async () => {
    const { calls, router, id } = await newEmpty()
    await userEvent.click(screen.getByRole('tab', { name: '概览' }))
    await ask()
    await userEvent.click(screen.getByRole('button', { name: '继续编辑' }))
    const name = screen.getByRole('textbox', { name: '名称' })
    expect(name).toHaveFocus()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await userEvent.type(name, '甲')
    await userEvent.click(screen.getByRole('tab', { name: '概览' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${id}`))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('不是刚新建的项目名称叫「新项目」也不问', async () => {
    const p = obj({ title: '新项目' })
    fakeBackend([p])
    const router = mount(`/projects/${p.id}/settings`)
    await screen.findByRole('textbox', { name: '名称' })
    await userEvent.click(screen.getByRole('tab', { name: '概览' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${p.id}`))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('名称清空时不存，离开输入框恢复原名', async () => {
    const p = obj({ title: '工作台' })
    const calls = fakeBackend([p])
    mount(`/projects/${p.id}/settings`)
    const name = await screen.findByRole('textbox', { name: '名称' })
    await userEvent.clear(name)
    expect(screen.getByText('名称必填；不填的话离开输入框时恢复成「工作台」')).toBeInTheDocument()
    await userEvent.tab()
    expect(name).toHaveValue('工作台')
    await new Promise((r) => setTimeout(r, 700))
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
  })

  it('删除先确认，列出挂着的任务数；删完回到列表', async () => {
    const p = obj({ title: '工作台' })
    const rows = [p, obj({ type_id: 'task', title: '任务', project_id: p.id })]
    const calls = fakeBackend(rows)
    const router = mount(`/projects/${p.id}/settings`)
    await userEvent.click(await screen.findByRole('button', { name: '删除项目' }))
    await screen.findByText('只删项目记录，本地目录和文件不动；项目进回收站，可以恢复；1 个任务还挂在这个项目下，记录保留')
    await userEvent.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects'))
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/api/objects/${p.id}`)).toBe(true)
  })

  it('打开的项目不存在时提示并能回列表', async () => {
    fakeBackend([])
    const router = mount('/projects/obj_nope')
    await screen.findByText('这个项目不存在或已删除')
    await userEvent.click(screen.getByRole('button', { name: '回到项目列表' }))
    expect(router.state.location.pathname).toBe('/projects')
  })
})

describe('详情页的标签设置和切换项目', () => {
  it('设置里勾掉的标签不显示，概览、设置不能勾；停在被藏的标签上回概览', async () => {
    const a = obj({ title: '工作台', props: { tabs_hidden: ['sop'] } })
    const calls = fakeBackend([a])
    const router = mount(`/projects/${a.id}/sop`)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${a.id}`))
    const bar = await screen.findByRole('tablist', { name: '项目标签' })
    expect(within(bar).queryByRole('tab', { name: 'SOP' })).not.toBeInTheDocument()
    // TSK-0718：标签条和项目名称在同一行（标题行里，名称后面），不另起一行
    const row = bar.closest('.page-title, .tb-slot')
    expect(row).not.toBeNull()
    expect(within(row as HTMLElement).getByRole('heading', { level: 1 })).toHaveTextContent('工作台')
    expect(within(bar).getByRole('tab', { name: 'Agent' })).toBeInTheDocument()

    await userEvent.click(within(bar).getByRole('tab', { name: '设置' }))
    const sec = await screen.findByRole('region', { name: '显示的标签' })
    expect(within(sec).getByRole('checkbox', { name: '概览' })).toBeDisabled()
    expect(within(sec).getByRole('checkbox', { name: '设置' })).toBeDisabled()
    expect(within(sec).getByRole('checkbox', { name: 'SOP' })).not.toBeChecked()
    await userEvent.click(within(sec).getByRole('checkbox', { name: 'Agent' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && (c.body as { props?: { tabs_hidden?: string[] } }).props?.tabs_hidden?.join() === 'sop,agents')).toBe(true))
    await waitFor(() => expect(within(bar).queryByRole('tab', { name: 'Agent' })).not.toBeInTheDocument())
    await userEvent.click(within(sec).getByRole('checkbox', { name: 'SOP' }))
    await waitFor(() => expect(within(bar).getByRole('tab', { name: 'SOP' })).toBeInTheDocument())
  })

  it('标题里的项目名是切换菜单：最近打开的在前，可搜，选了停在同一个标签；目标项目藏了这个标签就回概览', async () => {
    const a = obj({ title: '工作台' })
    const b = obj({ title: '交易台' })
    const c = obj({ title: '博客', props: { tabs_hidden: ['tasks'] } })
    fakeBackend([a, b, c])
    localStorage.setItem('pmw-projects-recent', JSON.stringify([b.id]))
    const router = mount(`/projects/${a.id}/tasks`)
    const btn = await screen.findByRole('button', { name: '切换项目' })
    await waitFor(() => expect(btn).toHaveTextContent('工作台'))
    await userEvent.click(btn)
    const opts = () => screen.getAllByRole('option').map((o) => o.getAttribute('title'))
    // 最近打开的（交易台）在前，其余按名称
    expect(opts()).toEqual(['交易台', '博客', '工作台'])
    expect(screen.getAllByRole('option').find((o) => o.getAttribute('title') === '工作台')).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('交易{Enter}')
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${b.id}/tasks`))

    await userEvent.click(await screen.findByRole('button', { name: '切换项目' }))
    await userEvent.type(screen.getByRole('combobox', { name: '搜项目' }), '博客')
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(router.state.location.pathname).toBe(`/projects/${c.id}`))
  })

  const tabNames = (bar: HTMLElement) => within(bar).getAllByRole('tab').map((t) => t.textContent)
  const pickNames = (sec: HTMLElement) => within(within(sec).getByRole('list', { name: '标签顺序' })).getAllByRole('listitem').map((li) => li.textContent?.replace(/固定(第一|最后)$/, ''))
  const patchedOrder = (calls: { method: string; body?: unknown }[]) =>
    calls.filter((c) => c.method === 'PATCH').map((c) => (c.body as { props?: { tabs_order?: string[] } }).props?.tabs_order).filter(Boolean).at(-1)

  it('详情页标签按 props.tabs_order 排：概览第一、设置最后；藏掉的不显示', async () => {
    const order = ['prototypes', 'sop', 'comms', 'attachments', 'stakeholders', 'tasks', 'docs', 'agents', 'materials', 'profile']
    const a = obj({ title: '工作台', props: { tabs_order: ['settings', ...order], tabs_hidden: ['docs'] } })
    fakeBackend([a])
    mount(`/projects/${a.id}`)
    const bar = await screen.findByRole('tablist', { name: '项目标签' })
    // 附件在 IM 插件没在跑时本来就不显示
    expect(tabNames(bar)).toEqual(['概览', '原型', 'SOP', '沟通', '干系人', '任务', 'Agent', '支持材料', '档案', '设置'])
  })

  it('设置里用上移、下移调顺序：立即保存，焦点留在按钮上，标签条跟着变；固定项没有按钮；恢复默认顺序', async () => {
    const a = obj({ title: '工作台' })
    const calls = fakeBackend([a])
    mount(`/projects/${a.id}/settings`)
    const bar = await screen.findByRole('tablist', { name: '项目标签' })
    const sec = await screen.findByRole('region', { name: '显示的标签' })
    const reset = within(sec).getByRole('button', { name: '恢复默认顺序' })
    expect(reset).toBeDisabled()
    expect(pickNames(sec)).toEqual(['概览', '沟通', '附件', '干系人', '任务', '文档', 'SOP', 'Agent', '支持材料', '原型', '档案', '设置'])
    expect(within(sec).queryByRole('button', { name: '上移「概览」' })).toBeNull()
    expect(within(sec).queryByRole('button', { name: '下移「设置」' })).toBeNull()
    // 第一个能排的上不去，最后一个下不去
    expect(within(sec).getByRole('button', { name: '上移「沟通」' })).toBeDisabled()
    expect(within(sec).getByRole('button', { name: '下移「档案」' })).toBeDisabled()

    // 键盘：Tab 到按钮上按空格、回车
    const down = within(sec).getByRole('button', { name: '下移「沟通」' })
    down.focus()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(patchedOrder(calls)).toEqual(['attachments', 'comms', 'stakeholders', 'tasks', 'docs', 'sop', 'agents', 'materials', 'prototypes', 'profile']))
    expect(within(sec).getByRole('button', { name: '下移「沟通」' })).toHaveFocus()
    await userEvent.keyboard(' ')
    await waitFor(() => expect(pickNames(sec).slice(0, 4)).toEqual(['概览', '附件', '干系人', '沟通']))
    await waitFor(() => expect(tabNames(bar).slice(0, 3)).toEqual(['概览', '干系人', '沟通']))
    expect(screen.getByText('「沟通」移到第 4 个')).toBeInTheDocument()

    // 挪到最上面后上移置灰，焦点换到下移
    await userEvent.click(within(sec).getByRole('button', { name: '上移「原型」' }))
    const up = within(sec).getByRole('button', { name: '上移「SOP」' })
    up.focus()
    for (let i = 0; i < 5; i += 1) await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(pickNames(sec).slice(0, 3)).toEqual(['概览', 'SOP', '附件']))
    expect(within(sec).getByRole('button', { name: '上移「SOP」' })).toBeDisabled()
    expect(within(sec).getByRole('button', { name: '下移「SOP」' })).toHaveFocus()
    expect(pickNames(sec).at(-1)).toBe('设置')

    expect(reset).toBeEnabled()
    await userEvent.click(reset)
    await waitFor(() => expect(patchedOrder(calls)).toEqual([]))
    await waitFor(() => expect(tabNames(bar)).toEqual(['概览', '沟通', '干系人', '任务', '文档', 'SOP', 'Agent', '支持材料', '原型', '档案', '设置']))
    expect(reset).toBeDisabled()
  })

  it('拖动一行排序；插件给的标签也参与，新登记的按默认位置出现', async () => {
    const reg = projectTabRegistry('video').register({ key: 'deals', label: '商单', after: 'tasks', page: lazy(async () => ({ default: () => <div>商单内容</div> })) })
    try {
      // 存的顺序里没有商单（插件后来才开）：跟在默认顺序里它前面的「任务」后面
      const order = ['tasks', 'comms', 'attachments', 'stakeholders', 'docs', 'sop', 'agents', 'materials', 'prototypes']
      const a = obj({ title: '工作台', props: { tabs_order: order } })
      const calls = fakeBackend([a])
      mount(`/projects/${a.id}/settings`)
      const bar = await screen.findByRole('tablist', { name: '项目标签' })
      expect(tabNames(bar).slice(0, 4)).toEqual(['概览', '任务', '商单', '沟通'])
      const sec = await screen.findByRole('region', { name: '显示的标签' })
      expect(pickNames(sec).slice(0, 4)).toEqual(['概览', '任务', '商单', '沟通'])

      // 把商单拖到原型那一行（往下拖，落在原型后面）
      const row = (name: string) => within(sec).getAllByRole('listitem').find((li) => li.textContent?.startsWith(name))!
      const dt = { setData: () => {}, getData: () => '', effectAllowed: '', dropEffect: '' }
      fireEvent.dragStart(row('商单'), { dataTransfer: dt })
      fireEvent.dragOver(row('原型'), { dataTransfer: dt })
      fireEvent.drop(row('原型'), { dataTransfer: dt })
      await waitFor(() => expect(patchedOrder(calls)).toEqual(['tasks', 'comms', 'attachments', 'stakeholders', 'docs', 'sop', 'agents', 'materials', 'prototypes', 'deals', 'profile']))
      await waitFor(() => expect(tabNames(bar).slice(-4)).toEqual(['原型', '商单', '档案', '设置']))
      // 拖到设置上也只到可排的最后，设置不动；拖到概览上到第一个
      fireEvent.dragStart(row('沟通'), { dataTransfer: dt })
      fireEvent.drop(row('概览'), { dataTransfer: dt })
      await waitFor(() => expect(pickNames(sec).slice(0, 3)).toEqual(['概览', '沟通', '任务']))
    } finally {
      reg.dispose()
    }
  })
})

