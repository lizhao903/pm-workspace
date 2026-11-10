// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 启动命令的渲染（终端插件 0.2.0）：设置页的预览用，规则和后端 internal/plugins/terminal/launch.go 的 RenderClaudeCommand 一致，
// 真正执行的那条以后端渲染的为准（新建会话响应里的 command）
export const DEFAULT_CLAUDE_COMMAND = 'gogogo'

export const PLACEHOLDERS = {
  prompt: '{{prompt_file}}',
  mcp: '{{mcp_config}}',
  workdir: '{{workdir}}',
} as const

export type LaunchPaths = { prompt_file: string; mcp_config: string; workdir: string }

/** 单引号引起来，路径里的单引号转义成 '\'' */
export const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/**
 * 没写 {{prompt_file}} 就在末尾补 "$(cat {{prompt_file}})"，没写 {{mcp_config}} 就补 --mcp-config {{mcp_config}}；
 * 提示词放在 --mcp-config 前面，因为 --mcp-config 能接多个值。占位符换成引好的路径，外面多包的一层引号去掉
 */
export function renderClaudeCommand(tmpl: string, p: LaunchPaths): string {
  let cmd = tmpl.trim() || DEFAULT_CLAUDE_COMMAND
  if (!cmd.includes(PLACEHOLDERS.prompt)) cmd += ` "$(cat ${PLACEHOLDERS.prompt})"`
  if (!cmd.includes(PLACEHOLDERS.mcp)) cmd += ` --mcp-config ${PLACEHOLDERS.mcp}`
  const vals: [string, string][] = [[PLACEHOLDERS.prompt, p.prompt_file], [PLACEHOLDERS.mcp, p.mcp_config], [PLACEHOLDERS.workdir, p.workdir]]
  for (const [ph, v] of vals) {
    const q = shellQuote(v)
    cmd = cmd.replaceAll(`"${ph}"`, q).replaceAll(`'${ph}'`, q).replaceAll(ph, q)
  }
  return cmd
}

/** 设置页能看的错：只能写一行 */
export function commandError(v: string): string | undefined {
  if (/[\r\n]/.test(v)) return '只能写一行，多条命令用 && 或 ; 连起来'
  if (v.trim().length > 2000) return '最多 2000 个字'
}
