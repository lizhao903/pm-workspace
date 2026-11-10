// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置「执行器」（TSK-0722，SPEC-settings-27）：交给执行时能选的三个执行器装没装、什么版本、缺什么。
// 和分派弹窗用同一份 GET /api/runners；「检测」跳过后端一分钟的缓存重新找可执行文件、跑 --version。
// 缺东西时照后端给的步骤列出来（没装 dsh 时是安装步骤，和 docs/deepseek-harness.md 同一份）。
// DeepSeek 卡片下面是集成检查：选服务商和模型，一键在临时目录里只读跑一次 dsh，逐项看起进程、模型路由、MCP 回写、
// 只读、落库、取消、超时、进程清理过没过；在跑时每 1.5 秒取一次进度，最近一次的结果存在库里，打开就能看到。
import { useState } from 'react'
import {
  errorText, useAgentProviders, useDeepSeekSmoke, useDetectRunners, useRunners, useStartDeepSeekSmoke,
  type RunnerSmoke, type RunnerStatus,
} from '../../../core/data'
import { Button, ErrorState, LoadingState, PageTitle } from '../../../core/ui'
import { dshProviderOptions } from '../../tasks/handoffModel'
import { ProviderModelFields } from '../../tasks/ProviderModelFields'
import { CHECK_MARK, binSourceText, fmtMs, fmtTime, runnerState, smokeSummary } from './runnersModel'
import './runners.css'

export function RunnersSection() {
  const q = useRunners()
  const detect = useDetectRunners()
  const title = (
    <PageTitle parent="设置" desc="交给执行时能选的执行器：装没装、什么版本、缺什么；DeepSeek 可以一键做集成检查">执行器</PageTitle>
  )
  if (q.isPending) return <div className="rnr-page">{title}<LoadingState /></div>
  if (q.isError) return <div className="rnr-page">{title}<ErrorState title="执行器状态没取到" error={errorText(q.error)} onRetry={() => void q.refetch()} /></div>
  const checkedAt = q.data.find((r) => r.harness !== 'agent')?.checked_at
  return (
    <div className="rnr-page">
      {title}
      <div className="rnr-bar">
        <Button size="sm" variant="outline" disabled={detect.isPending} onClick={() => detect.mutate()}>
          {detect.isPending ? '检测中…' : '检测'}
        </Button>
        <span className="rnr-muted">
          {detect.isError ? `没检测成：${errorText(detect.error)}` : `上次检测 ${fmtTime(checkedAt)}；重新找可执行文件、跑一次 --version，结果缓存一分钟`}
        </span>
      </div>
      {q.data.map((st) => <RunnerCard key={st.harness} st={st} />)}
    </div>
  )
}

function RunnerCard({ st }: { st: RunnerStatus }) {
  const state = runnerState(st)
  return (
    <section className="rnr-card" aria-label={st.label} data-harness={st.harness}>
      <div className="rnr-head">
        <b>{st.label}</b>
        <span className={`rnr-state ${state.tone}`}>{state.text}</span>
      </div>
      <dl className="rnr-kv">
        {st.harness !== 'agent' && <>
          <dt>可执行文件</dt>
          <dd><code>{st.bin || '没有'}</code><span className="rnr-muted">（{binSourceText(st)}）</span></dd>
        </>}
        <dt>版本</dt>
        <dd>{st.version || '取不到'}</dd>
        <dt>执行方式</dt>
        <dd>{st.modes.map((m) => (m === 'terminal' ? '切换到终端（要终端插件在跑）' : '后台执行')).join('、')}</dd>
        {st.harness !== 'agent' && <>
          <dt>工作台 MCP</dt>
          <dd>{st.mcp ? '能接上（pmw-run），回写进展和结论' : '接不上，结论写在最后的回复里'}</dd>
        </>}
        {st.harness === 'deepseek' && <>
          <dt>默认服务商</dt>
          <dd>{st.provider_id ? `${st.provider_name}${st.model ? ' · ' + st.model : '（没设模型）'}` : '没有能用的'}</dd>
        </>}
      </dl>
      {st.problems.length > 0 && (
        <ul className="rnr-problems" aria-label={`${st.label} 缺什么`}>
          {st.problems.map((p) => (
            <li key={p.code} className={`rnr-problem${p.blocking ? ' blocking' : ''}`}>
              <div>{p.blocking ? '缺：' : '提示：'}{p.message}</div>
              {p.fix && <div className="rnr-muted">{p.fix}</div>}
              {p.steps.length > 0 && <ol>{p.steps.map((s) => <li key={s}><code>{s}</code></li>)}</ol>}
            </li>
          ))}
        </ul>
      )}
      {st.harness === 'deepseek' && <SmokeBlock st={st} />}
    </section>
  )
}

function SmokeBlock({ st }: { st: RunnerStatus }) {
  const smoke = useDeepSeekSmoke()
  const start = useStartDeepSeekSmoke()
  const providers = useAgentProviders()
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const effProvider = providers.data?.find((p) => p.id === (providerId || st.provider_id))
  const sm = smoke.data
  const running = sm?.status === 'running' || start.isPending
  const go = () => start.mutate({ ...(providerId ? { provider_id: providerId } : {}), ...(model.trim() ? { model: model.trim() } : {}) })
  return (
    <div className="rnr-smoke">
      <div className="rnr-smoke-title">集成检查</div>
      <div className="rnr-muted">
        在系统临时目录里新建一个目录，只读、用固定提示词跑一次 dsh（列目录、经工作台 MCP 回报结论），再起两次验取消和超时；不建任务、不写执行记录，跑完删掉目录。
        会调三次模型，后两次很快被停掉：用真实服务商会花少量额度。
      </div>
      <ProviderModelFields options={dshProviderOptions(providers.data, st)} providerId={providerId} onProvider={setProviderId}
        model={model} onModel={setModel} provider={effProvider} placeholder={effProvider?.model || st.model || '按服务商设置'} />
      <div className="rnr-bar">
        <Button size="sm" variant="primary" disabled={running} onClick={go}>{running ? '检查中…' : '跑一次集成检查'}</Button>
        {start.isError && <span className="rnr-err" role="alert">没发起：{errorText(start.error)}</span>}
      </div>
      {smoke.isError && <span className="rnr-err">上次的结果没取到：{errorText(smoke.error)}</span>}
      {sm ? <SmokeResult sm={sm} /> : smoke.isSuccess && <span className="rnr-muted">还没跑过集成检查</span>}
    </div>
  )
}

function SmokeResult({ sm }: { sm: RunnerSmoke }) {
  return (
    <>
      <div className={sm.status === 'passed' ? 'rnr-ok' : sm.status === 'failed' ? 'rnr-err' : 'rnr-muted'} role="status">
        {smokeSummary(sm)}
      </div>
      <div className="rnr-muted">
        {fmtTime(sm.started_at)} 开始{sm.finished_at ? `，${fmtTime(sm.finished_at)} 结束` : ''} · dsh {sm.version || '版本未知'} ·{' '}
        {sm.provider_name || '默认服务商'} · {sm.model}{sm.session_id ? ` · 会话 ${sm.session_id}` : ''}
      </div>
      <ul className="rnr-checks" aria-label="检查项">
        {sm.checks.map((c) => (
          <li key={c.key} className="rnr-check" data-status={c.status}>
            <span className="rnr-check-mark">{CHECK_MARK[c.status]}</span>
            <span>{c.label}</span>
            <span className="rnr-check-detail">{c.detail}{c.ms ? `（${fmtMs(c.ms)}）` : ''}</span>
          </li>
        ))}
      </ul>
      {sm.conclusion && <><div className="rnr-muted">经 MCP 回报的结论</div><blockquote className="rnr-quote">{sm.conclusion}</blockquote></>}
      {sm.answer && <><div className="rnr-muted">最后的答复</div><blockquote className="rnr-quote">{sm.answer}</blockquote></>}
    </>
  )
}
