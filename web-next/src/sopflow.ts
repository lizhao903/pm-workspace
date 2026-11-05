// SOP：标准工作流。步骤之间是一张有向图：
//   after    这一步依赖哪几步；依赖多于一步就是汇合，依赖同一步的几步会并行跑
//   判断步骤  产出 route，决定走哪个分支；没走到的分支上的步骤标为「未走此分支」
//   branch   这一步只在某个判断选了某个分支时才跑
// 执行过程中每一步的输入输出都留在执行记录里，人可以在四个地方插手：
//   执行前暂停（逐步确认模式）：看过、可改输入再跑
//   人工检查步骤：看过、可改输出再放行，或退回上游重做
//   人工判断：看过输入，选走哪个分支
//   失败：重试或跳过
// 原型里步骤由前端定时器模拟，每步的产出是写死的规则，不连真服务
import { seedContacts, seedMessages } from './data'
import { newId } from './ids'
import type { ScheduleRule } from './scheduledata'
import { NODE_TYPES, evalRule, isBranching, loopRounds, render, typeOf, type Cfg, type StepKind } from './nodetypes'

export type Json = Record<string, unknown>
export type { StepKind }

// 节点类型的名字、执行规则都在 nodetypes 里，这里只留一份名字表给老代码用
export const STEP_KIND = Object.fromEntries(NODE_TYPES.map((t) => [t.kind, { label: t.label }])) as Record<StepKind, { label: string }>

export interface SopCase { key: string; label: string }

export interface SopStepDef {
  key: string
  name: string
  kind: StepKind
  desc: string
  /** 模拟耗时 */
  ms: number
  /** 依赖的步骤；不写就接在定义顺序的上一步后面，[] 是起点 */
  after?: string[]
  /** 只在判断步骤 of 选了 case 时才执行 */
  branch?: { of: string; case: string }
  run?: (input: Json) => Json
  /** 返回错误信息表示这一步会失败；重试时还会再判一次 */
  fail?: (input: Json) => string | null
  /** 判断步骤的分支 */
  cases?: SopCase[]
  /** 判断规则；判断步骤既没有 decide 也没有 rule 就是人工判断 */
  decide?: (input: Json) => { route: string; reason: string }
  /** 用户自己写的判断规则描述；原型里不真的求值，按第一个分支模拟 */
  rule?: string
  /** 节点类型自己的配置项，见 nodetypes 里各类型的 fields */
  config?: Cfg
}

export interface SopField {
  key: string
  label: string
  type: 'text' | 'textarea' | 'select'
  options?: { value: string; label: string }[]
  placeholder?: string
  required?: boolean
  default?: string
}

export interface Sop {
  id: string
  name: string
  desc: string
  /** sop_trigger 枚举的 key */
  trigger: string
  /**
   * 编排页里定时触发的草稿（TSK-0463）：规则和启停。保存时写进随流程管理的定时任务（定时任务列表里 action.managed 的那条），
   * 流程本身不存；打开编排页时从那条定时任务带出来，没有那条时为空（「定时，未配置」）
   */
  sched?: { rule: ScheduleRule; enabled: boolean }
  fields: SopField[]
  steps: SopStepDef[]
  /** 编排画布上的节点位置，key 是步骤 key，__start 是开始节点；没有就按依赖自动排 */
  layout?: Record<string, { x: number; y: number }>
}

/**
 * paused：逐步确认模式下执行前等人确认输入
 * review：人工检查步骤等人放行输出 / 人工判断步骤等人选分支
 * bypassed：所在分支没被选中，不执行
 */
export type StepStatus = 'pending' | 'running' | 'paused' | 'review' | 'done' | 'failed' | 'skipped' | 'bypassed'
export type RunStatus = 'running' | 'waiting' | 'done' | 'failed' | 'stopped'

export interface RunStep {
  key: string
  status: StepStatus
  input?: Json
  output?: Json
  /** 判断步骤选中的分支 */
  route?: string
  route_reason?: string
  started_at?: number
  ended_at?: number
  error?: string
  /** 人改过输入或输出、人选的分支，界面上标出来，事后查得到是谁动过 */
  edited?: 'input' | 'output' | 'route'
  attempts: number
  log: { at: number; text: string }[]
  /** 在排队（状态仍是 running）：ahead 是全局队列里前面还有几个；slot 为空是等模型名额（SOP-07），claude_code 是等 Claude Code 名额（AUTO-12） */
  queue?: { ahead: number; slot?: 'claude_code' }
  /** 占着一个调模型的名额（原型自己用；正式产品在后端内存里） */
  gated?: boolean
  /** 占着一个 Claude Code 名额（AUTO-12，原型自己用） */
  cgated?: boolean
  /**
   * 挂起等服务商恢复（TSK-0392，SPEC-sop-7.50）：IM、定时等自动发起的执行，调模型的步骤遇到服务商不可用不标失败，
   * 状态仍是 running，到 retry_at 或服务商恢复后原地重跑；provider 是服务商名，reason 是最近一次失败
   */
  provider_wait?: { provider_id: string; provider: string; reason: string; since: number; retry_at: number }
  /** 超出治理上限被暂停（AUTO-12，SPEC-sop-15）：没放行时停在 paused；放行后 released，attempt 是放行的那次尝试 */
  hold?: { kind: 'runs' | 'duration'; reason: string; since: number; released?: boolean; attempt?: number }
  /** Claude Code 节点发起的那次执行（AUTO-01）：执行 id、关联任务（执行记录留在任务上时）、工作目录 */
  claude?: { run_id: string; task_id?: string; workdir?: string }
  /** 第几轮：被条件回退退回重做后为 2、3……，首轮没有（AUTO-02） */
  round?: number
  /** 这一轮被退回重做的原因 */
  rework_reason?: string
  /** 条件回退节点已经自动退回了几次 */
  loops?: number
}

export interface SopRun {
  id: string
  sop_id: string
  /** 开始执行时的流程定义快照；之后改了 SOP，进行中的执行仍按原来的步骤走完 */
  sop: Sop
  title: string
  step_through: boolean
  stopped: boolean
  started_at: number
  ended_at?: number
  input: Json
  steps: RunStep[]
  /** 关联的工作对象（SOP-06）：在任务详情里「执行 SOP」发起的、Agent 处理任务时用 run_sop 发起的；子流程继承父执行的 */
  object_id?: string
  /** 发起来源（SOP-06）：manual 手动 / agent / schedule 定时任务 / im IM 消息触发 / subflow 子流程 / plugin 别的插件；以前的执行没有 */
  source?: RunSource
  /** 来源对象的 id：Agent id、定时任务 id、消息 id、父执行 id、插件 id；批量重跑新起的（manual）记原执行 id */
  source_ref?: string
  /** 发起那一刻来源的名字；正式产品 Agent、定时任务的名字现查，查不到才用它 */
  source_name?: string
  /** 失败后按最新流程重新发起（批量重跑的 relaunch）新起的那条执行 id；有值就是「已重跑」（SPEC-sop-4.21） */
  relaunched_to?: string
}

export type RunSource = 'manual' | 'agent' | 'schedule' | 'im' | 'subflow' | 'plugin'
export type RunOrigin = { objectId?: string; source?: RunSource; sourceRef?: string; sourceName?: string }

/** 来源的文字：「手动」「手动（批量重跑）」「Agent：消息分诊助手」「定时：周一例会」「IM 消息」「子流程」「插件：video」；没有来源为空串 */
export function sourceText(r: Pick<SopRun, 'source' | 'source_ref' | 'source_name'>): string {
  const name = r.source_name || r.source_ref || ''
  switch (r.source) {
    // 界面上批量发起、批量重跑的记了 source_name
    case 'manual': return r.source_name ? `手动（${r.source_name}）` : '手动'
    case 'agent': return name ? `Agent：${name}` : 'Agent'
    case 'schedule': return name ? `定时：${name}` : '定时'
    case 'im': return 'IM 消息'
    case 'subflow': return '子流程'
    case 'plugin': return name ? `插件：${name}` : '插件'
    default: return ''
  }
}

export const STEP_STATUS: Record<StepStatus, { label: string; color: string }> = {
  pending: { label: '未开始', color: '#a19d92' },
  running: { label: '执行中', color: '#3d4fd6' },
  paused: { label: '待确认输入', color: '#b0570b' },
  review: { label: '待处理', color: '#b0570b' },
  done: { label: '完成', color: '#2f7d43' },
  failed: { label: '失败', color: '#c0352b' },
  skipped: { label: '已跳过', color: '#a19d92' },
  bypassed: { label: '未走此分支', color: '#a19d92' },
}

/** 界面上显示的状态：失败后已按最新流程重跑过的多一种「已重跑」，灰色，不算失败待处理（SPEC-sop-4.21） */
export type RunShow = RunStatus | 'relaunched'
export const RUN_STATUS: Record<RunShow, { label: string; color: string }> = {
  running: { label: '执行中', color: '#3d4fd6' },
  waiting: { label: '待我处理', color: '#b0570b' },
  done: { label: '已完成', color: '#2f7d43' },
  failed: { label: '失败', color: '#c0352b' },
  stopped: { label: '已终止', color: '#a19d92' },
  relaunched: { label: '已重跑', color: '#a19d92' },
}
export const runShow = (r: SopRun): RunShow => {
  const st = runStatus(r)
  return st === 'failed' && r.relaunched_to ? 'relaunched' : st
}

/** 排队中的步骤（SOP-07）：状态仍是 running，界面单独显示「排队中」 */
export const QUEUED_LOOK = { label: '排队中', color: '#7a766c' }
/** 挂起等服务商恢复（SPEC-sop-7.50） */
export const PROVIDER_WAIT_LOOK = { label: '等服务商恢复', color: '#b7791f' }
export const isProviderWait = (s: RunStep) => s.status === 'running' && !!s.provider_wait
export const isQueued = (s: RunStep) => s.status === 'running' && !!s.queue
/** 超出治理上限暂停（AUTO-12）：状态是 paused，带没放行的 hold */
export const HELD_LOOK = { label: '超出上限', color: '#c0392b' }
export const stepLook = (s: RunStep) => (isProviderWait(s) ? PROVIDER_WAIT_LOOK : isQueued(s) ? QUEUED_LOOK : isHeld(s) ? HELD_LOOK : STEP_STATUS[s.status])

/* ---------- 调模型的并发上限（SOP-07） ---------- */

/** 要调模型的节点：AI 处理、参数提取、问题分类、迭代、调用 Agent；知识检索只做关键词检索，不算 */
export const MODEL_KINDS = ['ai', 'extract', 'classifier', 'iterate', 'agent']
export const isModelKind = (kind: string) => MODEL_KINDS.includes(kind)
/** 交给 Claude Code、走 Claude Code 名额和需求预算的节点（执行任务 task_run 同 claude_code，TSK-0411） */
export const isClaudeKind = (kind: string) => kind === 'claude_code' || kind === 'task_run'
export const MODEL_CONCURRENCY_DEFAULT = 2
export const MODEL_CONCURRENCY_MAX = 16

/**
 * 跨所有执行限制同时调模型的步骤数：占着名额的（gated）不动；没名额的标 queue 并记「排队等模型（前面还有 N 个）」，
 * 排到了去掉 queue、从这时开始计时并记「排到了，开始调模型」。先按执行的发起时间、再按步骤顺序排；调小时占着的不打断。
 * 正式产品在后端（gate.go），子流程按父执行的发起时间排；原型的子流程不起子执行，不用管
 */
export function gateRuns(runs: SopRun[], limit: number, now = Date.now()): SopRun[] {
  let held = 0
  const wait: { r: number; i: number }[] = []
  runs.forEach((run, r) => run.steps.forEach((s, i) => {
    if (run.stopped || s.status !== 'running' || !isModelKind(run.sop.steps[i].kind)) return
    if (s.gated) held++
    else wait.push({ r, i })
  }))
  let changed = false
  const out = runs.map((run) => {
    // 不在执行的步骤清掉排队标记
    if (!run.steps.some((s) => (s.gated || s.queue) && (s.status !== 'running' || run.stopped))) return run
    changed = true
    return { ...run, steps: run.steps.map((s) => (s.status !== 'running' || run.stopped ? { ...s, gated: undefined, queue: undefined } : s)) }
  })
  wait.sort((a, b) => (runs[a.r].started_at - runs[b.r].started_at) || (a.r - b.r) || (a.i - b.i))
  let granted = 0
  wait.forEach(({ r, i }, n) => {
    const s = out[r].steps[i]
    let next: RunStep
    if (held < limit) {
      held++
      granted++
      next = s.queue ? logged({ ...s, gated: true, queue: undefined, started_at: now }, now, '排到了，开始调模型') : { ...s, gated: true }
    } else {
      // 排在前面、这次也没排到的个数
      const ahead = n - granted
      next = s.queue ? (s.queue.ahead === ahead ? s : { ...s, queue: { ahead } })
        : logged({ ...s, queue: { ahead } }, now, `排队等模型（前面还有 ${ahead} 个）`)
    }
    if (next !== s) {
      changed = true
      out[r] = { ...out[r], steps: out[r].steps.map((x, j) => (j === i ? next : x)) }
    }
  })
  return changed ? out : runs
}

/**
 * 流水线治理（AUTO-12，SPEC-sop-15）：同时跑的 Claude Code 步骤数、每个需求累计跑 Claude Code 的次数和分钟数，0 是不限。
 * 正式产品存在插件设置 sop_settings，账本在 sop_claude_usage（governance.go）；token 用量拿不到，不按 token 控制
 */
export type Governance = { claude_concurrency: number; task_max_claude_runs: number; task_max_claude_minutes: number }
export const GOVERNANCE_DEFAULT: Governance = { claude_concurrency: 3, task_max_claude_runs: 30, task_max_claude_minutes: 1440 }
export const GOVERNANCE_MAX: Governance = { claude_concurrency: 10, task_max_claude_runs: 1000, task_max_claude_minutes: 100000 }

/** Claude Code 步骤算到哪份预算上：配了关联任务按任务，没配按这次执行 */
export const budgetKey = (run: SopRun, i: number) => render(run.sop.steps[i].config?.task ?? '', run.steps[i].input ?? {}) || run.object_id || `run:${run.id}`

/** 一份预算已经用了的次数和分钟数：发起过的 Claude Code 步骤，每次尝试算一次（含重试、退回重做）；在跑的算到 now */
export function claudeUsage(runs: SopRun[], key: string, now = Date.now()): { runs: number; minutes: number } {
  let n = 0
  let ms = 0
  for (const r of runs) {
    r.steps.forEach((s, i) => {
      if (!isClaudeKind(r.sop.steps[i].kind) || budgetKey(r, i) !== key) return
      const launched = s.cgated || !!s.claude || s.status === 'done' || s.status === 'failed'
      if (!launched) return
      n += Math.max(1, s.attempts)
      if (s.started_at) ms += (s.ended_at ?? now) - s.started_at
    })
  }
  return { runs: n, minutes: Math.floor(ms / 60000) }
}

/**
 * 每次调度后做一次治理：刚放出来的 Claude Code 步骤先查预算，超了转 paused、记 hold；没超的按 claude_concurrency 排队（queue.slot = claude_code），
 * 排到了从这时开始计时。人放行过的那次尝试不再拦。正式产品在后端（governance.go），超限还发一条错误级通知
 */
export function governRuns(runs: SopRun[], gov: Governance, now = Date.now()): SopRun[] {
  let out = runs
  const put = (r: number, i: number, next: RunStep) => {
    out = out.map((run, k) => (k === r ? { ...run, steps: run.steps.map((x, j) => (j === i ? next : x)) } : run))
  }
  // 预算
  runs.forEach((run, r) => run.steps.forEach((s, i) => {
    if (run.stopped || s.status !== 'running' || s.cgated || s.queue || !isClaudeKind(run.sop.steps[i].kind)) return
    if (s.hold?.released && s.hold.attempt === s.attempts) return
    const key = budgetKey(run, i)
    const u = claudeUsage(out, key, now)
    const who = key.startsWith('run:') ? '这次流水线' : `需求 ${key} `
    let hold: RunStep['hold']
    if (gov.task_max_claude_runs > 0 && u.runs >= gov.task_max_claude_runs) {
      hold = { kind: 'runs', reason: `${who}已经跑了 ${u.runs} 次 Claude Code，到了上限 ${gov.task_max_claude_runs} 次`, since: now }
    } else if (gov.task_max_claude_minutes > 0 && u.minutes >= gov.task_max_claude_minutes) {
      hold = { kind: 'duration', reason: `${who}Claude Code 累计跑了 ${u.minutes} 分钟，到了上限 ${gov.task_max_claude_minutes} 分钟`, since: now }
    }
    if (hold) put(r, i, logged({ ...s, status: 'paused', hold, attempts: Math.max(0, s.attempts - 1) }, now, `超出上限，暂停：${hold.reason}。点「继续」放行这一次，或到 SOP 设置里调高上限`))
  }))
  // 并发
  let held = 0
  const wait: { r: number; i: number }[] = []
  out.forEach((run, r) => run.steps.forEach((s, i) => {
    if (!isClaudeKind(run.sop.steps[i].kind)) return
    if (run.stopped || s.status !== 'running') {
      if (s.cgated || s.queue?.slot) put(r, i, { ...s, cgated: undefined, queue: undefined })
      return
    }
    if (s.cgated) held++
    else wait.push({ r, i })
  }))
  wait.sort((a, b) => (out[a.r].started_at - out[b.r].started_at) || (a.r - b.r) || (a.i - b.i))
  let granted = 0
  wait.forEach(({ r, i }, n) => {
    const s = out[r].steps[i]
    if (held < gov.claude_concurrency) {
      held++
      granted++
      put(r, i, s.queue ? logged({ ...s, cgated: true, queue: undefined, started_at: now }, now, '排到了，交给 Claude Code') : { ...s, cgated: true })
    } else {
      const ahead = n - granted
      if (!s.queue) put(r, i, logged({ ...s, queue: { ahead, slot: 'claude_code' } }, now, `排队等 Claude Code 名额（前面还有 ${ahead} 个）`))
      else if (s.queue.ahead !== ahead) put(r, i, { ...s, queue: { ahead, slot: 'claude_code' } })
    }
  })
  return out
}

/** 这一步正停在「超出上限」上等人放行 */
export const isHeld = (s: RunStep) => s.status === 'paused' && !!s.hold && !s.hold.released

const FINISHED: StepStatus[] = ['done', 'skipped', 'bypassed']
export const isFinished = (s: StepStatus) => FINISHED.includes(s)
export const needsMe = (s: StepStatus) => s === 'paused' || s === 'review' || s === 'failed'

export function runStatus(r: SopRun): RunStatus {
  if (r.stopped) return 'stopped'
  if (r.steps.some((s) => s.status === 'failed')) return 'failed'
  if (r.steps.some((s) => s.status === 'paused' || s.status === 'review')) return 'waiting'
  if (r.steps.every((s) => isFinished(s.status))) return 'done'
  return 'running'
}

/** 界面默认看哪一步：先看等人处理的，再看执行中的，都没有就看最后完成的 */
export function focusIndex(r: SopRun) {
  const by = (f: (s: RunStep) => boolean) => r.steps.findIndex(f)
  const i = [by((s) => needsMe(s.status)), by((s) => s.status === 'running')].find((x) => x >= 0)
  if (i !== undefined) return i
  let last = 0
  r.steps.forEach((s, j) => { if (s.status === 'done' && (s.ended_at ?? 0) >= (r.steps[last].ended_at ?? 0)) last = j })
  return last
}

/* ---------- 流程图结构 ---------- */

/** 补全默认依赖：没写 after 的接在上一步后面 */
export const depsOf = (sop: Sop, i: number): string[] => sop.steps[i].after ?? (i === 0 ? [] : [sop.steps[i - 1].key])

/** 每步在图里的列：起点为 0，其余是依赖的最大列 + 1 */
export function ranks(sop: Sop): number[] {
  const idx = new Map(sop.steps.map((s, i) => [s.key, i]))
  const memo: number[] = []
  const rank = (i: number): number => {
    if (memo[i] !== undefined) return memo[i]
    const deps = depsOf(sop, i)
    memo[i] = deps.length ? 1 + Math.max(...deps.map((k) => rank(idx.get(k)!))) : 0
    return memo[i]
  }
  sop.steps.forEach((_, i) => rank(i))
  return memo
}

/* ---------- 流程定义 ---------- */

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const rid = () => Math.random().toString(36).slice(2, 7)
type Demand = { title: string; evidence: string; type: 'feature' | 'bug'; priority: string }

export const SOPS: Sop[] = [
  {
    id: 'sop_feedback',
    name: '客户反馈转需求',
    desc: '把 IM 里的客户反馈提炼成诉求，按功能需求和缺陷分开处理，回复客户并同步研发',
    trigger: 'im',
    fields: [
      { key: 'customer', label: '客户', type: 'text', required: true, default: '梁晚晴', placeholder: '联系人姓名' },
      { key: 'channel', label: '回复渠道', type: 'select', default: 'lark', options: [
        { value: 'lark', label: '飞书' }, { value: 'slack', label: 'Slack' }, { value: 'telegram', label: 'Telegram' }, { value: 'wechat', label: '微信' },
      ] },
      { key: 'message', label: '反馈原文', type: 'textarea', required: true, default: '导出的报表里时间是 UTC，我们财务每次都要手动换算成北京时间，能不能导出时选时区？另外导出超过 5 万行就卡住了。' },
    ],
    steps: [
      {
        key: 'fetch', name: '整理反馈原文', kind: 'auto', ms: 900, after: [],
        desc: '去掉寒暄和表情，按句拆开，带上客户和渠道信息',
        run: (i) => ({ customer: i.customer, channel: i.channel, sentences: str(i.message).split(/[。？！?!]/).map((s) => s.trim()).filter(Boolean) }),
      },
      {
        key: 'extract', name: 'AI 提炼诉求', kind: 'ai', ms: 2200,
        desc: '每条诉求给出一句话描述、类型和建议优先级',
        run: (i) => ({
          customer: i.customer, channel: i.channel,
          demands: ((i.sentences as string[]) ?? []).filter((s) => /能不能|卡|希望|报错|打不开|失败/.test(s)).map((s, n): Demand => {
            const bug = /卡|报错|打不开|失败/.test(s)
            return {
              title: /时区/.test(s) ? '导出报表支持选择时区' : /导出.*卡/.test(s) ? '大数据量导出改为异步任务' : /报错|打不开/.test(s) ? '审批提交报错、详情打不开' : s.slice(0, 20),
              evidence: s, type: bug ? 'bug' : 'feature', priority: bug ? 'P0' : n === 0 ? 'P1' : 'P2',
            }
          }),
        }),
      },
      {
        key: 'classify', name: '判断反馈类型', kind: 'decide', ms: 500,
        desc: '有功能诉求走需求流程；全是缺陷就直接建缺陷单',
        cases: [{ key: 'feature', label: '功能需求' }, { key: 'bug', label: '缺陷' }],
        decide: (i) => {
          const ds = (i.demands as Demand[]) ?? []
          const f = ds.filter((d) => d.type === 'feature').length
          return f ? { route: 'feature', reason: `${ds.length} 条诉求里有 ${f} 条是功能需求` } : { route: 'bug', reason: `${ds.length} 条诉求都是缺陷` }
        },
        run: (i) => i,
      },
      {
        key: 'confirm', name: '确认诉求清单', kind: 'review', ms: 300, after: ['classify'], branch: { of: 'classify', case: 'feature' },
        desc: '检查 AI 拆出来的诉求对不对，改标题或优先级后放行',
        run: (i) => i,
      },
      {
        key: 'archive', name: '存为内容摘录', kind: 'auto', ms: 800,
        desc: '在「文档 > 摘录」里新建一条，带上原文出处',
        run: (i) => ({ ...i, content_id: newId('dc') }),
      },
      {
        key: 'bug_ticket', name: '建缺陷单', kind: 'auto', ms: 900, after: ['classify'], branch: { of: 'classify', case: 'bug' },
        desc: '按 P0 建缺陷单，附上客户原话',
        run: (i) => ({ ...i, ticket: `BUG-${Math.floor(1000 + Math.random() * 9000)}` }),
      },
      {
        key: 'draft', name: 'AI 起草回复', kind: 'ai', ms: 1800, after: ['archive', 'bug_ticket'],
        desc: '按客户的语气起草一条回复，告知已记录和大致排期',
        run: (i) => {
          const ds = (i.demands as Demand[]) ?? []
          return {
            channel: i.channel, to: i.customer,
            text: i.ticket
              ? `${str(i.customer)}你好，问题已经复现并提了缺陷单 ${str(i.ticket)}，今天会有同事跟进修复，修好后第一时间告诉你。`
              : `${str(i.customer)}你好，反馈已收到并记录为需求：${ds.map((d) => `「${d.title}」`).join('、')}。下周排期会上评估，有结论第一时间同步你。`,
          }
        },
      },
      {
        key: 'notify_team', name: '同步给研发群', kind: 'auto', ms: 1200, after: ['archive', 'bug_ticket'],
        desc: '把诉求或缺陷单发到研发群，和回复客户并行',
        run: (i) => ({ posted: true, group: '研发群', items: i.ticket ? [i.ticket] : ((i.demands as Demand[]) ?? []).map((d) => d.title) }),
      },
      {
        key: 'review_reply', name: '检查回复内容', kind: 'review', ms: 300, after: ['draft'],
        desc: '发出去之前看一眼，措辞可以直接改',
        run: (i) => i,
      },
      {
        key: 'send', name: '发送回复', kind: 'auto', ms: 1000,
        desc: '通过对应渠道的连接器发出',
        run: (i) => ({ sent: true, channel: i.channel, message_id: newId('msg') }),
        fail: (i) => (i.channel === 'wechat' ? '微信连接器凭证已过期（401），去设置 > 连接器里重新授权后重试' : null),
      },
      {
        key: 'close', name: '标记消息已处理', kind: 'auto', ms: 500, after: ['send', 'notify_team'],
        desc: '回复和同步都完成后，把这条 IM 消息标为已处理',
        run: () => ({ message_status: 'done' }),
      },
    ],
  },
  {
    id: 'sop_meeting',
    name: '周会纪要整理',
    desc: '转写稿拆开后并行生成纪要、待办和发言统计，校对后同时归档和同步到群里',
    // 定时：每周一 18:00，规则在随流程管理的定时任务 sc_meeting 里（TSK-0463，原来是写死的 weekly）
    trigger: 'schedule',
    fields: [
      { key: 'meeting', label: '会议', type: 'text', required: true, default: '产品周会 10/26' },
      { key: 'transcript', label: '转写稿', type: 'textarea', required: true, default: '林予安：权限点清单周三前和后端对齐。\n周屿：导出异步化要先评估存储成本。\n陈若溪：远川的时区问题这周先给临时方案。\n周屿：好，缓存方案我周五前出。' },
    ],
    steps: [
      {
        key: 'split', name: '按发言人切分', kind: 'auto', ms: 800, after: [],
        desc: '把转写稿拆成「谁 - 说了什么」',
        run: (i) => ({ meeting: i.meeting, lines: str(i.transcript).split('\n').filter(Boolean).map((l) => { const [who, ...rest] = l.split('：'); return { who, said: rest.join('：') } }) }),
      },
      {
        key: 'summarize', name: 'AI 提炼结论', kind: 'ai', ms: 2400, after: ['split'],
        desc: '会上定下来的事',
        run: (i) => ({ conclusions: ((i.lines as { said: string }[]) ?? []).filter((l) => !/前/.test(l.said)).map((l) => l.said) }),
      },
      {
        key: 'todos', name: 'AI 提取待办', kind: 'ai', ms: 1900, after: ['split'],
        desc: '负责人 + 截止时间',
        run: (i) => ({ todos: ((i.lines as { who: string; said: string }[]) ?? []).filter((l) => /前/.test(l.said)).map((l) => ({ owner: l.who, task: l.said.replace(/^好，/, ''), due: /周三/.test(l.said) ? '周三' : '周五' })) }),
      },
      {
        key: 'stats', name: '统计发言', kind: 'auto', ms: 700, after: ['split'],
        desc: '每人发言次数，看谁没说话',
        run: (i) => ({ speakers: ((i.lines as { who: string }[]) ?? []).reduce<Record<string, number>>((a, l) => ({ ...a, [l.who]: (a[l.who] ?? 0) + 1 }), {}) }),
      },
      {
        key: 'proofread', name: '校对纪要', kind: 'review', ms: 300, after: ['summarize', 'todos', 'stats'],
        desc: '三路结果汇到一起，核对待办的负责人和截止时间',
        run: (i) => ({ ...(i.summarize as Json), ...(i.todos as Json), ...(i.stats as Json) }),
      },
      {
        key: 'save', name: '归档到内容', kind: 'auto', ms: 700, after: ['proofread'],
        desc: '存为「文档 > 会议纪要」',
        run: (i) => ({ ...i, content_id: newId('dc') }),
      },
      {
        key: 'notify', name: '同步到飞书群', kind: 'auto', ms: 900, after: ['proofread'],
        desc: '发到项目群，@ 待办负责人',
        run: (i) => ({ posted: true, group: '产品组', mentions: ((i.todos as { owner: string }[]) ?? []).map((t) => t.owner) }),
      },
    ],
  },
  {
    id: 'sop_contact',
    name: '联系人建档',
    desc: '从签名或名片文字里解析联系方式，查重后由人决定新建还是合并',
    trigger: 'manual',
    fields: [
      { key: 'raw', label: '签名 / 名片文字', type: 'textarea', required: true, default: '梁晚晴 | 采购总监\n远川科技\n手机 136 5566 7788\n邮箱 wanqing.liang@yuanchuan.tech\n飞书 ou_liangwq' },
    ],
    steps: [
      {
        key: 'parse', name: 'AI 解析字段', kind: 'ai', ms: 1600, after: [],
        desc: '识别姓名、公司、职位、电话、邮箱、IM 账号',
        run: (i) => {
          const raw = str(i.raw)
          const [first = '', company = ''] = raw.split('\n')
          const [name = '', title = ''] = first.split('|').map((s) => s.trim())
          return {
            name, title, company: company.trim(),
            phone: /(1\d{2}[\s-]?\d{4}[\s-]?\d{4})/.exec(raw)?.[1] ?? '',
            email: /[\w.]+@[\w.]+/.exec(raw)?.[0] ?? '',
            im: { lark: /飞书\s*(\S+)/.exec(raw)?.[1] ?? '' },
          }
        },
      },
      {
        key: 'dedupe', name: '查重', kind: 'auto', ms: 700,
        desc: '按姓名、电话、IM 账号比对已有联系人',
        run: (i) => {
          const digits = (s: string) => s.replace(/\D/g, '')
          const im = (i.im as Record<string, string>) ?? {}
          return {
            ...i,
            candidates: seedContacts.flatMap((c) => {
              const hits = [c.name === i.name && '姓名', c.phone && digits(c.phone) === digits(str(i.phone)) && '电话', im.lark && c.im.lark === im.lark && '飞书账号'].filter(Boolean)
              return hits.length ? [{ id: c.id, name: c.name, company: c.company, title: c.title, matched: hits }] : []
            }),
          }
        },
      },
      {
        key: 'match', name: '新建还是合并', kind: 'decide', ms: 300,
        desc: '查重有疑似重复时由人判断；没有候选也要确认一次',
        cases: [{ key: 'new', label: '新建联系人' }, { key: 'merge', label: '合并到已有' }],
        run: (i) => i,
      },
      {
        key: 'write', name: '写入新联系人', kind: 'auto', ms: 600, after: ['match'], branch: { of: 'match', case: 'new' },
        desc: '新建一条联系人',
        run: (i) => ({ contact_id: newId('ct'), name: i.name }),
      },
      {
        key: 'merge', name: '合并字段', kind: 'review', ms: 400, after: ['match'], branch: { of: 'match', case: 'merge' },
        desc: '列出要覆盖的字段（职位、邮箱等），确认后写回已有联系人',
        run: (i) => {
          const c = ((i.candidates as { id: string; title: string }[]) ?? [])[0]
          return { contact_id: c?.id ?? '', changes: { title: { from: c?.title ?? '', to: i.title }, email: { to: i.email } } }
        },
      },
    ],
  },  {
    // 视频模块的阶段执行器可以直接选它；检查点对应视频的四个检查点，人放行了才往下走
    id: 'sop_video_weekly',
    name: '视频周更',
    desc: '按 web-video-presentation 技能把一集从原文做到分发包：AI 出稿、Agent 开发第 1 章、并行做其余章节、渲染，四处停下等人检查',
    trigger: 'manual',
    fields: [
      { key: 'video', label: '视频', type: 'text', required: true, default: '第 3 集：Agent 怎么配才放心', placeholder: '哪一集' },
      { key: 'orient', label: '画面比例', type: 'select', default: 'both', options: [
        { value: 'both', label: '横屏和竖屏两套' }, { value: 'landscape', label: '只出横屏' }, { value: 'portrait', label: '只出竖屏' },
      ] },
      { key: 'chapters', label: '章节数', type: 'text', default: '4' },
      { key: 'article', label: '原文', type: 'textarea', required: true, default: 'Agent 能做的事越多，越要先想清楚哪些动作要人确认。这一集讲三件事：能力开关怎么配、确认卡片什么时候弹、出了错怎么查运行记录。' },
    ],
    steps: [
      {
        key: 'script', name: '文稿处理', kind: 'ai', ms: 2200, after: [],
        desc: '把原文改成口播稿和大纲；双方向的横版、竖版各写一套，竖版每屏压到 40 字以内',
        config: { output: 'scripts' },
        run: (i) => {
          const orients = i.orient === 'both' ? ['landscape', 'portrait'] : [str(i.orient) || 'landscape']
          const n = Math.max(1, Number(i.chapters) || 4)
          return {
            video: i.video, orients, chapters: Array.from({ length: n }, (_, k) => `第 ${k + 1} 章`),
            scripts: orients.map((o) => ({ variant: o, path: `script-${o}.md`, status: 'review' })),
            outline: orients.map((o) => ({ variant: o, path: `outline-${o}.md` })),
          }
        },
      },
      {
        key: 'plan', name: '规划检查', kind: 'review', ms: 300,
        desc: '对齐稿子、大纲、主题、素材和画面比例；放行后比例锁定',
        run: (i) => i,
      },
      {
        key: 'ch1', name: '开发第 1 章', kind: 'agent', ms: 2600,
        desc: '交给 Agent 按技能搭演示工程，第 1 章做完整，作为后面各章的样板。用前选一个能写文件、开终端的 Agent',
        config: { prompt: '按 web-video-presentation 技能搭 {{orients}} 的演示工程，第 1 章完整做出来，跑起来截图给我看' },
        run: (i) => ({ ...i, presentations: ((i.orients as string[]) ?? []).map((o) => ({ variant: o, path: `presentation-${o}`, done: ['第 1 章'] })) }),
      },
      {
        key: 'ch1_review', name: '检查第 1 章', kind: 'review', ms: 300,
        desc: '第 1 章是样板：版式、节奏、动效都在这里定，不行就退回重做',
        run: (i) => i,
      },
      {
        key: 'rest', name: '并行开发其余章节', kind: 'iterate', ms: 3000,
        desc: '第 2 到 N 章照第 1 章的样板各开一路，同时开发',
        config: { list: 'chapters', action: '照第 1 章的样板开发这一章' },
        run: (i) => ({ ...i, presentations: ((i.presentations as { variant: string; path: string }[]) ?? []).map((p) => ({ ...p, done: i.chapters })) }),
      },
      {
        key: 'audio', name: '音频检查', kind: 'review', ms: 300,
        desc: '决定要不要合成口播音频；要的话按章节听一遍，多音字和停顿在这里改',
        run: (i) => ({ ...i, audio: { path: 'audio/', chapters: ((i.chapters as string[]) ?? []).length } }),
      },
      {
        key: 'render', name: '渲染', kind: 'code', ms: 2400,
        desc: '逐章程序化录屏，合成 mp4，按章节时间点出字幕',
        config: { language: 'javascript', code: 'function main(input) {\n  // 每个比例录一遍：playwright 逐章录屏，ffmpeg 拼接并混入口播音频\n  return { videos: input.orients.map((o) => `out/${o}.mp4`) }\n}' },
        run: (i) => ({
          ...i,
          videos: ((i.orients as string[]) ?? []).map((o) => ({ variant: o, path: `out/${o}.mp4` })),
          subtitles: ((i.orients as string[]) ?? []).map((o) => ({ variant: o, path: `subtitle/${o}.srt`, lang: 'zh' })),
        }),
      },
      {
        key: 'dist', name: '分发包检查', kind: 'review', ms: 300,
        desc: '封面（每种封面比例 5 个版本）、简介、章节时间轴都齐了再放行，之后去发布记录按平台发',
        run: (i) => ({ ...i, covers: ((i.orients as string[]) ?? []).map((o) => ({ variant: o, options: 5 })) }),
      },
    ],
  },
  // 消息分诊（SPEC-messages-2.41）：判断一条消息要不要我处理；要处理的写一句处理建议（advice）并标 need=yes，不用管的标已忽略（marked）。
  // 消息抽屉「分诊建议」一节按这些输出字段取结论，不认步骤 key。原型的判断是写死的规则
  {
    id: 'sop_triage',
    name: '消息分诊：要不要我处理',
    desc: '读消息、判断要不要我处理。要处理的写一句处理建议；不用管的标成已忽略',
    trigger: 'manual',
    fields: [{ key: 'message_id', label: '消息', type: 'text', required: true, placeholder: '消息 id' }],
    steps: [
      {
        key: 'read', name: '读取消息', kind: 'auto', ms: 300, after: [], desc: '按消息 id 读出发信人、会话、正文',
        run: (i) => {
          const m = seedMessages.find((x) => x.id === i.message_id)
          return { ...i, message: m ? { id: m.id, sender: m.sender_name, conversation: m.conversation || '私聊', text: m.text } : { id: i.message_id, text: '' } }
        },
      },
      {
        key: 'triage', name: '要不要我处理', kind: 'classifier', ms: 900, desc: '私聊里找我、群里 @我 要我做事的算要处理；@所有人、广播、闲聊算忽略',
        cases: [{ key: 'handle', label: '需要我处理' }, { key: 'ignore', label: '忽略' }],
        decide: (i) => {
          const t = str((i.message as Json | undefined)?.text)
          const handle = !/@所有人/.test(t) && /@Broleez|能不能|麻烦|确认|？|\?|找时间/.test(t)
          return handle ? { route: 'handle', reason: '模型判断属于「需要我处理」' } : { route: 'ignore', reason: '模型判断属于「忽略」' }
        },
        run: (i) => i,
      },
      {
        key: 'advise', name: '写处理建议', kind: 'ai', ms: 1200, after: ['triage'], branch: { of: 'triage', case: 'handle' },
        desc: '一两句话写：对方要我做什么；建议怎么回或下一步做什么；有截止时间就写出来', config: { output: 'advice' },
        run: (i) => {
          const msg = (i.message as Json | undefined) ?? {}
          const t = str(msg.text)
          const ask = t.replace(/@\S+\s*/g, '').split(/[。？！?!]/).map((x) => x.trim()).find((x) => /能不能|麻烦|确认|吗|找时间|can we/i.test(x)) ?? t.slice(0, 30)
          const due = /今天/.test(t) ? '今天内' : /这周|this week/i.test(t) ? '本周内' : /下周/.test(t) ? '下周前' : ''
          return { ...i, advice: `${str(msg.sender)} 希望：${ask}。\n建议先回复「收到，我看一下」，${due ? `${due}给出答复` : '看完后给出结论'}；需要别人配合的先拉上相关同事。` }
        },
      },
      {
        key: 'drop', name: '标成已忽略', kind: 'auto', ms: 300, after: ['triage'], branch: { of: 'triage', case: 'ignore' }, desc: '消息页「已忽略」里还找得到',
        run: (i) => ({ ...i, marked: { message_id: i.message_id, state: 'ignore', status: 'ignored' } }),
      },
      {
        key: 'flag', name: '标记要处理', kind: 'template', ms: 200, after: ['advise'], desc: '给上层流程判断要不要建任务', config: { output: 'need', template: 'yes' },
        run: (i) => ({ ...i, need: 'yes' }),
      },
    ],
  },
  // 需求评审闭环（AUTO-01 Claude Code 执行 + AUTO-02 条件回退）：产品 Agent 写 PRD，研发评审 Agent 只读评审，
  // 不通过自动退回产品带着意见重写，最多 3 轮，超限转人工裁决。原型里评审首轮不通过、第 2 轮通过
  {
    id: 'sop_prd_review',
    name: '需求评审闭环',
    desc: 'Claude Code 按产品角色写 PRD，再按研发评审角色只读评审；不通过自动退回重写，最多 3 轮，超限转人工',
    trigger: 'manual',
    fields: [
      { key: 'task_id', label: '需求任务', type: 'text', required: true, placeholder: '任务 id' },
      { key: 'dir', label: '项目目录', type: 'text', required: true, default: '/Volumes/project/acme', placeholder: '本机绝对路径' },
    ],
    steps: [
      {
        key: 'prd', name: '产品：写 PRD', kind: 'claude_code', ms: 3000, after: [],
        desc: '按任务正文写 PRD、更新原型；被评审退回时带着意见改',
        config: { preset: 'rp_pm', workdir: '{{dir}}', prompt: '按任务 {{task_id}} 写 PRD，更新原型与规格', task: '{{task_id}}', permission: '', timeout: '2 小时' },
      },
      {
        key: 'review', name: '研发评审', kind: 'claude_code', ms: 3000,
        desc: '只读评审 PRD，回报 verdict 和 issues',
        config: { preset: 'rp_review', workdir: '{{dir}}', prompt: '评审任务 {{task_id}} 的 PRD', task: '{{task_id}}', permission: '', timeout: '1 小时' },
      },
      {
        key: 'gate', name: '评审不通过就退回', kind: 'loopback', ms: 400, rule: 'result.verdict 等于 reject',
        desc: '不通过退回产品重写，意见作为 feedback 带回去',
        config: { target: 'prd', max_rounds: '3' },
        cases: [{ key: 'pass', label: '通过' }, { key: 'over', label: '超限' }],
      },
      {
        key: 'dev', name: '进入研发', kind: 'task', ms: 600, after: ['gate'], branch: { of: 'gate', case: 'pass' },
        desc: '评审通过，建研发任务',
        config: { title: '开发：{{summary}}', priority: 'P1', assignee: '我' },
      },
      {
        key: 'human', name: '人工裁决', kind: 'review', ms: 300, after: ['gate'], branch: { of: 'gate', case: 'over' },
        desc: '退回 3 轮仍不通过：看评审意见决定放行还是打回',
      },
    ],
  },
  // IM 需求自动受理（AUTO-06，SPEC-sop-0 演示数据、SPEC-messages-2.51）：正式产品由 IM 插件写进 SOP 的内置流程 sop_im_auto_intake，
  // 默认停用（触发方式手动），在编排页把触发方式改成「IM 消息」才自动处理新消息。IM、项目插件的节点原型里用 auto 模拟：
  // 读取消息、转成任务、回执、列/读项目档案、设置任务阶段、问提出人、等回复。原型里分类拿得准、评审首轮退回、第 2 轮通过
  {
    id: 'sop_im_auto_intake',
    name: 'IM 需求自动受理',
    desc: 'IM 消息是需求就建任务、回执需求方，按项目档案分类（拿不准问提出人），Claude Code 写 PRD、研发评审，不通过自动退回最多 3 轮，通过后进入开发。默认停用：触发方式是「手动」，改成「IM 消息」才会自动处理新消息',
    trigger: 'manual',
    fields: [
      { key: 'message_id', label: 'IM 消息', type: 'text', required: true, default: 'm1', placeholder: '消息 id；IM 触发时自动带上' },
      { key: 'conversation_id', label: '会话', type: 'text', placeholder: '留空取消息所在的会话' },
    ],
    steps: [
      {
        key: 'read', name: '读取消息', kind: 'auto', ms: 300, after: [], desc: '按消息 id 取出正文、发信人和会话',
        run: (i) => {
          const m = seedMessages.find((x) => x.id === i.message_id) ?? seedMessages[0]
          return { ...i, message: { id: m.id, sender: m.sender_name, conversation: m.conversation || '私聊', text: m.text } }
        },
      },
      {
        key: 'is_req', name: '是不是需求', kind: 'classifier', ms: 800, after: ['read'],
        desc: '要做新功能、改进、修问题、改产品的算需求；闲聊、通知、问进度、单纯提问不算',
        cases: [{ key: 'req', label: '是需求' }, { key: 'other', label: '不是需求' }], config: { from: 'message.text' },
        decide: (i) => (/午饭|收到|谢谢/.test(str((i.message as Json | undefined)?.text))
          ? { route: 'other', reason: '模型判断属于「不是需求」' } : { route: 'req', reason: '模型判断属于「是需求」' }),
        run: (i) => i,
      },
      { key: 'skip', name: '普通消息不建任务', kind: 'end', ms: 200, after: ['is_req'], branch: { of: 'is_req', case: 'other' }, desc: '不是需求，流程到此结束，消息照常留在消息页' },
      {
        key: 'to_task', name: '建需求任务', kind: 'auto', ms: 500, after: ['is_req'], branch: { of: 'is_req', case: 'req' },
        desc: '转成任务（IM 插件 im_to_task）：记来源消息和提出人，阶段「已接收」；这条消息转过任务就用那条',
        run: (i) => ({ ...i, task: { id: 'tsk_auto1', ref: 'TSK-0101', title: str((i.message as Json | undefined)?.text).slice(0, 40), stage: 'received', url: 'https://pmw.local/tasks/board?t=tsk_auto1' } }),
      },
      {
        key: 'ack', name: '回执需求方', kind: 'auto', ms: 400, after: ['to_task'],
        desc: '回执需求方（IM 插件 im_ack_task，TSK-0467）：在原消息所在的会话里回复「已创建任务 TSK-x，开始进行需求规划」；同一条消息只回一次，我自己发的、只收不发的不回，回复失败不影响任务',
        run: (i) => ({ ...i, acked: { status: 'sent', task_ref: str((i.task as Json).ref), text: `已创建任务 ${str((i.task as Json).ref)}，开始进行需求规划` } }),
      },
      {
        key: 'profiles', name: '读项目档案', kind: 'auto', ms: 300, after: ['ack'], desc: '列项目档案（项目插件 projects_list_profiles）：建过档案的项目摘要，给分类用',
        run: (i) => ({ ...i, profiles_text: '- 产品工作台（PRJ-0001）：个人产品管理工具；关键词：需求、SOP\n- Acme（PRJ-0002）：桌面客户端；关键词：客户端、导出' }),
      },
      {
        key: 'classify', name: '判断归属项目', kind: 'ai', ms: 1500, after: ['profiles'], config: { output: 'classify' },
        desc: '读需求原文和各项目档案，回 JSON：project_id、confidence、sure（置信度不低于 0.7 为 yes）、candidates_text、reason',
        run: (i) => ({ ...i, classify: '{"project_id":"p2","confidence":0.9,"sure":"yes"}' }),
      },
      {
        key: 'parse', name: '整理分类结果', kind: 'extract', ms: 600, after: ['classify'], config: { from: 'classify', fields: 'project_id、project、confidence、sure、candidates_text、reason' },
        desc: '把分类回答整理成字段',
        run: (i) => ({ ...i, extracted: { project_id: 'p2', project: 'Acme', confidence: 0.9, sure: 'yes', candidates_text: '1. Acme（PRJ-0002）', reason: '说的是客户端导出' } }),
      },
      {
        key: 'sure', name: '拿得准吗', kind: 'decide', ms: 300, after: ['parse'], rule: 'extracted.sure 等于 yes',
        desc: '置信度够（不低于 0.7）直接绑项目，不够问提出人', cases: [{ key: 'yes', label: '拿得准' }, { key: 'no', label: '拿不准' }],
        decide: (i) => (str((i.extracted as Json | undefined)?.sure) === 'yes'
          ? { route: 'yes', reason: '规则「extracted.sure 等于 yes」成立' } : { route: 'no', reason: '规则「extracted.sure 等于 yes」不成立' }),
      },
      {
        key: 'bind_auto', name: '绑定项目', kind: 'auto', ms: 300, after: ['sure'], branch: { of: 'sure', case: 'yes' },
        desc: '设置任务阶段（IM 插件 im_set_task_stage）：任务归到分类给出的项目',
        run: (i) => ({ ...i, project: { id: 'p2', name: 'Acme' } }),
      },
      { key: 'ask_stage', name: '阶段改为待确认项目', kind: 'auto', ms: 300, after: ['sure'], branch: { of: 'sure', case: 'no' }, desc: '设置任务阶段：confirm_project' },
      { key: 'ask', name: '问提出人归哪个项目', kind: 'auto', ms: 400, after: ['ask_stage'], desc: '回复原消息：列出候选项目，请对方回复项目名或编号' },
      { key: 'wait', name: '等提出人回复', kind: 'wait', ms: 2500, after: ['ask'], desc: '等待回复（IM 插件 im_wait_reply）：会话里对方的下一条消息，最多 2 天', config: { duration: '2 天' } },
      { key: 'pick', name: '认出选的项目', kind: 'ai', ms: 900, after: ['wait'], desc: '从回复里认出选的项目，只回项目 id', config: { output: 'picked' }, run: (i) => ({ ...i, picked: 'p2' }) },
      { key: 'bind_pick', name: '绑定项目', kind: 'auto', ms: 300, after: ['pick'], desc: '设置任务阶段：任务归到提出人选的项目', run: (i) => ({ ...i, project: { id: str(i.picked), name: 'Acme' } }) },
      {
        key: 'profile', name: '读项目档案', kind: 'auto', ms: 300, after: ['bind_auto', 'bind_pick'], desc: '读项目档案（项目插件 projects_get_profile）：取原型库、PRD、代码库目录',
        run: (i) => ({ ...i, profile: { name: 'Acme', dirs: { code: '/Volumes/project/acme', prototype: '/Volumes/project/acme/web-next', prd: '/Volumes/project/acme/docs/prd' } } }),
      },
      { key: 'design', name: '阶段改为设计中', kind: 'auto', ms: 300, after: ['profile'], desc: '设置任务阶段：designing；评审退回时也从这里重来' },
      {
        key: 'prd', name: '产品：写 PRD 和原型', kind: 'claude_code', ms: 3000, after: ['design'], desc: 'Claude Code 按产品角色在原型库目录写 PRD、更新原型与规格',
        config: { preset: 'rp_pm', workdir: '{{profile.dirs.prototype}}', prompt: '按需求任务 {{task.ref}} 写 PRD、更新原型与规格。需求原文：{{message.text}}。上一轮研发评审退回的意见（第一轮为空）：{{feedback.result.issues}}', task: '{{task.id}}', permission: '', timeout: '2 小时' },
      },
      { key: 'to_review', name: '阶段改为评审中', kind: 'auto', ms: 300, after: ['prd'], desc: '设置任务阶段：reviewing' },
      {
        key: 'review', name: '研发评审', kind: 'claude_code', ms: 3000, after: ['to_review'], desc: 'Claude Code 按研发评审角色只读评审，回报 verdict 和 issues',
        config: { preset: 'rp_review', workdir: '{{profile.dirs.code}}', prompt: '评审需求任务 {{task.ref}} 的 PRD、原型和规格', task: '{{task.id}}', permission: 'read', timeout: '1 小时' },
      },
      {
        key: 'gate', name: '评审不通过就退回', kind: 'loopback', ms: 400, after: ['review'], rule: 'result.verdict 等于 reject',
        desc: '不通过退回「阶段改为设计中」重写，意见作为 feedback 带回去；最多 3 轮',
        config: { target: 'design', max_rounds: '3' }, cases: [{ key: 'pass', label: '通过' }, { key: 'over', label: '超限' }],
      },
      { key: 'dev', name: '阶段改为开发中', kind: 'auto', ms: 300, after: ['gate'], branch: { of: 'gate', case: 'pass' }, desc: '设置任务阶段：developing' },
      { key: 'tell_dev', name: '告诉提出人进入开发', kind: 'auto', ms: 400, after: ['dev'], desc: '回复原消息：设计评审通过，进入开发' },
      // 接研发 pipeline（AUTO-09）：子流程拿这一步的输出当输入，先写出 task_id，再只留任务和来源消息
      { key: 'pipeline_in', name: '交给研发 pipeline', kind: 'template', ms: 200, after: ['tell_dev'], desc: '把任务 id 写成 task_id，研发 pipeline 按它取任务', config: { template: '{{task.id}}', output: 'task_id' } },
      {
        key: 'pipeline_args', name: '只带任务和来源消息', kind: 'end', ms: 200, after: ['pipeline_in'],
        desc: '子流程拿这一步的输出当输入：只留 task_id、message_id、conversation_id，评审的 summary、feedback 不带进研发', config: { outputs: 'task_id, message_id, conversation_id' },
      },
      { key: 'pipeline', name: '研发 pipeline', kind: 'subflow', ms: 1500, after: ['pipeline_args'], desc: '开发、测试、通知验收、人工验收；这一步等研发 pipeline 走完', config: { sop: 'sop_im_dev_pipeline' } },
      { key: 'human_stage', name: '阶段改为需人工', kind: 'auto', ms: 300, after: ['gate'], branch: { of: 'gate', case: 'over' }, desc: '设置任务阶段：need_human' },
      { key: 'human', name: '人工裁决', kind: 'review', ms: 300, after: ['human_stage'], desc: '退回 3 轮仍不通过：看评审意见决定放行还是打回' },
    ],
  },
  // 研发 pipeline（AUTO-09，SPEC-sop-12.43 起）：正式产品由 IM 插件写进 SOP 的内置流程 sop_im_dev_pipeline，默认停用（手动发起，或「IM 需求自动受理」末尾以子流程接上）。
  // IM、项目插件的节点原型里用 auto 模拟：设置任务阶段、读项目档案、准备工作区、跑测试、通知。原型里第一次测试没通过，退回研发一轮后通过；
  // 停在「人工验收」等你选：通过 / 实现缺陷（退回研发）/ 需求偏差（退回产品）
  {
    id: 'sop_im_dev_pipeline',
    name: '研发 pipeline',
    desc: '准备工作区，研发、测试用例、自动化测试三路并行，汇合后部署测试；没通过自动退回研发最多 3 轮；通过后保留测试环境、通知提出人和验收人员，人工验收通过进待发布，实现缺陷退回研发、需求偏差退回产品。默认停用：手动发起，或由「IM 需求自动受理」接上',
    trigger: 'manual',
    fields: [
      { key: 'task_id', label: '任务', type: 'text', required: true, default: 'tk_dev3', placeholder: '任务 id；任务要已归到项目、项目档案里设了代码库和测试命令' },
      { key: 'message_id', label: '来源消息', type: 'text', default: 'm1', placeholder: 'IM 消息 id，有的话通知时在原消息里回复提出人' },
      { key: 'conversation_id', label: '会话', type: 'text', placeholder: '来源消息所在的会话，可空' },
    ],
    steps: [
      {
        key: 'start', name: '阶段改为开发中', kind: 'auto', ms: 300, after: [], desc: '设置任务阶段（IM 插件 im_set_task_stage）：developing，取任务信息',
        run: (i) => ({ ...i, task: { id: str(i.task_id), ref: 'T-017', title: '权限变更缓存改成按部门失效', project_id: 'pj_perm', stage: 'developing', url: 'https://pmw.local/tasks/board?t=tk_dev3' } }),
      },
      {
        key: 'profile', name: '读项目档案', kind: 'auto', ms: 300, after: ['start'], desc: '读项目档案（项目插件 projects_get_profile）：取验收人员',
        run: (i) => ({ ...i, profile: { name: '权限中心', acceptors_text: '许知行、周屿', dirs: { code: '/Volumes/project/perm-center' } } }),
      },
      {
        key: 'worktree', name: '准备工作区', kind: 'auto', ms: 500, after: ['profile'], desc: '准备工作区（项目插件 projects_prepare_worktree）：任务独立的 worktree 和分支 auto/<任务编号>，分一段端口',
        run: (i) => ({ ...i, worktree: { path: '/Volumes/project/example/pm-workspace/data-dev/worktrees/pj_perm/T-017', branch: 'auto/T-017', port_start: 7920 } }),
      },
      { key: 'dev_stage', name: '回到开发中', kind: 'auto', ms: 200, after: ['worktree'], desc: '设置任务阶段：developing；测试没通过、验收发现实现缺陷时退回到这里' },
      {
        key: 'dev', name: '研发：功能开发', kind: 'claude_code', ms: 3000, after: ['dev_stage'], desc: 'Claude Code 按研发角色在工作区里改代码、跑单测、提交',
        config: { preset: 'rp_dev', workdir: '{{worktree.path}}', prompt: '按任务 {{task.ref}} 的内容和验收标准开发（分支 {{worktree.branch}}）。上一轮退回的原因：{{feedback.reason}}；没过的步骤 {{feedback.test.failed_step}}，测试报告 {{feedback.test.report_url}}', task: '{{task.id}}', permission: 'write', timeout: '4 小时' },
        run: (i) => {
          const fb = i.feedback as Json | undefined
          return { ...i, status: 'done', run_id: `run_${Math.random().toString(36).slice(2, 10)}`, result: { files: ['internal/perm/cache.go'], tests: 'passed' },
            summary: fb ? `按第 ${fb.round} 轮的意见改完了：失效时把子部门一起算上（原型模拟）` : '权限缓存改成按部门打版本号，改了哪个部门只失效哪个部门（原型模拟）' }
        },
      },
      {
        key: 'cases', name: '测试用例设计', kind: 'claude_code', ms: 2200, after: ['worktree'], desc: '对照验收标准写测试用例，summary 是验收清单',
        config: { preset: 'rp_testdesign', workdir: '{{worktree.path}}', prompt: '为任务 {{task.ref}} 设计测试用例，写进 docs/test-cases/{{task.ref}}.md', task: '{{task.id}}', permission: 'write', timeout: '4 小时' },
        run: (i) => ({ ...i, status: 'done', run_id: 'run_cases', result: { cases: 4, automated: 3 }, summary: '- [ ] 改部门 A 的权限，1 分钟内 A 的成员生效\n- [ ] 部门 B 的缓存不受影响\n- [ ] 子部门跟着失效' }),
      },
      { key: 'cases_note', name: '记下验收清单', kind: 'template', ms: 200, after: ['cases'], desc: '汇合时研发的 summary 会盖掉这一路的，先存一份', config: { template: '{{summary}}', output: 'test_cases' } },
      {
        key: 'autotest', name: '自动化测试脚本', kind: 'claude_code', ms: 2600, after: ['worktree'], desc: '写单测、接口、端到端脚本，产物写进 TEST_REPORT_DIR',
        config: { preset: 'rp_testdesign', workdir: '{{worktree.path}}', prompt: '为任务 {{task.ref}} 写自动化测试，截图和 junit 写到 TEST_REPORT_DIR', task: '{{task.id}}', permission: 'write', timeout: '4 小时' },
        run: (i) => ({ ...i, status: 'done', run_id: 'run_auto', result: { files: ['internal/perm/cache_test.go', 'e2e/perm.spec.ts'] }, summary: '加了 cache_test.go 和 e2e/perm.spec.ts，覆盖验收标准 1 到 3' }),
      },
      { key: 'autotest_note', name: '记下自动化测试', kind: 'template', ms: 200, after: ['autotest'], desc: '存一份自动化测试的说明', config: { template: '{{summary}}', output: 'autotest' } },
      { key: 'join', name: '三路汇合', kind: 'aggregate', ms: 200, after: ['cases_note', 'autotest_note', 'dev'], desc: '合并三路的输出，研发排最后，summary 是研发的变更说明', config: { mode: 'merge' } },
      { key: 'stage_test', name: '阶段改为测试中', kind: 'auto', ms: 200, after: ['join'], desc: '设置任务阶段：testing' },
      {
        key: 'test', name: '部署测试', kind: 'auto', ms: 2400, after: ['stage_test'],
        desc: '跑测试（项目插件 projects_run_test，保留测试环境：是）：构建、起测试环境、跑测试和冒烟，写测试报告；通过时保留测试环境给人工验收',
        run: (i) => {
          const ok = !!i.feedback
          const until = new Date(Date.now() + 24 * 3600_000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          return { ...i, test: ok
            ? { ok: true, status: 'passed', report_url: 'https://pmw.local/api/projects/tests/runs/tr_dev3/report', env_kept: true, env_text: `http://127.0.0.1:7920（保留到 ${until}，到点自动回收）` }
            : { ok: false, status: 'failed', failed_step: 'test', error: '测试：退出码 1', report_url: 'https://pmw.local/api/projects/tests/runs/tr_x1/report', env_kept: false, env_text: 'http://127.0.0.1:7920（测试跑完已回收）' } }
        },
      },
      {
        key: 'test_gate', name: '测试没通过就退回研发', kind: 'loopback', ms: 400, after: ['test'], rule: 'test.ok 等于 false',
        desc: '退回「回到开发中」重做，失败步骤和报告作为 feedback 带回去；最多 3 轮',
        config: { target: 'dev_stage', max_rounds: '3' }, cases: [{ key: 'pass', label: '通过' }, { key: 'over', label: '超限' }],
      },
      { key: 'test_human_stage', name: '阶段改为需人工', kind: 'auto', ms: 200, after: ['test_gate'], branch: { of: 'test_gate', case: 'over' }, desc: '设置任务阶段：need_human' },
      { key: 'test_human_notify', name: '通知：测试修复超限', kind: 'auto', ms: 300, after: ['test_human_stage'], desc: '通知（IM 插件 im_notify）：平台通知「自动测试修复 3 轮仍没通过」' },
      { key: 'test_human', name: '人工处理', kind: 'review', ms: 300, after: ['test_human_notify'], desc: '看测试报告决定怎么办：改好代码后放行，或者终止这次执行' },
      { key: 'stage_accept', name: '阶段改为待验收', kind: 'auto', ms: 200, after: ['test_gate'], branch: { of: 'test_gate', case: 'pass' }, desc: '设置任务阶段：accepting' },
      {
        key: 'notify', name: '通知提出人与验收人员', kind: 'auto', ms: 500, after: ['stage_accept'],
        desc: '通知（IM 插件 im_notify）：平台通知，并在原消息串里回复提出人：测试环境地址、测试报告、看板、验收人员、变更说明、验收清单',
        run: (i) => {
          const t = i.task as Json, tst = i.test as Json, p = i.profile as Json
          return { ...i, notified: { app: 'sent', im: i.message_id ? 'sent' : 'skipped', title: `${str(t.ref)} 待验收`,
            text: `需求 ${str(t.ref)}「${str(t.title)}」开发完成，自动测试通过，请验收。\n测试环境：${str(tst.env_text)}\n测试报告：${str(tst.report_url)}\n看板：${str(t.url)}\n验收人员：${str(p.acceptors_text)}\n\n变更说明：\n${str(i.summary)}\n\n验收清单：\n${str(i.test_cases)}` } }
        },
      },
      {
        key: 'accept', name: '人工验收', kind: 'decide', ms: 300, after: ['notify'],
        desc: '在测试环境上验收。通过选「通过」；不通过先在任务里写一条进展说明问题，再按归属选「实现缺陷」（退回研发）或「需求偏差」（退回产品）',
        cases: [{ key: 'pass', label: '通过' }, { key: 'defect', label: '实现缺陷' }, { key: 'deviation', label: '需求偏差' }],
      },
      { key: 'stage_release', name: '阶段改为待发布', kind: 'auto', ms: 200, after: ['accept'], branch: { of: 'accept', case: 'pass' }, desc: '设置任务阶段：releasing；保留的测试环境随之回收' },
      { key: 'tell_release', name: '告诉提出人验收通过', kind: 'auto', ms: 300, after: ['stage_release'], desc: '通知：平台通知，回复原消息「验收通过，等发布」' },
      { key: 'done', name: '结束', kind: 'end', ms: 200, after: ['tell_release'], desc: '发布由发布 pipeline 接着做' },
      {
        key: 'back_dev', name: '阶段改回开发中', kind: 'auto', ms: 200, after: ['accept'], branch: { of: 'accept', case: 'defect' }, desc: '设置任务阶段：developing',
        run: (i) => ({ ...i, task: { ...(i.task as Json), stage: 'developing' } }),
      },
      {
        key: 'accept_gate', name: '验收不通过退回研发', kind: 'loopback', ms: 400, after: ['back_dev'], rule: 'task.stage 等于 developing',
        desc: '退回「回到开发中」重做，研发从任务进展里读验收意见；最多 3 轮',
        config: { target: 'dev_stage', max_rounds: '3' }, cases: [{ key: 'pass', label: '通过' }, { key: 'over', label: '超限' }],
      },
      { key: 'accept_human_stage', name: '阶段改为需人工', kind: 'auto', ms: 200, after: ['accept_gate'], branch: { of: 'accept_gate', case: 'over' }, desc: '设置任务阶段：need_human' },
      { key: 'accept_human_notify', name: '通知：验收退回超限', kind: 'auto', ms: 300, after: ['accept_human_stage'], desc: '通知：平台通知「验收退回 3 轮仍没通过」' },
      { key: 'accept_human', name: '人工处理', kind: 'review', ms: 300, after: ['accept_human_notify'], desc: '验收退回 3 轮仍不通过：看验收意见决定怎么办' },
      { key: 'back_design', name: '阶段改回设计中', kind: 'auto', ms: 200, after: ['accept'], branch: { of: 'accept', case: 'deviation' }, desc: '设置任务阶段：designing' },
      { key: 'tell_pm', name: '通知产品：需求偏差', kind: 'auto', ms: 300, after: ['back_design'], desc: '通知：平台通知产品，回复原消息「已退回产品重新设计」' },
      { key: 'to_design', name: '结束', kind: 'end', ms: 200, after: ['tell_pm'], desc: '产品改完 PRD 后重新走评审和研发' },
    ],
  },
  // 来消息确认派发（TSK-0411，SPEC-sop 节点表「执行任务」「更新任务」）：正式产品由 IM 插件写进 SOP 的内置流程 sop_im_task_confirm，默认停用。
  // 私信我、等我回复是 IM 插件的 im_ask_me（原型用 auto 模拟，输入 reply 当作我的回复）；单独用（触发方式改成 IM 消息）时先分类、建任务，
  // 接在消息分流建任务之后当子流程时输入带 task_id，跳过分类和建任务。同一条消息只建一次任务。
  {
    id: 'sop_im_task_confirm',
    name: '来消息确认派发',
    desc: 'IM 消息要建任务时先在原会话回执需求方「已创建任务 TSK-x，开始进行需求规划」，再私信我确认：回「执行」派 Claude Code 在任务继承的工作目录里开工、做完私信回报；回「分配 某人」改负责人；回「不做」取消任务；认不出再问一次、超时提醒一次，仍没有就不执行。默认停用：触发方式是「手动」',
    trigger: 'manual',
    fields: [
      { key: 'message_id', label: 'IM 消息', type: 'text', required: true, default: 'm1', placeholder: '消息 id；IM 触发时自动带上' },
      { key: 'task_id', label: '任务', type: 'text', placeholder: '已经建好的任务 id；留空时按消息判断要不要建' },
      { key: 'reply', label: '我的回复（原型模拟）', type: 'text', default: '执行', placeholder: '执行 / 分配 林原 / 不做 / 随便说点什么' },
    ],
    steps: [
      {
        key: 'read', name: '读取消息', kind: 'auto', ms: 300, after: [], desc: '读取消息（IM 插件 im_get_message）',
        run: (i) => {
          const m = seedMessages.find((x) => x.id === i.message_id) ?? seedMessages[0]
          return { ...i, message: { id: m.id, sender: m.sender_name, conversation: m.conversation || '私聊', text: m.text } }
        },
      },
      { key: 'given_id', name: '带了任务 id 吗', desc: '', kind: 'decide', ms: 200, after: ['read'], rule: 'task_id 不等于 ""', cases: [{ key: 'yes', label: '带了' }, { key: 'no', label: '没带' }] },
      {
        key: 'need', name: '要不要建任务', kind: 'classifier', ms: 800, after: ['given_id'], branch: { of: 'given_id', case: 'no' },
        desc: '要我或团队去做的事算要建任务；闲聊、通知、问进度、客套不算', config: { from: 'message.text' },
        cases: [{ key: 'task', label: '要建任务' }, { key: 'none', label: '不用' }],
        decide: (i) => (/午饭|收到|谢谢/.test(str((i.message as Json | undefined)?.text)) ? { route: 'none', reason: '模型判断属于「不用」' } : { route: 'task', reason: '模型判断属于「要建任务」' }),
        run: (i) => i,
      },
      { key: 'skip', name: '不用建任务', desc: '', kind: 'end', ms: 200, after: ['need'], branch: { of: 'need', case: 'none' } },
      {
        key: 'to_task', name: '建任务', kind: 'auto', ms: 500, after: ['need'], branch: { of: 'need', case: 'task' },
        desc: '转成任务（IM 插件 im_to_task）：这条消息已经被别的流程建过任务时取回那条，不再建',
        run: (i) => ({ ...i, task: { id: 'tsk_confirm1', ref: 'TSK-0102', title: str((i.message as Json | undefined)?.text).slice(0, 40) } }),
      },
      { key: 'use_id', name: '用带来的任务', desc: '', kind: 'auto', ms: 200, after: ['given_id'], branch: { of: 'given_id', case: 'yes' }, run: (i) => ({ ...i, task: { id: i.task_id, ref: 'TSK-0099', title: '带来的任务' } }) },
      { key: 'join', name: '任务', desc: '', kind: 'aggregate', ms: 200, after: ['use_id', 'to_task'], config: { mode: 'first' } },
      { key: 'info', name: '读任务', kind: 'task_update', ms: 300, after: ['join'], desc: '取任务的编号、标题、项目和继承后的工作目录，给私信摘要用', config: {} },
      {
        key: 'ack', name: '回执需求方', kind: 'auto', ms: 400, after: ['info'],
        desc: '回执需求方（IM 插件 im_ack_task，TSK-0467）：先在原消息所在的会话里回复需求方「已创建任务 TSK-x，开始进行需求规划」，再私信我；同一条消息只回一次（别的流程回过就不回）',
        run: (i) => ({ ...i, acked: { status: 'sent', task_ref: str((i.task as Json).ref), text: `已创建任务 ${str((i.task as Json).ref)}，开始进行需求规划` } }),
      },
      {
        key: 'ask', name: '私信我确认', kind: 'auto', ms: 1200, after: ['ack'],
        desc: '私信我确认（IM 插件 im_ask_me）：私信我任务摘要和「执行 / 分配 某人 / 不做」；认不出再问一次，超时提醒一次，仍没有就不执行',
        run: (i) => {
          const r = str(i.reply).trim()
          const m = /^(?:分配给?|交给|指派给?)\s*(.+)$/.exec(r)
          const choice = /^(执行|确认|好|开工)$/.test(r) ? 'execute' : m ? 'assign' : /^(不做|取消|算了)$/.test(r) ? 'cancel' : 'none'
          return { ...i, answer: { choice, assignee: m?.[1] ?? '', text: r, reason: choice === 'none' ? 'unknown' : '', reason_text: choice === 'none' ? '两次都没认出你的回复' : '' } }
        },
      },
      { key: 'is_exec', name: '回复执行？', desc: '', kind: 'decide', ms: 200, after: ['ask'], rule: 'answer.choice 等于 execute', cases: [{ key: 'yes', label: '执行' }, { key: 'no', label: '不是' }] },
      { key: 'run', name: '执行任务', desc: '', kind: 'task_run', ms: 3000, after: ['is_exec'], branch: { of: 'is_exec', case: 'yes' }, config: { task: '{{task.id}}', timeout: '2 小时', on_fail: 'continue' } },
      { key: 'run_ok', name: '执行成功？', desc: '', kind: 'decide', ms: 200, after: ['run'], rule: 'status 等于 done', cases: [{ key: 'yes', label: '成功' }, { key: 'no', label: '失败' }] },
      { key: 'tell_done', name: '回报结果', kind: 'auto', ms: 300, after: ['run_ok'], branch: { of: 'run_ok', case: 'yes' }, desc: '私信我（IM 插件 im_tell_me）：执行完了 + 结论摘要 + 任务链接' },
      { key: 'tell_fail', name: '回报失败', kind: 'auto', ms: 300, after: ['run_ok'], branch: { of: 'run_ok', case: 'no' }, desc: '私信我：没执行成功的原因 + 任务链接' },
      { key: 'is_assign', name: '回复分配？', desc: '', kind: 'decide', ms: 200, after: ['is_exec'], branch: { of: 'is_exec', case: 'no' }, rule: 'answer.choice 等于 assign', cases: [{ key: 'yes', label: '分配' }, { key: 'no', label: '不是' }] },
      { key: 'assign', name: '改负责人', desc: '', kind: 'task_update', ms: 300, after: ['is_assign'], branch: { of: 'is_assign', case: 'yes' }, config: { task: '{{task.id}}', assignee: '{{answer.assignee}}' } },
      { key: 'assigned', name: '分配上了？', desc: '', kind: 'decide', ms: 200, after: ['assign'], rule: 'task.assign_ok 等于 yes', cases: [{ key: 'yes', label: '分配上了' }, { key: 'no', label: '没找到人' }] },
      { key: 'tell_assigned', name: '回话：已分配', kind: 'auto', ms: 300, after: ['assigned'], branch: { of: 'assigned', case: 'yes' }, desc: '私信我：已把任务分配给某人' },
      { key: 'tell_noone', name: '回话：没找到人', kind: 'auto', ms: 300, after: ['assigned'], branch: { of: 'assigned', case: 'no' }, desc: '私信我：没找到「X」，任务留着没分配' },
      { key: 'is_cancel', name: '回复不做？', desc: '', kind: 'decide', ms: 200, after: ['is_assign'], branch: { of: 'is_assign', case: 'no' }, rule: 'answer.choice 等于 cancel', cases: [{ key: 'yes', label: '不做' }, { key: 'no', label: '没答复' }] },
      { key: 'cancel', name: '标为已取消', desc: '', kind: 'task_update', ms: 300, after: ['is_cancel'], branch: { of: 'is_cancel', case: 'yes' }, config: { task: '{{task.id}}', status: 'cancelled' } },
      { key: 'tell_cancel', name: '回话：已取消', kind: 'auto', ms: 300, after: ['cancel'], desc: '私信我：已取消' },
      { key: 'tell_idle', name: '回话：先不执行', kind: 'auto', ms: 300, after: ['is_cancel'], branch: { of: 'is_cancel', case: 'no' }, desc: '私信我：认不出或超时，先不执行，任务留在未开工' },
    ],
  },
  // FDE 反馈转发（TSK-0468，SPEC-sop-12.51）：正式产品由 IM 插件写进 SOP 的内置流程 sop_im_fde_forward，默认停用（IM 设置「FDE 反馈转发」打开后，
  // 我在消息页手动转任务、拆分任务时由 IM 插件发起；流程自动建的任务不发）。整理摘要、私信联系人是 IM 插件的 im_message_digest、im_send_contact，原型用 auto 模拟
  {
    id: 'sop_im_fde_forward',
    name: 'FDE 反馈转发',
    desc: '我在 IM 消息页手动把消息转成任务（转任务、拆分任务）后，私信 Robot.CyberBroleez 一条「FDE 反馈」+ 原始消息 + 任务编号和链接；同一条消息只发一次，拆分出几条任务汇成一条。默认停用：在 IM 消息页「渠道配置」里打开「FDE 反馈转发」才会自动发；收件人、开头文字在「私信 FDE 反馈收件人」这一步里改',
    trigger: 'manual',
    fields: [
      { key: 'message_id', label: 'IM 消息', type: 'text', required: true, default: 'm1', placeholder: '消息 id；手动转任务时自动带上' },
      { key: 'message_ids', label: '同组消息', type: 'text', placeholder: '拆分任务时会话带的一组消息 id，可空' },
      { key: 'task_ids', label: '任务', type: 'text', placeholder: '新建的任务 id，可空（空时取这条消息转成、拆出来的任务）' },
    ],
    steps: [
      {
        key: 'digest', name: '整理消息摘要', kind: 'auto', ms: 300, after: [],
        desc: '整理消息摘要（IM 插件 im_message_digest）：原始消息的发信人、会话、时间、原文、附件名，和新任务编号、链接；拆分出几条任务时都列上',
        run: (i) => {
          const m = seedMessages.find((x) => x.id === i.message_id) ?? seedMessages[0]
          return { ...i, digest: {
            messages_text: `发信人：${m.sender_name}\n会话：${m.conversation || '私聊'}（${m.channel}）\n时间：2026-11-05 10:30\n原文：${m.text}`,
            tasks_text: '任务：TSK-0103「' + m.text.slice(0, 20) + '」https://pmw.local/tasks/board?t=tsk_fde1',
          } }
        },
      },
      {
        key: 'send', name: '私信 FDE 反馈收件人', kind: 'auto', ms: 500, after: ['digest'],
        config: { contact: 'Robot.CyberBroleez', to: 'U0BQZG8LSTB', channel: 'slack', text: 'FDE 反馈\n{{digest.messages_text}}\n{{digest.tasks_text}}' },
        desc: '私信联系人（IM 插件 im_send_contact）：按联系人找到 Slack 身份 U0BQZG8LSTB 私信「FDE 反馈」+ 摘要；联系人没有这个身份时失败「联系人 Robot.CyberBroleez 没有 Slack 身份 U0BQZG8LSTB」，发送失败记运行异常，任务不受影响',
        run: (i) => ({ ...i, sent_to: { contact: 'Robot.CyberBroleez', to: 'U0BQZG8LSTB' } }),
      },
    ],
  },
]

// 新建和编辑的 SOP 也放进这张表，引擎和界面都从这里按 id 取。App 里另有一份 state 负责触发重渲染
export const sopById = (id: string) => SOPS.find((s) => s.id === id)!
export function upsertSop(sop: Sop) {
  const i = SOPS.findIndex((s) => s.id === sop.id)
  if (i >= 0) SOPS[i] = sop
  else SOPS.push(sop)
}
export const isManualDecide = (d: SopStepDef) => d.kind === 'decide' && !d.decide && !d.rule?.trim()

/** 用户新建的步骤没有写死的产出规则，原型里按类型给一个看得出是谁产出的占位结果 */
function mockRun(def: SopStepDef, input: Json): Json {
  return typeOf(def.kind).run?.(def.config ?? {}, input, def) ?? input
}

/* ---------- 执行引擎（纯函数，App 里一个定时器推着走） ---------- */

const logged = (s: RunStep, at: number, text: string): RunStep => ({ ...s, log: [...s.log, { at, text }] })
const setStep = (r: SopRun, i: number, f: (s: RunStep) => RunStep): SopRun => ({ ...r, steps: r.steps.map((s, j) => (j === i ? f(s) : s)) })

/** 输入：没有依赖用执行参数；只有一路依赖用它的输出；汇合时按步骤 key 分开放，免得字段互相覆盖 */
function inputFor(r: SopRun, sop: Sop, i: number): Json {
  const deps = depsOf(sop, i).map((k) => r.steps.findIndex((s) => s.key === k)).filter((j) => r.steps[j].status !== 'bypassed')
  if (!deps.length) return r.input
  if (deps.length === 1) return r.steps[deps[0]].output ?? {}
  return Object.fromEntries(deps.map((j) => [r.steps[j].key, r.steps[j].output ?? {}]))
}

/** 把依赖都走完的步骤放出来；没选中的分支标为未走。一轮放出的步骤可能让下一轮又能放，所以循环到不动为止 */
function advance(r: SopRun, now: number): SopRun {
  if (r.stopped) return r
  const sop = r.sop
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < r.steps.length; i += 1) {
      if (r.steps[i].status !== 'pending') continue
      const def = sop.steps[i]
      const deps = depsOf(sop, i).map((k) => r.steps.find((s) => s.key === k)!)
      if (!deps.every((d) => isFinished(d.status))) continue
      const branchOff = def.branch && r.steps.find((s) => s.key === def.branch!.of)?.route !== def.branch.case
      if (branchOff || (deps.length > 0 && deps.every((d) => d.status === 'bypassed'))) {
        r = setStep(r, i, (s) => logged({ ...s, status: 'bypassed' }, now, '所在分支未被选中，不执行'))
      } else {
        const input = inputFor(r, sop, i)
        r = setStep(r, i, (s) => (r.step_through
          ? logged({ ...s, status: 'paused', input, output: undefined, error: undefined }, now, '执行前暂停，等待确认输入')
          : logged({ ...s, status: 'running', input, output: undefined, error: undefined, started_at: now, attempts: s.attempts + 1 }, now, '开始执行')))
      }
      changed = true
    }
  }
  if (!r.ended_at && r.steps.every((s) => isFinished(s.status))) r = { ...r, ended_at: now }
  return r
}

export function startRun(sop: Sop, input: Json, stepThrough: boolean, now = Date.now(), o: RunOrigin = {}): SopRun {
  const run: SopRun = {
    ...(o.objectId ? { object_id: o.objectId } : {}),
    ...(o.source ? { source: o.source, source_ref: o.sourceRef, source_name: o.sourceName } : {}),
    id: `run_${now.toString(36)}${rid()}`,
    sop_id: sop.id,
    sop,
    title: `${sop.name} · ${str(Object.values(input)[0]).split(/[\n|]/)[0].trim().slice(0, 16)}`,
    step_through: stepThrough, stopped: false, started_at: now, input,
    steps: sop.steps.map((d) => ({ key: d.key, status: 'pending', attempts: 0, log: [] })),
  }
  return advance(run, now)
}

/** 到点的执行中步骤出结果，几路并行的各自结算 */
export function tick(r: SopRun, now = Date.now()): SopRun {
  if (r.stopped) return r
  const sop = r.sop
  let moved = false
  r.steps.forEach((s, i) => {
    // 排队等模型的不往前走（SOP-07）
    if (s.status !== 'running' || s.queue) return
    const def = sop.steps[i]
    if (now - (s.started_at ?? now) < def.ms) return
    moved = true
    const err = def.fail?.(s.input ?? {}) ?? typeOf(def.kind).fail?.(def.config ?? {}, s.input ?? {})
    if (err) { r = setStep(r, i, (x) => logged({ ...x, status: 'failed', error: err, ended_at: now }, now, `失败：${err}`)); return }
    const output = def.run ? def.run(s.input ?? {}) : mockRun(def, s.input ?? {})
    if (def.kind === 'loopback') { r = loopback(r, i, now); return }
    if (def.kind === 'claude_code') {
      const out = output as Json
      const v = (out.result as Json | undefined)?.verdict
      r = setStep(r, i, (x) => logged({ ...x, status: 'done', output, ended_at: now, claude: { run_id: String(out.run_id), task_id: render(def.config?.task ?? '', x.input ?? {}) || undefined, workdir: render(def.config?.workdir ?? '', x.input ?? {}) } },
        now, v ? `Claude Code 跑完了，回报结论 ${v}` : 'Claude Code 跑完了，没有回报结构化结论'))
      return
    }
    if (isBranching(def.kind) && !isManualDecide(def)) {
      const t = typeOf(def.kind)
      const { route, reason } = def.decide ? def.decide(s.input ?? {})
        : t.route ? t.route(def.config ?? {}, s.input ?? {}, def)
          : { route: def.cases?.[0]?.key ?? '', reason: `按规则「${def.rule}」判断（原型模拟）` }
      const label = def.cases?.find((c) => c.key === route)?.label ?? route
      r = setStep(r, i, (x) => logged({ ...x, status: 'done', output, route, route_reason: reason, ended_at: now }, now, `判断结果：走「${label}」，${reason}`))
    } else if (def.kind === 'decide') {
      r = setStep(r, i, (x) => logged({ ...x, status: 'review', output }, now, '等待人工判断走哪个分支'))
    } else if (def.kind === 'review') {
      r = setStep(r, i, (x) => logged({ ...x, status: 'review', output }, now, '已就绪，等待人工检查'))
    } else {
      r = setStep(r, i, (x) => logged({ ...x, status: 'done', output, ended_at: now }, now, `完成，用时 ${((now - (x.started_at ?? now)) / 1000).toFixed(1)}s`))
    }
  })
  return moved ? advance(r, now) : r
}

/** 第 j 步的所有下游（依赖它、或挂在它的分支上，层层往下），不含自己 */
export function downstreamOf(sop: Sop, j: number): number[] {
  const inSet = new Set([j])
  for (let changed = true; changed;) {
    changed = false
    sop.steps.forEach((d, k) => {
      if (inSet.has(k)) return
      const hit = depsOf(sop, k).some((x) => inSet.has(sop.steps.findIndex((y) => y.key === x))) || (!!d.branch && inSet.has(sop.steps.findIndex((y) => y.key === d.branch!.of)))
      if (hit) { inSet.add(k); changed = true }
    })
  }
  inSet.delete(j)
  return [...inSet].sort((a, b) => a - b)
}

/** 第 i 步沿依赖往上的所有步骤 */
export function upstreamOf(sop: Sop, i: number): number[] {
  const out = new Set<number>()
  const walk = (k: number) => depsOf(sop, k).forEach((x) => { const j = sop.steps.findIndex((y) => y.key === x); if (j >= 0 && !out.has(j)) { out.add(j); walk(j) } })
  walk(i)
  return [...out].sort((a, b) => a - b)
}

/** 条件回退（AUTO-02），同后端 loopback.go：条件成立且没超限就退回目标重做（带 feedback），超限走「超限」，不成立走「通过」 */
function loopback(r: SopRun, i: number, now: number): SopRun {
  const def = r.sop.steps[i]
  const s = r.steps[i]
  const input = s.input ?? {}
  const rule = def.rule?.trim() ?? ''
  const ok = evalRule(rule, input)
  const fail = (err: string) => setStep(r, i, (x) => logged({ ...x, status: 'failed', error: err, ended_at: now }, now, `失败：${err}`))
  if (ok === null) return fail(rule ? `规则「${rule}」写法不对，要写成「字段 等于 值」或「字段 包含 值」` : '还没填回退条件')
  const label = (k: string) => def.cases?.find((c) => c.key === k)?.label ?? k
  if (!ok) return setStep(r, i, (x) => logged({ ...x, status: 'done', output: input, route: 'pass', route_reason: `条件「${rule}」不成立`, ended_at: now }, now, `判断结果：走「${label('pass')}」，条件「${rule}」不成立`))
  const max = loopRounds(def.config?.max_rounds) ?? 3
  const j = r.sop.steps.findIndex((x) => x.key === def.config?.target)
  if (j < 0 || !upstreamOf(r.sop, i).includes(j)) return fail(`退回的步骤 ${def.config?.target ?? ''} 不是这一步的上游`)
  const loops = s.loops ?? 0
  if (loops >= max) {
    const why = `已经自动退回 ${loops} 轮，条件「${rule}」成立，超过上限`
    if (!r.sop.steps.some((x) => x.branch?.of === def.key && x.branch.case === 'over')) return fail(`${why}；没有步骤接在「超限」出口上`)
    return setStep(r, i, (x) => logged({ ...x, status: 'done', output: input, route: 'over', route_reason: why, ended_at: now }, now, `判断结果：走「${label('over')}」，${why}`))
  }
  const round = loops + 2
  const tname = r.sop.steps[j].name
  const reason = `「${def.name}」条件「${rule}」成立`
  const { feedback: _old, ...rest } = input
  const feedback = { ...rest, round, reason, from: def.key }
  let next = setStep(r, i, (x) => logged({ ...x, loops: loops + 1 }, now, `条件「${rule}」成立，退回「${tname}」重做（第 ${round} 轮，最多退回 ${max} 轮）`))
  for (const k of downstreamOf(r.sop, j)) {
    next = setStep(next, k, (x) => {
      const reset = x.status !== 'pending' || k === i
      const y: RunStep = reset ? { ...x, status: 'pending', output: undefined, ended_at: undefined, edited: undefined, route: undefined, route_reason: undefined, error: undefined, claude: undefined } : x
      return { ...(reset && k !== i ? logged(y, now, `上游「${tname}」被退回重做，这一步重新等待`) : y), round, rework_reason: undefined }
    })
  }
  const tinput = { ...inputFor(next, r.sop, j), feedback }
  return setStep(next, j, (x) => logged({
    ...x, input: tinput, output: undefined, ended_at: undefined, edited: undefined, route: undefined, route_reason: undefined, error: undefined, claude: undefined,
    round, rework_reason: reason, ...(next.step_through ? { status: 'paused' as const } : { status: 'running' as const, started_at: now, attempts: x.attempts + 1 }),
  }, now, `第 ${round} 轮：被${reason}退回重做`))
}

export type RunAction =
  | { kind: 'confirm-input'; step: number; input?: Json }
  | { kind: 'approve'; step: number; output?: Json }
  | { kind: 'route'; step: number; route: string }
  | { kind: 'rework'; step: number }
  | { kind: 'retry'; step: number }
  | { kind: 'skip'; step: number }
  | { kind: 'stop' }
  | { kind: 'step-through'; on: boolean }

/* ---------- 失败执行批量重跑（SPEC-sop-4.13~4.19） ---------- */

/** retry 在原执行里重试失败的步骤（沿用快照）；relaunch 用原输入、流程现在的定义新起一条（原执行标「已重跑」） */
export type RerunAction = 'retry' | 'relaunch'
export type RerunResult = {
  done: { run_id: string; new_run_id?: string }[]
  skipped: { run_id: string; reason: string; new_run_id?: string }[]
  failed: { run_id: string; error: string }[]
}
/** 一次最多重跑几条（同正式产品，和批量发起同一个上限） */
export const RERUN_MAX = 200
export const RERUN_SOURCE_NAME = '批量重跑'
/** 已重跑过的再重跑、重试时跳过的原因（SPEC-sop-4.22） */
export const RERUN_REASON_RELAUNCHED = '已重跑过'

/** 发起后流程又改过：快照的步骤、字段和流程现在的不一样；流程删了不算（正式产品比 flow_version） */
export function flowChanged(r: SopRun): boolean {
  const cur = SOPS.find((s) => s.id === r.sop_id)
  return !!cur && JSON.stringify([cur.steps, cur.fields]) !== JSON.stringify([r.sop.steps, r.sop.fields])
}

/**
 * 批量重跑：不是失败的、重复的、已重跑过的跳过并给原因；relaunch 来源记手动、source_ref 记原执行、source_name 记「批量重跑」，逐步确认、关联对象照原执行，
 * 原执行记上 relaunched_to（「已重跑」，移出失败）。同一条失败执行只重跑一次（SPEC-sop-4.21、4.22）。
 * 原型没有子执行，正式产品里子执行换成它的顶层执行、同一条只发起一次（SPEC-sop-4.17）
 */
export function rerunRuns(runs: SopRun[], ids: string[], action: RerunAction, now = Date.now()): { runs: SopRun[]; result: RerunResult } {
  const result: RerunResult = { done: [], skipped: [], failed: [] }
  const byId = new Map(runs.map((r) => [r.id, r]))
  const fresh: SopRun[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const r = byId.get(id)
    if (seen.has(id)) { result.skipped.push({ run_id: id, reason: '重复或为空' }); continue }
    seen.add(id)
    if (!r) { result.skipped.push({ run_id: id, reason: '执行不存在' }); continue }
    const st = runStatus(r)
    if (st !== 'failed') { result.skipped.push({ run_id: id, reason: `不是失败状态（${RUN_STATUS[st].label}）` }); continue }
    if (r.relaunched_to) { result.skipped.push({ run_id: id, reason: RERUN_REASON_RELAUNCHED, new_run_id: r.relaunched_to }); continue }
    if (action === 'retry') {
      let x = r
      r.steps.forEach((s, i) => { if (s.status === 'failed') x = act(x, { kind: 'retry', step: i }, now) })
      byId.set(id, x)
      result.done.push({ run_id: id })
      continue
    }
    const sop = SOPS.find((s) => s.id === r.sop_id)
    if (!sop) { result.failed.push({ run_id: id, error: `流程「${r.sop.name}」已删除` }); continue }
    const input = { ...Object.fromEntries(sop.fields.map((f) => [f.key, f.default ?? ''])), ...r.input }
    const miss = sop.fields.filter((f) => f.required && !str(input[f.key]).trim())
    if (miss.length) { result.failed.push({ run_id: id, error: `${miss.map((f) => `「${f.label}」`).join('、')}必填` }); continue }
    const n = startRun(sop, input, r.step_through, now + fresh.length, { objectId: r.object_id, source: 'manual', sourceRef: r.id, sourceName: RERUN_SOURCE_NAME })
    fresh.push(n)
    byId.set(id, { ...r, relaunched_to: n.id })
    result.done.push({ run_id: id, new_run_id: n.id })
  }
  return { runs: [...fresh, ...runs.map((r) => byId.get(r.id) ?? r)], result }
}

export function act(r: SopRun, a: RunAction, now = Date.now()): SopRun {
  const sop = r.sop
  switch (a.kind) {
    case 'stop':
      return { ...r, stopped: true, ended_at: now, steps: r.steps.map((s) => (['running', 'paused', 'review'].includes(s.status) ? logged({ ...s, status: 'pending' }, now, '执行被终止') : s)) }
    case 'step-through':
      return { ...r, step_through: a.on }
    case 'confirm-input':
      return setStep(r, a.step, (s) => {
        // 超出上限暂停的（AUTO-12）：放行这一次尝试，之后照常按上限拦
        const hold = s.hold && !s.hold.released ? { ...s.hold, released: true, attempt: s.attempts + 1 } : s.hold
        const next = logged({
          ...s, status: 'running', started_at: now, attempts: s.attempts + 1, hold,
          ...(a.input ? { input: a.input, edited: 'input' as const } : {}),
        }, now, a.input ? '输入已修改，开始执行' : '输入已确认，开始执行')
        return hold !== s.hold ? logged(next, now, '已放行：这一次不按上限拦，继续执行') : next
      })
    case 'approve':
      return advance(setStep(r, a.step, (s) => logged({
        ...s, status: 'done', ended_at: now,
        ...(a.output ? { output: a.output, edited: 'output' as const } : {}),
      }, now, a.output ? '输出已修改并放行' : '检查通过')), now)
    case 'route': {
      const label = sop.steps[a.step].cases?.find((c) => c.key === a.route)?.label ?? a.route
      return advance(setStep(r, a.step, (s) => logged({ ...s, status: 'done', route: a.route, route_reason: '人工判断', edited: 'route', ended_at: now }, now, `人工判断：走「${label}」`)), now)
    }
    case 'rework': {
      // 退回：这一步回到未开始，它依赖的上游（走到了的那几路）重新执行，跑完后再回到这一步
      const deps = depsOf(sop, a.step).map((k) => r.steps.findIndex((s) => s.key === k)).filter((j) => r.steps[j].status !== 'bypassed')
      let next = setStep(r, a.step, (s) => logged({ ...s, status: 'pending', output: undefined }, now, '退回上游重做'))
      for (const j of deps) next = setStep(next, j, (s) => logged({ ...s, status: 'running', output: undefined, started_at: now, attempts: s.attempts + 1, edited: undefined }, now, '被下游退回，重新执行'))
      return next
    }
    case 'retry':
      return setStep(r, a.step, (s) => logged({ ...s, status: 'running', error: undefined, started_at: now, attempts: s.attempts + 1 }, now, `第 ${s.attempts + 1} 次尝试`))
    case 'skip':
      return advance(setStep(r, a.step, (s) => logged({ ...s, status: 'skipped', output: s.input, error: undefined, ended_at: now }, now, '已跳过，输入原样传给下游')), now)
  }
}

/* ---------- 演示数据：用真引擎跑出来，输入输出和实际执行一致 ---------- */

function simulate(sop: Sop, input: Json, startedMinsAgo: number, until: (r: SopRun) => boolean, routes: Record<string, string> = {}): SopRun {
  let t = Date.now() - startedMinsAgo * 60000
  let r = startRun(sop, input, false, t)
  for (let guard = 0; guard < 80 && !until(r); guard += 1) {
    const running = r.steps.map((s, i) => [s, i] as const).filter(([s]) => s.status === 'running')
    if (running.length) {
      // 跳到最早结束的那一路
      t = Math.min(...running.map(([s, i]) => (s.started_at ?? t) + sop.steps[i].ms))
      r = tick(r, t)
      continue
    }
    const i = r.steps.findIndex((s) => s.status === 'review' || s.status === 'paused')
    if (i < 0) break
    const s = r.steps[i]
    t += 40000
    if (s.status === 'paused') r = act(r, { kind: 'confirm-input', step: i }, t)
    else if (isBranching(sop.steps[i].kind)) r = act(r, { kind: 'route', step: i, route: routes[s.key] ?? sop.steps[i].cases![0].key }, t)
    else r = act(r, { kind: 'approve', step: i }, t)
  }
  return r
}

const defaults = (sop: Sop): Json => Object.fromEntries(sop.fields.map((f) => [f.key, f.default ?? '']))
const stepIs = (key: string, st: StepStatus) => (r: SopRun) => r.steps.find((s) => s.key === key)?.status === st

export const seedRuns: SopRun[] = (() => {
  const [fb, mt, ct] = SOPS
  const tr = SOPS.find((x) => x.id === 'sop_triage')!
  return [
    // 刚开始的周会纪要，正在三路并行
    { ...simulate(mt, { ...defaults(mt), meeting: '权限 PRD 评审会 10/29' }, 0.03, stepIs('summarize', 'running')), source: 'manual' as const },
    // 功能需求分支，停在「确认诉求清单」等人检查
    { ...simulate(fb, defaults(fb), 12, stepIs('confirm', 'review')), source: 'im' as const, source_ref: 'm1' },
    // 联系人建档，查到疑似重复，等人判断新建还是合并
    { ...simulate(ct, defaults(ct), 30, stepIs('match', 'review')), source: 'manual' as const },
    // 缺陷分支，走微信回复，发送失败
    simulate(fb, { ...defaults(fb), customer: '许知行', channel: 'wechat', message: '审批页面一提交就报错，详情也打不开。' }, 95, (r) => runStatus(r) === 'failed'),
    { ...simulate(mt, defaults(mt), 60 * 26, (r) => runStatus(r) === 'done'), source: 'schedule' as const, source_ref: 'sc_meeting', source_name: '周会纪要' },
    simulate(ct, { raw: '何嘉宁 | 商务拓展总监\n远舟科技\n手机 138 0013 7788\n邮箱 jianing.he@yuanzhou.tech' }, 60 * 50, (r) => runStatus(r) === 'done', { match: 'new' }),
    // 关联到任务 T-015（SOP-06）：Agent 处理任务时发起的，停在「确认诉求清单」；在任务上手动发起、已经跑完的周会纪要
    { ...simulate(fb, { ...defaults(fb), customer: '许知行', message: '导出改成分批写文件，修掉 300 秒超时\n\n大租户导出审计日志很慢，能不能分批导出，再给个进度提示？' }, 40, stepIs('confirm', 'review')), object_id: 'tk_dev1', source: 'agent' as const, source_ref: 'ag_triage', source_name: '消息分诊助手' },
    { ...simulate(mt, { ...defaults(mt), meeting: '导出超时复盘 10/30' }, 60 * 20, (r) => runStatus(r) === 'done'), object_id: 'tk_dev1', source: 'manual' as const },
    // 消息分诊（SPEC-messages-2.41）：第一条消息分诊过两次（最近一次要处理、写了建议），@所有人 那条判为忽略
    { ...simulate(tr, { message_id: seedMessages[0].id }, 5, (r) => runStatus(r) === 'done'), source: 'manual' as const, source_name: '批量发起' },
    { ...simulate(tr, { message_id: seedMessages[0].id }, 2, (r) => runStatus(r) === 'done'), source: 'manual' as const, source_name: '批量发起' },
    { ...simulate(tr, { message_id: seedMessages[2].id }, 20, (r) => runStatus(r) === 'done'), source: 'manual' as const, source_name: '批量发起' },
    // 研发 pipeline 关联到任务 T-016（AUTO-12）：评审退回过两轮后，研发这一步超出「每个需求最多跑 Claude Code 的次数」，暂停等你放行
    heldDev(),
  ].map((r, n) => ({ ...r, id: `run_seed${n}` }))
})()

/** 演示数据：研发 pipeline 跑到「研发」那一步时超出次数上限暂停（SPEC-sop-15） */
function heldDev(): SopRun {
  const dp = SOPS.find((x) => x.id === 'sop_im_dev_pipeline')!
  const r = simulate(dp, { ...defaults(dp), task_id: 'tk_dev2' }, 90, (x) => stepIs('dev', 'running')(x) && stepIs('cases_note', 'done')(x) && stepIs('autotest_note', 'done')(x))
  const i = r.steps.findIndex((s) => s.key === 'dev')
  const now = r.steps[i].started_at ?? Date.now()
  const hold = { kind: 'runs' as const, reason: '需求 T-016 已经跑了 30 次 Claude Code，到了上限 30 次', since: now }
  const steps = r.steps.map((s, j) => (j === i ? logged({ ...s, status: 'paused' as const, hold, attempts: 0, round: 3, rework_reason: '「评审不通过就退回」条件「result.verdict 等于 reject」成立' }, now,
    `超出上限，暂停：${hold.reason}。点「继续」放行这一次，或到 SOP 设置里调高上限`) : s))
  return { ...r, object_id: 'tk_dev2', source: 'manual' as const, steps }
}
