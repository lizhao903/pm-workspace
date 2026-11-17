// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置 > 执行器（TSK-0722，SPEC-settings-27）：交给执行时能选的三个执行器装没装、什么版本、缺什么。
// 正式产品 frontend/src/modules/settings/runners/，和分派弹窗用同一份 GET /api/runners；「检测」跳过后端一分钟的缓存重新找可执行文件。
// DeepSeek 卡片下面是集成检查：选服务商和模型，在临时目录里只读跑一次 dsh，逐项看起进程、模型路由、MCP 回写、只读、落库、取消、超时、进程清理。
// 原型没有后端：演示数据里上一次集成检查「MCP 回写」失败，再跑一次按步骤推进、全部通过；勾「演示：没装 dsh」看缺东西时的安装步骤。
import { useEffect, useRef, useState } from 'react'
import type { ModelConf, Provider } from './modeldata'
import { PageTitle } from './topbar'
import { cls } from './ui'
import './setx.css'

type RunHarness = 'claude' | 'deepseek' | 'agent'
type RunnerProblem = { code: string; message: string; fix: string; steps: string[]; blocking: boolean }
/** GET /api/runners 的一项，顺序固定 claude、deepseek、agent */
export interface RunnerStatus {
  harness: RunHarness
  label: string
  available: boolean
  modes: ('stream' | 'terminal')[]
  bin: string
  bin_source: 'flag' | 'path' | 'builtin'
  version: string
  mcp: boolean
  provider_id: string
  provider_name: string
  model: string
  problems: RunnerProblem[]
  checked_at: string
}
type SmokeCheck = { key: string; label: string; status: 'pending' | 'running' | 'pass' | 'fail' | 'skip'; detail: string; ms: number }
export interface RunnerSmoke {
  status: 'running' | 'passed' | 'failed'
  started_at: string
  finished_at: string | null
  version: string
  provider_name: string
  model: string
  session_id: string
  conclusion: string
  answer: string
  checks: SmokeCheck[]
}

const CHECK_LABELS: [string, string][] = [
  ['spawn', '起进程'], ['model', '模型路由'], ['mcp', 'MCP 回写'], ['readonly', '只读'],
  ['persist', '落库'], ['cancel', '取消'], ['timeout', '超时'], ['cleanup', '进程清理'],
]
const PASS_DETAIL: Record<string, [string, number]> = {
  spawn: ['dsh 起来了', 40], model: ['按所选服务商和模型路由', 2300], mcp: ['经 pmw-run 回报了结论', 5100], readonly: ['写文件被沙箱拦下', 0],
  persist: ['会话落到 dsh 自己的库里', 0], cancel: ['发停止后 1.2 秒退出', 1200], timeout: ['到点被停掉', 3000], cleanup: ['进程组都退了', 0],
}
const CHECK_MARK: Record<SmokeCheck['status'], string> = { pass: '通过', fail: '失败', skip: '跳过', running: '进行中', pending: '等待' }

const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString()
const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '')
const fmtMs = (ms: number) => (ms < 100 ? '' : ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`)

function binSourceText(st: RunnerStatus) {
  if (st.bin_source === 'builtin') return '工作台自己，不起外部进程'
  if (st.bin_source === 'flag') return st.harness === 'deepseek' ? '启动参数 --dsh-bin 或环境变量 DSH_BIN 指定' : '启动时指定'
  return '按名字在 PATH 里找'
}
function runnerState(st: RunnerStatus): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  if (!st.available) return { text: '不可用', tone: 'bad' }
  if (st.problems.length) return { text: '可用，有提示', tone: 'warn' }
  return { text: '可用', tone: 'ok' }
}
function smokeSummary(sm: RunnerSmoke) {
  if (sm.status === 'running') return `检查中：${sm.checks.filter((c) => c.status !== 'pending' && c.status !== 'running').length} / ${sm.checks.length} 项有结果`
  const failed = sm.checks.filter((c) => c.status !== 'pass')
  return failed.length ? `${failed.length} 项没通过：${failed.map((c) => c.label).join('、')}` : `全部 ${sm.checks.length} 项通过`
}

/** 没装 dsh 时的安装步骤：和后端 internal/api/runners.go 的 dshInstallSteps、docs/deepseek-harness.md「二、装 dsh」同一份 */
const DSH_STEPS = [
  'npm i --prefix ~/.local/share/pmw-dsh @deepseek-ai/dsh',
  '启动工作台时加 --dsh-bin ~/.local/share/pmw-dsh/node_modules/.bin/dsh（或设环境变量 DSH_BIN 为同一路径），重启工作台',
  '到「设置 / 模型服务商」配一个 DeepSeek（OpenAI 兼容，Base URL https://api.deepseek.com，填 API Key 和模型）',
  '回到「设置 / 执行器」点「检测」，再跑一次集成检查',
]
const DSH_HINT = '先装 deepseek-harness（npm i --prefix <目录> @deepseek-ai/dsh），再在启动工作台时用 --dsh-bin <目录>/node_modules/.bin/dsh 或环境变量 DSH_BIN 指定；也可以装进 PATH'

/** 演示数据：三张卡片；noDsh 时 DeepSeek 没装 */
function demoRunners(providers: Provider[], models: ModelConf[], noDsh: boolean): RunnerStatus[] {
  const at = new Date().toISOString()
  const pv = providers.find((p) => p.enabled && p.status === 'ok')
  const model = models.find((m) => m.provider_id === pv?.id && m.enabled)?.id ?? ''
  return [
    { harness: 'claude', label: 'Claude Code', available: true, modes: ['stream', 'terminal'], bin: '/usr/local/bin/claude', bin_source: 'path', version: '2.1.4 (Claude Code)', mcp: true, provider_id: '', provider_name: '', model: '', problems: [], checked_at: at },
    noDsh
      ? { harness: 'deepseek', label: 'DeepSeek', available: false, modes: ['stream'], bin: '', bin_source: 'path', version: '', mcp: true, provider_id: pv?.id ?? '', provider_name: pv?.name ?? '', model, checked_at: at,
        problems: [{ code: 'not_installed', message: '找不到 dsh 可执行文件', fix: DSH_HINT, blocking: true, steps: DSH_STEPS }] }
      : { harness: 'deepseek', label: 'DeepSeek', available: true, modes: ['stream'], bin: '/usr/local/bin/dsh', bin_source: 'path', version: 'dsh 0.9.2', mcp: true, provider_id: pv?.id ?? '', provider_name: pv?.name ?? '', model, checked_at: at,
        problems: model ? [] : [{ code: 'no_model', message: `服务商「${pv?.name ?? ''}」没设模型`, fix: '到「设置 / 模型服务商」给它填一个模型，或在分派时指定模型', steps: [], blocking: false }] },
    { harness: 'agent', label: '工作台 Agent', available: true, modes: ['stream'], bin: '', bin_source: 'builtin', version: '随工作台', mcp: true, provider_id: '', provider_name: '', model: '', problems: [], checked_at: at },
  ]
}

const seedSmoke = (): RunnerSmoke => ({
  status: 'failed', started_at: minsAgo(60 * 26), finished_at: minsAgo(60 * 26 - 1), version: 'dsh 0.9.2', provider_name: '本机 Ollama', model: 'qwen2.5-coder:14b', session_id: 'dsh-3f9a2c',
  conclusion: '', answer: '目录里有 README.md 和 notes.txt 两个文件。',
  checks: CHECK_LABELS.map(([key, label]) => key === 'mcp'
    ? { key, label, status: 'fail', detail: '没收到 pmw_finish_run：模型没调工作台 MCP（这个模型可能不支持工具调用）', ms: 0 }
    : { key, label, status: 'pass', detail: PASS_DETAIL[key][0], ms: PASS_DETAIL[key][1] }),
})

export function RunnersPage({ providers, models }: { providers: Provider[]; models: ModelConf[] }) {
  const [noDsh, setNoDsh] = useState(false)
  const [checkedAt, setCheckedAt] = useState(() => minsAgo(3))
  const [detecting, setDetecting] = useState(false)
  const list = demoRunners(providers, models, noDsh)
  const detect = () => { setDetecting(true); window.setTimeout(() => { setDetecting(false); setCheckedAt(new Date().toISOString()) }, 700) }
  return (
    <div className="page setx-page">
      <PageTitle parent="设置" desc="交给执行时能选的执行器：装没装、什么版本、缺什么；DeepSeek 可以一键做集成检查">执行器</PageTitle>
      <div className="setx-bar">
        <button className="act" disabled={detecting} onClick={detect}>{detecting ? '检测中…' : '检测'}</button>
        <span className="muted setx-sm">上次检测 {fmtTime(checkedAt)}；重新找可执行文件、跑一次 --version，结果缓存一分钟</span>
        <span className="spacer" />
        <label className="list-sub setx-demo"><input type="checkbox" checked={noDsh} onChange={(e) => setNoDsh(e.target.checked)} /> 演示：没装 dsh</label>
      </div>
      {list.map((st) => <RunnerCard key={st.harness} st={st} providers={providers} models={models} />)}
    </div>
  )
}

function RunnerCard({ st, providers, models }: { st: RunnerStatus; providers: Provider[]; models: ModelConf[] }) {
  const state = runnerState(st)
  return (
    <section className="setx-card" aria-label={st.label} data-harness={st.harness}>
      <div className="setx-card-head">
        <b>{st.label}</b>
        <span className={cls('rnr-state', state.tone)}>{state.text}</span>
      </div>
      <dl className="setx-kv">
        {st.harness !== 'agent' && <><dt>可执行文件</dt><dd><code>{st.bin || '没有'}</code><span className="muted">（{binSourceText(st)}）</span></dd></>}
        <dt>版本</dt><dd>{st.version || '取不到'}</dd>
        <dt>执行方式</dt><dd>{st.modes.map((m) => (m === 'terminal' ? '切换到终端（要终端插件在跑）' : '后台执行')).join('、')}</dd>
        {st.harness !== 'agent' && <><dt>工作台 MCP</dt><dd>{st.mcp ? '能接上（pmw-run），回写进展和结论' : '接不上，结论写在最后的回复里'}</dd></>}
        {st.harness === 'deepseek' && <><dt>默认服务商</dt><dd>{st.provider_id ? `${st.provider_name}${st.model ? ' · ' + st.model : '（没设模型）'}` : '没有能用的'}</dd></>}
      </dl>
      {st.problems.length > 0 && (
        <ul className="rnr-problems" aria-label={`${st.label} 缺什么`}>
          {st.problems.map((p) => (
            <li key={p.code} className={cls('rnr-problem', p.blocking && 'blocking')}>
              <div>{p.blocking ? '缺：' : '提示：'}{p.message}</div>
              {p.fix && <div className="muted">{p.fix}</div>}
              {p.steps.length > 0 && <ol>{p.steps.map((s) => <li key={s}><code>{s}</code></li>)}</ol>}
            </li>
          ))}
        </ul>
      )}
      {st.harness === 'deepseek' && <SmokeBlock st={st} providers={providers} models={models} />}
    </section>
  )
}

function SmokeBlock({ st, providers, models }: { st: RunnerStatus; providers: Provider[]; models: ModelConf[] }) {
  const [sm, setSm] = useState<RunnerSmoke>(seedSmoke)
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const timer = useRef<number | null>(null)
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])
  const pid = providerId || st.provider_id
  const pv = providers.find((p) => p.id === pid)
  const running = sm.status === 'running'
  const go = () => {
    const effModel = model.trim() || models.find((m) => m.provider_id === pid && m.enabled)?.id || st.model
    let cur: RunnerSmoke = { status: 'running', started_at: new Date().toISOString(), finished_at: null, version: st.version, provider_name: pv?.name ?? '', model: effModel, session_id: '', conclusion: '', answer: '',
      checks: CHECK_LABELS.map(([key, label], i) => ({ key, label, status: i === 0 ? 'running' : 'pending', detail: '', ms: 0 })) }
    setSm(cur)
    // 在跑时正式产品每 1.5 秒取一次进度；原型每 0.6 秒推进一项，全部通过
    const step = (i: number) => {
      timer.current = window.setTimeout(() => {
        const checks = cur.checks.map((c, k) => (k === i ? { ...c, status: 'pass' as const, detail: PASS_DETAIL[c.key][0], ms: PASS_DETAIL[c.key][1] } : k === i + 1 ? { ...c, status: 'running' as const } : c))
        const last = i === checks.length - 1
        cur = { ...cur, checks, ...(last && { status: 'passed', finished_at: new Date().toISOString(), session_id: `dsh-${Date.now().toString(16).slice(-6)}`,
          conclusion: '临时目录里有 README.md 和 notes.txt，只读执行，没有改动。', answer: '已列出目录并经工作台 MCP 回报结论。' }) }
        setSm(cur)
        if (!last) step(i + 1)
      }, 600)
    }
    step(0)
  }
  const pvModels = models.filter((m) => m.provider_id === pid && m.enabled)
  return (
    <div className="rnr-smoke">
      <div className="rnr-smoke-title">集成检查</div>
      <div className="muted setx-sm">
        在系统临时目录里新建一个目录，只读、用固定提示词跑一次 dsh（列目录、经工作台 MCP 回报结论），再起两次验取消和超时；不建任务、不写执行记录，跑完删掉目录。
        会调三次模型，后两次很快被停掉：用真实服务商会花少量额度。
      </div>
      <div className="setx-grid2">
        <label className="field">
          <span className="field-label">服务商</span>
          <select className="select" value={providerId} onChange={(e) => { setProviderId(e.target.value); setModel('') }}>
            <option value="">默认（{st.provider_name ? `${st.provider_name}${st.model ? ` · ${st.model}` : ''}` : '没有能用的'}）</option>
            {providers.filter((p) => p.enabled).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">模型</span>
          <input list="rnr-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder={pvModels[0]?.id || st.model || '按服务商设置'} />
          <datalist id="rnr-models">{pvModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
        </label>
      </div>
      <div className="setx-bar">
        <button className="act act-primary" disabled={running || !st.available} onClick={go}>{running ? '检查中…' : '跑一次集成检查'}</button>
        {!st.available && <span className="danger-text setx-sm">dsh 没装好，先按上面的步骤装</span>}
      </div>
      <div className={sm.status === 'passed' ? 'rnr-ok' : sm.status === 'failed' ? 'danger-text' : 'muted'} role="status">{smokeSummary(sm)}</div>
      <div className="muted setx-sm">
        {fmtTime(sm.started_at)} 开始{sm.finished_at ? `，${fmtTime(sm.finished_at)} 结束` : ''} · {sm.version || 'dsh 版本未知'} · {sm.provider_name || '默认服务商'} · {sm.model}{sm.session_id ? ` · 会话 ${sm.session_id}` : ''}
      </div>
      <ul className="rnr-checks" aria-label="检查项">
        {sm.checks.map((c) => (
          <li key={c.key} className="rnr-check" data-status={c.status}>
            <span className="rnr-check-mark">{CHECK_MARK[c.status]}</span>
            <span>{c.label}</span>
            <span className="rnr-check-detail">{c.detail}{fmtMs(c.ms) ? `（${fmtMs(c.ms)}）` : ''}</span>
          </li>
        ))}
      </ul>
      {sm.conclusion && <><div className="muted setx-sm">经 MCP 回报的结论</div><blockquote className="rnr-quote">{sm.conclusion}</blockquote></>}
      {sm.answer && <><div className="muted setx-sm">最后的答复</div><blockquote className="rnr-quote">{sm.answer}</blockquote></>}
    </div>
  )
}
