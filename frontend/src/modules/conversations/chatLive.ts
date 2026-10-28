// 正在进行的对话（AG-01a）。回复在流里一段段来，落库要等收尾，
// 所以流的状态放在模块级：切到别的会话再切回来、离开会话页再回来，都还能看到这一轮。
import { useSyncExternalStore } from 'react'
import { errorText, streamChat, type ChatEvent } from '../../core/data'

export type LivePhase = 'streaming' | 'done' | 'failed'

export type LiveChat = {
  sessionId: string
  /** 这一轮人说的话；落库前先显示 */
  text: string
  events: ChatEvent[]
  phase: LivePhase
  /** 开流失败、断流、对话出错的原因 */
  error?: string
}

let live: Record<string, LiveChat> = {}
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function set(sessionId: string, next: LiveChat | null) {
  const copy = { ...live }
  if (next) copy[sessionId] = next
  else delete copy[sessionId]
  live = copy
  emit()
}

function patch(sessionId: string, f: (c: LiveChat) => LiveChat) {
  const cur = live[sessionId]
  if (cur) set(sessionId, f(cur))
}

/**
 * 在一个会话里发一句话。收尾后按失效规则刷新消息，消息读回来再收起这一轮；
 * 失败的留着，显示原因和「重试」。同一个会话同时只跑一轮，正在回复时再发直接忽略，返回 false。
 */
export function sendChat(sessionId: string, text: string): boolean {
  if (live[sessionId]?.phase === 'streaming') return false
  set(sessionId, { sessionId, text, events: [], phase: 'streaming' })
  const { done, settled } = streamChat({ session_id: sessionId, message: text }, {
    onEvent: (e) => patch(sessionId, (c) => ({ ...c, events: [...c.events, e] })),
  })
  done.then(
    () => patch(sessionId, (c) => ({ ...c, phase: 'done' })),
    (err: unknown) => patch(sessionId, (c) => ({ ...c, phase: 'failed', error: errorText(err) })),
  )
  void settled.then(() => {
    if (live[sessionId]?.phase === 'done') set(sessionId, null)
  })
  return true
}

/** 收起失败的那一轮（重试前、或者人不想管了） */
export function dismissChat(sessionId: string) {
  if (live[sessionId]?.phase !== 'streaming') set(sessionId, null)
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

const snapshot = () => live

export function useLiveChat(sessionId: string | null): LiveChat | undefined {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot)
  return sessionId ? all[sessionId] : undefined
}

/** 测试用：清空模块级状态 */
export function resetLiveChats() {
  live = {}
  emit()
}
