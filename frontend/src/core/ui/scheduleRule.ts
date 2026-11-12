// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 定时规则的纯函数（SPEC-tasks-7、8）：规则说成一句话、前端先挡的规则错误、「几点」的文字、编辑用的模式。
// 定时任务页和 SOP 流程编辑（TSK-0463）共用；下次执行、接下来几次由后端算（POST /api/schedules/preview），这里不重复算。
import type { ScheduleFreq, ScheduleRule } from '../data'

export const FREQS: ScheduleFreq[] = ['once', 'daily', 'weekdays', 'weekly', 'monthly', 'cron']
export const FREQ_LABEL: Record<ScheduleFreq, string> = { once: '一次', daily: '每天', weekdays: '工作日', weekly: '每周', monthly: '每月', cron: 'Cron 表达式' }
export const WEEK = ['日', '一', '二', '三', '四', '五', '六']
/** 周一在前 */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]

/**
 * 编辑时的模式：后端的六种频率之外多一种「每隔几小时」，存成 cron「分 *\/N * * *」（从 0 点起算），
 * 规则本身不加字段；cron 写成这个样子的也按「每隔」显示
 */
export type RuleMode = Exclude<ScheduleFreq, 'cron'> | 'interval' | 'cron'
export const RULE_MODES: RuleMode[] = ['once', 'daily', 'weekdays', 'weekly', 'monthly', 'interval', 'cron']
export const RULE_MODE_LABEL: Record<RuleMode, string> = { ...FREQ_LABEL, interval: '每隔几小时', cron: 'Cron' }
/** 「每隔几小时」能选的间隔：整除 24，每天的执行时刻固定 */
export const INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12]

const INTERVAL_RE = /^(\d{1,2})\s+\*\/(\d{1,2})\s+\*\s+\*\s+\*$/

/** cron 是不是「每隔几小时」：是的话回 { hours, minute } */
export function intervalOf(r: Pick<ScheduleRule, 'freq' | 'cron'>): { hours: number; minute: number } | null {
  if (r.freq !== 'cron') return null
  const m = INTERVAL_RE.exec(r.cron.trim())
  if (!m) return null
  const minute = Number(m[1])
  const hours = Number(m[2])
  return minute <= 59 && hours >= 1 && hours <= 23 ? { hours, minute } : null
}
export const intervalCron = (hours: number, minute: number) => `${minute} */${hours} * * *`
export const modeOf = (r: ScheduleRule): RuleMode => (intervalOf(r) ? 'interval' : r.freq)

/** 换模式：「每隔几小时」默认每 2 小时整点；从「每隔」换到 Cron 时保留原表达式 */
export function withMode(r: ScheduleRule, m: RuleMode): ScheduleRule {
  if (m === 'interval') return { ...r, freq: 'cron', cron: intervalOf(r) ? r.cron : intervalCron(2, 0) }
  if (m === 'cron') return { ...r, freq: 'cron', cron: intervalOf(r) || !r.cron.trim() ? '0 9 * * 1' : r.cron }
  return { ...r, freq: m }
}

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** 新建时的默认规则：每周一 09:00；一次性默认明天，cron 默认同一个点 */
export function emptyRule(now: Date = new Date()): ScheduleRule {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return { freq: 'weekly', time: '09:00', weekdays: [1], day: 1, date: ymd(tomorrow), cron: '0 9 * * 1' }
}

/** 后端只给自己频率的字段时补齐，切换频率时有默认值可用 */
export function fullRule(r: Partial<ScheduleRule> | undefined, now: Date = new Date()): ScheduleRule {
  const e = emptyRule(now)
  return {
    freq: r?.freq ?? e.freq,
    time: r?.time || e.time,
    weekdays: r?.weekdays?.length ? [...r.weekdays] : e.weekdays,
    day: r?.day || e.day,
    date: r?.date || e.date,
    cron: r?.cron || e.cron,
  }
}

/** 规则写成一句话：「每周一 09:00」「每隔 2 小时（整点）」「Cron：0 18 * * 1」 */
export function describeRule(r: ScheduleRule): string {
  switch (r.freq) {
    case 'once': return `${r.date || '未定日期'} ${r.time}`
    case 'daily': return `每天 ${r.time}`
    case 'weekdays': return `工作日 ${r.time}`
    case 'weekly': {
      const days = WEEK_ORDER.filter((d) => r.weekdays.includes(d))
      return `每周${days.length ? days.map((d) => WEEK[d]).join('、') : '（没选周几）'} ${r.time}`
    }
    case 'monthly': return `每月 ${r.day} 号 ${r.time}`
    case 'cron': {
      const iv = intervalOf(r)
      if (iv) return `每隔 ${iv.hours} 小时（${iv.minute ? `第 ${iv.minute} 分` : '整点'}）`
      return `Cron：${r.cron || '未填'}`
    }
  }
}

/** 前端先挡的规则错误（SPEC-tasks-0 ruleError 的五种文案）；cron 的细节和时区由后端预览再校验 */
export function ruleError(r: ScheduleRule, now: Date = new Date()): string {
  if (r.freq !== 'cron' && !/^\d{2}:\d{2}$/.test(r.time)) return '时间要写成 09:00 这种格式'
  if (r.freq === 'weekly' && !r.weekdays.length) return '每周执行要至少选一天'
  if (r.freq === 'once' && !r.date) return '选一个执行日期'
  if (r.freq === 'once' && new Date(`${r.date}T${r.time}`) <= now) return '这个时间已经过去了'
  if (r.freq === 'cron' && r.cron.trim().split(/\s+/).filter(Boolean).length !== 5) return 'Cron 要 5 段：分 时 日 月 周，比如 0 9 * * 1'
  return ''
}

/** 「今天 09:00」「明天 09:00」「周三 18:00」「11-15 09:00」；算不出时「不再执行」 */
export function whenText(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '不再执行'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '不再执行'
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(d) - day(now)) / 86400000)
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (diff === 0) return `今天 ${t}`
  if (diff === 1) return `明天 ${t}`
  if (diff > 1 && diff < 7) return `周${WEEK[d.getDay()]} ${t}`
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${t}`
}
