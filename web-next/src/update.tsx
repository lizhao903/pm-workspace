// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置 > 版本更新（SPEC-settings-23，SYS-UPD）。正式产品 frontend/src/modules/settings/update/UpdateSection.tsx。
// 原型没有后端：正在运行一个旧提交、源码目录多 3 条提交，点更新后按步骤假装推进，最后显示「已更新」（不真的刷新页面）。
// 「让第二步失败」是演示开关，勾上后构建前端那一步失败，旧版本不动。
import { useEffect, useRef, useState } from 'react'
import { PageTitle } from './topbar'
import { cls } from './ui'

type StepState = 'pending' | 'running' | 'done' | 'failed'
type Commit = { sha: string; subject: string; at: string }

const STEP_LABELS = ['备份数据库', '构建前端', '构建后端和 MCP', '自检新版本', '替换并重启']
const STEP_STATE: Record<StepState, string> = { pending: '等待', running: '进行中', done: '完成', failed: '失败' }
/** 演示里每步走多久 */
const STEP_MS = 900

const RUNNING = { version: 'dev', commit: '8d9ff0cd7c46', modified: true, commit_at: '2026-10-31T15:27:43Z', binary: '/Users/me/pm-workspace/bin/pmw-dev' }
const AHEAD: Commit[] = [
  { sha: '440999e2a1b3', subject: 'chore: 工作台 MCP 指向 7796', at: '2026-11-03T01:12:00Z' },
  { sha: '3fb77ce91c04', subject: 'chore(release): 版本号升到 0.2.0', at: '2026-11-02T09:40:00Z' },
  { sha: '91c677a5d2e8', subject: 'docs: 原型与规格同步，接口契约与插件接口文档更新', at: '2026-11-01T14:05:00Z' },
]
const SOURCE = { repo: '/Users/me/pm-workspace', branch: 'main', dirty: 3 }

const short = (sha: string) => sha.slice(0, 7)
const when = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function UpdatePage() {
  const [commit, setCommit] = useState(RUNNING.commit)
  const [steps, setSteps] = useState<StepState[] | null>(null)
  const [phase, setPhase] = useState<'idle' | 'running' | 'restarting' | 'updated' | 'failed'>('idle')
  const [asking, setAsking] = useState(false)
  const [failDemo, setFailDemo] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [log, setLog] = useState('')
  const timer = useRef<number | null>(null)
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  const updated = commit !== RUNNING.commit
  const ahead = updated ? [] : AHEAD
  const available = !updated
  const busy = phase === 'running' || phase === 'restarting'

  const advance = (i: number, cur: StepState[]) => {
    if (i >= STEP_LABELS.length) return
    const next = cur.map((s, k) => (k === i ? 'running' : s)) as StepState[]
    setSteps(next)
    if (i === STEP_LABELS.length - 1) {
      setPhase('restarting')
      timer.current = window.setTimeout(() => { setCommit(AHEAD[0].sha); setPhase('updated'); setSteps(null) }, STEP_MS * 2)
      return
    }
    timer.current = window.setTimeout(() => {
      if (i === 1 && failDemo) {
        setSteps(next.map((s, k) => (k === i ? 'failed' : s)) as StepState[])
        setLog((l) => `${l}$ make frontend\nnpm ERR! 构建失败（演示）\n失败：make frontend 失败：exit status 2\n正在跑的旧版本没有动。\n`)
        setPhase('failed')
        return
      }
      setLog((l) => l + [`已备份到 ${SOURCE.repo}/data-dev/backups/pm-20261103-0712.db\n`, '$ make frontend\n已把 frontend/dist 拷进 internal/webui/dist\n', '$ go build -ldflags -X main.version=dev -o bin/pmw-dev.new ./cmd/pmw\n$ go build -o bin/pmw-mcp-dev.new ./cmd/pmw-mcp\n', '新程序 -h 能跑\n'][i])
      const done = next.map((s, k) => (k === i ? 'done' : s)) as StepState[]
      advance(i + 1, done)
    }, STEP_MS)
  }

  const go = () => {
    setAsking(false)
    setShowLog(false)
    setLog('')
    setPhase('running')
    advance(0, STEP_LABELS.map(() => 'pending'))
  }

  return (
    <div className="page page-fill up-page">
      <PageTitle parent="设置" desc="把工作台更新到本机源码目录里的最新代码，并自动重启">版本更新</PageTitle>
      <div className="up-grid">
        <section className="up-card" aria-label="正在运行">
          <div className="section-label">正在运行</div>
          <div><b>{short(commit)}</b>{!updated && RUNNING.modified && <span className="up-tag">编译时带未提交改动</span>}</div>
          <div className="list-sub">版本 {RUNNING.version} · 提交于 {when(updated ? AHEAD[0].at : RUNNING.commit_at)}</div>
          <div className="up-mono">{RUNNING.binary}</div>
        </section>
        <section className="up-card" aria-label="源码目录">
          <div className="section-label">源码目录</div>
          <div><b>{short(AHEAD[0].sha)}</b> {AHEAD[0].subject}</div>
          <div className="list-sub">分支 {SOURCE.branch} · 提交于 {when(AHEAD[0].at)}{!updated && SOURCE.dirty ? ` · ${SOURCE.dirty} 个文件有未提交的改动` : ''}</div>
          <div className="up-mono">{SOURCE.repo}</div>
        </section>
      </div>
      {ahead.length > 0 && (
        <section className="up-commits" aria-label="新提交">
          <div className="section-label">新提交 {ahead.length} 条</div>
          <ul>
            {ahead.map((c) => <li key={c.sha}><span className="up-sha">{short(c.sha)}</span><span className="up-subject">{c.subject}</span><span className="list-sub">{when(c.at)}</span></li>)}
          </ul>
        </section>
      )}

      {phase === 'updated' && <div className="up-banner up-ok" role="status">已更新到 {short(commit)}，正在刷新页面…（原型不真的刷新）</div>}
      {phase === 'restarting' && <div className="up-banner" role="status">新版本已经换上，工作台正在重启，几秒后自动连上…</div>}

      {steps && (
        <section className="up-progress" aria-label="更新进度">
          <ol>
            {steps.map((s, i) => (
              <li key={STEP_LABELS[i]} className={cls('up-step', `up-${s}`)}>
                <span className="up-dot" aria-hidden="true" /><span>{STEP_LABELS[i]}</span><span className="list-sub">{STEP_STATE[s]}{i === 4 && s === 'running' ? ' · 正在重启' : ''}</span>
              </li>
            ))}
          </ol>
          {phase === 'failed' && <div className="danger-text" role="alert">更新没成：make frontend 失败：exit status 2。正在跑的旧版本没有动。</div>}
          {log && (
            <>
              <button className="link-btn up-log-toggle" onClick={() => setShowLog(!showLog)}>{showLog ? '收起构建日志' : '查看构建日志'}</button>
              {showLog && <pre className="up-log" aria-label="构建日志">{log}</pre>}
            </>
          )}
        </section>
      )}

      {phase !== 'restarting' && phase !== 'updated' && (
        <div className="up-actions">
          <button className="act act-primary" disabled={busy || !available} onClick={() => setAsking(true)}>
            {phase === 'running' ? '正在更新…' : phase === 'failed' ? '重新更新' : '更新到最新版本'}
          </button>
          {!available && !busy && <span className="list-sub">已经是最新版本</span>}
          <label className="up-demo list-sub"><input type="checkbox" checked={failDemo} disabled={busy} onChange={(e) => setFailDemo(e.target.checked)} /> 演示：让第二步失败</label>
        </div>
      )}
      {phase === 'updated' && <div className="up-actions"><span className="list-sub">已经是最新版本</span></div>}

      {asking && (
        <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) setAsking(false) }}>
          <div className="qs" role="alertdialog" aria-label="更新到最新版本">
            <div className="qs-head"><b>更新到最新版本</b></div>
            <div>构建要几分钟，期间工作台照常能用。</div>
            <div className="section-label">会发生什么</div>
            <ul className="up-impacts">
              <li>先备份数据库到数据目录的 backups/</li>
              <li>用源码目录里的当前代码重新构建前端、后端和 MCP（含 {SOURCE.dirty} 个文件的未提交改动）</li>
              <li>构建、自检都过了才替换程序（旧的留成 .prev），然后重启工作台，页面会断开几秒</li>
              <li>正在跑的 Agent 对话、任务执行、终端会话会中断</li>
              <li>任何一步失败都不替换，旧版本照常在跑</li>
            </ul>
            <div className="act-row">
              <span className="spacer" />
              <button className="act act-quiet" onClick={() => setAsking(false)}>取消</button>
              <button className="act act-primary" onClick={go}>开始更新</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
