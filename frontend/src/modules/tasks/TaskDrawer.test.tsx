import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ObjectStatus, Progress, WorkObject } from '../../core/data'
import { acceptanceItems } from './mdParse'
import { TaskDrawer } from './TaskDrawer'

const statuses: ObjectStatus[] = [
  { key: 'todo', label: '待办', color: '', terminal: false },
  { key: 'doing', label: '进行中', color: '', terminal: false },
  { key: 'review', label: '待验收', color: '', terminal: false },
  { key: 'done', label: '已完成', color: '', terminal: true },
]
const at = new Date(Date.now() - 3600_000).toISOString()

function task(p: Partial<WorkObject> = {}): WorkObject {
  return {
    id: 'obj_0001', type_id: 'task', ref: 'TSK-0001', title: '导出改成分批写', body: '## 背景\n\n超时', status: 'review', priority: '', owner: '',
    owner_id: null, category_id: null, project_id: null, source: '', props: { acceptance: '- [ ] 导出不再超时\n- [ ] 前端提示进度' },
    workdir: '', due_at: null, started_at: null, completed_at: null, archived_at: null, deleted_at: null, created_at: at, updated_at: at,
    tags: [], link_count: 0, participants: [], ...p,
  }
}
const review: Progress = {
  id: 'pg_2', object_id: 'obj_0001', kind: 'review', text: '改了服务端分批写\n\n### 测试结果\ngo test ./... 通过',
  commits: ['abc1234def5678'], files: ['a.go'], status: 'review', actor: 'claude-code', actor_name: 'claude-code',
  session_id: 'sess-1234abcd', source: 'mcp', created_at: at,
}

function stub(t: WorkObject) {
  const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
  const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    if (u.pathname.endsWith('/progress')) return json([review])
    if (u.pathname === `/api/objects/${t.id}`) return json(t)
    if (u.pathname === '/api/object-types') return json([{ id: 'task', name: '任务', statuses }])
    if (u.pathname.startsWith('/api/agent/workdir')) return json({ path: '', exists: false, is_dir: false, writable: false, message: '' })
    return json([])
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function open(t: WorkObject) {
  const fn = stub(t)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TaskDrawer task={t} statuses={statuses} priorities={[]} projects={[]} onClose={() => {}} onCreated={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { drawer: screen.getByRole('dialog'), fn }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('验收标准清单', () => {
  it('有 [ ] 写法只取清单项，否则取所有列表项', () => {
    expect(acceptanceItems('说明\n- [ ] 一\n- [x] 二\n- 备注')).toEqual(['一', '二'])
    expect(acceptanceItems('- 一\n1. 二')).toEqual(['一', '二'])
    expect(acceptanceItems('')).toEqual([])
  })
})

describe('待验收的任务抽屉', () => {
  it('顶上是提交说明、测试结果、提交号和验收标准清单，再是改动、产出物、进展，任务字段收进「编辑任务」', async () => {
    const { drawer } = open(task())
    const bar = within(drawer).getByRole('region', { name: '等你验收' })
    expect(await within(bar).findByText('改了服务端分批写')).toBeInTheDocument()
    expect(within(bar).getByRole('heading', { name: '测试结果' })).toBeInTheDocument()
    expect(within(bar).getByText('abc1234def')).toBeInTheDocument()
    const checks = within(bar).getByRole('group', { name: '对照验收标准' })
    expect(within(checks).getAllByRole('checkbox').map((c) => c.parentElement?.textContent)).toEqual(['导出不再超时', '前端提示进度'])

    // 区块顺序
    const order = [bar, ...['改动', '产出物', '进展'].map((n) => within(drawer).getByRole('region', { name: n }))]
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }

    // 字段默认收起
    expect(within(drawer).queryByRole('radiogroup', { name: '状态' })).not.toBeInTheDocument()
    const toggle = within(drawer).getByRole('button', { name: /编辑任务/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(order[3].compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await userEvent.click(toggle)
    expect(within(drawer).getByRole('radiogroup', { name: '状态' })).toBeInTheDocument()
    expect(within(drawer).getByDisplayValue('导出改成分批写')).toBeInTheDocument()
    // 正文默认预览
    const bodyMode = within(drawer).getByRole('group', { name: '正文的显示方式' })
    expect(within(bodyMode).getByRole('button', { name: '预览' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(drawer).getByRole('heading', { name: '背景' })).toBeInTheDocument()
  })

  it('勾选只在本地，不发请求', async () => {
    const { drawer, fn } = open(task())
    const bar = within(drawer).getByRole('region', { name: '等你验收' })
    const box = within(bar).getAllByRole('checkbox')[0]
    const before = fn.mock.calls.length
    await userEvent.click(box)
    expect(box).toBeChecked()
    expect(within(bar).getByText(/已勾 1 \/ 2/)).toBeInTheDocument()
    expect(fn.mock.calls.slice(before).some(([, init]) => init?.method && init.method !== 'GET')).toBe(false)
  })

  it('不是待验收的任务照旧：字段在前，没有「编辑任务」', async () => {
    const { drawer } = open(task({ status: 'doing' }))
    expect(within(drawer).getByRole('radiogroup', { name: '状态' })).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: /编辑任务/ })).not.toBeInTheDocument()
    expect(within(drawer).queryByRole('region', { name: '等你验收' })).not.toBeInTheDocument()
    const bodyMode = within(drawer).getByRole('group', { name: '正文的显示方式' })
    expect(within(bodyMode).getByRole('button', { name: '编辑' })).toHaveAttribute('aria-pressed', 'true')
  })
})
