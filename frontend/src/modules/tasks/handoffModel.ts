// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 交给 Claude Code（DEV-09）的纯函数：默认工作目录、请求体、运行中的那条；两种方式（0048）的文案和终端执行的善后。
import {
  runFinished, type AgentProvider, type RunMode, type RunnerProblem, type RunnerStatus, type RunPermissions, type RunPreset, type RunRequest, type RunWriteProfile,
  type TaskRun, type TerminalRunRequest,
} from '../../core/data'
import type { LiveRun } from './runLive'

// ---- 交给谁（TSK-0722）：一个「交给执行」入口，弹窗最上面选执行器 ----

/** 三种执行器，顺序同 GET /api/runners */
export type Who = 'claude' | 'deepseek' | 'agent'
export const WHO_ORDER: readonly Who[] = ['claude', 'deepseek', 'agent']
export const WHO_LABEL: Record<Who, string> = { claude: 'Claude Code', deepseek: 'DeepSeek', agent: '工作台 Agent' }

/** 每种执行器一句话：怎么跑、适合什么 */
export function whoHint(who: Who): string {
  if (who === 'deepseek') return 'deepseek-harness（dsh）在后台跑 DeepSeek 模型，命令在它的沙箱里执行，经工作台 MCP 回写进展和结论；适合读需求写方案、整理分析'
  if (who === 'agent') return '工作台自己的 Agent 用它的工具处理这条任务：读任务和关联、记进展、改状态、建子任务。改代码类的任务仍建议交给 Claude Code'
  return '本机 Claude Code：后台执行或切换到终端交互，适合改代码、动文件、跑测试'
}

/** 这种执行器的状态；状态还没取到（或取不到）时为 undefined，按可用处理，不挡发起，由后端兜底 */
export function runnerOf(list: readonly RunnerStatus[] | undefined, who: Who): RunnerStatus | undefined {
  return list?.find((r) => r.harness === who)
}

/** 第一个让它不能用的问题；能用回 undefined */
export function blockingProblem(st: RunnerStatus | undefined): RunnerProblem | undefined {
  return st?.problems.find((p) => p.blocking)
}

/** 置灰时说的那句：缺什么 + 怎么修 */
export function problemText(p: RunnerProblem): string {
  return p.fix ? `${p.message}。${p.fix}` : p.message
}

/** 打开时选谁：用户选过的（还能用）优先，否则按顺序第一个能用的；都不能用回 claude（弹窗里照样说原因） */
export function pickWho(list: readonly RunnerStatus[] | undefined, chosen: Who | null): Who {
  const usable = (w: Who) => !blockingProblem(runnerOf(list, w))
  if (chosen && usable(chosen)) return chosen
  return WHO_ORDER.find(usable) ?? 'claude'
}

/** dsh 能接的服务商协议，同后端 runner.DSHCompatible */
export const DSH_KINDS: readonly string[] = ['openai', 'anthropic', 'ollama']

/** DeepSeek 的服务商下拉：空值是「默认」（后端挑的那个），其余是 dsh 能接、启用的服务商 */
export function dshProviderOptions(providers: readonly AgentProvider[] | undefined, st: RunnerStatus | undefined): { value: string; label: string }[] {
  const head = { value: '', label: st?.provider_id ? `默认（${st.provider_name}${st.model ? ' · ' + st.model : ''}）` : '默认（带 deepseek 的服务商优先）' }
  return [head, ...(providers ?? []).filter((p) => p.enabled && DSH_KINDS.includes(p.kind)).map((p) => ({ value: p.id, label: p.name }))]
}

/** 交给 DeepSeek 时能不能续跑：最近一次 DeepSeek 执行留了 dsh 会话（同后端：最近 20 条里找） */
export function canResumeDSH(rows: readonly TaskRun[] | undefined): boolean {
  return !!rows?.some((r) => r.harness === 'deepseek' && !!r.harness_session?.trim())
}

/** 交给 DeepSeek 的请求体：同 Claude Code 的再加执行器、服务商、模型、续跑；空的不带 */
export function deepseekRunRequest(base: RunRequest, f: { providerId: string; model: string; resume: boolean }): RunRequest {
  const req: RunRequest = { ...base, harness: 'deepseek' }
  if (f.providerId) req.provider_id = f.providerId
  if (f.model.trim()) req.model = f.model.trim()
  if (f.resume) req.resume_session = true
  return req
}

// 弹窗打开时的工作目录：任务上设的优先，没设用所属项目的
export function defaultWorkdir(taskDir: string, inheritDir?: string): { dir: string; from: 'task' | 'project' | '' } {
  if (taskDir.trim()) return { dir: taskDir.trim(), from: 'task' }
  if (inheritDir?.trim()) return { dir: inheritDir.trim(), from: 'project' }
  return { dir: '', from: '' }
}

// 请求体（契约 POST /api/objects/{id}/run）：目录、附加说明、允许写入、权限档位（TSK-0499：不允许写入时 read_only，
// 允许时是选的写入档位），选了角色时多一个 preset_id（SPEC-tasks-6.18）
export function runRequest(workdir: string, extra: string, allowWrites: boolean, presetId = '', writeProfile: RunWriteProfile = 'accept_edits'): RunRequest {
  return {
    workdir: workdir.trim(), extra_prompt: extra.trim(), allow_writes: allowWrites,
    permission: allowWrites ? writeProfile : 'read_only',
    ...(presetId ? { preset_id: presetId } : {}),
  }
}

/** 写入档位的选项（TSK-0499），顺序同后端；文字跟设置「执行权限」一致 */
export const WRITE_PROFILE_OPTIONS: { value: RunWriteProfile; label: string }[] = [
  { value: 'accept_edits', label: '允许改文件' },
  { value: 'edits_and_tests', label: '允许改文件 + 跑测试构建' },
  { value: 'custom', label: '自定义白名单' },
]

/**
 * 写入档位的选项按执行器给（TSK-0722）：DeepSeek（dsh）没有命令白名单，「自定义白名单」置灰；
 * 另两档在 dsh 里都是 workspace-write 沙箱
 */
export function writeProfileOptions(who: Who): { value: RunWriteProfile; label: string; disabled?: boolean }[] {
  if (who !== 'deepseek') return WRITE_PROFILE_OPTIONS
  return WRITE_PROFILE_OPTIONS.map((o) => (o.value === 'custom' ? { ...o, label: `${o.label}（DeepSeek 没有，不可选）`, disabled: true } : o))
}

/**
 * 弹窗里实际用的写入档位：用户选过的优先，没选过跟设置里的默认，设置还没到用 accept_edits。
 * 交给 DeepSeek 时「自定义白名单」没有对应，退回「允许改文件」
 */
export function pickedWriteProfile(chosen: RunWriteProfile | null, settings?: Pick<RunPermissions, 'write_profile'>, who: Who = 'claude'): RunWriteProfile {
  const p = chosen ?? settings?.write_profile ?? 'accept_edits'
  return who === 'deepseek' && p === 'custom' ? 'accept_edits' : p
}

/** 写入档位下面那行说明：每档额外放开什么；DeepSeek 说 dsh 沙箱的口径 */
export function writeProfileHint(p: RunWriteProfile, custom: readonly string[] = [], who: Who = 'claude'): string {
  if (who === 'deepseek') return 'dsh 没有命令白名单：这一档是 workspace-write 沙箱，能写工作目录（和软链接进来的目录），命令（含测试构建）都在沙箱里跑，写不出工作目录'
  if (p === 'edits_and_tests') return '再放行测试、构建命令（go test、npm test、make test 等）：会执行项目自己的代码'
  if (p === 'custom') return custom.length ? `再放行设置里的自定义白名单（${custom.length} 条）` : '自定义白名单还是空的，等同「允许改文件」；到设置「执行权限」里加'
  return '只放开文件编辑；命令只放行只读的'
}

/** 角色选「不用」时的值 */
export const NO_PRESET = ''

/**
 * 弹窗里实际选中的角色 id（SPEC-tasks-6.18）：用户选过的优先（选的那条被删了算「不用」），
 * 没选过取标了默认的那条，没有默认为「不用」
 */
export function pickedPreset(list: readonly RunPreset[] | undefined, chosen: string | null): string {
  const xs = list ?? []
  if (chosen !== null) return xs.some((p) => p.id === chosen) ? chosen : NO_PRESET
  return xs.find((p) => p.default)?.id ?? NO_PRESET
}

/** 角色是否只读；没带 permission 的按 accept_edits（同后端） */
export function roleReadOnly(p: RunPreset | undefined): boolean {
  return p?.permission === 'read_only'
}

/**
 * 流式执行实际放不放开文件编辑（AUTO-03）：只读角色锁成只读；允许改文件的角色默认勾上，用户还能取消；
 * 没选角色时默认只读，勾选要二次确认。choice 为 null 表示用户没动过勾选（换角色时清回 null）
 */
export function effectiveAllow(p: RunPreset | undefined, choice: boolean | null): { allow: boolean; locked: boolean } {
  if (p && roleReadOnly(p)) return { allow: false, locked: true }
  if (choice !== null) return { allow: choice, locked: false }
  return { allow: !!p, locked: false }
}

/** 角色下拉里一项的文字：场景名，只读的标出来，默认的标出来 */
export function roleOptionLabel(p: RunPreset): string {
  return `${p.scene}${roleReadOnly(p) ? '（只读）' : ''}${p.default ? '（默认）' : ''}`
}

// 同一任务正在跑的执行：本页刚发起还没收尾的流，或者执行记录里没收尾的那条。
// 返回 run id（还没拿到时为空串）；没有在跑的返回 undefined
export function runningOf(objectId: string, rows: readonly TaskRun[] | undefined, live: readonly LiveRun[]): string | undefined {
  const row = rows?.find((r) => !runFinished(r))
  if (row) return row.id
  const l = live.find((x) => x.objectId === objectId && (x.phase === 'starting' || x.phase === 'streaming'))
  return l ? l.runId ?? '' : undefined
}

/** 终端插件没在跑时「切换到终端」置灰，旁边说这句 */
export const TERMINAL_OFF_HINT = '终端插件没启用，到 设置 > 插件 里启用后可用'

export const MODE_LABEL: Record<RunMode, string> = { stream: '流式执行', terminal: '切换到终端' }

/** 两种方式各自的说明，显示在方式下面 */
export function modeHint(mode: RunMode, terminalOn: boolean): string {
  if (mode === 'stream') return '工作台在后台跑 Claude Code，过程流式显示在任务的执行记录里'
  if (!terminalOn) return TERMINAL_OFF_HINT
  return '在工作台的终端里新开一个标签，执行设置里的启动命令开一个交互式会话；结束和结论由它经 MCP 回写'
}

/** 提交按钮的文案 */
export function submitLabel(mode: RunMode, opts: { typing: boolean; allow: boolean; busy: boolean }): string {
  if (opts.typing) return '正在校验目录'
  if (mode === 'terminal') return opts.busy ? '正在打开终端' : '在终端中打开'
  return opts.allow ? '开始执行（允许写入）' : '开始执行（只读）'
}

/** 终端方式的请求体：没有 allow_writes，权限由用户的启动命令决定；选了角色时带 preset_id */
export function terminalRequest(workdir: string, extra: string, presetId = ''): TerminalRunRequest {
  return { workdir: workdir.trim(), extra_prompt: extra.trim(), ...(presetId ? { preset_id: presetId } : {}) }
}

/** 终端没开出来时给这次执行记的失败结论 */
export function launchFailSummary(err: string): string {
  return `终端没打开：${err}`
}
