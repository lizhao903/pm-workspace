// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 定时规则编辑（SPEC-tasks-8「什么时候」）：频率、周几、日期、几号、时间、每隔几小时、Cron，下面是后端算的接下来几次。
// 定时任务抽屉和 SOP 流程编辑的「定时」触发（TSK-0463）共用；compact 时频率用下拉（窄的属性面板放不下一排按钮）。
import type { ScheduleRule } from '../data'
import { cls } from './cls'
import { Field, Input, Select } from './form'
import {
  INTERVAL_HOURS, RULE_MODES, RULE_MODE_LABEL, WEEK, WEEK_ORDER, describeRule, intervalCron, intervalOf, modeOf, whenText, withMode, type RuleMode,
} from './scheduleRule'
import type { RuleCheck } from './useRuleCheck'
import './scheduleRule.css'

const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5)

export function ScheduleRuleFields({ rule, onChange, check, now, compact }: {
  rule: ScheduleRule
  onChange: (r: ScheduleRule) => void
  check: RuleCheck
  now: Date
  /** 窄面板：频率用下拉 */
  compact?: boolean
}) {
  const r = rule
  const mode = modeOf(r)
  const iv = intervalOf(r)
  const set = (p: Partial<ScheduleRule>) => onChange({ ...r, ...p })
  const pick = (m: RuleMode) => onChange(withMode(r, m))
  const { error, upcoming } = check
  return (
    <div className={cls('rule-ed', compact && 'compact')}>
      {compact ? (
        <Field label="频率">
          <Select value={mode} aria-label="频率" onValueChange={(v) => pick(v as RuleMode)}
            options={RULE_MODES.map((m) => ({ value: m, label: RULE_MODE_LABEL[m] }))} />
        </Field>
      ) : (
        <div className="rule-ed-seg" role="radiogroup" aria-label="频率">
          {RULE_MODES.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} className={cls(mode === m && 'on')}
              onClick={() => pick(m)}>{RULE_MODE_LABEL[m]}</button>
          ))}
        </div>
      )}
      {mode === 'weekly' && (
        <div className="rule-ed-week" role="group" aria-label="周几">
          {WEEK_ORDER.map((w) => {
            const on = r.weekdays.includes(w)
            return (
              <button key={w} type="button" aria-pressed={on} aria-label={`周${WEEK[w]}`} className={cls('rule-ed-day', on && 'on')}
                onClick={() => set({ weekdays: on ? r.weekdays.filter((x) => x !== w) : [...r.weekdays, w].sort() })}>{WEEK[w]}</button>
            )
          })}
        </div>
      )}
      <div className="field-row">
        {mode === 'once' && (
          <Field label="日期"><Input type="date" value={r.date} onChange={(e) => set({ date: e.target.value })} /></Field>
        )}
        {mode === 'monthly' && (
          <Field label="几号">
            <Select value={String(r.day)} onValueChange={(v) => set({ day: Number(v) })}
              options={Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: i === 30 ? '31（小月按月底） 号' : `${i + 1} 号` }))} />
          </Field>
        )}
        {mode === 'interval' && iv ? (
          <>
            <Field label="每隔">
              <Select value={String(iv.hours)} aria-label="每隔几小时" onValueChange={(v) => set({ cron: intervalCron(Number(v), iv.minute) })}
                options={[...new Set([...INTERVAL_HOURS, iv.hours])].sort((a, b) => a - b).map((h) => ({ value: String(h), label: `${h} 小时` }))} />
            </Field>
            <Field label="在第几分">
              <Select value={String(iv.minute)} aria-label="在第几分" onValueChange={(v) => set({ cron: intervalCron(iv.hours, Number(v)) })}
                options={[...new Set([...MINUTES, iv.minute])].sort((a, b) => a - b).map((m) => ({ value: String(m), label: m ? `${m} 分` : '整点' }))} />
            </Field>
          </>
        ) : mode === 'cron' ? (
          <Field label={<>Cron 表达式<span className="rule-ed-hint">分 时 日 月 周</span></>}>
            <Input className="rule-ed-mono" value={r.cron} placeholder="0 9 * * 1" invalid={!!error}
              onChange={(e) => set({ cron: e.target.value })} />
          </Field>
        ) : (
          <Field label="时间"><Input type="time" value={r.time} onChange={(e) => set({ time: e.target.value })} /></Field>
        )}
      </div>
      {mode === 'interval' && <div className="rule-ed-sub">从 0 点起算，每天在固定的几个整点（或第几分）执行</div>}
      {error ? <div className="field-err" role="alert">{error}</div> : (
        <div className="rule-ed-preview" aria-live="polite">
          <span className="rule-ed-sub">{describeRule(r)}，接下来：</span>
          {upcoming ? (upcoming.length
            ? upcoming.map((u) => <span key={u} className="tag">{whenText(u, now)}</span>)
            : <span className="rule-ed-sub">不会再执行</span>) : <span className="rule-ed-sub">正在算</span>}
        </div>
      )}
    </div>
  )
}
