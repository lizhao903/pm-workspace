// 任务模块（SPEC-tasks-1、SPEC-tasks-2）：二级菜单 + 列表。路由挂在 tasks/* 下：
// /tasks 全部任务，/tasks/overdue 逾期；状态筛选记在 ?status=，可以直接链接到「待验收」这类视图。
import { useEffect, useState } from 'react'
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { useObjectTypes, type WorkObject } from '../../core/api'
import { useDictItems, useProjectOptions, useTaskCounts, useTaskList } from '../../core/api/tasks'
import { ErrorState, LoadingState, Subnav } from '../../core/ui'
import { OPEN, type StatusFilter } from './model'
import { TaskDrawerStub } from './TaskDrawerStub'
import { TaskList, type TaskView } from './TaskList'
import './tasks.css'

// 搜索词停手多久再发请求
const SEARCH_DELAY = 300
// 优先级字典的 id（/api/dictionaries）
const PRIORITY_DICT = 'priority'

const SUBPATH: Record<TaskView, string> = { all: '', overdue: 'overdue' }

type Opened = { kind: 'task'; task: WorkObject } | { kind: 'new' }

export default function Page() {
  const rest = useParams()['*'] ?? ''
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const view: TaskView | null = rest === '' ? 'all' : rest === 'overdue' ? 'overdue' : null
  // 模块根路径：去掉子路径，模块以后挂到别的路径下也不用改
  const root = pathname.slice(0, pathname.length - rest.length).replace(/\/+$/, '')

  const status: StatusFilter = params.get('status') || OPEN
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [opened, setOpened] = useState<Opened | null>(null)

  useEffect(() => {
    const kw = search.trim()
    if (kw === q) return
    const id = setTimeout(() => setQ(kw), SEARCH_DELAY)
    return () => clearTimeout(id)
  }, [search, q])

  const types = useObjectTypes()
  const prios = useDictItems(PRIORITY_DICT)
  const projects = useProjectOptions()
  const counts = useTaskCounts()
  const list = useTaskList({ q, overdue: view === 'overdue' })

  if (view === null) return <Navigate to={root} replace />

  const taskType = types.data?.find((t) => t.id === 'task')
  const statuses = taskType?.statuses ?? []
  const overdueN = counts.data?.overdue

  const selectView = (v: TaskView) => {
    setOpened(null)
    navigate(SUBPATH[v] ? `${root}/${SUBPATH[v]}` : root)
  }
  const setStatus = (f: StatusFilter) => {
    const next = new URLSearchParams(params)
    if (f === OPEN) next.delete('status')
    else next.set('status', f)
    setParams(next, { replace: true })
  }

  let main
  if (types.isError) main = <ErrorState title="任务类型加载失败" error={types.error} onRetry={() => void types.refetch()} />
  else if (types.isPending) main = <LoadingState />
  else if (!taskType) main = <ErrorState title="后端没有任务类型" error="/api/object-types 里找不到 id 为 task 的类型" />
  else {
    // 当前打开的任务以列表里的最新数据为准，不在列表里（被筛掉了）就用打开时的那份
    const sel = opened?.kind === 'task' ? opened.task.id : null
    main = (
      <TaskList
        // 换视图时折叠、多露条数、优先级和项目筛选都重新来：逾期视图只有一段，沿用全部任务里的折叠会整页空掉
        key={view}
        view={view}
        tasks={list.data?.data ?? []}
        loading={list.isPending}
        error={list.isError ? list.error : undefined}
        onRetry={() => void list.refetch()}
        statuses={statuses}
        priorities={prios.data ?? []}
        projects={(projects.data?.data ?? []).map((p) => ({ id: p.id, title: p.title }))}
        status={status}
        onStatus={setStatus}
        search={search}
        onSearch={setSearch}
        q={q}
        selected={sel}
        onOpen={(t) => setOpened({ kind: 'task', task: t })}
        onNew={() => setOpened({ kind: 'new' })}
      />
    )
  }

  const openTask = opened?.kind === 'task'
    ? list.data?.data.find((t) => t.id === opened.task.id) ?? opened.task
    : null

  return (
    <div className="tasks-mod">
      <Subnav<TaskView> title="任务" active={view} onSelect={selectView} items={[
        { key: 'all', label: '全部任务', group: '视图' },
        {
          key: 'overdue', label: '逾期', group: '视图',
          // 计数没取到时不显示数字，也不能显示成「没有逾期」
          desc: overdueN === undefined ? undefined : overdueN ? `${overdueN} 条过了截止日还没完成` : '没有逾期的任务',
          alert: overdueN ?? 0,
        },
      ]} />
      <div className="tasks-body">{main}</div>
      <TaskDrawerStub
        open={!!opened}
        task={openTask}
        statuses={statuses}
        priorities={prios.data ?? []}
        onClose={() => setOpened(null)}
      />
    </div>
  )
}
