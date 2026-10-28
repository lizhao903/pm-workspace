import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '../../core/data'
import { artifactKind, foldHistory, foldLive, parseQuestion, titleFrom, whenGroup } from './chatModel'

const msg = (p: Partial<AgentMessage>): AgentMessage => ({
  id: 'm' + Math.random().toString(36).slice(2, 8), session_id: 'ags_1', role: 'user', content: '', created_at: '2026-10-29T01:00:00Z', ...p,
})

describe('提问的解析', () => {
  it('后端拼进回复里的提问拆成问题和选项，前面的正文留着', () => {
    const r = parseQuestion('我看了一下。\n【需要你确认】这个需求要不要拆成独立任务？\n- 拆成三个任务：按前端/后端/联调拆\n- 先不拆：作为一个整体推进\n')
    expect(r).toEqual({
      text: '我看了一下。',
      question: {
        question: '这个需求要不要拆成独立任务？', multi: false,
        options: [{ label: '拆成三个任务', detail: '按前端/后端/联调拆' }, { label: '先不拆', detail: '作为一个整体推进' }],
      },
    })
  })

  it('可多选的标记去掉；没有选项、没有标记的不算提问', () => {
    expect(parseQuestion('【需要你确认】挑哪些？（可多选）\n- A：甲\n- B：乙')?.question.multi).toBe(true)
    expect(parseQuestion('【需要你确认】挑哪些？（可多选）\n- A：甲')?.question.question).toBe('挑哪些？')
    expect(parseQuestion('【需要你确认】光有问题')).toBeNull()
    expect(parseQuestion('普通回复\n- 列表：不是选项')).toBeNull()
  })
})

describe('消息折叠', () => {
  it('tool 消息挂到后面那条回复上；回复里的提问拆出来', () => {
    const out = foldHistory([
      msg({ id: 'u1', role: 'user', content: '建一条任务' }),
      msg({ id: 't1', role: 'tool', tool_name: 'create_object', tool_args: '{"title":"x"}', content: '已建 TSK-0009' }),
      msg({ id: 'a1', role: 'assistant', content: '建好了。\n【需要你确认】要不要设截止日？\n- 要：周五\n- 不要：先放着' }),
    ])
    expect(out.map((m) => [m.id, m.role])).toEqual([['u1', 'user'], ['a1', 'agent']])
    expect(out[1].calls).toEqual([{ name: 'create_object', args: '{"title":"x"}', summary: '已建 TSK-0009', state: 'done' }])
    expect(out[1].text).toBe('建好了。')
    expect(out[1].question?.options.map((o) => o.label)).toEqual(['要', '不要'])
  })

  it('最后一组工具调用后面没有回复（中途失败）时单独成一条', () => {
    const out = foldHistory([msg({ id: 'u1', role: 'user', content: '查' }), msg({ id: 't1', role: 'tool', tool_name: 'search_objects', content: '3 条' })])
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({ id: 't1', role: 'agent', text: '', calls: [{ name: 'search_objects', state: 'done' }] })
  })

  it('流里的事件：正文拼接，工具调用和结果按名字配对，提问和出错单独记', () => {
    const live = foldLive([
      { type: 'delta', text: '好的，' },
      { type: 'tool_call', name: 'search_objects', args: '{}' },
      { type: 'tool_call', name: 'get_object', args: '{"id":"x"}' },
      { type: 'tool_result', name: 'search_objects', summary: '找到 2 条' },
      { type: 'artifact', path: 'a.md', size: 3 },
      { type: 'delta', text: '查完了' },
      { type: 'question', id: 'q1', question: '选哪个？', options: [{ label: 'A', detail: '甲' }], multi: false },
    ])
    expect(live.text).toBe('好的，查完了')
    expect(live.calls.map((c) => [c.name, c.state, c.summary])).toEqual([['search_objects', 'done', '找到 2 条'], ['get_object', 'running', undefined]])
    expect(live.files).toEqual([{ path: 'a.md', size: 3 }])
    expect(live.question?.id).toBe('q1')
    expect(foldLive([{ type: 'error', message: '模型不可用' }]).error).toBe('模型不可用')
  })
})

describe('其他', () => {
  it('标题取第一行前 20 个字', () => {
    expect(titleFrom('  帮我看看这周的需求\n第二行')).toBe('帮我看看这周的需求')
    expect(titleFrom('一二三四五六七八九十一二三四五六七八九十多出来')).toBe('一二三四五六七八九十一二三四五六七八九十')
  })

  it('时间分段：今天 / 本周（从周一算）/ 更早', () => {
    // 2026-10-29 是周四
    const now = new Date(2026, 9, 29, 15, 0)
    expect(whenGroup(new Date(2026, 9, 29, 0, 1).toISOString(), now)).toBe('今天')
    expect(whenGroup(new Date(2026, 9, 26, 9, 0).toISOString(), now)).toBe('本周')
    expect(whenGroup(new Date(2026, 9, 25, 23, 0).toISOString(), now)).toBe('更早')
  })

  it('产出物类型：代码标记优先，其次链接，否则文件', () => {
    expect(artifactKind({ note: '[commit] sha=abc', url: '' })).toBe('commit')
    expect(artifactKind({ note: '', url: 'https://x' })).toBe('link')
    expect(artifactKind({ note: '说明', url: '' })).toBe('file')
  })
})
