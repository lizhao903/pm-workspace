// 设置里的「Agent」分节（AG-01b5）：/settings/agents 是列表，/settings/agents/new 新建，/settings/agents/<id> 配置页，
// /settings/agents?agent=<id> 转到配置页。
// 模型可选项由服务商列表和本次会话里测过的结果算出来，列表卡片和配置页用同一份，不为这个去测连接。
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router'
import { isApiError, QueryState, useAgent, useAgentProviders, useAgents, useProviderChecks } from '../../../core/data'
import { Button, EmptyState, PageTitle } from '../../../core/ui'
import { AgentEditor } from './AgentEditor'
import { AgentList } from './AgentList'
import { modelChoices } from './model'
import './agents.css'

export function AgentsSection() {
  const navigate = useNavigate()
  const sub = (useParams()['*'] ?? '').split('/').slice(1).join('/')
  // 别的页面（知识库挂的 Agent）用 /settings/agents?agent=<id> 跳过来，换成配置页
  const linked = useSearchParams()[0].get('agent')
  const providers = useAgentProviders().data ?? []
  const checks = useProviderChecks(providers.map((p) => p.id))
  // 正在用的模型不在服务商的模型列表里也要列出来，免得卡片上看不到名字
  const agents = useAgents().data ?? []
  const models = modelChoices(providers, checks, agents.map((a) => ({ provider_id: a.provider_id, model: a.model })))

  if (!sub && linked) return <Navigate replace to={`/settings/agents/${encodeURIComponent(linked)}`} />
  if (!sub) return <AgentList models={models} onOpen={(id) => void navigate(`/settings/agents/${encodeURIComponent(id)}`)} onNew={() => void navigate('/settings/agents/new')} />
  if (sub === 'new') return <AgentEditor key="new" agent={null} models={models} />
  return <ExistingAgent key={sub} id={sub} models={models} />
}

function ExistingAgent({ id, models }: { id: string; models: ReturnType<typeof modelChoices> }) {
  const navigate = useNavigate()
  const q = useAgent(id)
  // 刚在这页删掉时手上还有旧数据，等删除的回调跳回列表，不换成「不存在」
  if (!q.data && q.isError && isApiError(q.error, 'not_found')) {
    return (
      <div className="ag-page">
        <PageTitle parent="Agent">找不到</PageTitle>
        <EmptyState title="这个 Agent 不存在或已删除" action={<Button onClick={() => void navigate('/settings/agents')}>回到 Agent 列表</Button>} />
      </div>
    )
  }
  return <QueryState query={q}>{(a) => <AgentEditor agent={a} models={models} />}</QueryState>
}
