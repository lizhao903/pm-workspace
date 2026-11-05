// 分镜和 B-roll 素材的数据约定（TSK-0456）。正式版：后端 internal/plugins/video/storyboard.go、media.go，
// 表 video_shots、video_shot_brolls、video_media_roots；前端 frontend/src/plugins/video/StoryboardDesk.tsx、MediaDrawer.tsx。
// 原型里没有真磁盘：素材目录和文件是下面的演示数据，缩略图是按色相画的 SVG，视频不播放。
import { SPEECH_RATE, textStats } from './videodata'

/** 一个分镜：no 是序号；duration 手填（秒），没填按口播字数估（shotEst） */
export type Shot = {
  id: string
  video_id: string
  text: string
  visual: string
  duration?: number
  brolls: Broll[]
}

/** 分镜里的一条 B-roll：只存素材目录 id 加相对路径，in / out 是视频的入点、出点（秒） */
export type Broll = {
  id: string
  root_id: string
  path: string
  kind: MediaKind
  note: string
  in?: number
  out?: number
}

export type MediaKind = 'image' | 'video'

/** 素材目录：project 是这一集的工程目录（不登记），其余是用户登记的本机目录，全局共用 */
export type MediaRoot = { id: string; name: string; path: string; builtin?: boolean }

/** 目录里的一个文件；hue 只是原型画缩略图用 */
export type MediaFile = {
  root_id: string
  path: string
  kind: MediaKind
  size: number
  modified_at: string
  width?: number
  height?: number
  duration?: number
  hue: number
}

/** 浏览一页多少个 */
export const MEDIA_PAGE = 12

export const shotEst = (s: Pick<Shot, 'text'>) => {
  const { chars } = textStats(s.text)
  return chars ? Math.max(1, Math.round((chars / SPEECH_RATE) * 60)) : 0
}
export const shotSeconds = (s: Shot) => s.duration ?? shotEst(s)

/** 秒数写成「1:05」「0:08.5」 */
export function fmtSec(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  const whole = Math.floor(s)
  const frac = Math.round((s - whole) * 10)
  return `${m}:${String(whole).padStart(2, '0')}${frac ? `.${frac}` : ''}`
}

/** 入点、出点：「12」「12.5」「1:05」，空串清掉（null），认不出 undefined */
export function parseSec(input: string): number | null | undefined {
  const t = input.trim()
  if (!t) return null
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(t)
  if (!m) return undefined
  const s = Number(m[2])
  if (m[1] && s >= 60) return undefined
  return Number(m[1] ?? 0) * 60 + s
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}

/** 同正式版 shotsFromText：有标题按标题拆（标题当画面说明，只有总标题没正文的跳过），没标题按空行分段 */
export function shotsFromText(md: string): { text: string; visual: string }[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const secs: { level: number; title: string; body: string[] }[] = []
  let has = false
  for (const l of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(l.trimEnd())
    if (m) { has = true; secs.push({ level: m[1].length, title: m[2].replace(/#+$/, '').trim(), body: [] }); continue }
    if (!secs.length) secs.push({ level: 0, title: '', body: [] })
    secs[secs.length - 1].body.push(l)
  }
  const clean = (b: string[]) => b.map((l) => l.replace(/^\s*(\d+[.、)]|[-*+])\s*/, '').trim()).join('\n').replace(/\n\s*\n/g, '\n\n').trim()
  if (!has) return clean(secs.flatMap((s) => s.body)).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((text) => ({ text, visual: '' }))
  return secs.flatMap((s, i) => {
    const text = clean(s.body)
    if (!text && (!s.title || (s.level === 1 && i < secs.length - 1))) return []
    return [{ text, visual: s.title }]
  })
}

/* ---------- 演示数据 ---------- */

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

export const seedMediaRoots: MediaRoot[] = [
  { id: 'vmr_cam', name: '相机素材', path: '/Volumes/素材盘/2026 相机' },
  { id: 'vmr_shot', name: '截图', path: '/Users/me/Pictures/截图' },
]

const f = (root_id: string, path: string, kind: MediaKind, size: number, mins: number, hue: number, x: Partial<MediaFile> = {}): MediaFile =>
  ({ root_id, path, kind, size, modified_at: minsAgo(mins), hue, ...(kind === 'image' ? { width: 1920, height: 1080 } : { width: 1920, height: 1080, duration: 12.4 }), ...x })

/** 演示的磁盘：工程目录按集的 root 认（这里只给 vd3 的），登记目录各几十个文件，含子目录 */
export const seedMediaFiles: MediaFile[] = [
  f('project', 'assets/logo.png', 'image', 48_000, 60 * 30, 210, { width: 512, height: 512 }),
  f('project', 'assets/agent-config.png', 'image', 820_000, 60 * 5, 160),
  f('project', 'recordings/agent-demo.mov', 'video', 186_000_000, 60 * 3, 30, { duration: 94.2 }),
  ...Array.from({ length: 16 }, (_, i) => f('vmr_cam', `A7C_${String(1021 + i).padStart(4, '0')}.mp4`, 'video', 120_000_000 + i * 7_000_000, 60 * 24 * (i + 1), (i * 37) % 360,
    { duration: 6 + (i % 5) * 3.5 })),
  ...Array.from({ length: 6 }, (_, i) => f('vmr_cam', `城市空镜/street_${i + 1}.jpg`, 'image', 4_200_000 + i * 90_000, 60 * 48, (i * 53 + 20) % 360, { width: 6000, height: 4000 })),
  f('vmr_cam', '城市空镜/夜景延时.mp4', 'video', 520_000_000, 60 * 72, 250, { width: 3840, height: 2160, duration: 18 }),
  ...Array.from({ length: 5 }, (_, i) => f('vmr_shot', `设置页-${i + 1}.png`, 'image', 300_000 + i * 20_000, 60 * (i + 2), (i * 70 + 190) % 360, { width: 2880, height: 1800 })),
]

export const seedShots: Shot[] = [
  { id: 'vsh_1', video_id: 'vd3', text: '把 Agent 放进工作流之前，先想清楚它能碰什么、不能碰什么。', visual: '开场：本人出镜，背景是工作台', brolls: [
    { id: 'vbr_1', root_id: 'vmr_cam', path: 'A7C_1021.mp4', kind: 'video', note: '只要推镜头那段', in: 2, out: 6.5 },
    { id: 'vbr_2', root_id: 'project', path: 'assets/logo.png', kind: 'image', note: '' },
  ] },
  { id: 'vsh_2', video_id: 'vd3', text: '工具授权分三档：自动、确认、关闭。删文件、发消息这类动作默认要确认。', visual: '录屏：Agent 配置页的工具授权', duration: 15, brolls: [
    { id: 'vbr_3', root_id: 'project', path: 'assets/agent-config.png', kind: 'image', note: '圈出「确认」那一列' },
    { id: 'vbr_4', root_id: 'vmr_shot', path: '设置页-旧版.png', kind: 'image', note: '旧版对比，文件被删了会标缺失' },
  ] },
  { id: 'vsh_3', video_id: 'vd3', text: '最后看一次真实运行：它停下来问你，你点确认它才继续。', visual: '录屏：运行记录里的确认', brolls: [] },
]
