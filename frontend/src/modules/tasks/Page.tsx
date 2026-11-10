// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 任务模块（SPEC-tasks-1、SPEC-tasks-2）：二级菜单 + 列表。路由挂在 tasks/* 下：
// /tasks 全部任务，/tasks/overdue 逾期；状态筛选记在 ?status=，可以直接链接到「待验收」这类视图；?t=<id> 打开某条任务的抽屉。
// 抽屉的标签记在 ?tab=，?run= / ?sop_run= 定位某次执行（drawerTabs.ts）；从列表换一条任务、新建时清掉，新打开的从默认标签开始。
// /tasks/board 阶段看板（AUTO-05，SPEC-tasks-11）：按 props.stage 分列、按提出人筛。
// /tasks/outputs 产出物（TSK-0497，SPEC-tasks-12）：按任务汇总的产出物清单，和看板一样是「视图」组里的一项，不另起菜单。
// /tasks/schedules 定时任务（SPEC-tasks-7、8，TASK-04a），二级菜单「自动化」组。
// 来源分类视图已去掉，旧链接 /tasks/source/<来源> 回到全部任务；/tasks/webhooks Webhook 接入、/tasks/webhooks/<id|new> 配置页（SPEC-tasks-9、10，TASK-04b）。
import { useEffect, useMemo, useState } from 'react'
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import {
  useAgents, useApprove, useDictItems, useLastDeliveries, useObject, useObjectTypes, useSetStatus, useStakeholders, useWebhooks, type WorkObject,
} from '../../core/data'
import { Button, ErrorState, InSubnavHost, LoadingState, Subnav, type SubnavItem } from '../../core/ui'
import { timeAgo } from './model'
import { ARTIFACT_KIND_DICT, useProjectOptions, useTaskCounts, useTaskList, useTaskOutputs } from './queries'
import { ApproveDialog } from './ApproveDialog'
import { OPEN, REVIEW, doneKey, reopenKey, terminalOf, type StatusFilter } from './model'
import { SchedulesView } from './Schedules'
import { TaskDrawer } from './TaskDrawer'
import { FOCUS_ARTIFACTS, FOCUS_PARAM, useTaskTabParams } from './drawerTabs'
import { TaskList, type TaskView } from './TaskList'
import { StageBoard } from './StageBoard'
import { OutputsView } from './Outputs'
import { kindTable } from './outputSummary'
import { PIPELINE_TAB } from './stageModel'
import { LAST_DELIVERY_POLL_MS, WebhooksView } from './Webhooks'
import { isFailing, recentHooks } from './webhookModel'
import './tasks.css'

// 搜索词停手多久再发请求
const SEARCH_DELAY = 300
// 优先级字典的 id（/api/dictionaries）
const PRIORITY_DICT = 'priority'

type View = TaskView | 'board' | 'outputs' | 'schedules' | 'hooks' | `hook:${string}`

const isHookView = (v: View): v is `hook:${string}` => v.startsWith('hook:')

/** 子路径和视图互转；hook:new 是新建 Webhook */
function viewOf(rest: string): View | null {
  if (rest === '') return 'all'
  if (rest === 'overdue' || rest === 'schedules' || rest === 'board' || rest === 'outputs') return rest
  if (rest === 'webhooks') return 'hooks'
  const [a, b, ...more] = rest.split('/')
  if (more.length || !b) return null
  if (a === 'webhooks') return `hook:${b}`
  return null
}
function subpath(v: View): string {
  if (v === 'all') return ''
  if (v === 'overdue' || v === 'schedules' || v === 'board' || v === 'outputs') return v
  if (v === 'hooks') return 'webhooks'
  return `webhooks/${encodeURIComponent(v.slice(5))}`
}

type Opened = { kind: 'task'; task: WorkObject } | { kind: 'new' }

export default function Page() {
  const rest = useParams()['*'] ?? ''
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const view = viewOf(rest)
  // 模块根路径：去掉子路径，模块以后挂到别的路径下也不用改
  const root = pathname.slice(0, pathname.length - rest.length).replace(/\/+$/, '')

  const status: StatusFilter = params.get('status') || OPEN
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [opened, setOpened] = useState<Opened | null>(null)
  // 待验收任务点完成圆圈时的确认
  const [approving, setApproving] = useState<WorkObject | null>(null)
  const setTaskStatus = useSetStatus()
  const drawerTab = useTaskTabParams()
  const approve = useApprove()

  // 命令面板打开某条任务（A-01）：?t=<id>，取到就打开抽屉，再把参数从地址里去掉
  const linkId = params.get('t')
  const linked = useObject(linkId)
  // 取到就在渲染时打开（随输入调整状态的写法），同一个 id 只开一次
  const [linkSeen, setLinkSeen] = useState<string | null>(null)
  if (linkSeen !== linkId && (!linkId || linked.data)) {
    setLinkSeen(linkId)
    if (linkId && linked.data) setOpened({ kind: 'task', task: linked.data })
  }
  useEffect(() => {
    if (!linkId || (!linked.data && !linked.isError)) return
    const next = new URLSearchParams(params)
    next.delete('t')
    setParams(next, { replace: true })
  }, [linkId, linked.data, linked.isError, params, setParams])

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
  // 搜索在拉全的列表上本地匹配（要搜负责人名，后端 q 不管负责人），不传 q
  const list = useTaskList({ overdue: view === 'overdue' })
  const people = useStakeholders()
  // 负责人是 Agent 时显示它的头像（TSK-0500）
  const agentList = useAgents()
  const agents = useMemo(() => new Map((agentList.data ?? []).map((a) => [a.id, a])), [agentList.data])
  // 每条任务的产出汇总和种类名（TSK-0497）：列表行、看板卡片、产出物视图共用
  const outputs = useTaskOutputs()
  const kindDict = useDictItems(ARTIFACT_KIND_DICT)
  const kinds = kindTable(kindDict.data)
  const hooks = useWebhooks()
  const hookList = hooks.data ?? []
  const lastDeliveries = useLastDeliveries(hookList.map((h) => h.id), LAST_DELIVERY_POLL_MS)

  if (view === null) return <Navigate to={root} replace />

  const taskType = types.data?.find((t) => t.id === 'task')
  const statuses = taskType?.statuses ?? []
  const overdueN = counts.data?.overdue

  // 完成圆圈：待验收的先确认，已结束的改回第一个非终态，其余标完成；请求还在路上时不重复发
  const toggleDone = (t: WorkObject) => {
    if (setTaskStatus.isPending) return
    if (t.status === REVIEW) { approve.reset(); setApproving(t); return }
    const next = terminalOf(statuses)(t.status) ? reopenKey(statuses) : doneKey(statuses)
    if (next) setTaskStatus.mutate({ id: t.id, status: next })
  }
  const doApprove = (t: WorkObject) => {
    const done = doneKey(statuses)
    if (!done) return
    approve.mutate({ id: t.id, status: done }, { onSuccess: () => setApproving(null) })
  }

  const selectView = (v: View) => {
    setOpened(null)
    const sub = subpath(v)
    navigate(sub ? `${root}/${sub}` : root)
  }
  // 点产出标记、产出物视图的「在任务里看」：打开抽屉、停在开发任务标签并滚到产出物面板（TSK-0497）
  const openOutputs = (id: string, t: WorkObject | undefined) => {
    if (t) {
      drawerTab.select('dev', { [FOCUS_PARAM]: FOCUS_ARTIFACTS })
      setOpened({ kind: 'task', task: t })
    } else {
      // 不在已取到的列表里（比如列表还没回来）：走 ?t= 取到再打开
      const next = new URLSearchParams(params)
      next.set('t', id)
      next.set('tab', 'dev')
      next.set(FOCUS_PARAM, FOCUS_ARTIFACTS)
      setParams(next, { replace: true })
    }
  }
  // 来源标签上的 Webhook 名：列表没取到时不说「已删除」
  const hookName = (id: string) => (hooks.data ? hooks.data.find((h) => h.id === id)?.name ?? null : undefined)
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
  else if (view === 'board') {
    main = (
      <StageBoard tasks={list.data?.data ?? []} loading={list.isPending} error={list.isError ? list.error : undefined}
        onRetry={() => void list.refetch()} statuses={statuses} selected={opened?.kind === 'task' ? opened.task.id : null}
        onOpen={(t) => {
          // 看板上点开直接看流水线（AUTO-12）：SOP 插件在跑才有这个标签，没有就回默认标签
          if (opened?.kind !== 'task' || opened.task.id !== t.id) {
            if (drawerTab.refs.some((r) => r.key === PIPELINE_TAB)) drawerTab.select(PIPELINE_TAB)
            else drawerTab.clear()
          }
          setOpened({ kind: 'task', task: t })
        }}
        search={search} onSearch={setSearch} q={q}
        outputs={outputs.map} kinds={kinds} onOpenOutputs={(t) => openOutputs(t.id, t)} agents={agents} />
    )
  } else if (view === 'outputs') {
    main = (
      <OutputsView tasks={list.data?.data ?? []} statuses={statuses} kinds={kinds}
        projects={(projects.data?.data ?? []).map((p) => ({ id: p.id, title: p.title }))}
        search={search} onSearch={setSearch} q={q} selected={opened?.kind === 'task' ? opened.task.id : null}
        onOpenTask={openOutputs} />
    )
  } else if (view === 'schedules') main = <SchedulesView statuses={statuses} priorities={prios.data ?? []} projects={projects.data?.data ?? []} />
  else if (view === 'hooks' || isHookView(view)) {
    main = (
      <WebhooksView route={view === 'hooks' ? 'list' : view.slice(5)} statuses={statuses} priorities={prios.data ?? []}
        projects={projects.data?.data ?? []} onOpenHook={(id) => selectView(`hook:${id}`)} onNewHook={() => selectView('hook:new')}
        onList={() => selectView('hooks')} />
    )
  } else {
    // 当前打开的任务以列表里的最新数据为准，不在列表里（被筛掉了）就用打开时的那份
    const sel = opened?.kind === 'task' ? opened.task.id : null
    main = (
      <TaskList
        // 换视图时折叠、多露条数、优先级、项目、负责人筛选和排序都重新来：逾期视图只有一段，沿用全部任务里的折叠会整页空掉
        key={view}
        view={view}
        tasks={list.data?.data ?? []}
        loading={list.isPending}
        error={list.isError ? list.error : undefined}
        onRetry={() => void list.refetch()}
        statuses={statuses}
        priorities={prios.data ?? []}
        projects={(projects.data?.data ?? []).map((p) => ({ id: p.id, title: p.title }))}
        people={people.data ?? []}
        onToggleDone={toggleDone}
        status={status}
        onStatus={setStatus}
        search={search}
        onSearch={setSearch}
        q={q}
        selected={sel}
        drawerOpen={!!opened}
        onOpen={(t) => { if (opened?.kind !== 'task' || opened.task.id !== t.id) drawerTab.clear(); setOpened({ kind: 'task', task: t }) }}
        onNew={() => { drawerTab.clear(); setOpened({ kind: 'new' }) }}
        hookName={hookName}
        outputs={outputs.map}
        kinds={kinds}
        onOpenOutputs={(t) => openOutputs(t.id, t)}
        agents={agents}
      />
    )
  }

  // 二级菜单「最近推送」：最近推送过的几个 Webhook；打开的不在里面时高亮落在「Webhook 接入」（SPEC-tasks-1.8）
  const failN = hookList.filter((h) => isFailing(lastDeliveries[h.id])).length
  const recent = recentHooks(hookList, lastDeliveries)
  const navActive: View = isHookView(view) && view !== 'hook:new' && !recent.some((h) => view === `hook:${h.id}`) ? 'hooks' : view

  const openTask = opened?.kind === 'task'
    ? list.data?.data.find((t) => t.id === opened.task.id) ?? opened.task
    : null

  return (
    <div className="tasks-mod">
      {/* 二级菜单送进外壳的二级菜单位置：从页面最上方开始，顶栏只在它右边 */}
      <InSubnavHost>
        <Subnav<View> title="任务" className="subnav-fold" active={navActive} onSelect={selectView} items={[
          { key: 'all', label: '全部任务', group: '视图' },
          {
            key: 'overdue', label: '逾期', group: '视图',
            // 计数没取到时不显示数字，也不能显示成「没有逾期」
            desc: overdueN === undefined ? undefined : overdueN ? `${overdueN} 条过了截止日还没完成` : '没有逾期的任务',
            alert: overdueN ?? 0,
          },
          { key: 'board', label: '阶段看板', group: '视图', desc: '按阶段分列，按提出人看进度' },
          {
            key: 'outputs', label: '产出物', group: '视图',
            // 有产出的任务数；汇总没取到时不显示数字
            desc: outputs.query.data ? `${outputs.query.data.objects.length} 条任务有产出` : '按任务看提交、文档、原型等产出',
          },
          { key: 'schedules', label: '定时任务', group: '自动化', desc: '到点自动建任务、跑 SOP、叫 Agent' },
          {
            key: 'hooks', label: 'Webhook 接入', group: '自动化',
            desc: hooks.data ? `${hookList.length} 个${failN ? `，${failN} 个最近推送失败` : ''}` : undefined, alert: failN,
          },
          ...recent.map((h): SubnavItem<View> => {
            const at = lastDeliveries[h.id]!.last!.at
            return {
              key: `hook:${h.id}`, label: h.name || '未命名', group: '最近推送',
              desc: `${timeAgo(at)}推送${h.enabled ? '' : ' · 已停用'}`, alert: isFailing(lastDeliveries[h.id]) ? 1 : 0,
            }
          }),
        ]}>
          <Button className="subnav-new" onClick={() => selectView('hook:new')}>
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            新建 Webhook
          </Button>
        </Subnav>
      </InSubnavHost>
      <div className="tasks-body">{main}</div>
      {opened && taskType && (
        <TaskDrawer
          // 换一条任务就重新挂载，表单从这条任务的值重新开始
          key={openTask?.id ?? 'new'}
          task={openTask}
          statuses={statuses}
          priorities={prios.data ?? []}
          projects={projects.data?.data ?? []}
          // 插件区块（SOP 执行）去运行页后「返回」回到这里并重新打开这条任务（?t=）
          returnTo={openTask ? `${pathname}?${withTask(params, openTask.id)}` : undefined}
          onClose={() => setOpened(null)}
          onCreated={(t) => setOpened({ kind: 'task', task: t })}
        />
      )}
      {approving && (
        <ApproveDialog task={approving} busy={approve.isPending}
          error={approve.isError ? approve.error.message : undefined}
          onCancel={() => setApproving(null)}
          onOpen={() => { setOpened({ kind: 'task', task: approving }); setApproving(null) }}
          onApprove={() => doApprove(approving)} />
      )}
    </div>
  )
}

/** 当前查询参数加上 t=<任务 id>：从别处返回时 ?t= 重新打开这条任务 */
function withTask(params: URLSearchParams, id: string) {
  const next = new URLSearchParams(params)
  next.set('t', id)
  return next.toString()
}
