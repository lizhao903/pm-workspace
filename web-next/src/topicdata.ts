// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 视频博主的选题管理和信息收集
// 素材（Clip）是收进来的原始信息：链接、笔记、热榜、评论、竞品、IM 消息；选题（Topic）是从素材里挑出来、打过分、准备做的题
// 选题「立项」后生成一集视频（Video），两边互相记着 id

import type { PlatformKey } from './videodata'

export type TopicStatus = 'idea' | 'research' | 'ready' | 'scheduled' | 'made' | 'dropped'
export const TOPIC_STATUS: Record<TopicStatus, { label: string; color: string; desc: string }> = {
  idea: { label: '想法', color: '#a19d92', desc: '先记下来，还没细想' },
  research: { label: '调研中', color: '#3d4fd6', desc: '在找资料、看竞品、想切入角度' },
  ready: { label: '可开拍', color: '#2f7d43', desc: '角度和大纲想清楚了，随时能立项' },
  scheduled: { label: '已排期', color: '#7a4fd6', desc: '定了哪天做、哪天发' },
  made: { label: '已做成', color: '#0f8a8a', desc: '已经立项成视频' },
  dropped: { label: '放弃', color: '#c0352b', desc: '不做了，留着备查' },
}
export const TOPIC_FLOW: TopicStatus[] = ['idea', 'research', 'ready', 'scheduled', 'made', 'dropped']

/** 打分：需求度（有多少人想看）、契合度（和账号定位合不合）、成本（越高越难做），各 1 到 5 */
export interface TopicScore { demand: number; fit: number; effort: number }
/** 优先级分：需求和契合越高越好，成本越高越扣分；满分 10 */
export const topicPriority = (s: TopicScore) => Math.round(((s.demand * 0.45 + s.fit * 0.35 + (6 - s.effort) * 0.2) / 5) * 100) / 10

export interface Topic {
  id: string
  title: string
  /** 切入角度：同一个题，从哪个角度讲 */
  angle: string
  audience: string
  status: TopicStatus
  score: TopicScore
  tags: string[]
  series_id?: string
  platforms: PlatformKey[]
  /** 大纲草稿，markdown */
  outline: string
  clip_ids: string[]
  planned_at?: string
  video_id?: string
  drop_reason?: string
  created_at: string
  updated_at: string
}

export type ClipKind = 'link' | 'note' | 'trend' | 'comment' | 'competitor' | 'im'
export const CLIP_KIND: Record<ClipKind, { label: string; color: string }> = {
  link: { label: '链接', color: '#3d4fd6' },
  note: { label: '笔记', color: '#6e6b62' },
  trend: { label: '热榜', color: '#e8590c' },
  comment: { label: '评论', color: '#0f8a8a' },
  competitor: { label: '竞品', color: '#7a4fd6' },
  im: { label: 'IM 消息', color: '#2f7d43' },
}

export interface Clip {
  id: string
  kind: ClipKind
  title: string
  content: string
  url?: string
  /** 从哪来的：平台名、热榜名、评论所在视频、消息所在群 */
  source: string
  /** 热度、点赞数这类数字，没有就不填 */
  heat?: number
  tags: string[]
  starred: boolean
  /** 已经归到的选题 */
  topic_ids: string[]
  /** 处理过的不再出现在「待整理」 */
  triaged: boolean
  created_at: string
}

const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString()
const day = 60 * 24

export const seedClips: Clip[] = [
  { id: 'cl_01', kind: 'comment', title: '能讲讲 Cursor 和 Claude Code 怎么选吗', content: '看完第 3 集了，最纠结的是两个都在用，什么场景用哪个？', source: 'B 站评论 · 第 3 集：Cursor 改代码', heat: 326, tags: ['AI 编程'], starred: true, topic_ids: ['tp_01'], triaged: true, created_at: minsAgo(day * 3) },
  { id: 'cl_02', kind: 'trend', title: '「AI 编程助手对比」搜索量一周涨 3 倍', content: 'B 站搜索联想词前 5，抖音话题 #AI编程 播放 2.1 亿', source: 'B 站热搜', heat: 21000, tags: ['AI 编程', '热点'], starred: false, topic_ids: ['tp_01'], triaged: true, created_at: minsAgo(day * 2) },
  { id: 'cl_03', kind: 'competitor', title: '某科技 UP 主：我用 AI 一天写完一个 App', content: '播放 86 万，评论里很多人问怎么上手、要不要会编程', url: 'https://www.bilibili.com/video/BV1demo01', source: 'B 站 · 竞品', heat: 860000, tags: ['竞品', 'AI 编程'], starred: true, topic_ids: [], triaged: false, created_at: minsAgo(day * 1) },
  { id: 'cl_04', kind: 'link', title: 'NotebookLM 新增中文播客生成', content: '官方博客：支持把文档生成两人对谈的中文音频', url: 'https://blog.google/technology/ai/notebooklm-audio', source: '手动收藏', tags: ['工具更新'], starred: false, topic_ids: ['tp_03'], triaged: true, created_at: minsAgo(day * 4) },
  { id: 'cl_05', kind: 'note', title: '自己踩的坑：Dify 工作流变量作用域', content: '分支里赋的变量在合并节点取不到，要先用变量聚合器。可以单独做一期。', source: '手写', tags: ['踩坑', 'Dify'], starred: false, topic_ids: [], triaged: false, created_at: minsAgo(300) },
  { id: 'cl_06', kind: 'im', title: '同事问：周报能不能全自动', content: '林予安：你那个周报助手能不能每周五自动发到群里？', source: 'Slack · #product', tags: ['周报', '自动化'], starred: false, topic_ids: [], triaged: false, created_at: minsAgo(180) },
  { id: 'cl_07', kind: 'comment', title: '求出一期本地跑大模型的', content: '公司不让用在线 AI，想知道 Mac 上能跑什么', source: '视频号评论 · 第 22 集：Ollama 本地跑模型', heat: 88, tags: ['本地模型'], starred: false, topic_ids: [], triaged: false, created_at: minsAgo(120) },
  { id: 'cl_08', kind: 'trend', title: '「AI 做 PPT」话题上热榜', content: '抖音热榜第 14，相关视频平均播放 12 万', source: '抖音热榜', heat: 140000, tags: ['热点', '办公'], starred: false, topic_ids: [], triaged: false, created_at: minsAgo(60) },
]

export const seedTopics: Topic[] = [
  { id: 'tp_01', title: 'Cursor 和 Claude Code 到底怎么选', angle: '按「改现有项目 / 从零搭 / 跑长任务」三个场景对比，不比参数比体验', audience: '已经在用 AI 写代码、想选一个主力工具的开发者', status: 'ready',
    score: { demand: 5, fit: 5, effort: 3 }, tags: ['AI 编程', '对比'], series_id: 'sr_ai', platforms: ['bilibili', 'youtube'], outline: '1. 三个场景\n2. 同一个需求两边各做一遍\n3. 结论：什么时候用哪个', clip_ids: ['cl_01', 'cl_02'], created_at: minsAgo(day * 3), updated_at: minsAgo(day) },
  { id: 'tp_02', title: '一个人怎么管 30 集的系列', angle: '用「一人之下」自己演示：系列模板、批量改版、阶段分布', audience: '做系列内容的知识区 UP 主', status: 'research',
    score: { demand: 3, fit: 5, effort: 2 }, tags: ['工作流'], series_id: 'sr_pmw', platforms: ['bilibili', 'channels'], outline: '', clip_ids: [], created_at: minsAgo(day * 5), updated_at: minsAgo(day * 2) },
  { id: 'tp_03', title: 'NotebookLM 把文档变播客', angle: '实测中文效果，和自己配音对比', audience: '需要做音频内容、不想露声的人', status: 'scheduled', planned_at: new Date(Date.now() + day * 60000 * 5).toISOString(),
    score: { demand: 4, fit: 4, effort: 2 }, tags: ['工具更新'], series_id: 'sr_ai', platforms: ['channels', 'douyin'], outline: '1. 生成过程\n2. 效果对比\n3. 适合什么场景', clip_ids: ['cl_04'], created_at: minsAgo(day * 4), updated_at: minsAgo(day * 3) },
  { id: 'tp_04', title: 'AI 视频生成全家桶横评', angle: '同一段脚本让 5 个工具各出一版', audience: '想做 AI 短片的新手', status: 'idea',
    score: { demand: 4, fit: 3, effort: 5 }, tags: ['横评'], platforms: ['douyin', 'xiaohongshu'], outline: '', clip_ids: [], created_at: minsAgo(day * 6), updated_at: minsAgo(day * 6) },
  { id: 'tp_05', title: '用 AI 给老照片上色', angle: '', audience: '', status: 'dropped', drop_reason: '和账号定位不符，热度也一般',
    score: { demand: 2, fit: 1, effort: 2 }, tags: [], platforms: [], outline: '', clip_ids: [], created_at: minsAgo(day * 10), updated_at: minsAgo(day * 8) },
]

/** 拉取热榜 / 收集评论（模拟）：每次取下一批，取完就没有新的 */
export const TREND_POOL: Omit<Clip, 'id' | 'created_at'>[][] = [
  [{ kind: 'trend', title: '「Claude 写代码」B 站搜索上升最快', content: '本周搜索量环比 +180%', source: 'B 站热搜', heat: 34000, tags: ['热点', 'AI 编程'], starred: false, topic_ids: [], triaged: false },
    { kind: 'trend', title: '小红书「AI 副业」话题新增 1.2 万篇笔记', content: '多数是工具清单类，教程类偏少', source: '小红书热门话题', heat: 12000, tags: ['热点'], starred: false, topic_ids: [], triaged: false }],
  [{ kind: 'trend', title: '「AI 简历」视频号热门', content: '相关视频平均转发 2300', source: '视频号热门', heat: 2300, tags: ['热点', '求职'], starred: false, topic_ids: [], triaged: false }],
]
export const COMMENT_POOL: Omit<Clip, 'id' | 'created_at'>[][] = [
  [{ kind: 'comment', title: '能不能讲讲 Agent 怎么接自己公司的系统', content: 'MCP 那块看不太懂，求一期实操', source: 'B 站评论 · 第 3 集：Agent 怎么配才放心', heat: 154, tags: ['Agent', 'MCP'], starred: false, topic_ids: [], triaged: false },
    { kind: 'comment', title: '想看你的工作台怎么搭的', content: '左边那个菜单能自己配吗', source: 'YouTube 评论 · 第 1 集：今日待办一页清', heat: 41, tags: ['工作台'], starred: false, topic_ids: [], triaged: false }],
]
