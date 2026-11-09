// SOP 插件的页面（SPEC-sop-1 到 7）：二级菜单 + 执行记录（默认）、待我处理、流程库、流程详情、运行页，发起执行抽屉。
// 路由挂在 sop/* 下：/sop 执行记录（?flow= 按流程筛），/sop/waiting，/sop/library（?folder= 按文件夹筛，TSK-0482；none 是未分类），/sop/flows/<id> 流程详情（?start=1 打开发起执行抽屉），/sop/runs/<id> 运行页。
// 编排页（SOP-04c）：/sop/new 新建，/sop/flows/<id>/edit 编辑，保存后回流程详情，「测试运行」再打开发起执行抽屉；流程详情「复制」出的新流程直接进它的编排页。打开运行页时把来处记在 location.state，「返回」回到那里
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import {
  QueryState, isApiError, useEventsLive, useSopFlows, useSopFolders, useSopNodeTypes, useSopOpenRuns, useSopRun, useSopRunAction, useSopRuns, type SopFlow, type SopJson,
  type SopRunBrief,
} from '../../core/data'
import { useSopNodeViews } from '../../core/plugin'
import { Button, EmptyState, InSubnavHost, Subnav } from '../../core/ui'
import { EditPage } from './EditPage'
import { FlowDetail } from './FlowDetail'
import { Library } from './Library'
import { branchingOf, flowStats, isEnded, mergeRuns, recentFlows, timeAgo } from './model'
import { pipelinePath, stageWaitTasks, waitingTodayItems } from './pipelineModel'
import { IconPlus } from './parts'
import { RunList } from './RunList'
import { RunView } from './RunView'
import { useFlowNeeds, useTriggerLabel } from './scope'
import { StartDrawer } from './StartDrawer'
import { useWaitingData } from './waitingSource'
import './sop.css'

// 事件流断开时退回轮询；连着时不轮询
const POLL_MS = 15_000
const RUN_POLL_MS = 3_000

type NavKey = 'runs' | 'waiting' | 'library' | `flow:${string}`
type Route =
  | { kind: 'runs' } | { kind: 'waiting' } | { kind: 'library' }
  | { kind: 'flow'; id: string } | { kind: 'run'; id: string } | { kind: 'edit'; id?: string } | { kind: 'bad' }

function routeOf(rest: string): Route {
  const seg = rest.split('/').filter(Boolean).map(decodeURIComponent)
  if (!seg.length) return { kind: 'runs' }
  if (seg.length === 1 && (seg[0] === 'waiting' || seg[0] === 'library')) return { kind: seg[0] }
  if (seg.length === 1 && seg[0] === 'new') return { kind: 'edit' }
  if (seg.length === 2 && seg[0] === 'flows') return { kind: 'flow', id: seg[1] }
  if (seg.length === 3 && seg[0] === 'flows' && seg[2] === 'edit') return { kind: 'edit', id: seg[1] }
  if (seg.length === 2 && seg[0] === 'runs') return { kind: 'run', id: seg[1] }
  return { kind: 'bad' }
}

type BackState = { back?: string; nav?: NavKey }

export default function Page() {
  const rest = useParams()['*'] ?? ''
  const { pathname, search, state } = useLocation()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const root = pathname.slice(0, pathname.length - rest.length).replace(/\/+$/, '')
  const route = routeOf(rest)
  const live = useEventsLive()
  const flows = useSopFlows({ refetchInterval: live ? false : POLL_MS })
  // 最近 500 条 + 没走完和待我处理的（不受 500 条限制，TSK-0486），合成一份给列表、计数、流程库和流程详情
  const recentRuns = useSopRuns({ refetchInterval: live ? false : POLL_MS })
  const openRuns = useSopOpenRuns({ refetchInterval: live ? false : POLL_MS })
  const runs = useMergedRuns(recentRuns, openRuns)
  // 二级菜单「待我处理」的数字和今日同一份取数、同一个计数；阶段任务也列在待我处理页
  const waitingQ = useWaitingData({ refetchInterval: live ? false : POLL_MS })
  const types = useSopNodeTypes()
  // 文件夹（TSK-0482）：没取到时流程库照常显示，只是没有文件夹那一行的内容
  const folders = useSopFolders()
  // 插件节点的名字、颜色在注册表里，登记变了重画
  useSopNodeViews()
  const branching = useMemo(() => branchingOf(types.data), [types.data])
  const needs = useFlowNeeds()
  const trigger = useTriggerLabel()
  const [start, setStart] = useState<{ flow: SopFlow; initial?: SopJson | null } | null>(null)

  // 相对时间每分钟走一次
  const now = useNow(60_000)
  const flowList = useMemo(() => flows.data ?? [], [flows.data])
  const runList = useMemo(() => runs.data ?? [], [runs.data])
  const stats = useMemo(() => flowStats(runList), [runList])
  const recent = useMemo(() => recentFlows(flowList, stats), [flowList, stats])
  const waitingData = waitingQ.data
  const pendingN = waitingData ? waitingTodayItems(waitingData.steps, waitingData.tasks).total : 0
  const stageTasks = useMemo(() => (waitingData ? stageWaitTasks(waitingData.steps, waitingData.tasks) : []), [waitingData])
  // 别处（项目的 SOP 标签）带 ?start=1 进流程详情：流程取到后直接打开发起执行抽屉，关掉时去掉这个参数
  const startId = route.kind === 'flow' && params.get('start') === '1' ? route.id : ''
  const startFlow = startId ? flowList.find((f) => f.id === startId) : undefined
  const drawer = start ?? (startFlow ? { flow: startFlow, initial: null } : null)
  const closeStart = () => {
    setStart(null)
    if (!startId) return
    const next = new URLSearchParams(params)
    next.delete('start')
    setParams(next, { replace: true, state })
  }

  if (route.kind === 'bad') return <Navigate to={root} replace />

  // 来处不带 start，从运行页返回时不再弹发起执行抽屉
  const hereQs = new URLSearchParams(search)
  hereQs.delete('start')
  const here = pathname + (hereQs.toString() ? `?${hereQs}` : '')
  const go = (to: string, st?: BackState) => navigate(to, { state: st })
  const openRun = (id: string, nav?: NavKey) => go(`${root}/runs/${encodeURIComponent(id)}`, { back: here, nav })
  const openFlow = (id: string) => go(`${root}/flows/${encodeURIComponent(id)}`)
  const runsOf = (flowId: string) => go(`${root}?flow=${encodeURIComponent(flowId)}`)
  const onNew = () => go(`${root}/new`)
  // 在某个文件夹里新建：新流程默认放进这个文件夹（TSK-0482）
  const onNewIn = (folderId: string | null) => go(`${root}/new${folderId ? `?folder=${encodeURIComponent(folderId)}` : ''}`)
  const select = (k: NavKey) => {
    if (k === 'runs') go(root)
    else if (k === 'waiting' || k === 'library') go(`${root}/${k}`)
    else openFlow(k.slice(5))
  }

  const fromState = (state as BackState | null) ?? {}
  const active: NavKey = route.kind === 'waiting' || route.kind === 'library' ? route.kind
    : route.kind === 'flow' ? (recent.some((f) => f.id === route.id) ? `flow:${route.id}` : 'library')
      : route.kind === 'run' ? fromState.nav ?? 'runs' : 'runs'

  // 编排页不显示二级菜单，画布铺满
  const subnav = route.kind !== 'edit' && (
    <InSubnavHost>
      <Subnav<NavKey> title="SOP" className="sop-subnav" active={active} onSelect={select} items={[
        { key: 'runs', label: '执行记录', group: '视图' },
        // 计数加载失败时不显示红点，不当成 0
        { key: 'waiting', label: '待我处理', desc: '待检查、待确认、失败', alert: waitingQ.isError ? 0 : pendingN, group: '视图' },
        { key: 'library', label: '流程库', desc: flows.data ? `${flowList.length} 个标准流程` : undefined, group: '视图' },
        ...recent.map((f) => ({
          key: `flow:${f.id}` as NavKey, label: f.name, desc: `${timeAgo(new Date(stats.get(f.id)!.last).toISOString(), now)}执行`, group: '最近用过',
        })),
      ]}>
        <Button className="subnav-new" onClick={onNew}><IconPlus />新建 SOP</Button>
      </Subnav>
    </InSubnavHost>
  )

  const both = { flows, runs }
  let body
  if (route.kind === 'runs' || route.kind === 'waiting') {
    const view = route.kind
    body = (
      <Loaded q={both}>
        {(fl, rs) => (
          <RunList runs={rs} flows={fl} view={view} flow={params.get('flow') ?? ''} now={now} onOpen={(id) => openRun(id, view)}
            stageTasks={view === 'waiting' ? stageTasks : undefined} onOpenTask={(id) => navigate(pipelinePath(id))}
            onFlow={(v) => {
              const next = new URLSearchParams(params)
              if (v) next.set('flow', v)
              else next.delete('flow')
              setParams(next, { replace: true })
            }} />
        )}
      </Loaded>
    )
  } else if (route.kind === 'library') {
    body = (
      <Loaded q={both}>
        {(fl) => (
          <Library flows={fl} folders={folders.data ?? []} folder={params.get('folder') ?? ''} stats={stats} needs={needs} trigger={trigger}
            onOpen={openFlow} onNew={onNewIn} now={now}
            onFolder={(k) => {
              const next = new URLSearchParams(params)
              if (k) next.set('folder', k)
              else next.delete('folder')
              setParams(next, { replace: true })
            }} />
        )}
      </Loaded>
    )
  } else if (route.kind === 'flow') {
    const id = route.id
    body = (
      <Loaded q={both}>
        {(fl, rs) => {
          const flow = fl.find((f) => f.id === id)
          if (!flow) return <Gone title="这个 SOP 已经删除" onBack={() => go(`${root}/library`)} backLabel="回到流程库" />
          return (
            <FlowDetail flow={flow} runs={rs} branching={branching} needs={needs(flow)} trigger={trigger} now={now} onStart={() => setStart({ flow })}
              onOpenRun={(rid) => openRun(rid, active)} onEdit={() => go(`${root}/flows/${encodeURIComponent(id)}/edit`)}
              onAllRuns={() => runsOf(id)} onDeleted={() => navigate(root, { replace: true })}
              onCopied={(f) => go(`${root}/flows/${encodeURIComponent(f.id)}/edit`)} />
          )
        }}
      </Loaded>
    )
  } else if (route.kind === 'run') {
    body = (
      <RunPage id={route.id} live={live} branching={branching} onBack={() => navigate(fromState.back ?? root)}
        onOpenRun={(rid) => openRun(rid, fromState.nav)}
        onEditFlow={(flowId) => go(`${root}/flows/${encodeURIComponent(flowId)}/edit`)}
        onRerun={(flowId, input) => {
          const flow = flowList.find((f) => f.id === flowId)
          if (flow) setStart({ flow, initial: input })
          else setStart(null)
          return !!flow
        }} />
    )
  } else {
    const id = route.id
    body = (
      <Loaded q={both}>
        {(fl, rs) => (
          <EditPage key={id ?? 'new'} id={id} flows={fl} runs={rs} folderId={id ? undefined : params.get('folder') || undefined}
            onCancel={() => (id ? openFlow(id) : go(root))}
            onSaved={(f, thenRun) => {
              navigate(`${root}/flows/${encodeURIComponent(f.id)}`, { replace: true })
              if (thenRun) setStart({ flow: f })
            }} />
        )}
      </Loaded>
    )
  }

  return (
    <div className={route.kind === 'run' || route.kind === 'edit' ? 'sop-mod sop-mod-fill' : 'sop-mod'}>
      {subnav}
      {body}
      {drawer && (
        <StartDrawer key={drawer.flow.id} flow={drawer.flow} initial={drawer.initial} onClose={closeStart}
          onStarted={(id) => { setStart(null); openRun(id, active) }} />
      )}
    </div>
  )
}

type Q<T> = { data: T | undefined; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown }

/** 两份执行都回来了才算取到；任一出错算出错，「重试」两份都重取 */
function useMergedRuns(recent: Q<SopRunBrief[]>, open: Q<SopRunBrief[]>): Q<SopRunBrief[]> {
  const data = useMemo(() => (recent.data && open.data ? mergeRuns(recent.data, open.data) : undefined), [recent.data, open.data])
  return {
    data, isPending: !data && !recent.isError && !open.isError, isError: recent.isError || open.isError, error: recent.error ?? open.error,
    refetch: () => { void recent.refetch(); void open.refetch() },
  }
}

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(t)
  }, [ms])
  return now
}

/** 流程和执行都回来了才渲染；任一出错显示错误和「重试」 */
function Loaded({ q, children }: { q: { flows: Q<SopFlow[]>; runs: Q<SopRunBrief[]> }; children: (flows: SopFlow[], runs: SopRunBrief[]) => ReactNode }) {
  return (
    <div className="sop-body">
      <QueryState query={q.flows} errorTitle="流程没取到">
        {(fl) => <QueryState query={q.runs} errorTitle="执行记录没取到">{(rs) => children(fl, rs)}</QueryState>}
      </QueryState>
    </div>
  )
}

function Gone({ title, onBack, backLabel }: { title: string; onBack: () => void; backLabel: string }) {
  return (
    <div className="sop-page">
      <EmptyState title={title} action={<Button onClick={onBack}>{backLabel}</Button>} />
    </div>
  )
}

function RunPage({ id, live, branching, onBack, onOpenRun, onEditFlow, onRerun }: {
  id: string
  onOpenRun: (id: string) => void
  live: boolean
  branching: ReturnType<typeof branchingOf>
  onBack: () => void
  /** 条件是一句话的失败点「去改流程」（TSK-0498）：打开这条流程的编辑页 */
  onEditFlow: (flowId: string) => void
  /** 返回 false 表示流程已删除 */
  onRerun: (flowId: string, input: SopJson) => boolean
}) {
  const run = useSopRun(id, { refetchInterval: (q) => (live || (q.state.data && isEnded(q.state.data)) ? false : RUN_POLL_MS) })
  const act = useSopRunAction()
  const [gone, setGone] = useState(false)
  if (run.isError && isApiError(run.error, 'not_found')) return <Gone title="这次执行不存在" onBack={onBack} backLabel="返回" />
  return (
    <QueryState query={run} errorTitle="这次执行没取到">
      {(r) => (
        <>
          {gone && <div className="sop-act-error" role="alert">这个 SOP 已删除，不能再执行</div>}
          <RunView run={r} branching={branching} busy={act.isPending} actError={act.error} onBack={onBack} onOpenRun={onOpenRun}
            onEditFlow={() => onEditFlow(r.flow_id)}
            onAct={(a) => act.mutateAsync({ runId: r.id, action: a }).catch(() => undefined)}
            onRerun={() => setGone(!onRerun(r.flow_id, r.input))} />
        </>
      )}
    </QueryState>
  )
}
