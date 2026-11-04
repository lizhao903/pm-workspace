// 设置「版本更新」（SYS-UPD）：正在跑的版本、源码目录比它新多少，「更新到最新版本」按固定几步更新并原地重启。
// 「最新版本」是本机源码目录里的当前代码（含未提交的改动），仓库没有远端，不拉代码。
// 点了先确认；之后轮询进度，重启那几秒请求失败照样等；新进程起来（最近一次更新没了）就算成功，几秒后自动刷新页面换上新前端。
// 任何一步失败旧版本照常在跑，页面写清哪一步、为什么，日志能展开看。
import { useEffect, useState } from 'react'
import { errorText, useStartUpdate, useUpdateStatus, type UpdateCommit, type UpdateStatus, type UpdateStep } from '../../../core/data'
import { Button, ConfirmDialog, ErrorState, LoadingState, PageTitle, cls } from '../../../core/ui'
import './update.css'

/** 新进程起来后几秒自动刷新页面 */
const RELOAD_MS = 2000

const short = (sha: string) => sha.slice(0, 7)
const when = (iso: string) => (iso ? new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')
const STEP_STATE: Record<UpdateStep['state'], string> = { pending: '等待', running: '进行中', done: '完成', failed: '失败', skipped: '跳过' }

/** 跟进中的这次更新：点了之后记下来；seen 是已经看到过这次的进度（之后进度没了才算新进程起来，避免拿旧数据误判） */
type Follow = { seen: boolean }

export function UpdateSection({ reload = () => window.location.reload() }: { reload?: () => void }) {
  const [follow, setFollow] = useState<Follow | null>(null)
  const q = useUpdateStatus(!!follow)
  const start = useStartUpdate()
  const [asking, setAsking] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const st = q.data
  const job = st?.job ?? null
  // 点了更新、请求在失败（重启中）或者已经是新进程（job 没了）：按阶段显示
  const restarting = !!follow?.seen && (q.isError || job?.state === 'restarting')
  const updated = !!follow?.seen && !!st && !job && !q.isError && !start.isPending
  useEffect(() => { if (follow && !follow.seen && job) setFollow({ seen: true }) }, [follow, job])
  useEffect(() => {
    if (!updated) return
    const t = window.setTimeout(reload, RELOAD_MS)
    return () => window.clearTimeout(t)
  }, [updated, reload])
  // 失败了就不再跟进（轮询停），页面留着结果
  useEffect(() => { if (follow && job?.state === 'failed') setFollow(null) }, [follow, job?.state])

  const go = () => {
    setAsking(false)
    start.mutate(undefined, {
      onSuccess: (r) => {
        setShowLog(false)
        // 回来的状态里就有这次的进度，直接算看到过
        setFollow({ seen: !!r.job })
      },
    })
  }

  if (!st && q.isPending) return <div className="up-page"><PageTitle parent="设置">版本更新</PageTitle><LoadingState /></div>
  if (!st && !follow) {
    return (
      <div className="up-page">
        <PageTitle parent="设置">版本更新</PageTitle>
        <ErrorState title="版本信息没取到" error={errorText(q.error)} onRetry={() => void q.refetch()} />
      </div>
    )
  }

  const busy = job?.state === 'running' || restarting || start.isPending
  return (
    <div className="up-page">
      <PageTitle parent="设置" desc="把工作台更新到本机源码目录里的最新代码，并自动重启">版本更新</PageTitle>
      {st && <Versions st={st} />}

      {updated ? (
        <div className="up-banner up-ok" role="status">已更新到 {short(st!.running.commit)}，正在刷新页面…
          <Button size="sm" onClick={reload}>现在刷新</Button>
        </div>
      ) : restarting ? (
        <div className="up-banner" role="status">新版本已经换上，工作台正在重启，几秒后自动连上…</div>
      ) : null}

      {job && !updated && <Progress job={job} showLog={showLog} onToggleLog={() => setShowLog(!showLog)} />}

      {!updated && !restarting && (
        <div className="up-actions">
          <Button variant="primary" disabled={busy || !!st?.blocked || !st?.available} onClick={() => { start.reset(); setAsking(true) }}>
            {job?.state === 'running' ? '正在更新…' : job?.state === 'failed' ? '重新更新' : '更新到最新版本'}
          </Button>
          {st?.blocked ? <span className="up-muted">{st.blocked}</span>
            : !st?.available && !busy ? <span className="up-muted">已经是最新版本</span> : null}
          {start.isError && <span className="danger-text" role="alert">没开始：{errorText(start.error)}</span>}
        </div>
      )}

      <ConfirmDialog open={asking} title="更新到最新版本" confirmLabel="开始更新" onConfirm={go} onCancel={() => setAsking(false)}
        impactsTitle="会发生什么" impacts={[
          '先备份数据库到数据目录的 backups/',
          `用源码目录里的当前代码重新构建前端、后端和 MCP${st?.source?.dirty ? `（含 ${st.source.dirty} 个文件的未提交改动）` : ''}`,
          '构建、自检都过了才替换程序（旧的留成 .prev），然后重启工作台，页面会断开几秒',
          '正在跑的 Agent 对话、任务执行、终端会话会中断',
          '任何一步失败都不替换，旧版本照常在跑',
        ]}>
        构建要几分钟，期间工作台照常能用。
      </ConfirmDialog>
    </div>
  )
}

function Versions({ st }: { st: UpdateStatus }) {
  const r = st.running
  const src = st.source
  const ahead = src?.ahead ?? []
  return (
    <>
      <div className="up-grid">
        <section className="up-card" aria-label="正在运行">
          <div className="up-label">正在运行</div>
          <div><b>{r.commit ? short(r.commit) : '未知提交'}</b>{r.modified && <span className="up-tag">编译时带未提交改动</span>}</div>
          <div className="up-muted">版本 {r.version}{r.commit_at ? ` · 提交于 ${when(r.commit_at)}` : ''}</div>
          {r.binary && <div className="up-mono">{r.binary}</div>}
        </section>
        <section className="up-card" aria-label="源码目录">
          <div className="up-label">源码目录</div>
          {src?.head ? (
            <>
              <div><b>{short(src.head.sha)}</b> <span className="up-subject">{src.head.subject}</span></div>
              <div className="up-muted">分支 {src.branch} · 提交于 {when(src.head.at)}{src.dirty > 0 ? ` · ${src.dirty} 个文件有未提交的改动` : ''}</div>
              <div className="up-mono">{src.repo}</div>
            </>
          ) : <div className="up-muted">{st.blocked || '没找到源码目录'}</div>}
        </section>
      </div>
      {src?.diverged && <div className="up-muted">正在运行的提交不在当前分支的历史里（换过分支或改过历史），列不出新提交，更新后以源码目录为准</div>}
      {ahead.length > 0 && (
        <section className="up-commits" aria-label="新提交">
          <div className="up-label">新提交 {src!.ahead_total} 条</div>
          <ul>
            {ahead.map((c: UpdateCommit) => (
              <li key={c.sha}><span className="up-sha">{short(c.sha)}</span><span className="up-subject">{c.subject}</span><span className="up-muted">{when(c.at)}</span></li>
            ))}
          </ul>
          {src!.ahead_total > ahead.length && <div className="up-muted">还有 {src!.ahead_total - ahead.length} 条更早的</div>}
        </section>
      )}
    </>
  )
}

function Progress({ job, showLog, onToggleLog }: { job: NonNullable<UpdateStatus['job']>; showLog: boolean; onToggleLog: () => void }) {
  return (
    <section className="up-progress" aria-label="更新进度">
      <ol>
        {job.steps.map((s) => (
          <li key={s.key} className={cls('up-step', `up-${s.state}`)}>
            <span className="up-dot" aria-hidden="true" />
            <span>{s.label}</span>
            <span className="up-muted">{STEP_STATE[s.state]}{s.note ? ` · ${s.note}` : ''}</span>
          </li>
        ))}
      </ol>
      {job.state === 'failed' && <div className="danger-text" role="alert">更新没成：{job.error}。正在跑的旧版本没有动。</div>}
      {job.log && (
        <>
          <button type="button" className="link-btn up-log-toggle" onClick={onToggleLog}>{showLog ? '收起构建日志' : '查看构建日志'}</button>
          {showLog && <pre className="up-log" aria-label="构建日志">{job.log}</pre>}
        </>
      )}
    </section>
  )
}
