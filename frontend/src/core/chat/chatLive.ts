// 正在进行的对话（AG-01a）。回复在流里一段段来，落库要等收尾，
// 所以流的状态放在模块级：切到别的会话再切回来、离开会话页再回来，都还能看到这一轮。
// 要人确认的调用（AG-02b）：confirm 事件里的 id 记在这里（落库的消息里没有 id）；点了确认、拒绝，
// 接着跑的那一轮也是一轮流，结果先记着，消息读回来后以读回的为准。
import { useSyncExternalStore } from 'react'
import { errorText, streamChat, streamDecision, type ChatEvent } from '../data'
import type { CallDecision, CallRef } from './chatModel'

export type LivePhase = 'streaming' | 'done' | 'failed'

export type LiveChat = {
  sessionId: string
  /** 这一轮人说的话；落库前先显示。确认、拒绝接着跑的一轮为空 */
  text: string
  events: ChatEvent[]
  phase: LivePhase
  /** 开流失败、断流、对话出错的原因 */
  error?: string
  /** 确认、拒绝接着跑的一轮：处理的是哪次调用 */
  decide?: { callId: string; approve: boolean }
}

type State = {
  live: Record<string, LiveChat>
  /** 每个会话里 confirm 事件给过的调用 */
  refs: Record<string, CallRef[]>
  /** 点过确认、拒绝的调用 */
  decisions: Record<string, CallDecision>
}

let state: State = { live: {}, refs: {}, decisions: {} }
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function update(f: (s: State) => State) {
  state = f(state)
  emit()
}

function set(sessionId: string, next: LiveChat | null) {
  update((s) => {
    const live = { ...s.live }
    if (next) live[sessionId] = next
    else delete live[sessionId]
    return { ...s, live }
  })
}

function patch(sessionId: string, f: (c: LiveChat) => LiveChat) {
  const cur = state.live[sessionId]
  if (cur) set(sessionId, f(cur))
}

function addRef(sessionId: string, e: ChatEvent) {
  if (e.type !== 'confirm') return
  update((s) => ({ ...s, refs: { ...s.refs, [sessionId]: [...(s.refs[sessionId] ?? []), { id: e.id, name: e.name, args: e.args }] } }))
}

function setDecision(callId: string, d: CallDecision | null) {
  update((s) => {
    const decisions = { ...s.decisions }
    if (d) decisions[callId] = d
    else delete decisions[callId]
    return { ...s, decisions }
  })
}

/** 收尾：消息读回来再收起这一轮；失败的留着 */
function follow(sessionId: string, done: Promise<unknown>, settled: Promise<void>, onFail?: () => void) {
  done.then(
    () => patch(sessionId, (c) => ({ ...c, phase: 'done' })),
    (err: unknown) => {
      onFail?.()
      patch(sessionId, (c) => ({ ...c, phase: 'failed', error: errorText(err) }))
    },
  )
  void settled.then(() => {
    if (state.live[sessionId]?.phase === 'done') set(sessionId, null)
  })
}

/**
 * 在一个会话里发一句话。收尾后按失效规则刷新消息，消息读回来再收起这一轮；
 * 失败的留着，显示原因和「重试」。同一个会话同时只跑一轮，正在回复时再发直接忽略，返回 false。
 */
export function sendChat(sessionId: string, text: string): boolean {
  if (state.live[sessionId]?.phase === 'streaming') return false
  set(sessionId, { sessionId, text, events: [], phase: 'streaming' })
  const { done, settled } = streamChat({ session_id: sessionId, message: text }, {
    onEvent: (e) => {
      addRef(sessionId, e)
      patch(sessionId, (c) => ({ ...c, events: [...c.events, e] }))
    },
  })
  follow(sessionId, done, settled)
  return true
}

/**
 * 确认或拒绝会话里的一次调用，接着跑的回复按一轮流显示在这个会话里（SPEC-sessions-1.17、2.5）。
 * 卡片先换状态，第一条工具结果写回卡片；没跑起来（已经处理过、Agent 停用、授权已关）卡片退回等你确认。
 * 这个会话正在回复时返回 false。
 */
export function decideCall(sessionId: string, callId: string, approve: boolean): boolean {
  if (state.live[sessionId]?.phase === 'streaming') return false
  setDecision(callId, { approve })
  set(sessionId, { sessionId, text: '', events: [], phase: 'streaming', decide: { callId, approve } })
  let resolved = false
  const { done, settled } = streamDecision(callId, approve, sessionId, {
    onEvent: (e) => {
      if (!resolved && e.type === 'tool_result') {
        resolved = true
        setDecision(callId, { approve, summary: e.summary })
      }
      addRef(sessionId, e)
      patch(sessionId, (c) => ({ ...c, events: [...c.events, e] }))
    },
  })
  follow(sessionId, done, settled, () => {
    if (!resolved) setDecision(callId, null)
  })
  return true
}

/** 收起失败的那一轮（重试前、或者人不想管了） */
export function dismissChat(sessionId: string) {
  if (state.live[sessionId]?.phase !== 'streaming') set(sessionId, null)
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

const snapshot = () => state

export function useLiveChat(sessionId: string | null): LiveChat | undefined {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot)
  return sessionId ? s.live[sessionId] : undefined
}

/** 这个会话有没有发过、正在发的一轮（还没落库或落库失败的也算），组件外用 */
export function hasLiveChat(sessionId: string): boolean {
  return !!state.live[sessionId]
}

const NO_REFS: CallRef[] = []

/** 会话里 confirm 事件给过的调用，和点过的确认、拒绝 */
export function useCallState(sessionId: string | null): { refs: CallRef[]; decisions: Record<string, CallDecision> } {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot)
  return { refs: (sessionId && s.refs[sessionId]) || NO_REFS, decisions: s.decisions }
}

/** 某次调用正在确认、拒绝（接着跑的那一轮还没收尾） */
export function useDeciding(callId: string | undefined): boolean {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot)
  return !!callId && Object.values(s.live).some((c) => c.phase === 'streaming' && c.decide?.callId === callId)
}

/** 测试用：清空模块级状态 */
export function resetLiveChats() {
  state = { live: {}, refs: {}, decisions: {} }
  emit()
}
