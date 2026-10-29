import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { IncidentsSection } from './IncidentsSection'

describe('设置 / 运行异常', () => {
  it('没有记录时写明还没有，不再是「待开发」', () => {
    render(<IncidentsSection />)
    expect(screen.getByText('还没有运行异常记录')).toBeInTheDocument()
    expect(screen.getByText(/都会记在这里/)).toBeInTheDocument()
    expect(screen.queryByText('待开发')).toBeNull()
  })
})
