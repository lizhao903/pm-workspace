// 定时任务：按规则到点自动做一件事——建一条任务、提醒你、执行一个 SOP、或者让一个 Agent 去做
// 原型里没有真的后台计时，「下次执行」按规则算出来展示；「立即执行一次」会真的跑一遍动作并留记录
// 定时发布（publish）跟着视频的发布记录走：发布记录定了时间就有一条，时间在日历或发布记录里改，这里只读

import type { Priority } from './taskdata'
import type { IncidentLevel } from './incidentdata'
import { PLATFORMS, seedPublishes, type Publish } from './videodata'

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
  /** 提醒：到点在工作台右下角弹一条通知（不外发 IM）；task_id 是关联的任务，点提醒打开它，空串为不关联（正式产品叫 object_id） */
  /** popup：弹窗方式（SPEC-tasks-8.26），toast 右下角（默认），modal 屏幕中间 */
  | { kind: 'remind'; title: string; body: string; task_id: string; popup?: 'toast' | 'modal' }
  /** managed：随流程管理的那一条（TSK-0463）——流程触发方式选「定时」时建的，一个流程最多一条；名称跟流程名、动作改不了，删流程时一起删 */
  | { kind: 'sop'; sop_id: string; managed?: boolean }
  | { kind: 'agent'; agent_id: string; prompt: string }
  | { kind: 'publish'; publish_id: string }
  /** 运行异常巡检（INC-01）：到点把满足条件、未处理、还没有任务的异常各建一条任务交给 Claude Code 修 */
  | { kind: 'incident_sweep'; min_level: IncidentLevel; min_count: number }
  /**
   * 交给 Claude Code（TSK-0429）：到点在 workdir 里无人值守跑一次 Claude Code，不建任务；结论和产出记进这条定时任务的执行记录。
   * preset_id 是「设置 / 角色」里的角色（空串为不用）；allow_writes 为 false 时只读；
   * out_dir 是产出放哪（相对 workdir，空为 workdir 本身），拼进提示词
   */
  | { kind: 'claude'; workdir: string; prompt: string; preset_id: string; allow_writes: boolean; out_dir: string }
export const ACTION_LABEL: Record<ScheduleAction['kind'], string> = { task: '建一条任务', remind: '提醒', sop: '执行 SOP', agent: '让 Agent 去做', claude: '交给 Claude Code', publish: '发布视频', incident_sweep: '运行异常巡检' }
/** 「交给 Claude Code」的配置错误，空串为没问题（SPEC-tasks-8.27） */
export function claudeActionError(a: { workdir: string; prompt: string; out_dir: string }): string {
  const w = a.workdir.trim()
  if (!w) return '选一个工作目录'
  if (!w.startsWith('/')) return '工作目录要写本机绝对路径'
  if (!a.prompt.trim()) return '写一下要它做什么'
  const o = a.out_dir.trim()
  if (o.startsWith('/') || o.split('/').includes('..')) return '结果目录要写工作目录下的相对路径'
  return ''
}
/** 产出目录的完整路径：工作目录接上相对目录 */
export const claudeOutPath = (a: { workdir: string; out_dir: string }) => {
  const w = a.workdir.trim().replace(/\/+$/, '')
  const o = a.out_dir.trim().replace(/^\.?\/+|\/+$/g, '')
  return o ? `${w}/${o}` : w
}
export const SWEEP_LEVEL_LABEL: Record<IncidentLevel, string> = { error: '只看错误', warn: '错误和警告' }
/** 「只看错误」「错误和警告，至少 3 次」 */
export const sweepText = (a: { min_level: IncidentLevel; min_count: number }) => `${SWEEP_LEVEL_LABEL[a.min_level]}${a.min_count > 1 ? `，至少 ${a.min_count} 次` : ''}`
/** 运行异常页「开启自动巡检」建的那条：每天 9:00，只看错误 */
export const sweepSchedule = (id: string): Schedule => ({
  id, name: '运行异常巡检', enabled: true, rule: { ...emptyRule(), freq: 'daily', time: '09:00' },
  action: { kind: 'incident_sweep', min_level: 'error', min_count: 1 }, history: [], created_at: new Date().toISOString(),
})

/** files：「交给 Claude Code」这次写出的产出（绝对路径），执行记录里逐个列出 */
export interface ScheduleRun { at: string; ok: boolean; text: string; ref?: string; manual?: boolean; files?: string[] }

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

/**
 * 编辑时的模式（TSK-0463）：六种频率之外多一种「每隔几小时」，存成 cron「分 *\/N * * *」（从 0 点起算），规则本身不加字段
 */
export type RuleMode = Freq | 'interval'
export const RULE_MODES: RuleMode[] = ['once', 'daily', 'weekdays', 'weekly', 'monthly', 'interval', 'cron']
export const RULE_MODE_LABEL: Record<RuleMode, string> = { once: '一次', daily: '每天', weekdays: '工作日', weekly: '每周', monthly: '每月', interval: '每隔几小时', cron: 'Cron' }
export const INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12]
export function intervalOf(r: Pick<ScheduleRule, 'freq' | 'cron'>): { hours: number; minute: number } | null {
  if (r.freq !== 'cron') return null
  const m = /^(\d{1,2})\s+\*\/(\d{1,2})\s+\*\s+\*\s+\*$/.exec(r.cron.trim())
  if (!m) return null
  const minute = Number(m[1]); const hours = Number(m[2])
  return minute <= 59 && hours >= 1 && hours <= 23 ? { hours, minute } : null
}
export const intervalCron = (hours: number, minute: number) => `${minute} */${hours} * * *`
export const modeOf = (r: ScheduleRule): RuleMode => (intervalOf(r) ? 'interval' : r.freq)
export function withMode(r: ScheduleRule, m: RuleMode): ScheduleRule {
  if (m === 'interval') return { ...r, freq: 'cron', cron: intervalOf(r) ? r.cron : intervalCron(2, 0) }
  if (m === 'cron') return { ...r, freq: 'cron', cron: intervalOf(r) || !r.cron.trim() ? '0 9 * * 1' : r.cron }
  return { ...r, freq: m }
}

/** 随这个流程管理的那条定时任务（TSK-0463），没有为 undefined */
export const flowSchedule = (list: Schedule[], sopId: string) => list.find((s) => s.action.kind === 'sop' && s.action.managed && s.action.sop_id === sopId)

/** 规则写成一句话 */
export function describeRule(r: ScheduleRule): string {
  const iv = intervalOf(r)
  if (iv) return `每隔 ${iv.hours} 小时（${iv.minute ? `第 ${iv.minute} 分` : '整点'}）`
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
  const iv = intervalOf(r)
  if (iv) {
    // 每隔几小时：从 0 点起算的整点（或第几分）
    const d = new Date(from); d.setSeconds(0, 0)
    for (let i = 0; i < 48; i += 1) {
      d.setMinutes(iv.minute)
      if (d > from && d.getHours() % iv.hours === 0) return new Date(d)
      d.setHours(d.getHours() + 1)
    }
    return null
  }
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

/**
 * 列表「下次执行」一列：启用的按规则算；只提醒一次的提醒到点后自动停用，提醒了写「已提醒」、错过了写「已错过」，其余停用的「已停用」
 */
export function nextText(s: Schedule, now = new Date()): string {
  if (s.enabled) return whenText(nextRun(s.rule, now))
  if (s.action.kind === 'remind' && s.rule.freq === 'once' && s.rule.date && new Date(`${s.rule.date}T${s.rule.time}`) <= now) {
    const last = s.history[0]
    if (!last) return '已停用'
    return last.ok ? '已提醒' : last.text.includes('错过') ? '已错过' : '已停用'
  }
  return '已停用'
}

/** 任务抽屉「设个提醒」建的那条：只提醒一次，关联这条任务，名称「提醒：标题」 */
export function taskReminder(id: string, taskId: string, f: { title: string; body: string; date: string; time: string }): Schedule {
  const title = f.title.trim()
  return {
    id, name: `提醒：${title}`.slice(0, 100), enabled: true, rule: { ...emptyRule(), freq: 'once', date: f.date, time: f.time },
    action: { kind: 'remind', title, body: f.body.trim(), task_id: taskId }, history: [], created_at: new Date().toISOString(),
  }
}

/** 到点该提醒的：启用的、只提醒一次的提醒，时间到了还没提醒过（原型只模拟这一种的到点，重复的提醒用「立即执行一次」看效果） */
export const dueReminders = (list: Schedule[], now = new Date()) => list.filter((s) => s.enabled && s.action.kind === 'remind' && s.rule.freq === 'once'
  && s.rule.date && new Date(`${s.rule.date}T${s.rule.time}`) <= now)

export const emptyRule = (): ScheduleRule => ({ freq: 'weekly', time: '09:00', weekdays: [1], day: 1, date: ymd(new Date(Date.now() + 86400000)), cron: '0 9 * * 1' })

const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString()

/** 定时发布的 id 跟着发布记录走，一条发布最多一条定时 */
export const publishScheduleId = (publishId: string) => `sc_pub_${publishId}`
/** 一条已定时的发布对应的定时任务：只执行一次，日期时间取 scheduled_at */
export function publishSchedule(p: Publish, old?: Schedule): Schedule {
  const at = new Date(p.scheduled_at!)
  const platform = PLATFORMS.find((x) => x.key === p.platform)?.label ?? p.platform
  return {
    id: publishScheduleId(p.id), name: `定时发布：${platform}「${p.title || '未填标题'}」`, enabled: old?.enabled ?? true,
    rule: { ...(old?.rule ?? emptyRule()), freq: 'once', date: ymd(at), time: `${pad(at.getHours())}:${pad(at.getMinutes())}` },
    action: { kind: 'publish', publish_id: p.id }, history: old?.history ?? [], created_at: old?.created_at ?? new Date().toISOString(),
  }
}
/** 按发布记录同步定时发布：已定时的补上或改时间，不再定时的停掉，发布记录删了的跟着删；已发布、失败的留着看执行记录。没变化时原样返回 */
export function syncPublishSchedules(list: Schedule[], publishes: Publish[]): Schedule[] {
  let changed = false
  const out = list.filter((s) => {
    const keep = s.action.kind !== 'publish' || publishes.some((p) => s.action.kind === 'publish' && p.id === s.action.publish_id)
    if (!keep) changed = true
    return keep
  }).map((s) => {
    if (s.action.kind !== 'publish') return s
    const id = s.action.publish_id
    const p = publishes.find((x) => x.id === id)
    if (!p) return s
    if (p.status === 'scheduled' && p.scheduled_at) {
      const next = publishSchedule(p, s)
      if (next.rule.date === s.rule.date && next.rule.time === s.rule.time && next.name === s.name && s.rule.freq === 'once') return s
      // 改了时间就重新启用
      changed = true
      return { ...next, enabled: true }
    }
    // 不再是定时（改成立即发布、已发出去）：还没到点的停掉，免得到点再发一次
    if (s.enabled && nextRun(s.rule)) { changed = true; return { ...s, enabled: false } }
    return s
  })
  const fresh = publishes.filter((p) => p.status === 'scheduled' && p.scheduled_at && !out.some((s) => s.id === publishScheduleId(p.id))).map((p) => publishSchedule(p))
  if (fresh.length) changed = true
  return changed ? [...fresh, ...out] : list
}

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
  // TSK-0429：每天 10:00 让 Claude Code 从 FDE 反馈表拉数据、整理成需求清单存本地；前天那次表格没权限读，失败了
  {
    id: 'sc_fde_feedback', name: '整理 FDE 反馈需求清单', enabled: true, created_at: minsAgo(60 * 24 * 4),
    rule: { ...emptyRule(), freq: 'daily', time: '10:00' },
    action: {
      kind: 'claude', workdir: '/Users/me/pm/fde-feedback', preset_id: '', allow_writes: true, out_dir: 'lists',
      prompt: '从 FDE 反馈表（https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit?gid=1115809405）读全部反馈行，按 README.md 里的整理规则去重、归并成需求清单：写当天的 .md 和 .json，更新 latest.json；和上一份比，标出新增、变更、已关闭。只读表格，不改表格。',
    },
    // 最近一次 10:04 跑完（现在还没到 10:04 就是昨天那次），往前每天一次
    history: [0, 1, 2].map((n) => {
      const at = new Date(); at.setHours(10, 4, 0, 0)
      if (at.getTime() > Date.now()) at.setDate(at.getDate() - 1)
      at.setDate(at.getDate() - n)
      const day = ymd(at)
      return n === 2
        ? { at: at.toISOString(), ok: false, text: '失败：读不到表格（403，没有访问权限），沿用上一份清单，没写新文件' }
        : { at: at.toISOString(), ok: true, text: n === 0 ? '读了 46 行反馈，整理出 18 条需求（新增 3、变更 2、已关闭 1）' : '读了 43 行反馈，整理出 16 条需求（新增 2、变更 0、已关闭 0）',
          files: [`/Users/me/pm/fde-feedback/lists/${day}.md`, `/Users/me/pm/fde-feedback/lists/${day}.json`] }
    }),
  },
  // 随流程「周会纪要整理」管理的那条（TSK-0463）：流程触发方式是「定时」，规则在这里，名称跟流程名
  {
    id: 'sc_meeting', name: '周会纪要整理', enabled: true, created_at: minsAgo(60 * 24 * 20),
    rule: { ...emptyRule(), freq: 'weekly', time: '18:00', weekdays: [1] },
    action: { kind: 'sop', sop_id: 'sop_meeting', managed: true },
    history: [{ at: minsAgo(60 * 26), ok: true, text: '执行了「周会纪要整理」，已完成' }],
  },
  {
    id: 'sc_remind_eu', name: '提醒：架构图发给 Mia', enabled: true, created_at: minsAgo(60 * 3),
    rule: { ...emptyRule(), freq: 'once', time: '17:30', date: ymd(new Date(Date.now() + 86400000)) },
    action: { kind: 'remind', title: '架构图发给 Mia', body: '通电话前发过去，留时间给她看', task_id: 'tk_eu1' },
    history: [],
  },
  {
    id: 'sc_contract', name: '机柜合同续签提醒', enabled: false, created_at: minsAgo(60 * 24 * 60),
    rule: { ...emptyRule(), freq: 'monthly', time: '10:00', day: 25 },
    action: { kind: 'task', title: '确认下月机柜续费', desc: '', priority: 'P3', assignee: '我', due_days: 3 },
    history: [{ at: minsAgo(60 * 24 * 33), ok: false, text: '没执行：已停用' }],
  },
  // 视频的定时发布：抖音那条 5 天前到点发布失败了（封面比例不对），其余还在等
  ...seedPublishes.filter((p) => p.status === 'scheduled' && p.scheduled_at).map((p) => publishSchedule(p, { created_at: minsAgo(60 * 24 * 3) } as Schedule)),
  {
    ...publishSchedule({ ...seedPublishes.find((p) => p.id === 'pb3')! }, { created_at: minsAgo(60 * 24 * 6) } as Schedule),
    history: [{ at: seedPublishes.find((p) => p.id === 'pb3')!.scheduled_at!, ok: false, text: '发布失败：封面比例不符合要求，已记进运行异常' }],
  },
]
