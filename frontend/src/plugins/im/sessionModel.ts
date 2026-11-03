// 从消息发起会话、拆分任务（0008）的纯函数：默认挑哪个 Agent、会话标题、会话来源、第一句话。
// 会话来源 source_ref 的形状同「转任务」写进任务的那份（后端 toTask），多一个 message_ids（合并显示的一组）、kind、label、project_id；
// 内核把它记进会话，会话里 Agent 建的任务缺省带上它、挂到 project_id 的项目（内核 0047）。
import type { Agent, AgentGrantMode, ImMessage, ImSessionIntent, SessionSourceRef } from '../../core/data'
import { shortTime, whoName } from './model'

/** 会话页里打开某个会话 */
export const sessionPath = (id: string) => `/conversations?s=${encodeURIComponent(id)}`

/** 会话来源的种类：会话页按它找 IM 插件登记的显示方式 */
export const SOURCE_KIND = 'im_message'
/** 上次从消息发起会话用的 Agent 记在本机 */
export const LAST_AGENT_KEY = 'im.session.agent'
/** 来源里正文的上限（同后端转任务） */
const SOURCE_TEXT_MAX = 500
/** 第一句话里最多带几条消息的原文，再多只写条数（私聊整段可能很长） */
export const PROMPT_MESSAGES_MAX = 40

const clip = (s: string, n: number) => {
  const xs = Array.from(s.replace(/\s+/g, ' ').trim())
  return xs.length > n ? `${xs.slice(0, n).join('')}…` : xs.join('')
}

/**
 * 能用的 Agent 里挑默认的：上次用的；有 IM 触发的；名字、说明里像是管任务或消息的；最后是第一个启用的。
 * 给了 writable（拆分任务时按「写任务」的实际档位）就先在能建任务的里按这个顺序挑，一个都没有再不看它
 */
export function pickAgent(agents: readonly Agent[], lastId?: string | null, writable?: (a: Agent) => boolean): Agent | undefined {
  const pick = (usable: readonly Agent[]) => usable.find((a) => a.id === lastId)
    ?? usable.find((a) => a.triggers.some((t) => t.kind === 'im'))
    ?? usable.find((a) => /任务|拆|消息|IM|助理|助手/i.test(`${a.name} ${a.desc}`))
    ?? usable[0]
  const usable = agents.filter((a) => a.enabled)
  return (writable && pick(usable.filter(writable))) || pick(usable)
}

/** 按时间正序 */
const chrono = (xs: readonly ImMessage[]) => [...xs].sort((a, b) => a.at.localeCompare(b.at))

/** 这组消息归的项目：最新一条有归属的 */
export function projectOf(xs: readonly ImMessage[]): { id: string; name: string } | null {
  const m = chrono(xs).reverse().find((x) => x.project_id)
  return m?.project_id ? { id: m.project_id, name: m.project_name } : null
}

/** 群名或「和 X 的私聊」 */
const where = (m: ImMessage) => (m.conversation ? `群「${m.conversation}」` : `和 ${whoName(m)} 的私聊`)

export function sessionTitle(xs: readonly ImMessage[], intent: ImSessionIntent): string {
  const last = chrono(xs).at(-1)!
  const gist = `${whoName(last)}「${clip(last.text, 16) || '（没有正文）'}」`
  return intent === 'split' ? `拆分任务：${gist}` : `IM 消息：${gist}`
}

/** 会话来源：指回这组消息（message_id 是最新一条，会话页的「来源」点回它） */
export function sourceRef(xs: readonly ImMessage[], chLabel: string): SessionSourceRef {
  const all = chrono(xs)
  const last = all.at(-1)!
  const p = projectOf(all)
  return {
    kind: SOURCE_KIND,
    label: `${chLabel} 消息：${whoName(last)}「${clip(last.text, 20) || '（没有正文）'}」${all.length > 1 ? `等 ${all.length} 条` : ''}`,
    message_id: last.id,
    message_ids: all.map((m) => m.id),
    channel: last.channel, connector_id: last.connector_id, external_id: last.external_id,
    conversation_id: last.conversation_id, conversation: last.conversation,
    sender: whoName(last), sender_id: last.sender_id,
    text: clip(all.map((m) => m.text).join('\n'), SOURCE_TEXT_MAX), at: last.at,
    ...(p ? { project_id: p.id } : {}),
  }
}

/**
 * 第一句话：消息的原文、发信人、群、时间、归属项目、附件名，加上意图。
 * 拆分任务时让 Agent 先把清单列出来再逐条建：Agent 建任务的授权是「需确认」时每条都会弹确认卡片，在卡片上点确认才建；
 * 是「自动」时没有卡片，就让它列完先停下等用户回话
 */
export function sessionPrompt(xs: readonly ImMessage[], intent: ImSessionIntent, opts: { chLabel: string; grant?: AgentGrantMode }): string {
  const all = chrono(xs)
  const last = all.at(-1)!
  const senders = [...new Set(all.map((m) => `${whoName(m)}（${opts.chLabel} 编号 ${m.sender_id}）`))]
  const p = projectOf(all)
  const atts = [...new Set(all.flatMap((m) => m.attachments.map((a) => a.name)))]
  const time = all.length > 1 ? `${shortTime(all[0].at)} 到 ${shortTime(last.at)}` : shortTime(last.at)
  const shown = all.slice(-PROMPT_MESSAGES_MAX)
  const lines = [
    `下面是 ${opts.chLabel} 上${where(last)}里收到的 ${all.length} 条消息。`,
    '',
    `发信人：${senders.join('、')}`,
    `群：${last.conversation || '私聊'}`,
    `时间：${time}`,
    `归属项目：${p ? p.name || p.id : '未归项目'}`,
    ...(atts.length ? [`附件：${atts.join('、')}`] : []),
    '',
    '消息原文：',
    ...(all.length > shown.length ? [`（前面还有 ${all.length - shown.length} 条，只带最近 ${shown.length} 条）`] : []),
    ...shown.map((m) => `[${shortTime(m.at)}] ${whoName(m)}：${m.text.trim() || '（没有正文）'}`),
    '',
  ]
  if (intent === 'split') {
    lines.push(
      '请把消息里要做的事拆成若干条任务。',
      '先用一个列表写出拆分清单：每条一个标题（一句话说清做什么），再写一句说明；消息里提到了优先级、截止时间就带上，没提到的不要编。拆不出来就直说，不要硬拆。',
      opts.grant === 'auto'
        ? '列完先停下，等我回复确认或修改后，再用 create_object 逐条建成任务（type_id 为 task）。'
        : '列完后用 create_object 逐条建成任务（type_id 为 task），每建一条我会在确认卡片上确认或拒绝，拒绝的就跳过、接着建下一条。',
      p ? `任务不用指定项目，会自动挂到项目「${p.name || p.id}」下，并记上来源消息。` : '任务会自动记上来源消息。',
    )
  } else {
    lines.push('请先帮我理解这些消息：说的是什么事、需要我做什么、有没有要马上回复的；需要建任务时先告诉我。')
  }
  return lines.join('\n')
}

/** 项目 props.related 里第一个关联目录的路径；存成 file:// 的也认 */
export function relatedDir(props: Record<string, unknown> | null | undefined): string {
  const list = Array.isArray(props?.related) ? (props!.related as { path?: unknown }[]) : []
  const p = list.find((x) => typeof x?.path === 'string' && x.path)?.path as string | undefined
  return p ? p.replace(/^file:\/\//, '') : ''
}
