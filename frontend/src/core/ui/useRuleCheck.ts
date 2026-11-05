// 定时规则的校验和预览（ScheduleRuleEditor 配套）：前端先挡一遍，再停手一会儿请求后端预览接下来几次。
import { useEffect, useState } from 'react'
import { errorText, useSchedulePreview, type ScheduleRule } from '../data'
import { ruleError } from './scheduleRule'

// 改规则时停手多久再去预览
const PREVIEW_DELAY = 300

export type RuleCheck = {
  /** 前端先挡的错误或后端预览报的错，没有为空串 */
  error: string
  /** 后端预览报的错（前端没挡住的，比如 cron 的某一段超范围），拦保存用 */
  serverError: string
  /** 接下来几次；还在算或有错时为 null */
  upcoming: string[] | null
}

/** 规则的校验和预览：停手一会儿再请求，cron 一个字一个字敲时不连发。off 时不校验不预览（只读的规则） */
export function useRuleCheck(rule: ScheduleRule, opts: { now: Date; count?: number; off?: boolean }): RuleCheck {
  const { now, count = 3, off = false } = opts
  const clientErr = off ? '' : ruleError(rule, now)
  const [previewRule, setPreviewRule] = useState<ScheduleRule | null>(clientErr || off ? null : rule)
  useEffect(() => {
    const next = clientErr || off ? null : rule
    const id = setTimeout(() => setPreviewRule(next), PREVIEW_DELAY)
    return () => clearTimeout(id)
  }, [rule, clientErr, off])
  const preview = useSchedulePreview(previewRule, count)
  // 后端校验的说明带着「validation failed:」前缀，去掉只留原因
  const serverError = previewRule && preview.isError ? `规则不对：${errorText(preview.error).replace(/^validation failed:\s*/, '')}` : ''
  return { error: clientErr || serverError, serverError, upcoming: !clientErr && preview.data ? preview.data.next_runs : null }
}

