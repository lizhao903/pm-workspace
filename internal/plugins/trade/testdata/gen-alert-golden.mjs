// 用原型 web-next/src/alertcheck.ts 的 checkAlerts 在几个固定时刻跑一组提醒，写成 Go 对拍用的黄金文件（TRD-03a）。
// 每个时刻、每个标的的行情（最新价、昨收、21 根 1 分钟成交量、资金费率 %、IV %）和标的信息一起存：
// Go 测试只读这个文件，不重新模拟行情。生成时还用存下来的行情再跑一遍 checkAlertsOn，确认存的东西够判定用。
//
// 在仓库根目录跑（Node 22.18+，原型 web-next 需已 npm install）：
//   node --experimental-transform-types --no-warnings internal/plugins/trade/testdata/gen-alert-golden.mjs
// 输出 internal/plugins/trade/testdata/alerts_golden.json；原型的判定或文案改了就重跑。

import { registerHooks } from 'node:module'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

// 原型按打包器的习惯写不带扩展名的相对 import，这里补上 .ts
registerHooks({
  resolve(spec, ctx, next) {
    if ((spec.startsWith('./') || spec.startsWith('../')) && !/\.[cm]?[jt]sx?$/.test(spec) && ctx.parentURL?.includes('/web-next/src/')) {
      return next(spec + '.ts', ctx)
    }
    return next(spec, ctx)
  },
})

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '../../../../web-next/src')
const td = await import(join(src, 'tradedata.ts'))
const ac = await import(join(src, 'alertcheck.ts'))

// 固定时刻：不和分钟对齐
const ATS = [Date.UTC(2026, 8, 30, 9, 37, 13), Date.UTC(2026, 9, 14, 2, 5, 41), Date.UTC(2026, 10, 3, 15, 48, 7)]
const opt = (u, right) => {
  const ch = td.optionChain(u, td.OPTION_EXPIRIES[1], 11)
  return ch[ch.length >> 1][right].symbol
}
const SYMBOLS = [
  'BINANCE:BTCUSDT', 'BINANCE:SOLUSDT', 'BINANCE:BTCUSDT.P', 'OKX:ETH-USDT-SWAP', 'SSE:600519', 'SZSE:300750', 'SSE:510300',
  'HKEX:HSI2611', 'NASDAQ:NVDA', 'CME:ESZ6', opt('BINANCE:BTCUSDT', 'call'), opt('SSE:510300', 'put'), 'NASDAQ:GONE',
]
const CONDS = Object.keys(td.ALERT_COND)

// 存下来的行情：用到的才算，不适用的字段记 0
function record(symbol, at) {
  const i = td.instOf(symbol)
  const m = ac.simMarket(symbol, at)
  if (!i) return { inst: null, last: 0, prev: 0, volumes: [], funding: 0, iv: 0 }
  return {
    inst: { symbol: i.symbol, name: i.name, kind: i.kind, digits: i.digits, limit: i.limit ?? 0 },
    last: m.last(), prev: m.prev(), volumes: m.volumes(),
    funding: i.kind === 'perp' ? m.funding() : 0,
    iv: i.kind === 'option' ? m.iv() : 0,
  }
}
const replay = (r) => ({
  inst: r.inst ? { ...td.instOf(r.inst.symbol), ...r.inst, limit: r.inst.limit || undefined } : undefined,
  last: () => r.last, prev: () => r.prev, volumes: () => r.volumes, funding: () => r.funding, iv: () => r.iv,
})

const markets = {}
const cases = []
let n = 0
const iso = (ms) => new Date(ms).toISOString()
for (const at of ATS) {
  for (const symbol of SYMBOLS) {
    const key = `${symbol}@${at}`
    markets[key] = record(symbol, at)
    for (const cond of CONDS) {
      const v = ac.condValue(cond, symbol, at)
      const base = v ?? 1
      const lo = base - Math.abs(base) * 0.002 - 0.0001
      const hi = base + Math.abs(base) * 0.002 + 0.0001
      const met = ac.hit(cond, base, lo) ? lo : hi // 满足条件的那一侧
      const alerts = []
      const add = (name, extra) => alerts.push({
        name, alert: {
          id: `al${++n}`, symbol, cond, value: met, repeat: false, cooldown_min: 30, notify: ['app'], enabled: true, note: '',
          created_at: iso(at - 86400000), ...extra,
        },
      })
      add('阈值低', { value: lo })
      add('阈值高', { value: hi })
      add('阈值等于当前值', { value: base })
      add('停用', { enabled: false })
      add('单次已触发', { last_fired_at: iso(at - 3600000) })
      add('重复冷却中', { repeat: true, cooldown_min: 30, last_fired_at: iso(at - 600000) })
      add('重复冷却已过', { repeat: true, cooldown_min: 5, last_fired_at: iso(at - 600000) })
      add('重复正好过冷却', { repeat: true, cooldown_min: 10, last_fired_at: iso(at - 600000) })
      add('重复冷却为零', { repeat: true, cooldown_min: 0, last_fired_at: iso(at - 1000) })
      add('重复冷却为负', { repeat: true, cooldown_min: -5, last_fired_at: iso(at - 1000) })
      for (const { name, alert } of alerts) {
        const got = ac.checkAlerts([alert], at)
        const again = ac.checkAlertsOn([alert], at, () => replay(markets[key]))
        const pick = (xs) => xs.map((h) => ({ text: h.text, price: h.price }))
        if (!isDeepStrictEqual(pick(got), pick(again))) {
          throw new Error(`${name} ${symbol} ${cond}：存下来的行情和模拟行情判定不一致\n${JSON.stringify(pick(got))}\n${JSON.stringify(pick(again))}`)
        }
        // 判定用不到的字段不存，文件小一些
        const { notify: _n, note: _o, created_at: _c, ...kept } = alert
        cases.push({ name: `${name} ${symbol} ${cond}`, at, market: key, alert: kept, hit: got[0] ? { text: got[0].text, price: got[0].price } : null })
      }
    }
  }
}

const out = join(here, 'alerts_golden.json')
writeFileSync(out, JSON.stringify({ markets, cases }) + '\n')
const hits = cases.filter((c) => c.hit).length
console.log(`写了 ${out}：${cases.length} 个用例，${hits} 个触发`)
