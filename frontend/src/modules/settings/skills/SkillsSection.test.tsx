import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Skill } from '../../../core/data'
import { SkillsSection } from './SkillsSection'

const sk = (p: Partial<Skill> & { id: string }): Skill => ({
  name: p.id, desc: '', source: 'custom', uses: [], instructions: '步骤', when: '', agents: [], ...p,
})

const seed = (): Skill[] => [
  sk({ id: 'sk_weekly', name: '写周报', desc: '按项目归类本周完成', source: 'builtin', uses: ['查任务', '写文档', 'B 站', '终端'], when: '周五' }),
  sk({ id: 'sk_cut', name: '剪口播', source: 'video' }),
  sk({ id: 'sk_q', name: '业务数据查询', desc: 'PostgreSQL 只读', uses: ['GitHub · list_issues'], agents: [{ id: 'ag_a', name: '数据助手' }, { id: 'ag_b', name: '分诊助手' }] }),
]

type Call = { method: string; path: string; body?: Record<string, unknown> }

function stub(rows: Skill[]) {
  const calls: Call[] = []
  const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path, body })
    if (path === '/api/skills' && method === 'GET') return new Response(JSON.stringify({ data: rows, meta: { total: rows.length } }))
    if (path === '/api/plugins') return ok([{ id: 'video', name: '视频制作' }])
    if (path === '/api/connectors') {
      return ok([{ id: 'cn_1', tool: 'github', name: 'GitHub', status: 'connected', tools: [{ name: 'list_issues', desc: '', write: false, mode: 'auto' }] }])
    }
    if (path === '/api/skills' && method === 'POST') {
      const from = rows.find((r) => r.id === body.copy_from)
      const s = sk({ ...(from ?? {}), ...body, id: 'sk_new', source: 'custom', agents: [] })
      delete (s as Record<string, unknown>).copy_from
      rows = [s, ...rows]
      return ok(s, 201)
    }
    const id = decodeURIComponent(path.split('/').pop()!)
    if (method === 'PATCH') {
      rows = rows.map((r) => (r.id === id ? { ...r, ...body } : r))
      return ok(rows.find((r) => r.id === id))
    }
    if (method === 'DELETE') {
      const s = rows.find((r) => r.id === id)
      rows = rows.filter((r) => r.id !== id)
      return ok(s)
    }
    return new Response('{}', { status: 404 })
  }))
  return calls
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path, c.body])

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><SkillsSection /></QueryClientProvider>)
}

afterEach(() => { vi.unstubAllGlobals() })

describe('技能页', () => {
  it('列表：来源筛选带数量，插件技能有才出现；用到最多露 3 个；没人在用写明；搜不到和一个都没有分开说', async () => {
    stub(seed())
    renderPage()
    const seg = within(await screen.findByRole('group', { name: '来源' }))
    expect(seg.getByRole('button', { name: /全部\s*3/ })).toHaveAttribute('aria-pressed', 'true')
    expect(seg.getByRole('button', { name: /内置\s*1/ })).toBeInTheDocument()
    expect(seg.getByRole('button', { name: /自定义\s*1/ })).toBeInTheDocument()
    expect(seg.getByRole('button', { name: /插件\s*1/ })).toBeInTheDocument()
    const weekly = screen.getByText('写周报').closest('[data-skill]') as HTMLElement
    expect(within(weekly).getByText('+1')).toBeInTheDocument()
    expect(within(weekly).getByText('没有 Agent 在用')).toBeInTheDocument()

    await userEvent.click(seg.getByRole('button', { name: /插件/ }))
    expect(screen.getByText('剪口播')).toBeInTheDocument()
    expect(screen.queryByText('写周报')).not.toBeInTheDocument()
    await userEvent.click(seg.getByRole('button', { name: /全部/ }))
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索技能' }), 'postgresql')
    expect(screen.getByText('业务数据查询')).toBeInTheDocument()
    expect(screen.queryByText('写周报')).not.toBeInTheDocument()
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索技能' }), 'zzz')
    expect(screen.getByText('没有匹配的技能')).toBeInTheDocument()
  })

  it('一个技能都没有', async () => {
    stub([])
    renderPage()
    expect(await screen.findByText('还没有技能')).toBeInTheDocument()
    expect(screen.getByText('点右上角「新建技能」')).toBeInTheDocument()
  })

  it('内置技能只读，只有复制；复制后打开新技能的抽屉，名称加「（我的）」，创建带 copy_from，之后切成编辑', async () => {
    const calls = stub(seed())
    renderPage()
    await userEvent.click(await screen.findByText('写周报'))
    const drawer = within(screen.getByRole('dialog', { name: '内置技能' }))
    expect(drawer.getByText(/内置技能不能直接改/)).toBeInTheDocument()
    expect(drawer.getByDisplayValue('写周报')).toBeDisabled()
    expect(drawer.queryByRole('button', { name: '删除' })).not.toBeInTheDocument()
    expect(drawer.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
    expect(drawer.getByText('B 站')).toBeInTheDocument()
    expect(drawer.getByText('还没有 Agent 挂这个技能')).toBeInTheDocument()
    expect(screen.getByText('写周报').closest('[data-skill]')).toHaveClass('sel')

    await userEvent.click(drawer.getByRole('button', { name: '复制一份来改' }))
    const copy = within(await screen.findByRole('dialog', { name: '新建技能' }))
    expect(copy.getByDisplayValue('写周报（我的）')).toBeEnabled()
    expect(copy.getByDisplayValue('周五')).toBeInTheDocument()
    await userEvent.click(copy.getByRole('button', { name: '创建' }))
    const edit = within(await screen.findByRole('dialog', { name: '技能' }))
    expect(edit.getByRole('button', { name: '删除' })).toBeInTheDocument()
    expect(edit.getByRole('button', { name: '保存' })).toBeInTheDocument()
    expect(writes(calls)).toEqual([['POST', '/api/skills', {
      name: '写周报（我的）', desc: '按项目归类本周完成', when: '周五', instructions: '步骤', uses: ['查任务', '写文档', 'B 站', '终端'], copy_from: 'sk_weekly',
    }]])
  })

  it('新建：名称和怎么做没填就红框不提交；加连接器工具从开着的工具里挑', async () => {
    const calls = stub(seed())
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: '新建技能' }))
    const d = within(screen.getByRole('dialog', { name: '新建技能' }))
    const name = d.getByPlaceholderText('比如：竞品分析')
    expect(name).toHaveFocus()
    await userEvent.click(d.getByRole('button', { name: '创建' }))
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(writes(calls)).toEqual([])

    await userEvent.type(name, '竞品分析')
    await userEvent.type(d.getByRole('textbox', { name: /怎么做/ }), '先列竞品')
    await userEvent.click(d.getByRole('checkbox', { name: '查任务' }))
    await userEvent.click(d.getByRole('button', { name: /加连接器工具/ }))
    await userEvent.click(await screen.findByRole('option', { name: /list_issues/ }))
    await userEvent.keyboard('{Escape}')
    await userEvent.click(d.getByRole('button', { name: '创建' }))
    await screen.findByRole('dialog', { name: '技能' })
    expect(writes(calls)).toEqual([['POST', '/api/skills', {
      name: '竞品分析', desc: '', when: '', instructions: '先列竞品', uses: ['查任务', 'GitHub · list_issues'],
    }]])
  })

  it('自定义技能：改了只传改动；删除前列出挂着它的 Agent', async () => {
    const calls = stub(seed())
    renderPage()
    await userEvent.click(await screen.findByText('业务数据查询'))
    const d = within(screen.getByRole('dialog', { name: '技能' }))
    expect(d.getByText('数据助手')).toBeInTheDocument()
    const desc = d.getByDisplayValue('PostgreSQL 只读')
    await userEvent.clear(desc)
    await userEvent.type(desc, '只读查询')
    await userEvent.click(d.getByRole('button', { name: '保存' }))
    await vi.waitFor(() => expect(writes(calls)).toEqual([['PATCH', '/api/skills/sk_q', { desc: '只读查询' }]]))

    await userEvent.click(d.getByRole('button', { name: '删除' }))
    const dlg = within(screen.getByRole('alertdialog'))
    expect(dlg.getByText('数据助手、分诊助手 挂着它，删除后会自动卸下')).toBeInTheDocument()
    await userEvent.click(dlg.getByRole('button', { name: '删除' }))
    await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: '技能' })).not.toBeInTheDocument())
    expect(writes(calls).at(-1)).toEqual(['DELETE', '/api/skills/sk_q', undefined])
  })
})
