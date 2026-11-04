// 项目：把一个产品相关的东西归到一起——本地项目目录、支持材料、产品文档、产品原型、关联目录、项目 Agent
// 原型的启停是模拟的：不真的起进程，只按端口占用规则走「启动中 → 运行中 / 失败」，日志是编出来的
import { seedContent } from './data'

export type MaterialKind = 'file' | 'folder' | 'link' | 'note'
export const MATERIAL_KIND: Record<MaterialKind, string> = { file: '文件', folder: '文件夹', link: '链接', note: '笔记' }

export interface Material {
  id: string; name: string; kind: MaterialKind; value: string; tags: string[]; added_at: string
  /**
   * 来自 IM 消息的：记着出处。附件加进来的 attachment_id 是附件，文件的 value 是本地绝对路径，不拼项目目录；
   * 消息正文转成的笔记（SPEC-messages-6）attachment_id 为空，message_ids 是这组消息（按时间正序），message_id 是最新一条
   */
  from?: { message_id: string; attachment_id: string; sender: string; conversation: string; message_ids?: string[] }
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

/**
 * 项目档案（AUTO-04，SPEC-projects-15）的命令，分两组（AUTO-10，SPEC-projects-15.9）：
 * 测试环境组由任务工作区的「运行测试」执行（AUTO-08），smoke 一直是测试环境上的冒烟；
 * 发布组由发布 pipeline 在任务工作区里执行，版本号与打包在上线审批前跑，其余审批后才跑
 */
export const PROFILE_COMMANDS = [
  { key: 'build', label: '构建', group: 'test', hint: '测试前先构建' },
  { key: 'test', label: '测试', group: 'test', hint: '单测、接口、端到端；截图和 junit 写进 $TEST_REPORT_DIR' },
  { key: 'test_env', label: '起测试环境', group: 'test', hint: '后台起临时测试环境，监听 $PORT' },
  { key: 'smoke', label: '冒烟（测试环境）', group: 'test', hint: '在测试环境上跑的冒烟，不碰生产' },
  { key: 'version', label: '版本号与更新日志', group: 'release', hint: '审批前跑：把版本号写进 $RELEASE_DIR/version.txt、更新日志写进 $RELEASE_DIR/changelog.md；没写 version.txt 取输出最后一行' },
  { key: 'package', label: '打包', group: 'release', hint: '审批前跑：在工作区里打包，不碰生产；可用 $RELEASE_VERSION' },
  { key: 'preflight', label: '发布前检查', group: 'release', hint: '上线审批后才跑：备份数据库、核对密钥；没过不发布、不回滚' },
  { key: 'release', label: '发布', group: 'release', hint: '上线审批后才跑：发布到生产；没填就发起不了发布' },
  { key: 'prod_smoke', label: '线上冒烟', group: 'release', hint: '上线审批后才跑：发布后检查线上；没过自动回滚' },
  { key: 'rollback', label: '回滚', group: 'release', hint: '上线审批后才跑：发布或线上冒烟没过时自动执行' },
] as const
export const PROFILE_COMMAND_GROUPS = [
  { key: 'test', label: '测试环境', hint: '任务工作区的「运行测试」按顺序执行：构建、起测试环境、测试、冒烟；可用变量 PORT、WORKTREE、TASK_REF、TEST_REPORT_DIR' },
  { key: 'release', label: '发布', hint: '发布 pipeline 在任务工作区里执行，审批前只跑版本号与打包；可用变量 WORKTREE、TASK_REF、RELEASE_ID、RELEASE_DIR、RELEASE_VERSION' },
] as const
export type ProfileCommandKey = (typeof PROFILE_COMMANDS)[number]['key']
/** dir 相对代码库目录，空串是代码库根目录；timeout_sec 为 0 用执行方的默认值；ready 只有起测试环境用：就绪检查（AUTO-08） */
export interface ProfileCommand { command: string; dir: string; timeout_sec: number; ready?: string }
export const PLATFORM_PRESETS = ['web', 'H5', '桌面', '云端', '移动端', '小程序']

/** 项目档案：给分类 Agent 和各 pipeline 用。目录是本机绝对路径，正式产品保存时校验存在且是目录 */
export interface ProjectProfile {
  intro: string
  keywords: string[]
  platforms: string[]
  code_dir: string
  proto_dir: string
  prd_dir: string
  commands: Partial<Record<ProfileCommandKey, ProfileCommand>>
  /** 联系人 id */
  owner_ids: string[]
  acceptor_ids: string[]
}
export const EMPTY_PROFILE: ProjectProfile = { intro: '', keywords: [], platforms: [], code_dir: '', proto_dir: '', prd_dir: '', commands: {}, owner_ids: [], acceptor_ids: [] }

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
  /** 详情页不显示的标签（SPEC-projects-13.19）；概览、设置一直显示，没有时全部显示 */
  tabs_hidden?: string[]
  /** 详情页标签的先后（SPEC-projects-13.20）：标签 key 的顺序，概览、设置固定一头一尾不在里面；没有时按默认顺序，没列进来的新标签按默认位置插入 */
  tabs_order?: string[]
  stakeholders: Stakeholder[]
  /** 关联的 SOP */
  sop_ids: string[]
  materials: Material[]
  docs: ProjectDoc[]
  prototypes: Prototype[]
  /** 项目档案（SPEC-projects-15）；没建过时没有 */
  profile?: ProjectProfile
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
    profile: {
      intro: '个人产品管理工具：需求、任务、项目、文档、IM 消息和原型统一管，Claude Code 按任务开发',
      keywords: ['工作台', 'pmw', '需求管理', '原型'], platforms: ['web', '桌面'],
      code_dir: '', proto_dir: '/Volumes/project/0xBroleez/pm-workspace/web-next', prd_dir: '/Volumes/project/0xBroleez/pm-workspace/docs',
      commands: { build: { command: 'make build', dir: '', timeout_sec: 900 }, test: { command: 'go test ./... && npm --prefix frontend test', dir: '', timeout_sec: 1200 },
        test_env: { command: './pmw --addr :$PORT --data $TEST_REPORT_DIR/data', dir: '', timeout_sec: 60, ready: '/api/health' }, smoke: { command: 'curl -fsS http://127.0.0.1:$PORT/api/health', dir: '', timeout_sec: 0 },
        version: { command: './scripts/next-version.sh > $RELEASE_DIR/version.txt && git log --oneline main.. > $RELEASE_DIR/changelog.md', dir: '', timeout_sec: 0 },
        package: { command: 'make build VERSION=$RELEASE_VERSION', dir: '', timeout_sec: 900 },
        preflight: { command: './scripts/backup-db.sh && ./scripts/check-vault-key.sh', dir: '', timeout_sec: 300 },
        release: { command: './scripts/deploy.sh $RELEASE_VERSION', dir: '', timeout_sec: 600 },
        prod_smoke: { command: 'curl -fsS http://127.0.0.1:7796/api/health', dir: '', timeout_sec: 60 },
        rollback: { command: './scripts/rollback.sh', dir: '', timeout_sec: 600 } },
      owner_ids: ['ct_001'], acceptor_ids: ['ct_004'],
    },
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
      { contact_id: 'ct_004', role: 'informed', focus: '回归用例和验收' },
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
    ],
    docs: [{ id: 'pd3', title: '权限配置交互说明', kind: '交互说明', status: 'draft', source: { type: 'file', path: 'docs/permission-ux.md' }, updated_at: minsAgo(60 * 20) }],
    prototypes: [{ id: 'pt3', name: '权限配置原型', dir: 'prototype', command: 'npm run dev -- --port 7781', port: 7781, status: 'stopped', logs: [] }],
    created_at: minsAgo(60 * 24 * 15),
  },
  {
    id: 'pj_beian', name: '北岸物流审批流 demo', desc: '给北岸物流演示运营后台审批流，顺带评估司机端离线签收', color: '#b0570b', mark: { text: '', icon: 'checklist' },
    root: '/Volumes/project/clients/beian-approval',
    related: [],
    agent_ids: ['ag_triage'],
    chats: [{ id: 'ch6', kind: 'dm', contact_id: 'ct_007' }],
    stakeholders: [
      { contact_id: 'ct_007', role: 'decider', focus: '审批流能不能接他们的签收单据' },
      { contact_id: 'ct_001', role: 'member', focus: '司机端离线签收的前端方案' },
      { contact_id: 'ct_003', role: 'informed', focus: '演示用的审批页面' },
    ],
    sop_ids: ['sop_feedback'],
    materials: [
      { id: 'mt7', name: '展会交流记录', kind: 'note', value: '运营后台审批流感兴趣；山区司机签收经常失败；下季度再约', tags: ['线索'], added_at: minsAgo(60 * 24 * 31) },
    ],
    docs: [
      { id: 'pd4', title: '审批流可以复用工单的状态机', kind: '技术方案', status: 'draft', source: { type: 'library', content_id: 'dc_003' }, updated_at: seedContent.find((c) => c.id === 'dc_003')?.updated_at ?? minsAgo(60 * 50) },
      { id: 'pd5', title: '离线同步方案对比', kind: '技术方案', status: 'review', source: { type: 'library', content_id: 'dc_006' }, updated_at: seedContent.find((c) => c.id === 'dc_006')?.updated_at ?? minsAgo(60 * 24 * 5) },
    ],
    prototypes: [{ id: 'pt4', name: '审批流 demo', dir: 'demo', command: 'npm run dev -- --port 7782', port: 7782, status: 'stopped', logs: [] }],
    created_at: minsAgo(60 * 24 * 7),
  },
  {
    id: 'pj_eu', name: '欧盟数据驻留方案', desc: '和 Nordlicht 一起定欧盟租户的存储和运维方案', color: '#2f7d43', mark: { text: '', icon: 'globe' },
    root: '/Volumes/docs/方案/eu-residency',
    // 有关联文档目录、没登记原型：交给 Claude Code 的提示词里原型一项写「没有登记原型目录」（SPEC-tasks-6.13）
    related: [{ path: '/Volumes/docs/方案/eu-residency/方案文档', label: '方案文档' }],
    agent_ids: ['ag_weekly'],
    chats: [{ id: 'ch7', kind: 'dm', contact_id: 'ct_008' }],
    stakeholders: [
      { contact_id: 'ct_008', role: 'contact', focus: '欧盟法务口径和本地机房' },
      { contact_id: 'ct_009', role: 'member', focus: '审计日志保留期和运维访问留痕' },
      { contact_id: 'ct_002', role: 'member', focus: '存储架构和备份' },
    ],
    sop_ids: [],
    materials: [
      { id: 'mt5', name: 'Mia：欧盟数据驻留的法务要求', kind: 'note', value: '欧盟租户数据落在欧盟境内机房；运维访问留痕；备份不出境', tags: ['合规'], added_at: minsAgo(18) },
      { id: 'mt8', name: '现有存储架构图', kind: 'file', value: 'architecture/storage-current.png', tags: ['架构'], added_at: minsAgo(60 * 24 * 3) },
    ],
    docs: [{ id: 'pd6', title: 'Mia：欧盟数据驻留的法务要求', kind: '其他', status: 'draft', source: { type: 'library', content_id: 'dc_004' }, updated_at: seedContent.find((c) => c.id === 'dc_004')?.updated_at ?? minsAgo(18) }],
    prototypes: [],
    created_at: minsAgo(60 * 24 * 6),
  },
]
