// 项目：把一个产品相关的东西归到一起——本地项目目录、支持材料、产品文档、产品原型、关联目录、项目 Agent
// 原型的启停是模拟的：不真的起进程，只按端口占用规则走「启动中 → 运行中 / 失败」，日志是编出来的
import { seedContent } from './data'

export type MaterialKind = 'file' | 'folder' | 'link' | 'note'
export const MATERIAL_KIND: Record<MaterialKind, string> = { file: '文件', folder: '文件夹', link: '链接', note: '笔记' }

export interface Material {
  id: string; name: string; kind: MaterialKind; value: string; tags: string[]; added_at: string
  /** 从 IM 消息附件加进来的：记着出处；文件的 value 是本地绝对路径，不拼项目目录 */
  from?: { message_id: string; attachment_id: string; sender: string; conversation: string }
}

export type DocStatus = 'draft' | 'review' | 'final'
export const DOC_STATUS: Record<DocStatus, { label: string; color: string }> = {
  draft: { label: '草稿', color: '#a19d92' },
  review: { label: '评审中', color: '#b0570b' },
  final: { label: '定稿', color: '#2f7d43' },
}
export const DOC_KINDS = ['PRD', '技术方案', '交互说明', '测试用例', '发布说明', '其他']

/** 产品文档：要么关联「文档」里的一篇，要么是项目目录里的一个文件 */
export interface ProjectDoc { id: string; title: string; kind: string; status: DocStatus; source: { type: 'library'; content_id: string } | { type: 'file'; path: string }; updated_at: string }

export type ProtoStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
export const PROTO_STATUS: Record<ProtoStatus, { label: string; color: string }> = {
  stopped: { label: '已停止', color: '#a19d92' },
  starting: { label: '启动中', color: '#3d4fd6' },
  running: { label: '运行中', color: '#2f7d43' },
  stopping: { label: '停止中', color: '#b0570b' },
  error: { label: '启动失败', color: '#c0352b' },
}

export interface Prototype {
  id: string
  name: string
  /** 相对项目目录的路径 */
  dir: string
  command: string
  port: number
  status: ProtoStatus
  error?: string
  started_at?: string
  logs: string[]
}

export interface RelatedDir { path: string; label: string }

/** 项目的沟通渠道：群聊按「渠道 + 群名」认，私聊按联系人认 */
export type ProjectChat =
  | { id: string; kind: 'group'; channel: string; conversation: string }
  | { id: string; kind: 'dm'; contact_id: string }

export type StakeRole = 'decider' | 'contact' | 'owner' | 'member' | 'informed'
export const STAKE_ROLE: Record<StakeRole, { label: string; desc: string }> = {
  decider: { label: '决策人', desc: '拍板、验收' },
  contact: { label: '对接人', desc: '日常沟通、需求来源' },
  owner: { label: '负责人', desc: '我方交付负责' },
  member: { label: '参与', desc: '一起做事' },
  informed: { label: '知会', desc: '有进展告诉他就行' },
}
export interface Stakeholder { contact_id: string; role: StakeRole; focus: string }

export interface Project {
  id: string
  name: string
  desc: string
  color: string
  /** 项目标志：文字（默认取名字第一个字）或上传的图片，底色用 color */
  mark?: { text: string; image?: string; icon?: string }
  root: string
  related: RelatedDir[]
  /** 项目的 Agent，第一个是默认 */
  agent_ids: string[]
  chats: ProjectChat[]
  /** 沟通里的附件选了「不加入」的（附件 id），不再提示 */
  skipped_attachments?: string[]
  stakeholders: Stakeholder[]
  /** 关联的 SOP */
  sop_ids: string[]
  materials: Material[]
  docs: ProjectDoc[]
  prototypes: Prototype[]
  created_at: string
}

export const PROJECT_COLORS = ['#3d4fd6', '#0f8a8a', '#7a4fd6', '#b0570b', '#2f7d43', '#c0352b']
/** 这些端口有别的东西在用，原型不能占：7777 是在跑的真实工作台 */
export const RESERVED_PORTS: Record<number, string> = { 7777: '真实数据的工作台服务' }

/** 检查端口：被保留、或者被本项目 / 其他项目里正在运行的原型占着，都不能启动 */
export function portConflict(port: number, selfId: string, projects: Project[]): string | null {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return '端口要在 1024 到 65535 之间'
  if (RESERVED_PORTS[port]) return `${port} 端口给${RESERVED_PORTS[port]}用着`
  for (const p of projects) for (const x of p.prototypes) {
    if (x.id !== selfId && x.port === port && (x.status === 'running' || x.status === 'starting')) return `${port} 端口被「${p.name} / ${x.name}」占着`
  }
  return null
}

const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString()
// 按启动命令编一段像样的启动输出；认不出的命令只报监听端口
const bootLogs = (p: Pick<Prototype, 'command' | 'port' | 'dir'>) => {
  const head = [`$ cd ${p.dir}`, `$ ${p.command}`]
  if (/http\.server/.test(p.command)) return [...head, `Serving HTTP on 127.0.0.1 port ${p.port} (http://127.0.0.1:${p.port}/) ...`]
  if (/next/.test(p.command)) return [...head, '▲ Next.js', `- Local: http://127.0.0.1:${p.port}`, '✓ Ready']
  if (/npm|pnpm|yarn|vite/.test(p.command)) return [...head, '> vite', '  VITE ready in 412 ms', `  ➜  Local:   http://127.0.0.1:${p.port}/`]
  return [...head, `listening on http://127.0.0.1:${p.port}`]
}
export const startLogs = bootLogs

export const seedProjects: Project[] = [
  {
    id: 'pj_pmw', name: '产品工作台新版', desc: '把工作台前端重做一版，先出可点的原型', color: '#3d4fd6', mark: { text: '', icon: 'layout' },
    root: '/Volumes/project/0xBroleez/pm-workspace',
    related: [
      { path: '/Volumes/project/0xBroleez/pm-workspace/web', label: '旧版前端' },
      { path: '/Volumes/project/0xBroleez/pm-workspace/docs', label: '接口契约与状态看板' },
    ],
    agent_ids: ['ag_weekly', 'ag_sop'],
    chats: [{ id: 'ch1', kind: 'group', channel: 'slack', conversation: '#product' }, { id: 'ch2', kind: 'group', channel: 'slack', conversation: '#feedback' }, { id: 'ch3', kind: 'dm', contact_id: 'ct_002' }],
    stakeholders: [
      { contact_id: 'ct_001', role: 'owner', focus: '前端实现和交付节奏' },
      { contact_id: 'ct_002', role: 'member', focus: '接口和权限缓存方案' },
      { contact_id: 'ct_003', role: 'member', focus: '交互和视觉规范' },
      { contact_id: 'ct_004', role: 'informed', focus: '测试计划' },
    ],
    sop_ids: ['sop_meeting'],
    materials: [
      { id: 'mt1', name: '参考：Dify 工作流编排截图', kind: 'file', value: 'docs/refs/dify-canvas.png', tags: ['参考', 'SOP'], added_at: minsAgo(60 * 24) },
      { id: 'mt2', name: '旧版用起来的问题清单', kind: 'note', value: '侧栏太宽；列表页错误横幅太占地方；设置项散落在各页', tags: ['反馈'], added_at: minsAgo(60 * 30) },
      { id: 'mt3', name: '接口契约', kind: 'link', value: 'docs/api-contract.md', tags: ['接口'], added_at: minsAgo(60 * 24 * 6) },
      { id: 'mt6', name: '旧版界面截图', kind: 'folder', value: 'docs/screenshots', tags: ['参考'], added_at: minsAgo(60 * 24 * 4) },
    ],
    docs: [
      { id: 'pd1', title: '租户级权限模型 PRD v0.3', kind: 'PRD', status: 'review', source: { type: 'library', content_id: 'dc_001' }, updated_at: seedContent.find((c) => c.id === 'dc_001')?.updated_at ?? minsAgo(40) },
      { id: 'pd2', title: '新版前端信息架构', kind: '交互说明', status: 'draft', source: { type: 'file', path: 'web-next/README.md' }, updated_at: minsAgo(60 * 3) },
    ],
    prototypes: [
      { id: 'pt1', name: '新版前端原型', dir: 'web-next', command: 'npm run dev', port: 7778, status: 'running', started_at: minsAgo(60 * 5), logs: bootLogs({ dir: 'web-next', command: 'npm run dev', port: 7778 }) },
      { id: 'pt2', name: '状态看板', dir: 'docs', command: 'python3 -m http.server 7790', port: 7790, status: 'stopped', logs: [] },
    ],
    created_at: minsAgo(60 * 24 * 10),
  },
  {
    id: 'pj_perm', name: '远川科技权限改造', desc: '按部门自定义角色，月底演示', color: '#0f8a8a', mark: { text: '', icon: 'shield' },
    root: '/Volumes/project/clients/yuanchuan-permission',
    related: [{ path: '/Volumes/docs/客户/远川科技', label: '客户资料' }],
    agent_ids: ['ag_triage'],
    chats: [{ id: 'ch4', kind: 'group', channel: 'lark', conversation: '远川试点项目群' }, { id: 'ch5', kind: 'dm', contact_id: 'ct_005' }],
    stakeholders: [
      { contact_id: 'ct_005', role: 'decider', focus: '月底演示能不能按部门自定义角色' },
      { contact_id: 'ct_006', role: 'contact', focus: '采购流程、报价和合同' },
      { contact_id: 'ct_002', role: 'owner', focus: '权限变更生效时间' },
    ],
    sop_ids: ['sop_feedback', 'sop_contact'],
    materials: [
      { id: 'mt4', name: '客户访谈纪要 10/20', kind: 'file', value: 'materials/interview-1020.md', tags: ['访谈'], added_at: minsAgo(60 * 24 * 8) },
      { id: 'mt5', name: 'Mia：欧盟数据驻留的法务要求', kind: 'note', value: '欧盟租户数据落在境内机房；运维访问留痕；备份不出境', tags: ['合规'], added_at: minsAgo(60 * 24 * 2) },
    ],
    docs: [{ id: 'pd3', title: '权限配置交互说明', kind: '交互说明', status: 'draft', source: { type: 'file', path: 'docs/permission-ux.md' }, updated_at: minsAgo(60 * 20) }],
    prototypes: [{ id: 'pt3', name: '权限配置原型', dir: 'prototype', command: 'npm run dev -- --port 7781', port: 7781, status: 'stopped', logs: [] }],
    created_at: minsAgo(60 * 24 * 15),
  },
]
