import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../../core/api'
import { duration, extraOf, foldEvents, parseOutput, runNote, runStatusOf } from './runsModel'

describe('foldEvents', () => {
  it('delta 连续拼成一段，tool 和 tool_result 按 id 配对，交错到达也配得上', () => {
    const ev: RunEvent[] = [
      { type: 'start', run_id: 'r1', workdir: '/w' },
      { type: 'delta', text: '先看' },
      { type: 'delta', text: '一下。' },
      { type: 'tool', id: 'a', name: 'Read', detail: '/w/a.md' },
      { type: 'tool', id: 'b', name: 'Write', detail: '/w/b.md' },
      { type: 'tool_result', id: 'b', name: 'Write', ok: false, error: '权限不足' },
      { type: 'tool_result', id: 'a', name: 'Read', ok: true, error: '' },
      { type: 'tool', id: 'c', name: 'Bash', detail: 'ls' },
      { type: 'delta', text: '完了' },
      { type: 'done', run_id: 'r1', exit_code: 0 },
    ]
    expect(foldEvents(ev)).toEqual([
      { k: 'text', text: '先看一下。' },
      { k: 'tool', id: 'a', name: 'Read', detail: '/w/a.md', state: 'ok', error: '' },
      { k: 'tool', id: 'b', name: 'Write', detail: '/w/b.md', state: 'failed', error: '权限不足' },
      { k: 'tool', id: 'c', name: 'Bash', detail: 'ls', state: 'pending', error: '' },
      { k: 'text', text: '完了' },
    ])
  })

  it('没有开始事件的结果单独成卡，失败不被吞掉', () => {
    expect(foldEvents([{ type: 'tool_result', id: 'x', name: 'Edit', ok: false, error: '没找到' }])).toEqual([
      { k: 'tool', id: 'x', name: 'Edit', detail: '', state: 'failed', error: '没找到' },
    ])
  })
})

describe('parseOutput', () => {
  it('按 runner 的 render 格式解析：工具行成卡片，失败行配给最近的同名调用，其余记成功', () => {
    const out = '我先读文件。\n[工具] Read · /w/a.md\n[工具] Write · /w/b.md\n[工具失败] Write · 权限不足\n读完了。\n第二行'
    expect(parseOutput(out, 'done')).toEqual([
      { k: 'text', text: '我先读文件。' },
      { k: 'tool', id: 'o0', name: 'Read', detail: '/w/a.md', state: 'ok', error: '' },
      { k: 'tool', id: 'o1', name: 'Write', detail: '/w/b.md', state: 'failed', error: '权限不足' },
      { k: 'text', text: '读完了。\n第二行' },
    ])
  })

  it('被取消的记录，最后一个没配上的调用结果未知', () => {
    const b = parseOutput('[工具] Read · a\n[工具] Bash · sleep 60', 'canceled')
    expect(b.map((x) => x.k === 'tool' && x.state)).toEqual(['ok', 'unknown'])
  })

  it('没有工具行就是一整段正文；空输出没有块', () => {
    expect(parseOutput('只有正文\n\n两段', 'done')).toEqual([{ k: 'text', text: '只有正文\n\n两段' }])
    expect(parseOutput('', 'failed')).toEqual([])
  })
})

describe('状态和说明', () => {
  it('按 status 显示，不看 exit_code', () => {
    expect(runStatusOf('failed').label).toBe('失败')
    expect(runStatusOf('canceled').label).toBe('已取消')
    expect(runStatusOf('weird')).toEqual({ label: 'weird', tone: 'off' })
  })

  it('完成但有 error 是保留意见，失败是红字原因，运行中不显示', () => {
    expect(runNote({ status: 'done', error: '有 1 次工具调用被挡下' })).toEqual({ text: '保留意见：有 1 次工具调用被挡下', tone: 'muted' })
    expect(runNote({ status: 'failed', error: '没有一次工具调用成功' })).toEqual({ text: '没有一次工具调用成功', tone: 'danger' })
    expect(runNote({ status: 'canceled', error: '执行已被取消' })).toEqual({ text: '执行已被取消', tone: 'muted' })
    expect(runNote({ status: 'running', error: 'x' })).toBeNull()
    expect(runNote({ status: 'done', error: '' })).toBeNull()
  })

  it('附加说明从提示词的补充要求一节取', () => {
    const p = '## 任务\n标题：x\n\n## 本次执行的补充要求\n只读 a.md\n第二行\n\n## 约束\n- 不改'
    expect(extraOf(p)).toBe('只读 a.md\n第二行')
    expect(extraOf('## 任务\n标题：x\n\n## 约束\n')).toBe('')
  })

  it('用时', () => {
    const t = '2026-10-28T10:00:00Z'
    expect(duration(t, '2026-10-28T10:00:42Z')).toBe('42 秒')
    expect(duration(t, '2026-10-28T10:05:00Z')).toBe('5 分钟')
    expect(duration(t, null, new Date('2026-10-28T11:30:00Z'))).toBe('1 小时 30 分钟')
  })
})
