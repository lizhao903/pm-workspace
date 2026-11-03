import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { setTheme } from './theme'
import { ThemeSwitch } from './ThemeSwitch'

// 组件测试的样板：放在被测文件旁边，*.test.tsx 跑在 jsdom，按角色和文字找元素
describe('ThemeSwitch', () => {
  // theme.ts 的偏好是模块级状态，每条用例前回到浅色
  beforeEach(() => {
    act(() => setTheme('light'))
    localStorage.clear()
  })

  it('三个选项，默认选中浅色', () => {
    render(<ThemeSwitch />)
    expect(screen.getByRole('radiogroup', { name: '配色方案' })).toBeInTheDocument()
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.textContent)).toEqual(['浅色', '深色', '跟随系统'])
    expect(screen.getByRole('radio', { name: '浅色' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: '深色' })).toHaveAttribute('aria-checked', 'false')
  })

  it('点深色：选中态切换、写到 <html data-theme> 和存储', async () => {
    const user = userEvent.setup()
    render(<ThemeSwitch className="extra" />)
    expect(screen.getByRole('radiogroup')).toHaveClass('theme-switch', 'extra')

    await user.click(screen.getByRole('radio', { name: '深色' }))

    expect(screen.getByRole('radio', { name: '深色' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: '深色' })).toHaveClass('on')
    expect(screen.getByRole('radio', { name: '浅色' })).toHaveAttribute('aria-checked', 'false')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('pmw-theme')).toBe('dark')
  })

  it('跟随系统：系统是浅色时生效浅色', async () => {
    const user = userEvent.setup()
    render(<ThemeSwitch />)
    await user.click(screen.getByRole('radio', { name: '跟随系统' }))
    expect(screen.getByRole('radio', { name: '跟随系统' })).toHaveAttribute('aria-checked', 'true')
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})
