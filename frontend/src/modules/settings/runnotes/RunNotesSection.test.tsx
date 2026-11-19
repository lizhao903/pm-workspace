// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置「快捷说明」（SPEC-settings-32）：整组编辑、排顺序、保存；前端先挡空的、重复的、超长的，后端 400 时显示它的 message
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunQuickNote } from '../../../core/data'
import { RunNotesSection } from './RunNotesSection'
import { noteIssues } from './notesModel'

const seed: RunQuickNote[] = [
  { label: '整理需求及原型', text: '整理需求及对应原型' },
  { label: '只读调研', text: '只读调研，不改代码' },
]

function backend(fail?: string) {
  const bodies: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const b = JSON.parse(String(init.body)) as { items: RunQuickNote[] }
      bodies.push(b)
      if (fail) return new Response(JSON.stringify({ error: { code: 'validation', message: fail } }), { status: 400 })
      return new Response(JSON.stringify({ data: b.items }), { status: 200 })
    }
    return new Response(JSON.stringify({ data: seed }), { status: 200 })
  }))
  return bodies
}

function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/settings/run-quick-notes']}><RunNotesSection /></MemoryRouter></QueryClientProvider>)
}

afterEach(() => vi.unstubAllGlobals())

describe('快捷说明的校验', () => {
  it('名称、文字必填，名称不重复、按字数限长', () => {
    expect(noteIssues([{ label: ' ', text: '' }])).toEqual([{ label: '写一个名称', text: '写上要填进附加说明的文字' }])
    expect(noteIssues([{ label: 'a', text: 'x' }, { label: 'a ', text: 'y' }])[1].label).toBe('和上面的重复了')
    expect(noteIssues([{ label: '一二三四五六七八九十一二', text: 'x' }])[0].label).toBe('')
    expect(noteIssues([{ label: '一二三四五六七八九十一二三', text: 'x' }])[0].label).toBe('最多 12 字')
  })
})

describe('设置「快捷说明」', () => {
  it('改一条、加一条、调顺序后整组保存', async () => {
    const bodies = backend()
    renderIt()
    const user = userEvent.setup()
    const first = await screen.findByRole('group', { name: '第 1 条' })
    expect(within(first).getByRole('textbox', { name: '名称' })).toHaveValue('整理需求及原型')
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '加一条' }))
    const third = screen.getByRole('group', { name: '第 3 条' })
    // 空的不能存，逐格说缺什么
    expect(within(third).getByText('写一个名称')).toBeInTheDocument()
    expect(save).toBeDisabled()
    await user.type(within(third).getByRole('textbox', { name: '名称' }), '修复并补测试')
    await user.type(within(third).getByRole('textbox', { name: '文字' }), '修复并补上测试')
    await user.click(within(third).getByRole('button', { name: '上移' }))
    await user.click(save)
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ items: [seed[0], { label: '修复并补测试', text: '修复并补上测试' }, seed[1]] })
    expect(await screen.findByRole('status')).toHaveTextContent('已保存：3 条快捷说明')
  })

  it('全删了保存就是不要快捷说明；后端拒绝时显示原因', async () => {
    const bodies = backend('快捷说明最多 20 条')
    renderIt()
    const user = userEvent.setup()
    await screen.findByRole('group', { name: '第 1 条' })
    while (screen.queryByRole('group', { name: '第 1 条' })) {
      await user.click(within(screen.getByRole('group', { name: '第 1 条' })).getByRole('button', { name: '删除' }))
    }
    expect(screen.getByText('还没有快捷说明')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(bodies).toEqual([{ items: [] }]))
    expect(await screen.findByRole('alert')).toHaveTextContent('没保存：快捷说明最多 20 条')
  })
})
