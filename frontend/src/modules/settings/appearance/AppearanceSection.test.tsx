// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { setSideCollapsed, useSideCollapsed } from '../../../core/shell/sideCollapse'
import { setTheme } from '../../../core/ui'
import { AppearanceSection } from './AppearanceSection'

// 外壳侧栏的收起按钮用的也是这个状态，这里用一个小组件代替
function SideProbe() {
  const [collapsed] = useSideCollapsed()
  return <span data-testid="side">{collapsed ? '收起' : '展开'}</span>
}

beforeEach(() => {
  localStorage.clear()
  setTheme('light')
})

describe('设置 / 外观', () => {
  it('三张配色卡片，点哪张哪张高亮并马上生效、存进浏览器', async () => {
    render(<AppearanceSection />)
    expect(screen.getByRole('button', { name: /浅色/ })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: /深色/ }))
    expect(screen.getByRole('button', { name: /深色/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /浅色/ })).toHaveAttribute('aria-pressed', 'false')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('pmw-theme')).toBe('dark')
    await userEvent.click(screen.getByRole('button', { name: /跟随系统/ }))
    expect(localStorage.getItem('pmw-theme')).toBe('system')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('收起一级菜单和侧栏按钮是同一个状态', async () => {
    render(<><AppearanceSection /><SideProbe /></>)
    const sw = screen.getByRole('switch', { name: '收起一级菜单' })
    expect(sw).not.toBeChecked()
    await userEvent.click(sw)
    expect(screen.getByTestId('side')).toHaveTextContent('收起')
    expect(localStorage.getItem('pmw-side')).toBe('collapsed')
    act(() => setSideCollapsed(false))
    expect(sw).not.toBeChecked()
  })
})
