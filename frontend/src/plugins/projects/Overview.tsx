// 概览（SPEC-projects-3）：数字卡片和摘要块，每块都能点进对应标签。
// 现在有数据来源的是任务、干系人、项目目录；最新沟通、项目 Agent、原型、文档和材料等对应后端（PJ-02、AG、PJ-04、PJ-03）有了再补
import { Suspense, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  PROJECT_ROLES, errorText, projectView, useAllObjects, useContacts, useDictItems, useProjectStakeholders, type WorkObject,
} from '../../core/data'
import { useObjectDrawer } from '../../core/plugin'
import { ErrorState, cls } from '../../core/ui'
import { STAKE_PEEK, TASK_PEEK, type ProjectTab } from './model'

const PRIORITY_DICT = 'priority'

export function Overview({ project, onTab }: { project: WorkObject; onTab: (t: ProjectTab) => void }) {
  const p = projectView(project)
  const navigate = useNavigate()
  const tasks = useAllObjects({ type: ['task'], project: p.id, not_terminal: true })
  const prios = useDictItems(PRIORITY_DICT)
  const stakes = useProjectStakeholders(p.id)
  const contacts = useContacts()
  // 点任务打开任务模块登记的抽屉（PJ-01d）
  const drawer = useObjectDrawer('task')
  const [openId, setOpenId] = useState<string | null>(null)

  // 未完成任务按优先级排（字典顺序），同优先级的新改的在前
  const openTasks = useMemo(() => {
    const rank = new Map((prios.data ?? []).map((x, i) => [x.key, i]))
    const r = (k: string) => rank.get(k) ?? (k ? 999 : 1000)
    return [...(tasks.data?.data ?? [])].sort((a, b) => r(a.priority) - r(b.priority) || a.priority.localeCompare(b.priority) || b.updated_at.localeCompare(a.updated_at))
  }, [tasks.data, prios.data])

  const people = useMemo(() => new Map((contacts.data ?? []).map((c) => [c.id, c])), [contacts.data])
  const order = (role: string) => PROJECT_ROLES.findIndex((x) => x.key === role)
  const stakeList = useMemo(() => [...(stakes.data ?? [])].sort((a, b) => order(a.role) - order(b.role) || a.sort_order - b.sort_order), [stakes.data])
  const roleLabel = (role: string) => PROJECT_ROLES.find((x) => x.key === role)?.label ?? role

  const stat = (label: string, value: number | undefined, to: ProjectTab, tone?: string) => (
    <button type="button" className="pj-stat" onClick={() => onTab(to)}>
      <span className="pj-stat-label">{label}</span>
      <span className={cls('pj-stat-value', tone)}>{value ?? '-'}</span>
    </button>
  )

  return (
    <div className="pj-overview">
      <div className="pj-stats">
        {stat('未完成任务', tasks.data?.data.length, 'tasks')}
        {stat('干系人', stakes.data?.length, 'stakeholders')}
      </div>
      <div className="pj-ov-grid">
        <section className="pj-block" aria-label="进行中的任务">
          <div className="pj-block-head"><h2 className="pj-sec-title">进行中的任务</h2><button type="button" className="pj-link" onClick={() => onTab('tasks')}>全部</button></div>
          {tasks.isError ? <ErrorState compact error={errorText(tasks.error)} onRetry={() => void tasks.refetch()} />
            : tasks.isPending ? <div className="pj-block-empty">加载中</div>
              : openTasks.length ? (
                <ul className="pj-lines">
                  {openTasks.slice(0, TASK_PEEK).map((t) => (
                    <li key={t.id}>
                      <button type="button" className="pj-line pj-line-btn" disabled={!drawer} onClick={() => setOpenId(t.id)}>
                        <span className="pj-ref">{t.ref}</span><span className="ellipsis">{t.title}</span>
                        <span className="spacer" /><span className="pj-muted">{t.owner_name || t.owner}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <div className="pj-block-empty">没有未完成的任务</div>}
        </section>

        <section className="pj-block" aria-label="干系人">
          <div className="pj-block-head"><h2 className="pj-sec-title">干系人</h2><button type="button" className="pj-link" onClick={() => onTab('stakeholders')}>全部</button></div>
          {stakes.isError ? <ErrorState compact error={errorText(stakes.error)} onRetry={() => void stakes.refetch()} />
            : stakes.isPending ? <div className="pj-block-empty">加载中</div>
              : stakeList.length ? (
                <div className="pj-chips">
                  {stakeList.slice(0, STAKE_PEEK).map((x) => {
                    const name = people.get(x.stakeholder_id)?.name ?? '已删除的联系人'
                    return (
                      <button key={x.stakeholder_id} type="button" className="tag pj-chip" title={x.focus ? `${name}：${x.focus}` : name}
                        onClick={() => navigate(`/contacts?c=${encodeURIComponent(x.stakeholder_id)}`)}>
                        {name} · {roleLabel(x.role)}
                      </button>
                    )
                  })}
                  {stakeList.length > STAKE_PEEK && (
                    <button type="button" className="tag pj-chip" title="看全部干系人" onClick={() => onTab('stakeholders')}>+{stakeList.length - STAKE_PEEK}</button>
                  )}
                </div>
              ) : <div className="pj-block-empty">还没有干系人</div>}
        </section>

        <section className="pj-block" aria-label="项目目录">
          <h2 className="pj-sec-title">项目目录</h2>
          <code className="pj-root">{p.root || '还没设置'}</code>
          {p.related.length > 0 && (
            <div className="pj-chips">{p.related.map((r) => <span key={r.path} className="tag" title={r.path}>{r.label || r.path.split('/').pop()}</span>)}</div>
          )}
        </section>
      </div>
      <Suspense fallback={null}>
        {openId && drawer && <drawer.drawer key={openId} objectId={openId} onClose={() => setOpenId(null)} />}
      </Suspense>
    </div>
  )
}
