// 定时任务：按规则到点自动做一件事——建一条任务、执行一个 SOP、或者让一个 Agent 去做
// 原型里没有真的后台计时，「下次执行」按规则算出来展示；「立即执行一次」会真的跑一遍动作并留记录

import type { Priority } from './taskdata'

export type Freq = 'once' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'cron'
export const FREQ_LABEL: Record<Freq, string> = { once: '只执行一次', daily: '每天', weekdays: '工作日', weekly: '每周', monthly: '每月', cron: 'Cron 表达式' }
export const WEEK = ['日', '一', '二', '三', '四', '五', '六']

export interface ScheduleRule {
  freq: Freq
  /** HH:mm */
  time: string
  /** 每周：周几（0 = 周日） */
  weekdays: number[]
  /** 每月：几号；31 在小月按月底算 */
  day: number
  /** 只执行一次：yyyy-mm-dd */
  date: string
  cron: string
}

export type ScheduleAction =
  | { kind: 'task'; title: string; desc: string; priority: Priority; assignee: string; due_days: number }
  | { kind: 'sop'; sop_id: string }
  | { kind: 'agent'; agent_id: string; prompt: string }
export const ACTION_LABEL: Record<ScheduleAction['kind'], string> = { task: '建一条任务', sop: '执行 SOP', agent: '让 Agent 去做' }

export interface ScheduleRun { at: string; ok: boolean; text: string; ref?: string; manual?: boolean }

export interface Schedule {
  id: string
  name: string
  enabled: boolean
  rule: ScheduleRule
  action: ScheduleAction
  history: ScheduleRun[]
  created_at: string
}

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** 规则写成一句话 */
export function describeRule(r: ScheduleRule): string {
  switch (r.freq) {
    case 'once': return `${r.date || '未定日期'} ${r.time}`
    case 'daily': return `每天 ${r.time}`
    case 'weekdays': return `工作日 ${r.time}`
    case 'weekly': return `每周${r.weekdays.length ? [...r.weekdays].sort().map((d) => WEEK[d]).join('、') : '（没选周几）'} ${r.time}`
    case 'monthly': return `每月 ${r.day} 号 ${r.time}`
    case 'cron': return `Cron：${r.cron || '未填'}`
  }
}

/** 规则有没有问题；有问题的不能保存 */
export function ruleError(r: ScheduleRule): string {
  if (r.freq !== 'cron' && !/^\d{2}:\d{2}$/.test(r.time)) return '时间要写成 09:00 这种格式'
  if (r.freq === 'weekly' && !r.weekdays.length) return '每周执行要至少选一天'
  if (r.freq === 'once' && !r.date) return '选一个执行日期'
  if (r.freq === 'once' && new Date(`${r.date}T${r.time}`) < new Date()) return '这个时间已经过去了'
  if (r.freq === 'cron' && r.cron.trim().split(/\s+/).length !== 5) return 'Cron 要 5 段：分 时 日 月 周，比如 0 9 * * 1'
  return ''
}

/** 从 from 往后找下一次执行时间；找不到（一次性已过、规则不完整）返回 null */
export function nextRun(r: ScheduleRule, from = new Date()): Date | null {
  if (ruleError(r) && r.freq !== 'once') return null
  if (r.freq === 'cron') {
    // 原型只认「分 时 * * 周」这类常见写法，其余按每天这个点算
    const [mi, h, , , dow] = r.cron.trim().split(/\s+/)
    const time = `${pad(Number(h) || 0)}:${pad(Number(mi) || 0)}`
    const days = dow && dow !== '*' ? dow.split(',').map(Number).filter((x) => !Number.isNaN(x)) : []
    return nextRun({ ...r, freq: days.length ? 'weekly' : 'daily', time, weekdays: days }, from)
  }
  const [hh, mm] = r.time.split(':').map(Number)
  if (r.freq === 'once') {
    const d = new Date(`${r.date}T${r.time}`)
    return d > from ? d : null
  }
  for (let i = 0; i < 400; i += 1) {
    const d = new Date(from)
    d.setDate(from.getDate() + i)
    d.setHours(hh, mm, 0, 0)
    if (d <= from) continue
    const wd = d.getDay()
    if (r.freq === 'daily') return d
    if (r.freq === 'weekdays' && wd >= 1 && wd <= 5) return d
    if (r.freq === 'weekly' && r.weekdays.includes(wd)) return d
    if (r.freq === 'monthly') {
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
      if (d.getDate() === Math.min(r.day, last)) return d
    }
  }
  return null
}

/** 「明天 09:00」「周三 18:00」「11-15 09:00」 */
export function whenText(d: Date | null): string {
  if (!d) return '不再执行'
  const today = new Date()
  const diff = Math.round((new Date(ymd(d)).getTime() - new Date(ymd(today)).getTime()) / 86400000)
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (diff === 0) return `今天 ${t}`
  if (diff === 1) return `明天 ${t}`
  if (diff < 7) return `周${WEEK[d.getDay()]} ${t}`
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${t}`
}

export const emptyRule = (): ScheduleRule => ({ freq: 'weekly', time: '09:00', weekdays: [1], day: 1, date: ymd(new Date(Date.now() + 86400000)), cron: '0 9 * * 1' })

const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString()

export const seedSchedules: Schedule[] = [
  {
    id: 'sc_weekly_agenda', name: '周会前整理议程', enabled: true, created_at: minsAgo(60 * 24 * 40),
    rule: { ...emptyRule(), freq: 'weekly', time: '09:00', weekdays: [1] },
    action: { kind: 'task', title: '整理本周产品周会议程', desc: '把上周遗留问题和本周要拍板的事列出来，会前发群里', priority: 'P2', assignee: '我', due_days: 0 },
    history: [{ at: minsAgo(60 * 24 * 2 + 300), ok: true, text: '建了任务 T-005', ref: 'T-005' }, { at: minsAgo(60 * 24 * 9 + 300), ok: true, text: '建了任务 T-002', ref: 'T-002' }],
  },
  {
    id: 'sc_weekly_report', name: '周五写周报', enabled: true, created_at: minsAgo(60 * 24 * 30),
    rule: { ...emptyRule(), freq: 'weekly', time: '16:00', weekdays: [5] },
    action: { kind: 'agent', agent_id: 'ag_weekly', prompt: '汇总这周的任务，写成周报草稿存进「文档 > 笔记」' },
    history: [{ at: minsAgo(60 * 24 * 5), ok: true, text: '周报助手写好了「第 43 周周报」，等你确认后已存进文档' }],
  },
  {
    id: 'sc_meeting', name: '周会纪要', enabled: true, created_at: minsAgo(60 * 24 * 20),
    rule: { ...emptyRule(), freq: 'cron', cron: '0 18 * * 1' },
    action: { kind: 'sop', sop_id: 'sop_meeting' },
    history: [{ at: minsAgo(60 * 26), ok: true, text: '执行了「周会纪要整理」，已完成' }],
  },
  {
    id: 'sc_contract', name: '机柜合同续签提醒', enabled: false, created_at: minsAgo(60 * 24 * 60),
    rule: { ...emptyRule(), freq: 'monthly', time: '10:00', day: 25 },
    action: { kind: 'task', title: '确认下月机柜续费', desc: '', priority: 'P3', assignee: '我', due_days: 3 },
    history: [{ at: minsAgo(60 * 24 * 33), ok: false, text: '没执行：已停用' }],
  },
]
