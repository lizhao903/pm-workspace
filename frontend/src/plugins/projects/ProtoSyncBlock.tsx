// 档案标签末尾的「原型同步」（AUTO-11，SPEC-projects-15.17 到 15.28）：以上线代码为准回写原型库和规格。
// 同步点（代码提交和原型库同步分支提交的对应）、三种触发的开关（默认都关）、立即同步 / 设为基线、
// 最近一次结果（差异清单按五类，带规格的实现状态）、规格实现状态一览、同步历史。
// 拿不准的差异在 SOP 执行页的「产品裁决」里定，这里只给入口；同步分支由产品看过差异清单后自己合并，这里不合并。
import { useState } from 'react'
import { useNavigate } from 'react-router'
import {
  DECISION_LABEL, IMPL_STATUS_LABEL, PROTO_SYNC_KIND_LABEL, PROTO_SYNC_STATUS_LABEL, PROTO_SYNC_TRIGGER_LABEL, errorText, implTone, protoSyncSummary, protoSyncTone,
  shortSha, specStatuses, useCancelProtoSync, useProtoSyncHistory, useProtoSyncState, useSaveProtoSyncSettings, useTriggerProtoSync,
  type ProtoSync, type ProtoSyncSettingsPatch,
} from '../../core/data'
import { Button, ConfirmDialog, Switch, cls } from '../../core/ui'
import './worktree.css'
import './protosync.css'

/** 进行中多久取一次（事件流也会推，这是兜底） */
const RUNNING_POLL_MS = 3_000
const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/

const when = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function ProtoSyncBlock({ projectId }: { projectId: string }) {
  const navigate = useNavigate()
  const state = useProtoSyncState(projectId, (s) => (s?.active ? RUNNING_POLL_MS : false))
  const history = useProtoSyncHistory(projectId)
  const save = useSaveProtoSyncSettings(projectId)
  const trigger = useTriggerProtoSync(projectId)
  const cancel = useCancelProtoSync()
  const [err, setErr] = useState('')
  const [askBaseline, setAskBaseline] = useState(false)
  const [dailyAt, setDailyAt] = useState<string | null>(null)
  const [branch, setBranch] = useState<string | null>(null)

  const s = state.data
  if (state.isError) {
    return (
      <section className="pj-block" aria-label="原型同步">
        <h2 className="pj-sec-title">原型同步</h2>
        <div className="field-err" role="alert">原型同步没加载出来：{errorText(state.error)} <button type="button" className="pj-link" onClick={() => void state.refetch()}>重试</button></div>
      </section>
    )
  }
  if (!s) return null
  const st = s.settings
  const put = (patch: ProtoSyncSettingsPatch) => {
    setErr('')
    save.mutate(patch, { onError: (e) => setErr(`没保存上：${errorText(e)}`) })
  }
  const run = (mode: 'sync' | 'baseline') => {
    setErr('')
    trigger.mutate(mode, { onError: (e) => setErr(errorText(e)), onSettled: () => setAskBaseline(false) })
  }
  const dailyVal = dailyAt ?? st.daily_at
  const dailyBad = !CLOCK_RE.test(dailyVal.trim())
  const branchVal = branch ?? st.branch
  const active = s.active
  const last = s.last
  const specs = specStatuses(history.data ?? [])
  const behind = !!s.head && !!s.point && s.point.commit !== s.head

  return (
    <section className="pj-block ps" aria-label="原型同步" data-section="proto-sync">
      <h2 className="pj-sec-title">原型同步<span className="pj-hint">以上线代码为准回写原型库和规格；只提交到原型库的同步分支 proto-sync/日期，合并由你决定</span></h2>

      <div className="ps-point" role="group" aria-label="同步点">
        {s.point ? (
          <span>
            同步点：代码 <code>{shortSha(s.point.commit)}</code>
            {s.point.proto_commit ? <>，对应原型 <code>{s.point.proto_branch}</code> <code>{shortSha(s.point.proto_commit)}</code></> : null}
            <span className="wt-muted">（{when(s.point.at)}，{PROTO_SYNC_STATUS_LABEL[s.point.status]}）</span>
          </span>
        ) : <span className="wt-muted">还没有同步点：第一次同步会对比整个代码库；代码和原型已经对齐时可以先设为基线</span>}
        {s.head_error ? <span className="field-err">{s.head_error}</span> : (
          <span className="wt-muted">
            生产分支 <code>{s.branch}</code> 现在是 <code>{shortSha(s.head)}</code>{s.point ? (behind ? '，比同步点新' : '，已同步到这里') : ''}
          </span>
        )}
        <span className="ps-actions">
          {active ? (
            <>
              <span className={cls('wtt-badge', protoSyncTone(active.status))}>{PROTO_SYNC_STATUS_LABEL[active.status]}</span>
              {active.sop_run_id && <button type="button" className="pj-link" onClick={() => navigate(`/sop/runs/${encodeURIComponent(active.sop_run_id)}`)}>
                {active.status === 'reviewing' ? '去裁决' : '查看执行'}</button>}
              <Button size="sm" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate(active.id, { onError: (e) => setErr(errorText(e)) })}>
                {cancel.isPending ? '作废中…' : '作废'}
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="primary" disabled={trigger.isPending || !!s.head_error} onClick={() => run('sync')}>{trigger.isPending ? '发起中…' : '立即同步'}</Button>
              <Button size="sm" variant="outline" disabled={trigger.isPending || !!s.head_error} onClick={() => setAskBaseline(true)}>设为基线</Button>
            </>
          )}
        </span>
      </div>
      {err && <div className="field-err" role="alert">{err}</div>}

      <div className="ps-triggers" role="group" aria-label="自动触发">
        <span className="field-label">自动触发<span className="pj-hint">默认都关；同一项目同时只跑一次，有进行中的就等它结束</span></span>
        <Switch checked={st.on_release} disabled={save.isPending} onCheckedChange={(v) => put({ on_release: v })}>发布成功后同步</Switch>
        <Switch checked={st.on_merge} disabled={save.isPending} onCheckedChange={(v) => put({ on_merge: v })}>
          生产分支有新提交时同步<span className="pj-hint">每分钟看一次本机代码库的分支，不拉远端</span>
        </Switch>
        <div className="ps-daily">
          <Switch checked={st.daily} disabled={save.isPending} onCheckedChange={(v) => put({ daily: v })}>每日巡检</Switch>
          <input className={cls('input ps-time', dailyBad && 'bad')} value={dailyVal} aria-label="巡检时间" aria-invalid={dailyBad || undefined} placeholder="09:00"
            onChange={(e) => setDailyAt(e.target.value)}
            onBlur={() => { if (!dailyBad && dailyVal.trim() !== st.daily_at) put({ daily_at: dailyVal.trim() }); if (!dailyBad) setDailyAt(null) }} />
          <span className={dailyBad ? 'field-err' : 'wt-muted'}>{dailyBad ? '时间写成 HH:MM，改好前不保存' : '本机时间；没有新提交时只记一行，不跑流程'}</span>
        </div>
        <label className="field ps-branch">
          <span className="field-label">生产分支<span className="pj-hint">留空依次认 main、master、当前检出的分支</span></span>
          <input className="input pj-mono" value={branchVal} placeholder="main" spellCheck={false} aria-label="生产分支"
            onChange={(e) => setBranch(e.target.value)}
            onBlur={() => { if (branchVal.trim() !== st.branch) put({ branch: branchVal.trim() }); setBranch(null) }} />
        </label>
      </div>

      {last ? <LastSync p={last} onOpenRun={(id) => navigate(`/sop/runs/${encodeURIComponent(id)}`)} /> : (
        <div className="pj-block-empty">还没有同步过</div>
      )}

      {specs.length > 0 && (
        <div className="ps-specs" role="group" aria-label="规格实现状态">
          <span className="wtt-title">规格实现状态<span className="pj-hint">按规格编号取最近一次同步的结论</span></span>
          <table className="ps-table">
            <thead><tr><th>规格条目</th><th>内容</th><th>实现状态</th><th>同步于</th></tr></thead>
            <tbody>
              {specs.map((x) => (
                <tr key={x.spec}>
                  <td><code>{x.spec}</code></td>
                  <td>{x.title}</td>
                  <td><span className={cls('ps-impl', implTone(x.status))}>{IMPL_STATUS_LABEL[x.status]}</span></td>
                  <td className="wt-muted">{when(x.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(history.data?.length ?? 0) > 1 && (
        <details className="ps-history">
          <summary>同步历史（{history.data!.length}）</summary>
          <ol className="ps-hist-list">
            {history.data!.map((p) => (
              <li key={p.id} className="ps-hist-row">
                <span className="wt-muted">{when(p.started_at)}</span>
                <span>{PROTO_SYNC_TRIGGER_LABEL[p.trigger]}</span>
                <span className={cls('wtt-badge', protoSyncTone(p.status))}>{PROTO_SYNC_STATUS_LABEL[p.status]}</span>
                <code>{p.base_commit ? shortSha(p.base_commit) : '首次'} → {shortSha(p.head_commit)}</code>
                {p.proto_commit && <code>{p.proto_branch} {shortSha(p.proto_commit)}</code>}
                <span className="ps-hist-sum">{protoSyncSummary(p)}</span>
              </li>
            ))}
          </ol>
        </details>
      )}

      <ConfirmDialog open={askBaseline} title="把当前代码设为同步点？" confirmLabel="设为基线" busy={trigger.isPending}
        onConfirm={() => run('baseline')} onCancel={() => setAskBaseline(false)}>
        不对比、不改原型，只记下「原型已经和代码 {shortSha(s.head)} 对齐」。之后的同步只看这之后的改动；原型其实没对齐时，之前的差异就不会再被发现。
      </ConfirmDialog>
    </section>
  )
}

function LastSync({ p, onOpenRun }: { p: ProtoSync; onOpenRun: (id: string) => void }) {
  const tone = protoSyncTone(p.status)
  return (
    <div className="wtt ps-last" role="group" aria-label="最近一次同步">
      <div className="wtt-head">
        <span className="wtt-title">最近一次</span>
        <span className={cls('wtt-badge', tone)}>{PROTO_SYNC_STATUS_LABEL[p.status]}</span>
        <span className="wt-muted">{when(p.started_at)}，{PROTO_SYNC_TRIGGER_LABEL[p.trigger]}</span>
        {p.sop_run_id && <span className="wtt-actions"><button type="button" className="wtt-link" onClick={() => onOpenRun(p.sop_run_id)}>查看执行</button></span>}
      </div>
      <div className={cls('wtt-summary', tone)} role={tone === 'bad' ? 'alert' : undefined}>{protoSyncSummary(p)}</div>
      {p.summary && p.status !== 'baseline' && <div className="wt-muted">{p.summary}</div>}
      {p.fix_task_id && <div className="wt-muted">拿不准的判为缺陷，已建修复任务（{p.fix_task_id}）</div>}
      {p.items.length > 0 && (
        <table className="ps-table" aria-label="差异清单">
          <thead><tr><th>分类</th><th>差异</th><th>规格条目</th><th>实现状态</th></tr></thead>
          <tbody>
            {p.items.map((it, i) => (
              <tr key={i}>
                <td><span className={cls('ps-kind', it.kind)}>{PROTO_SYNC_KIND_LABEL[it.kind]}</span></td>
                <td>
                  {it.title}
                  {it.detail && <div className="wt-muted">{it.detail}</div>}
                  {it.decision && <div className="wt-muted">裁决：{DECISION_LABEL[it.decision]}</div>}
                </td>
                <td>{it.spec ? <code>{it.spec}</code> : <span className="wt-muted">{it.page || '—'}</span>}</td>
                <td><span className={cls('ps-impl', implTone(it.status))}>{IMPL_STATUS_LABEL[it.status]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {p.files.length > 0 && (
        <details className="wtt-out">
          <summary>改动的代码文件（{p.files.length}）</summary>
          <pre>{p.diff_stat || p.files.join('\n')}</pre>
        </details>
      )}
    </div>
  )
}
