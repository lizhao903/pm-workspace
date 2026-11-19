// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TradeBuiltinStrategy, TradeStrategy } from '../../core/data'
import { BuiltinLogic, NewFromBuiltin, PerSymbolTable, SymbolWeights } from './BuiltinParts'

// 内置策略（TRD-09）的编辑块：参数表按范围夹住、资金权重算占比、从内置策略新建、分标的统计
const kdj: TradeBuiltinStrategy = {
  id: 'kdj-short-1h3m', name: 'KDJ 1h 定趋势 + 3m 定买卖点', desc: '1h KDJ 定趋势，3m 定买卖点', source: 'autotrader', trend_interval: '1h', entry_interval: '3m',
  trend_mode: 'partial', direction: 'long', symbols: ['BINANCE:BTCUSDT'], stop_loss: 4.5, take_profit: 6.5, position_pct: 100, warm_bars: 2000,
  params: [
    { key: 'oversold', label: '超卖线（J）', default: 20, min: 1, max: 99, step: 1, unit: '', help: 'J 低于它算超卖' },
    { key: 'sell_gate', label: '信号出场浮盈门槛', default: 2.25, min: -100, max: 100, step: 0.05, unit: '%', help: '' },
  ],
}

function strategy(over: Partial<TradeStrategy> = {}): TradeStrategy {
  return {
    id: 'st_1', name: kdj.name, desc: '', mode: 'builtin', builtin: kdj.id, symbols: ['BINANCE:SOLUSDT', 'BINANCE:ETHUSDT', 'BINANCE:BTCUSDT'], interval: '3m',
    direction: 'long', entry: { logic: 'all', rules: [] }, exit: { logic: 'any', rules: [] }, stop_loss: 4.5, take_profit: 6.5, position_pct: 100, code: '',
    params: { oversold: 20, sell_gate: 2.25 }, symbol_weights: {}, tags: [], updated_at: 'a', created_at: 'b', ...over,
  }
}

function Harness({ init, onSet }: { init: TradeStrategy; onSet: (p: Partial<TradeStrategy>) => void }) {
  const [st, setSt] = useState(init)
  const set = (p: Partial<TradeStrategy>) => {
    onSet(p)
    setSt({ ...st, ...p })
  }
  return <><BuiltinLogic st={st} set={set} /><SymbolWeights st={st} set={set} /></>
}

function wrap(node: React.ReactNode) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [kdj], meta: { total: 1 } }), { status: 200 })))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

afterEach(() => vi.unstubAllGlobals())

describe('内置策略', () => {
  it('参数按内置的中文名和范围出，越界夹住；资金权重按占比显示', async () => {
    const sets: Partial<TradeStrategy>[] = []
    wrap(<Harness init={strategy({ symbol_weights: { 'BINANCE:SOLUSDT': 2 } })} onSet={(p) => sets.push(p)} />)
    const os = await screen.findByLabelText('超卖线（J）')
    expect(screen.getByText('1 时 定趋势 · 3 分 入场')).toBeInTheDocument()
    await userEvent.clear(os)
    await userEvent.type(os, '150')
    expect(sets.at(-1)?.params?.oversold).toBe(99)
    // SOL 权重 2，另外两个按 1：50%、25%、25%
    expect(screen.getByText('50%')).toBeInTheDocument()
    expect(screen.getAllByText('25%')).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: '平均分' }))
    expect(sets.at(-1)).toEqual({ symbol_weights: {} })
  })

  it('从内置策略新建：列出目录，选一个回调', async () => {
    const picked: string[] = []
    wrap(<NewFromBuiltin onPick={(b) => picked.push(b.id)} />)
    await userEvent.click(screen.getByRole('button', { name: /从内置策略新建/ }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /KDJ 1h 定趋势/ }))
    expect(picked).toEqual(['kdj-short-1h3m'])
  })

  it('分标的统计', () => {
    wrap(<PerSymbolTable rows={[{ symbol: 'BINANCE:BTCUSDT', capital: 500, stats: { total_return: 0.0312, annual: 0, max_dd: 0.05, sharpe: 1, win_rate: 0.6, trades: 5, profit_factor: 1.2, bench_return: 0 } }]} />)
    expect(screen.getByText('3.12%')).toBeInTheDocument()
    expect(screen.getByText('60.00%')).toBeInTheDocument()
  })
})
