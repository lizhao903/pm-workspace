// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../../core/data'
import { allowRulesLink, allowRulesOf, cacheHitLabel, cacheHitRatio, cacheHitTitle, duration, extraOf, foldEvents, moduleLabel, parseOutput, runNote, runStatusOf } from './runsModel'

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

// TSK-0499：被拒提示里「建议放行：`…`」的规则取出来，做去设置放行的直达入口
describe('建议放行', () => {
  it('取出规则、去重，没有这句回空', () => {
    const e = '这次执行有 2 个工具调用被权限策略拒绝（Bash），任务没有真正完成。被拒的命令：git commit -m x | head。本次档位「只读」没放行这些调用；建议放行：`Bash(git commit:*)`、`mcp__x`、`Bash(git commit:*)`。到「设置 / 执行权限」把它们加进自定义白名单。'
    expect(allowRulesOf(e)).toEqual(['Bash(git commit:*)', 'mcp__x'])
    expect(allowRulesOf('执行超时')).toEqual([])
    expect(allowRulesLink(['Bash(a:*)', 'mcp__x'])).toBe('/settings/run-permissions?add=' + encodeURIComponent('Bash(a:*)\nmcp__x'))
  })
})

// P0（2026-11）：模块前缀复用的缓存命中，只在有 token 数据时显示
describe('模块前缀复用的缓存命中', () => {
  it('命中率 = 命中 / (命中 + 未命中)；没有 token 数据回 null', () => {
    expect(cacheHitRatio({ cache_read_tokens: 8700, uncached_input_tokens: 1300 })).toBeCloseTo(0.87)
    expect(cacheHitRatio({ cache_read_tokens: 0, uncached_input_tokens: 1000 })).toBe(0)
    expect(cacheHitRatio({ cache_read_tokens: 100 })).toBe(1)
    expect(cacheHitRatio({ uncached_input_tokens: 100 })).toBe(0)
    expect(cacheHitRatio({})).toBeNull()
    expect(cacheHitRatio({ cache_read_tokens: 0, uncached_input_tokens: 0 })).toBeNull()
  })

  it('标签显示百分比，没有数据回空串', () => {
    expect(cacheHitLabel({ cache_read_tokens: 8700, uncached_input_tokens: 1300 })).toBe('缓存 87%')
    expect(cacheHitLabel({ cache_read_tokens: 1, uncached_input_tokens: 2 })).toBe('缓存 33%')
    expect(cacheHitLabel({})).toBe('')
  })

  it('悬停说明带命中和未命中的 token 数、模块前缀复用', () => {
    expect(cacheHitTitle({ cache_read_tokens: 8700, uncached_input_tokens: 1300, module_key: 'project:obj_x' }))
      .toBe('命中缓存 8700 tokens / 未命中 1300 tokens；模块前缀复用（项目 obj_x）')
    expect(cacheHitTitle({})).toBe('命中缓存 0 tokens / 未命中 0 tokens；模块前缀复用')
  })

  it('模块键给人看：project / workdir 的说明，别的原样', () => {
    expect(moduleLabel('project:obj_1')).toBe('项目 obj_1')
    expect(moduleLabel('workdir:/tmp/w')).toBe('目录 /tmp/w')
    expect(moduleLabel('other')).toBe('other')
    expect(moduleLabel('')).toBe('')
    expect(moduleLabel(undefined)).toBe('')
  })
})
