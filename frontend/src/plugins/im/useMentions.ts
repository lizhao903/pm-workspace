// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 回复框、发消息弹窗里 @ 的状态（IM 插件 0.18.0）：「回复时 @ 对方」开关、从候选里选过谁；发送时由 compose 拼正文、筛 mentions。
// 开关只在群聊回复时有（def 不为空），默认打开；改了记在本机（localStorage），下次打开回复框按上次的设置。
import { useState } from 'react'
import type { ImAction, ImMessage } from '../../core/data'
import { composeMentions, defaultMention, type MentionPick } from './mentionModel'

const STORE_KEY = 'pmw.im.replyMention'

/** 本机记的开关：没记过、读不到算打开 */
export function readReplyMention(): boolean {
  try {
    return localStorage.getItem(STORE_KEY) !== 'off'
  } catch {
    return true
  }
}

function writeReplyMention(on: boolean) {
  try {
    localStorage.setItem(STORE_KEY, on ? 'on' : 'off')
  } catch {
    // 本机存不了（隐私模式等）就只管这一次
  }
}

/** def 是回复时要 @ 的对方（群聊回复的原发信人）；私聊、发消息弹窗传 null，没有开关 */
export function useMentions(def: MentionPick | null) {
  const [on, setOnState] = useState(readReplyMention)
  const [picked, setPicked] = useState<MentionPick[]>([])
  const tag = def && on ? def : null
  return {
    /** 有没有「回复时 @ 对方」开关（群聊回复才有） */
    toggle: def,
    on,
    setOn: (v: boolean) => { setOnState(v); writeReplyMention(v) },
    tag,
    pick: (p: MentionPick) => setPicked((x) => [...x, p]),
    compose: (text: string) => composeMentions(text, tag, picked),
    /** 发出去后清掉选过的人 */
    clear: () => setPicked([]),
  }
}

/** 列表行上「回复」菜单的快捷回复：同回复框，群聊且本机开关打开时 @ 原发信人 */
export function quickReplyAction(m: ImMessage, text: string, done: boolean): ImAction {
  const def = defaultMention(m)
  const { text: body, mentions } = composeMentions(text, def && readReplyMention() ? def : null, [])
  return { kind: 'reply', text: body, done, ...(mentions.length ? { mentions } : {}) }
}
