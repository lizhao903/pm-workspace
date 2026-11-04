import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ObjectStatus, WorkObject } from '../../core/data'
import { StageBoard } from './StageBoard'

const statuses: ObjectStatus[] = [
  { key: 'todo', label: '待办', color: 'gray', terminal: false },
  { key: 'doing', label: '进行中', color: 'blue', terminal: false },
  { key: 'done', label: '已完成', color: 'green', terminal: true },
]

let seq = 0
function task(p: Partial<WorkObject>): WorkObject {
  seq += 1
  return {
    id: 'obj_' + seq, type_id: 'task', ref: `TSK-${seq}`, title: '任务 ' + seq, body: '', status: 'todo',
    priority: 'P2', owner: '', owner_id: null, category_id: null, project_id: null, source: '', props: null, workdir: '',
    due_at: null, started_at: null, completed_at: null, archived_at: null, deleted_at: null,
    created_at: '2026-11-04T00:00:00Z', updated_at: '2026-11-04T00:00:00Z', tags: [], link_count: 0, participants: [], ...p,
  }
}

function Harness({ tasks, onOpen = () => {} }: { tasks: WorkObject[]; onOpen?: (t: WorkObject) => void }) {
  const [search, setSearch] = useState('')
  return <StageBoard tasks={tasks} statuses={statuses} selected={null} onOpen={onOpen} search={search} onSearch={setSearch} q={search} />
}

function renderBoard(tasks: WorkObject[], onOpen?: (t: WorkObject) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><Harness tasks={tasks} onOpen={onOpen} /></QueryClientProvider>)
}

afterEach(() => { vi.unstubAllGlobals() })

const col = (label: string) => screen.getByRole('listitem', { name: new RegExp(`^${label} `) })

describe('阶段看板', () => {
  const lin = { contact_id: 'stk_lin', name: '林原', channel: 'slack', sender_id: 'U1' }
  const guest = { name: '访客', channel: 'slack', sender_id: 'U9', sender_name: '访客' }

  it('按阶段分列，卡片显示提出人和状态；未设阶段的默认不出列，勾上才出，已结束的不算', async () => {
    renderBoard([
      task({ title: '导出', status: 'doing', props: { stage: 'developing', requester: lin } }),
      task({ title: '加字段', props: { stage: 'clarifying', requester: guest } }),
      task({ title: '老任务' }),
      task({ title: '早就做完的', status: 'done' }),
    ])
    expect(within(col('开发中')).getByText('导出')).toBeInTheDocument()
    expect(within(col('开发中')).getByText('林原')).toBeInTheDocument()
    expect(within(col('开发中')).getByText('进行中')).toBeInTheDocument()
    expect(within(col('待澄清')).getByText('访客')).toBeInTheDocument()
    expect(screen.queryByText('老任务')).not.toBeInTheDocument()
    await userEvent.click(screen.getByLabelText(/显示未设阶段（1）/))
    expect(within(col('未设阶段')).getByText('老任务')).toBeInTheDocument()
    expect(within(col('未设阶段')).getByText('没有提出人')).toBeInTheDocument()
    // 没设阶段又已结束的老任务不进看板
    expect(screen.queryByText('早就做完的')).not.toBeInTheDocument()
  })

  it('按提出人筛选', async () => {
    renderBoard([
      task({ title: '导出', props: { stage: 'developing', requester: lin } }),
      task({ title: '加字段', props: { stage: 'clarifying', requester: guest } }),
    ])
    await userEvent.click(screen.getByRole('button', { name: '提出人' }))
    await userEvent.click(screen.getByRole('option', { name: /访客（slack）/ }))
    expect(screen.queryByText('导出')).not.toBeInTheDocument()
    expect(screen.getByText('加字段')).toBeInTheDocument()
  })

  it('卡片上改阶段走 PUT /stage，不打开抽屉；点卡片打开抽屉', async () => {
    const calls: { url: string; method?: string; body?: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, body: init?.body ? String(init.body) : undefined })
      return new Response(JSON.stringify({ data: task({ props: { stage: 'testing' } }) }), { status: 200 })
    }))
    const onOpen = vi.fn()
    const t = task({ title: '导出', props: { stage: 'developing', requester: lin } })
    renderBoard([t], onOpen)
    await userEvent.selectOptions(screen.getByLabelText(`改阶段：${t.ref}`), 'testing')
    expect(onOpen).not.toHaveBeenCalled()
    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.url).toContain(`/api/objects/${t.id}/stage`)
    expect(JSON.parse(put!.body!)).toEqual({ stage: 'testing' })
    await userEvent.click(screen.getByRole('button', { name: `${t.ref} 导出` }))
    expect(onOpen).toHaveBeenCalledWith(t)
  })

  it('有任务但都没设阶段：提示并给「显示未设阶段的任务」', async () => {
    renderBoard([task({ title: '老任务' })])
    expect(screen.getByText('还没有任务进入流程')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '显示未设阶段的任务' }))
    expect(screen.getByText('老任务')).toBeInTheDocument()
  })
})
