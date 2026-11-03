// 场景默认 Agent（0045，SPEC-settings-8 列表页下方）：不挂 Agent 的模型调用按场景选一个 Agent，
// 用它的服务商、模型、思考档位和指令；没选（或选的删了、停用了）照老样子用默认服务商、思考按模型默认。
import { useState } from 'react'
import { errorText, useAgentScenarios, usePatchAgentScenarios, type Agent } from '../../../core/data'
import { Select } from '../../../core/ui'
import { scenarioOptions, scenarioProblem } from './model'

export function ScenarioDefaults({ agents }: { agents: Agent[] }) {
  const q = useAgentScenarios()
  const patch = usePatchAgentScenarios()
  const [err, setErr] = useState<string | null>(null)
  const list = q.data ?? []
  if (!list.length) return null
  const pick = (key: string, id: string) => {
    setErr(null)
    patch.mutate({ [key]: id }, { onError: (e) => setErr(`保存失败：${errorText(e)}`) })
  }
  return (
    <section className="ag-scenes" aria-label="场景默认 Agent">
      <div className="ag-sec-title">场景默认 Agent<span className="ag-hint">没指定 Agent 的模型调用用谁：用它的模型、思考和指令；不指定就用默认服务商</span></div>
      {err && <div className="ag-banner ag-banner-danger" role="alert">{err}</div>}
      {list.map((s) => {
        const problem = scenarioProblem(s.agent_id, agents)
        return (
          <div key={s.key} className="ag-scene" data-scenario={s.key}>
            <div className="ag-scene-text">
              <b>{s.label}</b>
              <span className="ag-sub">{s.desc}</span>
            </div>
            <div className="ag-scene-pick">
              <Select aria-label={`${s.label}的默认 Agent`} value={s.agent_id} disabled={patch.isPending}
                options={scenarioOptions(s.agent_id, agents)} onValueChange={(v) => pick(s.key, v)} />
              {problem && <span className="danger-text ag-sub">{problem}</span>}
            </div>
          </div>
        )
      })}
    </section>
  )
}
