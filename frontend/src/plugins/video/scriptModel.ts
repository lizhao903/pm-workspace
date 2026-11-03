// 内容编写的纯函数和本地草稿（VID-09b，同原型 web-next/src/videodata.ts 的 textStats、ScriptText）。
// 后端只存版本（文件和 .versions/ 里的旧版），没有草稿存放处：没保存的草稿和「初稿已处理」只记在本机浏览器里，
// 存不进去（隐私模式、被禁用）时只留在内存，刷新就没了。
import { useSyncExternalStore } from 'react'
import type { Video, VideoArtifact, VideoOrientation, VideoTopic } from '../../core/data'
import { ORIENT, ORIENTS } from './model'

export type TextKind = 'article' | 'script' | 'outline'
export const TEXT_LABEL: Record<TextKind, string> = { article: '原文', script: '口播稿', outline: '大纲' }
export const isTextKind = (k: string): k is TextKind => k === 'article' || k === 'script' || k === 'outline'

/** 口播语速：每分钟多少字 */
export const SPEECH_RATE = 240

/** 去掉 Markdown 记号后数字数（汉字一个算一个，英文按词），按语速估时长（秒） */
export function textStats(md: string): { chars: number; seconds: number } {
  const plain = md.replace(/```[\s\S]*?```/g, ' ').replace(/\]\([^)]*\)/g, ' ').replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '').replace(/[*_`~[\]#>|]/g, ' ')
  const han = (plain.match(/[一-鿿]/g) ?? []).length
  const words = (plain.replace(/[一-鿿]/g, ' ').match(/[A-Za-z0-9]+(?:['.-][A-Za-z0-9]+)*/g) ?? []).length
  const chars = han + words
  return { chars, seconds: Math.round((chars / SPEECH_RATE) * 60) }
}

/** 口播时长：不到一分钟说秒，够一分钟说几分几秒 */
export const speakText = (sec: number) => (sec < 60 ? `${Math.max(1, sec)} 秒` : `${Math.floor(sec / 60)} 分 ${String(sec % 60).padStart(2, '0')} 秒`)

/** 大纲的节数：一到三级标题 */
export const sectionCount = (md: string) => md.split('\n').filter((l) => /^#{1,3}\s/.test(l)).length

/** 选题大纲拆成条目：去掉序号和列表记号 */
export const outlineItems = (md: string) => md.split('\n').map((l) => l.replace(/^\s*(\d+[.、)]|[-*+])\s*/, '').trim()).filter(Boolean)

/** 编辑区的口播稿栏：本集的比例，还没定按横屏一栏 */
export const deskOrients = (v: Video): VideoOrientation[] => (v.orientations.length ? ORIENTS.filter((o) => v.orientations.includes(o)) : ['landscape'])

/** 这一类（按比例）最新的那条产出物 */
export const latestText = (arts: VideoArtifact[], kind: TextKind, variant?: VideoOrientation) =>
  arts.filter((a) => a.kind === kind && (a.variant || undefined) === variant).sort((a, b) => b.version - a.version)[0] as VideoArtifact | undefined

/** 栏名：横屏口播稿、大纲、原文 */
export const paneLabel = (kind: TextKind, variant?: VideoOrientation) => `${variant && kind === 'script' ? ORIENT[variant].label : ''}${TEXT_LABEL[kind]}`

/** 能不能挑来挂：没立项、没放弃，按优先级排在调用方 */
export const pickableTopic = (t: VideoTopic) => !t.video_id && t.status !== 'dropped' && t.status !== 'made'

/** 新建选题的标题：本集标题去掉「第 N 集：」，「新视频」算空 */
export const newTopicTitle = (v: Video) => v.title.replace(/^第 \d+ 集：/, '').replace(/^新视频$/, '').trim()

/* ---------- 本地草稿 ---------- */

export type TextDraft = { body: string; at: string }
type Store = { drafts: Record<string, TextDraft>; handled: string[] }

const STORAGE_KEY = 'pmw.video.script-desk'
/** 「初稿已处理」最多记多少条，旧的丢掉 */
const HANDLED_MAX = 200

export const draftKey = (videoId: string, kind: TextKind, variant?: VideoOrientation) => `${videoId}:${kind}:${variant ?? ''}`

function load(): Store {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const x = raw ? (JSON.parse(raw) as Partial<Store>) : null
    return { drafts: x?.drafts && typeof x.drafts === 'object' ? x.drafts : {}, handled: Array.isArray(x?.handled) ? x.handled : [] }
  } catch {
    return { drafts: {}, handled: [] }
  }
}

let state: Store | null = null
const listeners = new Set<() => void>()
const snapshot = () => (state ??= load())

function commit(next: Store) {
  state = next
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 存不进去就只留在内存
  }
  listeners.forEach((f) => f())
}

const subscribe = (f: () => void) => {
  listeners.add(f)
  return () => { listeners.delete(f) }
}

/** 本地草稿和初稿处理记录，变了就重新渲染 */
export function useDeskStore() {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** 写草稿；body 为 null 或和已保存的一样时删掉 */
export function setDraft(key: string, body: string | null, saved?: string) {
  const s = snapshot()
  const drop = body === null || body === (saved ?? '')
  if (drop && !(key in s.drafts)) return
  const drafts = { ...s.drafts }
  if (drop) delete drafts[key]
  else drafts[key] = { body, at: new Date().toISOString() }
  commit({ ...s, drafts })
}

/** 一份初稿的标识：产出物加版本，再起草会升版本，旧标识自然作废 */
export const proposalKey = (a: VideoArtifact) => `${a.id}@v${a.version}`

export function markHandled(keys: string[]) {
  const s = snapshot()
  const handled = [...s.handled.filter((k) => !keys.includes(k)), ...keys].slice(-HANDLED_MAX)
  commit({ ...s, handled })
}

/** 测试用：清空 */
export function resetDeskStore() {
  state = { drafts: {}, handled: [] }
  try { window.localStorage.removeItem(STORAGE_KEY) } catch { /* 没有存储 */ }
  listeners.forEach((f) => f())
}

/**
 * 按选题大纲起草跑完后待对比的初稿：最近一次内容编写的执行跑完、登记或升版的口播稿和大纲，
 * 还是执行器写的那一版（手写存过的来源会变成手动）、没定稿、没在本机处理过
 */
export function pendingProposals(v: Video, arts: VideoArtifact[], handled: string[]) {
  const r = v.last_run
  if (!r || r.stage !== 'script' || r.status !== 'done' || !r.artifact_ids?.length) return []
  return arts.filter((a) => r.artifact_ids!.includes(a.id) && (a.kind === 'script' || a.kind === 'outline')
    && a.source.type !== 'manual' && (a.status === 'review' || a.status === 'draft') && !handled.includes(proposalKey(a)))
    .sort((a, b) => Number(a.kind === 'outline') - Number(b.kind === 'outline') || ORIENTS.indexOf(a.variant ?? 'landscape') - ORIENTS.indexOf(b.variant ?? 'landscape'))
}

/** 规划检查要对齐的文稿：原文、每个比例的口播稿和大纲各自最新的一版；加上提醒 */
export function planDocs(v: Video, arts: VideoArtifact[], hasDraft: boolean) {
  const os = v.orientations.length ? deskOrients(v) : ORIENTS.filter((o) => arts.some((a) => (a.kind === 'script' || a.kind === 'outline') && a.variant === o))
  const docs = [latestText(arts, 'article'), ...(['script', 'outline'] as const).flatMap((k) => os.map((o) => latestText(arts, k, o)))]
    .filter((a): a is VideoArtifact => !!a)
  const warns = [
    ...os.filter((o) => !latestText(arts, 'script', o)).map((o) => `${ORIENT[o].label}还没有口播稿`),
    ...docs.filter((a) => a.kind !== 'article' && a.status === 'draft')
      .map((a) => `${a.variant ? ORIENT[a.variant].label : ''}${TEXT_LABEL[a.kind as TextKind]} v${a.version} 还是草稿，没交验收`),
    ...(hasDraft ? ['内容编写里还有没保存的草稿，这里看到的是已保存的版本'] : []),
  ]
  return { docs, warns }
}
