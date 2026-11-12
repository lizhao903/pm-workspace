// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { TradeStrategy } from '../../core/data'
import {
  blockerOf, codeKindOf, defaultSweepValues, drawdown, inputOf, parseSweepValues, quickDefaults, quickParams, ruleText, segments, sig, spanText,
  withParam,
} from './strategyModel'

const st: TradeStrategy = {
  id: 'st_1', name: '双均线', desc: '', mode: 'rules', symbols: ['BINANCE:BTCUSDT'], interval: '4h', direction: 'long',
  entry: { logic: 'all', rules: [{ id: 'r1', left: { kind: 'ind', ind: 'ema', params: [12] }, op: 'cross_up', right: { kind: 'ind', ind: 'ema', params: [48] } }] },
  exit: { logic: 'any', rules: [{ id: 'r2', left: { kind: 'ind', ind: 'rsi', params: [14] }, op: 'gt', right: { kind: 'num', value: 48 } }] },
  stop_loss: 6, take_profit: 0, position_pct: 30, code: '', params: { fast: 12, slow: 48 }, tags: [], updated_at: 'a', created_at: 'b',
}

describe('策略页的纯函数', () => {
  it('规则文字、拦截原因', () => {
    expect(ruleText(st.entry.rules[0])).toBe('EMA(12) 上穿 EMA(48)')
    expect(ruleText(st.exit.rules[0])).toBe('RSI(14) 大于 48')
    expect(blockerOf(st)).toBe('')
    expect(blockerOf({ ...st, symbols: [] })).toBe('先选至少一个标的')
    expect(blockerOf({ ...st, entry: { logic: 'all', rules: [] } })).toBe('入场规则还是空的')
    expect(blockerOf({ ...st, mode: 'code', entry: { logic: 'all', rules: [] } })).toBe('')
  })

  it('改参数值时规则里等于旧值的周期、数值一起改；有同值参数时不连带', () => {
    const p = withParam(st, 'slow', 60)
    expect(p.params).toEqual({ fast: 12, slow: 60 })
    expect(p.entry!.rules[0].right).toEqual({ kind: 'ind', ind: 'ema', params: [60] })
    expect(p.exit!.rules[0].right).toEqual({ kind: 'num', value: 60 })
    const shared = withParam({ ...st, params: { a: 12, b: 12 } }, 'a', 20)
    expect(shared.entry).toBeUndefined()
    expect(withParam({ ...st, mode: 'code' }, 'fast', 5).entry).toBeUndefined()
  })

  it('快速回测默认值和参数覆盖只认策略里有的参数', () => {
    const qc = quickDefaults(st)
    expect(qc).toMatchObject({ bars: 1000, capital: 100000, fee_bp: 5, slippage_ticks: 1 })
    expect(quickDefaults({ ...st, symbols: ['NASDAQ:AAPL'] }).fee_bp).toBe(3)
    expect(quickParams(st, { ...qc, over: { fast: 9, nope: 1 } })).toEqual({ fast: 9, slow: 48 })
  })

  it('名称为空时不写 name；快照比较不看时间和规则编号', () => {
    expect(inputOf({ ...st, name: ' ' })).not.toHaveProperty('name')
    expect(inputOf(st)).not.toHaveProperty('id')
    const renumbered = { ...st, updated_at: 'x', entry: { ...st.entry, rules: [{ ...st.entry.rules[0], id: 'rl_other' }] } }
    expect(sig(renumbered)).toBe(sig(st))
    expect(sig({ ...st, stop_loss: 7 })).not.toBe(sig(st))
  })

  it('代码策略的内置近似', () => {
    expect(codeKindOf({ name: '永续网格', code: '', params: {} })).toBe('grid')
    expect(codeKindOf({ name: 'x', code: '', params: { open_bp: 40 } })).toBe('basis')
    expect(codeKindOf({ name: 'x', code: 'print(1)', params: {} })).toBe('ma')
  })

  it('扫参默认值和取值解析', () => {
    expect(defaultSweepValues(12, 'fast')).toEqual([6, 9, 12, 15, 18, 24])
    expect(defaultSweepValues(0, 'stop_loss')).toEqual([0, 3, 6, 10, 15])
    expect(defaultSweepValues(0, 'fast')).toEqual([0, 1, 2, 5, 10])
    expect(defaultSweepValues(0.01, 'qty')).toEqual([0.005, 0.0075, 0.01, 0.0125, 0.015, 0.02])
    expect(parseSweepValues('6，9 12, x, 9')).toEqual([6, 9, 12])
  })

  it('区间时长、回撤、分段收益', () => {
    expect(spanText(1000, '4h')).toBe('约 6 个月')
    expect(spanText(200, '1h')).toBe('约 8 天')
    expect(drawdown([{ v: 100 }, { v: 120 }, { v: 90 }, { v: 130 }])).toEqual([0, 0, -0.25, 0])
    expect(segments([{ t: 0, v: 1 }])).toBeNull()
    const day = 86_400_000
    const seg = segments(Array.from({ length: 5 }, (_, i) => ({ t: Date.UTC(2026, 0, 1, 12) + i * day, v: 100 + i })))!
    expect(seg.mode).toBe('day')
    expect(seg.cells).toHaveLength(5)
  })
})
