// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useSyncExternalStore } from 'react'

// 后台执行的权限（TSK-0499，SPEC-settings-26）：交给 Claude Code 流式执行（claude -p，没人值守）时放行什么。
// 每一档都放行工作台 MCP（server 名 pmw-run）和只读命令白名单；勾「允许写入」后选写入档位。
// 原型只放内存（刷新回到默认：写入档位 accept_edits、自定义白名单为空）；正式产品存在 agent_settings.run_permissions，
// GET / PUT /api/run-permissions，档位清单的唯一真相是 internal/runner/permissions.go。

export type RunPermission = 'read_only' | 'accept_edits' | 'edits_and_tests' | 'custom'
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
  read_only: '只读', accept_edits: '允许改文件', edits_and_tests: '允许改文件 + 跑测试构建', custom: '自定义白名单',
}
export const WRITE_PROFILE_OPTIONS: { value: RunWriteProfile; label: string }[] = [
  { value: 'accept_edits', label: PROFILE_LABEL.accept_edits },
  { value: 'edits_and_tests', label: PROFILE_LABEL.edits_and_tests },
  { value: 'custom', label: PROFILE_LABEL.custom },
]

/** 某一档实际放行的规则（不含 MCP） */
export function allowedOf(p: RunPermission, custom: readonly string[]): string[] {
  return [...READ_ONLY_COMMANDS, ...(p === 'edits_and_tests' ? TEST_COMMANDS : []), ...(p === 'custom' ? custom : [])]
}

export function writeProfileHint(p: RunWriteProfile, custom: readonly string[]): string {
  if (p === 'edits_and_tests') return '再放行测试、构建命令（go test、npm test、make test 等）：会执行项目自己的代码'
  if (p === 'custom') return custom.length ? `再放行设置里的自定义白名单（${custom.length} 条）` : '自定义白名单还是空的，等同「允许改文件」；到设置「执行权限」里加'
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

export type RunPerms = { write_profile: RunWriteProfile; custom: string[] }

let state: RunPerms = { write_profile: 'accept_edits', custom: [] }
const subs = new Set<() => void>()
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }

export function useRunPerms(): RunPerms {
  return useSyncExternalStore(subscribe, () => state)
}

export function saveRunPerms(v: RunPerms) {
  state = { write_profile: v.write_profile, custom: [...v.custom] }
  subs.forEach((f) => f())
}
