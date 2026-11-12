// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 调试对话的纯函数（AG-02b，SPEC-settings-9.31）：对话由前端自己留着，每次整段带给 /api/agents/debug/chat；
// 流里的事件折进正在回复的那条；确认、拒绝后接着跑的回复另起一条，执行结果写回原来那张卡片。
import type { ChatEvent, DebugChatMessage } from '../../../core/data'

export type DbgCallState = 'running' | 'done' | 'pending' | 'confirmed' | 'rejected'
export type DbgCall = { name: string; args: string; summary?: string; state: DbgCallState; /** 要人确认的调用 id（dbg_） */ id?: string }

export type DbgMsg = {
  id: number
  role: 'user' | 'agent'
  text: string
  calls: DbgCall[]
  /** 写出的文件（相对产物目录） */
  files: string[]
  streaming?: boolean
  error?: string
  /** 确认、拒绝后接着跑的这条：第一条工具结果写回哪张卡片 */
  decide?: { msgId: number; callId: string; approve: boolean; resolved?: boolean }
}

/** 空对话里的示例问题，同会话页（SPEC-sessions-1.19） */
export const DEBUG_EXAMPLES = ['我现在有哪些任务最急？', '建一条任务：周五前整理演示环境', '最近有哪些需求还没开始？', '这周的周报帮我汇总一下']

// 工具的显示名和归哪项能力（契约「Agent 工具授权」的内置工具表）；连接器工具照原名
const TOOLS: Record<string, { label: string; ability?: string; write?: boolean }> = {
  search_objects: { label: '查工作对象', ability: '查任务' },
  get_object: { label: '读工作对象', ability: '查任务' },
  list_types: { label: '查对象类型' },
  create_object: { label: '新建工作对象', ability: '新建 / 更新任务', write: true },
  update_object: { label: '修改工作对象', ability: '新建 / 更新任务', write: true },
  write_file: { label: '写文件', ability: '写文档', write: true },
  kb_search: { label: '查知识库', ability: '读文档' },
}
export const toolLabel = (name: string) => TOOLS[name]?.label ?? name
export const isWriteTool = (name: string) => !!TOOLS[name]?.write
/** 授权关了时要开的那一项：内置工具是能力名，连接器工具是工具名 */
export const abilityOf = (name: string) => TOOLS[name]?.ability ?? name

/** 后端对授权关了的工具的结果是「<工具> 没有授权，没有执行」 */
export const NO_GRANT = /没有授权/

/** 带给后端的对话：只要有字的，失败的那条不带；最后一条是这次要发的话 */
export function transcript(msgs: readonly DbgMsg[]): DebugChatMessage[] {
  const out: DebugChatMessage[] = []
  for (const m of msgs) {
    const content = m.text.trim()
    if (!content || m.error) continue
    out.push({ role: m.role === 'user' ? 'user' : 'assistant', content })
  }
  return out
}

const patchMsg = (msgs: readonly DbgMsg[], id: number, f: (m: DbgMsg) => DbgMsg) => msgs.map((m) => (m.id === id ? f(m) : m))

const patchCall = (msgs: readonly DbgMsg[], msgId: number, callId: string, f: (c: DbgCall) => DbgCall) =>
  patchMsg(msgs, msgId, (m) => ({ ...m, calls: m.calls.map((c) => (c.id === callId ? f(c) : c)) }))

/** 点了确认、拒绝：卡片先换状态，结果等流里的工具结果 */
export function markDecided(msgs: readonly DbgMsg[], msgId: number, callId: string, approve: boolean): DbgMsg[] {
  return patchCall(msgs, msgId, callId, (c) => ({ ...c, state: approve ? 'confirmed' : 'rejected' }))
}

/** 一条事件折进 target 那条回复 */
export function reduceEvent(msgs: readonly DbgMsg[], target: number, e: ChatEvent): DbgMsg[] {
  const cur = msgs.find((m) => m.id === target)
  if (!cur) return [...msgs]
  const d = cur.decide
  // 确认接着跑的第一对 tool_call / tool_result 是那次调用本身，写回原卡片
  if (d && !d.resolved && (e.type === 'tool_call' || e.type === 'tool_result')) {
    if (e.type === 'tool_call') return [...msgs]
    const next = patchCall(msgs, d.msgId, d.callId, (c) => ({ ...c, summary: e.summary }))
    return patchMsg(next, target, (m) => ({ ...m, decide: { ...d, resolved: true } }))
  }
  return patchMsg(msgs, target, (m) => {
    switch (e.type) {
      case 'delta':
        return { ...m, text: m.text + e.text }
      case 'tool_call':
        return { ...m, calls: [...m.calls, { name: e.name, args: e.args, state: 'running' }] }
      case 'tool_result': {
        const i = m.calls.findIndex((c) => c.state === 'running' && c.name === e.name)
        if (i < 0) return { ...m, calls: [...m.calls, { name: e.name, args: '', summary: e.summary, state: 'done' }] }
        return { ...m, calls: m.calls.map((c, j) => (j === i ? { ...c, summary: e.summary, state: 'done' } : c)) }
      }
      case 'confirm':
        return { ...m, calls: [...m.calls, { name: e.name, args: e.args, summary: undefined, state: 'pending', id: e.id }] }
      case 'artifact':
        return { ...m, files: [...m.files, e.path] }
      case 'question':
        // 调试里不做选项按钮，问题和选项拼成文字，直接打字回答
        return { ...m, text: [m.text.trim(), e.question, ...e.options.map((o) => `- ${o.label}${o.detail ? `：${o.detail}` : ''}`)].filter(Boolean).join('\n') }
      default:
        return m
    }
  })
}

/** 流收尾 */
export const finishMsg = (msgs: readonly DbgMsg[], target: number) => patchMsg(msgs, target, (m) => ({ ...m, streaming: false }))

/** 出错：记原因；确认、拒绝没跑起来（过期、已经处理过）时卡片退回等你确认 */
export function failMsg(msgs: readonly DbgMsg[], target: number, error: string): DbgMsg[] {
  const cur = msgs.find((m) => m.id === target)
  let next = patchMsg(msgs, target, (m) => ({ ...m, streaming: false, error }))
  const d = cur?.decide
  if (d && !d.resolved && !cur?.text && !cur?.calls.length) next = patchCall(next, d.msgId, d.callId, (c) => ({ ...c, state: 'pending' }))
  return next
}

/** 流里写回答还没出字、也没调工具时显示「正在回复」 */
export const isThinking = (m: DbgMsg) => !!m.streaming && !m.text && !m.calls.length

/** 只有不在跑的时候、等你确认的卡片能点 */
export const canDecide = (msgs: readonly DbgMsg[]) => !msgs.some((m) => m.streaming)
