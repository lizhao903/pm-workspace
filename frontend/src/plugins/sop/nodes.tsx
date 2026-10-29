// 节点的展示信息（SPEC-sop-11）：名称、说明、颜色、图标、配置项、画布上的一行摘要。照原型 web-next/src/nodetypes.tsx 的 NODE_TYPES。
// 有哪些节点、分组、是不是分支节点、哪些配置项必填，以后端 GET /api/sop/node-types 为准（目录见 edit.ts 的 catalogOf）；
// 这里只管怎么显示。插件节点的显示由插件经 api.sopNodes 登记（SOP-03b，pluginInfo）；后端给了前端没登记的 kind 时
// 用 fallbackInfo，照常能加、能配名称和说明。doc、contact 是 SOP-02a 新加的写节点，原型里没有；notify 由 IM 插件的节点代替（SOP-02b），编辑器不列
import { useSyncExternalStore, type ReactNode } from 'react'
import { queryClient } from '../../core/data'
import { sopNodeView } from '../../core/plugin'
import { KIND_LABEL } from './model'

export type ConfigField = {
  key: string
  label: string
  type: 'text' | 'textarea' | 'code' | 'select' | 'number' | 'multi'
  options?: (ctx: FieldCtx) => { value: string; label: string }[]
  placeholder?: string
  hint?: string
  default?: string
  /** 插件登记的配置项：选项从数据层缓存算，缓存变了要重新算 */
  live?: boolean
}

/** 配置项选项的上下文：子流程可选的流程（不含正在编辑的）、Agent、知识库、文档分类，都从后端读 */
export type FieldCtx = {
  flows: { id: string; name: string }[]
  agents: { id: string; name: string }[]
  kbs: { id: string; name: string }[]
  docCats: { id: string; name: string }[]
}
export const EMPTY_CTX: FieldCtx = { flows: [], agents: [], kbs: [], docCats: [] }

export type NodeInfo = {
  label: string
  desc: string
  color: string
  icon: ReactNode
  /** 说明框的标题；不给是「说明」 */
  descLabel?: string
  /** 说明框的占位 */
  descHint?: string
  fields: ConfigField[]
  summary?: (cfg: Record<string, string>, ctx: FieldCtx) => string
}

const line = (d: string) => <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
const nameOf = (list: { id: string; name: string }[], id: string) => list.find((x) => x.id === id)?.name ?? id
const opts = (vals: string[]) => vals.map((v) => ({ value: v, label: v }))

const INFO: Record<string, NodeInfo> = {
  auto: {
    label: KIND_LABEL.auto, desc: '只把输入原样传下去、记一行日志；写数据用下面的写节点', color: '#3d4fd6', descLabel: '做什么', descHint: '比如：整理好字段交给下一步',
    icon: <path d="M9 2 4 9h3.5L7 14l5-7H8.5Z" fill="currentColor" />, fields: [],
  },
  ai: {
    label: KIND_LABEL.ai, desc: '生成、提炼、起草、改写', color: '#7a4fd6', descLabel: '给 AI 的要求',
    descHint: '比如：按客户的语气起草一条回复，告知已记录和大致排期。可以引用上游输出的字段',
    icon: <path d="M8 2.5 9.3 6.7 13.5 8 9.3 9.3 8 13.5 6.7 9.3 2.5 8 6.7 6.7Z" fill="currentColor" />,
    fields: [
      {
        key: 'model', label: '模型', type: 'select', default: '', hint: '留空用默认服务商的模型',
        options: () => [{ value: '', label: '跟随默认' }, { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' }, { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }, { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' }],
      },
      { key: 'output', label: '输出字段名', type: 'text', placeholder: 'result', default: 'result' },
    ],
    summary: (c) => (c.model ? c.model.replace('claude-', 'Claude ').replace(/-5-5$/, ' 5.5') : ''),
  },
  knowledge: {
    label: KIND_LABEL.knowledge, desc: '在知识库里按问题找相关段落', color: '#2f7d43',
    icon: <>{line('M3 3.5h4.5v9H3zM8.5 3.5H13v9H8.5')}</>,
    fields: [
      { key: 'query', label: '检索问题', type: 'textarea', placeholder: '可以引用输入字段，比如 {{customer}} 的历史需求', hint: '支持 {{字段}}' },
      // 后端只搜 config.kbs 里的知识库（原型的 scope 是文档分类，后端不认）
      { key: 'kbs', label: '检索哪些知识库', type: 'multi', options: (ctx) => ctx.kbs.map((k) => ({ value: k.id, label: k.name })), hint: '不选执行时会失败' },
      { key: 'top_k', label: '最多返回', type: 'number', default: '3' },
    ],
    summary: (c) => (c.query ? `问：${c.query}` : ''),
  },
  extract: {
    label: KIND_LABEL.extract, desc: '从一段文字里抽出指定字段', color: '#0c8599',
    icon: <>{line('M3 4h10M3 8h6M3 12h8')}<circle cx="12.5" cy="8" r="1.5" fill="currentColor" /></>,
    fields: [
      { key: 'fields', label: '要提取的字段', type: 'text', placeholder: '客户名, 金额, 日期', hint: '逗号隔开' },
      { key: 'from', label: '从哪个字段里提', type: 'text', placeholder: '留空自动找最长的那段文字' },
    ],
    summary: (c) => (c.fields ? `提取：${c.fields}` : ''),
  },
  template: {
    label: KIND_LABEL.template, desc: '用 {{字段}} 把输入拼成一段固定格式的文字', color: '#0c8599',
    icon: <>{line('M5 3.5 2.5 8 5 12.5M11 3.5 13.5 8 11 12.5M9 3 7 13')}</>,
    fields: [
      { key: 'template', label: '模板', type: 'code', placeholder: '{{customer}} 你好，你反馈的「{{demands[0].title}}」已经记录。' },
      { key: 'output', label: '输出字段名', type: 'text', default: 'text' },
    ],
    summary: (c) => c.template ?? '',
  },
  aggregate: {
    label: KIND_LABEL.aggregate, desc: '把几路上游（并行或分支）的输出合成一份', color: '#0c8599',
    icon: <>{line('M3 3.5 8 8 3 12.5M8 8h5')}</>,
    fields: [{
      key: 'mode', label: '合并方式', type: 'select', default: 'merge',
      options: () => [{ value: 'merge', label: '字段合并（后面的覆盖前面的）' }, { value: 'group', label: '按上游分组保留' }, { value: 'first', label: '取第一个有值的' }],
    }],
    summary: (c) => ({ merge: '字段合并', group: '按上游分组', first: '取第一个有值的' } as Record<string, string>)[c.mode || 'merge'] ?? '',
  },
  code: {
    label: KIND_LABEL.code, desc: '写一段代码处理输入（后端暂不执行）', color: '#495057',
    icon: <>{line('M5.5 4.5 2.5 8l3 3.5M10.5 4.5l3 3.5-3 3.5')}</>,
    fields: [
      { key: 'language', label: '语言', type: 'select', default: 'javascript', options: () => [{ value: 'javascript', label: 'JavaScript' }, { value: 'python', label: 'Python' }] },
      { key: 'code', label: '代码', type: 'code', placeholder: 'function main(input) {\n  return { total: input.items.length }\n}' },
    ],
    summary: (c) => (c.language === 'python' ? 'Python' : 'JavaScript'),
  },
  decide: {
    label: KIND_LABEL.decide, desc: '按规则选分支；规则留空就是人工判断', color: '#0f8a8a',
    icon: <>{line('M4 3v3.5a2 2 0 0 0 2 2h4M10 8.5 12.5 6M10 8.5 12.5 11M4 6.5V13')}</>, fields: [],
  },
  classifier: {
    label: KIND_LABEL.classifier, desc: 'AI 判断输入属于哪一类，每一类一个出口', color: '#0f8a8a',
    icon: <>{line('M2.5 4h4M2.5 8h4M2.5 12h4M9 4h4.5M9 8h4.5M9 12h4.5')}</>,
    fields: [
      { key: 'from', label: '要分类的字段', type: 'text', placeholder: '留空自动找最长的那段文字' },
      { key: 'hint', label: '分类说明', type: 'textarea', placeholder: '每一类的判断依据，比如：提到报错、打不开的算「缺陷」' },
    ],
  },
  iterate: {
    label: KIND_LABEL.iterate, desc: '对一个列表里的每一项做同样的事', color: '#0f8a8a',
    icon: <>{line('M12.5 6A4.5 4.5 0 1 0 13 9')}{line('M12.8 3v3.2H9.6')}</>,
    fields: [
      { key: 'list', label: '列表字段', type: 'text', placeholder: 'demands', hint: '输入里哪个字段是列表' },
      { key: 'action', label: '每一项做什么', type: 'textarea', placeholder: '比如：为每条诉求建一条任务' },
    ],
    summary: (c) => (c.list ? `遍历 ${c.list}` : ''),
  },
  wait: {
    label: KIND_LABEL.wait, desc: '停一段时间再往下走，比如等对方回复', color: '#868e96',
    icon: <><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />{line('M8 5v3l2 1.5')}</>,
    fields: [{ key: 'duration', label: '等多久', type: 'text', default: '1 小时', placeholder: '30 分钟 / 1 天', hint: '也认 90s、1h30m' }],
    summary: (c) => (c.duration ? `等 ${c.duration}` : ''),
  },
  review: {
    label: KIND_LABEL.review, desc: '停下来让人看输出，可改了再放行', color: '#b0570b', descLabel: '检查要点', descHint: '比如：核对待办的负责人和截止时间',
    icon: <><circle cx="8" cy="8" r="2.2" fill="currentColor" /><path d="M1.8 8S4.2 3.8 8 3.8 14.2 8 14.2 8 11.8 12.2 8 12.2 1.8 8 1.8 8Z" fill="none" stroke="currentColor" strokeWidth="1.4" /></>,
    fields: [{ key: 'assignee', label: '谁来检查', type: 'text', placeholder: '我', default: '我' }],
    summary: (c) => (c.assignee && c.assignee !== '我' ? `由 ${c.assignee} 检查` : ''),
  },
  http: {
    label: KIND_LABEL.http, desc: '调用外部系统的接口', color: '#e8590c',
    icon: <><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />{line('M2.5 8h11M8 2.5c2 2.2 2 8.8 0 11M8 2.5c-2 2.2-2 8.8 0 11')}</>,
    fields: [
      { key: 'method', label: '方法', type: 'select', default: 'POST', options: () => opts(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) },
      { key: 'url', label: '地址', type: 'text', placeholder: 'https://api.example.com/tickets' },
      { key: 'headers', label: '请求头', type: 'code', placeholder: 'Authorization: Bearer {{token}}' },
      { key: 'body', label: '请求体', type: 'code', placeholder: '{ "title": "{{title}}" }', hint: '支持 {{字段}}' },
    ],
    summary: (c) => (c.url ? `${c.method || 'POST'} ${c.url}` : ''),
  },
  notify: {
    label: KIND_LABEL.notify, desc: '通过 IM 连接器或邮件发一条消息', color: '#e8590c',
    icon: <>{line('M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2Z')}</>,
    fields: [
      { key: 'to', label: '发给', type: 'text', placeholder: '人名、群名，或 {{customer}}' },
      { key: 'content', label: '内容', type: 'textarea', placeholder: '{{text}}', hint: '支持 {{字段}}' },
    ],
    summary: (c) => (c.to ? `发给 ${c.to}` : ''),
  },
  task: {
    label: KIND_LABEL.task, desc: '在「任务」里建一条，带上流程里的上下文', color: '#e8590c',
    icon: <><rect x="2.5" y="2.5" width="11" height="11" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.4" />{line('m5.5 8.2 1.8 1.8 3.4-3.8')}</>,
    fields: [
      { key: 'title', label: '标题', type: 'text', placeholder: '{{demands[0].title}}', hint: '支持 {{字段}}' },
      { key: 'priority', label: '优先级', type: 'select', default: 'P2', options: () => opts(['P0', 'P1', 'P2', 'P3']) },
      { key: 'assignee', label: '负责人', type: 'text', default: '我', hint: '联系人 id 或名字，「我」不指派' },
      { key: 'body', label: '正文', type: 'textarea', placeholder: '支持 {{字段}}' },
    ],
    summary: (c) => (c.title ? `${c.priority || 'P2'} ${c.title}` : ''),
  },
  doc: {
    label: KIND_LABEL.doc, desc: '新建一篇文档，或把内容追加到已有文档末尾', color: '#e8590c',
    icon: <>{line('M4 2.5h5.5L12 5v8.5H4zM9.5 2.5V5H12M6 8h4M6 10.5h4')}</>,
    fields: [
      { key: 'mode', label: '方式', type: 'select', default: 'new', options: () => [{ value: 'new', label: '新建文档' }, { value: 'append', label: '追加到已有文档' }] },
      { key: 'title', label: '标题', type: 'text', placeholder: '留空用「流程名 · 步骤名」', hint: '新建时用' },
      { key: 'doc', label: '追加到哪篇文档', type: 'text', placeholder: '文档 id，支持 {{字段}}', hint: '追加时用' },
      { key: 'category', label: '文档分类', type: 'select', options: (ctx) => [{ value: '', label: '不分类' }, ...ctx.docCats.map((c) => ({ value: c.id, label: c.name }))] },
      { key: 'content', label: '正文', type: 'textarea', placeholder: '留空时写入输入的 JSON', hint: '支持 {{字段}}' },
    ],
    summary: (c) => (c.mode === 'append' ? (c.doc ? `追加到 ${c.doc}` : '追加到已有文档') : c.title ? `新建「${c.title}」` : '新建文档'),
  },
  contact: {
    label: KIND_LABEL.contact, desc: '新建联系人，或把字段合并到已有联系人', color: '#e8590c',
    icon: <><circle cx="8" cy="6" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.4" />{line('M3.5 13c.7-2.2 2.4-3.3 4.5-3.3M11.5 9.5v4M9.5 11.5h4')}</>,
    fields: [
      { key: 'mode', label: '方式', type: 'select', default: 'new', options: () => [{ value: 'new', label: '新建联系人' }, { value: 'merge', label: '合并到已有联系人' }] },
      { key: 'id', label: '合并到哪个联系人', type: 'text', placeholder: '联系人 id，留空取输入的 contact_id', hint: '合并时用' },
      { key: 'name', label: '姓名', type: 'text', placeholder: '留空取输入里的 name', hint: '支持 {{字段}}' },
      { key: 'company', label: '公司', type: 'text', placeholder: '留空取输入里的 company' },
      { key: 'title', label: '职位', type: 'text', placeholder: '留空取输入里的 title' },
      { key: 'phone', label: '电话', type: 'text', placeholder: '留空取输入里的 phone' },
      { key: 'email', label: '邮箱', type: 'text', placeholder: '留空取输入里的 email' },
      { key: 'group', label: '分组', type: 'text', placeholder: '留空取输入里的 group' },
      { key: 'note', label: '备注', type: 'textarea', placeholder: '留空取输入里的 note' },
    ],
    summary: (c) => (c.mode === 'merge' ? '合并到已有联系人' : c.name ? `新建「${c.name}」` : '新建联系人'),
  },
  agent: {
    label: KIND_LABEL.agent, desc: '把这一步交给一个 Agent，按它的权限做事', color: '#7a4fd6',
    icon: <><circle cx="8" cy="6" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.4" />{line('M3 13.5c.8-2.4 2.7-3.6 5-3.6s4.2 1.2 5 3.6')}</>,
    fields: [
      { key: 'agent', label: 'Agent', type: 'select', options: (ctx) => ctx.agents.map((a) => ({ value: a.id, label: a.name })) },
      { key: 'prompt', label: '交代给它的事', type: 'textarea', placeholder: '比如：认出 {{customer}} 是谁，判断要不要建任务' },
    ],
    summary: (c, ctx) => (c.agent ? nameOf(ctx.agents, c.agent) : ''),
  },
  subflow: {
    label: KIND_LABEL.subflow, desc: '在这里执行另一个 SOP，跑完再回来', color: '#3d4fd6',
    icon: <><rect x="2" y="3" width="5" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" /><rect x="9" y="9" width="5" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />{line('M4.5 7v3.5H9')}</>,
    fields: [{ key: 'sop', label: '执行哪个 SOP', type: 'select', options: (ctx) => ctx.flows.map((f) => ({ value: f.id, label: f.name })) }],
    summary: (c, ctx) => (c.sop ? `执行「${nameOf(ctx.flows, c.sop)}」` : ''),
  },
  end: {
    label: KIND_LABEL.end, desc: '流程到这里结束，挑出要留下的结果', color: '#2f7d43',
    icon: <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />,
    fields: [{ key: 'outputs', label: '保留哪些字段', type: 'text', placeholder: '留空保留全部，多个用逗号隔开' }],
    summary: (c) => (c.outputs ? `输出：${c.outputs}` : '输出全部'),
  },
}

const PLUGIN_ICON = <><rect x="3" y="3" width="10" height="10" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="8" cy="8" r="1.8" fill="currentColor" /></>

/** 插件经 api.sopNodes 登记的节点；选项函数出错时当没有选项，不让编辑器崩 */
function pluginInfo(kind: string): NodeInfo | undefined {
  const v = sopNodeView(kind)
  if (!v) return undefined
  return {
    label: v.label || kind, desc: v.desc, color: v.color || '#868e96', icon: PLUGIN_ICON,
    fields: v.fields.map((f) => ({
      key: f.key, label: f.label, type: f.type, hint: f.hint, default: f.default, live: true,
      options: f.options && (() => {
        try {
          return f.options!()
        } catch (e) {
          console.error(`SOP 节点 ${kind} 的 ${f.key} 选项出错`, e)
          return []
        }
      }),
    })),
  }
}

let cacheTick = 0
const noSub = () => () => {}
const subCache = (fn: () => void) => queryClient.getQueryCache().subscribe((e) => {
  if (e.type === 'updated' || e.type === 'added' || e.type === 'removed') {
    cacheTick += 1
    fn()
  }
})

/** 插件配置项订阅数据层缓存，选项依赖的数据取回来后重新渲染 */
export function useLiveOptions(live: boolean | undefined) {
  useSyncExternalStore(live ? subCache : noSub, () => (live ? cacheTick : 0))
}

/** 前端不认识的 kind（后端有、前端没登记的插件节点）：名字就是 kind，没有配置项 */
export function fallbackInfo(kind: string): NodeInfo {
  return { label: kind, desc: '插件提供的节点', color: '#868e96', icon: <circle cx="8" cy="8" r="3" fill="currentColor" />, fields: [] }
}

export const nodeInfo = (kind: string): NodeInfo => INFO[kind] ?? pluginInfo(kind) ?? fallbackInfo(kind)
export const hasInfo = (kind: string) => kind in INFO

/** 新建节点时的默认配置 */
export const defaultConfig = (kind: string): Record<string, string> =>
  Object.fromEntries(nodeInfo(kind).fields.filter((f) => f.default !== undefined).map((f) => [f.key, f.default!]))
