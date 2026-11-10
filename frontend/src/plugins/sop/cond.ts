// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 结构化条件（TSK-0490，契约「结构化条件」）：条件分支、条件回退的条件存成「字段 + 运算符 + 值」的结构，可多条且 / 或。
// 不做自然语言转规则：旧的一行规则只为已有流程保留，写法对得上的（「字段 等于 值」）能一键换成等价的结构化条件；
// 写成一句话的执行不了，只能把话挪进说明、重新挑字段。口径同后端 internal/plugins/sop/cond.go。
import { SOP_COND_OPS, type SopCond, type SopCondItem, type SopCondOp, type SopStepDef } from '../../core/data'

/** 旧规则的写法（同后端 ruleRe） */
export const RULE_RE = /^\s*(\S+)\s+(不等于|等于|不包含|包含)\s+(.*?)\s*$/
const RULE_OPS: Record<string, SopCondOp> = { 等于: 'eq', 不等于: 'ne', 包含: 'contains', 不包含: 'not_contains' }

/** 值去掉一层引号（同后端 unquote） */
function unquote(s: string) {
  for (const [a, b] of [['"', '"'], ["'", "'"], ['「', '」'], ['“', '”']]) {
    if (s.length >= a.length + b.length && s.startsWith(a) && s.endsWith(b)) return s.slice(a.length, s.length - b.length)
  }
  return s
}

/** 旧规则换成等价的结构化条件；不是旧写法（一句话）回 null */
export function legacyCond(rule: string): SopCond | null {
  const m = RULE_RE.exec(rule)
  if (!m) return null
  return { logic: 'and', items: [{ field: m[1], op: RULE_OPS[m[2]], value: unquote(m[3]) }] }
}

export const opLabel = (op: string) => SOP_COND_OPS.find((o) => o.value === op)?.label ?? op
export const unaryOp = (op: string) => op === 'empty' || op === 'not_empty'

/** 给人看的一句：「relevance 等于 me 且 channel 不为空」（同后端 condText） */
export function condText(c: SopCond): string {
  const q = (v: string) => (v === '' || /\s/.test(v) ? JSON.stringify(v) : v)
  return c.items.map((it) => (unaryOp(it.op) ? `${it.field || '（没选字段）'} ${opLabel(it.op)}` : `${it.field || '（没选字段）'} ${opLabel(it.op)} ${q(it.value)}`))
    .join(c.logic === 'or' ? ' 或 ' : ' 且 ')
}

/** 新建条件分支、条件回退时的空条件：一条，字段等着选 */
export const blankCond = (): SopCond => ({ logic: 'and', items: [blankItem()] })
export const blankItem = (): SopCondItem => ({ field: '', op: 'eq', value: '' })

/** 这一步写了条件（cond 或旧规则）；条件分支两样都没有是人工判断 */
export const hasCondition = (s: SopStepDef) => !!s.cond || !!s.rule?.trim()

/** 结构上的问题（字段这一步拿不拿得到由后端按节点声明查，保存时带回来）；同后端 condProblems */
export function condProblems(c: SopCond): string[] {
  const out: string[] = []
  if (!c.items.length) out.push('条件是空的：至少要有一条「字段 + 运算符 + 值」，要人来选就删掉条件')
  c.items.forEach((it, i) => {
    const n = `第 ${i + 1} 条条件`
    if (!it.field.trim()) out.push(`${n}没选字段`)
    if ((it.op === 'contains' || it.op === 'not_contains') && it.value === '') out.push(`${n}「${opLabel(it.op)}」后面要有值`)
  })
  return out
}

/** 画布、流程图上的一行：结构化条件写出来，旧规则原样，都没有为空串 */
export function condLine(s: SopStepDef): string {
  if (s.cond) return condText(s.cond)
  return s.rule?.trim() ?? ''
}
