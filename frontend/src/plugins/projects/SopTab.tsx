// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// SOP 标签（SPEC-projects-9）：关联的标准流程（props.sop_ids）和它们的最近执行。
// 流程和执行都从 SOP 插件的接口取，执行列表用 SOP 页同一份「最近 500 条」缓存，按关联的流程在前端筛。
// 点名称去流程详情，「执行」去流程详情并打开发起执行抽屉（?start=1），点执行记录去运行页，「返回」回到这里
// 自动反向关联：没手动关联、但流程里引用了本项目、执行时用的是本项目、或流程名以项目名开头的流程也列出来，标「自动」（sopModel.autoFlows）；
// 可以「固定关联」（进 sop_ids），也可以「不自动关联」（进 sop_ids_hidden，下面能一键恢复）。
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import {
  errorText, isApiError, projectView, sopRunShow, useEventsLive, usePlugins, useSaveProject, useSopFlows, useSopInputRuns, useSopRuns, type WorkObject,
} from '../../core/data'
import { Button, EmptyState, ErrorState, LoadingState, Pill, SearchSelect } from '../../core/ui'
import { ago } from './model'
import { AUTO_REASON_LABEL, PROJECT_INPUT_KEYS, addSop, autoFlows, availFlows, linkedFlows, recentRuns, removeSop, runLook } from './sopModel'

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
  // 执行输入里的项目字段是本项目（id 或编号）的执行，按两个常用字段名各查一次
  const projVals = [p.id, p.ref]
  const byInput0 = useSopInputRuns(PROJECT_INPUT_KEYS[0], projVals, { enabled: on, refetchInterval: live ? false : POLL_MS })
  const byInput1 = useSopInputRuns(PROJECT_INPUT_KEYS[1], projVals, { enabled: on, refetchInterval: live ? false : POLL_MS })
  const save = useSaveProject()
  const [err, setErr] = useState('')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  const all = useMemo(() => flows.data ?? [], [flows.data])
  const mine = useMemo(() => linkedFlows(p.sopIds, all), [p.sopIds, all])
  // 关联到本项目的执行：object_id 是本项目的，加上输入里项目字段是本项目的（两份可能重复，按 id 去重）
  const projRuns = useMemo(() => {
    const m = new Map<string, NonNullable<typeof runs.data>[number]>()
    for (const r of runs.data ?? []) if (r.object_id === p.id) m.set(r.id, r)
    for (const r of [...(byInput0.data ?? []), ...(byInput1.data ?? [])]) m.set(r.id, r)
    return [...m.values()]
  }, [runs.data, byInput0.data, byInput1.data, p.id])
  const auto = useMemo(() => autoFlows({ id: p.id, ref: p.ref, name: p.name }, all, projRuns, p.sopIds, p.sopHidden),
    [p.id, p.ref, p.name, all, projRuns, p.sopIds, p.sopHidden])
  const avail = availFlows(p.sopIds, all)
  const recent = useMemo(() => recentRuns([...mine, ...auto.map((a) => a.flow)], runs.data ?? []), [mine, auto, runs.data])
  // 点掉的里面还在流程库的，才算「已点掉」
  const hiddenN = p.sopHidden.filter((id) => all.some((f) => f.id === id)).length
  const noPlugin = (!!plugins.data && !info?.running) || (isApiError(flows.error, 'not_found'))

  const setIds = (ids: string[]) => {
    setErr('')
    // 手动关联了的，从「不自动关联」里拿掉，免得以后取消关联后它不再自动出现
    const hidden = p.sopHidden.filter((id) => !ids.includes(id))
    const props = hidden.length === p.sopHidden.length ? { sop_ids: ids } : { sop_ids: ids, sop_ids_hidden: hidden }
    save.mutate({ id: p.id, props }, { onError: (e) => setErr(`没存上：${errorText(e)}`) })
  }
  const setHidden = (ids: string[]) => {
    setErr('')
    save.mutate({ id: p.id, props: { sop_ids_hidden: ids } }, { onError: (e) => setErr(`没存上：${errorText(e)}`) })
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
        {mine.length || auto.length ? (
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
            {auto.map(({ flow: f, reasons }) => (
              <li key={f.id} className="pj-mat pj-sop">
                <button type="button" className="pj-sop-text" title="在 SOP 里打开" onClick={() => openFlow(f.id)}>
                  <b className="pj-mat-name">{f.name}<span className="pj-auto-tag" title={reasons.map((r) => AUTO_REASON_LABEL[r]).join('；')}>自动</span></b>
                  <span className="pj-muted pj-wrap">{reasons.map((r) => AUTO_REASON_LABEL[r]).join('；')}{f.desc ? ` · ${f.desc}` : ''}</span>
                </button>
                <Button variant="primary" size="sm" onClick={() => openFlow(f.id, true)}>执行</Button>
                <Button variant="ghost" size="sm" disabled={save.isPending} onClick={() => setIds(addSop(p.sopIds, f.id))}>固定关联</Button>
                <Button variant="ghost" size="sm" disabled={save.isPending} onClick={() => setHidden([...p.sopHidden, f.id])}>不自动关联</Button>
              </li>
            ))}
          </ul>
        ) : <div className="pj-mount-empty">还没关联 SOP</div>}
        {hiddenN > 0 && (
          <div className="pj-muted">
            {hiddenN} 个流程设成了不自动关联
            <button type="button" className="pj-link" disabled={save.isPending} onClick={() => setHidden([])}>恢复</button>
          </div>
        )}
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
