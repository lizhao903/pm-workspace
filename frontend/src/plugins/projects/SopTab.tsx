// SOP 标签（SPEC-projects-9）：关联的标准流程（props.sop_ids）和它们的最近执行。
// 流程和执行都从 SOP 插件的接口取，执行列表用 SOP 页同一份「最近 500 条」缓存，按关联的流程在前端筛。
// 点名称去流程详情，「执行」去流程详情并打开发起执行抽屉（?start=1），点执行记录去运行页，「返回」回到这里
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import {
  errorText, isApiError, projectView, sopRunShow, useEventsLive, usePlugins, useSaveProject, useSopFlows, useSopRuns, type WorkObject,
} from '../../core/data'
import { Button, EmptyState, ErrorState, LoadingState, Pill, SearchSelect } from '../../core/ui'
import { ago } from './model'
import { addSop, availFlows, linkedFlows, recentRuns, removeSop, runLook } from './sopModel'

const SOP_PLUGIN = 'sop'
const SOP_PATH = '/sop'
const PLUGINS_PATH = '/settings/plugins'
/** 事件流断开时轮询 */
const POLL_MS = 30_000

export function SopTab({ project }: { project: WorkObject }) {
  const p = projectView(project)
  const navigate = useNavigate()
  const { pathname, search } = useLocation()
  const live = useEventsLive()
  const plugins = usePlugins()
  const info = plugins.data?.find((x) => x.id === SOP_PLUGIN)
  // 插件列表读不出来时照样去取，404 再当没启用
  const on = plugins.isError || !!info?.running
  const flows = useSopFlows({ refetchInterval: live ? false : POLL_MS })
  const runs = useSopRuns({ refetchInterval: live ? false : POLL_MS })
  const save = useSaveProject()
  const [err, setErr] = useState('')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  const all = useMemo(() => flows.data ?? [], [flows.data])
  const mine = useMemo(() => linkedFlows(p.sopIds, all), [p.sopIds, all])
  const avail = availFlows(p.sopIds, all)
  const recent = useMemo(() => recentRuns(mine, runs.data ?? []), [mine, runs.data])
  const noPlugin = (!!plugins.data && !info?.running) || (isApiError(flows.error, 'not_found'))

  const setIds = (ids: string[]) => {
    setErr('')
    save.mutate({ id: p.id, props: { sop_ids: ids } }, { onError: (e) => setErr(`没存上：${errorText(e)}`) })
  }
  const back = { back: pathname + search }
  const openFlow = (id: string, start = false) => navigate(`${SOP_PATH}/flows/${encodeURIComponent(id)}${start ? '?start=1' : ''}`)
  const openRun = (id: string) => navigate(`${SOP_PATH}/runs/${encodeURIComponent(id)}`, { state: back })

  const head = (
    <div className="pj-tab-head">
      <span className="pj-muted pj-wrap">这个项目常用的标准流程，在这里直接执行</span>
      <span className="spacer" />
      {on && !noPlugin && (
        <SearchSelect value="" placeholder="关联 SOP" searchPlaceholder="搜流程名" align="end" active={false}
          disabled={!flows.data || save.isPending}
          options={avail.map((f) => ({ value: f.id, label: f.name, keywords: f.desc }))}
          emptyText="SOP 都已经关联了" onChange={(id) => { if (id) setIds(addSop(p.sopIds, id)) }} />
      )}
    </div>
  )

  let body
  if (noPlugin) {
    body = (
      <EmptyState title="SOP 编排插件还没启用" desc="关联的流程和执行记录来自 SOP 编排插件"
        action={<Button onClick={() => navigate(PLUGINS_PATH)}>去插件管理</Button>} />
    )
  } else if (plugins.isPending || flows.isPending) body = <LoadingState />
  else if (flows.isError) body = <ErrorState title="SOP 没加载出来" error={errorText(flows.error)} onRetry={() => void flows.refetch()} />
  else {
    body = (
      <>
        {mine.length ? (
          <ul className="pj-mat-list" aria-label="关联的 SOP">
            {mine.map((f) => (
              <li key={f.id} className="pj-mat pj-sop">
                <button type="button" className="pj-sop-text" title="在 SOP 里打开" onClick={() => openFlow(f.id)}>
                  <b className="pj-mat-name">{f.name}</b>
                  {f.desc && <span className="pj-muted pj-wrap">{f.desc}</span>}
                </button>
                <Button variant="primary" size="sm" onClick={() => openFlow(f.id, true)}>执行</Button>
                <Button variant="ghost" size="sm" disabled={save.isPending} onClick={() => setIds(removeSop(p.sopIds, f.id))}>取消关联</Button>
              </li>
            ))}
          </ul>
        ) : <div className="pj-mount-empty">还没关联 SOP</div>}
        {recent.length > 0 && (
          <section className="pj-sop-runs" aria-label="最近执行">
            <h3 className="pj-sec-title">最近执行</h3>
            <div className="pj-table">
              {recent.map((r) => {
                const look = runLook(sopRunShow(r))
                return (
                  <button key={r.id} type="button" className="pj-sop-run" onClick={() => openRun(r.id)}>
                    <span className="ellipsis">{r.title || r.flow_name}</span>
                    <Pill label={look.label} color={look.color} />
                    <span className="pj-muted" title={r.started_at}>{ago(r.started_at, now)}</span>
                  </button>
                )
              })}
            </div>
          </section>
        )}
        {runs.isError && !runs.data && <ErrorState compact error={`执行记录没加载出来：${errorText(runs.error)}`} onRetry={() => void runs.refetch()} />}
      </>
    )
  }

  return (
    <div className="pj-tab">
      {head}
      {err && <div className="pj-err" role="alert">{err}</div>}
      {body}
    </div>
  )
}
