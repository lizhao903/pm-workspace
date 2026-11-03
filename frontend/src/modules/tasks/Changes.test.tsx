import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ObjectStatus, Progress, Revision, WorkObject } from '../../core/data'
import { groupRevisions } from '../../core/data'
import { ChangesPanel } from './Changes'
import { ReviewBar } from './ReviewBar'

const rev = (id: string, at: string, p: Partial<Revision> = {}): Revision => ({
  id, object_id: 'obj_1', field: 'status', old_value: 'todo', new_value: 'doing', actor: 'me', source: 'ui',
  created_at: at, actor_name: 'me', session_id: '', ...p,
})
const task = { id: 'obj_1', ref: 'TSK-0001', title: '任务', status: 'review', type_id: 'task' } as WorkObject
const statuses: ObjectStatus[] = [
  { key: 'todo', label: '待办', color: '', terminal: false },
  { key: 'doing', label: '进行中', color: '', terminal: false },
  { key: 'review', label: '待验收', color: '', terminal: false },
  { key: 'done', label: '已完成', color: '', terminal: true },
]

function stub(rows: { revisions?: Revision[]; progress?: Progress[] }) {
  const posts: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push(body)
      return new Response(JSON.stringify({ data: { id: 'rev_new', ...body } }), { status: 201 })
    }
    const data = url.includes('/revisions') ? rows.revisions ?? [] : url.includes('/progress') ? rows.progress ?? [] : {}
    return new Response(JSON.stringify({ data }), { status: 200 })
  }))
  return posts
}
const wrap = (el: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>)
}

afterEach(() => { vi.unstubAllGlobals() })

describe('改动分组', () => {
  it('按 session_id 分组，不相邻的同一会话也归一组；组按最近改动排，组内按时间顺序；没有会话的按操作者', () => {
    const rows = [
      rev('r4', '2026-10-28T10:04:00Z', { actor_name: 'claude-code', session_id: 'sess-a' }),
      rev('r3', '2026-10-28T10:03:00Z', { actor_name: 'claude-code', session_id: 'sess-b' }),
      rev('r2', '2026-10-28T10:02:00Z', { actor_name: 'claude-code', session_id: 'sess-a' }),
      rev('r1', '2026-10-28T10:01:00Z'),
    ]
    const g = groupRevisions(rows)
    expect(g.map((x) => x.session_id)).toEqual(['sess-a', 'sess-b', ''])
    expect(g[0].rows.map((r) => r.id)).toEqual(['r2', 'r4'])
    expect([g[0].first, g[0].last]).toEqual(['2026-10-28T10:02:00Z', '2026-10-28T10:04:00Z'])
    expect(g[2].actor_name).toBe('me')
  })

  it('面板每组显示操作者和会话；进展行不显示元数据 JSON', async () => {
    stub({ revisions: [
      rev('r2', '2026-10-28T10:02:00Z', { field: 'progress', old_value: '{"kind":"review","files":["a.go"]}', new_value: '做完了', actor_name: 'claude-code', session_id: 'sess-bbbbbbbb' }),
      rev('r1', '2026-10-28T10:01:00Z', { actor_name: 'claude-code', session_id: 'sess-aaaaaaaa' }),
    ] })
    wrap(<ChangesPanel task={task} />)
    expect(await screen.findByText('提交验收：做完了')).toBeInTheDocument()
    expect(screen.queryByText(/files/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制会话 id sess-bbbbbbbb' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制会话 id sess-aaaaaaaa' })).toBeInTheDocument()
    expect(screen.getByText('status 从 todo 改成 doing')).toBeInTheDocument()
  })
})

describe('验收和退回', () => {
  it('退回不填意见提交不了；填了发 kind=note、status 回初始状态', async () => {
    const posts = stub({})
    const onReviewed = vi.fn()
    wrap(<ReviewBar task={task} statuses={statuses} onReviewed={onReviewed} />)
    const bar = screen.getByRole('region', { name: '等你验收' })
    await userEvent.click(within(bar).getByRole('button', { name: '退回' }))
    await userEvent.click(within(bar).getByRole('button', { name: '确认退回' }))
    expect(within(bar).getByText('写一下退回原因')).toBeInTheDocument()
    expect(posts).toHaveLength(0)
    await userEvent.type(within(bar).getByRole('textbox', { name: '退回意见' }), '排序不对')
    await userEvent.click(within(bar).getByRole('button', { name: '确认退回' }))
    await vi.waitFor(() => expect(onReviewed).toHaveBeenCalledWith('todo'))
    expect(posts).toEqual([{ kind: 'note', text: '退回：排序不对', status: 'todo' }])
  })

  it('验收通过意见可选，和完成圆圈同一个请求', async () => {
    const posts = stub({})
    const onReviewed = vi.fn()
    wrap(<ReviewBar task={task} statuses={statuses} onReviewed={onReviewed} />)
    await userEvent.click(screen.getByRole('button', { name: '验收通过' }))
    await userEvent.click(screen.getByRole('button', { name: '确认验收通过' }))
    await vi.waitFor(() => expect(onReviewed).toHaveBeenCalledWith('done'))
    expect(posts).toEqual([{ kind: 'note', text: '验收通过', status: 'done' }])
  })
})
