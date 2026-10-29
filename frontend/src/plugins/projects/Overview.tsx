// 概览（SPEC-projects-3）：五个数字卡片和七个摘要块，每块都能点进对应标签。
// 待回复、最新沟通用沟通标签同一份项目消息（useProjectMessages）；产品文档数和文档标签同一个查询；
// 项目 Agent 等 AG 系列，先放「还没设置。去设置」空状态
import { Suspense, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  PROJECT_ROLES, errorText, projectView, useAllObjects, useContacts, useDictItems, useProjectMaterials, useProjectStakeholders,
  type ImMessage, type WorkObject,
} from '../../core/data'
import { useObjectDrawer } from '../../core/plugin'
import { ErrorState, cls } from '../../core/ui'
import { awaitingCount, awaitingReply, whoName } from './commsModel'
import { recentDocsAndMaterials } from './materialModel'
import { useProjectMessages } from './projectMessages'
import { STAKE_PEEK, TASK_PEEK, ago, type ProjectTab } from './model'
import { ProtoBlock, ProtoStat } from './PrototypesTab'

const PRIORITY_DICT = 'priority'
const DOC = 'doc'
const MESSAGES_PATH = '/messages'
const PLUGINS_PATH = '/settings/plugins'
/** 最新沟通露几条（SPEC-projects-3.2） */
const MSG_PEEK = 4

export function Overview({ project, onTab }: { project: WorkObject; onTab: (t: ProjectTab) => void }) {
  const p = projectView(project)
  const navigate = useNavigate()
  const tasks = useAllObjects({ type: ['task'], project: p.id, not_terminal: true })
  const prios = useDictItems(PRIORITY_DICT)
  const stakes = useProjectStakeholders(p.id)
  const contacts = useContacts()
  const pm = useProjectMessages(p.id)
  const docs = useAllObjects({ type: [DOC], project: p.id, sort: '-updated_at' })
  const mats = useProjectMaterials(p.id)
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
  // 相对时间、稍后到点每分钟重算一次
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])
  const msgsReady = !pm.noIm && !pm.pluginsPending && !pm.binds.isPending && !pm.msgs.isPending && !(pm.msgs.isError && !pm.msgs.data.length)
  const waiting = msgsReady ? awaitingCount(pm.msgs.data, now) : undefined
  const recent = useMemo(() => recentDocsAndMaterials(docs.data?.data ?? [], mats.data ?? []), [docs.data, mats.data])
  const openMessage = (m: ImMessage) => navigate(`${MESSAGES_PATH}?m=${encodeURIComponent(m.id)}`)

  let comms
  if (pm.binds.isError) comms = <ErrorState compact error={errorText(pm.binds.error)} onRetry={() => void pm.binds.refetch()} />
  else if (pm.noIm) {
    comms = <div className="pj-block-empty">项目消息来自 IM 消息插件，还没启用。<button type="button" className="pj-link" onClick={() => navigate(PLUGINS_PATH)}>去插件管理</button></div>
  } else if (pm.msgs.isError && !pm.msgs.data.length) comms = <ErrorState compact error={errorText(pm.msgs.error)} onRetry={pm.msgs.refetch} />
  else if (!msgsReady) comms = <div className="pj-block-empty">加载中</div>
  else if (pm.msgs.data.length) {
    comms = (
      <ul className="pj-lines">
        {pm.msgs.data.slice(0, MSG_PEEK).map((m) => (
          <li key={m.id}>
            <button type="button" className="pj-line pj-line-btn" title={m.text} onClick={() => openMessage(m)}>
              <span className={cls('pj-dot', awaitingReply(m, now) && 'pj-dot-wait')} />
              <b className="pj-line-who">{whoName(m)}</b><span className="ellipsis">{m.text}</span>
              <span className="spacer" /><span className="pj-muted" title={m.at}>{ago(m.at, now)}</span>
            </button>
          </li>
        ))}
      </ul>
    )
  } else if (pm.bound.length) comms = <div className="pj-block-empty">绑定的会话里还没有消息</div>
  else comms = <div className="pj-block-empty">还没绑定沟通渠道。<button type="button" className="pj-link" onClick={() => onTab('comms')}>去绑定</button></div>

  const stat = (label: string, value: number | undefined, to: ProjectTab, tone?: string) => (
    <button type="button" className="pj-stat" onClick={() => onTab(to)}>
      <span className="pj-stat-label">{label}</span>
      <span className={cls('pj-stat-value', tone)}>{value ?? '-'}</span>
    </button>
  )

  return (
    <div className="pj-overview">
      <div className="pj-stats">
        {stat('待回复消息', waiting, 'comms', waiting ? 'danger' : undefined)}
        {stat('未完成任务', tasks.data?.data.length, 'tasks')}
        {stat('干系人', stakes.data?.length, 'stakeholders')}
        {stat('产品文档', docs.data?.data.length, 'docs')}
        <ProtoStat projectId={p.id} onOpen={() => onTab('prototypes')} />
      </div>
      <div className="pj-ov-grid">
        <section className="pj-block" aria-label="最新沟通">
          <div className="pj-block-head"><h2 className="pj-sec-title">最新沟通</h2><button type="button" className="pj-link" onClick={() => onTab('comms')}>全部</button></div>
          {comms}
        </section>

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

        <section className="pj-block" aria-label="项目 Agent">
          <div className="pj-block-head"><h2 className="pj-sec-title">项目 Agent</h2><button type="button" className="pj-link" onClick={() => onTab('agents')}>全部</button></div>
          <div className="pj-block-empty">还没设置。<button type="button" className="pj-link" onClick={() => onTab('agents')}>去设置</button></div>
        </section>

        <ProtoBlock projectId={p.id} projectName={p.name} onAll={() => onTab('prototypes')} />

        <section className="pj-block" aria-label="最近的文档和材料">
          <h2 className="pj-sec-title">最近的文档和材料</h2>
          {docs.isError || mats.isError ? <ErrorState compact error={errorText(docs.error ?? mats.error)} onRetry={() => { void docs.refetch(); void mats.refetch() }} />
            : docs.isPending || mats.isPending ? <div className="pj-block-empty">加载中</div>
              : recent.length ? (
                <ul className="pj-lines">
                  {recent.map((x) => (
                    <li key={x.key} className="pj-line">
                      <span className="tag">{x.tag}</span><span className="ellipsis">{x.title}</span>
                      <span className="spacer" /><span className="pj-muted" title={x.at}>{ago(x.at, now)}</span>
                    </li>
                  ))}
                </ul>
              ) : <div className="pj-block-empty">还没有文档和材料</div>}
        </section>
      </div>
      <Suspense fallback={null}>
        {openId && drawer && <drawer.drawer key={openId} objectId={openId} onClose={() => setOpenId(null)} />}
      </Suspense>
    </div>
  )
}
