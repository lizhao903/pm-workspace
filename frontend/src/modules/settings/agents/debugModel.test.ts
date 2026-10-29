import { describe, expect, it } from 'vitest'
import { failMsg, finishMsg, markDecided, reduceEvent, transcript, type DbgMsg } from './debugModel'

const user = (id: number, text: string): DbgMsg => ({ id, role: 'user', text, calls: [], files: [] })
const agentMsg = (id: number, p: Partial<DbgMsg> = {}): DbgMsg => ({ id, role: 'agent', text: '', calls: [], files: [], streaming: true, ...p })

describe('调试对话（SPEC-settings-9.31）', () => {
  it('带给后端的对话只要有字的，失败的不带', () => {
    expect(transcript([user(1, '查任务'), agentMsg(2, { text: '有 3 条' }), user(3, '建一条'), agentMsg(4, { error: '模型不可用', text: '半句' }), user(5, '再试')]))
      .toEqual([
        { role: 'user', content: '查任务' }, { role: 'assistant', content: '有 3 条' }, { role: 'user', content: '建一条' }, { role: 'user', content: '再试' },
      ])
  })

  it('事件折进回复：正文、工具配对、需确认的带 id', () => {
    let ms: DbgMsg[] = [user(1, '建一条任务'), agentMsg(2)]
    ms = reduceEvent(ms, 2, { type: 'delta', text: '好的' })
    ms = reduceEvent(ms, 2, { type: 'tool_call', name: 'search_objects', args: '{}' })
    ms = reduceEvent(ms, 2, { type: 'tool_result', name: 'search_objects', summary: '找到 2 条' })
    ms = reduceEvent(ms, 2, { type: 'confirm', id: 'dbg_1', name: 'create_object', args: '{"title":"x"}', summary: '新建「x」' })
    ms = finishMsg(ms, 2)
    expect(ms[1]).toMatchObject({ text: '好的', streaming: false })
    expect(ms[1].calls.map((c) => [c.name, c.state, c.id])).toEqual([['search_objects', 'done', undefined], ['create_object', 'pending', 'dbg_1']])
  })

  it('确认后卡片先换状态，接着跑的第一对调用结果写回原卡片，后面的照常列', () => {
    let ms: DbgMsg[] = [agentMsg(2, { streaming: false, calls: [{ name: 'create_object', args: '{}', state: 'pending', id: 'dbg_1' }] })]
    ms = [...markDecided(ms, 2, 'dbg_1', true), agentMsg(3, { decide: { msgId: 2, callId: 'dbg_1', approve: true } })]
    expect(ms[0].calls[0].state).toBe('confirmed')
    ms = reduceEvent(ms, 3, { type: 'tool_call', name: 'create_object', args: '{}' })
    ms = reduceEvent(ms, 3, { type: 'tool_result', name: 'create_object', summary: '已新建 TSK-0009' })
    ms = reduceEvent(ms, 3, { type: 'tool_call', name: 'get_object', args: '{}' })
    ms = reduceEvent(ms, 3, { type: 'delta', text: '建好了' })
    expect(ms[0].calls[0]).toMatchObject({ state: 'confirmed', summary: '已新建 TSK-0009' })
    expect(ms[1].calls.map((c) => c.name)).toEqual(['get_object'])
    expect(ms[1].text).toBe('建好了')
  })

  it('确认没跑起来（过期、处理过）时卡片退回等你确认', () => {
    let ms: DbgMsg[] = [agentMsg(2, { streaming: false, calls: [{ name: 'create_object', args: '{}', state: 'pending', id: 'dbg_1' }] })]
    ms = [...markDecided(ms, 2, 'dbg_1', false), agentMsg(3, { decide: { msgId: 2, callId: 'dbg_1', approve: false } })]
    ms = failMsg(ms, 3, '这次调用已经过期')
    expect(ms[0].calls[0].state).toBe('pending')
    expect(ms[1]).toMatchObject({ streaming: false, error: '这次调用已经过期' })
  })
})
