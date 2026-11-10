// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 产出结果（SPEC-sessions-3、B-08）：同一次提交登记到多个任务时合并成一行，点「N 个任务」展开。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Artifact } from '../../core/data'
import { OutputsView } from './OutputsView'

const art = (id: string, over: Partial<Artifact> = {}): Artifact => ({
  id, object_id: null, session_id: null, run_id: null, title: '', path: '/p', base_dir: '', url: '', platform: 'local', size: 0,
  source: 'mcp', note: '', created_at: new Date().toISOString(), updated_at: '', rel_path: '/p', kind: '', display_kind: 'other', ...over,
})
const commit = (id: string, obj: string) => art(id, {
  title: '第三十七批提交', note: '[commit] sha=995ce6e branch=b repo=/r', object_id: 'obj_' + obj, object_ref: 'TSK-' + obj, object_title: '任务标题 ' + obj,
})
const ARTS = [commit('a1', '1'), commit('a2', '2'), commit('a3', '3'), art('f1', { title: '周报.md', object_id: 'obj_9', object_ref: 'TSK-9', object_title: '写周报' })]

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const u = new URL(String(input), 'http://x')
    const data = u.pathname === '/api/artifacts' ? ARTS : []
    return new Response(JSON.stringify({ data, meta: { total: data.length } }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('产出结果按提交合并', () => {
  it('同一提交一行，显示提交号和说明；来源是涉及的任务数，点开列出任务', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(<QueryClientProvider client={client}><OutputsView onOpenSession={vi.fn()} /></QueryClientProvider>)
    const btn = await screen.findByRole('button', { name: /3 个任务/ })
    expect(container.querySelectorAll('.output-row[data-artifact]')).toHaveLength(2)
    expect(screen.getByText('995ce6e')).toBeTruthy()
    // 类型条数按合并后的行算
    expect(screen.getByRole('tab', { name: /全部/ }).textContent).toBe('全部2')
    expect(screen.queryByRole('list', { name: '涉及的任务' })).toBeNull()
    await userEvent.click(btn)
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    const list = screen.getByRole('list', { name: '涉及的任务' })
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['TSK-1任务标题 1', 'TSK-2任务标题 2', 'TSK-3任务标题 3'])
    // 只有一个任务的照旧显示任务编号和标题
    expect(screen.getByText('TSK-9 写周报')).toBeTruthy()
    await userEvent.click(btn)
    expect(screen.queryByRole('list', { name: '涉及的任务' })).toBeNull()
  })
})
