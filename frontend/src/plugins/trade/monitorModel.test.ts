// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { TradeAlert, TradeInstrument } from '../../core/data'
import {
  condFits, dayLabel, draftBody, draftErrors, draftOf, fillValue, fmtAlertValue, fmtSessionSpan, fmtThreshold, ruleIn, ruleMatches, sessionOf,
  timeAgo, withSymbol,
} from './monitorModel'

const inst = (over: Partial<TradeInstrument>): TradeInstrument => ({
  symbol: 'BINANCE:BTCUSDT', name: 'BTC/USDT', market: 'crypto', kind: 'spot', venue: 'Binance', digits: 2, lot: 1, multiplier: 1, source: '', updated_at: '', ...over,
})
const alert = (over: Partial<TradeAlert> = {}): TradeAlert => ({
  id: 'al_1', symbol: 'BINANCE:BTCUSDT', cond: 'price_above', value: 70000, repeat: false, cooldown_min: 30, notify: ['app'], im_connector: '',
  enabled: true, note: '', last_fired_at: '', created_at: '', updated_at: '', ...over,
})

describe('盯盘的纯函数', () => {
  it('条件按品种适用：资金费率只给永续、IV 只给期权、接近涨跌停要有涨跌停', () => {
    const spot = inst({}), perp = inst({ kind: 'perp' }), opt = inst({ kind: 'option' }), cn = inst({ market: 'cn', limit: 0.1 })
    expect(condFits('funding_above', spot)).toBe(false)
    expect(condFits('funding_above', perp)).toBe(true)
    expect(condFits('iv_above', opt)).toBe(true)
    expect(condFits('iv_above', perp)).toBe(false)
    expect(condFits('limit_near', spot)).toBe(false)
    expect(condFits('limit_near', cn)).toBe(true)
    expect(condFits('price_above', undefined)).toBe(false)
  })

  it('当前值和阈值的格式同原型', () => {
    expect(fmtAlertValue('price_above', 70012.5, 1)).toBe('70,012.5')
    expect(fmtAlertValue('volume_spike', 3.456, 2)).toBe('3.46 倍')
    expect(fmtAlertValue('funding_above', 0.061, 2)).toBe('0.0610%')
    expect(fmtAlertValue('pct_below', 4.3, 2)).toBe('4.30%')
    expect(fmtThreshold(alert(), 1)).toBe('70,000.0')
    expect(fmtThreshold(alert({ cond: 'pct_below', value: 4 }), 2)).toBe('4')
    expect(fillValue('price_below', 70012.56, 1)).toBe('70012.6')
    expect(fillValue('funding_above', 0.012345, 2)).toBe('0.0123')
  })

  it('规则筛选和搜索', () => {
    const a = alert({ note: '突破前高', last_fired_at: '2026-11-01T00:00:00Z' })
    expect(ruleIn(a, 'fired')).toBe(true)
    expect(ruleIn(alert(), 'fired')).toBe(false)
    expect(ruleIn(alert({ enabled: false }), 'off')).toBe(true)
    expect(ruleMatches(a, 'BTC/USDT', 'btc 前高')).toBe(true)
    expect(ruleMatches(a, 'BTC/USDT', '上穿')).toBe(true)
    expect(ruleMatches(a, 'BTC/USDT', 'eth')).toBe(false)
  })

  it('相对时间和按天分段', () => {
    const now = new Date(2026, 10, 5, 12, 0).getTime()
    expect(timeAgo(new Date(now - 20_000).toISOString(), now)).toBe('刚刚')
    expect(timeAgo(new Date(now - 3 * 3600_000).toISOString(), now)).toBe('3 小时前')
    expect(dayLabel(new Date(2026, 10, 5, 1).toISOString(), now)).toBe('今天')
    expect(dayLabel(new Date(2026, 10, 4, 23).toISOString(), now)).toBe('昨天')
    expect(dayLabel(new Date(2026, 9, 1).toISOString(), now)).toBe('10 月 1 日')
    expect(dayLabel(new Date(2025, 9, 1).toISOString(), now)).toBe('2025 年 10 月 1 日')
  })

  it('市场时段按当地时间算', () => {
    // 2026-11-05 周四 02:00 UTC = 上海 10:00（交易中）、香港 10:00（交易中）、纽约 21:00（休市）
    const at = Date.UTC(2026, 10, 5, 2, 0)
    expect(sessionOf('cn', at)).toBe('open')
    expect(sessionOf('hk', at)).toBe('open')
    expect(sessionOf('us', at)).toBe('closed')
    expect(sessionOf('crypto', at)).toBe('open')
    // 上海 12:00 午休；周六休市
    expect(sessionOf('cn', Date.UTC(2026, 10, 5, 4, 0))).toBe('break')
    expect(sessionOf('cn', Date.UTC(2026, 10, 7, 2, 0))).toBe('closed')
    expect(fmtSessionSpan(90 * 60_000)).toBe('1 小时 30 分')
    expect(fmtSessionSpan(26 * 3600_000)).toBe('1 天 2 小时')
  })

  it('抽屉草稿：换标的清阈值、不适用的条件退回价格上穿；保存的 body 不带没勾 IM 的连接器', () => {
    const d = { ...draftOf(null, 'BINANCE:BTCUSDT.P', 'cn_tg'), cond: 'funding_above' as const, value: '0.05' }
    const next = withSymbol(d, 'BINANCE:BTCUSDT', inst({}))
    expect(next.cond).toBe('price_above')
    expect(next.value).toBe('')
    expect(draftErrors(next, inst({}))).toContain('填一个阈值')
    expect(draftErrors({ ...next, value: 'abc' }, inst({}))).toContain('阈值要是数字')
    expect(draftErrors({ ...next, value: '1', notify: [] }, inst({}))).toContain('至少选一种通知方式')
    expect(draftErrors({ ...next, value: '1', notify: ['im'], im_connector: '' }, inst({}))).toContain('选一个推送用的 IM 连接器')
    expect(draftErrors({ ...next, value: '1' }, inst({}))).toEqual([])
    expect(draftBody({ ...next, value: '70000', cooldown_min: -3, note: ' x ' })).toEqual({
      symbol: 'BINANCE:BTCUSDT', cond: 'price_above', value: 70000, repeat: false, cooldown_min: 0, notify: ['app'], im_connector: '', enabled: true, note: 'x',
    })
  })
})
