import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { DictItem, ObjectStatus, WorkObject } from '../../core/api'
import { OPEN, type StatusFilter } from './model'
import { TaskList, type TaskView } from './TaskList'

const statuses: ObjectStatus[] = [
  { key: 'todo', label: '待办', color: 'gray', terminal: false },
  { key: 'review', label: '待验收', color: 'purple', terminal: false },
  { key: 'done', label: '已完成', color: 'green', terminal: true },
  { key: 'cancelled', label: '已取消', color: 'gray', terminal: true },
]
const priorities = [
  { key: 'P0', label: '最高', color: 'red', sort_order: 10, archived_at: null, description: '' },
  { key: 'P2', label: '中', color: 'orange', sort_order: 30, archived_at: null, description: '' },
] as DictItem[]
const now = new Date(2026, 9, 28, 15)
const due = (d: string) => new Date(`${d}T23:59:59`).toISOString()

let seq = 0
function task(p: Partial<WorkObject>): WorkObject {
  seq += 1
  return {
    id: 'obj_' + seq, type_id: 'task', ref: `TSK-${String(seq).padStart(4, '0')}`, title: '任务 ' + seq, body: '', status: 'todo',
    priority: 'P2', owner: '', owner_id: null, category_id: null, project_id: null, source: '', props: null, workdir: '',
    due_at: null, started_at: null, completed_at: null, archived_at: null, deleted_at: null,
    created_at: now.toISOString(), updated_at: now.toISOString(), tags: [], link_count: 0, participants: [], ...p,
  }
}

function Harness({ tasks, view = 'all', onOpen = () => {} }: { tasks: WorkObject[]; view?: TaskView; onOpen?: (t: WorkObject) => void }) {
  const [status, setStatus] = useState<StatusFilter>(OPEN)
  const [search, setSearch] = useState('')
  return (
    <TaskList view={view} tasks={tasks} statuses={statuses} priorities={priorities} projects={[]}
      status={status} onStatus={setStatus} search={search} onSearch={setSearch} q={search}
      selected={null} onOpen={onOpen} onNew={() => {}} now={now} />
  )
}

const rowsIn = (group: HTMLElement) => within(group).queryAllByRole('button', { name: /^TSK-/ })

describe('任务列表', () => {
  it('按截止日分段，状态和优先级的名字来自传进来的状态表和字典', () => {
    render(<Harness tasks={[
      task({ title: '逾期的待验收', status: 'review', due_at: due('2026-10-20'), priority: 'P0' }),
      task({ title: '今天的', due_at: due('2026-10-28') }),
      task({ title: '没截止的' }),
      task({ title: '做完的', status: 'done' }),
    ]} />)
    const groups = screen.getAllByRole('group').filter((g) => g.getAttribute('aria-label') !== '状态')
    // 默认「未完成」，已结束的段不出现
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['逾期', '今天', '无截止'])
    const overdue = screen.getByRole('group', { name: '逾期' })
    expect(within(overdue).getByText('逾期的待验收')).toBeInTheDocument()
    expect(within(overdue).getByText('待验收')).toBeInTheDocument()
    expect(within(overdue).getByText('最高')).toBeInTheDocument()
    expect(within(overdue).getByText('10-20 逾期')).toBeInTheDocument()
  })

  it('状态按钮带条数，点「全部」出现已结束段，点「待验收」只剩待验收', async () => {
    const user = userEvent.setup()
    render(<Harness tasks={[task({ status: 'review' }), task({}), task({ status: 'done' }), task({ status: 'cancelled' })]} />)
    const bar = screen.getByRole('group', { name: '状态' })
    // 已取消不单独占按钮
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(['未完成2', '待办1', '待验收1', '已完成1', '全部4'])
    await user.click(within(bar).getByRole('button', { name: /^全部/ }))
    expect(rowsIn(screen.getByRole('group', { name: '已结束' }))).toHaveLength(2)
    await user.click(within(bar).getByRole('button', { name: /^待验收/ }))
    expect(screen.getAllByRole('button', { name: /^TSK-/ })).toHaveLength(1)
  })

  it('一段超过 30 条时露 30 条，段尾「这一段还有 N 条」点了多露', async () => {
    const user = userEvent.setup()
    render(<Harness tasks={Array.from({ length: 145 }, () => task({}))} />)
    const group = screen.getByRole('group', { name: '无截止' })
    expect(rowsIn(group)).toHaveLength(30)
    await user.click(within(group).getByRole('button', { name: '这一段还有 115 条' }))
    expect(rowsIn(group)).toHaveLength(130)
    await user.click(within(group).getByRole('button', { name: '这一段还有 15 条' }))
    expect(rowsIn(group)).toHaveLength(145)
    expect(within(group).queryByText(/这一段还有/)).toBeNull()
  })

  it('换了状态筛选，各段重新只露 30 条', async () => {
    const user = userEvent.setup()
    render(<Harness tasks={Array.from({ length: 40 }, () => task({}))} />)
    await user.click(screen.getByRole('button', { name: '这一段还有 10 条' }))
    expect(rowsIn(screen.getByRole('group', { name: '无截止' }))).toHaveLength(40)
    const bar = screen.getByRole('group', { name: '状态' })
    await user.click(within(bar).getByRole('button', { name: /^全部/ }))
    expect(rowsIn(screen.getByRole('group', { name: '无截止' }))).toHaveLength(30)
  })

  it('段标题点击折叠', async () => {
    const user = userEvent.setup()
    render(<Harness tasks={[task({}), task({})]} />)
    const head = screen.getByRole('button', { name: /无截止/ })
    await user.click(head)
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryAllByRole('button', { name: /^TSK-/ })).toHaveLength(0)
  })

  it('点一行回调 onOpen', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    const t = task({ title: '点我' })
    render(<Harness tasks={[t]} onOpen={onOpen} />)
    await user.click(screen.getByText('点我'))
    expect(onOpen).toHaveBeenCalledWith(t)
  })

  it('空状态：逾期视图、只是状态筛选没结果、搜索没结果', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<Harness view="overdue" tasks={[]} />)
    expect(screen.getByText('没有逾期的任务')).toBeInTheDocument()
    unmount()
    const second = render(<Harness tasks={[task({})]} />)
    await user.click(screen.getByRole('button', { name: /^待验收/ }))
    expect(screen.getByText('没有处于该状态的任务')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '切回「未完成」' }))
    expect(screen.getAllByRole('button', { name: /^TSK-/ })).toHaveLength(1)
    second.unmount()
    // 后端按 q 过滤后为空
    render(<Harness tasks={[]} />)
    await user.type(screen.getByRole('searchbox', { name: '搜索任务' }), 'zz')
    expect(screen.getByText('没有匹配的任务')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '清掉筛选条件' }))
    expect(screen.getByRole('searchbox', { name: '搜索任务' })).toHaveValue('')
  })

  it('加载失败时显示错误和重试，状态按钮不带条数', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    render(<TaskList view="all" tasks={[]} error={new Error('连不上')} onRetry={onRetry} statuses={statuses} priorities={priorities}
      projects={[]} status={OPEN} onStatus={() => {}} search="" onSearch={() => {}} q="" selected={null}
      onOpen={() => {}} onNew={() => {}} now={now} />)
    expect(screen.getByRole('alert')).toHaveTextContent('连不上')
    expect(within(screen.getByRole('group', { name: '状态' })).getByRole('button', { name: '未完成' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalled()
  })
})
