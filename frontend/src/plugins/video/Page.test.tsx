import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Page from './Page'

describe('视频的空页面', () => {
  it('显示标题和空状态', () => {
    render(<Page />)
    expect(screen.getByRole('heading', { name: '视频' })).toBeInTheDocument()
    expect(screen.getByText('还没有内容')).toBeInTheDocument()
  })
})
