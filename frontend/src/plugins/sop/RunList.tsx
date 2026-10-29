// 执行记录和待我处理（SPEC-sop-3、SPEC-sop-4）：同一个页面，只差过滤条件、标题、说明和有没有状态分段按钮。
// 按开始日期分段，每段先显示 30 条，点一次多 100 条，改筛选或搜索后回到 30 条。照原型 sop.tsx RunList
import { useMemo, useState } from 'react'
import type { SopFlow, SopRunBrief, SopRunStatus } from '../../core/data'
import { EmptyState, IconSearch, ListSegHead, ListSegMore, PageTitle, SearchSelect, cls } from '../../core/ui'
import { DAY_SEGS, baseRuns, daySegOf, flowOptions, sortRuns, type DaySeg } from './model'
import { RunHead, RunRow } from './parts'

const PAGE = 30
const STATUS_SEG: [('' | SopRunStatus), string][] = [['', '全部'], ['running', '执行中'], ['waiting', '待我处理'], ['failed', '失败'], ['done', '已完成']]

export function RunList({ runs, flows, view, flow, onFlow, onOpen, now }: {
  runs: readonly SopRunBrief[]
  flows: readonly SopFlow[]
  view: 'runs' | 'waiting'
  /** 流程筛选放在地址里（?flow=），从流程详情「在执行记录里看全部」进来时预选 */
  flow: string
  onFlow: (id: string) => void
  onOpen: (id: string) => void
  now: number
}) {
  const [st, setSt] = useState<'' | SopRunStatus>('')
  const [q, setQ] = useState('')
  const [closed, setClosed] = useState<Set<DaySeg>>(() => new Set())
  const [more, setMore] = useState<Partial<Record<DaySeg, number>>>({})
  const waiting = view === 'waiting'
  const status = waiting ? '' : st

  const options = useMemo(() => flowOptions(flows, runs), [flows, runs])
  const base = baseRuns(runs, { flow, q, waitingOnly: waiting })
  const rows = sortRuns(base.filter((r) => !status || r.status === status))
  const segOf = daySegOf(new Date(now))
  const segs = DAY_SEGS.map((s) => ({ ...s, xs: rows.filter((r) => segOf(r.started_at) === s.key) })).filter((s) => s.xs.length)
  const filtered = !!(status || flow || q.trim())

  const toggle = (k: DaySeg) => setClosed((s) => {
    const n = new Set(s)
    if (n.has(k)) n.delete(k)
    else n.add(k)
    return n
  })

  return (
    <div className="sop-page">
      <PageTitle parent="SOP" count={rows.length}
        desc={waiting ? '这些执行停下来等你：检查输出、确认输入，或处理失败的步骤' : '每一步都留着输入和输出，点进去可以逐步查看'}>
        {waiting ? '待我处理' : '执行记录'}
      </PageTitle>
      <div className="sop-toolbar">
        {!waiting && (
          <div className="sop-seg" role="group" aria-label="按状态筛选">
            {STATUS_SEG.map(([k, l]) => (
              <button key={k} type="button" className={cls(st === k && 'on')} aria-pressed={st === k} onClick={() => { setSt(k); setMore({}) }}>
                {l}<span className="seg-n">{k ? base.filter((r) => r.status === k).length : base.length}</span>
              </button>
            ))}
          </div>
        )}
        <SearchSelect value={flow} onChange={(v) => { onFlow(v); setMore({}) }} noneLabel="全部流程" searchPlaceholder="搜流程" options={options}
          missingLabel={() => '已删除的流程'} />
        <span className="spacer" />
        <div className="search">
          <IconSearch />
          <input placeholder="搜索执行标题、流程名" aria-label="搜索执行" value={q} onChange={(e) => { setQ(e.target.value); setMore({}) }} />
        </div>
      </div>
      {!rows.length ? (
        <EmptyState
          title={filtered ? '没有匹配的执行记录' : waiting ? '没有等你处理的执行' : '没有执行记录'}
          desc={filtered ? '换个筛选条件试试' : waiting ? '检查点都处理完了' : '从流程库里选一个标准流程开始执行'} />
      ) : (
        <div className="sop-run-table">
          <RunHead />
          {segs.map((s) => {
            const open = !closed.has(s.key)
            const n = PAGE + (more[s.key] ?? 0)
            return (
              <div key={s.key} role="group" aria-label={s.label}>
                <ListSegHead label={s.label} n={s.xs.length} open={open} onToggle={() => toggle(s.key)} />
                {open && s.xs.slice(0, n).map((r) => <RunRow key={r.id} r={r} onOpen={onOpen} now={now} />)}
                {open && <ListSegMore n={s.xs.length - n} text={`再显示 ${Math.min(100, s.xs.length - n)} 条`}
                  onMore={() => setMore((m) => ({ ...m, [s.key]: (m[s.key] ?? 0) + 100 }))} />}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
