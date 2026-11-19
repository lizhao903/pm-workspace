// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// TRD-10：K 线图向后端要的指标、后端指标的取线，提醒抽屉的指标条件草稿。
import { describe, expect, it } from 'vitest'
import type { TradeAlert, TradeKlineIndicator } from '../../core/data'
import { chartInd, chartSpecs } from './MarketsPage'
import { draftBody, draftErrors, draftOf, fmtAlertValue, indText, withInd } from './monitorModel'

const off = { ma5: false, ma20: false, ma60: false, ema12: false, ema26: false, boll: false }

describe('K 线图的指标', () => {
  it('只要打开的叠加和副图，成交量不找后端要', () => {
    expect(chartSpecs(off, 'vol')).toBe('')
    expect(chartSpecs({ ...off, ma5: true, ema26: true, boll: true }, 'kdj')).toBe('MA(5),EMA(26),BOLL(20,2),KDJ(9,3,3)')
    // 全开也不超过后端一次 8 个的上限
    expect(chartSpecs({ ma5: true, ma20: true, ma60: true, ema12: true, ema26: true, boll: true }, 'macd').match(/\)/g)).toHaveLength(7)
  })

  it('按规范写法和线名取后端的序列，null 换成 NaN，没要的是空', () => {
    const inds: TradeKlineIndicator[] = [
      { spec: 'MA(5)', name: 'MA', params: [5], overlay: true, warmup: 5, lines: [{ key: 'MA', values: [null, 2, 3] }] },
      { spec: 'KDJ(9,3,3)', name: 'KDJ', params: [9, 3, 3], overlay: false, warmup: 5, lines: [{ key: 'K', values: [50, 60, 70] }, { key: 'D', values: [1, 2, 3] }, { key: 'J', values: [0, 0, 0] }] },
    ]
    const bars = [1, 2, 3].map((c, t) => ({ t, o: c, h: c, l: c, c, v: 10 }))
    const ind = chartInd(inds, bars)
    expect(ind.lines.ma5[0]).toBeNaN()
    expect(ind.lines.ma5.slice(1)).toEqual([2, 3])
    // 没要的指标也和 K 线等长，全是 NaN（换指标时旧数据先顶着，不能取到 undefined）
    expect(ind.kdj.k).toEqual([50, 60, 70])
    expect(ind.macd.dif).toHaveLength(3)
    expect(ind.macd.dif.every(Number.isNaN)).toBe(true)
    expect(chartInd(inds, [...bars, { t: 3, o: 1, h: 1, l: 1, c: 1, v: 1 }]).kdj.k[3]).toBeNaN()
    expect(ind.vma).toHaveLength(3)
  })
})

const alert = (over: Partial<TradeAlert> = {}): TradeAlert => ({
  id: 'al_1', symbol: 'BINANCE:BTCUSDT', cond: 'price_above', value: 70000, repeat: false, cooldown_min: 30, notify: ['app'], im_connector: '',
  enabled: true, note: '', last_fired_at: '', created_at: '', updated_at: '', indicator: null, interval: '', ...over,
})

describe('提醒的指标条件', () => {
  it('新建默认 RSI、1 小时；价格条件不带指标', () => {
    const d = draftOf(null, 'BINANCE:BTCUSDT')
    expect(d.ind).toBe('rsi')
    expect(d.params).toEqual([14])
    expect(d.interval).toBe('1h')
    expect(draftBody({ ...d, value: '1' })).not.toHaveProperty('indicator')
  })

  it('指标条件带指标和周期，参数缺的补默认', () => {
    const d = withInd({ ...draftOf(null, 'BINANCE:BTCUSDT'), cond: 'ind_cross_up', interval: '15m' }, 'kdj_k')
    expect(d.params).toEqual([9, 3, 3])
    const body = draftBody({ ...d, value: '80', params: [9] })
    expect(body.indicator).toEqual({ kind: 'ind', ind: 'kdj_k', params: [9, 3, 3] })
    expect(body.interval).toBe('15m')
    expect(draftErrors({ ...d, value: '80', params: [NaN] }, undefined)).toContain('指标参数要是数字')
  })

  it('编辑时读回已存的指标；显示写法和数值格式', () => {
    const a = alert({ cond: 'ind_above', value: 70, indicator: { kind: 'ind', ind: 'ma', params: [20] }, interval: '4h' })
    const d = draftOf(a, a.symbol)
    expect([d.ind, d.params, d.interval]).toEqual(['ma', [20], '4h'])
    expect(indText(a.indicator)).toBe('MA(20)')
    expect(fmtAlertValue('ind_above', 70123.456, 1, 'ma')).toBe('70,123.5')
    expect(fmtAlertValue('ind_above', 71.234, 1, 'rsi')).toBe('71.23')
  })
})
