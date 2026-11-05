// 分镜和 B-roll 素材的纯函数（TSK-0456，同原型 web-next/src/videodata.ts 的 shotSeconds、fmtSec）。
import type { VideoBroll, VideoMediaFile, VideoShot } from '../../core/data'

/** 一个分镜的时长：手填的优先，没填用按口播字数估的 */
export const shotSeconds = (s: Pick<VideoShot, 'duration' | 'est'>) => s.duration ?? s.est

/** 全部分镜的总时长（秒） */
export const totalSeconds = (xs: Pick<VideoShot, 'duration' | 'est'>[]) => xs.reduce((n, s) => n + shotSeconds(s), 0)

/** 秒数写成「1:05」「0:08.5」，一小时以上「1:02:03」 */
export function fmtSec(sec: number): string {
  const neg = sec < 0
  let s = Math.abs(sec)
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  const whole = Math.floor(s)
  const frac = Math.round((s - whole) * 10)
  const ss = `${String(whole).padStart(2, '0')}${frac ? `.${frac}` : ''}`
  return `${neg ? '-' : ''}${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${ss}`
}

/** 解析入点、出点：「12」「12.5」「1:05」「1:02:03」都认，空串是清掉（null），认不出回 undefined */
export function parseSec(input: string): number | null | undefined {
  const t = input.trim()
  if (!t) return null
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(t)) return undefined
  const parts = t.split(':')
  const last = Number(parts.pop())
  if (parts.some((p, i) => i > 0 && Number(p) >= 60) || (parts.length && last >= 60)) return undefined
  const n = parts.reduce((acc, p) => acc * 60 + Number(p), 0) * 60 + last
  return parts.length ? n : last
}

/** 文件大小：B、KB、MB、GB */
export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** 浏览里一个文件的一行说明：尺寸、时长、大小 */
export function fileMeta(f: Pick<VideoMediaFile, 'width' | 'height' | 'duration' | 'size'>): string {
  return [f.width && f.height ? `${f.width}×${f.height}` : '', f.duration ? fmtSec(f.duration) : '', fmtSize(f.size)].filter(Boolean).join(' · ')
}

/** 入出点的说明：「0:01.5 到 0:04」「从 0:02 起」「到 0:10」，都没设回空串 */
export function clipText(b: Pick<VideoBroll, 'in' | 'out'>): string {
  if (b.in != null && b.out != null) return `${fmtSec(b.in)} 到 ${fmtSec(b.out)}`
  if (b.in != null) return `从 ${fmtSec(b.in)} 起`
  if (b.out != null) return `到 ${fmtSec(b.out)}`
  return ''
}

/** 把 id 从 from 挪到 to 的位置（拖动排序），回新顺序 */
export function moveId(ids: string[], id: string, to: number): string[] {
  const rest = ids.filter((x) => x !== id)
  const i = Math.max(0, Math.min(to, rest.length))
  return [...rest.slice(0, i), id, ...rest.slice(i)]
}

/** 拖动时带的数据类型：从素材浏览拖进分镜 */
export const DRAG_MEDIA = 'application/x-pmw-media'
/** 拖动分镜行排序 */
export const DRAG_SHOT = 'application/x-pmw-shot'

export type DraggedMedia = { root_id: string; path: string }[]

/** 读拖进来的素材，格式不对回空数组 */
export function readDragged(raw: string): DraggedMedia {
  try {
    const x = JSON.parse(raw) as unknown
    return Array.isArray(x) ? x.filter((i): i is { root_id: string; path: string } => !!i && typeof i.root_id === 'string' && typeof i.path === 'string') : []
  } catch {
    return []
  }
}

/** 面包屑：根加每一段子目录 */
export function dirCrumbs(dir: string): { label: string; path: string }[] {
  const out: { label: string; path: string }[] = []
  let cur = ''
  for (const seg of dir.split('/').filter(Boolean)) {
    cur = cur ? `${cur}/${seg}` : seg
    out.push({ label: seg, path: cur })
  }
  return out
}
