// 条件是一句话的修复指引（TSK-0498）：TSK-0490 之前存进来的条件分支 / 条件回退，rule 写的是一句话，
// 执行器只认「字段 + 运算符 + 值」，执行到这一步必然失败。这里判断哪些旧规则算一句话、生成失败说明（文案与后端逐字一致），
// 流程库、流程详情、运行页共用；口径同后端 internal/plugins/sop 的 cond.go legacyCond 与 check.go codeRuleText。
import type { SopIssue, SopStepDef } from '../../core/data'
import { legacyCond } from './cond'

/** 条件是一句话的错误码：流程体检 issue 的 code、执行步骤的 error_code 都用它（同后端） */
export const RULE_TEXT_CODE = 'rule_text'

/** 条件是一句话：有内容、但不是「字段 空格 等于|不等于|包含|不包含 空格 值」的旧写法（空 rule 是人工判断，不算） */
export function ruleIsSentence(rule?: string): boolean {
  const r = rule?.trim() ?? ''
  return !!r && legacyCond(r) === null
}

/** 4.3 的失败说明；IM 触发的流程后面再加一句按会话、@我 去触发过滤里配（固定文案，与后端逐字一致） */
export function ruleSentenceText(rule: string, trigger?: string): string {
  const base = `条件「${rule.trim()}」是一句话，程序没法照着判断。到流程编辑里把这一步的条件改成「字段 + 运算符 + 值」（从这一步能拿到的字段里选，可多条且 / 或），这句话可以留在步骤说明里`
  return trigger === 'im'
    ? `${base}；按来源会话、是否 @我 筛消息不用判断步骤，在触发方式「IM 消息」下面选「只接这些会话」和「与我的关系」，要拦住后面的流程就打开「命中后不再触发后面的 IM 流程」`
    : base
}

/** 一条需修复的步骤：步骤名 + 4.3 的说明 */
export type RuleTextFix = { name: string; text: string }

/**
 * 把流程体检里 code=rule_text 的问题收成给人看的逐条修复指引：步骤名按 step 下标取，
 * 说明按这一步现在的 rule 重新生成（固定文案），取不到 rule 时退回后端给的 text
 */
export function ruleTextFixes(issues: readonly SopIssue[] | undefined, steps: readonly SopStepDef[], trigger: string): RuleTextFix[] {
  return (issues ?? []).filter((x) => x.code === RULE_TEXT_CODE).map((x) => {
    const step = x.step !== undefined ? steps[x.step] : undefined
    const name = step?.name ?? (x.step !== undefined ? `第 ${x.step + 1} 步` : '流程')
    const text = step?.rule && ruleIsSentence(step.rule) ? ruleSentenceText(step.rule, trigger) : x.text
    return { name, text }
  })
}
