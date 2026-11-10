// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置「角色」（SPEC-settings-24，AUTO-03）：列表和编辑分开，每个角色单独一页编辑；保存时换进整组 PUT；前端先挡空的和重复的，400 显示后端的话
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunPreset } from '../../../core/data'
import { RunPresetsSection } from './RunPresetsSection'
import { presetIssues, toggleDefault } from './presetModel'

const seed: RunPreset[] = [
  { id: 'rp_pm', scene: '产品经理工作台', content: '请按用户要求输出 PRD 文档，更新产品原型，同步后回复用户消息。', default: true },
  { id: 'rp_dev', scene: '研发开发', content: '按验收标准改代码，跑通测试后提交。', default: false },
  { id: 'rp_review', scene: '研发评审', content: '只读评审。', default: false, permission: 'read_only', output: '回报 verdict', dir_kind: 'code' },
]

function backend(put: (items: RunPreset[]) => Response) {
  const bodies: RunPreset[][] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/api/run-prompts') && init?.method === 'PUT') {
      const items = JSON.parse(String(init.body)).items as RunPreset[]
      bodies.push(items)
      return put(items)
    }
    return new Response(JSON.stringify({ data: seed }), { status: 200 })
  }))
  return bodies
}

function renderIt(at = '/settings/run-prompts') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([{ path: '/settings/*', element: <RunPresetsSection /> }], { initialEntries: [at] })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

afterEach(() => vi.unstubAllGlobals())

describe('角色的纯函数', () => {
  it('默认是单选，再点一次取消', () => {
    expect(toggleDefault(seed, 1).map((p) => p.default)).toEqual([false, true, false])
    expect(toggleDefault(seed, 0).map((p) => p.default)).toEqual([false, false, false])
  })
  it('空的、重复的场景和空内容挡下', () => {
    const list = [...seed, { id: '', scene: ' 研发开发 ', content: '', default: false, output: '长'.repeat(2001) }]
    expect(presetIssues(list, 3)).toEqual({ scene: '和上面的重复了', content: '写上执行要求', output: '最多 2000 字' })
    expect(presetIssues(seed, 0)).toEqual({})
  })
})

describe('角色设置', () => {
  it('列表只列角色，不在列表上编辑；点一行进它的编辑页', async () => {
    backend(() => new Response('{}', { status: 500 }))
    const router = renderIt()
    const table = await screen.findByRole('table', { name: '角色' })
    expect(within(table).getAllByRole('row').slice(1).map((r) => r.querySelector('b')?.textContent)).toEqual(['产品经理工作台', '研发开发', '研发评审'])
    expect(within(table).getByText('默认')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
    await userEvent.click(within(table).getByRole('row', { name: /研发评审/ }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/run-prompts/rp_review'))
    expect(await screen.findByLabelText('角色场景')).toHaveValue('研发评审')
    expect(screen.getByLabelText('权限')).toHaveValue('read_only')
    expect(screen.getByLabelText('输出要求')).toHaveValue('回报 verdict')
    expect(screen.queryByLabelText('第 1 条的角色场景')).toBeNull()
  })

  it('编辑一个：设为默认时别的取消默认，只换掉这一个，整组保存', async () => {
    const bodies = backend((items) => new Response(JSON.stringify({ data: items }), { status: 200 }))
    renderIt('/settings/run-prompts/rp_dev')
    const content = await screen.findByLabelText('执行要求')
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toBeDisabled()
    await userEvent.click(screen.getByRole('checkbox', { name: '默认' }))
    await userEvent.type(content, ' 再补单测')
    await userEvent.click(save)
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].map((p) => [p.id, p.default])).toEqual([['rp_pm', false], ['rp_dev', true], ['rp_review', false]])
    expect(bodies[0][1].content).toBe('按验收标准改代码，跑通测试后提交。 再补单测')
    // 别的角色原样，旧数据补默认字段
    expect(bodies[0][2]).toMatchObject({ permission: 'read_only', output: '回报 verdict', dir_kind: 'code' })
    expect(await screen.findByRole('status')).toHaveTextContent('已保存')
  })

  it('新建：接在末尾，id 留空由后端补，建好后转到它的编辑页；空的、重名的先挡', async () => {
    const bodies = backend((items) => new Response(JSON.stringify({ data: items.map((p, i) => ({ ...p, id: p.id || `rp_new${i}` })) }), { status: 200 }))
    const router = renderIt()
    await userEvent.click(await screen.findByRole('button', { name: '新建角色' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/run-prompts/new'))
    await userEvent.click(await screen.findByRole('button', { name: '建好' }))
    expect(screen.getByText('写一个角色场景')).toBeInTheDocument()
    expect(bodies).toHaveLength(0)
    await userEvent.type(screen.getByLabelText('角色场景'), '研发开发')
    expect(screen.getByText('和上面的重复了')).toBeInTheDocument()
    await userEvent.clear(screen.getByLabelText('角色场景'))
    await userEvent.type(screen.getByLabelText('角色场景'), ' 视频博主 ')
    await userEvent.type(screen.getByLabelText('执行要求'), '按口播稿做演示页')
    await userEvent.selectOptions(screen.getByLabelText('权限'), 'read_only')
    await userEvent.selectOptions(screen.getByLabelText('默认目录'), 'prototype')
    await userEvent.click(screen.getByRole('button', { name: '建好' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].map((p) => [p.id, p.scene])).toEqual([['rp_pm', '产品经理工作台'], ['rp_dev', '研发开发'], ['rp_review', '研发评审'], ['', '视频博主']])
    expect(bodies[0][3]).toMatchObject({ permission: 'read_only', dir_kind: 'prototype' })
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/run-prompts/rp_new3'))
  })

  it('删除要确认，删完回列表；后端 400 显示它的 message', async () => {
    let fail = true
    const bodies = backend((items) => (fail
      ? new Response(JSON.stringify({ error: { code: 'validation', message: '只能有一个默认角色' } }), { status: 400 })
      : new Response(JSON.stringify({ data: items }), { status: 200 })))
    const router = renderIt('/settings/run-prompts/rp_dev')
    await userEvent.click(await screen.findByRole('button', { name: '删除角色' }))
    await userEvent.click(screen.getByRole('button', { name: '确认删除' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('没删掉：只能有一个默认角色')
    fail = false
    await userEvent.click(screen.getByRole('button', { name: '删除角色' }))
    await userEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/run-prompts'))
    expect(bodies.at(-1)!.map((p) => p.id)).toEqual(['rp_pm', 'rp_review'])
  })

  it('不存在的角色给回列表的入口', async () => {
    backend(() => new Response('{}', { status: 500 }))
    renderIt('/settings/run-prompts/rp_gone')
    expect(await screen.findByText('这个角色不存在或已删除')).toBeInTheDocument()
  })
})
