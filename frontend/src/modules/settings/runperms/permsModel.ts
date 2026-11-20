// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置「执行权限」（TSK-0499，SPEC-settings-26）的纯函数：白名单文本和数组互转、前端先挡的规则、地址里带来的待加规则。
// 规则格式和后端 internal/runner/permissions.go 的 CheckRule 一致，前端只挡明显不对的，其余以后端 400 为准。

export const RULES_MAX = 100
export const RULE_MAX_LEN = 200

/** 文本框一行一条：去首尾空白、去空行、去重保序 */
export function parseRules(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const r = line.trim()
    if (r && !out.includes(r)) out.push(r)
  }
  return out
}

/** 等于放开任意命令的写法，不收（同后端） */
const WIDE = new Set(['Bash', 'Bash(*)', 'Bash(:*)', 'Bash()'])

/** 一条规则的问题，没问题回空串 */
export function ruleIssue(r: string): string {
  if (r.length > RULE_MAX_LEN) return `「${r.slice(0, 40)}…」太长，最多 ${RULE_MAX_LEN} 个字符`
  if (WIDE.has(r) || /^Bash\(\s*[*:]/.test(r)) return `「${r}」等于放开任意命令，不收；按命令前缀写，如 Bash(git commit:*)`
  if (r.startsWith('Bash(')) return r.endsWith(')') ? '' : `「${r}」少了右括号，写成 Bash(命令前缀:*)`
  if (r.startsWith('mcp__')) return r.length > 5 ? '' : `「${r}」少了 server 名`
  if (!/^[A-Z][A-Za-z0-9_]*(\(.*\))?$/.test(r)) return `「${r}」不像 Claude Code 的权限规则：写成 Bash(命令前缀:*)、mcp__server 或工具名`
  return ''
}

/** 整组的第一个问题，没问题回空串 */
export function rulesIssue(rules: readonly string[]): string {
  if (rules.length > RULES_MAX) return `自定义白名单最多 ${RULES_MAX} 条`
  for (const r of rules) {
    const e = ruleIssue(r)
    if (e) return e
  }
  return ''
}

/** 工作台 MCP 的 server 名（同后端 runner.MCPServer） */
const WORKBENCH_MCP = 'mcp__pmw-run'

/**
 * 一条自定义硬拦截的问题（同后端 runner.CheckDenyRule）：写法同白名单，但收 Bash(*) 这类宽规则（只会收紧）；
 * 不收挡掉整个工作台 MCP 的规则
 */
export function denyRuleIssue(r: string): string {
  if (r === WORKBENCH_MCP || r === WORKBENCH_MCP + '__*') return `「${r}」会挡掉工作台 MCP 的全部工具，执行就没法读任务、回写结论；要挡具体工具写全名，如 ${WORKBENCH_MCP}__pmw_update_object`
  if (r === 'Bash' || /^Bash\(.*[^\s].*\)$/.test(r) && r.length <= RULE_MAX_LEN) return ''
  if (r === 'Bash()') return `「${r}」括号里是空的，写成 Bash(命令前缀:*)`
  return ruleIssue(r)
}

/** 自定义硬拦截整组的第一个问题，没问题回空串 */
export function denyRulesIssue(rules: readonly string[]): string {
  if (rules.length > RULES_MAX) return `自定义硬拦截最多 ${RULES_MAX} 条`
  for (const r of rules) {
    const e = denyRuleIssue(r)
    if (e) return e
  }
  return ''
}

/** 地址 ?add= 带来的规则（执行记录「去设置放行」），去掉已经在白名单里的 */
export function pendingRules(add: string | null, have: readonly string[]): string[] {
  if (!add) return []
  return parseRules(add).filter((r) => !have.includes(r))
}
