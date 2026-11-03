// 用原型 web-next/src/backtest.ts 在固定截止时刻跑一组回测和扫参，写成 Go 对拍用的黄金文件（TRD-04a）。
// 每个用例连同所用 K 线、标的信息一起存：Go 测试只读这个文件，不重新模拟行情。
//
// 在仓库根目录跑（Node 22.18+，原型 web-next 需已 npm install）：
//   node --experimental-transform-types --no-warnings internal/plugins/trade/testdata/gen-backtest-golden.mjs
// 输出 internal/plugins/trade/testdata/backtest_golden.json；原型的回测逻辑改了就重跑。

import { registerHooks } from 'node:module'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// 原型按打包器的习惯写不带扩展名的相对 import，这里补上 .ts
registerHooks({
  resolve(spec, ctx, next) {
    if ((spec.startsWith('./') || spec.startsWith('../')) && !/\.[cm]?[jt]sx?$/.test(spec) && ctx.parentURL?.includes('/web-next/src/')) {
      return next(spec + '.ts', ctx)
    }
    return next(spec, ctx)
  },
  // 只在内存里给 backtest.ts 的取 K 线处加个记录，看每个用例实际取了多少根，黄金文件只存这么多
  load(url, ctx, next) {
    const r = next(url, ctx)
    if (!url.endsWith('/web-next/src/backtest.ts')) return r
    const anchor = 'getBars(symbol, cfg.interval, count, end)'
    const text = String(r.source)
    if (!text.includes(anchor)) throw new Error('backtest.ts 里找不到取 K 线的锚点，生成脚本要跟着改')
    return { ...r, source: text.replace(anchor, `globalThis.__spyBars(getBars, symbol, cfg.interval, count, end)`) }
  },
})
const asked = new Map()
globalThis.__spyBars = (get, symbol, interval, count, end) => {
  const k = `${symbol}|${interval}`
  asked.set(k, Math.max(asked.get(k) ?? 0, count))
  return get(symbol, interval, count, end)
}

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '../../../../web-next/src')
const td = await import(join(src, 'tradedata.ts'))
const bt = await import(join(src, 'backtest.ts'))

// 固定截止时刻：不和周期对齐，最后一根是没走完的 K 线
const END = Date.UTC(2026, 8, 30, 9, 37, 0)
const seed = (id) => structuredClone(td.seedStrategies.find((s) => s.id === id))

const cfgOf = (st, extra = {}) => ({
  strategy_id: st.id, symbols: st.symbols, interval: st.interval, bars: 300, capital: 100000, fee_bp: 5, slippage_ticks: 1, params: {}, ...extra,
})

const macross = seed('st_macross')
const rsi = seed('st_rsi')
const grid = seed('st_grid')
const basis = seed('st_ifbasis')

// 双向、止盈、更多指标：覆盖规则模式的其余分支
const both = {
  ...seed('st_macross'), id: 'st_both', name: '双向 MACD', direction: 'both', stop_loss: 4, take_profit: 8, position_pct: 50,
  entry: { logic: 'any', rules: [
    { id: 'b1', left: { kind: 'ind', ind: 'macd', params: [12, 26, 9] }, op: 'cross_up', right: { kind: 'num', value: 0 } },
    { id: 'b2', left: { kind: 'ind', ind: 'price', params: [] }, op: 'cross_up', right: { kind: 'ind', ind: 'boll_up', params: [20, 2] } },
  ] },
  exit: { logic: 'all', rules: [
    { id: 'b3', left: { kind: 'ind', ind: 'macd', params: [12, 26, 9] }, op: 'cross_down', right: { kind: 'num', value: 0 } },
    { id: 'b4', left: { kind: 'ind', ind: 'atr', params: [14] }, op: 'gt', right: { kind: 'num', value: 0 } },
  ] },
  params: { fast: 12, slow: 26 },
}
const short = {
  ...seed('st_macross'), id: 'st_short', name: '均线做空', direction: 'short', stop_loss: 3, take_profit: 5, position_pct: 40,
  entry: { logic: 'all', rules: [
    { id: 's1', left: { kind: 'ind', ind: 'price', params: [] }, op: 'cross_down', right: { kind: 'ind', ind: 'ma', params: [30] } },
    { id: 's2', left: { kind: 'ind', ind: 'volume', params: [] }, op: 'gt', right: { kind: 'num', value: 0 } },
  ] },
  exit: { logic: 'any', rules: [
    { id: 's3', left: { kind: 'ind', ind: 'price', params: [] }, op: 'cross_up', right: { kind: 'ind', ind: 'ema', params: [30] } },
    { id: 's4', left: { kind: 'ind', ind: 'rsi', params: [7] }, op: 'lt', right: { kind: 'num', value: 25 } },
  ] },
  params: { ma: 30 },
}
const codeMa = { ...seed('st_grid'), id: 'st_codema', name: '自写趋势', code: 'def on_bar(ctx, bar):\n    pass\n', params: { fast: 8, slow: 30 }, symbols: ['NASDAQ:AAPL', 'BINANCE:SOLUSDT'], interval: '1h', direction: 'long' }
const basisNoFut = { ...seed('st_ifbasis'), id: 'st_basis_nofut', symbols: ['SSE:510300', 'SSE:600519'] }
const basisUnderlying = { ...seed('st_ifbasis'), id: 'st_basis_und', symbols: ['CFFEX:IF2612'] }
const emptyRules = { ...seed('st_macross'), id: 'st_empty', entry: { logic: 'all', rules: [] } }

const cases = [
  { name: 'macross', st: macross, cfg: cfgOf(macross), sweeps: [['fast', [6, 9, 12, 18, 24]], ['slow', [30, 48, 72]], ['stop_loss', [0, 3, 6, 10]]] },
  { name: 'macross_short_window', st: macross, cfg: cfgOf(macross, { bars: 120, interval: '1h', fee_bp: 10, slippage_ticks: 3, params: { fast: 9, slow: 30, position_pct: 60 } }) },
  { name: 'rsi', st: rsi, cfg: cfgOf(rsi, { interval: '1h', bars: 400 }), sweeps: [['low', [25, 30, 35, 40]], ['high', [55, 65, 75]], ['take_profit', [0, 5, 15]]] },
  { name: 'grid', st: grid, cfg: cfgOf(grid, { bars: 400 }), sweeps: [['grids', [6, 10, 20, 40]], ['position_pct', [20, 50, 80]]] },
  { name: 'grid_range', st: grid, cfg: cfgOf(grid, { bars: 200, symbols: ['BINANCE:BTCUSDT.P'], params: { lower: 0, upper: 1e9, grids: 10 } }) },
  { name: 'grid_long', st: { ...grid, direction: 'long', stop_loss: 1 }, cfg: cfgOf(grid, { bars: 300, interval: '1h' }) },
  { name: 'basis', st: basis, cfg: cfgOf(basis, { bars: 400 }), sweeps: [['open_bp', [5, 10, 20, 40]], ['close_bp', [0, 5, 10]]] },
  { name: 'basis_underlying', st: basisUnderlying, cfg: cfgOf(basisUnderlying, { bars: 300, params: { open_bp: 8, close_bp: 2 } }) },
  { name: 'basis_fallback', st: basisNoFut, cfg: cfgOf(basisNoFut, { bars: 300, interval: '1h' }) },
  { name: 'both', st: both, cfg: cfgOf(both, { interval: '1h', bars: 500 }), sweeps: [['fast', [8, 12, 16]], ['take_profit', [0, 4, 8]]] },
  { name: 'short', st: short, cfg: cfgOf(short, { symbols: ['NYSE:TSLA', 'CME:ESZ6', 'HKEX:HSI2611'], interval: '1h', bars: 400 }), sweeps: [['ma', [10, 30, 60]]] },
  { name: 'code_ma', st: codeMa, cfg: cfgOf(codeMa, { params: { fast: 6 } }), sweeps: [['slow', [20, 30, 50]]] },
  { name: 'lot_too_big', st: macross, cfg: cfgOf(macross, { symbols: ['CFFEX:IF2612', 'SSE:600519'], interval: '1h', capital: 5000 }) },
  { name: 'empty_rules', st: emptyRules, cfg: cfgOf(emptyRules) },
  { name: 'no_symbols', st: macross, cfg: cfgOf(macross, { symbols: ['FOO:BAR'] }) },
]

// Go Instrument 的形状（json 标签同 source.go）
const instJSON = (i) => ({
  symbol: i.symbol, name: i.name, market: i.market, kind: i.kind, venue: i.venue, digits: i.digits, lot: i.lot, multiplier: i.multiplier,
  ...(i.expiry ? { expiry: i.expiry } : {}), ...(i.underlying ? { underlying: i.underlying } : {}), source: 'prototype', updated_at: '',
})

// K 线按「标的|周期」存一份，长度取所有用例里实际取过的最多根数
const out = { generated_by: 'internal/plugins/trade/testdata/gen-backtest-golden.mjs', end: END, bars: {}, cases: [] }
for (const c of cases) {
  const syms = new Set(c.cfg.symbols)
  for (const s of c.cfg.symbols) { const u = td.instOf(s)?.underlying; if (u) syms.add(u) }
  const instruments = {}
  for (const s of syms) {
    const i = td.instOf(s)
    if (!i) continue
    instruments[s] = instJSON(i)
  }
  const result = bt.runBacktest(c.cfg, c.st, END)
  const sweeps = (c.sweeps ?? []).map(([param, values]) => ({ param, values, points: bt.sweep(c.cfg, c.st, param, values, END) }))
  const kind = c.st.mode === 'code' ? bt.codeKindOf(c.st) : ''
  out.cases.push({ name: c.name, strategy: c.st, config: c.cfg, code_kind: kind, instruments, result, sweeps })
  console.log(c.name.padEnd(22), 'trades', String(result.trades.length).padStart(4), 'ret', result.stats.total_return.toFixed(4), result.note ?? '')
}
for (const [key, count] of asked) {
  const [s, interval] = key.split('|')
  const all = td.bars(s, interval, count, END)
  // K 线只跟时刻有关：取尾巴等于少取，Go 的 loader 靠这一点
  const tail = td.bars(s, interval, Math.min(50, count), END)
  if (JSON.stringify(all.slice(-tail.length)) !== JSON.stringify(tail)) throw new Error(`${s} 的 K 线取尾巴和少取不一致`)
  out.bars[key] = all
}
writeFileSync(join(here, 'backtest_golden.json'), JSON.stringify(out) + '\n')
