// 运行页（SPEC-sop-7）：上方流程图标出每步状态，下方检查器看选中步骤的输入、输出、日志，做八种动作。
// 状态变化靠事件流刷新（插件入口订阅 sop.* 事件报 sop-run）；动作的响应先写回缓存。没手动点过步骤时检查器跟着 focusIndex 走。
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { errorText, isSopHeld, isSopProviderWait, sopRunShow, type SopJson, type SopRun, type SopRunAction, type SopStepDef } from '../../core/data'
import { Button, Checkbox, PageTitle, Pill, cls } from '../../core/ui'
import { FlowGraph } from './FlowGraph'
import {
  EDITED_LABEL, PROVIDERS_SETTINGS_PATH, SOP_SETTINGS_PATH, clock, defaultTab, depsOf, dur, focusIndex, isEnded, isManualDecide, isQueued, needsMe, parseJsonObject, runDur,
  runLook, runStepLook, timeAgo, upstreamOf, type Tab,
} from './model'
import { IconBack, KindTag } from './parts'
import { useSourceText } from './source'

/** 字段视图：短文本直接显示，长文本保留换行，数组和对象缩进成 JSON，空串显示「空」 */
export function DataView({ data }: { data: SopJson }) {
  const keys = Object.keys(data)
  if (!keys.length) return <div className="sop-io-empty">空</div>
  return (
    <dl className="sop-io-fields">
      {keys.map((k) => {
        const v = data[k]
        const simple = v === null || ['string', 'number', 'boolean'].includes(typeof v)
        return (
          <div key={k} className="sop-io-field">
            <dt>{k}</dt>
            <dd>{simple ? <span className="sop-io-text">{String(v) || <span className="sop-io-empty">空</span>}</span> : <pre className="sop-io-json">{JSON.stringify(v, null, 2)}</pre>}</dd>
          </div>
        )
      })}
    </dl>
  )
}

const TAB_LABEL: Record<Tab, string> = { input: '输入', output: '输出', log: '日志' }

function Inspector({ run, index, onAct, busy, now, branching }: {
  run: SopRun; index: number; onAct: (a: SopRunAction) => void; busy: boolean; now: number; branching: (d: SopStepDef) => boolean
}) {
  const flow = run.flow
  const def = flow.steps[index]
  const step = run.steps[index]
  const manual = isManualDecide(def)
  const [tab, setTab] = useState<Tab>(() => defaultTab(def, step))
  const [raw, setRaw] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)

  const data = tab === 'input' ? step.input : tab === 'output' ? step.output : null
  const ended = isEnded(run)
  const editable = !ended && ((tab === 'input' && step.status === 'paused') || (tab === 'output' && step.status === 'review' && !manual))
  const deps = depsOf(flow, index)
  const upstream = upstreamOf(run, index)
  const nameOf = (k: string) => flow.steps.find((x) => x.key === k)?.name ?? k
  const routeLabel = step.route && def.cases?.find((c) => c.key === step.route)?.label
  const branchOf: SopStepDef | undefined = def.branch && flow.steps.find((x) => x.key === def.branch!.of)
  const branchLabel = branchOf?.cases?.find((c) => c.key === def.branch!.case)?.label

  const beginEdit = (d: SopJson | null) => { setDraft(JSON.stringify(d ?? {}, null, 2)); setErr(''); setEditing(true) }
  const submit = () => {
    const p = parseJsonObject(draft)
    if (!p.ok) { setErr(p.error); return }
    onAct(step.status === 'paused' ? { kind: 'confirm-input', step: index, input: p.value } : { kind: 'approve', step: index, output: p.value })
  }
  const copy = () => {
    // 剪贴板不可用时没反应，不报错
    navigator.clipboard?.writeText(JSON.stringify(data ?? {}, null, 2)).then(() => setCopied(true), () => {})
  }
  const look = runStepLook(step)
  const queued = isQueued(step)
  const navigate = useNavigate()
  const started = step.started_at ? Date.parse(step.started_at) : 0

  return (
    <section className="sop-inspector" aria-label={`步骤 ${index + 1} ${def.name}`}>
      <div>
        <div className="sop-insp-title">
          <span className="sop-insp-n">步骤 {index + 1}</span>
          <h2>{def.name}</h2>
          <KindTag kind={def.kind} />
          <Pill label={look.label} color={look.color} />
          {step.edited && <span className="sop-edited-tag">{EDITED_LABEL[step.edited]}</span>}
          {!!step.round && <span className="sop-edited-tag">第 {step.round} 轮</span>}
        </div>
        <div className="sop-insp-desc">
          {def.desc}
          {deps.length > 1 && <>{def.desc ? ' · ' : ''}汇合 {deps.map(nameOf).join('、')}</>}
          {branchOf && <>{def.desc || deps.length > 1 ? ' · ' : ''}属于「{branchOf.name}」的「{branchLabel ?? def.branch!.case}」分支</>}
        </div>
      </div>

      {step.rework_reason && (
        <div className="sop-insp-route">
          <span className="sop-insp-route-k">第 {step.round} 轮</span>被退回重做<span className="sop-insp-route-why">{step.rework_reason}</span>
        </div>
      )}
      {def.kind === 'loopback' && !!step.loops && (
        <div className="sop-insp-route">
          <span className="sop-insp-route-k">已退回</span>{step.loops} 轮
          <span className="sop-insp-route-why">最多 {def.config?.max_rounds || 3} 轮，退回「{nameOf(def.config?.target ?? '')}」</span>
        </div>
      )}
      {step.claude && (
        <div className="sop-insp-route">
          <span className="sop-insp-route-k">Claude Code</span>执行 {step.claude.run_id}
          {step.claude.task_id ? (
            <Button size="sm" onClick={() => { void navigate(`/tasks?t=${encodeURIComponent(step.claude!.task_id!)}&run=${encodeURIComponent(step.claude!.run_id)}`) }}>
              在任务里查看这次执行
            </Button>
          ) : <span className="sop-insp-route-why">目录 {step.claude.workdir}；没关联任务，过程不留执行记录，结论在输出里</span>}
        </div>
      )}
      {routeLabel && (
        <div className="sop-insp-route">
          <span className="sop-insp-route-k">判断结果</span>走「{routeLabel}」分支<span className="sop-insp-route-why">{step.route_reason}</span>
        </div>
      )}
      {step.status === 'bypassed' && <div className="sop-banner muted">这一步所在的分支没被选中，没有执行，也没有输入输出。</div>}
      {!run.stopped && isSopProviderWait(step) && (
        <div className="sop-banner warn" role="status">
          <div>
            <b>等服务商恢复</b>服务商「{step.provider_wait!.provider}」不可用（{step.provider_wait!.reason}），这一步已挂起，
            {clock(step.provider_wait!.retry_at)} 自动重跑，服务商恢复后会接着跑这条执行，不新建执行。最多等到执行发起后 24 小时，过了才标失败。
          </div>
          <div className="sop-act-row">
            <Button size="sm" onClick={() => { void navigate(PROVIDERS_SETTINGS_PATH) }}>检查服务商</Button>
          </div>
        </div>
      )}
      {!run.stopped && isSopHeld(step) && (
        <div className="sop-banner danger">
          <div><b>超出上限，已暂停</b>{step.hold!.reason}。放行只放这一次，之后的执行照样按上限拦；要长期放宽到设置里调高上限。</div>
          <div className="sop-act-row">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => onAct({ kind: 'confirm-input', step: index })}>放行这一次</Button>
            <Button size="sm" disabled={busy} onClick={() => onAct({ kind: 'skip', step: index })}>跳过这一步</Button>
            <Button size="sm" onClick={() => { void navigate(SOP_SETTINGS_PATH) }}>调整上限</Button>
          </div>
        </div>
      )}
      {!run.stopped && step.status === 'paused' && !isSopHeld(step) && (
        <div className="sop-banner warn">
          <div><b>执行前暂停</b>这一步要用下面的输入执行。检查一下，有问题可以直接改。</div>
          <div className="sop-act-row">
            {editing ? <>
              <Button variant="primary" size="sm" disabled={busy} onClick={submit}>用修改后的输入执行</Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(false)}>取消修改</Button>
            </> : <>
              <Button variant="primary" size="sm" disabled={busy} onClick={() => onAct({ kind: 'confirm-input', step: index })}>确认并执行</Button>
              <Button variant="outline" size="sm" onClick={() => { setTab('input'); beginEdit(step.input) }}>修改输入</Button>
              {!branching(def) && <Button size="sm" disabled={busy} onClick={() => onAct({ kind: 'skip', step: index })}>跳过这一步</Button>}
            </>}
          </div>
        </div>
      )}
      {!run.stopped && step.status === 'review' && manual && (
        <div className="sop-banner warn">
          <div><b>需要你判断</b>看过下面的输入，选这次走哪个分支。没选中的分支不会执行。</div>
          <div className="sop-act-row">
            {(def.cases ?? []).map((c, n) => (
              <Button key={c.key} variant={n === 0 ? 'primary' : 'outline'} size="sm" disabled={busy}
                onClick={() => onAct({ kind: 'route', step: index, route: c.key })}>走「{c.label}」</Button>
            ))}
          </div>
        </div>
      )}
      {!run.stopped && step.status === 'review' && !manual && (
        <div className="sop-banner warn">
          <div><b>需要你检查</b>确认下面的输出没问题再放行，下游会直接拿它当输入。</div>
          <div className="sop-act-row">
            {editing ? <>
              <Button variant="primary" size="sm" disabled={busy} onClick={submit}>保存修改并放行</Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(false)}>取消修改</Button>
            </> : <>
              <Button variant="primary" size="sm" disabled={busy} onClick={() => onAct({ kind: 'approve', step: index })}>通过，继续执行</Button>
              <Button variant="outline" size="sm" onClick={() => { setTab('output'); beginEdit(step.output) }}>修改输出</Button>
              {upstream.length > 0 && (
                <Button size="sm" disabled={busy} onClick={() => onAct({ kind: 'rework', step: index })}>
                  退回{upstream.length > 1 ? `上游 ${upstream.length} 步` : `「${upstream[0].name}」`}重做
                </Button>
              )}
            </>}
          </div>
        </div>
      )}
      {!run.stopped && step.status === 'failed' && (
        <div className="sop-banner danger">
          <div><b>执行失败</b>{step.error}</div>
          {/* 已按最新流程重跑过的不能再重试、跳过（后端 409），去新执行里处理 */}
          {run.relaunched_to ? (
            <div className="sop-banner-note">这次执行已按最新流程重跑，不能再重试或跳过，到新执行里处理</div>
          ) : (
            <div className="sop-act-row">
              <Button variant="primary" size="sm" disabled={busy} onClick={() => onAct({ kind: 'retry', step: index })}>重试</Button>
              <Button size="sm" disabled={busy} onClick={() => onAct({ kind: 'skip', step: index })}>跳过这一步</Button>
            </div>
          )}
        </div>
      )}
      {queued && (
        <div className="sop-banner muted">
          {step.queue!.slot === 'claude_code' ? <>
            <div><b>排队中</b>在等 Claude Code 名额，前面还有 {step.queue!.ahead} 个。同时跑的 Claude Code 步骤数有上限，多出来的按先来后到排队，排到了自动发起。</div>
            <div className="sop-act-row">
              <Button size="sm" onClick={() => { void navigate(SOP_SETTINGS_PATH) }}>调整同时跑的 Claude Code 步骤数</Button>
            </div>
          </> : <>
            <div><b>排队中</b>在等模型名额，前面还有 {step.queue!.ahead} 个。同时调模型的步骤数有上限，多出来的按先来后到排队，排到了自动开始。</div>
            <div className="sop-act-row">
              <Button size="sm" onClick={() => { void navigate(SOP_SETTINGS_PATH) }}>调整同时调模型的步骤数</Button>
            </div>
          </>}
        </div>
      )}
      {step.status === 'running' && !queued && (
        <div className="sop-banner info">
          <span className="spinner" aria-hidden="true" />正在执行{def.kind === 'ai' ? '，AI 生成中' : ''}…
          {typeof def.ms === 'number' && def.ms > 0 && started > 0 && (
            <div className="sop-run-bar"><span style={{ width: `${Math.min(100, ((now - started) / def.ms) * 100)}%` }} /></div>
          )}
        </div>
      )}

      {step.status !== 'bypassed' && <>
        <div className="sop-insp-tabs">
          <div className="sop-seg sop-seg-sm" role="tablist" aria-label="输入输出日志">
            {(['input', 'output', 'log'] as Tab[]).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className={cls(tab === t && 'on')} onClick={() => { setTab(t); setEditing(false) }}>
                {TAB_LABEL[t]}
                {t === 'log' && <span className="seg-n">{step.log.length}</span>}
              </button>
            ))}
          </div>
          {tab === 'input' && deps.length > 1 && step.input && <span className="sop-insp-note">汇合输入按上游步骤分组</span>}
          <span className="spacer" />
          {tab !== 'log' && data && !editing && <>
            <Button size="sm" onClick={() => setRaw(!raw)}>{raw ? '字段视图' : 'JSON'}</Button>
            <Button size="sm" onClick={copy}>{copied ? '已复制' : '复制'}</Button>
            {editable && <Button variant="outline" size="sm" onClick={() => beginEdit(data)}>修改</Button>}
          </>}
        </div>

        <div className="sop-insp-body">
          {tab === 'log' ? (
            step.log.length ? (
              <ol className="sop-io-log">
                {step.log.map((l, i) => <li key={i}><time dateTime={l.at}>{clock(l.at)}</time>{l.text}</li>)}
              </ol>
            ) : <div className="sop-io-empty">还没有日志</div>
          ) : editing ? (
            <div className="sop-io-edit">
              <textarea spellCheck={false} aria-label={tab === 'input' ? '修改输入' : '修改输出'} value={draft}
                onChange={(e) => { setDraft(e.target.value); setErr('') }} />
              {err ? <div className="field-err" role="alert">{err}</div> : <div className="field-hint-line">改的是 JSON；提交后这一步会标为「人工修改」，执行记录里留痕</div>}
            </div>
          ) : !data ? (
            <div className="sop-io-empty">
              {tab === 'input' ? (deps.length > 1 ? '等汇合的几路上游都完成后，这里会出现它们的输出' : '还没执行到这一步，上游完成后这里会出现它的输入')
                : step.status === 'running' ? '执行完才有输出'
                  : step.status === 'failed' ? '执行失败，没有输出' : '还没有输出'}
            </div>
          ) : raw ? <pre className="sop-io-json sop-io-json-full">{JSON.stringify(data, null, 2)}</pre> : <DataView data={data} />}
        </div>
      </>}
      {(step.started_at || step.attempts > 1) && (
        <div className="sop-insp-foot">
          {step.started_at && <span>开始 {clock(step.started_at)}</span>}
          {step.ended_at && step.started_at && <span>用时 {dur(Date.parse(step.ended_at) - started)}</span>}
          {step.attempts > 1 && <span>执行了 {step.attempts} 次</span>}
        </div>
      )}
    </section>
  )
}

export function RunView({ run, onBack, onAct, onRerun, onOpenRun, busy, actError, branching }: {
  run: SopRun
  onBack: () => void
  /** 请求结束（成功或失败）时 resolve */
  onAct: (a: SopRunAction) => Promise<unknown>
  onRerun: () => void
  /** 打开另一次执行（批量重跑新发起的看原执行） */
  onOpenRun?: (id: string) => void
  busy: boolean
  /** 动作提交失败的原因（SPEC-sop-7.38），已按最新状态读回 */
  actError?: unknown
  branching: (d: SopStepDef) => boolean
}) {
  const flow = run.flow
  const focus = focusIndex(run.steps)
  const [picked, setPicked] = useState<number | null>(null)
  const index = picked !== null && picked < run.steps.length ? picked : focus
  const ended = isEnded(run)
  const waiting = run.steps.filter((x) => needsMe(x.status)).length
  const act = (a: SopRunAction) => { setPicked(null); void onAct(a) }
  // 逐步确认开关：请求回来之前先显示要切成的值，不闪回去
  const [want, setWant] = useState<boolean | null>(null)
  const toggleStepThrough = (on: boolean) => {
    setWant(on)
    void onAct({ kind: 'step-through', on }).finally(() => setWant(null))
  }

  // 执行中每秒走一次：耗时、进度条；不请求后端
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (ended) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [ended])

  const look = runLook(sopRunShow(run))
  const step = run.steps[index]
  const source = useSourceText()(run)
  return (
    <div className="sop-run-view">
      <div className="sop-run-head">
        <Button className="sop-run-back" onClick={onBack}><IconBack />返回</Button>
        <div className="sop-run-head-text">
          <PageTitle parent={run.flow_name} actions={<>
            {picked !== null && picked !== focus && !ended && <Button size="sm" onClick={() => setPicked(null)}>回到当前步骤</Button>}
            {!ended && (
              <Checkbox checked={want ?? run.step_through} disabled={busy} title="每一步执行前停下来，确认输入后再跑"
                onCheckedChange={toggleStepThrough}>逐步确认</Checkbox>
            )}
            {!ended && <Button variant="outline" size="sm" disabled={busy} onClick={() => act({ kind: 'stop' })}>终止执行</Button>}
            {ended && <Button variant="primary" size="sm" onClick={onRerun}>用同样的输入再执行</Button>}
          </>}>{run.title}</PageTitle>
          <div className="sop-run-head-meta">
            <Pill label={look.label} color={look.color} />
            <span>{run.flow_name}</span>
            {source && <span>来源：{source}</span>}
            {/* 批量重跑新发起的记着原执行（source_ref），点了打开原执行 */}
            {run.source === 'manual' && run.source_ref && onOpenRun && (
              <button type="button" className="sop-run-origin" onClick={() => onOpenRun(run.source_ref!)}>重跑自原执行</button>
            )}
            {/* 失败后已按最新流程重跑过的，点了打开重跑出来的新执行 */}
            {run.relaunched_to && onOpenRun && (
              <button type="button" className="sop-run-origin" onClick={() => onOpenRun(run.relaunched_to!)}>已重跑，看新执行</button>
            )}
            <span>开始于 {timeAgo(run.started_at, now)}</span>
            <span>{ended ? '共' : '已'}用时 {runDur(run, now)}</span>
            {waiting > 1 && <span className="sop-run-head-warn">{waiting} 个步骤等你处理</span>}
          </div>
        </div>
      </div>
      {!!actError && <div className="sop-act-error" role="alert">操作没成功：{errorText(actError)}。已按最新状态刷新。</div>}
      <div className="sop-run-flow">
        <FlowGraph flow={flow} run={run} selected={index} branching={branching} onSelect={(i) => setPicked(i === focus ? null : i)} />
      </div>
      {step && <Inspector key={`${index}:${step.status}`} run={run} index={index} onAct={act} busy={busy} now={now} branching={branching} />}
    </div>
  )
}
