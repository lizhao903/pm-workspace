// 设置「角色」（SPEC-settings-24，AUTO-03）：改场景、执行要求、权限、默认目录、输出要求，单选默认、删、加，整组保存；前端先挡空的和重复的，400 显示后端的话
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
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

function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><RunPresetsSection /></QueryClientProvider>)
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
  it('改默认、加一条，整组保存（新条目 id 留空，去掉首尾空白）', async () => {
    const bodies = backend((items) => new Response(JSON.stringify({ data: items.map((p, i) => ({ ...p, id: p.id || `rp_new${i}` })) }), { status: 200 }))
    renderIt()
    expect(await screen.findByLabelText('第 1 条的角色场景')).toHaveValue('产品经理工作台')
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toBeDisabled()
    await userEvent.click(screen.getAllByRole('checkbox', { name: '默认' })[1])
    expect(screen.getByLabelText('第 3 条的权限')).toHaveValue('read_only')
    expect(screen.getByLabelText('第 3 条的输出要求')).toHaveValue('回报 verdict')
    await userEvent.click(screen.getByRole('button', { name: '加一个角色' }))
    await userEvent.type(screen.getByLabelText('第 4 条的角色场景'), ' 视频博主 ')
    await userEvent.type(screen.getByLabelText('第 4 条的执行要求'), '按口播稿做演示页')
    await userEvent.selectOptions(screen.getByLabelText('第 4 条的权限'), 'read_only')
    await userEvent.selectOptions(screen.getByLabelText('第 4 条的默认目录'), 'prototype')
    await userEvent.type(screen.getByLabelText('第 4 条的输出要求'), ' 回报页数 ')
    await userEvent.click(save)
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].map((p) => [p.id, p.scene, p.default])).toEqual([['rp_pm', '产品经理工作台', false], ['rp_dev', '研发开发', true], ['rp_review', '研发评审', false], ['', '视频博主', false]])
    // 旧数据没带新字段的补默认；新加的带上选的值
    expect(bodies[0][0]).toMatchObject({ permission: 'accept_edits', output: '', dir_kind: 'any' })
    expect(bodies[0][2]).toMatchObject({ permission: 'read_only', output: '回报 verdict', dir_kind: 'code' })
    expect(bodies[0][3]).toMatchObject({ permission: 'read_only', output: '回报页数', dir_kind: 'prototype' })
    expect(await screen.findByRole('status')).toHaveTextContent('已保存：4 个角色')
  })

  it('空的先挡，保存不可点；删掉后能保存；后端 400 显示它的 message', async () => {
    const bodies = backend(() => new Response(JSON.stringify({ error: { code: 'validation', message: '只能有一个默认角色' } }), { status: 400 }))
    renderIt()
    await screen.findByLabelText('第 1 条的角色场景')
    await userEvent.click(screen.getByRole('button', { name: '加一个角色' }))
    expect(screen.getByText('写一个角色场景')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '删除「第 4 条」' }))
    await userEvent.click(screen.getByRole('button', { name: '删除「研发开发」' }))
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(await screen.findByRole('alert')).toHaveTextContent('没保存：只能有一个默认角色')
  })
})
