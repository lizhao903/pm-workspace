// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useSyncExternalStore } from 'react'

// 后台执行的权限（TSK-0499，SPEC-settings-26）：交给 Claude Code 流式执行（claude -p，没人值守）时放行什么、硬拦什么。
// 每一档都放行工作台 MCP（server 名 pmw-run）和只读命令白名单；勾「允许写入」后选写入档位（含「自动审核」auto）。
// 每一档都传硬拦截（内置 + 自定义，--disallowedTools），优先于白名单和自动审核。
// 原型只放内存（刷新回到默认：写入档位 accept_edits、自定义白名单和自定义硬拦截为空）；正式产品存在 agent_settings.run_permissions，
// GET / PUT /api/run-permissions，档位清单的唯一真相是 internal/runner/permissions.go。

export type RunPermission = 'read_only' | 'accept_edits' | 'edits_and_tests' | 'custom' | 'auto'
export type RunWriteProfile = Exclude<RunPermission, 'read_only'>

export const MCP_SERVER = 'pmw-run'

export const READ_ONLY_COMMANDS = [
  'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git blame:*)', 'Bash(git ls-files:*)', 'Bash(git rev-parse:*)',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(grep:*)', 'Bash(sort:*)', 'Bash(uniq:*)', 'Bash(cut:*)', 'Bash(jq:*)', 'Bash(pwd)',
  'Bash(sqlite3 -readonly -safe:*)', 'Bash(sqlite3 -safe -readonly:*)',
]
export const TEST_COMMANDS = [
  'Bash(go test:*)', 'Bash(go vet:*)', 'Bash(go build:*)', 'Bash(gofmt -l:*)', 'Bash(make test:*)', 'Bash(make build:*)',
  'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(npm run typecheck:*)', 'Bash(npm run build:*)', 'Bash(npm run lint:*)',
  'Bash(npx tsc:*)', 'Bash(npx vitest:*)', 'Bash(pytest:*)', 'Bash(cargo test:*)', 'Bash(cargo build:*)',
]

export const PROFILE_LABEL: Record<RunPermission, string> = {
  read_only: '只读', accept_edits: '允许改文件', edits_and_tests: '允许改文件 + 跑测试构建', custom: '自定义白名单', auto: '自动审核',
}
export const WRITE_PROFILE_OPTIONS: { value: RunWriteProfile; label: string }[] = [
  { value: 'accept_edits', label: PROFILE_LABEL.accept_edits },
  { value: 'edits_and_tests', label: PROFILE_LABEL.edits_and_tests },
  { value: 'custom', label: PROFILE_LABEL.custom },
  { value: 'auto', label: PROFILE_LABEL.auto },
]

/** DeepSeek（dsh）没有对应的写入档位：自定义白名单（没有命令白名单）、自动审核（没有分类器和硬拦截） */
export const DSH_UNSUPPORTED: readonly RunWriteProfile[] = ['custom', 'auto']

/** 某一档实际放行的规则（不含 MCP） */
export function allowedOf(p: RunPermission, custom: readonly string[]): string[] {
  return [...READ_ONLY_COMMANDS, ...(p === 'edits_and_tests' ? TEST_COMMANDS : []), ...(p === 'custom' || p === 'auto' ? custom : [])]
}

export function writeProfileHint(p: RunWriteProfile, custom: readonly string[]): string {
  if (p === 'edits_and_tests') return '再放行测试、构建命令（go test、npm test、make test 等）：会执行项目自己的代码'
  if (p === 'custom') return custom.length ? `再放行设置里的自定义白名单（${custom.length} 条）` : '自定义白名单还是空的，等同「允许改文件」；到设置「执行权限」里加'
  if (p === 'auto') return `白名单外的命令不再一律被拒，由 Claude Code 自动审核按这次任务的意图决定放不放${custom.length ? `；自定义白名单（${custom.length} 条）直接放行` : ''}。推 main、强推、rm -rf 等硬拦截照样挡`
  return '只放开文件编辑；命令只放行只读的'
}

/** 一条规则的问题（口径同后端 CheckRule），没问题回空串 */
export function ruleIssue(r: string): string {
  if (r.length > 200) return `「${r.slice(0, 40)}…」太长，最多 200 个字符`
  if (['Bash', 'Bash(*)', 'Bash(:*)', 'Bash()'].includes(r) || /^Bash\(\s*[*:]/.test(r)) return `「${r}」等于放开任意命令，不收；按命令前缀写，如 Bash(git commit:*)`
  if (r.startsWith('Bash(')) return r.endsWith(')') ? '' : `「${r}」少了右括号，写成 Bash(命令前缀:*)`
  if (r.startsWith('mcp__')) return r.length > 5 ? '' : `「${r}」少了 server 名`
  if (!/^[A-Z][A-Za-z0-9_]*(\(.*\))?$/.test(r)) return `「${r}」不像 Claude Code 的权限规则：写成 Bash(命令前缀:*)、mcp__server 或工具名`
  return ''
}

/** 工作台 MCP 的放行规则（同后端 runner.MCPAllowRule） */
const WORKBENCH_MCP = `mcp__${MCP_SERVER}`

/**
 * 一条自定义硬拦截的问题（口径同后端 CheckDenyRule）：写法同白名单，但收 Bash、Bash(*) 这类宽规则（只会收紧）；
 * 不收挡掉整个工作台 MCP 的规则
 */
export function denyRuleIssue(r: string): string {
  if (r === WORKBENCH_MCP || r === WORKBENCH_MCP + '__*') return `「${r}」会挡掉工作台 MCP 的全部工具，执行就没法读任务、回写结论；要挡具体工具写全名，如 ${WORKBENCH_MCP}__pmw_update_object`
  if (r.length > 200) return `「${r.slice(0, 40)}…」太长，最多 200 个字符`
  if (r === 'Bash' || /^Bash\(.*\S.*\)$/.test(r)) return ''
  if (r === 'Bash()') return `「${r}」括号里是空的，写成 Bash(命令前缀:*)`
  return ruleIssue(r)
}

/** 自定义硬拦截整组的第一个问题，没问题回空串 */
export function denyRulesIssue(rules: readonly string[]): string {
  if (rules.length > 100) return '自定义硬拦截最多 100 条'
  return rules.map(denyRuleIssue).find((e) => e) ?? ''
}

/**
 * 内置硬拦截（删不掉），按组。原型照后端 internal/runner/deny.go 的 BuiltinDenyGroups 生成，
 * 数据目录用演示的 ~/pm-workspace/data（正式产品是本实例的数据目录），对外地址只列 bro.vip
 */
export type DenyGroup = { key: string; label: string; rules: string[] }
export const DEMO_DATA_DIR = '~/pm-workspace/data'
export const BUILTIN_DENY: DenyGroup[] = (() => {
  const push: string[] = [], force: string[] = [], reset: string[] = [], clean: string[] = [], branch: string[] = []
  for (const g of ['git', 'git -C *']) {
    for (const b of ['main', 'master']) {
      push.push(`Bash(${g} push * ${b})`, `Bash(${g} push * ${b} *)`, `Bash(${g} push *:${b})`, `Bash(${g} push *:${b} *)`,
        `Bash(${g} push *:refs/heads/${b})`, `Bash(${g} push *:refs/heads/${b} *)`)
    }
    push.push(`Bash(${g} push *--all*)`, `Bash(${g} push *--mirror*)`)
    force.push(`Bash(${g} push *--force*)`, `Bash(${g} push -f *)`, `Bash(${g} push * -f *)`, `Bash(${g} push * -f)`, `Bash(${g} push * +*)`)
    reset.push(`Bash(${g} reset *--hard*)`)
    clean.push(`Bash(${g} clean*)`)
    branch.push(`Bash(${g} branch *-D*)`, `Bash(${g} branch *--delete *--force*)`, `Bash(${g} branch *--force *--delete*)`,
      `Bash(${g} branch *-d -f*)`, `Bash(${g} branch *-f -d*)`)
  }
  const rm: string[] = []
  for (const f of ['-rf', '-fr', '-Rf', '-fR']) rm.push(`Bash(rm ${f}*)`, `Bash(rm * ${f}*)`)
  rm.push('Bash(rm -r -f*)', 'Bash(rm -f -r*)', 'Bash(rm -R -f*)', 'Bash(rm -f -R*)', 'Bash(rm *--recursive *--force*)', 'Bash(rm *--force *--recursive*)')
  // 演示的数据目录（正式产品编辑工具写绝对路径 Edit(//…/**)，原型用 ~ 写法从简）
  const base = 'data'
  const dataDir = [`Edit(${DEMO_DATA_DIR}/**)`, `Write(${DEMO_DATA_DIR}/**)`,
    ...['/*', '.*', '~*', ''].map((p) => `Bash(sqlite3 ${p}${base}/*)`),
    ...['/*', '.*', '~*', ''].map((p) => `Bash(sqlite3 -safe ${p}${base}/*)`),
    ...'abcdefghijklmnopqtuvwxyz'.split('').map((c) => `Bash(sqlite3 -${c}*${base}/*)`),
    `Bash(sqlite3 -se*${base}/*)`, `Bash(sqlite3 -st*${base}/*)`]
  return [
    { key: 'push_main', label: '推送到 main / master', rules: push },
    { key: 'force_push', label: '强推（--force、-f、--force-with-lease、+分支）', rules: force },
    { key: 'reset_hard', label: 'git reset --hard', rules: reset },
    { key: 'git_clean', label: 'git clean', rules: clean },
    { key: 'branch_delete', label: '强删分支（git branch -D）', rules: branch },
    { key: 'rm_rf', label: 'rm -rf / rm -fr', rules: rm },
    { key: 'kill', label: '杀进程、动系统服务（kill、pkill、killall、launchctl）', rules: ['Bash(kill*)', 'Bash(pkill*)', 'Bash(launchctl*)'] },
    { key: 'data_dir', label: `写工作台自己的数据目录（${DEMO_DATA_DIR}）`, rules: dataDir },
    { key: 'admin_api', label: '调工作台的管理接口（/api/admin/）', rules: ['curl', 'wget', 'http'].map((c) => `Bash(${c} *bro.vip/api/admin*)`) },
  ]
})()

/** 被拒提示里有命中硬拦截的那一句（后端 denialReason 的「命中硬拦截」） */
export function hardDenied(error: string): boolean {
  return error.includes('命中硬拦截')
}

export function parseRules(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const r = line.trim()
    if (r && !out.includes(r)) out.push(r)
  }
  return out
}

/** 被拒提示里的「建议放行：`规则`、`规则`。」取出规则（格式同后端 denialReason） */
export function allowRulesOf(error: string): string[] {
  const i = error.indexOf('建议放行：')
  if (i < 0) return []
  const tail = error.slice(i + '建议放行：'.length)
  const end = tail.indexOf('。')
  const out: string[] = []
  for (const m of (end < 0 ? tail : tail.slice(0, end)).matchAll(/`([^`]+)`/g)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

export type RunPerms = { write_profile: RunWriteProfile; custom: string[]; deny: string[] }

let state: RunPerms = { write_profile: 'accept_edits', custom: [], deny: [] }
const subs = new Set<() => void>()
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }

export function useRunPerms(): RunPerms {
  return useSyncExternalStore(subscribe, () => state)
}

export function saveRunPerms(v: RunPerms) {
  state = { write_profile: v.write_profile, custom: [...v.custom], deny: [...v.deny] }
  subs.forEach((f) => f())
}
