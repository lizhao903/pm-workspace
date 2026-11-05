import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TRADE_MODULES } from './modules'

// 行情页（TRD-02b）已经有内容，测试在 MarketsPage.test.tsx
describe('交易套件的空页面', () => {
  it.each(TRADE_MODULES.filter((m) => m.id !== 'markets').map((m) => [m.id, m.label] as const))('%s 页显示标题和空状态', async (id, label) => {
    const m = TRADE_MODULES.find((x) => x.id === id)!
    const Page = (await m.load()).default
    render(<Page />)
    expect(screen.getByRole('heading', { name: label })).toBeInTheDocument()
    expect(screen.getByText('还没有内容')).toBeInTheDocument()
  })
})
