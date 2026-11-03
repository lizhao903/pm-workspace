import type { Project } from './projectdata'
import { TASK_STATUS, type Task } from './taskdata'

// 交给 Claude Code 的两种方式（SPEC-tasks-6.10 起）：流式执行、切换到终端。
// 提示词和正式产品 internal/runner/prompt.go 的模板一致；终端的启动命令模板见 SPEC-settings 的「终端」分节。

export type HandoffMode = 'stream' | 'terminal'

/** 设置 > 终端 > Claude Code 启动命令的默认值：用户本机的 shell 别名，展开是 cd /Volumes/docs/Know\ Me && claude --dangerously-skip-permissions */
export const CLAUDE_COMMAND_DEFAULT = 'gogogo'

/** 原型里工作台数据目录下放提示词和 MCP 配置的临时子目录；正式产品是 <数据目录>/tmp/handoff/<执行 id>/ */
export const HANDOFF_TMP = '/Users/me/pm-workspace/data/tmp/handoff'

/** 所属项目的上下文：文档目录取 related 第一个，原型目录取项目登记的原型（相对目录接在项目目录后面） */
export interface ProjectContext {
  name: string
  ref?: string
  workdir?: string
  docsDir?: string
  docsLabel?: string
  prototypes: { name: string; dir: string }[]
}

export function projectContext(p: Pick<Project, 'name' | 'root' | 'related' | 'prototypes'> & { ref?: string } | undefined): ProjectContext | undefined {
  if (!p) return undefined
  const abs = (d: string) => (d.startsWith('/') ? d : `${p.root.replace(/\/+$/, '')}/${d}`.replace(/\/+$/, ''))
  const doc = p.related.find((r) => r.path.trim())
  return {
    name: p.name, ref: p.ref, workdir: p.root || undefined,
    docsDir: doc?.path, docsLabel: doc?.label || undefined,
    prototypes: p.prototypes.map((x) => ({ name: x.name, dir: abs(x.dir) })),
  }
}

/** 预览时还没有执行 id，用这句占位 */
export const RUN_ID_PENDING = '<发起时生成的执行 id>'

export function buildPrompt(o: {
  task: Task; workdir: string; extra: string; mode: HandoffMode; project?: ProjectContext; runId?: string
}): string {
  const { task: t, project: p } = o
  const lines: string[] = []
  lines.push(`你正在协助处理一个来自「产品工作台」的工作对象。请在当前目录（${o.workdir}）内完成它。`, '', '## 任务')
  if (t.ref) lines.push(`编号：${t.ref}`)
  lines.push('类型：任务', `标题：${t.title}`, `状态：${TASK_STATUS[t.status]?.label ?? t.status}`, `优先级：${t.priority}`)
  if (t.due) lines.push(`到期：${t.due}`)
  if (t.repo) lines.push(`关联仓库：${t.repo}`)
  lines.push('')
  if (t.desc.trim()) lines.push('## 任务描述', t.desc.trim(), '')
  if (t.acceptance?.trim()) lines.push('## 验收标准', t.acceptance.trim(), '')
  if (p) {
    lines.push('## 所属项目', `名称：${p.name}${p.ref ? `（${p.ref}）` : ''}`)
    if (p.workdir) lines.push(`项目工作目录：${p.workdir}`)
    lines.push(p.docsDir
      ? `文档在哪里操作：${p.docsDir}${p.docsLabel ? `（项目关联目录「${p.docsLabel}」）` : ''}`
      : '文档在哪里操作：这个项目没有关联文档目录，可在项目设置里补；需要写文档时先问用户放哪里。')
    if (p.prototypes.length) {
      lines.push('原型在哪里操作：', ...p.prototypes.map((x) => `  - ${x.name ? `${x.name}：` : ''}${x.dir}`))
    } else {
      lines.push('原型在哪里操作：这个项目没有登记原型目录，可在项目设置里补；需要改原型时先问用户在哪里改。')
    }
    lines.push('')
  }
  if (o.extra.trim()) lines.push('## 本次执行的补充要求', o.extra.trim(), '')
  if (o.mode === 'terminal') {
    const run = o.runId || RUN_ID_PENDING
    lines.push('## 回写到工作台',
      `这次是从「产品工作台」交给你、在终端里交互执行的（执行记录 ${run}）。工作台的 MCP（server 名 pm-workspace）已经接上，进展和结果请用它写回这条任务，不要只在终端里说：`,
      `1. 开始时：用 pmw_update_object（id=${t.id}）把任务状态改成进行中（状态 key 用 pmw_list_types 查，任务一般是 doing；已经是进行中就不用改），再用 pmw_append_progress 记一句你打算怎么做。`,
      `2. 每产出一件交付物（文档、原型、代码提交等）：调 pmw_record_artifact，带 object_id=${t.id}、run_id=${run}。`,
      '3. 过程中做完一个关键步骤，用 pmw_append_progress 记一条。',
      `4. 结束时（做完、做不下去、或用户让你停下）：调 pmw_finish_run，run_id=${run}，status 填 done 或 failed，summary 写结论摘要：做了什么、产出在哪、还剩什么没做。任务做完了再用 pmw_update_object 改状态。`,
      '')
  }
  lines.push('## 约束', p
    ? '- 所有产出只写在当前目录、以及上面「所属项目」里写明的文档目录和原型目录里，不要改动其他位置的文件。'
    : '- 所有产出只写在当前目录内，不要改动工作区之外的任何文件。',
  '- 完成后用一段话说明你做了什么、改了哪些文件，以及还剩什么没做。')
  return lines.join('\n') + '\n'
}

/** 单引号转义：值里的单引号写成 '\'' */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

const PLACEHOLDER = /(["']?)\{\{\s*(prompt_file|mcp_config|workdir)\s*\}\}\1/g

/**
 * 渲染启动命令：占位符换成已加引号的路径（用户自己包了一层引号也认，去掉那层）；
 * 没写 {{prompt_file}} 在末尾补 "$(cat {{prompt_file}})"，没写 {{mcp_config}} 再补 --mcp-config {{mcp_config}}。
 * 提示词放在 --mcp-config 前面：--mcp-config 能接多个值，放后面的参数会被它吞掉。留空用默认值
 */
export function renderClaudeCommand(template: string, v: { prompt_file: string; mcp_config: string; workdir: string }): string {
  let cmd = template.trim() || CLAUDE_COMMAND_DEFAULT
  const has = (k: string) => new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`).test(cmd)
  if (!has('prompt_file')) cmd += ' "$(cat {{prompt_file}})"'
  if (!has('mcp_config')) cmd += ' --mcp-config {{mcp_config}}'
  return cmd.replace(PLACEHOLDER, (_m, _q, k: keyof typeof v) => shellQuote(v[k]))
}

/** 原型模拟：这次终端执行写出来的两个文件 */
export const handoffFiles = (runId: string) => ({
  prompt_file: `${HANDOFF_TMP}/${runId}/prompt.md`,
  mcp_config: `${HANDOFF_TMP}/${runId}/mcp.json`,
})
