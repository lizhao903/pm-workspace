// 档案标签末尾的「原型同步」（AUTO-11，SPEC-projects-15.17 到 15.28）：以上线代码为准回写原型库和规格。
// 原型里的「立即同步」用定时器模拟流程：一会儿后出结果，带一条拿不准的差异等裁决；正式产品裁决在 SOP 执行页的「产品裁决」里，
// 原型点「去裁决」在这里直接给三个选项（规格 P-21）。
import { useEffect, useState } from 'react'
import {
  DECISION, EMPTY_PROTO_SYNC, IMPL, PS_KIND, PS_STATUS, PS_TRIGGER, counts, implTone, psSummary, psTone, sampleItems, sha, specStatuses, syncPoint,
  type ProtoSyncDecision, type ProtoSyncInfo, type ProtoSyncRun, type ProtoSyncSettings,
} from './protosyncdata'
import { cls } from './ui'

const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const when = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function ProtoSyncSection({ info, codeDirSet, onChange }: { info?: ProtoSyncInfo; codeDirSet: boolean; onChange: (x: ProtoSyncInfo) => void }) {
  const ps = info ?? EMPTY_PROTO_SYNC
  const st = ps.settings
  const [dailyAt, setDailyAt] = useState(st.daily_at)
  const [branch, setBranch] = useState(st.branch)
  const [askBaseline, setAskBaseline] = useState(false)
  const [deciding, setDeciding] = useState(false)
  const set = (x: Partial<ProtoSyncSettings>) => onChange({ ...ps, settings: { ...st, ...x } })
  const point = syncPoint(ps.history)
  const active = ps.history.find((x) => x.status === 'running' || x.status === 'reviewing')
  const last = ps.history[0]
  const dailyBad = !CLOCK_RE.test(dailyAt.trim())
  const specs = specStatuses(ps.history)
  const update = (id: string, x: Partial<ProtoSyncRun>) => onChange({ ...ps, history: ps.history.map((r) => (r.id === id ? { ...r, ...x } : r)) })

  // 模拟流程：进行中 2 秒后出结果，一条拿不准，等裁决
  useEffect(() => {
    if (active?.status !== 'running' || active.items.length) return
    const t = setTimeout(() => update(active.id, { status: 'reviewing', items: sampleItems(), summary: '改了任务抽屉的工作区块；项目卡片的原型数拿不准' }), 2000)
    return () => clearTimeout(t)
  })

  const start = (baseline: boolean) => {
    const run: ProtoSyncRun = {
      id: `psy_${Date.now()}`, trigger: baseline ? 'baseline' : 'manual', status: baseline ? 'baseline' : 'running', base_commit: point?.head_commit ?? '',
      head_commit: ps.head, proto_branch: '', proto_commit: '', items: [], decision: '', fix_task: '', summary: '', error: '', started_at: new Date().toISOString(),
    }
    onChange({ ...ps, history: [run, ...ps.history] })
    setAskBaseline(false)
  }
  const decide = (d: Exclude<ProtoSyncDecision, ''>) => {
    if (!active) return
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    update(active.id, {
      status: 'done', decision: d, proto_branch: `proto-sync/${day}`, proto_commit: 'a3d9f10c7e', fix_task: d === 'defect' ? 'TSK-0460' : '',
      items: active.items.map((it) => (it.kind === 'uncertain' && !it.decision ? { ...it, decision: d, status: d === 'design' ? 'implemented' : d === 'defect' ? 'deviation' : 'pending' } : it)),
    })
    setDeciding(false)
  }

  return (
    <section className="hook-sec ps-sec" aria-label="原型同步">
      <div className="field-group-title">原型同步<span className="field-hint">以上线代码为准回写原型库和规格；只提交到原型库的同步分支 proto-sync/日期，合并由你决定</span></div>

      <div className="ps-point" role="group" aria-label="同步点">
        {point ? (
          <span>同步点：代码 <code>{sha(point.head_commit)}</code>
            {point.proto_commit && <>，对应原型 <code>{point.proto_branch}</code> <code>{sha(point.proto_commit)}</code></>}
            <span className="list-sub">（{when(point.started_at)}，{PS_STATUS[point.status]}）</span>
          </span>
        ) : <span className="list-sub">还没有同步点：第一次同步会对比整个代码库；代码和原型已经对齐时可以先设为基线</span>}
        {codeDirSet
          ? <span className="list-sub">生产分支 <code>{st.branch || 'main'}</code> 现在是 <code>{sha(ps.head)}</code>{point ? (point.head_commit === ps.head ? '，已同步到这里' : '，比同步点新') : ''}</span>
          : <span className="field-err">项目没有代码库目录：先在上面填「代码库目录」，或者给项目设目录</span>}
        <span className="ps-actions">
          {active ? (
            <>
              <span className={cls('ps-badge', psTone(active.status))}>{PS_STATUS[active.status]}</span>
              {active.status === 'reviewing' && <button className="btn btn-outline btn-sm" onClick={() => setDeciding(!deciding)}>去裁决</button>}
              <button className="btn btn-outline btn-sm" onClick={() => update(active.id, { status: 'cancelled', error: '手动作废，同步点没动' })}>作废</button>
            </>
          ) : askBaseline ? (
            <>
              <span className="danger-text">不对比、不改原型，只记下原型已和代码 {sha(ps.head)} 对齐；之前的差异不会再被发现</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setAskBaseline(false)}>取消</button>
              <button className="btn btn-primary btn-sm" onClick={() => start(true)}>设为基线</button>
            </>
          ) : (
            <>
              <button className="btn btn-primary btn-sm" disabled={!codeDirSet} onClick={() => start(false)}>立即同步</button>
              <button className="btn btn-outline btn-sm" disabled={!codeDirSet} onClick={() => setAskBaseline(true)}>设为基线</button>
            </>
          )}
        </span>
      </div>
      {deciding && active?.status === 'reviewing' && (
        <div className="ps-decide" role="group" aria-label="产品裁决">
          <span className="list-sub">产品裁决（正式产品在 SOP 执行页的「产品裁决」里选）：</span>
          {(['design', 'defect', 'ignore'] as const).map((d) => <button key={d} className="btn btn-outline btn-sm" onClick={() => decide(d)}>{DECISION[d]}</button>)}
        </div>
      )}

      <div className="ps-triggers" role="group" aria-label="自动触发">
        <span className="field-label">自动触发<span className="field-hint">默认都关；同一项目同时只跑一次，有进行中的就等它结束</span></span>
        <label className="switch-line"><input type="checkbox" checked={st.on_release} onChange={(e) => set({ on_release: e.target.checked })} /><span className="switch" />发布成功后同步</label>
        <label className="switch-line"><input type="checkbox" checked={st.on_merge} onChange={(e) => set({ on_merge: e.target.checked })} /><span className="switch" />
          生产分支有新提交时同步<span className="field-hint">每分钟看一次本机代码库的分支，不拉远端</span></label>
        <div className="ps-daily">
          <label className="switch-line"><input type="checkbox" checked={st.daily} onChange={(e) => set({ daily: e.target.checked })} /><span className="switch" />每日巡检</label>
          <input className={cls('mono-input ps-time', dailyBad && 'bad')} value={dailyAt} aria-label="巡检时间" placeholder="09:00"
            onChange={(e) => setDailyAt(e.target.value)} onBlur={() => { if (!dailyBad) set({ daily_at: dailyAt.trim() }) }} />
          <span className={dailyBad ? 'field-err' : 'list-sub'}>{dailyBad ? '时间写成 HH:MM，改好前不保存' : '本机时间；没有新提交时只记一行，不跑流程'}</span>
        </div>
        <label className="field ps-branch"><span className="field-label">生产分支<span className="field-hint">留空依次认 main、master、当前检出的分支</span></span>
          <input className="mono-input" value={branch} placeholder="main" spellCheck={false} aria-label="生产分支" onChange={(e) => setBranch(e.target.value)}
            onBlur={() => set({ branch: branch.trim() })} />
        </label>
      </div>

      {last ? <LastRun p={last} /> : <div className="ps-empty">还没有同步过</div>}

      {specs.length > 0 && (
        <div className="ps-specs" role="group" aria-label="规格实现状态">
          <span className="ps-title">规格实现状态<span className="field-hint">按规格编号取最近一次同步的结论</span></span>
          <table className="ps-table">
            <thead><tr><th>规格条目</th><th>内容</th><th>实现状态</th><th>同步于</th></tr></thead>
            <tbody>{specs.map((x) => (
              <tr key={x.spec}><td><code>{x.spec}</code></td><td>{x.title}</td><td><span className={cls('ps-impl', implTone(x.status))}>{IMPL[x.status]}</span></td><td className="list-sub">{when(x.at)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {ps.history.length > 1 && (
        <details className="ps-history">
          <summary>同步历史（{ps.history.length}）</summary>
          <ol className="ps-hist-list">{ps.history.map((p) => (
            <li key={p.id} className="ps-hist-row">
              <span className="list-sub">{when(p.started_at)}</span><span>{PS_TRIGGER[p.trigger]}</span>
              <span className={cls('ps-badge', psTone(p.status))}>{PS_STATUS[p.status]}</span>
              <code>{p.base_commit ? sha(p.base_commit) : '首次'} → {sha(p.head_commit)}</code>
              {p.proto_commit && <code>{p.proto_branch} {sha(p.proto_commit)}</code>}
              <span className="ps-hist-sum">{psSummary(p)}</span>
            </li>
          ))}</ol>
        </details>
      )}
    </section>
  )
}

function LastRun({ p }: { p: ProtoSyncRun }) {
  const tone = psTone(p.status)
  const c = counts(p.items)
  return (
    <div className="ps-last" role="group" aria-label="最近一次同步">
      <div className="ps-last-head">
        <span className="ps-title">最近一次</span>
        <span className={cls('ps-badge', tone)}>{PS_STATUS[p.status]}</span>
        <span className="list-sub">{when(p.started_at)}，{PS_TRIGGER[p.trigger]}</span>
        {p.status !== 'baseline' && p.status !== 'no_change' && <span className="ps-link">查看执行</span>}
      </div>
      <div className={cls('ps-summary', tone)}>{psSummary(p)}</div>
      {p.summary && <div className="list-sub">{p.summary}</div>}
      {p.fix_task && <div className="list-sub">拿不准的判为缺陷，已建修复任务（{p.fix_task}）</div>}
      {p.items.length > 0 && (
        <table className="ps-table" aria-label="差异清单">
          <thead><tr><th>分类</th><th>差异</th><th>规格条目</th><th>实现状态</th></tr></thead>
          <tbody>{p.items.map((it, i) => (
            <tr key={i}>
              <td><span className={cls('ps-kind', it.kind)}>{PS_KIND[it.kind]}</span></td>
              <td>{it.title}{it.detail && <div className="list-sub">{it.detail}</div>}{it.decision && <div className="list-sub">裁决：{DECISION[it.decision]}</div>}</td>
              <td>{it.spec ? <code>{it.spec}</code> : <span className="list-sub">{it.page || '—'}</span>}</td>
              <td><span className={cls('ps-impl', implTone(it.status))}>{IMPL[it.status]}</span></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {c.pending > 0 && <div className="list-sub">{c.pending} 条拿不准的等产品裁决：当作新设计按代码回写原型，当作缺陷建修复任务，或暂不处理</div>}
    </div>
  )
}
