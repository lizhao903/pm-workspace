import type { ReactNode } from 'react'
import { seedAgents } from './agentdata'
import { seedModels, seedProviders } from './modeldata'
import { CONTENT_CATEGORIES, seedContent } from './data'
import { seedProjects } from './projectdata'

// SOP 节点类型表：画布、节点选择器、属性面板、执行引擎都从这里取。加一种节点 = 在 NODE_TYPES 里加一项
// 这个文件不从 sopflow 取值（只取类型），sopflow 反过来依赖它，互相取值会在加载时拿到未初始化的东西
//   fields   属性面板里的配置项，存在步骤的 config 里
//   run      模拟执行：拿配置和输入算输出；模板转换、变量聚合、知识检索、分类器、结束是真算的，其余返回占位结果
//   branching 有分支出口（条件分支、问题分类器）
//   summary  画布节点上显示的一行配置摘要

/** 默认服务商：第一个启用的（原型的服务商没有「默认」标记） */
const defaultProvider = () => seedProviders.find((p) => p.enabled)

export type StepKind =
  | 'auto' | 'ai' | 'review' | 'decide'
  | 'knowledge' | 'extract' | 'template' | 'aggregate' | 'code'
  | 'classifier' | 'iterate' | 'wait'
  | 'http' | 'notify' | 'task' | 'local_append' | 'agent' | 'subflow'
  | 'end'

type Json = Record<string, unknown>
export type Cfg = Record<string, string>

export interface FieldCtx { sops: { id: string; name: string }[] }
export interface ConfigField {
  key: string
  label: string
  type: 'text' | 'textarea' | 'code' | 'select' | 'number' | 'multi'
  /** cfg 是节点当前的配置：AI 节点的模型跟着选的服务商走 */
  options?: (ctx: FieldCtx, cfg: Cfg) => { value: string; label: string }[]
  /** 改了这一项要一起清空的配置项（换服务商清掉模型） */
  clears?: string[]
  placeholder?: string
  hint?: string
  required?: boolean
  default?: string
  /** 按当前配置不显示（选了 Agent 的 AI 节点不显示服务商和模型） */
  hidden?: (cfg: Cfg) => boolean
}

/** 调模型的节点（ai、extract、classifier、iterate）可以选一个 Agent：用它的模型、思考档位和指令（指令拼在节点提示前）；
 * 选了以后服务商、模型不显示、执行时也不看。不选按「设置 / Agent」里「其他后台调用」的默认 Agent，那里也没选用默认服务商。
 * 节点上不单独配思考，思考只在 Agent 上配 */
const agentField: ConfigField = {
  key: 'agent', label: 'Agent', type: 'select', default: '', hint: '用它的模型、思考和指令；要不要思考到 设置 → Agent 里改',
  options: () => [{ value: '', label: '不选（用场景默认）' }, ...seedAgents.map((a) => ({ value: a.id, label: a.name }))],
}
const withAgent = (c: Cfg) => !!c.agent
const agentName = (c: Cfg) => seedAgents.find((a) => a.id === c.agent)?.name ?? (c.agent ? '已删除的 Agent' : '')

interface NodeLike { name: string; config?: Cfg; cases?: { key: string; label: string }[] }

export interface NodeType {
  kind: StepKind
  label: string
  group: string
  desc: string
  color: string
  icon: ReactNode
  ms: number
  /** 说明框的标题；不给就是「说明」 */
  descLabel?: string
  fields?: ConfigField[]
  branching?: boolean
  defaultCases?: { key: string; label: string }[]
  run?: (cfg: Cfg, input: Json, node: NodeLike) => Json
  fail?: (cfg: Cfg, input: Json) => string | null
  /** 分支节点按规则自动选分支 */
  route?: (cfg: Cfg, input: Json, node: NodeLike) => { route: string; reason: string }
  summary?: (cfg: Cfg) => string
}

/* ---------- 工具 ---------- */

export function getPath(obj: unknown, path: string): unknown {
  return path.trim().replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj)
}
const txt = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
/** {{字段}} 换成输入里的值，取不到的留空 */
export const render = (tpl: string, input: Json) => tpl.replace(/\{\{\s*([\w.[\]一-龥]+)\s*\}\}/g, (_, p: string) => txt(getPath(input, p)))
/** 输入里最像正文的那段文字：先看指定字段，再找最长的字符串 */
const mainText = (input: Json, field?: string) => {
  if (field?.trim()) return txt(getPath(input, field))
  const strs: string[] = []
  const walk = (v: unknown) => { if (typeof v === 'string') strs.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk) }
  walk(input)
  return strs.sort((a, b) => b.length - a.length)[0] ?? ''
}
const list = (s?: string) => (s ?? '').split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean)
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

const P = (d: string) => <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
/** 项目下拉：选项是项目名，也可以取输入里的字段 */
const projectOptions = () => [{ value: '{{project}}', label: '取输入里的 project' }, ...seedProjects.map((p) => ({ value: p.name, label: p.name }))]
/** 按 id 或名字认项目，同后端（后端还认编号） */
const findProject = (key: string) => seedProjects.find((p) => p.id === key || p.name === key)
/** 本机日期 YYYY-MM-DD，写进项目目录的 {{date}} */
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const CHANNELS = [{ value: 'lark', label: '飞书' }, { value: 'slack', label: 'Slack' }, { value: 'wechat', label: '微信' }, { value: 'telegram', label: 'Telegram' }, { value: 'email', label: '邮件' }]

/* ---------- 节点表 ---------- */

export const NODE_TYPES: NodeType[] = [
  {
    kind: 'auto', label: '自动执行', group: '基础', desc: '调接口、写数据、发消息这类不需要判断的动作', color: '#3d4fd6', ms: 900, descLabel: '做什么',
    icon: <path d="M9 2 4 9h3.5L7 14l5-7H8.5Z" fill="currentColor" />,
    run: (_c, input, n) => ({ ...input, [`${n.name}_done`]: true }),
  },
  {
    kind: 'ai', label: 'AI 处理', group: '基础', desc: '生成、提炼、起草、改写', color: '#7a4fd6', ms: 1800, descLabel: '给 AI 的要求',
    icon: <path d="M8 2.5 9.3 6.7 13.5 8 9.3 9.3 8 13.5 6.7 9.3 2.5 8 6.7 6.7Z" fill="currentColor" />,
    fields: [
      agentField,
      // 服务商和模型都从 设置 → 模型服务商 来（原型用种子数据）；换服务商清掉模型。选了 Agent 不显示
      { key: 'provider', label: '服务商', type: 'select', default: '', clears: ['model'], hidden: withAgent, options: () => [{ value: '', label: `跟随默认（${defaultProvider()?.name ?? '还没有可用的服务商'}）` }, ...seedProviders.filter((p) => p.enabled).map((p) => ({ value: p.id, label: p.name }))] },
      {
        key: 'model', label: '模型', type: 'select', default: '', hint: '没列出来的到 设置 → 模型服务商 启用', hidden: withAgent,
        options: (_, c) => [{ value: '', label: '服务商设置的模型' }, ...seedModels.filter((m) => m.enabled && m.provider_id === (c.provider || defaultProvider()?.id)).map((m) => ({ value: m.id, label: m.name }))],
      },
      { key: 'output', label: '输出字段名', type: 'text', placeholder: 'result', default: 'result' },
    ],
    run: (c, input, n) => ({ ...input, [c.output || 'result']: `「${n.name}」的生成结果（原型模拟）` }),
    summary: (c) => (c.agent ? agentName(c) : [seedProviders.find((p) => p.id === c.provider)?.name ?? '', seedModels.find((m) => m.id === c.model)?.name ?? c.model ?? ''].filter(Boolean).join(' · ')),
  },
  {
    kind: 'knowledge', label: '知识检索', group: '知识与数据', desc: '在文档库里按问题找相关段落', color: '#2f7d43', ms: 1000,
    icon: <>{P('M3 3.5h4.5v9H3zM8.5 3.5H13v9H8.5')}</>,
    fields: [
      { key: 'query', label: '检索问题', type: 'textarea', required: true, placeholder: '可以引用输入字段，比如 {{customer}} 的历史需求', hint: '支持 {{字段}}' },
      { key: 'scope', label: '检索范围', type: 'multi', options: () => CONTENT_CATEGORIES.map((c) => ({ value: c.key, label: c.label })), hint: '不选就是全部内容' },
      { key: 'top_k', label: '最多返回', type: 'number', default: '3' },
    ],
    run: (c, input) => {
      const q = render(c.query ?? '', input)
      const words = q.split(/[\s，。,.？?、：:]+/).filter((w) => w.length >= 2)
      const scope = list(c.scope)
      const hits = seedContent
        .filter((it) => !scope.length || scope.includes(it.category))
        .map((it) => ({ it, score: words.filter((w) => `${it.title}${it.body}${it.tags.join('')}`.includes(w)).length }))
        .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, Number(c.top_k) || 3)
      return { ...input, query: q, matches: hits.map(({ it, score }) => ({ title: it.title, score, snippet: it.body.replace(/[#>*`-]/g, '').replace(/\s+/g, ' ').slice(0, 60) })) }
    },
    summary: (c) => (c.query ? `问：${c.query}` : ''),
  },
  {
    kind: 'extract', label: '参数提取', group: '知识与数据', desc: '从一段文字里抽出指定字段', color: '#0c8599', ms: 1200,
    icon: <>{P('M3 4h10M3 8h6M3 12h8')}<circle cx="12.5" cy="8" r="1.5" fill="currentColor" /></>,
    fields: [
      { key: 'fields', label: '要提取的字段', type: 'text', required: true, placeholder: '客户名, 金额, 日期', hint: '逗号隔开' },
      { key: 'from', label: '从哪个字段里提', type: 'text', placeholder: '留空自动找最长的那段文字' },
      agentField,
    ],
    run: (c, input) => {
      const t = mainText(input, c.from)
      const guess = (f: string) => {
        if (/金额|价格|费用|钱/.test(f)) return /(\d+(?:\.\d+)?)\s*(元|万|块)/.exec(t)?.[0] ?? ''
        if (/日期|时间|截止/.test(f)) return /(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}月\d{1,2}日|周[一二三四五六日])/.exec(t)?.[0] ?? ''
        if (/电话|手机/.test(f)) return /1\d{2}[\s-]?\d{4}[\s-]?\d{4}/.exec(t)?.[0] ?? ''
        if (/邮箱/.test(f)) return /[\w.]+@[\w.]+/.exec(t)?.[0] ?? ''
        return '（原型模拟：由模型提取）'
      }
      return { ...input, extracted: Object.fromEntries(list(c.fields).map((f) => [f, guess(f)])) }
    },
    summary: (c) => (c.fields ? `提取：${c.fields}` : ''),
  },
  {
    kind: 'template', label: '模板转换', group: '知识与数据', desc: '用 {{字段}} 把输入拼成一段固定格式的文字', color: '#0c8599', ms: 300,
    icon: <>{P('M5 3.5 2.5 8 5 12.5M11 3.5 13.5 8 11 12.5M9 3 7 13')}</>,
    fields: [
      { key: 'template', label: '模板', type: 'code', required: true, placeholder: '{{customer}} 你好，你反馈的「{{demands[0].title}}」已经记录。' },
      { key: 'output', label: '输出字段名', type: 'text', default: 'text' },
    ],
    run: (c, input) => ({ ...input, [c.output || 'text']: render(c.template ?? '', input) }),
    summary: (c) => c.template ?? '',
  },
  {
    kind: 'aggregate', label: '变量聚合', group: '知识与数据', desc: '把几路上游（并行或分支）的输出合成一份', color: '#0c8599', ms: 200,
    icon: <>{P('M3 3.5 8 8 3 12.5M8 8h5')}</>,
    fields: [{ key: 'mode', label: '合并方式', type: 'select', default: 'merge', options: () => [{ value: 'merge', label: '字段合并（后面的覆盖前面的）' }, { value: 'group', label: '按上游分组保留' }, { value: 'first', label: '取第一个有值的' }] }],
    run: (c, input) => {
      // 汇合节点的输入是 { 上游 key: 输出 }，只有一路时就是那一路的输出
      const parts = Object.values(input).every(isObj) ? Object.values(input) as Json[] : [input]
      if (c.mode === 'group') return input
      if (c.mode === 'first') return parts.find((p) => Object.keys(p).length) ?? {}
      return Object.assign({}, ...parts)
    },
    summary: (c) => ({ merge: '字段合并', group: '按上游分组', first: '取第一个有值的' }[c.mode || 'merge'] ?? ''),
  },
  {
    kind: 'code', label: '代码执行', group: '知识与数据', desc: '写一段代码处理输入', color: '#495057', ms: 600,
    icon: <>{P('M5.5 4.5 2.5 8l3 3.5M10.5 4.5l3 3.5-3 3.5')}</>,
    fields: [
      { key: 'language', label: '语言', type: 'select', default: 'javascript', options: () => [{ value: 'javascript', label: 'JavaScript' }, { value: 'python', label: 'Python' }] },
      { key: 'code', label: '代码', type: 'code', required: true, placeholder: 'function main(input) {\n  return { total: input.items.length }\n}' },
    ],
    run: (c, input) => ({ ...input, code_result: `（原型不执行代码，这里是 ${c.language === 'python' ? 'Python' : 'JavaScript'} 的模拟返回）` }),
    summary: (c) => (c.language === 'python' ? 'Python' : 'JavaScript'),
  },
  {
    kind: 'decide', label: '条件分支', group: '逻辑', desc: '按规则选分支；规则留空就是人工判断', color: '#0f8a8a', ms: 400,
    icon: <>{P('M4 3v3.5a2 2 0 0 0 2 2h4M10 8.5 12.5 6M10 8.5 12.5 11M4 6.5V13')}</>,
    branching: true, defaultCases: [{ key: 'yes', label: '是' }, { key: 'no', label: '否' }],
  },
  {
    kind: 'classifier', label: '问题分类器', group: '逻辑', desc: 'AI 判断输入属于哪一类，每一类一个出口', color: '#0f8a8a', ms: 1200,
    icon: <>{P('M2.5 4h4M2.5 8h4M2.5 12h4M9 4h4.5M9 8h4.5M9 12h4.5')}</>,
    branching: true, defaultCases: [{ key: 'c1', label: '类别 1' }, { key: 'c2', label: '类别 2' }],
    fields: [
      { key: 'from', label: '要分类的字段', type: 'text', placeholder: '留空自动找最长的那段文字' },
      { key: 'hint', label: '分类说明', type: 'textarea', placeholder: '每一类的判断依据，比如：提到报错、打不开的算「缺陷」' },
      agentField,
    ],
    summary: agentName,
    route: (c, input, n) => {
      const t = mainText(input, c.from)
      const cases = n.cases ?? []
      const hit = cases.find((k) => k.label && t.includes(k.label)) ?? cases.find((k) => k.label.split('').some((ch) => ch.trim() && t.includes(ch) && /[一-龥]/.test(ch) && k.label.length <= 3))
      return hit ? { route: hit.key, reason: `文字里提到了「${hit.label}」` } : { route: cases[0]?.key ?? '', reason: '没有明显命中，归到第一类（原型模拟）' }
    },
  },
  {
    kind: 'iterate', label: '迭代', group: '逻辑', desc: '对一个列表里的每一项做同样的事', color: '#0f8a8a', ms: 1500,
    icon: <>{P('M12.5 6A4.5 4.5 0 1 0 13 9')}{P('M12.8 3v3.2H9.6')}</>,
    fields: [
      { key: 'list', label: '列表字段', type: 'text', required: true, placeholder: 'demands', hint: '输入里哪个字段是列表' },
      { key: 'action', label: '每一项做什么', type: 'textarea', required: true, placeholder: '比如：为每条诉求建一条任务' },
      agentField,
    ],
    fail: (c, input) => (Array.isArray(getPath(input, c.list ?? '')) ? null : `输入里的「${c.list || '未填'}」不是列表`),
    run: (c, input) => {
      const items = getPath(input, c.list ?? '') as unknown[]
      return { ...input, results: items.map((item, i) => ({ item, result: `${c.action || '处理'}（第 ${i + 1} 项，原型模拟）` })) }
    },
    summary: (c) => (c.list ? `遍历 ${c.list}` : ''),
  },
  {
    kind: 'wait', label: '等待', group: '逻辑', desc: '停一段时间再往下走，比如等对方回复', color: '#868e96', ms: 2500,
    icon: <><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />{P('M8 5v3l2 1.5')}</>,
    fields: [{ key: 'duration', label: '等多久', type: 'text', default: '1 小时', placeholder: '30 分钟 / 1 天', hint: '原型里统一等 2.5 秒' }],
    run: (c, input) => ({ ...input, waited: c.duration || '1 小时' }),
    summary: (c) => (c.duration ? `等 ${c.duration}` : ''),
  },
  {
    kind: 'review', label: '人工检查', group: '人工', desc: '停下来让人看输出，可改了再放行', color: '#b0570b', ms: 300, descLabel: '检查要点',
    icon: <><circle cx="8" cy="8" r="2.2" fill="currentColor" /><path d="M1.8 8S4.2 3.8 8 3.8 14.2 8 14.2 8 11.8 12.2 8 12.2 1.8 8 1.8 8Z" fill="none" stroke="currentColor" strokeWidth="1.4" /></>,
    fields: [{ key: 'assignee', label: '谁来检查', type: 'text', placeholder: '我', default: '我' }],
    run: (_c, input) => input,
    summary: (c) => (c.assignee && c.assignee !== '我' ? `由 ${c.assignee} 检查` : ''),
  },
  {
    kind: 'http', label: 'HTTP 请求', group: '外部', desc: '调用外部系统的接口', color: '#e8590c', ms: 900,
    icon: <><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />{P('M2.5 8h11M8 2.5c2 2.2 2 8.8 0 11M8 2.5c-2 2.2-2 8.8 0 11')}</>,
    fields: [
      { key: 'method', label: '方法', type: 'select', default: 'POST', options: () => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m })) },
      { key: 'url', label: '地址', type: 'text', required: true, placeholder: 'https://api.example.com/tickets' },
      { key: 'headers', label: '请求头', type: 'code', placeholder: 'Authorization: Bearer {{token}}' },
      { key: 'body', label: '请求体', type: 'code', placeholder: '{ "title": "{{title}}" }', hint: '支持 {{字段}}' },
    ],
    fail: (c) => (!c.url?.trim() ? '没有配置请求地址' : /fail|500/.test(c.url) ? 'HTTP 500：对方服务出错' : null),
    run: (c, input) => ({ ...input, http: { status: 200, method: c.method || 'POST', url: render(c.url ?? '', input), body: { ok: true } } }),
    summary: (c) => (c.url ? `${c.method || 'POST'} ${c.url}` : ''),
  },
  {
    kind: 'notify', label: '发送消息', group: '外部', desc: '通过 IM 连接器或邮件发一条消息', color: '#e8590c', ms: 800,
    icon: <>{P('M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2Z')}</>,
    fields: [
      { key: 'channel', label: '渠道', type: 'select', default: 'lark', options: () => CHANNELS },
      { key: 'to', label: '发给', type: 'text', required: true, placeholder: '人名、群名，或 {{customer}}' },
      { key: 'content', label: '内容', type: 'textarea', required: true, placeholder: '{{text}}', hint: '支持 {{字段}}' },
    ],
    fail: (c) => (c.channel === 'wechat' ? '微信连接器凭证已过期（401），去设置 > 连接器里重新授权' : null),
    run: (c, input) => ({ ...input, sent: { channel: c.channel || 'lark', to: render(c.to ?? '', input), text: render(c.content ?? '', input) } }),
    summary: (c) => (c.to ? `${CHANNELS.find((x) => x.value === (c.channel || 'lark'))?.label} → ${c.to}` : ''),
  },
  {
    kind: 'task', label: '创建任务', group: '外部', desc: '在「任务」里建一条，带上流程里的上下文', color: '#e8590c', ms: 600,
    icon: <><rect x="2.5" y="2.5" width="11" height="11" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.4" />{P('m5.5 8.2 1.8 1.8 3.4-3.8')}</>,
    fields: [
      { key: 'title', label: '标题', type: 'text', required: true, placeholder: '{{demands[0].title}}', hint: '支持 {{字段}}' },
      { key: 'priority', label: '优先级', type: 'select', default: 'P2', options: () => ['P0', 'P1', 'P2', 'P3'].map((p) => ({ value: p, label: p })) },
      { key: 'assignee', label: '负责人', type: 'text', default: '我' },
      { key: 'project', label: '所属项目', type: 'select', options: () => [{ value: '', label: '不挂项目' }, ...projectOptions()], hint: '项目 id、编号或名字，支持 {{字段}}' },
    ],
    fail: (c, input) => { const k = render(c.project ?? '', input).trim(); return k && !findProject(k) ? `项目「${k}」不存在` : null },
    run: (c, input) => ({ ...input, task: { ref: `T-${Math.floor(100 + Math.random() * 900)}`, title: render(c.title ?? '', input), priority: c.priority || 'P2', assignee: c.assignee || '我', project: findProject(render(c.project ?? '', input).trim())?.name ?? '' } }),
    summary: (c) => (c.title ? `${c.priority || 'P2'} ${c.title}${c.project ? ` · ${c.project}` : ''}` : ''),
  },
  {
    kind: 'local_append', label: '写进项目目录', group: '外部', desc: '把一段文字写进项目关联的本地目录，文件已有就追加', color: '#e8590c', ms: 400,
    icon: <>{P('M2.5 4.5h4l1.2 1.5h5.8v6.5h-11zM8 8v3M6.5 9.5h3')}</>,
    fields: [
      { key: 'project', label: '项目', type: 'select', required: true, options: projectOptions },
      { key: 'dir', label: '写进哪个目录', type: 'text', placeholder: '留空是第一个关联目录', hint: '填第几个（从 1 起）或目录的名称' },
      { key: 'path', label: '文件路径', type: 'text', required: true, placeholder: 'IM收件/{{date}}.md', hint: '项目目录下的相对路径，不能有 ..；支持 {{字段}}、{{date}}' },
      { key: 'content', label: '内容', type: 'textarea', required: true, placeholder: '{{message.sender}}：{{message.text}}', hint: '支持 {{字段}}，一次最多 64 KB' },
    ],
    fail: (c, input) => {
      const p = findProject(render(c.project ?? '', input).trim())
      if (!p) return `项目「${render(c.project ?? '', input).trim()}」不存在`
      if (!p.related.length) return `项目「${p.name}」没有关联本地目录`
      const rel = render((c.path ?? '').replaceAll('{{date}}', today()), input).trim()
      if (!rel || rel.startsWith('/') || rel.split(/[\\/]/).includes('..')) return `文件路径「${rel}」要是项目目录下的相对路径，不能有 ..`
      return null
    },
    run: (c, input) => {
      const p = findProject(render(c.project ?? '', input).trim())!
      const n = Number(c.dir)
      const d = (c.dir && (Number.isInteger(n) ? p.related[n - 1] : p.related.find((x) => x.label === c.dir))) || p.related[0]
      const rel = render((c.path ?? '').replaceAll('{{date}}', today()), input).trim()
      return { ...input, file: { path: `${d.path}/${rel}`, rel, dir: d.path, dir_label: d.label, project: { id: p.id, name: p.name }, created: true } }
    },
    summary: (c) => (c.path ? `${c.project ? `${c.project} / ` : ''}${c.path}` : ''),
  },
  {
    kind: 'agent', label: '调用 Agent', group: '外部', desc: '把这一步交给一个 Agent，按它的权限做事', color: '#7a4fd6', ms: 2000,
    icon: <><circle cx="8" cy="6" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.4" />{P('M3 13.5c.8-2.4 2.7-3.6 5-3.6s4.2 1.2 5 3.6')}</>,
    fields: [
      { key: 'agent', label: 'Agent', type: 'select', required: true, options: () => seedAgents.map((a) => ({ value: a.name, label: a.name })) },
      { key: 'prompt', label: '交代给它的事', type: 'textarea', placeholder: '比如：认出 {{customer}} 是谁，判断要不要建任务' },
    ],
    run: (c, input) => ({ ...input, agent_reply: `（${c.agent || 'Agent'} 的处理结果，原型模拟）` }),
    summary: (c) => c.agent ?? '',
  },
  {
    kind: 'subflow', label: '子流程', group: '外部', desc: '在这里执行另一个 SOP，跑完再回来', color: '#3d4fd6', ms: 2200,
    icon: <><rect x="2" y="3" width="5" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" /><rect x="9" y="9" width="5" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />{P('M4.5 7v3.5H9')}</>,
    fields: [{ key: 'sop', label: '执行哪个 SOP', type: 'select', required: true, options: (ctx) => ctx.sops.map((s) => ({ value: s.name, label: s.name })) }],
    run: (c, input) => ({ ...input, subflow: { sop: c.sop, status: 'done' } }),
    summary: (c) => (c.sop ? `执行「${c.sop}」` : ''),
  },
  {
    kind: 'end', label: '结束', group: '输出', desc: '流程到这里结束，挑出要留下的结果', color: '#2f7d43', ms: 200,
    icon: <><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" /></>,
    fields: [{ key: 'outputs', label: '保留哪些字段', type: 'text', placeholder: '留空保留全部，多个用逗号隔开' }],
    run: (c, input) => (list(c.outputs).length ? Object.fromEntries(list(c.outputs).map((k) => [k, getPath(input, k) ?? null])) : input),
    summary: (c) => (c.outputs ? `输出：${c.outputs}` : '输出全部'),
  },
]

export const typeOf = (k: StepKind) => NODE_TYPES.find((t) => t.kind === k) ?? NODE_TYPES[0]
export const isBranching = (k: StepKind) => !!typeOf(k).branching
export const NODE_GROUPS = ['基础', '知识与数据', '逻辑', '人工', '外部', '输出']

/** 新建节点时的默认配置 */
export const defaultConfig = (k: StepKind): Cfg => Object.fromEntries((typeOf(k).fields ?? []).filter((f) => f.default !== undefined).map((f) => [f.key, f.default!]))

/** 必填配置有没有填 */
export const missingFields = (k: StepKind, cfg: Cfg = {}) => (typeOf(k).fields ?? []).filter((f) => f.required && !cfg[f.key]?.trim())

export function KindTag({ kind }: { kind: StepKind }) {
  const t = typeOf(kind)
  return <span className="kind-tag" style={{ '--c': t.color } as React.CSSProperties}>{t.label}</span>
}

export function KindIcon({ kind, size = 22 }: { kind: StepKind | 'start'; size?: number }) {
  const t = kind === 'start' ? null : typeOf(kind)
  return (
    <span className="kind-icon" style={{ width: size, height: size, background: t?.color ?? '#2f7d43' }}>
      <svg viewBox="0 0 16 16" width={size * 0.62} height={size * 0.62}>{t?.icon ?? <path d="M5.5 4v8l6.5-4Z" fill="currentColor" />}</svg>
    </span>
  )
}
