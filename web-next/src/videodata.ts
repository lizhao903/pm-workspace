// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 视频类项目：按 web-video-presentation 技能的制作流程管——选题 → 文稿 → 规划检查 → 网页开发 → 第一章验收 → 其余章节 → 音频 → 录屏 → 分发包
// 一个视频项目可以出横屏、竖屏、方形几个画面比例；每个比例是一个独立的演示工程，共用文稿
// 产出物（文稿、工程、音频、视频、封面、简介、章节）都登记在这里，带版本、比例、状态、验收记录
// 发布记录按平台记：用了哪个比例和封面、标题简介、链接，事后回填播放数据
// 系列：多集共用开场、收尾和模板；批量改版时要能看出影响哪几集
//
// 这个文件是视频模块的数据约定：videos.tsx、videopublish.tsx 只读它的类型和常量，不改它

export type Orientation = 'landscape' | 'portrait' | 'square'
export const ORIENT: Record<Orientation, { label: string; ratio: string; w: number; h: number }> = {
  landscape: { label: '横屏', ratio: '16:9', w: 16, h: 9 },
  portrait: { label: '竖屏', ratio: '9:16', w: 9, h: 16 },
  square: { label: '方形', ratio: '1:1', w: 1, h: 1 },
}

export type StageKey = 'topic' | 'script' | 'plan' | 'web' | 'ch1' | 'chapters' | 'audio' | 'record' | 'distribution'
export const STAGES: { key: StageKey; label: string; desc: string; checkpoint?: boolean }[] = [
  { key: 'topic', label: '选题', desc: '这一集讲什么：从选题库挑一个，或者新建一个' },
  { key: 'script', label: '内容编写', desc: '口播稿按比例各写一套，加大纲；可以按选题大纲起草，原文可选' },
  { key: 'plan', label: '规划检查', desc: '对齐稿子、大纲、主题、素材、开发方式和画面比例；比例定了就不能改', checkpoint: true },
  { key: 'web', label: '网页开发', desc: '按比例搭演示工程，第 1 章完整做出来' },
  { key: 'ch1', label: '第一章验收', desc: '第 1 章是后面所有章节的样板，必须验收', checkpoint: true },
  { key: 'chapters', label: '其余章节', desc: '第 2 到 N 章：逐章、顺序或并行开发' },
  { key: 'audio', label: '音频合成', desc: '决定要不要合成口播音频，按章节出音频', checkpoint: true },
  { key: 'record', label: '录屏渲染', desc: '程序化录屏，合成 mp4' },
  { key: 'distribution', label: '分发包', desc: '封面（每种封面比例 5 个版本）、简介、章节时间轴', checkpoint: true },
]
export const stageIndex = (k: StageKey) => STAGES.findIndex((s) => s.key === k)

// 封面比例和舞台方向分开：竖屏视频的封面可以是 9:16、3:4 或 1:1，平台各有要求（抖音主页要 3:4）
export type CoverRatio = '16x9' | '4x3' | '9x16' | '3x4' | '1x1'
export const COVER_RATIO: Record<CoverRatio, { label: string; w: number; h: number }> = {
  '16x9': { label: '16:9', w: 16, h: 9 },
  '4x3': { label: '4:3', w: 4, h: 3 },
  '9x16': { label: '9:16', w: 9, h: 16 },
  '3x4': { label: '3:4', w: 3, h: 4 },
  '1x1': { label: '1:1', w: 1, h: 1 },
}
/** 每个舞台方向默认出哪几种封面比例；第一个是和舞台同比例的那种 */
export const DEFAULT_COVER_RATIOS: Record<Orientation, CoverRatio[]> = {
  landscape: ['16x9', '4x3'],
  portrait: ['9x16', '3x4', '1x1'],
  square: ['1x1', '4x3'],
}
/** 封面的比例：老数据没记 ratio 的，按舞台方向算 */
export const coverRatioOf = (a: { ratio?: CoverRatio; variant?: Orientation }): CoverRatio => a.ratio ?? DEFAULT_COVER_RATIOS[a.variant ?? 'landscape'][0]

// 口播稿、大纲、简介、章节时间轴按比例各一套（技能布局 B：横版、竖版各写各的、各自验收）；原文和音频共用
export type ArtifactKind = 'article' | 'script' | 'outline' | 'presentation' | 'audio' | 'video' | 'subtitle' | 'cover' | 'description' | 'chapters'
export const ARTIFACT_KIND: Record<ArtifactKind, { label: string; stage: StageKey; perVariant: boolean }> = {
  article: { label: '原文', stage: 'script', perVariant: false },
  script: { label: '口播稿', stage: 'script', perVariant: true },
  outline: { label: '大纲', stage: 'script', perVariant: true },
  presentation: { label: '演示工程', stage: 'web', perVariant: true },
  audio: { label: '音频', stage: 'audio', perVariant: false },
  video: { label: '视频', stage: 'record', perVariant: true },
  subtitle: { label: '字幕', stage: 'record', perVariant: true },
  cover: { label: '封面', stage: 'distribution', perVariant: true },
  description: { label: '简介', stage: 'distribution', perVariant: true },
  chapters: { label: '章节时间轴', stage: 'distribution', perVariant: true },
}

export type ArtifactStatus = 'draft' | 'review' | 'final' | 'published'
export const ARTIFACT_STATUS: Record<ArtifactStatus, { label: string; color: string }> = {
  draft: { label: '草稿', color: '#a19d92' },
  review: { label: '待验收', color: '#b0570b' },
  final: { label: '已定稿', color: '#2f7d43' },
  published: { label: '已发布', color: '#3d4fd6' },
}

/** 谁验收的：自己，或者外部审核人（商单的客户，联系人 id） */
export type ReviewBy = { type: 'me' | 'contact'; id?: string }
export interface Review { at: string; ok: boolean; comment: string; by?: ReviewBy }

export interface Artifact {
  id: string
  video_id: string
  kind: ArtifactKind
  name: string
  /** 相对视频项目目录的路径 */
  path: string
  /** 按比例区分的产出（文稿、演示工程、视频、字幕、封面、简介、章节时间轴）才有 */
  variant?: Orientation
  /** 封面：封面本身的比例，和舞台方向分开；没记的按 variant 的默认比例算（coverRatioOf） */
  ratio?: CoverRatio
  /** 封面这种一个比例出好几个版本的：同一封面比例里第几个版本 */
  option?: number
  /** 字幕：语言 */
  lang?: string
  version: number
  status: ArtifactStatus
  /** 音频、视频：秒 */
  duration?: number
  /** 是谁产出的 */
  source: { type: 'manual' | 'sop' | 'agent' | 'skill'; label: string }
  reviews: Review[]
  /** 封面：同一舞台方向、同一封面比例里选用的那张 */
  picked?: boolean
  /** 封面：A/B 测试输掉的归档，留着不删 */
  archived?: boolean
  created_at: string
}

export type CheckpointState = 'pending' | 'passed' | 'rejected' | 'skipped'
export interface Checkpoint { stage: StageKey; state: CheckpointState; at?: string; note?: string }

export type PlatformKey = 'bilibili' | 'youtube' | 'douyin' | 'channels' | 'xiaohongshu'
/** cover：平台收的封面比例，第一个是推荐的；新建发布只列这些比例的封面，发布时不符合就失败 */
export const PLATFORMS: { key: PlatformKey; label: string; color: string; prefer: Orientation; cover: CoverRatio[] }[] = [
  { key: 'bilibili', label: 'B 站', color: '#fb7299', prefer: 'landscape', cover: ['16x9', '4x3'] },
  { key: 'youtube', label: 'YouTube', color: '#ff0033', prefer: 'landscape', cover: ['16x9'] },
  { key: 'douyin', label: '抖音', color: '#161823', prefer: 'portrait', cover: ['3x4', '9x16'] },
  { key: 'channels', label: '视频号', color: '#07c160', prefer: 'portrait', cover: ['9x16', '3x4'] },
  { key: 'xiaohongshu', label: '小红书', color: '#ff2442', prefer: 'portrait', cover: ['3x4', '1x1'] },
]

/** 发布平台对应的连接器（data.ts 的工具 key）；没接入的平台只能手动登记 */
export const PLATFORM_TOOL: Record<PlatformKey, string> = { bilibili: 'bilibili', youtube: 'youtube', douyin: 'douyin', channels: 'channels', xiaohongshu: 'xiaohongshu' }

export type PublishStatus = 'planned' | 'scheduled' | 'published' | 'failed'
export const PUBLISH_STATUS: Record<PublishStatus, { label: string; color: string }> = {
  planned: { label: '计划中', color: '#a19d92' },
  scheduled: { label: '已定时', color: '#3d4fd6' },
  published: { label: '已发布', color: '#2f7d43' },
  failed: { label: '发布失败', color: '#c0352b' },
}

/** 播放数据：前四个各平台都有；后面的是平台通用的扩展字段，平台不提供的留空 */
export interface Metrics {
  views: number; likes: number; comments: number; shares: number
  /** 曝光 */
  impressions?: number
  /** 点击率 0-1 */
  ctr?: number
  avg_watch_sec?: number
  /** 完播率 0-1 */
  completion?: number
  favorites?: number
  /** B 站投币 */
  coins?: number
  followers_gained?: number
  updated_at: string
}
/** 每次拉取或回填存一条，不覆盖；Publish.metrics 是最新一条 */
export interface MetricSnapshot extends Metrics {
  publish_id: string
  /** 发布后第几天，满一天算 1 */
  day: number
  source: 'manual' | 'connector'
}
/** 发布详情曲线上标出的几天 */
export const SNAPSHOT_DAYS = [1, 3, 7, 30]
/** 发布后第几天：满一天算 1，不足一天也算 1 */
export const dayAfter = (published_at: string, at = new Date().toISOString()) => Math.max(1, Math.floor((Date.parse(at) - Date.parse(published_at)) / 86400000))

/** 平台账号：一个平台可以接几个账号，打角色；封面 A/B 用的小号也挂在这里 */
export type ContentPlatformCap = 'upload' | 'schedule' | 'metrics' | 'comments' | 'reply' | 'dm'
export type AccountRole = 'main' | 'ab' | 'client'
export const ACCOUNT_ROLE: Record<AccountRole, { label: string; color: string }> = {
  main: { label: '主号', color: '#3d4fd6' },
  ab: { label: 'A/B 小号', color: '#b0570b' },
  client: { label: '客户号', color: '#2f7d43' },
}
export interface PlatformAccount {
  id: string
  /** 对应的连接器（data.ts 的 seedConnectors）；没接连接器、手动登记的账号没有 */
  connector_id?: string
  platform: PlatformKey
  /** 平台昵称 / 频道名 */
  handle: string
  uid: string
  role: AccountRole
  /** 这个账号实际能做什么 */
  caps: ContentPlatformCap[]
  followers?: number
}

/** 平台发布规则：发布前按这个校验，有一项不过就不让发 */
export interface PlatformRule {
  platform: PlatformKey
  title_max: number
  desc_max: number
  tags_max: number
  /** 简介里能不能放外链 */
  allow_link: boolean
  cover: CoverRatio[]
  duration_max_sec?: number
  /** 分区 / 类别，平台要选的才有 */
  categories?: string[]
}
const coverOf = (k: PlatformKey) => PLATFORMS.find((p) => p.key === k)!.cover
export const PLATFORM_RULES: Record<PlatformKey, PlatformRule> = {
  bilibili: { platform: 'bilibili', title_max: 80, desc_max: 2000, tags_max: 10, allow_link: false, cover: coverOf('bilibili'), categories: ['知识', '科技', '生活'] },
  youtube: { platform: 'youtube', title_max: 100, desc_max: 5000, tags_max: 15, allow_link: true, cover: coverOf('youtube'), categories: ['教育', '科学和技术', '人物和博客'] },
  douyin: { platform: 'douyin', title_max: 30, desc_max: 1000, tags_max: 5, allow_link: false, cover: coverOf('douyin'), duration_max_sec: 900 },
  channels: { platform: 'channels', title_max: 30, desc_max: 1000, tags_max: 10, allow_link: false, cover: coverOf('channels'), duration_max_sec: 3600 },
  xiaohongshu: { platform: 'xiaohongshu', title_max: 20, desc_max: 1000, tags_max: 10, allow_link: false, cover: coverOf('xiaohongshu'), duration_max_sec: 900 },
}
export interface PublishCheck { key: string; ok: boolean; text: string }
/** 按平台规则校验一条待发布的内容；字数按字符算 */
export function checkPublish(k: PlatformKey, x: { title: string; desc: string; tags: string[]; cover?: CoverRatio; duration?: number }): PublishCheck[] {
  const r = PLATFORM_RULES[k]
  const p = PLATFORMS.find((pl) => pl.key === k)!
  const len = (s: string) => [...s.trim()].length
  const out: PublishCheck[] = [
    { key: 'title', ok: len(x.title) <= r.title_max, text: len(x.title) <= r.title_max ? `标题 ${len(x.title)} / ${r.title_max} 字` : `标题超长：${p.label}最多 ${r.title_max} 字，现在 ${len(x.title)} 字` },
    { key: 'desc', ok: len(x.desc) <= r.desc_max, text: len(x.desc) <= r.desc_max ? `简介 ${len(x.desc)} / ${r.desc_max} 字` : `简介超长：${p.label}最多 ${r.desc_max} 字，现在 ${len(x.desc)} 字` },
    { key: 'tags', ok: x.tags.length <= r.tags_max, text: x.tags.length <= r.tags_max ? `标签 ${x.tags.length} / ${r.tags_max} 个` : `标签太多：${p.label}最多 ${r.tags_max} 个，现在 ${x.tags.length} 个` },
  ]
  if (!r.allow_link) {
    const link = /https?:\/\/|www\./i.test(x.desc)
    out.push({ key: 'link', ok: !link, text: link ? `简介带外链：${p.label}不允许放链接` : '简介没有外链' })
  }
  if (x.cover) {
    const ok = r.cover.includes(x.cover)
    out.push({ key: 'cover', ok, text: ok ? `封面 ${COVER_RATIO[x.cover].label} 符合要求` : `封面比例不对：${p.label}要 ${r.cover.map((c) => COVER_RATIO[c].label).join(' 或 ')}` })
  }
  if (r.duration_max_sec && x.duration) {
    const ok = x.duration <= r.duration_max_sec
    out.push({ key: 'duration', ok, text: ok ? `时长 ${Math.ceil(x.duration / 60)} 分钟，没超过 ${r.duration_max_sec / 60} 分钟` : `时长超出：${p.label}最长 ${r.duration_max_sec / 60} 分钟` })
  }
  return out
}

export interface Publish {
  id: string
  video_id: string
  platform: PlatformKey
  variant: Orientation
  /** 用的哪张封面（Artifact id） */
  cover_id?: string
  title: string
  desc: string
  status: PublishStatus
  scheduled_at?: string
  published_at?: string
  url?: string
  error?: string
  metrics?: Metrics
  /** 用哪个平台账号发的（PlatformAccount.id） */
  account_id?: string
  tags?: string[]
  /** 分区 */
  category?: string
  /** 合集 / 播放列表 */
  collection?: string
  /** 发布前的校验结果，新建时按 PLATFORM_RULES 记下 */
  checks?: PublishCheck[]
}

/** 封面 A/B 测试：一次挂 2 到 5 张封面，每张对应一条发布（小号分发）或平台原生测试的一组 */
export type CoverTestMode = 'native' | 'accounts' | 'utm'
export const COVER_TEST_MODE: Record<CoverTestMode, { label: string; desc: string }> = {
  native: { label: '平台原生测试', desc: '同一条发布，平台轮换封面（YouTube 缩略图测试）' },
  accounts: { label: '小号分发', desc: '主号和 A/B 小号各发一版，每版一张封面' },
  utm: { label: '分链接', desc: '同一条发布，不同投放链接配不同封面' },
}
export type CoverTestStatus = 'running' | 'decided' | 'inconclusive'
export const COVER_TEST_STATUS: Record<CoverTestStatus, { label: string; color: string }> = {
  running: { label: '进行中', color: '#3d4fd6' },
  decided: { label: '已决出', color: '#2f7d43' },
  inconclusive: { label: '没有结论', color: '#a19d92' },
}
export interface CoverTestArm {
  cover_id: string
  /** 小号分发：这一版对应的发布；曝光、点击率从它的 metrics 读 */
  publish_id?: string
  /** 平台原生测试：平台按封面分开给的曝光、点击率 */
  impressions?: number
  ctr?: number
}
export interface CoverTest {
  id: string
  video_id: string
  platform: PlatformKey
  mode: CoverTestMode
  arms: CoverTestArm[]
  started_at: string
  ended_at?: string
  /** 至少观察几天，默认 7 */
  min_days: number
  /** 每张至少多少曝光，默认 10000 */
  min_impressions: number
  /** 点击率领先第二名多少才算显著，默认 0.2 */
  min_gap: number
  /** 胜出的封面（Artifact id） */
  winner_id?: string
  status: CoverTestStatus
}
/** 封面 A/B 判定规则（COVER.md Part 7）：每张曝光到线、天数到线、点击率第一领先第二到线 */
export function coverTestState(t: CoverTest, arms: { cover_id: string; impressions?: number; ctr?: number }[], now = new Date().toISOString()) {
  const days = dayAfter(t.started_at, t.ended_at ?? now)
  const ranked = [...arms].filter((a) => a.ctr != null).sort((a, b) => (b.ctr ?? 0) - (a.ctr ?? 0))
  const gap = ranked.length >= 2 && (ranked[1].ctr ?? 0) > 0 ? (ranked[0].ctr ?? 0) / (ranked[1].ctr ?? 1) - 1 : undefined
  const reached = arms.filter((a) => (a.impressions ?? 0) >= t.min_impressions).length
  return {
    days, gap, reached, leader: ranked[0]?.cover_id,
    daysOk: days >= t.min_days, impOk: arms.length > 0 && reached === arms.length, gapOk: gap != null && gap >= t.min_gap,
  }
}

export interface Series {
  id: string
  name: string
  desc: string
  /** 共用的开场、收尾、模板（路径或说明） */
  intro: string
  outro: string
  template: string
  /** 改过共用部分但还没同步到的集（视频 id） */
  stale: string[]
  /** 配音（TTS-01）：音色和语速，空音色用「语音合成」插件的默认音色 */
  voice?: string
  voice_speed?: number
}

/** 阶段执行器：这一步交给谁跑（技能、SOP、Agent）；检查点仍由人确认，执行器只把产出物推到待验收 */
export type RunnerType = 'skill' | 'sop' | 'agent'
export interface StageRunner {
  stage: StageKey
  type: RunnerType
  /** 技能 id（agentdata 的 SKILLS）、SOP id（sopflow 的 SOPS）或 Agent id（agentdata 的 seedAgents） */
  ref_id: string
  /** 交代给它的话 */
  prompt?: string
}
export type RunState = 'running' | 'done' | 'failed'
/** 最近一次执行：技能和 Agent 都按 Agent 运行记，SOP 按 SOP 执行记录 */
export interface LastRun {
  type: 'agent' | 'sop'
  /** 指向 AgentRun 或 SopRun */
  id: string
  stage: StageKey
  status: RunState
  started_at: string
  ended_at?: string
  /** 失败原因 */
  error?: string
  /** 这次登记或升版的产出物 */
  artifact_ids?: string[]
}

export interface Video {
  id: string
  title: string
  project_id?: string
  series_id?: string
  episode?: number
  /** 要出哪几个比例；规划检查通过后锁定 */
  orientations: Orientation[]
  stage: StageKey
  checkpoints: Checkpoint[]
  /** 视频项目目录 */
  root: string
  /** 章节数 */
  chapters: number
  /** 各阶段配的执行器，一个阶段最多一个 */
  runners?: StageRunner[]
  last_run?: LastRun
  /** 计划首发日 YYYY-MM-DD：排内容日历、算制作进度落不落后 */
  target_date?: string
  /** 来自哪个选题（topicdata 的 Topic.id）；选题那边记着 video_id */
  topic_id?: string
  created_at: string
  updated_at: string
}

/** 视频状态一句话：在哪个阶段、有没有卡在检查点上 */
export function videoState(v: Video): { label: string; tone: 'ok' | 'warn' | 'info' | 'muted' } {
  if (v.stage === 'distribution' && v.checkpoints.find((c) => c.stage === 'distribution')?.state === 'passed') return { label: '已完成', tone: 'ok' }
  const cp = STAGES.find((s) => s.key === v.stage)?.checkpoint && v.checkpoints.find((c) => c.stage === v.stage)
  if (cp && cp.state === 'pending') return { label: `待${STAGES.find((s) => s.key === v.stage)!.label}`, tone: 'warn' }
  if (cp && cp.state === 'rejected') return { label: '退回修改', tone: 'warn' }
  return { label: STAGES.find((s) => s.key === v.stage)!.label, tone: 'info' }
}

const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString()
const day = 60 * 24
const pad2 = (n: number) => String(n).padStart(2, '0')
/** 本地日期 YYYY-MM-DD */
export const localYmd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
/** 今天往后第 n 天（负数往前）的本地日期 */
const daysFromNow = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return localYmd(d) }
/** 今天往后第 n 天本地 hh:mm 的时刻 */
const atDay = (n: number, hm: string) => { const d = new Date(); d.setDate(d.getDate() + n); const [h, m] = hm.split(':').map(Number); d.setHours(h, m, 0, 0); return d.toISOString() }
/** 离下一个周三还有几天（今天是周三就算下周三）：AI 系列每周三更 */
const toWed = ((3 - new Date().getDay() + 7) % 7) || 7
// 视频时间线：from = 视频创建，to = 最后一个已过阶段的时刻（都写成「多少分钟前」，to 不晚于 updated_at）
// 检查点按阶段在 from 和 to 之间排开，分发包检查点正好落在 to；产出物落在所属阶段的中段，早于该阶段的检查点
type Span = [from: number, to: number]
const stageAt = ([from, to]: Span, k: StageKey, frac = 1) => minsAgo(from - ((from - to) * (stageIndex(k) + frac)) / STAGES.length)
const cps = (passed: StageKey[], span: Span): Checkpoint[] => STAGES.filter((s) => s.checkpoint).map((s) => ({
  stage: s.key,
  state: passed.includes(s.key) ? 'passed' : 'pending',
  at: passed.includes(s.key) ? stageAt(span, s.key) : undefined,
}))
const SPAN: Record<string, Span> = { vd1: [day * 20, day * 7], vd2: [day * 5, 60 * 4], vd3: [day * 1, 60 * 2], vd4: [day * 8, 60 * 21], vd5: [day * 40, day * 11] }
// AI 系列：第 ep 集的创建时间和最近更新时间（分钟前）；to 比 updated 早一小时
const aiCreated = (ep: number) => day * (70 - ep * 2)
const aiUpdated = (ep: number) => day * Math.max(0, 33 - ep) + ep * 7
const AI_DONE = 18
/** 做过封面 A/B 的那一集 */
const AB_EP = 15

export const seedSeries: Series[] = [
  {
    id: 'sr_pmw', name: '一人之下 10 分钟上手', desc: '每集 10 分钟讲清一个模块，B 站横屏 + 视频号竖屏两版', intro: 'shared/intro-v2.tsx（5 秒标志动画）',
    outro: 'shared/outro.tsx（关注引导 + 下集预告）', template: 'templates/pmw-theme（暖灰主题）', stale: ['vd3'],
  },
  {
    id: 'sr_ai', name: 'AI 工具 100 讲', desc: '每集 5 分钟讲一个 AI 工具的真实用法，竖屏为主，每周三更', intro: 'shared/ai100-intro.tsx（3 秒片头）',
    outro: 'shared/ai100-outro.tsx（下集预告 + 关注）', template: 'templates/ai100（深色科技主题）', stale: ['ai_29', 'ai_30'],
  },
]

// 一个 32 集的长系列：前面的已完成，中间几集卡在各个阶段，后面的还在写稿
const AI_TOPICS = ['ChatGPT 写周报', 'Claude 读长文档', 'Cursor 改代码', 'Midjourney 出封面', 'Notion AI 整理会议', 'Perplexity 做调研', 'Kimi 读 PDF', '豆包做配音',
  '剪映 AI 字幕', 'Runway 生成空镜', 'Suno 写片头音乐', 'Gamma 做演示', 'Napkin 画图解', 'Whisper 转写访谈', 'DeepSeek 写 SQL', '通义听悟记笔记',
  'Copilot 写单测', 'v0 出界面', 'Bolt 搭原型', 'Dify 编工作流', 'Coze 做机器人', 'Ollama 本地跑模型', 'LM Studio 对比模型', 'Raycast AI 快捷指令',
  'Arc 浏览器 AI', 'Granola 会议纪要', 'Descript 剪口播', 'HeyGen 数字人', 'ElevenLabs 克隆声音', 'Recraft 做图标', 'Krea 实时出图', 'NotebookLM 做播客']
// 还没做完的集配好执行器：每一步都交给 web-video-presentation 技能跑，人只管检查点
const AI_RUNNERS: StageRunner[] = [
  { stage: 'script', type: 'skill', ref_id: 'sk_video', prompt: '按 Phase 1 出竖版口播稿和大纲' },
  { stage: 'web', type: 'skill', ref_id: 'sk_video', prompt: '套 templates/ai100 搭竖屏演示工程，第 1 章做完整' },
  { stage: 'chapters', type: 'skill', ref_id: 'sk_video', prompt: '照第 1 章的样板并行做第 2 到 N 章' },
  { stage: 'record', type: 'skill', ref_id: 'sk_video', prompt: '程序化录屏合成 mp4，按章节时间点出字幕' },
]
function aiSeries(): Video[] {
  return AI_TOPICS.map((t, i) => {
    const ep = i + 1
    const stage: StageKey = ep <= AI_DONE ? 'distribution' : ep <= 20 ? 'record' : ep === 21 ? 'audio' : ep <= 23 ? 'chapters' : ep <= 26 ? 'ch1' : ep === 27 ? 'web' : ep === 28 ? 'plan' : 'script'
    const passed = (STAGES.filter((s) => s.checkpoint).map((s) => s.key) as StageKey[]).filter((k) => stageIndex(k) < stageIndex(stage) || (ep <= AI_DONE && k === 'distribution'))
    const id = `ai_${String(ep).padStart(2, '0')}`
    SPAN[id] = [aiCreated(ep), aiUpdated(ep) + 60]
    const checkpoints = cps(passed, SPAN[id])
    // 第 25 集第一章被退回
    if (ep === 25) checkpoints.find((c) => c.stage === 'ch1')!.state = 'rejected'
    // 第 27 集网页开发跑失败了：预览端口被占，等人处理后重试
    const last_run: LastRun | undefined = ep === 27 ? {
      type: 'agent', id: 'ar_ai27web', stage: 'web', status: 'failed', started_at: minsAgo(aiUpdated(ep) + 6), ended_at: minsAgo(aiUpdated(ep) + 4),
      error: '预览端口 7801 被占用，演示工程起不来；关掉占用端口的进程后重试',
    } : undefined
    return {
      id, title: `第 ${ep} 集：${t}`, series_id: 'sr_ai', episode: ep, orientations: ['portrait'], stage, checkpoints,
      root: `videos/ai100/ep${String(ep).padStart(2, '0')}`, chapters: 3, runners: ep > AI_DONE ? AI_RUNNERS : undefined, last_run,
      // 已开工的第 19 到 26 集排好了每周三首发，再往后的还没排
      target_date: ep >= 19 && ep <= 26 ? daysFromNow(toWed + (ep - 19) * 7) : undefined,
      created_at: minsAgo(aiCreated(ep)), updated_at: minsAgo(aiUpdated(ep)),
    }
  })
}

export const seedVideos: Video[] = [
  { id: 'vd1', title: '第 1 集：今日待办一页清', project_id: 'pj_pmw', series_id: 'sr_pmw', episode: 1, orientations: ['landscape', 'portrait'], stage: 'distribution', checkpoints: cps(['plan', 'ch1', 'audio', 'distribution'], SPAN.vd1), root: 'videos/ep01-today', chapters: 5, created_at: minsAgo(day * 20), updated_at: minsAgo(day * 6) },
  { id: 'vd2', title: '第 2 集：SOP 编排像搭积木', project_id: 'pj_pmw', series_id: 'sr_pmw', episode: 2, orientations: ['landscape', 'portrait'], stage: 'ch1', checkpoints: cps(['plan'], SPAN.vd2), root: 'videos/ep02-sop', chapters: 6, target_date: daysFromNow(4), created_at: minsAgo(day * 5), updated_at: minsAgo(60 * 3) },
  { id: 'vd3', title: '第 3 集：Agent 怎么配才放心', project_id: 'pj_pmw', series_id: 'sr_pmw', episode: 3, orientations: ['landscape'], stage: 'script', checkpoints: cps([], SPAN.vd3), root: 'videos/ep03-agent', chapters: 4, target_date: daysFromNow(16),
    runners: [{ stage: 'script', type: 'sop', ref_id: 'sop_video_weekly', prompt: '从原文出口播稿和大纲，跑到规划检查停下' }], created_at: minsAgo(day * 1), updated_at: minsAgo(90) },
  ...aiSeries(),
  // 远川的两支商单片：试点上线短片已交付发布，权限改造演示片在录屏
  { id: 'vd4', title: '远川权限改造演示片', project_id: 'pj_perm', orientations: ['landscape'], stage: 'record', checkpoints: cps(['plan', 'ch1', 'audio'], SPAN.vd4), root: 'demo-video', chapters: 3, target_date: daysFromNow(6), created_at: minsAgo(day * 8), updated_at: minsAgo(60 * 20) },
  { id: 'vd5', title: '远川科技试点上线短片', project_id: 'pj_perm', orientations: ['landscape'], stage: 'distribution', checkpoints: cps(['plan', 'ch1', 'audio', 'distribution'], SPAN.vd5), root: 'videos/yc-pilot', chapters: 3, target_date: daysFromNow(-10), created_at: minsAgo(day * 40), updated_at: minsAgo(day * 10) },
]

let n = 0
const art = (video_id: string, kind: ArtifactKind, name: string, path: string, status: ArtifactStatus, extra: Partial<Artifact> = {}): Artifact => ({
  id: `af${(n += 1)}`, video_id, kind, name, path, status, version: 1, source: { type: 'skill', label: 'web-video-presentation' }, reviews: [], created_at: stageAt(SPAN[video_id], ARTIFACT_KIND[kind].stage, 0.5), ...extra,
})

// 双方向的集：文稿、简介、章节时间轴横竖各一套，各自验收；封面按封面比例分开登记
const both = (video_id: string, kind: ArtifactKind, name: string, ext: string, status: ArtifactStatus, extra: Partial<Record<Orientation, Partial<Artifact>>> = {}) =>
  (['landscape', 'portrait'] as Orientation[]).map((o) => art(video_id, kind, name, `${kind}-${o}.${ext}`, status, { variant: o, ...extra[o] }))

export const seedArtifacts: Artifact[] = [
  art('vd1', 'article', '原文', 'article.md', 'final'),
  ...both('vd1', 'script', '口播稿', 'md', 'final', {
    landscape: { version: 3, reviews: [{ at: minsAgo(day * 18.5), ok: false, comment: '第 3 段太长，拆成两屏' }, { at: minsAgo(day * 18), ok: true, comment: '可以' }] },
    portrait: { version: 2, reviews: [{ at: minsAgo(day * 18.4), ok: false, comment: '竖版一屏字太多，每屏压到 40 字以内' }, { at: minsAgo(day * 17.9), ok: true, comment: '可以' }] },
  }),
  ...both('vd1', 'outline', '大纲', 'md', 'final'),
  art('vd1', 'presentation', '演示工程', 'presentation-landscape', 'final', { variant: 'landscape' }),
  art('vd1', 'presentation', '演示工程', 'presentation-portrait', 'final', { variant: 'portrait' }),
  art('vd1', 'audio', '口播音频（5 章）', 'audio/', 'final', { duration: 598 }),
  art('vd1', 'video', '成片', 'out/ep01-16x9.mp4', 'published', { variant: 'landscape', duration: 602 }),
  art('vd1', 'video', '成片', 'out/ep01-9x16.mp4', 'published', { variant: 'portrait', duration: 602 }),
  art('vd1', 'subtitle', '字幕', 'subtitle/ep01-16x9.srt', 'final', { variant: 'landscape', lang: 'zh' }),
  art('vd1', 'subtitle', '字幕', 'subtitle/ep01-9x16.srt', 'final', { variant: 'portrait', lang: 'zh' }),
  ...[1, 2, 3, 4, 5].map((o) => art('vd1', 'cover', `封面 ${o}`, `cover/16x9-${o}.png`, o === 2 ? 'published' : 'final', { variant: 'landscape', ratio: '16x9', option: o, picked: o === 2 })),
  // 竖版第 1 张主号发了视频号，第 3、4 张给两个 A/B 小号发，封面测试还在跑
  ...[1, 2, 3, 4, 5].map((o) => art('vd1', 'cover', `封面 ${o}`, `cover/9x16-${o}.png`, [1, 3, 4].includes(o) ? 'published' : 'final', { variant: 'portrait', ratio: '9x16', option: o, picked: o === 1 })),
  // 1:1 那张先拿去发了抖音，被打回；之后补了一张 3:4，换上就能重试
  art('vd1', 'cover', '封面 1', 'cover/1x1-1.png', 'final', { variant: 'portrait', ratio: '1x1', option: 1 }),
  art('vd1', 'cover', '封面 1', 'cover/3x4-1.png', 'final', { variant: 'portrait', ratio: '3x4', option: 1, picked: true, created_at: minsAgo(day * 4) }),
  ...both('vd1', 'description', '简介', 'md', 'final'),
  ...both('vd1', 'chapters', '章节时间轴', 'md', 'final'),
  ...both('vd2', 'script', '口播稿', 'md', 'final', { landscape: { version: 2 } }),
  ...both('vd2', 'outline', '大纲', 'md', 'final'),
  art('vd2', 'presentation', '演示工程（第 1 章）', 'presentation-landscape', 'review', { variant: 'landscape', source: { type: 'skill', label: 'web-video-presentation' } }),
  art('vd2', 'presentation', '演示工程（第 1 章）', 'presentation-portrait', 'draft', { variant: 'portrait' }),
  art('vd3', 'script', '口播稿', 'script-landscape.md', 'draft', { variant: 'landscape', source: { type: 'manual', label: '手写' } }),
  art('vd4', 'script', '口播稿', 'script-landscape.md', 'final', { variant: 'landscape' }),
  // 演示工程给远川的许知行看过（外部审核人）
  art('vd4', 'presentation', '演示工程', 'presentation-landscape', 'final', { variant: 'landscape', reviews: [{ at: minsAgo(day * 3), ok: true, comment: '部门自定义角色那段讲清楚了，按这个往下录', by: { type: 'contact', id: 'ct_005' } }] }),
  art('vd4', 'audio', '口播音频（3 章）', 'audio/', 'final', { duration: 214 }),
  // AI 系列已完成的集：成片、选用的封面、简介，都已随视频号发布
  // 第 15 集做过封面 A/B：三张各发一个号，第 2 张胜出成了主封面，另两张归档
  ...seedVideos.filter((v) => v.series_id === 'sr_ai' && (v.episode ?? 0) <= AI_DONE).flatMap((v) => {
    const ep = String(v.episode).padStart(2, '0')
    const ab = v.episode === AB_EP
    return [
      art(v.id, 'video', '成片', `out/ep${ep}-9x16.mp4`, 'published', { variant: 'portrait', duration: 290 + ((v.episode ?? 0) * 7) % 40 }),
      art(v.id, 'cover', '封面 1', `cover/9x16-1.png`, 'published', { variant: 'portrait', ratio: '9x16', option: 1, picked: !ab, archived: ab || undefined }),
      ...(ab ? [
        art(v.id, 'cover', '封面 2', `cover/9x16-2.png`, 'published', { variant: 'portrait', ratio: '9x16', option: 2, picked: true }),
        art(v.id, 'cover', '封面 3', `cover/9x16-3.png`, 'published', { variant: 'portrait', ratio: '9x16', option: 3, archived: true }),
      ] : []),
      art(v.id, 'description', '简介', 'description-portrait.md', 'final', { variant: 'portrait' }),
    ]
  }),
  // 远川试点上线短片：成片由远川的许知行验收，退回过一次
  art('vd5', 'script', '口播稿', 'script-landscape.md', 'final', { variant: 'landscape' }),
  art('vd5', 'presentation', '演示工程', 'presentation-landscape', 'final', { variant: 'landscape' }),
  art('vd5', 'video', '成片', 'out/yc-pilot-16x9.mp4', 'published', { variant: 'landscape', duration: 186, version: 2,
    reviews: [{ at: minsAgo(day * 12.5), ok: false, comment: '片尾加上远川的标志和官网地址', by: { type: 'contact', id: 'ct_005' } }, { at: minsAgo(day * 12), ok: true, comment: '可以上线', by: { type: 'contact', id: 'ct_005' } }] }),
  art('vd5', 'cover', '封面 1', 'cover/16x9-1.png', 'published', { variant: 'landscape', ratio: '16x9', option: 1, picked: true }),
  art('vd5', 'description', '简介', 'description-landscape.md', 'final', { variant: 'landscape' }),
]
/** 平台账号：主号都挂着设置里的连接器；视频号两个 A/B 小号和远川的客户号是手动登记的，只能回填数据 */
export const seedAccounts: PlatformAccount[] = [
  { id: 'pa_bili', connector_id: 'cn_bilibili', platform: 'bilibili', handle: '一人之下官方', uid: '3546721', role: 'main', caps: ['upload', 'schedule', 'metrics', 'comments', 'reply'], followers: 48200 },
  { id: 'pa_bili_yc', platform: 'bilibili', handle: '远川科技', uid: '1880342', role: 'client', caps: ['metrics'], followers: 12600 },
  { id: 'pa_yt', connector_id: 'cn_youtube', platform: 'youtube', handle: 'One Below Studio', uid: 'UC7oneBelow', role: 'main', caps: ['upload', 'schedule', 'metrics', 'comments', 'reply'], followers: 3100 },
  { id: 'pa_dy', connector_id: 'cn_douyin', platform: 'douyin', handle: '一人之下', uid: 'yirenzhixia', role: 'main', caps: ['upload', 'metrics', 'comments', 'reply'], followers: 21500 },
  { id: 'pa_ch', connector_id: 'cn_channels', platform: 'channels', handle: '一人之下', uid: 'sphAbc01', role: 'main', caps: ['metrics', 'comments'], followers: 9800 },
  { id: 'pa_ch_a', platform: 'channels', handle: '一人之下·试封面 A', uid: 'sphAbc02', role: 'ab', caps: ['metrics'], followers: 640 },
  { id: 'pa_ch_b', platform: 'channels', handle: '一人之下·试封面 B', uid: 'sphAbc03', role: 'ab', caps: ['metrics'], followers: 410 },
]

/** 第 1 集某个封面比例的第几版 */
const vd1Cover = (ratio: CoverRatio, option: number) => seedArtifacts.find((a) => a.video_id === 'vd1' && a.kind === 'cover' && a.ratio === ratio && a.option === option)?.id
/** 某一集竖版 9:16 的第几版封面 */
const aiCover = (videoId: string, option: number) => seedArtifacts.find((a) => a.video_id === videoId && a.kind === 'cover' && a.option === option)?.id
const abVideo = `ai_${String(AB_EP).padStart(2, '0')}`
/** 曝光和点击率给定时，播放按两者相乘算 */
const byCtr = (impressions: number, ctr: number) => ({ impressions, ctr, views: Math.round(impressions * ctr) })

export const seedPublishes: Publish[] = [
  { id: 'pb1', video_id: 'vd1', platform: 'bilibili', variant: 'landscape', cover_id: vd1Cover('16x9', 2), title: '一人之下 10 分钟上手 01｜今日待办一页清', desc: '把散在各处的待办收到一页……', status: 'published', published_at: minsAgo(day * 6), url: 'https://www.bilibili.com/video/BV1xx',
    account_id: 'pa_bili', tags: ['效率工具', '待办', '产品经理'], category: '知识', collection: '一人之下 10 分钟上手',
    metrics: { views: 12840, likes: 931, comments: 87, shares: 64, impressions: 168900, ctr: 0.076, avg_watch_sec: 318, completion: 0.34, favorites: 612, coins: 248, followers_gained: 386, updated_at: minsAgo(60 * 5) } },
  { id: 'pb2', video_id: 'vd1', platform: 'channels', variant: 'portrait', cover_id: vd1Cover('9x16', 1), title: '今日待办一页清', desc: '一页看完今天要处理的事', status: 'published', published_at: minsAgo(day * 5), url: 'https://channels.weixin.qq.com/web/pages/feed?id=ep01today',
    account_id: 'pa_ch', metrics: { views: 3420, likes: 210, comments: 12, shares: 35, impressions: 41200, ctr: 0.083, avg_watch_sec: 141, completion: 0.22, followers_gained: 58, updated_at: minsAgo(60 * 30) } },
  // 两个 A/B 小号同一时间各发一版，只换封面
  { id: 'pb2a', video_id: 'vd1', platform: 'channels', variant: 'portrait', cover_id: vd1Cover('9x16', 3), title: '今日待办一页清', desc: '一页看完今天要处理的事', status: 'published', published_at: minsAgo(day * 5), url: 'https://channels.weixin.qq.com/web/pages/feed?id=ep01today-a',
    account_id: 'pa_ch_a', metrics: { ...byCtr(12600, 0.071), likes: 41, comments: 3, shares: 6, avg_watch_sec: 137, completion: 0.21, updated_at: minsAgo(60 * 30) } },
  { id: 'pb2b', video_id: 'vd1', platform: 'channels', variant: 'portrait', cover_id: vd1Cover('9x16', 4), title: '今日待办一页清', desc: '一页看完今天要处理的事', status: 'published', published_at: minsAgo(day * 5), url: 'https://channels.weixin.qq.com/web/pages/feed?id=ep01today-b',
    account_id: 'pa_ch_b', metrics: { ...byCtr(8900, 0.102), likes: 52, comments: 4, shares: 9, avg_watch_sec: 144, completion: 0.23, updated_at: minsAgo(60 * 30) } },
  { id: 'pb3', video_id: 'vd1', platform: 'douyin', variant: 'portrait', cover_id: vd1Cover('1x1', 1), title: '今日待办一页清', desc: '', status: 'failed', scheduled_at: minsAgo(day * 5), error: '封面比例不符合要求：抖音要 3:4 或 9:16，这次用的是 1:1', account_id: 'pa_dy' },
  { id: 'pb4', video_id: 'vd1', platform: 'youtube', variant: 'landscape', cover_id: vd1Cover('16x9', 2), title: 'One Page for Today', desc: '', status: 'scheduled', scheduled_at: new Date(Date.now() + day * 60000 * 2).toISOString(), account_id: 'pa_yt', category: '教育' },
  // 第 2 集：B 站已定时、视频号计划发，第一章还没验收，日历上标红
  { id: 'pb5', video_id: 'vd2', platform: 'bilibili', variant: 'landscape', title: '一人之下 10 分钟上手 02｜SOP 编排像搭积木', desc: '把重复的活编成 SOP，一步步跑', status: 'scheduled', scheduled_at: atDay(4, '20:00'),
    account_id: 'pa_bili', tags: ['效率工具', 'SOP', '自动化'], category: '知识', collection: '一人之下 10 分钟上手' },
  { id: 'pb6', video_id: 'vd2', platform: 'channels', variant: 'portrait', title: 'SOP 编排像搭积木', desc: '把重复的活编成 SOP', status: 'planned', scheduled_at: atDay(5, '12:00'), account_id: 'pa_ch' },
  // AI 系列接下来两集：视频号只能手动登记，先排成计划
  { id: 'pb_ai19', video_id: 'ai_19', platform: 'channels', variant: 'portrait', title: `AI 工具 100 讲 19｜${AI_TOPICS[18]}`, desc: '5 分钟讲一个 AI 工具的真实用法', status: 'planned', scheduled_at: atDay(toWed, '20:00'), account_id: 'pa_ch', collection: 'AI 工具 100 讲' },
  { id: 'pb_ai20', video_id: 'ai_20', platform: 'channels', variant: 'portrait', title: `AI 工具 100 讲 20｜${AI_TOPICS[19]}`, desc: '5 分钟讲一个 AI 工具的真实用法', status: 'planned', scheduled_at: atDay(toWed + 7, '20:00'), account_id: 'pa_ch', collection: 'AI 工具 100 讲' },
  // 远川试点上线短片发在远川自己的 B 站号，数据由远川给截图回填
  { id: 'pb_yc1', video_id: 'vd5', platform: 'bilibili', variant: 'landscape', cover_id: seedArtifacts.find((a) => a.video_id === 'vd5' && a.kind === 'cover')?.id, title: '远川科技｜部门权限试点上线了', desc: '远川科技用一人之下把权限按部门管起来的第一个月', status: 'published', published_at: minsAgo(day * 10), url: 'https://www.bilibili.com/video/BV1yc',
    account_id: 'pa_bili_yc', tags: ['企业服务', '权限'], category: '科技',
    metrics: { views: 8640, likes: 402, comments: 37, shares: 51, impressions: 98200, ctr: 0.088, avg_watch_sec: 121, completion: 0.41, favorites: 233, coins: 96, followers_gained: 140, updated_at: minsAgo(60 * 6) } },
  // AI 系列：每集分发包通过后两小时发视频号
  ...seedVideos.filter((v) => v.series_id === 'sr_ai' && (v.episode ?? 0) <= AI_DONE).map((v, i): Publish => {
    const ep = v.episode ?? 0
    const at = SPAN[v.id][1] - 120
    const cover = seedArtifacts.find((a) => a.video_id === v.id && a.kind === 'cover')
    const views = 2600 + ((ep * 1373) % 5200) + i * 90
    const ctr = ep === AB_EP ? 0.061 : 0.058 + ((ep * 7) % 5) / 100
    return {
      id: `pb_ai${String(ep).padStart(2, '0')}`, video_id: v.id, platform: 'channels', variant: 'portrait', cover_id: cover?.id, title: `AI 工具 100 讲 ${String(ep).padStart(2, '0')}｜${AI_TOPICS[ep - 1]}`,
      desc: '5 分钟讲一个 AI 工具的真实用法', status: 'published', published_at: minsAgo(at), url: `https://channels.weixin.qq.com/web/pages/feed?id=ai100ep${String(ep).padStart(2, '0')}`,
      account_id: 'pa_ch', collection: 'AI 工具 100 讲',
      metrics: { views, likes: 120 + ((ep * 37) % 260), comments: 8 + ((ep * 11) % 40), shares: 15 + ((ep * 13) % 70),
        impressions: Math.round(views / ctr), ctr, avg_watch_sec: 120 + ((ep * 17) % 60), completion: 0.28 + ((ep * 3) % 12) / 100, followers_gained: 20 + ((ep * 19) % 90), updated_at: minsAgo(60 * 2) },
    }
  }),
]
// 第 15 集的两个小号版本，和主号同一时间发
{
  const main = seedPublishes.find((p) => p.video_id === abVideo)!
  const arm = (id: string, option: number, account: string, m: ReturnType<typeof byCtr>, likes: number): Publish => ({
    ...main, id, cover_id: aiCover(abVideo, option), account_id: account, url: `${main.url}-${id.slice(-1)}`,
    metrics: { ...m, likes, comments: Math.round(likes / 12), shares: Math.round(likes / 6), avg_watch_sec: main.metrics!.avg_watch_sec, completion: main.metrics!.completion, updated_at: main.metrics!.updated_at },
  })
  seedPublishes.splice(seedPublishes.indexOf(main) + 1, 0, arm(`pb_ai${AB_EP}a`, 2, 'pa_ch_a', byCtr(21400, 0.092), 96), arm(`pb_ai${AB_EP}b`, 3, 'pa_ch_b', byCtr(18700, 0.058), 47))
}

/** 按天快照：有数据的发布在第 1、3、7、30 天和最近一次各一条，最近一条就是 Publish.metrics；第 1 集 B 站第 1 天是手动回填的 */
const grow = (d: number) => 1 - 0.8 * Math.exp(-d / 3.5)
export const seedSnapshots: MetricSnapshot[] = seedPublishes.filter((p) => p.metrics && p.published_at).flatMap((p) => {
  const m = p.metrics!
  const last = dayAfter(p.published_at!, m.updated_at)
  const days = [...SNAPSHOT_DAYS.filter((d) => d < last), last]
  return days.map((d): MetricSnapshot => {
    const f = grow(d) / grow(last)
    const n = (x?: number) => (x == null ? undefined : Math.round(x * f))
    return {
      publish_id: p.id, day: d, source: p.id === 'pb1' && d === 1 ? 'manual' : 'connector',
      views: n(m.views)!, likes: n(m.likes)!, comments: n(m.comments)!, shares: n(m.shares)!,
      impressions: n(m.impressions), ctr: m.ctr == null ? undefined : +(m.ctr * (1 + 0.18 * (1 - f))).toFixed(4),
      avg_watch_sec: m.avg_watch_sec, completion: m.completion == null ? undefined : +(m.completion * (1 + 0.1 * (1 - f))).toFixed(3),
      favorites: n(m.favorites), coins: n(m.coins), followers_gained: n(m.followers_gained),
      updated_at: d === last ? m.updated_at : new Date(Date.parse(p.published_at!) + d * day * 60000 + 3600000).toISOString(),
    }
  })
})

/** 封面 A/B：第 1 集视频号三版还在跑（才第 5 天，B 号曝光没到 1 万）；第 15 集已决出，第 2 张胜出 */
export const seedCoverTests: CoverTest[] = [
  {
    id: 'cvt1', video_id: 'vd1', platform: 'channels', mode: 'accounts', started_at: minsAgo(day * 5), min_days: 7, min_impressions: 10000, min_gap: 0.2, status: 'running',
    arms: [{ cover_id: vd1Cover('9x16', 1)!, publish_id: 'pb2' }, { cover_id: vd1Cover('9x16', 3)!, publish_id: 'pb2a' }, { cover_id: vd1Cover('9x16', 4)!, publish_id: 'pb2b' }],
  },
  (() => {
    const main = seedPublishes.find((p) => p.video_id === abVideo)!
    const t: CoverTest = {
      id: 'cvt2', video_id: abVideo, platform: 'channels', mode: 'accounts', started_at: main.published_at!, ended_at: new Date(Date.parse(main.published_at!) + 8 * day * 60000).toISOString(),
      min_days: 7, min_impressions: 10000, min_gap: 0.2, status: 'decided', winner_id: aiCover(abVideo, 2),
      arms: [{ cover_id: aiCover(abVideo, 1)!, publish_id: main.id }, { cover_id: aiCover(abVideo, 2)!, publish_id: `pb_ai${AB_EP}a` }, { cover_id: aiCover(abVideo, 3)!, publish_id: `pb_ai${AB_EP}b` }],
    }
    return t
  })(),
]

/* ---------- 内容编写 ---------- */

// 口播稿、大纲、原文可以在内容编写里直接写。正文实际落在视频目录的文件里（Artifact.path），原型按版本另存一份
// 一类（按比例的再分比例）同时最多一份草稿：边写边自动存，保存时存成产出物的下一个版本；执行器按选题大纲起草的初稿也先放这里，对比后采用或丢弃
export type TextKind = 'article' | 'script' | 'outline'
export interface ScriptText {
  video_id: string
  kind: TextKind
  /** 口播稿、大纲按比例各一份；原文没有 */
  variant?: Orientation
  /** 存成的是产出物的第几版；草稿和初稿没有 */
  version?: number
  /** mine 自己写着还没保存的；proposal 执行器起草、等对比的初稿 */
  draft?: 'mine' | 'proposal'
  body: string
  /** 初稿是谁起草的 */
  source?: Artifact['source']
  saved_at: string
}

/** 口播语速：每分钟多少字（汉字按字，英文和数字按词） */
export const SPEECH_RATE = 240
/** 去掉 Markdown 记号后数字数，按语速估时长（秒） */
export function textStats(md: string): { chars: number; seconds: number } {
  const plain = md.replace(/```[\s\S]*?```/g, ' ').replace(/\]\([^)]*\)/g, ' ').replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '').replace(/[*_`~[\]#>|]/g, ' ')
  const han = (plain.match(/[\u4e00-\u9fff]/g) ?? []).length
  const words = (plain.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9]+(?:['.-][A-Za-z0-9]+)*/g) ?? []).length
  const chars = han + words
  return { chars, seconds: Math.round((chars / SPEECH_RATE) * 60) }
}

/** 按选题起草要用到的几项（topicdata 的 Topic 的子集） */
export interface TopicBrief { title: string; angle: string; audience: string; outline: string }
/** 大纲草稿拆成条目：去掉序号和列表记号 */
const outlineItems = (md: string) => md.split('\n').map((l) => l.replace(/^\s*(#{1,6}|[-*+]|\d+[.、)])\s*/, '').trim()).filter(Boolean)
/**
 * 模拟技能「网页演示做视频」Phase 1：照选题的角度、受众和大纲起草。
 * 横屏一章一段；竖屏一屏一句，每屏压在 40 字以内；大纲按章节数排
 */
export function draftFromTopic(t: TopicBrief, kind: 'script' | 'outline', variant: Orientation, chapters: number): string {
  const items = outlineItems(t.outline)
  const title = t.title.trim() || '这一期'
  if (kind === 'outline') {
    const chs = Array.from({ length: Math.max(chapters, items.length) }, (_, i) => items[i] ?? `第 ${i + 1} 章（待补）`)
    return [`# ${title}`, [t.angle && `- 角度：${t.angle}`, t.audience && `- 受众：${t.audience}`].filter(Boolean).join('\n'),
      ...chs.map((c, i) => `## 第 ${i + 1} 章 ${c}\n- 要讲清楚的一件事\n- 配一个具体例子`)].filter(Boolean).join('\n\n')
  }
  if (variant === 'landscape') {
    return [`## 开场\n这一期讲「${title}」。${t.angle ? `换个角度：${t.angle}。` : ''}${t.audience ? `\n如果你是${t.audience}，这期正好用得上。` : ''}`,
      ...items.map((it, i) => `## ${i + 1}. ${it}\n先说${it}。这里放一个具体的例子：是什么、为什么、怎么做，讲完停一拍再进下一段。`),
      '## 收尾\n回顾一下今天的几个要点。觉得有用就关注一下，下期见。'].join('\n\n')
  }
  const screens = [`${title}？\n一分钟讲清楚。`, ...items.map((it) => `${it}\n一句话说透，配一个例子。`), '记住这几点就够了。\n关注我，下期见。']
  return screens.map((x, i) => `## 第 ${i + 1} 屏\n${x}`).join('\n\n')
}

/** 第 3 集横屏口播稿 v1 是手写的，正文在这里 */
const vd3Script = seedArtifacts.find((a) => a.video_id === 'vd3' && a.kind === 'script')
export const seedTexts: ScriptText[] = vd3Script ? [{
  video_id: 'vd3', kind: 'script', variant: 'landscape', version: vd3Script.version, saved_at: vd3Script.created_at,
  body: '## 开场\n上一集我们把 SOP 搭起来了，这一集讲 Agent：怎么配，才敢让它替你干活。\n\n## 1. 先划边界\n能读什么、能写什么、能不能出网，三件事先定下来。\n\n## 2. 工具一个个开\n不要一上来全开，用到哪个开哪个。',
}] : []

/* ---------- 内容日历 ---------- */

/** 离计划首发日不到这么多天还没过第一章验收，就算进度落后 */
export const LATE_DAYS = 7
const DAY_MS = 86400000
/** 两个本地日期 YYYY-MM-DD 差几天（b - a） */
export const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T00:00`).getTime() - new Date(`${a}T00:00`).getTime()) / DAY_MS)

/** 制作进度落后：排了首发日，离首发日不到 LATE_DAYS 天（或已经过了），第一章验收还没通过 */
export function isBehind(v: Video, today = localYmd(new Date())): boolean {
  if (!v.target_date) return false
  if (v.checkpoints.find((c) => c.stage === 'ch1')?.state === 'passed') return false
  return daysBetween(today, v.target_date) <= LATE_DAYS
}

/** 日历格子里的一条：发布、计划首发日、商单交付截止 */
export interface CalendarItem {
  /** YYYY-MM-DD，本地日期 */
  date: string
  kind: 'publish' | 'target' | 'deal_deadline'
  ref_id: string
  label: string
  tone: 'ok' | 'warn' | 'danger' | 'muted'
  /** 发布：具体时刻、状态、平台 */
  at?: string
  status?: PublishStatus
  platform?: PlatformKey
  video_id?: string
  /** 能不能拖动改日期：计划中、已定时的发布和没完成的首发日能拖，其余只看 */
  movable: boolean
}

/** 把发布、首发日、商单截止排成日历条目；没有日期的发布不上日历 */
export function calendarItems(videos: Video[], publishes: Publish[], deals: Deal[], today = localYmd(new Date())): CalendarItem[] {
  const out: CalendarItem[] = []
  for (const p of publishes) {
    const at = p.status === 'published' ? p.published_at : p.scheduled_at
    if (!at) continue
    const v = videos.find((x) => x.id === p.video_id)
    out.push({
      date: localYmd(new Date(at)), kind: 'publish', ref_id: p.id, label: p.title || v?.title || '未填标题', at, status: p.status, platform: p.platform, video_id: p.video_id,
      tone: p.status === 'failed' ? 'danger' : p.status === 'published' ? 'ok' : 'muted', movable: p.status === 'planned' || p.status === 'scheduled',
    })
  }
  for (const v of videos) {
    if (!v.target_date) continue
    const done = videoState(v).tone === 'ok'
    out.push({ date: v.target_date, kind: 'target', ref_id: v.id, label: v.title, video_id: v.id, tone: done ? 'ok' : isBehind(v, today) ? 'danger' : 'muted', movable: !done })
  }
  for (const d of deals) {
    if (!d.deadline || ['delivered', 'paid', 'lost'].includes(d.status)) continue
    out.push({ date: d.deadline, kind: 'deal_deadline', ref_id: d.id, label: `${d.brand}：${d.title}`, tone: daysBetween(today, d.deadline) <= 3 ? 'warn' : 'muted', movable: false })
  }
  return out
}

/* ---------- 商单 ---------- */

// 商单挂在项目下：客户、对接人、决策人都是项目干系人；视频挂到商单上，发布 7 天后出结案报告存进文档
export type DealStatus = 'inquiry' | 'quoted' | 'signed' | 'producing' | 'client_review' | 'delivered' | 'paid' | 'lost'
export const DEAL_STATUS: Record<DealStatus, { label: string; color: string }> = {
  inquiry: { label: '询价', color: '#a19d92' },
  quoted: { label: '已报价', color: '#7a4fd6' },
  signed: { label: '已签约', color: '#3d4fd6' },
  producing: { label: '制作中', color: '#0f8a8a' },
  client_review: { label: '客户审核', color: '#b0570b' },
  delivered: { label: '已交付', color: '#2f7d43' },
  paid: { label: '已收款', color: '#2f7d43' },
  lost: { label: '丢单', color: '#c0352b' },
}
/** 正常流转的顺序；丢单可以从收款前的任一步进 */
export const DEAL_FLOW: DealStatus[] = ['inquiry', 'quoted', 'signed', 'producing', 'client_review', 'delivered', 'paid']

export interface Deal {
  id: string
  /** 客户、对接人都在项目干系人里 */
  project_id: string
  /** 询价人（联系人 id） */
  contact_id?: string
  brand: string
  title: string
  platforms: PlatformKey[]
  /** 交付物：1 支横版 + 1 支竖版 + 置顶评论 */
  deliverables: string
  quote: number
  currency: 'CNY' | 'USD'
  status: DealStatus
  /** 交付截止 YYYY-MM-DD */
  deadline?: string
  /** 账期：最晚收款日 YYYY-MM-DD */
  pay_due?: string
  video_ids: string[]
  /** 从哪条 IM 消息转来的 */
  source_message_id?: string
  /** 结案报告：落在文档里的那篇 */
  report_content_id?: string
  /** 丢单原因 */
  lost_reason?: string
  /** 状态变化记录，新的在前 */
  history: { status: DealStatus; at: string }[]
  created_at: string
  updated_at: string
}

/** 账期提示：已交付没收款，离最晚收款日不到 7 天提醒，过了标红 */
export function payState(d: Deal, today = localYmd(new Date())): { days: number; tone: 'warn' | 'danger' } | null {
  if (d.status !== 'delivered' || !d.pay_due) return null
  const days = daysBetween(today, d.pay_due)
  if (days > 7) return null
  return { days, tone: days < 0 ? 'danger' : 'warn' }
}

/** 发布满几天出结案报告 */
export const REPORT_DAYS = 7
/** 结案报告能不能出：商单视频最早一条已发布的记录满 7 天；还没发布返回 null */
export function reportState(d: Deal, publishes: Publish[], now = Date.now()): { ready: boolean; left: number } | null {
  const first = publishes.filter((p) => d.video_ids.includes(p.video_id) && p.status === 'published' && p.published_at).map((p) => Date.parse(p.published_at!)).sort((a, b) => a - b)[0]
  if (first == null) return null
  const passed = Math.floor((now - first) / DAY_MS)
  return { ready: passed >= REPORT_DAYS, left: Math.max(0, REPORT_DAYS - passed) }
}

/** 报价参考：每千次播放折多少钱（元），乘近 30 天均播 */
export const QUOTE_CPM = 150
/** 近 30 天这些平台上已发布记录的平均播放（最新一条快照就是 Publish.metrics） */
export function avgViews30(publishes: Publish[], platforms: PlatformKey[], now = Date.now()): { avg: number; n: number } {
  const xs = publishes.filter((p) => p.status === 'published' && p.published_at && p.metrics && (!platforms.length || platforms.includes(p.platform)) && now - Date.parse(p.published_at) <= 30 * DAY_MS)
  return { avg: xs.length ? Math.round(xs.reduce((s, p) => s + p.metrics!.views, 0) / xs.length) : 0, n: xs.length }
}

/** 结案报告正文（轻量 Markdown，存进文档） */
export function dealReport(d: Deal, videos: Video[], publishes: Publish[], now = Date.now()): string {
  const pubs = publishes.filter((p) => d.video_ids.includes(p.video_id) && p.status === 'published')
  const sum = (k: 'views' | 'likes' | 'comments' | 'shares') => pubs.reduce((s, p) => s + (p.metrics?.[k] ?? 0), 0)
  const plat = (k: PlatformKey) => PLATFORMS.find((x) => x.key === k)?.label ?? k
  const money = `${d.currency === 'CNY' ? '¥' : '$'}${d.quote.toLocaleString('zh-CN')}`
  // 标题就是文档标题，正文从说明开始；每节一段，节内列表一行一条
  return [
    `> 生成于 ${new Date(now).toLocaleString('zh-CN')}，数据取各平台最近一次回填`,
    '## 合作概况',
    [`- 品牌：${d.brand}`,
      `- 交付物：${d.deliverables || '未填'}`,
      `- 报价：${money}`,
      `- 投放平台：${d.platforms.map(plat).join('、') || '未填'}`,
      `- 视频：${d.video_ids.map((id) => videos.find((v) => v.id === id)?.title ?? '已删除的视频').join('、') || '没有关联视频'}`].join('\n'),
    '## 数据汇总',
    `- 播放 ${sum('views').toLocaleString('zh-CN')}，点赞 ${sum('likes').toLocaleString('zh-CN')}，评论 ${sum('comments').toLocaleString('zh-CN')}，转发 ${sum('shares').toLocaleString('zh-CN')}`,
    '## 各平台明细',
    pubs.map((p) => {
      const m = p.metrics
      const ctr = m?.ctr != null ? `，点击率 ${(m.ctr * 100).toFixed(1)}%` : ''
      const done = m?.completion != null ? `，完播率 ${(m.completion * 100).toFixed(0)}%` : ''
      return `- ${plat(p.platform)}「${p.title}」：发布 ${dayAfter(p.published_at!, new Date(now).toISOString())} 天，播放 ${(m?.views ?? 0).toLocaleString('zh-CN')}${ctr}${done}${p.url ? `，链接 ${p.url}` : ''}`
    }).join('\n') || '- 还没有已发布的记录',
    '## 结论',
    '- 待补充：客户反馈、是否续约',
  ].join('\n\n')
}

export const seedDeals: Deal[] = [
  {
    id: 'deal_yc1', project_id: 'pj_perm', contact_id: 'ct_006', brand: '远川科技', title: '试点上线短片', platforms: ['bilibili'],
    deliverables: '1 支 3 分钟横版，发在远川自己的 B 站号；置顶评论放官网链接', quote: 12000, currency: 'CNY', status: 'delivered',
    deadline: daysFromNow(-12), pay_due: daysFromNow(3), video_ids: ['vd5'],
    history: [{ status: 'delivered', at: minsAgo(day * 10) }, { status: 'client_review', at: minsAgo(day * 13) }, { status: 'producing', at: minsAgo(day * 38) }, { status: 'signed', at: minsAgo(day * 40) }, { status: 'quoted', at: minsAgo(day * 41) }, { status: 'inquiry', at: minsAgo(day * 42) }],
    created_at: minsAgo(day * 42), updated_at: minsAgo(day * 10),
  },
  {
    id: 'deal_yc2', project_id: 'pj_perm', contact_id: 'ct_006', brand: '远川科技', title: '权限改造演示片', platforms: ['bilibili'],
    deliverables: '1 支横版演示片（3 章），另剪 3 段 30 秒切片', quote: 18000, currency: 'CNY', status: 'producing',
    deadline: daysFromNow(7), video_ids: ['vd4'],
    history: [{ status: 'producing', at: minsAgo(day * 8) }, { status: 'signed', at: minsAgo(day * 9) }, { status: 'quoted', at: minsAgo(day * 11) }, { status: 'inquiry', at: minsAgo(day * 12) }],
    created_at: minsAgo(day * 12), updated_at: minsAgo(day * 8),
  },
  {
    id: 'deal_ba1', project_id: 'pj_beian', contact_id: 'ct_007', brand: '北岸物流', title: '审批流 demo 讲解视频', platforms: ['bilibili', 'channels'],
    deliverables: '横版 1 支 + 竖版 1 支，讲运营后台审批流和司机端签收', quote: 9000, currency: 'CNY', status: 'quoted', video_ids: [],
    history: [{ status: 'quoted', at: minsAgo(day * 20) }, { status: 'inquiry', at: minsAgo(day * 25) }],
    created_at: minsAgo(day * 25), updated_at: minsAgo(day * 20),
  },
]
