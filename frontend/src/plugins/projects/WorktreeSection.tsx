// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 任务详情里的「工作区」（AUTO-07，SPEC-tasks-4.50 起）：经 core/plugin 的对象区块登记，摆在基础信息标签末尾。
// 在用的工作区：执行目录（可复制）、分支、基于哪个提交、端口段、状态；「清理工作区」删掉 worktree（分支合并了才删），
// 有没提交的改动时后端拒绝，按钮换成「强制清理」并二次确认。没有在用的、任务挂了项目且项目设了代码库时给「准备工作区」。
// 任务完成、取消或阶段到已上线时后端自动清理；清理过的只显示最近一条的结果。
// 卡片下面是「最近一次测试」（AUTO-08，TestRunBlock.tsx）：工作区在用时能运行测试；再下面是「最近一次发布」（AUTO-10，ReleaseBlock.tsx），有发布记录才显示。
import { useState } from 'react'
import {
  errorText, useCleanupWorktree, useEventsLive, usePrepareWorktree, useProjectProfile, useTaskWorktrees, worktreeState, type Worktree,
} from '../../core/data'
import type { ObjectSectionProps } from '../../core/plugin'
import { Button, ConfirmDialog, cls } from '../../core/ui'
import { ReleaseBlock } from './ReleaseBlock'
import { TestRunBlock } from './TestRunBlock'
import './worktree.css'

/** 事件流断开时轮询 */
const POLL_MS = 30_000

export default function WorktreeSection({ object }: ObjectSectionProps) {
  const live = useEventsLive()
  const list = useTaskWorktrees(object.id, { refetchInterval: live ? false : POLL_MS })
  const rows = list.data ?? []
  const active = rows.find((w) => w.status === 'active')
  const last = active ?? rows[0]
  if (list.isPending || list.isError) return null
  if (!last && !object.project_id) return null
  return (
    <section className="wt" aria-label="工作区" data-section="worktree">
      <div className="wt-head">
        <span className="wt-title">工作区</span>
        <span className="wt-hint">这条任务专用的 git worktree 和分支，Claude Code 在里面改代码</span>
      </div>
      {last && <WorktreeCard w={last} />}
      {(last || object.project_id) && (
        <TestRunBlock taskId={object.id} projectId={object.project_id ?? last?.project_id ?? ''} canRun={!!active?.exists}
          poll={live ? false : POLL_MS} />
      )}
      {(last || object.project_id) && <ReleaseBlock taskId={object.id} poll={live ? false : POLL_MS} />}
      {!active && object.project_id && <PrepareRow taskId={object.id} projectId={object.project_id} removed={!!last} />}
    </section>
  )
}

function WorktreeCard({ w }: { w: Worktree }) {
  const cleanup = useCleanupWorktree()
  const [confirm, setConfirm] = useState<'normal' | 'force' | null>(null)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)
  const state = worktreeState(w)
  const on = w.status === 'active'
  const dirty = on && !!w.last_error
  const copy = () => {
    navigator.clipboard?.writeText(w.path).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) }, () => {})
  }
  const run = (force: boolean) => {
    setErr('')
    cleanup.mutate({ id: w.id, force }, {
      onSuccess: () => setConfirm(null),
      onError: (e) => { setConfirm(null); setErr(errorText(e)) },
    })
  }
  return (
    <div className={cls('wt-card', !on && 'off')}>
      <dl className="wt-grid">
        <dt>目录</dt>
        <dd className="wt-path">
          <code title={w.path}>{w.path}</code>
          {on && <button type="button" className="wt-copy" onClick={copy} aria-label="复制目录">{copied ? '已复制' : '复制'}</button>}
        </dd>
        <dt>分支</dt>
        <dd><code>{w.branch}</code>{w.base_commit && <span className="wt-muted">（从 {w.base_commit.slice(0, 7)} 拉出）</span>}</dd>
        <dt>端口</dt>
        <dd>{on ? <>{w.port_start}–{w.port_end}<span className="wt-muted">（{w.port_count} 个，测试环境用）</span></> : <span className="wt-muted">已归还</span>}</dd>
        <dt>状态</dt>
        <dd className={cls('wt-state', state.tone)} role={state.tone === 'warn' ? 'alert' : undefined}>{state.text}</dd>
      </dl>
      {on && (
        <div className="wt-actions">
          {dirty
            ? <Button size="sm" variant="danger" onClick={() => setConfirm('force')} disabled={cleanup.isPending}>强制清理</Button>
            : <Button size="sm" variant="outline" onClick={() => setConfirm('normal')} disabled={cleanup.isPending}>清理工作区</Button>}
          <span className="wt-muted">任务完成、取消或上线后会自动清理</span>
        </div>
      )}
      {err && <div className="wt-err" role="alert">清理没成功：{err}</div>}
      <ConfirmDialog open={confirm === 'normal'} title="清理这个工作区？" confirmLabel="清理" busy={cleanup.isPending}
        impacts={[`删掉目录 ${w.root}`, `分支 ${w.branch} 已合并就一起删，没合并保留`, `归还端口 ${w.port_start}–${w.port_end}`]}
        onConfirm={() => run(false)} onCancel={() => setConfirm(null)}>
        有没提交的改动时不会删，会提示你。
      </ConfirmDialog>
      <ConfirmDialog open={confirm === 'force'} danger title="强制清理这个工作区？" confirmLabel="强制清理" busy={cleanup.isPending}
        impacts={[`目录 ${w.root} 里没提交的改动会丢掉`, `分支 ${w.branch} 已合并就一起删，没合并保留`, `归还端口 ${w.port_start}–${w.port_end}`]}
        onConfirm={() => run(true)} onCancel={() => setConfirm(null)}>
        已经提交到分支上的内容不受影响。
      </ConfirmDialog>
    </div>
  )
}

/** 没有在用的工作区：项目设了代码库（或项目目录）时给「准备工作区」 */
function PrepareRow({ taskId, projectId, removed }: { taskId: string; projectId: string; removed: boolean }) {
  const profile = useProjectProfile(projectId)
  const prepare = usePrepareWorktree(taskId)
  const [err, setErr] = useState('')
  const code = profile.data ? (profile.data.code_dir || profile.data.root) : ''
  if (!code && !removed) return null
  return (
    <div className="wt-prep">
      {code
        ? <span className="wt-muted">{removed ? '要接着改就再准备一个' : '还没准备'}：在代码库 <code>{code}</code> 拉分支建 worktree</span>
        : <span className="wt-muted">项目还没设代码库目录，到项目的档案里填</span>}
      {code && (
        <Button size="sm" variant="outline" disabled={prepare.isPending}
          onClick={() => { setErr(''); prepare.mutate(undefined, { onError: (e) => setErr(errorText(e)) }) }}>
          {prepare.isPending ? '准备中…' : '准备工作区'}
        </Button>
      )}
      {err && <div className="wt-err" role="alert">没准备好：{err}</div>}
    </div>
  )
}
