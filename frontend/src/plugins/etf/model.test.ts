// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { EtfDaily, EtfFund, EtfMetrics } from '../../core/data'
import { blankRule, buildRows, draftErrors, fmtMoney, fmtPct, ruleCond, scopeText, sparkPoints, streakText, summarize } from './model'

const fund = (symbol: string, over: Partial<EtfFund> = {}): EtfFund => ({
  symbol, name: `${symbol}ETF`, track_index: '沪深300', category: '宽基', manager: '', market: 'SH', secid: `1.${symbol}`, underlying: '000300',
  launch_date: '', updated_at: '', ...over,
})
const day = (symbol: string, date: string, shares: number): EtfDaily => ({
  date, symbol, shares, nav: 4, price: 4, open: 4, high: 4, low: 4, volume: 0, amount: 0, change_pct: 0, change_amount: 0, amplitude: 0,
  turnover_rate: 0, aum: shares * 4, premium_discount: 0, iopv: 0, premium_basis: 'nav', source: 'x', updated_at: '',
})
const met = (symbol: string, date: string, net: number | null): EtfMetrics => ({
  date, symbol, share_change_pct: null, net_inflow: net, inflow_streak: 0, amount_ratio: null, share_pctile: null, aum_pctile: null,
  premium_pctile: null, tracking_error: null, excess_return: null, aum_change_pct: null, premium_discount: null, premium_basis: 'nav',
  review_flag: '', updated_at: '',
})

describe('宽基监控的纯函数', () => {
  it('按最新交易日拼每只一行，趋势按日期正序、跳过没有份额的天', () => {
    const daily = [day('510300', '2026-11-03', 2e10), day('510300', '2026-11-02', 0), day('510300', '2026-11-04', 3e10), day('510500', '2026-11-03', 1e10)]
    const { date, rows } = buildRows([fund('510300'), fund('510500')], daily, [met('510300', '2026-11-04', 5e8), met('510300', '2026-11-03', 1)])
    expect(date).toBe('2026-11-04')
    expect(rows[0].daily?.date).toBe('2026-11-04')
    expect(rows[0].metrics?.net_inflow).toBe(5e8)
    expect(rows[0].trend).toEqual([2e10, 3e10])
    expect(rows[1].daily).toBeUndefined()
    expect(rows[1].metrics).toBeUndefined()
  })

  it('摘要只算有净流入的', () => {
    const rows = [
      { fund: fund('a'), metrics: met('a', 'd', 3e8), trend: [] },
      { fund: fund('b'), metrics: met('b', 'd', -1e8), trend: [] },
      { fund: fund('c'), metrics: met('c', 'd', null), trend: [] },
      { fund: fund('d'), trend: [] },
    ]
    expect(summarize(rows)).toEqual({ inflow: 2e8, up: 1, down: 1 })
  })

  it('数字和文案', () => {
    expect(fmtMoney(-2.345e8)).toBe('-2.35 亿元')
    expect(fmtMoney(12345)).toBe('1.23 万元')
    expect(fmtPct(null)).toBe('—')
    expect(fmtPct(1.5)).toBe('+1.50%')
    expect(fmtPct(1.5, 2, false)).toBe('1.50%')
    expect(streakText(3)).toBe('流入 3 天')
    expect(streakText(-2)).toBe('流出 2 天')
    expect(streakText(0)).toBe('—')
    expect(ruleCond({ metric: 'share_change_pct', operator: 'abs_gt', threshold: 2 })).toBe('份额日变动 绝对值 > 2.00%')
    expect(ruleCond({ metric: 'inflow_streak', operator: 'lte', threshold: -3 })).toBe('连续净流入天数 ≤ -3 天')
    const funds = [fund('510300', { name: '沪深300ETF' })]
    expect(scopeText({ scope: 'symbol', scope_value: '510300' }, funds)).toBe('510300 沪深300ETF')
    expect(scopeText({ scope: 'index', scope_value: '000300' }, funds)).toBe('跟踪沪深300')
    expect(scopeText({ scope: 'all', scope_value: '' })).toBe('全部')
  })

  it('迷你折线：两点以上才画，最小值在底、最大值在顶', () => {
    expect(sparkPoints([1], 10, 10)).toBe('')
    expect(sparkPoints([1, 3], 10, 10)).toBe('0.0,9.0 10.0,1.0')
  })

  it('规则草稿校验', () => {
    expect(draftErrors(blankRule())).toEqual(['名称必填'])
    expect(draftErrors({ ...blankRule(), name: 'x', threshold: 'abc' })).toEqual(['阈值要是数字'])
    expect(draftErrors({ ...blankRule(), name: 'x', scope: 'symbol' })).toEqual(['选一只 ETF'])
    expect(draftErrors({ ...blankRule(), name: 'x' })).toEqual([])
  })
})
