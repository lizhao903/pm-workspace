// 交给 Claude Code（DEV-09，照原型 devloop.tsx 的 RunDialog 和 quicksession.tsx 的弹窗样式）。
// 弹窗里选执行方式（0048）、工作目录、附加说明，能展开看将要发出的提示词。
// 流式执行：只读或允许写入（勾「允许写入」先二次确认），走 runLive.startRun，输出在执行记录里流式显示。
// 切换到终端：后端建执行记录、写好提示词和 MCP 配置，经终端插件登记的入口在终端里新开标签执行启动命令，开好后去终端页；
// 终端插件没在跑时这个方式置灰。同一任务有执行在跑时按钮变成「查看运行中」。
// 角色（SPEC-tasks-6.18，AUTO-03 由预置提示词升级）：附加说明上面选一个角色，它的执行要求和输出要求拼进提示词，
// 打开时选上标了默认的那个；在设置「角色」里管理。流式执行的「允许写入」跟着角色走：只读角色锁成只读，
// 允许改文件的角色默认勾上（用户可取消）；没选角色时同以前，默认只读、勾选要二次确认。终端方式的权限由启动命令决定。
// 发起后任务由后端改成进行中（SPEC-tasks-6.17），数据层的 run-started 跟着刷任务。
// 写入档位（TSK-0499）：勾了允许写入后多一个下拉选档位（允许改文件 / 再加测试构建 / 自定义白名单），默认取设置「执行权限」；
// 任何档位都放行工作台 MCP 和只读命令，不用 --dangerously-skip-permissions。
// 交给谁（TSK-0722）：一个「交给执行」按钮，弹窗最上面选 Claude Code / DeepSeek / 工作台 Agent，各自能不能用取 GET /api/runners，
// 不能用的置灰并写缺什么、怎么修（设置「执行器」看详情）。DeepSeek 和 Claude Code 共用这个弹窗：只有后台执行，
// 多服务商和模型、接着上次的会话；写入档位翻成 dsh 的沙箱档位，「自定义白名单」没有对应、置灰。
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router'
import {
  errorText, finishTerminalRun, startTerminalRun, useAgentProviders, useRunners, useRunPermissions, useRunPresets, useRunPrompt, useTaskRuns,
  useWorkdirCheck, workdirUsable,
  type RunMode, type RunnerStatus, type RunWriteProfile, type WorkObject,
} from '../../core/data'
import { useTerminalLauncher } from '../../core/plugin'
import { Button, Checkbox, ConfirmDialog, Field, IconButton, IconClose, Select, Textarea } from '../../core/ui'
import { restoreFocus, trapTab } from '../../core/ui/focus'
import {
  MODE_LABEL, NO_PRESET, WHO_LABEL, WHO_ORDER, blockingProblem, canResumeDSH, deepseekRunRequest, defaultWorkdir, dshProviderOptions, effectiveAllow,
  launchFailSummary, modeHint, pickWho, pickedPreset, pickedWriteProfile, problemText, roleOptionLabel, roleReadOnly, runRequest, runnerOf, runningOf,
  submitLabel, terminalRequest, whoHint, writeProfileHint, writeProfileOptions, type Who,
} from './handoffModel'
import { AgentRunDialog } from './AgentHandOff'
import { ProviderModelFields } from './ProviderModelFields'
import { startRun, useLiveRuns } from './runLive'
import { WorkdirField } from './WorkdirField'
import './handoff.css'

// 和 WorkdirField 一样停手片刻再校验，两边查询键相同，只发一次请求
const CHECK_DELAY = 400

// 滚到执行记录里那一条；还没拿到 run id 时滚到执行记录这一块
function scrollToRun(taskId: string, runId?: string) {
  const find = (sel: string, f: (el: HTMLElement) => boolean) => Array.from(document.querySelectorAll<HTMLElement>(sel)).find(f)
  const el = (runId && find('[data-run]', (x) => x.dataset.run === runId))
    || find('[data-slot="runs"]', (x) => x.dataset.task === taskId)
  el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
}

export function HandOffButton({ task, workdir, inherit, onShowRun }: {
  task: WorkObject
  /** 抽屉里当前填的工作目录（可能还没保存） */
  workdir: string
  inherit?: { project: string; dir: string }
  /**
   * 执行记录在别的标签里时由抽屉切过去（「查看运行中」、流式执行刚发起）；runId 没拿到时不给。
   * 不传时原地滚到执行记录
   */
  onShowRun?: (runId?: string) => void
}) {
  const show = (runId?: string) => (onShowRun ? onShowRun(runId) : scrollToRun(task.id, runId))
  // 「交给执行」一个入口（TSK-0722）：弹窗里选 Claude Code / DeepSeek / 工作台 Agent
  const [open, setOpen] = useState(false)
  const started = () => {
    setOpen(false)
    if (onShowRun) onShowRun()
    else requestAnimationFrame(() => scrollToRun(task.id))
  }
  const rows = useTaskRuns(task.id)
  const live = useLiveRuns()
  const running = runningOf(task.id, rows.data, live)

  if (running !== undefined) {
    return (
      <Button size="sm" variant="outline" onClick={() => show(running || undefined)}>
        <span className="ho-light" aria-hidden="true" />查看运行中
      </Button>
    )
  }
  return (
    <span className="ho-entry">
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>交给执行</Button>
      {open && <HandOffDialog task={task} workdir={workdir} inherit={inherit} onClose={() => setOpen(false)} onStart={started} />}
    </span>
  )
}

/**
 * 「交给执行」弹窗（TSK-0722）：记住交给谁，按它换 Claude Code / DeepSeek 共用的 RunDialog 或工作台 Agent 的弹窗；
 * 「交给谁」那一排由这里画好塞进去，换的时候焦点留在那一排上
 */
export function HandOffDialog({ task, workdir, inherit, onStart, onClose }: {
  task: WorkObject
  workdir: string
  inherit?: { project: string; dir: string }
  onStart: () => void
  onClose: () => void
}) {
  const runners = useRunners()
  const [chosen, setChosen] = useState<Who | null>(null)
  const who = pickWho(runners.data, chosen)
  const [restoreTo] = useState(() => document.activeElement)
  const switched = useRef(false)
  useEffect(() => {
    if (!switched.current) return
    document.querySelector<HTMLInputElement>('.ho-who input:checked')?.focus()
  }, [who])
  const pick = (w: Who) => { switched.current = true; setChosen(w) }
  const picker = <WhoPicker who={who} list={runners.data} onPick={pick} onClose={onClose} />
  const props = { task, workdir, inherit, onStart, onClose, picker, restoreTo }
  if (who === 'agent') return <AgentRunDialog key="agent" {...props} />
  return <RunDialog key={who} {...props} harness={who} runner={runnerOf(runners.data, who)} />
}

/** 「交给谁」一排：不能用的置灰，下面写缺什么、怎么修；选中的有不挡发起的问题（MCP 没接上）也写一句 */
function WhoPicker({ who, list, onPick, onClose }: { who: Who; list: RunnerStatus[] | undefined; onPick: (w: Who) => void; onClose: () => void }) {
  const id = useId()
  const off = WHO_ORDER.map((w) => ({ w, p: blockingProblem(runnerOf(list, w)) })).filter((x) => x.p)
  const warn = runnerOf(list, who)?.problems.find((p) => !p.blocking && p.code === 'no_mcp')
  return (
    <fieldset className="ho-mode ho-who">
      <legend className="ho-mode-label">交给谁</legend>
      <div className="ho-mode-opts">
        {WHO_ORDER.map((w) => {
          const p = blockingProblem(runnerOf(list, w))
          return (
            <label key={w} className={`ho-mode-opt${who === w ? ' on' : ''}${p ? ' off' : ''}`} title={p ? problemText(p) : undefined}>
              <input type="radio" name={`${id}-who`} value={w} checked={who === w} disabled={!!p} onChange={() => onPick(w)} />
              {WHO_LABEL[w]}
            </label>
          )
        })}
      </div>
      <span className="field-hint-line">{whoHint(who)}</span>
      {off.map(({ w, p }) => (
        <span key={w} className="field-hint-line ho-who-off">
          {WHO_LABEL[w]} 不可用：{problemText(p!)}（<Link to="/settings/runners" onClick={onClose}>设置 / 执行器</Link>）
        </span>
      ))}
      {warn && <span className="field-hint-line">{warn.message}，{warn.fix}</span>}
    </fieldset>
  )
}

export function RunDialog({ task, workdir, inherit, onStart, onClose, harness = 'claude', runner, picker, restoreTo }: {
  task: WorkObject
  workdir: string
  inherit?: { project: string; dir: string }
  /** 已经发起，弹窗该关了 */
  onStart: () => void
  onClose: () => void
  /** 交给谁（TSK-0722）：claude 或 deepseek，两者共用这个弹窗 */
  harness?: Exclude<Who, 'agent'>
  /** 这个执行器的状态（DeepSeek 用它的默认服务商和模型） */
  runner?: RunnerStatus
  /** 「交给谁」那一排，放在标题下面 */
  picker?: ReactNode
  /** 关掉时焦点回到哪里（换执行器时弹窗会重建） */
  restoreTo?: Element | null
}) {
  const dsh = harness === 'deepseek'
  const init = defaultWorkdir(workdir, inherit?.dir)
  const launcher = useTerminalLauncher()
  const navigate = useNavigate()
  const [mode, setMode] = useState<RunMode>('stream')
  const [dir, setDir] = useState(init.dir)
  // null 是用户没动过勾选：跟着角色走（见 effectiveAllow）
  const [allowChoice, setAllowChoice] = useState<boolean | null>(null)
  const [asking, setAsking] = useState(false)
  const [extra, setExtra] = useState('')
  const presets = useRunPresets()
  // null 是还没选过：跟着默认那条走（角色列表可能比弹窗晚到）
  const [chosenPreset, setChosenPreset] = useState<string | null>(null)
  const presetId = pickedPreset(presets.data, chosenPreset)
  const preset = presets.data?.find((p) => p.id === presetId)
  const { allow, locked: allowLocked } = effectiveAllow(preset, allowChoice)
  const pickPreset = (v: string) => { setChosenPreset(v); setAllowChoice(null) }
  const perms = useRunPermissions()
  // null 是还没选过：跟设置里的默认写入档位；DeepSeek 没有「自定义白名单」，退回「允许改文件」
  const [chosenProfile, setChosenProfile] = useState<RunWriteProfile | null>(null)
  const writeProfile = pickedWriteProfile(chosenProfile, perms.data, harness)
  // DeepSeek（TSK-0722）：服务商和模型（空是默认那个）、接着上次的会话
  const providers = useAgentProviders()
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const effProvider = providers.data?.find((p) => p.id === (providerId || runner?.provider_id))
  const rows = useTaskRuns(task.id)
  const resumable = dsh && canResumeDSH(rows.data)
  const [resumeChoice, setResumeChoice] = useState(false)
  const resume = resumable && resumeChoice
  const [checked, setChecked] = useState(init.dir)
  // 预览跟着附加说明变，也停手片刻再取
  const [extraSettled, setExtraSettled] = useState('')
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const id = useId()
  const [prev] = useState(() => restoreTo ?? document.activeElement)
  // 终端插件在弹窗开着时被停用：退回流式；DeepSeek 只有后台执行
  const terminalOn = !!launcher
  const effMode: RunMode = dsh || (mode === 'terminal' && !terminalOn) ? 'stream' : mode

  useEffect(() => {
    const p = dir.trim()
    if (p === checked) return
    const t = setTimeout(() => setChecked(p), CHECK_DELAY)
    return () => clearTimeout(t)
  }, [dir, checked])
  useEffect(() => {
    if (extra === extraSettled) return
    const t = setTimeout(() => setExtraSettled(extra), CHECK_DELAY)
    return () => clearTimeout(t)
  }, [extra, extraSettled])
  const prompt = useRunPrompt(task.id, {
    mode: effMode, workdir: checked, extra_prompt: extraSettled, preset_id: presetId || undefined, ...(dsh ? { harness: 'deepseek' as const } : {}),
  }, preview)
  const check = useWorkdirCheck(checked)
  const typing = dir.trim() !== checked

  const closeFn = useRef(onClose)
  const askingRef = useRef(asking)
  useEffect(() => {
    closeFn.current = onClose
    askingRef.current = asking
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current
      // 二次确认开着时键盘归它；选目录里的 Esc 只收起目录
      if (!el || askingRef.current) return
      if (e.key === 'Escape') {
        if (e.target instanceof Element && e.target.closest('.wd-picker')) return
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

  let dirErr = ''
  if (!dir.trim()) dirErr = '选一个工作目录，任务和所属项目都没设'
  const usable = !typing && !!check.data && workdirUsable(check.data)
  const ready = !dirErr && usable && !asking && !busy

  let source = '这次执行用的目录'
  if (init.from === 'task' && dir.trim() === init.dir) source = '任务上设的'
  else if (init.from === 'project' && dir.trim() === init.dir) source = `继承自所属项目「${inherit?.project ?? ''}」`

  const submit = () => {
    if (!ready) return
    if (effMode === 'stream') {
      const base = runRequest(dir, extra, allow, presetId, writeProfile)
      startRun(task.id, dsh ? deepseekRunRequest(base, { providerId, model, resume }) : base)
      onStart()
      return
    }
    void openInTerminal()
  }

  // 先让后端建记录、写临时文件，再让终端插件开标签执行；终端没开出来时把这条记录记成失败，弹窗留着说原因
  const openInTerminal = async () => {
    if (!launcher) return
    setBusy(true)
    setFailed('')
    let runId = ''
    try {
      const h = await startTerminalRun(task.id, terminalRequest(dir, extra, presetId))
      runId = h.run.id
      await launcher.launch({
        cwd: h.workdir, title: task.ref || task.title,
        claude: { prompt_file: h.prompt_file, mcp_config: h.mcp_config, workdir: h.workdir },
      })
      setBusy(false)
      onStart()
      navigate(launcher.page)
    } catch (e) {
      const msg = errorText(e)
      if (runId) void finishTerminalRun(runId, task.id, { status: 'failed', summary: launchFailSummary(msg) }).catch(() => undefined)
      setFailed(runId ? launchFailSummary(msg) : `没发起：${msg}`)
      setBusy(false)
    }
  }

  return createPortal(
    <>
      <div className="dialog-scrim ho-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
        <div ref={ref} className="ho" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} tabIndex={-1}>
          <div className="ho-head">
            <b id={`${id}-t`}>交给 {WHO_LABEL[harness]}</b>
            <span className="ho-sub ellipsis" title={`${task.ref} ${task.title}`}>{task.ref} {task.title}</span>
            <span className="spacer" />
            <IconButton label="关闭 (Esc)" onClick={onClose}><IconClose /></IconButton>
          </div>
          {picker}
          {dsh ? (
            <span className="field-hint-line">DeepSeek 只有后台执行：dsh 在工作台里跑，过程流式显示在任务的执行记录里；不接终端交互</span>
          ) : <fieldset className="ho-mode">
            <legend className="ho-mode-label">执行方式</legend>
            <div className="ho-mode-opts">
              {(['stream', 'terminal'] as const).map((m) => {
                const off = m === 'terminal' && !terminalOn
                return (
                  <label key={m} className={`ho-mode-opt${effMode === m ? ' on' : ''}${off ? ' off' : ''}`}
                    title={off ? modeHint(m, false) : undefined}>
                    <input type="radio" name={`${id}-mode`} value={m} checked={effMode === m} disabled={off || busy}
                      onChange={() => { setMode(m); setFailed('') }} />
                    {MODE_LABEL[m]}
                  </label>
                )
              })}
            </div>
            <span className="field-hint-line">{modeHint(effMode, terminalOn)}</span>
            {!terminalOn && <span className="field-hint-line">切换到终端：{modeHint('terminal', false)}</span>}
          </fieldset>}
          <div className="ho-dir">
            <WorkdirField value={dir} onChange={setDir} />
            {dirErr
              ? <span className="field-err" role="alert">{dirErr}</span>
              : <span className="field-hint-line">{source}</span>}
          </div>
          {dsh && (
            <ProviderModelFields options={dshProviderOptions(providers.data, runner)} providerId={providerId} onProvider={setProviderId}
              model={model} onModel={setModel} provider={effProvider}
              placeholder={effProvider?.model || runner?.model || '按服务商设置'} />
          )}
          {dsh && (
            <div className="ho-perm">
              <Checkbox className="ho-check" checked={resume} disabled={!resumable || busy} onCheckedChange={setResumeChoice}>接着上次的会话</Checkbox>
              <span className="field-hint-line">
                {resumable ? (resume ? '接着这条任务上一次 DeepSeek 执行的 dsh 会话跑，上次的上下文一起带上' : '不勾就新开一个会话')
                  : '这条任务还没交给 DeepSeek 执行过，没有可续的会话'}
              </span>
            </div>
          )}
          <div className="ho-preset">
            <div className="ho-preset-head">
              <label className="field-label" htmlFor={`${id}-preset`}>角色</label>
              <span className="spacer" />
              <Link className="ho-preset-manage" to="/settings/run-prompts" onClick={onClose}>管理角色</Link>
            </div>
            <Select id={`${id}-preset`} value={presetId} disabled={busy} onValueChange={pickPreset}
              options={[{ value: NO_PRESET, label: '不用' }, ...(presets.data ?? []).map((p) => ({ value: p.id, label: roleOptionLabel(p) }))]} />
            <span className="field-hint-line ho-preset-text">
              {presets.isError ? `角色没取到：${errorText(presets.error)}`
                : preset ? preset.content : '不带角色的执行要求，只按任务内容和附加说明执行'}
            </span>
            {preset?.output && <span className="field-hint-line ho-preset-text">输出要求：{preset.output}</span>}
            {effMode === 'terminal' && preset && roleReadOnly(preset) && (
              <span className="field-hint-line">终端方式的权限由启动命令决定：只读角色只在提示词里写明不改文件</span>
            )}
          </div>
          {effMode === 'stream' && <div className="ho-perm">
            <Checkbox className="ho-check" checked={allow} disabled={allowLocked || busy}
              onCheckedChange={(v) => { if (v) setAsking(true); else setAllowChoice(false) }}>
              允许写入
            </Checkbox>
            <span className="field-hint-line">
              {allowLocked ? `角色「${preset?.scene ?? ''}」只读：只跑一遍给结论，不改文件`
                : allow ? `${dsh ? '会以 dsh 的 workspace-write 沙箱运行' : '会以 acceptEdits 权限模式运行'}：可以直接改工作目录里的文件${preset && allowChoice === null ? `（按角色「${preset.scene}」）` : ''}`
                  : dsh ? '默认只读：dsh 沙箱 read-only，命令照跑但写不了文件' : '默认只读：只跑一遍看它打算怎么做，不改文件'}
            </span>
            {allow && (
              <div className="ho-profile">
                <div className="ho-preset-head">
                  <label className="field-label" htmlFor={`${id}-profile`}>写入档位</label>
                  <span className="spacer" />
                  <Link className="ho-preset-manage" to="/settings/run-permissions" onClick={onClose}>管理执行权限</Link>
                </div>
                <Select id={`${id}-profile`} value={writeProfile} disabled={busy}
                  onValueChange={(v) => setChosenProfile(v as RunWriteProfile)} options={writeProfileOptions(harness)} />
                <span className="field-hint-line">{writeProfileHint(writeProfile, perms.data?.custom, harness)}</span>
              </div>
            )}
            <span className="field-hint-line">
              {dsh ? '工作台 MCP 照常接上（回写进展和结论）；dsh 没有命令白名单，命令都在它的沙箱里跑，所以没有「自定义白名单」'
                : '任何档位都放行工作台 MCP（回写进展和结论）和只读命令（git log、grep、sqlite3 -readonly -safe 等）'}
            </span>
          </div>}
          <Field label="附加说明">
            <Textarea rows={3} value={extra} autoFocus
              placeholder={`可选：这次要特别注意的事，会接在任务内容后面发给 ${WHO_LABEL[harness]}`}
              onChange={(e) => setExtra(e.target.value)} />
          </Field>
          <details className="ho-preview" open={preview} onToggle={(e) => setPreview(e.currentTarget.open)}>
            <summary>提示词预览</summary>
            {preview && (
              prompt.isError
                ? <span className="field-err" role="alert">取不到预览：{errorText(prompt.error)}</span>
                : <pre className="ho-prompt" aria-label="提示词预览" aria-busy={prompt.isFetching}>{prompt.data?.prompt ?? '正在生成…'}</pre>
            )}
          </details>
          {failed && <span className="field-err" role="alert">{failed}</span>}
          <div className="ho-foot">
            <span className="field-hint-line">
              {effMode === 'terminal' ? '执行记录里会记一条「终端」，结束后由 Claude Code 回写结论'
                : dsh ? '执行过程会流式显示在任务的执行记录里，结论经工作台 MCP 回写' : '执行过程会流式显示在任务的执行记录里'}
            </span>
            <span className="spacer" />
            <Button variant="ghost" onClick={onClose}>取消</Button>
            <Button variant="primary" disabled={!ready} onClick={submit}>
              {resume ? '接着上次执行' : submitLabel(effMode, { typing: typing && !dirErr, allow, busy })}
            </Button>
          </div>
        </div>
      </div>
      <ConfirmDialog open={asking} danger title="允许写入？" confirmLabel="确认允许写入" cancelLabel="算了，只读"
        onConfirm={() => { setAllowChoice(true); setAsking(false) }} onCancel={() => setAsking(false)}>
        {dsh ? <>
          会以 dsh 的 workspace-write 沙箱运行：DeepSeek 可以不经确认直接改「{dir.trim() || '工作目录'}」里的文件，命令在沙箱里跑，写不出这个目录。
          不会开 danger-full-access。
        </> : <>
          会以 acceptEdits 权限模式运行：Claude Code 可以不经确认直接改「{dir.trim() || '工作目录'}」里的文件。
          其他需要权限的操作仍会被挡下，任何情况下都不会跳过权限确认。
        </>}
      </ConfirmDialog>
    </>,
    document.body,
  )
}
