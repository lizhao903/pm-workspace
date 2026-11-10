// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '../data'
import { artifactKind, bubbleIds, foldHistory, foldLive, overlayCalls, parseQuestion, titleFrom, toolAbility, whenGroup } from './chatModel'

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
    expect(out[1].calls).toEqual([{ name: 'create_object', args: '{"title":"x"}', summary: '已建 TSK-0009', state: 'done', msgIds: ['t1'] }])
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

describe('要人确认的调用（AG-02b）', () => {
  const asked = (id: string, args = '{"title":"开通试点账号"}') =>
    msg({ id, role: 'tool', tool_name: 'create_object', tool_args: args, content: '等待确认：新建「开通试点账号」' })

  it('「等待确认：」是等你确认的卡片，回复里「【等你确认】」那行不再重复', () => {
    const out = foldHistory([
      msg({ id: 'u1', role: 'user', content: '建一条任务' }),
      asked('t1'),
      msg({ id: 'a1', role: 'assistant', content: '我准备建一条任务。\n【等你确认】新建「开通试点账号」，确认后才会执行。\n' }),
    ])
    expect(out[1].calls).toEqual([{ name: 'create_object', args: '{"title":"开通试点账号"}', state: 'pending', asked: true, msgIds: ['t1'] }])
    expect(out[1].text).toBe('我准备建一条任务。')
  })

  it('确认、拒绝后的结果合回原卡片，不另起一张；参数空白不同也认', () => {
    const ok = foldHistory([
      asked('t1'), msg({ id: 'a1', role: 'assistant', content: '【等你确认】新建「开通试点账号」，确认后才会执行。' }),
      msg({ id: 't2', role: 'tool', tool_name: 'create_object', tool_args: '{ "title": "开通试点账号" }', content: '已新建 TSK-0009' }),
      msg({ id: 'a2', role: 'assistant', content: '建好了' }),
    ])
    expect(ok.map((m) => m.calls.map((c) => [c.state, c.summary]))).toEqual([[['confirmed', '已新建 TSK-0009']], []])
    expect(ok[1].text).toBe('建好了')
    const no = foldHistory([
      asked('t1'), msg({ id: 'a1', role: 'assistant', content: '' }),
      msg({ id: 't2', role: 'tool', tool_name: 'create_object', tool_args: '{"title":"开通试点账号"}', content: '用户拒绝了：新建「开通试点账号」，没有执行' }),
      msg({ id: 'a2', role: 'assistant', content: '好的，不建了' }),
    ])
    expect(no[0].calls[0].state).toBe('rejected')
  })

  it('流里的 confirm 是带 id 的等你确认；确认接着跑的一轮不再列那次调用本身', () => {
    expect(foldLive([{ type: 'confirm', id: 'atc_1', name: 'create_object', args: '{}', summary: '新建「x」' }]).calls)
      .toEqual([{ name: 'create_object', args: '{}', state: 'pending', id: 'atc_1' }])
    const live = foldLive([
      { type: 'tool_call', name: 'create_object', args: '{}' },
      { type: 'tool_result', name: 'create_object', summary: '已新建 TSK-0009' },
      { type: 'tool_call', name: 'search_objects', args: '{}' },
      { type: 'delta', text: '建好了' },
    ], true)
    expect(live.calls.map((c) => c.name)).toEqual(['search_objects'])
    expect(live.text).toBe('建好了')
  })

  it('补 id 从最近的往前配，处理过的也占掉自己的 id；点过的先换状态', () => {
    const views = foldHistory([
      asked('t1'), msg({ id: 'a1', role: 'assistant', content: '' }),
      msg({ id: 't2', role: 'tool', tool_name: 'create_object', tool_args: '{"title":"开通试点账号"}', content: '已新建 TSK-0009' }),
      msg({ id: 'u2', role: 'user', content: '再建一条' }),
      asked('t3'), msg({ id: 'a3', role: 'assistant', content: '' }),
    ])
    // 只知道最近那次的 id（页面加载后才收到的 confirm 事件）
    const one = overlayCalls(views, [{ id: 'atc_2', name: 'create_object', args: '{"title":"开通试点账号"}' }], {})
    expect(one[0].calls[0]).toMatchObject({ state: 'confirmed' })
    expect(one[0].calls[0].id).toBeUndefined()
    expect(one[2].calls[0]).toMatchObject({ state: 'pending', id: 'atc_2' })
    const both = overlayCalls(views, [
      { id: 'atc_1', name: 'create_object', args: '{"title":"开通试点账号"}' }, { id: 'atc_2', name: 'create_object', args: '{"title":"开通试点账号"}' },
    ], { atc_2: { approve: false } })
    expect(both[0].calls[0].id).toBe('atc_1')
    expect(both[2].calls[0]).toMatchObject({ id: 'atc_2', state: 'rejected' })
  })

  it('权限没开时要开的那一项', () => {
    expect(toolAbility('create_object')).toBe('新建 / 更新任务')
    expect(toolAbility('github__create_issue')).toBe('github__create_issue')
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

describe('移除气泡对应的原始消息（SPEC-sessions-1.43）', () => {
  it('用户一条；Agent 是回复加上面的工具调用，等确认的连同确认结果；只有调用的取调用', () => {
    const out = foldHistory([
      msg({ id: 'u1', role: 'user', content: '改一下' }),
      msg({ id: 't1', role: 'tool', tool_name: 'search_objects', content: '3 条' }),
      msg({ id: 't2', role: 'tool', tool_name: 'update_object', tool_args: '{"ref":"TSK-1"}', content: '等待确认：修改 TSK-1' }),
      msg({ id: 'a1', role: 'assistant', content: '等你确认' }),
      msg({ id: 't3', role: 'tool', tool_name: 'update_object', tool_args: '{"ref":"TSK-1"}', content: '已更新 TSK-1' }),
      msg({ id: 'u2', role: 'user', content: '再查' }),
      msg({ id: 't4', role: 'tool', tool_name: 'search_objects', content: '0 条' }),
    ])
    expect(out.map(bubbleIds)).toEqual([['u1'], ['a1', 't1', 't2', 't3'], ['u2'], ['t4']])
  })
})
