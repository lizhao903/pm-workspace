// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 交给工作台 Agent（TSK-0460，SPEC-tasks-6.20 起）：任务抽屉「开发」组「交给执行」里的工作台 Agent（TSK-0722 起三个执行器同一个入口，最上面选交给谁）。
// 弹窗里选 Agent（默认场景「执行任务」选的）、服务商和模型（默认按 Agent 设置）、角色、补充说明，能勾「接着上次的会话」，
// 步数和时长上限收在「预算」里。发起走 runLive.startRun（同一个 /run 接口，harness=agent），过程在执行记录里流式显示；
// Agent 要做需要确认的写操作时，执行记录里出确认卡片，确认或拒绝后接着跑。工作目录不用选：有就是 write_file 的产物目录。
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router'
import {
  errorText, useAgentProviders, useAgentScenarios, useAgents, useRunPresets, useRunPrompt, useTaskRuns,
  type WorkObject,
} from '../../core/data'
import { Button, Checkbox, Field, IconButton, IconClose, Input, Select, Textarea } from '../../core/ui'
import { ProviderModelFields } from './ProviderModelFields'
import { restoreFocus, trapTab } from '../../core/ui/focus'
import { AGENT_RUN_DEFAULTS, agentRunRequest, canResume, clampInt, pickAgent, providerOptions } from './agentHandoffModel'
import { NO_PRESET, defaultWorkdir, pickedPreset, roleOptionLabel, roleReadOnly } from './handoffModel'
import { startRun } from './runLive'
import './handoff.css'

const PREVIEW_DELAY = 400

export function AgentRunDialog({ task, workdir, inherit, onStart, onClose, picker, restoreTo }: {
  task: WorkObject
  workdir: string
  inherit?: { project: string; dir: string }
  onStart: () => void
  onClose: () => void
  /** 「交给谁」（TSK-0722），放在标题下面 */
  picker?: ReactNode
  /** 关掉时焦点回到哪里；换执行器时弹窗会重建，由外层记住打开前的焦点 */
  restoreTo?: Element | null
}) {
  const id = useId()
  const ref = useRef<HTMLDivElement>(null)
  const [prev] = useState(() => restoreTo ?? document.activeElement)
  const agents = useAgents()
  const scenarios = useAgentScenarios()
  const providers = useAgentProviders()
  const presets = useRunPresets()
  const rows = useTaskRuns(task.id)

  const [chosenAgent, setChosenAgent] = useState<string | null>(null)
  const agentId = pickAgent(agents.data, scenarios.data, chosenAgent)
  const agent = agents.data?.find((a) => a.id === agentId)
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  // 角色默认「不用」：设置里的角色是照 Claude Code 写的，输出要求里常带它才有的 MCP 工具，要用时自己选
  const [chosenPreset, setChosenPreset] = useState<string | null>(NO_PRESET)
  const presetId = pickedPreset(presets.data, chosenPreset)
  const preset = presets.data?.find((p) => p.id === presetId)
  const [extra, setExtra] = useState('')
  const [extraSettled, setExtraSettled] = useState('')
  const resumable = canResume(rows.data)
  const [resumeChoice, setResumeChoice] = useState(false)
  const resume = resumable && resumeChoice
  const [steps, setSteps] = useState(String(AGENT_RUN_DEFAULTS.steps))
  const [minutes, setMinutes] = useState(String(AGENT_RUN_DEFAULTS.minutes))
  const [preview, setPreview] = useState(false)

  // 模型下拉：选了服务商列那个服务商的；没选按 Agent 的服务商
  const effProvider = providers.data?.find((p) => p.id === (providerId || agent?.provider_id))
  const dir = defaultWorkdir(workdir, inherit?.dir).dir
  const prompt = useRunPrompt(task.id, { harness: 'agent', resume, extra_prompt: extraSettled, preset_id: presetId || undefined }, preview)

  useEffect(() => {
    if (extra === extraSettled) return
    const t = setTimeout(() => setExtraSettled(extra), PREVIEW_DELAY)
    return () => clearTimeout(t)
  }, [extra, extraSettled])

  const closeFn = useRef(onClose)
  useEffect(() => { closeFn.current = onClose })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current
      if (!el) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeFn.current()
      } else if (e.key === 'Tab') {
        trapTab(el, e)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      restoreFocus(prev)
    }
  }, [prev])

  let blocker = ''
  if (agents.isError) blocker = `Agent 列表没取到：${errorText(agents.error)}`
  else if (agents.isSuccess && !agentId && !resume) blocker = '还没有启用的 Agent：先到「设置 / Agent」建一个并启用'
  const ready = !blocker && (resume || !!agentId) && !agents.isPending

  const submit = () => {
    if (!ready) return
    startRun(task.id, agentRunRequest({
      agentId, providerId, model, presetId, extra, workdir: '', resume,
      steps: clampInt(steps, AGENT_RUN_DEFAULTS.steps, AGENT_RUN_DEFAULTS.maxSteps),
      minutes: clampInt(minutes, AGENT_RUN_DEFAULTS.minutes, AGENT_RUN_DEFAULTS.maxMinutes),
    }))
    onStart()
  }

  return createPortal(
    <div className="dialog-scrim ho-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={ref} className="ho" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} tabIndex={-1}>
        <div className="ho-head">
          <b id={`${id}-t`}>交给工作台 Agent</b>
          <span className="ho-sub ellipsis" title={`${task.ref} ${task.title}`}>{task.ref} {task.title}</span>
          <span className="spacer" />
          <IconButton label="关闭 (Esc)" onClick={onClose}><IconClose /></IconButton>
        </div>
        {picker ?? (
          <span className="field-hint-line">
            工作台自己的 Agent 用它的工具处理这条任务：读任务和关联、记进展、改状态、建子任务。改代码类的任务仍建议交给 Claude Code
          </span>
        )}

        <div className="ho-perm">
          <Checkbox className="ho-check" checked={resume} disabled={!resumable} onCheckedChange={setResumeChoice}>接着上次的会话</Checkbox>
          <span className="field-hint-line">
            {resumable ? (resume ? '用上次执行的 Agent 和会话接着做，上次的对话一起带上；下面的 Agent 不用选' : '不勾就新开一个会话')
              : '这条任务还没交给工作台 Agent 执行过，没有可续的会话'}
          </span>
        </div>

        {!resume && (
          <div className="ho-preset">
            <div className="ho-preset-head">
              <label className="field-label" htmlFor={`${id}-agent`}>Agent</label>
              <span className="spacer" />
              <Link className="ho-preset-manage" to="/settings/agents" onClick={onClose}>管理 Agent</Link>
            </div>
            <Select id={`${id}-agent`} value={agentId} disabled={!agents.data?.length}
              onValueChange={(v) => { setChosenAgent(v); setProviderId(''); setModel('') }}
              options={(agents.data ?? []).filter((a) => a.enabled).map((a) => ({ value: a.id, label: a.name }))} />
            <span className="field-hint-line ho-preset-text">
              {blocker || (agent?.desc ? agent.desc : '工具授权按这个 Agent 的「工具与权限」：需确认的写操作会停下等你确认')}
            </span>
          </div>
        )}

        <ProviderModelFields options={providerOptions(providers.data, agent)} providerId={providerId} onProvider={setProviderId}
          model={model} onModel={setModel} provider={effProvider}
          placeholder={providerId ? (effProvider?.model || '按服务商设置') : (agent?.model || '按 Agent 设置')} />

        <div className="ho-preset">
          <div className="ho-preset-head">
            <label className="field-label" htmlFor={`${id}-preset`}>角色</label>
            <span className="spacer" />
            <Link className="ho-preset-manage" to="/settings/run-prompts" onClick={onClose}>管理角色</Link>
          </div>
          <Select id={`${id}-preset`} value={presetId} onValueChange={setChosenPreset}
            options={[{ value: NO_PRESET, label: '不用' }, ...(presets.data ?? []).map((p) => ({ value: p.id, label: roleOptionLabel(p) }))]} />
          <span className="field-hint-line ho-preset-text">
            {presets.isError ? `角色没取到：${errorText(presets.error)}`
              : preset ? (roleReadOnly(preset) ? `只读角色：只给 Agent 读的工具，不改任何东西。${preset.content}` : preset.content)
                : '不带角色的执行要求，只按任务内容和补充说明执行'}
          </span>
        </div>

        <Field label="补充说明">
          <Textarea rows={3} value={extra} placeholder="可选：这次要特别注意的事，会接在任务内容后面发给 Agent" onChange={(e) => setExtra(e.target.value)} />
        </Field>

        <details className="ho-preview">
          <summary>预算</summary>
          <div className="ho-row ho-budget">
            <Field label="步数上限" hint={`调一次模型算一步，默认 ${AGENT_RUN_DEFAULTS.steps}，最多 ${AGENT_RUN_DEFAULTS.maxSteps}`}>
              <Input aria-label="步数上限" inputMode="numeric" value={steps} onChange={(e) => setSteps(e.target.value)} />
            </Field>
            <Field label="时长上限（分钟）" hint={`不含等你确认的时间，默认 ${AGENT_RUN_DEFAULTS.minutes}，最多 ${AGENT_RUN_DEFAULTS.maxMinutes}`}>
              <Input aria-label="时长上限（分钟）" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            </Field>
          </div>
          <span className="field-hint-line">超过上限这次执行就失败并写明原因；需要确认的操作 10 分钟没人确认按拒绝处理</span>
        </details>

        <details className="ho-preview" open={preview} onToggle={(e) => setPreview(e.currentTarget.open)}>
          <summary>提示词预览</summary>
          {preview && (
            prompt.isError
              ? <span className="field-err" role="alert">取不到预览：{errorText(prompt.error)}</span>
              : <pre className="ho-prompt" aria-label="提示词预览" aria-busy={prompt.isFetching}>{prompt.data?.prompt ?? '正在生成…'}</pre>
          )}
        </details>

        <div className="ho-foot">
          <span className="field-hint-line">
            {dir ? `写文件写进 ${dir}` : '任务和所属项目都没设工作目录：Agent 不能写文件'}；过程流式显示在执行记录里，结论记成任务进展
          </span>
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={!ready} onClick={submit}>{resume ? '接着上次执行' : '开始执行'}</Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
