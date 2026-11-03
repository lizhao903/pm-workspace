// Agent 列表，照原型 web-next/src/agents.tsx AgentsPage（SPEC-settings-8）：卡片网格，搜索，卡片上直接启停。
import { useState } from 'react'
import {
  errorText, QueryState, useAgentGrants, useAgentRuns, useAgents, usePatchAgent, type Agent, type AgentRunBrief,
} from '../../../core/data'
import { Button, cls, EmptyState, PageTitle, Switch } from '../../../core/ui'
import { timeAgo } from '../providers/model'
import { AgentAvatar } from './AgentAvatar'
import { ABILITIES, choiceKey, hasAll, thinkingLabel, triggerSummary, type ModelChoice } from './model'
import { MiniSearch } from './parts'
import { ScenarioDefaults } from './ScenarioDefaults'

export function AgentList({ models, onOpen, onNew }: { models: ModelChoice[]; onOpen: (id: string) => void; onNew: () => void }) {
  const q = useAgents()
  const agents = q.data ?? []
  const grants = useAgentGrants(agents.map((a) => a.id))
  // 执行记录接口取不到时按「还没运行过」显示
  const runs = useAgentRuns().data ?? []
  const patch = usePatchAgent()
  const [kw, setKw] = useState('')
  const [toggleErr, setToggleErr] = useState<string | null>(null)
  const rows = agents.filter((a) => hasAll(`${a.name} ${a.desc}`, kw))

  const toggle = (a: Agent, on: boolean) => {
    setToggleErr(null)
    patch.mutate({ id: a.id, patch: { enabled: on } }, {
      onError: (e) => setToggleErr(`${on ? '启用' : '停用'}「${a.name || '未命名'}」失败：${errorText(e)}`),
    })
  }

  return (
    <div className="ag-page">
      <PageTitle parent="设置" count={q.data ? agents.length : undefined} desc="工作助手：各有指令、模型和工具，写操作默认要你确认才执行"
        actions={(
          <Button variant="primary" onClick={onNew}>
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            新建 Agent
          </Button>
        )}>Agent</PageTitle>
      <QueryState query={q}>
        {() => (
          <>
            <div className="ag-toolbar">
              <MiniSearch value={kw} onChange={setKw} placeholder="搜 Agent 名称和说明" />
              {kw.trim() && <span className="ag-sub">命中 {rows.length} 个</span>}
            </div>
            {toggleErr && <div className="ag-banner ag-banner-danger" role="alert">{toggleErr}</div>}
            {/* 一个都没有和搜不到分开说 */}
            {!rows.length && (agents.length
              ? <EmptyState title="没有匹配的 Agent" desc="换个关键词试试" />
              : <EmptyState title="还没有 Agent" desc="点右上角「新建 Agent」" />)}
            <div className="ag-grid">
              {rows.map((a) => (
                <AgentCard key={a.id} agent={a} model={models.find((m) => m.key === choiceKey(a.provider_id, a.model))}
                  grants={grants[a.id]?.grants} runs={runs.filter((r) => r.agent_id === a.id)}
                  onOpen={() => onOpen(a.id)} onToggle={(on) => toggle(a, on)} />
              ))}
            </div>
            <ScenarioDefaults agents={agents} />
          </>
        )}
      </QueryState>
    </div>
  )
}

function AgentCard({ agent: a, model, grants, runs, onOpen, onToggle }: {
  agent: Agent
  model: ModelChoice | undefined
  grants: Record<string, string> | undefined
  runs: AgentRunBrief[]
  onOpen: () => void
  onToggle: (on: boolean) => void
}) {
  const on = ABILITIES.filter((x) => (grants?.[x.key] ?? 'off') !== 'off')
  const wait = runs.filter((r) => r.status === 'waiting').length
  const last = runs.reduce<AgentRunBrief | undefined>((m, r) => (!m || r.started_at > m.started_at ? r : m), undefined)
  const bad = model ? !model.ok : !!a.model
  return (
    <div role="button" tabIndex={0} className={cls('ag-card', !a.enabled && 'off')} data-agent={a.id} aria-label={a.name || '未命名'}
      onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen() }}>
      <div className="ag-card-head">
        <AgentAvatar agent={a} size={38} />
        <div className="ag-card-title">
          <span className="ag-name ellipsis">{a.name || '未命名'}</span>
          <span className={cls('ag-model ellipsis', bad && 'danger-text')}>
            {model?.label ?? a.model}{bad && ' · 不可用'}{a.thinking && a.thinking !== 'default' && ` · 思考：${thinkingLabel(a.thinking)}`}
          </span>
        </div>
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <Switch checked={a.enabled} aria-label={a.enabled ? `停用 ${a.name}` : `启用 ${a.name}`} title={a.enabled ? '停用后不再被触发' : '启用'}
            onCheckedChange={onToggle} />
        </span>
      </div>
      <div className="ag-desc">{a.desc || '还没有说明'}</div>
      {on.length > 0 && (
        <div className="ag-abilities">
          {on.slice(0, 5).map((x) => <span key={x.key} className={cls('ag-ability', grants?.[x.key] === 'confirm' && 'confirm')}>{x.label}</span>)}
          {on.length > 5 && <span className="ag-ability">+{on.length - 5}</span>}
        </div>
      )}
      <div className="ag-card-foot">
        <span className="ellipsis">{triggerSummary(a.triggers)}</span>
        <span className="spacer" />
        {wait > 0 && <span className="ag-wait">{wait} 条等确认</span>}
        <span className="ag-nowrap">{last ? `${timeAgo(Date.parse(last.started_at))}运行` : '还没运行过'}</span>
      </div>
    </div>
  )
}
