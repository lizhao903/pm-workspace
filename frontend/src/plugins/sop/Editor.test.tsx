import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SopAssistReply, SopFlow, SopNodeType } from '../../core/data'
import Page from './Page'

const TYPES: SopNodeType[] = [
  { kind: 'auto', group: '基础', branching: false, required: [] },
  { kind: 'decide', group: '逻辑', branching: true, default_cases: [{ key: 'yes', label: '是' }, { key: 'no', label: '否' }], required: [] },
  { kind: 'review', group: '人工', branching: false, required: [] },
  { kind: 'http', group: '外部', branching: false, required: [{ key: 'url', label: '地址' }] },
  { kind: 'notify', group: '外部', branching: false, required: [] },
]

const FLOW: SopFlow = {
  id: 'sop_fb', name: '客户反馈转需求', desc: '', trigger: '手动', version: 3, created_at: '', updated_at: '',
  fields: [{ key: 'customer', label: '客户', type: 'text', required: true }],
  steps: [
    { key: 'a', name: '整理', kind: 'auto', after: [] },
    { key: 'b', name: '复核', kind: 'review', after: ['a'] },
  ],
  layout: { __start: { x: 60, y: 80 }, a: { x: 400, y: 80 }, b: { x: 700, y: 120 } },
}

type Call = { method: string; path: string; body?: Record<string, unknown> }

function fakeBackend(opts: { saveIssues?: { text: string; step?: number }[]; assist?: (body: Record<string, unknown>) => Response } = {}) {
  const calls: Call[] = []
  const flows: SopFlow[] = [structuredClone(FLOW)]
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { data, meta: Array.isArray(data) ? { total: data.length } : undefined } : data), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body })
    if (u.pathname === '/api/sop/node-types') return json(TYPES)
    if (u.pathname === '/api/sop/runs') return json([])
    if (u.pathname === '/api/sop/folders') return json([{ id: 'sfd_pm', name: '产品经理', count: 0, created_at: '', updated_at: '' }])
    if (u.pathname === '/api/sop/assist') return opts.assist ? opts.assist(body) : json({ text: '好' })
    if (u.pathname === '/api/sop/flows' && method === 'POST') {
      if (opts.saveIssues) return json({ error: { code: 'validation', message: opts.saveIssues.map((x) => x.text).join('；'), issues: opts.saveIssues } }, 400)
      const f: SopFlow = { ...body, id: 'sop_new', version: 1, created_at: '', updated_at: '' }
      flows.push(f)
      return json(f, 201)
    }
    if (u.pathname === '/api/sop/flows') return json(flows)
    const one = u.pathname.match(/^\/api\/sop\/flows\/([^/]+)$/)
    if (one) {
      const i = flows.findIndex((x) => x.id === one[1])
      if (i < 0) return json({ error: { code: 'not_found', message: '流程不存在' } }, 404)
      if (method === 'PATCH') {
        if (opts.saveIssues) return json({ error: { code: 'validation', message: opts.saveIssues.map((x) => x.text).join('；'), issues: opts.saveIssues } }, 400)
        flows[i] = { ...flows[i], ...body, version: flows[i].version + 1 }
      }
      return json(flows[i])
    }
    // 字典、Agent、知识库、分类：空列表
    return json([])
  }))
  return { calls, flows }
}

function renderPage(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/sop/*', element: <Page /> }], { initialEntries: [path] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
const issueList = () => screen.getByRole('list', { name: '检查结果' })
const ai = () => screen.getByRole('complementary', { name: 'AI 协助' })

afterEach(() => vi.unstubAllGlobals())

describe('SOP 编排页', () => {
  it('新建：没填名称、没有步骤时发布不提交，列出问题', async () => {
    const user = userEvent.setup()
    const { calls } = fakeBackend()
    renderPage('/sop/new')
    await user.click(await screen.findByRole('button', { name: '发布' }))
    expect(within(issueList()).getByText('还没有名称')).toBeInTheDocument()
    expect(within(issueList()).getByText('至少要有一个步骤')).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/sop/flows')).toBe(false)
  })

  it('新建：加一个节点、填名称后发布，位置一起存进 layout，回到流程详情', async () => {
    const user = userEvent.setup()
    const { calls } = fakeBackend()
    const router = renderPage('/sop/new')
    await user.click(await screen.findByRole('button', { name: '添加节点' }))
    const palette = screen.getByRole('dialog', { name: '选择节点' })
    // notify 由 IM 插件的节点代替，不列
    expect(within(palette).queryByText('发送消息')).not.toBeInTheDocument()
    expect(within(palette).getByText('人工判断')).toBeInTheDocument()
    await user.click(within(palette).getByRole('button', { name: /人工检查/ }))
    expect(screen.getByRole('button', { name: '节点 人工检查' })).toBeInTheDocument()
    // 选中新节点，属性面板打开
    expect(screen.getByRole('textbox', { name: '节点名称' })).toHaveValue('人工检查')
    await user.type(screen.getByRole('textbox', { name: 'SOP 名称' }), '新流程')
    await user.click(screen.getByRole('button', { name: '发布' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/sop/flows/sop_new'))
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/sop/flows')!.body!
    // 没有 sop_trigger 枚举时用内置的，存 key
    expect(post).toMatchObject({ name: '新流程', trigger: 'manual', steps: [{ key: 's1', name: '人工检查', kind: 'review', after: [] }] })
    expect(Object.keys(post.layout as object).sort()).toEqual(['__start', 's1'])
  })

  it('开始节点选文件夹，保存时带 folder_id；在文件夹里点的新建默认放进那个文件夹（TSK-0482）', async () => {
    const user = userEvent.setup()
    const { calls } = fakeBackend()
    renderPage('/sop/flows/sop_fb/edit')
    fireEvent.keyDown(await screen.findByRole('button', { name: '开始节点' }), { key: 'Enter' })
    const panel = screen.getByRole('complementary', { name: '开始节点' })
    const pick = within(panel).getByRole('button', { name: '文件夹' })
    expect(pick).toHaveTextContent('未分类')
    await user.click(pick)
    await user.click(await screen.findByRole('option', { name: /产品经理/ }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({ folder_id: 'sfd_pm', version: 3 }))
  })

  it('在文件夹里新建：草稿带上那个文件夹', async () => {
    const user = userEvent.setup()
    const { calls } = fakeBackend()
    renderPage('/sop/new?folder=sfd_pm')
    await user.click(await screen.findByRole('button', { name: '添加节点' }))
    await user.click(within(screen.getByRole('dialog', { name: '选择节点' })).getByRole('button', { name: /人工检查/ }))
    await user.type(screen.getByRole('textbox', { name: 'SOP 名称' }), '新流程')
    await user.click(screen.getByRole('button', { name: '发布' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/sop/flows')?.body).toMatchObject({ name: '新流程', folder_id: 'sfd_pm' }))
  })

  it('必填配置没填时不保存，输入框标红', async () => {
    const user = userEvent.setup()
    const { calls } = fakeBackend()
    renderPage('/sop/flows/sop_fb/edit')
    await user.click(await screen.findByRole('button', { name: '添加节点' }))
    await user.click(within(screen.getByRole('dialog', { name: '选择节点' })).getByRole('button', { name: /HTTP 请求/ }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(within(issueList()).getByText('「HTTP 请求」还没填「地址」')).toBeInTheDocument()
    expect(screen.getByText('必填')).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
  })

  it('后端拒绝保存（依赖成环）时问题标到对应节点上，状态保持有未保存的修改', async () => {
    const user = userEvent.setup()
    const text = '依赖成环：「整理」 → 「复核」 → 「整理」'
    const { calls } = fakeBackend({ saveIssues: [{ text, step: 1 }] })
    renderPage('/sop/flows/sop_fb/edit')
    const name = await screen.findByRole('textbox', { name: 'SOP 名称' })
    await user.type(name, '（改）')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '节点 复核' })).toHaveAttribute('aria-invalid', 'true'))
    expect(screen.getByRole('button', { name: '节点 整理' })).not.toHaveAttribute('aria-invalid')
    expect(screen.getByRole('button', { name: '节点 复核' })).toHaveTextContent('!')
    expect(within(issueList()).getByText(text)).toBeInTheDocument()
    expect(screen.getByText('有未保存的修改')).toBeInTheDocument()
    expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({ version: 3, name: '客户反馈转需求（改）' })
    // 点问题选中那个节点
    await user.click(within(issueList()).getByText(text))
    expect(screen.getByRole('textbox', { name: '节点名称' })).toHaveValue('复核')
  })

  it('AI 协助：加一个人工检查，应用后画布出现新节点，撤销后恢复', async () => {
    const user = userEvent.setup()
    let sent: Record<string, unknown> | undefined
    fakeBackend({
      assist: (body) => {
        sent = body
        const d = body.draft as SopAssistReply['draft']
        return ok({ text: '在「复核」后面加了一步', draft: { ...d, steps: [...d!.steps, { key: 's3', name: '检查复核', kind: 'review', after: ['b'] }] } })
      },
    })
    renderPage('/sop/flows/sop_fb/edit')
    // 窄屏（测试环境 matchMedia 不匹配）打开编排页时 AI 面板收起
    await user.click(await screen.findByRole('button', { name: /AI 协助/ }))
    const box = screen.getByRole('textbox', { name: '和 AI 说' })
    await user.type(box, '加一个人工检查')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await user.click(await screen.findByRole('button', { name: '应用到流程' }))
    expect(sent).toMatchObject({ message: '加一个人工检查', draft: { name: '客户反馈转需求' } })
    expect((sent!.draft as Record<string, unknown>).layout).toBeUndefined()
    expect(screen.getByRole('button', { name: '节点 检查复核' })).toBeInTheDocument()
    expect(screen.getByText('已应用')).toBeInTheDocument()

    await user.click(within(ai()).getByRole('button', { name: '撤销' }))
    expect(screen.queryByRole('button', { name: '节点 检查复核' })).not.toBeInTheDocument()
    expect(screen.getByText('未采用')).toBeInTheDocument()
    expect(screen.getByText('已保存')).toBeInTheDocument()
  })

  it('AI 协助：应用后又改了画布就不再给撤销；模型出错时说明原因', async () => {
    const user = userEvent.setup()
    let n = 0
    fakeBackend({
      assist: (body) => {
        n += 1
        if (n === 2) return new Response(JSON.stringify({ error: { code: 'bad_model_reply', message: '模型回的不是 JSON' } }), { status: 422 })
        const d = body.draft as SopAssistReply['draft']
        return ok({ text: '加了', draft: { ...d, steps: [...d!.steps, { key: 's3', name: '新步骤', kind: 'auto', after: ['b'] }] } })
      },
    })
    renderPage('/sop/flows/sop_fb/edit')
    await user.click(await screen.findByRole('button', { name: /AI 协助/ }))
    await user.type(screen.getByRole('textbox', { name: '和 AI 说' }), '加一步')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await user.click(await screen.findByRole('button', { name: '应用到流程' }))
    expect(within(ai()).getByRole('button', { name: '撤销' })).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'SOP 名称' }), '2')
    expect(within(ai()).queryByRole('button', { name: '撤销' })).not.toBeInTheDocument()

    await user.type(screen.getByRole('textbox', { name: '和 AI 说' }), '再来')
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText('没能生成流程：模型回的不是 JSON')).toBeInTheDocument()
  })

  it('有未保存的修改时返回先确认', async () => {
    const user = userEvent.setup()
    fakeBackend()
    const router = renderPage('/sop/flows/sop_fb/edit')
    await user.type(await screen.findByRole('textbox', { name: 'SOP 名称' }), '改')
    await user.click(screen.getByRole('button', { name: '返回' }))
    const dlg = await screen.findByRole('alertdialog', { name: '离开编排页？' })
    await user.click(within(dlg).getByRole('button', { name: '不保存，离开' }))
    expect(router.state.location.pathname).toBe('/sop/flows/sop_fb')
  })

  it('流程已删除时编排页说明', async () => {
    fakeBackend()
    renderPage('/sop/flows/sop_gone/edit')
    expect(await screen.findByText('这个 SOP 已经删除')).toBeInTheDocument()
  })
})
