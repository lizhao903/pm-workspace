import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { DictItem, ObjectStatus, WorkObject } from '../../core/data'
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

const people = [{ id: 'stk_me', name: '张三' }, { id: 'stk_cc', name: 'Claude Code' }]

function Harness({ tasks, view = 'all', onOpen = () => {} }: { tasks: WorkObject[]; view?: TaskView; onOpen?: (t: WorkObject) => void }) {
  const [status, setStatus] = useState<StatusFilter>(OPEN)
  const [search, setSearch] = useState('')
  return (
    <TaskList view={view} tasks={tasks} statuses={statuses} priorities={priorities} projects={[]} people={people}
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
    // 优先级显示编号加名称，都从字典读
    expect(within(overdue).getByText('P0 最高')).toBeInTheDocument()
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
    // 搜索在本地匹配，没有命中
    render(<Harness tasks={[]} />)
    await user.type(screen.getByRole('searchbox', { name: '搜索任务' }), 'zz')
    expect(screen.getByText('没有匹配的任务')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '清掉筛选条件' }))
    expect(screen.getByRole('searchbox', { name: '搜索任务' })).toHaveValue('')
  })

  it('已结束按完成时间倒序，无截止按最近更新；排序下拉换成创建时间', async () => {
    const user = userEvent.setup()
    const at = (d: string) => `2026-10-${d}T10:00:00Z`
    render(<Harness tasks={[
      task({ title: '早完成', status: 'done', completed_at: at('10') }),
      task({ title: '刚完成', status: 'done', completed_at: at('27') }),
      task({ title: '早建晚改', created_at: at('01'), updated_at: at('26') }),
      task({ title: '晚建早改', created_at: at('20'), updated_at: at('21') }),
    ]} />)
    const titles = (name: string) => rowsIn(screen.getByRole('group', { name })).map((r) => r.querySelector('.ellipsis')?.textContent)
    expect(titles('无截止')).toEqual(['早建晚改', '晚建早改'])
    await user.click(screen.getByRole('button', { name: /^全部/ }))
    expect(titles('已结束')).toEqual(['刚完成', '早完成'])
    await user.selectOptions(screen.getByRole('combobox', { name: '排序' }), '创建时间')
    expect(titles('无截止')).toEqual(['晚建早改', '早建晚改'])
  })

  it('负责人筛选：未分配、我（先选是哪位干系人）、具体的人；搜索搜得到负责人名', async () => {
    localStorage.removeItem('pmw-tasks-me')
    const user = userEvent.setup()
    render(<Harness tasks={[
      task({ title: '我的事', owner_id: 'stk_me', owner_name: '张三' }),
      task({ title: '开发任务', owner_id: 'stk_cc', owner_name: 'Claude Code' }),
      task({ title: '没人管' }),
    ]} />)
    const all = () => screen.queryAllByRole('button', { name: /^TSK-/ }).map((r) => r.querySelector('.ellipsis')?.textContent)
    const pickOwner = async (label: string) => {
      await user.click(screen.getByRole('button', { name: '负责人' }))
      await user.click(screen.getByRole('option', { name: new RegExp(label) }))
    }
    await pickOwner('未分配')
    expect(all()).toEqual(['没人管'])
    await pickOwner('^我')
    expect(screen.getByText('还没选你是哪位干系人')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '我是' }))
    await user.click(screen.getByRole('option', { name: '我是 张三' }))
    expect(all()).toEqual(['我的事'])
    expect(localStorage.getItem('pmw-tasks-me')).toBe('stk_me')
    await pickOwner('Claude Code')
    expect(all()).toEqual(['开发任务'])
    await user.click(screen.getByRole('button', { name: '负责人' }))
    await user.click(screen.getByRole('option', { name: '全部负责人' }))
    await user.type(screen.getByRole('searchbox', { name: '搜索任务' }), 'claude')
    expect(all()).toEqual(['开发任务'])
    localStorage.removeItem('pmw-tasks-me')
  })

  it('点完成圆圈不打开抽屉，悬停提示按状态区分', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    const onToggleDone = vi.fn()
    const rows = [task({ title: '普通' }), task({ title: '待验收的', status: 'review' })]
    render(<TaskList view="all" tasks={rows} statuses={statuses} priorities={priorities} projects={[]} status={OPEN}
      onStatus={() => {}} search="" onSearch={() => {}} q="" selected={null} onOpen={onOpen} onNew={() => {}}
      onToggleDone={onToggleDone} now={now} />)
    await user.click(screen.getByRole('button', { name: `标为已完成：${rows[0].ref}` }))
    await user.click(screen.getByRole('button', { name: `验收通过：${rows[1].ref}` }))
    expect(onToggleDone.mock.calls.map((c) => c[0].id)).toEqual([rows[0].id, rows[1].id])
    expect(onOpen).not.toHaveBeenCalled()
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
  it('抽屉开着时列表带窄列标记，标题仍在行里（C-01）', () => {
    const t = task({ title: '窄列也要看得到的标题' })
    const props = {
      view: 'all' as const, tasks: [t], statuses, priorities, projects: [], status: OPEN, onStatus: () => {},
      search: '', onSearch: () => {}, q: '', selected: t.id, onOpen: () => {}, onNew: () => {}, now,
    }
    const { container, rerender } = render(<TaskList {...props} />)
    expect(container.querySelector('.task-table')).not.toHaveClass('task-table-docked')
    rerender(<TaskList {...props} drawerOpen />)
    expect(container.querySelector('.task-table')).toHaveClass('task-table-docked')
    expect(screen.getByRole('button', { name: `${t.ref} ${t.title}` })).toHaveTextContent('窄列也要看得到的标题')
  })
})
