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
import { NODE_TYPES, isBranching, typeOf, type Cfg, type StepKind } from './nodetypes'

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
  /** 在排队等模型名额（SOP-07）：状态仍是 running，ahead 是全局队列里前面还有几个 */
  queue?: { ahead: number }
  /** 占着一个调模型的名额（原型自己用；正式产品在后端内存里） */
  gated?: boolean
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
export const isQueued = (s: RunStep) => s.status === 'running' && !!s.queue
export const stepLook = (s: RunStep) => (isQueued(s) ? QUEUED_LOOK : STEP_STATUS[s.status])

/* ---------- 调模型的并发上限（SOP-07） ---------- */

/** 要调模型的节点：AI 处理、参数提取、问题分类、迭代、调用 Agent；知识检索只做关键词检索，不算 */
export const MODEL_KINDS = ['ai', 'extract', 'classifier', 'iterate', 'agent']
export const isModelKind = (kind: string) => MODEL_KINDS.includes(kind)
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
    trigger: 'weekly',
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
      return setStep(r, a.step, (s) => logged({
        ...s, status: 'running', started_at: now, attempts: s.attempts + 1,
        ...(a.input ? { input: a.input, edited: 'input' as const } : {}),
      }, now, a.input ? '输入已修改，开始执行' : '输入已确认，开始执行'))
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
  ].map((r, n) => ({ ...r, id: `run_seed${n}` }))
})()
