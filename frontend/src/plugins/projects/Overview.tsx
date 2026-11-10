// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 概览（SPEC-projects-3）：四个数字卡片和七个摘要块，每块都能点进对应标签。TSK-0718 去掉了「原型运行中」卡片（原型块还在）。
// 待回复、最新沟通用沟通标签同一份项目消息（useProjectMessages）；产品文档数和文档标签同一个查询；
// 项目 Agent 显示默认 Agent（agent_ids 里第一个还在的）的名字，不带头像和说明（TSK-0718），「和它对话」同 Agent 标签的「对话」（PR-21）
// 干系人的角色名从枚举字典 project_role 取（TSK-0718），停用的照常显示名字、标「已停用」
import { Suspense, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  errorText, projectView, useAgents, useAllObjects, useContacts, useDictItems, useProjectMaterials, useProjectRoles, useProjectStakeholders,
  type ImMessage, type WorkObject,
} from '../../core/data'
import { useObjectDrawer } from '../../core/plugin'
import { Button, ErrorState, cls } from '../../core/ui'
import { SESSION_PARAM, useProjectChat } from './projectChat'
import { defaultAgent } from './agentModel'
import { awaitingCount, awaitingReply, whoName } from './commsModel'
import { recentDocsAndMaterials } from './materialModel'
import { useProjectMessages } from './projectMessages'
import { STAKE_PEEK, TASK_PEEK, ago, roleOf, sortStakeholders, type ProjectTab } from './model'
import { ProtoBlock } from './PrototypesTab'

const PRIORITY_DICT = 'priority'
const DOC = 'doc'
const MESSAGES_PATH = '/messages'
const PLUGINS_PATH = '/settings/plugins'
/** 最新沟通露几条（SPEC-projects-3.2） */
const MSG_PEEK = 4

export function Overview({ project, onTab }: { project: WorkObject; onTab: (t: ProjectTab, query?: string) => void }) {
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
  // 不认识的角色排最后，显示原值并标红（E-02）；按字典顺序排
  const { roles } = useProjectRoles()
  const stakeList = useMemo(() => sortStakeholders(stakes.data ?? [], roles), [stakes.data, roles])
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
      </div>
      <div className="pj-ov-grid">
        <section className="pj-block" aria-label="最新沟通">
          <div className="pj-block-head"><h2 className="pj-sec-title">最新沟通</h2><button type="button" className="pj-link" onClick={() => onTab('comms')}>全部</button></div>
          {comms}
        </section>

        <section className="pj-block" aria-label="未完成的任务">
          <div className="pj-block-head"><h2 className="pj-sec-title">未完成的任务</h2><button type="button" className="pj-link" onClick={() => onTab('tasks')}>全部</button></div>
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
                    const role = roleOf(x.role, roles)
                    const tip = x.focus ? `${name}：${x.focus}` : name
                    return (
                      <button key={x.stakeholder_id} type="button" className={cls('tag pj-chip', !role && 'pj-role-unknown')}
                        title={role ? (role.enabled ? tip : `${tip}（角色「${role.label}」已停用）`) : `${tip}（不认识的角色「${x.role}」，去干系人标签改一个）`}
                        onClick={() => navigate(`/contacts?c=${encodeURIComponent(x.stakeholder_id)}`)}>
                        {name} · {role ? role.label : x.role}{role && !role.enabled && '（已停用）'}
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
          <AgentBlock project={project} onTab={onTab} />
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

/** 概览的「项目 Agent」（SPEC-projects-3.6）：默认 Agent 的名称和「和它对话」，不带头像和说明（TSK-0718）；停用时标「已停用」、按钮置灰 */
function AgentBlock({ project, onTab }: { project: WorkObject; onTab: (t: ProjectTab, query?: string) => void }) {
  const p = projectView(project)
  const agents = useAgents()
  // 建好后切到 Agent 标签就地打开，不跳到会话页
  const chat = useProjectChat(project, (sid) => onTab('agents', `${SESSION_PARAM}=${encodeURIComponent(sid)}`))
  const none = <div className="pj-block-empty">还没设置。<button type="button" className="pj-link" onClick={() => onTab('agents')}>去设置</button></div>
  // 没配 Agent 时不用等 Agent 列表
  if (!p.agentIds.length) return none
  if (agents.isError) return <ErrorState compact error={errorText(agents.error)} onRetry={() => void agents.refetch()} />
  if (agents.isPending) return <div className="pj-block-empty">加载中</div>
  const a = defaultAgent(p.agentIds, agents.data)
  if (!a) return none
  return (
    <>
      <div className="pj-ov-agent">
        <span className="pj-ov-agent-text"><b className="ellipsis">{a.name || '未命名'}</b>{!a.enabled && <span className="pj-muted">已停用</span>}</span>
        <Button variant="primary" size="sm" disabled={!a.enabled || chat.pending} onClick={() => chat.start(a.id)}>和它对话</Button>
      </div>
      {chat.err && <div className="pj-err" role="alert">{chat.err}</div>}
    </>
  )
}
