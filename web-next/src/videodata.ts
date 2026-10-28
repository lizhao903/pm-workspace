// 视频类项目：按 web-video-presentation 技能的制作流程管——文稿 → 规划检查 → 网页开发 → 第一章验收 → 其余章节 → 音频 → 录屏 → 分发包
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

export type StageKey = 'script' | 'plan' | 'web' | 'ch1' | 'chapters' | 'audio' | 'record' | 'distribution'
export const STAGES: { key: StageKey; label: string; desc: string; checkpoint?: boolean }[] = [
  { key: 'script', label: '内容编写', desc: '口播稿、大纲，一次产出' },
  { key: 'plan', label: '规划检查', desc: '对齐稿子、大纲、主题、素材、开发方式和画面比例；比例定了就不能改', checkpoint: true },
  { key: 'web', label: '网页开发', desc: '按比例搭演示工程，第 1 章完整做出来' },
  { key: 'ch1', label: '第一章验收', desc: '第 1 章是后面所有章节的样板，必须验收', checkpoint: true },
  { key: 'chapters', label: '其余章节', desc: '第 2 到 N 章：逐章、顺序或并行开发' },
  { key: 'audio', label: '音频合成', desc: '决定要不要合成口播音频，按章节出音频', checkpoint: true },
  { key: 'record', label: '录屏渲染', desc: '程序化录屏，合成 mp4' },
  { key: 'distribution', label: '分发包', desc: '封面（每个比例 5 个版本）、简介、章节时间轴', checkpoint: true },
]
export const stageIndex = (k: StageKey) => STAGES.findIndex((s) => s.key === k)

export type ArtifactKind = 'article' | 'script' | 'outline' | 'presentation' | 'audio' | 'video' | 'cover' | 'description' | 'chapters'
export const ARTIFACT_KIND: Record<ArtifactKind, { label: string; stage: StageKey; perVariant: boolean }> = {
  article: { label: '原文', stage: 'script', perVariant: false },
  script: { label: '口播稿', stage: 'script', perVariant: false },
  outline: { label: '大纲', stage: 'script', perVariant: false },
  presentation: { label: '演示工程', stage: 'web', perVariant: true },
  audio: { label: '音频', stage: 'audio', perVariant: false },
  video: { label: '视频', stage: 'record', perVariant: true },
  cover: { label: '封面', stage: 'distribution', perVariant: true },
  description: { label: '简介', stage: 'distribution', perVariant: false },
  chapters: { label: '章节时间轴', stage: 'distribution', perVariant: false },
}

export type ArtifactStatus = 'draft' | 'review' | 'final' | 'published'
export const ARTIFACT_STATUS: Record<ArtifactStatus, { label: string; color: string }> = {
  draft: { label: '草稿', color: '#a19d92' },
  review: { label: '待验收', color: '#b0570b' },
  final: { label: '已定稿', color: '#2f7d43' },
  published: { label: '已发布', color: '#3d4fd6' },
}

export interface Review { at: string; ok: boolean; comment: string }

export interface Artifact {
  id: string
  video_id: string
  kind: ArtifactKind
  name: string
  /** 相对视频项目目录的路径 */
  path: string
  /** 按比例区分的产出（演示工程、视频、封面）才有 */
  variant?: Orientation
  /** 封面这种一个比例出好几个版本的：第几个版本 */
  option?: number
  version: number
  status: ArtifactStatus
  /** 音频、视频：秒 */
  duration?: number
  /** 是谁产出的 */
  source: { type: 'manual' | 'sop' | 'agent' | 'skill'; label: string }
  reviews: Review[]
  /** 封面：同一比例里选用的那张 */
  picked?: boolean
  created_at: string
}

export type CheckpointState = 'pending' | 'passed' | 'rejected' | 'skipped'
export interface Checkpoint { stage: StageKey; state: CheckpointState; at?: string; note?: string }

export type PlatformKey = 'bilibili' | 'youtube' | 'douyin' | 'channels' | 'xiaohongshu'
export const PLATFORMS: { key: PlatformKey; label: string; color: string; prefer: Orientation }[] = [
  { key: 'bilibili', label: 'B 站', color: '#fb7299', prefer: 'landscape' },
  { key: 'youtube', label: 'YouTube', color: '#ff0033', prefer: 'landscape' },
  { key: 'douyin', label: '抖音', color: '#161823', prefer: 'portrait' },
  { key: 'channels', label: '视频号', color: '#07c160', prefer: 'portrait' },
  { key: 'xiaohongshu', label: '小红书', color: '#ff2442', prefer: 'portrait' },
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

export interface Metrics { views: number; likes: number; comments: number; shares: number; updated_at: string }

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
// 视频时间线：from = 视频创建，to = 最后一个已过阶段的时刻（都写成「多少分钟前」，to 不晚于 updated_at）
// 检查点按阶段在 from 和 to 之间排开，分发包检查点正好落在 to；产出物落在所属阶段的中段，早于该阶段的检查点
type Span = [from: number, to: number]
const stageAt = ([from, to]: Span, k: StageKey, frac = 1) => minsAgo(from - ((from - to) * (stageIndex(k) + frac)) / STAGES.length)
const cps = (passed: StageKey[], span: Span): Checkpoint[] => STAGES.filter((s) => s.checkpoint).map((s) => ({
  stage: s.key,
  state: passed.includes(s.key) ? 'passed' : 'pending',
  at: passed.includes(s.key) ? stageAt(span, s.key) : undefined,
}))
const SPAN: Record<string, Span> = { vd1: [day * 20, day * 7], vd2: [day * 5, 60 * 4], vd3: [day * 1, 60 * 2], vd4: [day * 8, 60 * 21] }
// AI 系列：第 ep 集的创建时间和最近更新时间（分钟前）；to 比 updated 早一小时
const aiCreated = (ep: number) => day * (70 - ep * 2)
const aiUpdated = (ep: number) => day * Math.max(0, 33 - ep) + ep * 7
const AI_DONE = 18

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
  'Copilot 写测试', 'v0 出界面', 'Bolt 搭原型', 'Dify 编工作流', 'Coze 做机器人', 'Ollama 本地跑模型', 'LM Studio 对比模型', 'Raycast AI 快捷指令',
  'Arc 浏览器 AI', 'Granola 会议纪要', 'Descript 剪口播', 'HeyGen 数字人', 'ElevenLabs 克隆声音', 'Recraft 做图标', 'Krea 实时出图', 'NotebookLM 做播客']
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
    return {
      id, title: `第 ${ep} 集：${t}`, series_id: 'sr_ai', episode: ep, orientations: ['portrait'], stage, checkpoints,
      root: `videos/ai100/ep${String(ep).padStart(2, '0')}`, chapters: 3, created_at: minsAgo(aiCreated(ep)), updated_at: minsAgo(aiUpdated(ep)),
    }
  })
}

export const seedVideos: Video[] = [
  { id: 'vd1', title: '第 1 集：今日待办一页清', project_id: 'pj_pmw', series_id: 'sr_pmw', episode: 1, orientations: ['landscape', 'portrait'], stage: 'distribution', checkpoints: cps(['plan', 'ch1', 'audio', 'distribution'], SPAN.vd1), root: 'videos/ep01-today', chapters: 5, created_at: minsAgo(day * 20), updated_at: minsAgo(day * 6) },
  { id: 'vd2', title: '第 2 集：SOP 编排像搭积木', project_id: 'pj_pmw', series_id: 'sr_pmw', episode: 2, orientations: ['landscape', 'portrait'], stage: 'ch1', checkpoints: cps(['plan'], SPAN.vd2), root: 'videos/ep02-sop', chapters: 6, created_at: minsAgo(day * 5), updated_at: minsAgo(60 * 3) },
  { id: 'vd3', title: '第 3 集：Agent 怎么配才放心', project_id: 'pj_pmw', series_id: 'sr_pmw', episode: 3, orientations: ['landscape'], stage: 'script', checkpoints: cps([], SPAN.vd3), root: 'videos/ep03-agent', chapters: 4, created_at: minsAgo(day * 1), updated_at: minsAgo(90) },
  ...aiSeries(),
  { id: 'vd4', title: '远川权限改造演示片', project_id: 'pj_perm', orientations: ['landscape'], stage: 'record', checkpoints: cps(['plan', 'ch1', 'audio'], SPAN.vd4), root: 'demo-video', chapters: 3, created_at: minsAgo(day * 8), updated_at: minsAgo(60 * 20) },
]

let n = 0
const art = (video_id: string, kind: ArtifactKind, name: string, path: string, status: ArtifactStatus, extra: Partial<Artifact> = {}): Artifact => ({
  id: `af${(n += 1)}`, video_id, kind, name, path, status, version: 1, source: { type: 'skill', label: 'web-video-presentation' }, reviews: [], created_at: stageAt(SPAN[video_id], ARTIFACT_KIND[kind].stage, 0.5), ...extra,
})

export const seedArtifacts: Artifact[] = [
  art('vd1', 'article', '原文', 'article.md', 'final'),
  art('vd1', 'script', '口播稿', 'script.md', 'final', { version: 3, reviews: [{ at: minsAgo(day * 18.5), ok: false, comment: '第 3 段太长，拆成两屏' }, { at: minsAgo(day * 18), ok: true, comment: '可以' }] }),
  art('vd1', 'outline', '大纲', 'outline.md', 'final'),
  art('vd1', 'presentation', '演示工程', 'presentation-landscape', 'final', { variant: 'landscape' }),
  art('vd1', 'presentation', '演示工程', 'presentation-portrait', 'final', { variant: 'portrait' }),
  art('vd1', 'audio', '口播音频（5 章）', 'audio/', 'final', { duration: 598 }),
  art('vd1', 'video', '成片', 'out/ep01-16x9.mp4', 'published', { variant: 'landscape', duration: 602 }),
  art('vd1', 'video', '成片', 'out/ep01-9x16.mp4', 'published', { variant: 'portrait', duration: 602 }),
  ...[1, 2, 3, 4, 5].map((o) => art('vd1', 'cover', `封面 ${o}`, `cover/16x9-${o}.png`, o === 2 ? 'published' : 'final', { variant: 'landscape', option: o, picked: o === 2 })),
  ...[1, 2, 3, 4, 5].map((o) => art('vd1', 'cover', `封面 ${o}`, `cover/9x16-${o}.png`, o === 1 ? 'published' : 'final', { variant: 'portrait', option: o, picked: o === 1 })),
  art('vd1', 'description', '简介', 'description.md', 'final'),
  art('vd1', 'chapters', '章节时间轴', 'chapters.md', 'final'),
  art('vd2', 'script', '口播稿', 'script.md', 'final', { version: 2 }),
  art('vd2', 'outline', '大纲', 'outline.md', 'final'),
  art('vd2', 'presentation', '演示工程（第 1 章）', 'presentation-landscape', 'review', { variant: 'landscape', source: { type: 'skill', label: 'web-video-presentation' } }),
  art('vd2', 'presentation', '演示工程（第 1 章）', 'presentation-portrait', 'draft', { variant: 'portrait' }),
  art('vd3', 'script', '口播稿', 'script.md', 'draft', { source: { type: 'manual', label: '手写' } }),
  art('vd4', 'script', '口播稿', 'script.md', 'final'),
  art('vd4', 'presentation', '演示工程', 'presentation-landscape', 'final', { variant: 'landscape' }),
  art('vd4', 'audio', '口播音频（3 章）', 'audio/', 'final', { duration: 214 }),
  // AI 系列已完成的集：成片、选用的封面、简介，都已随视频号发布
  ...seedVideos.filter((v) => v.series_id === 'sr_ai' && (v.episode ?? 0) <= AI_DONE).flatMap((v) => {
    const ep = String(v.episode).padStart(2, '0')
    return [
      art(v.id, 'video', '成片', `out/ep${ep}-9x16.mp4`, 'published', { variant: 'portrait', duration: 290 + ((v.episode ?? 0) * 7) % 40 }),
      art(v.id, 'cover', '封面 1', `cover/9x16-1.png`, 'published', { variant: 'portrait', option: 1, picked: true }),
      art(v.id, 'description', '简介', 'description.md', 'final'),
    ]
  }),
]

export const seedPublishes: Publish[] = [
  { id: 'pb1', video_id: 'vd1', platform: 'bilibili', variant: 'landscape', cover_id: 'af10', title: '一人之下 10 分钟上手 01｜今日待办一页清', desc: '把散在各处的待办收到一页……', status: 'published', published_at: minsAgo(day * 6), url: 'https://www.bilibili.com/video/BV1xx', metrics: { views: 12840, likes: 931, comments: 87, shares: 64, updated_at: minsAgo(60 * 5) } },
  { id: 'pb2', video_id: 'vd1', platform: 'channels', variant: 'portrait', cover_id: 'af14', title: '今日待办一页清', desc: '一页看完今天要处理的事', status: 'published', published_at: minsAgo(day * 5), url: 'https://channels.weixin.qq.com/web/pages/feed?id=ep01today', metrics: { views: 3420, likes: 210, comments: 12, shares: 35, updated_at: minsAgo(60 * 30) } },
  { id: 'pb3', video_id: 'vd1', platform: 'douyin', variant: 'portrait', title: '今日待办一页清', desc: '', status: 'failed', error: '封面尺寸不符合要求（需要 3:4）' },
  { id: 'pb4', video_id: 'vd1', platform: 'youtube', variant: 'landscape', cover_id: 'af10', title: 'One Page for Today', desc: '', status: 'scheduled', scheduled_at: new Date(Date.now() + day * 60000 * 2).toISOString() },
  // AI 系列：每集分发包通过后两小时发视频号
  ...seedVideos.filter((v) => v.series_id === 'sr_ai' && (v.episode ?? 0) <= AI_DONE).map((v, i): Publish => {
    const ep = v.episode ?? 0
    const at = SPAN[v.id][1] - 120
    const cover = seedArtifacts.find((a) => a.video_id === v.id && a.kind === 'cover')
    return {
      id: `pb_ai${String(ep).padStart(2, '0')}`, video_id: v.id, platform: 'channels', variant: 'portrait', cover_id: cover?.id, title: `AI 工具 100 讲 ${String(ep).padStart(2, '0')}｜${AI_TOPICS[ep - 1]}`,
      desc: '5 分钟讲一个 AI 工具的真实用法', status: 'published', published_at: minsAgo(at), url: `https://channels.weixin.qq.com/web/pages/feed?id=ai100ep${String(ep).padStart(2, '0')}`,
      metrics: { views: 2600 + ((ep * 1373) % 5200) + i * 90, likes: 120 + ((ep * 37) % 260), comments: 8 + ((ep * 11) % 40), shares: 15 + ((ep * 13) % 70), updated_at: minsAgo(60 * 2) },
    }
  }),
]
