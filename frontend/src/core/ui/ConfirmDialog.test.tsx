// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './ConfirmDialog'

describe('ConfirmDialog', () => {
  it('列出连带影响，确认和取消各自回调', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(
      <ConfirmDialog open danger title="删除需求 REQ-0001？" confirmLabel="删除"
        impacts={['3 条子任务一起删除', '2 个文档解除关联']} onConfirm={onConfirm} onCancel={onCancel}>
        删除后不能恢复。
      </ConfirmDialog>,
    )
    const dlg = screen.getByRole('alertdialog', { name: '删除需求 REQ-0001？' })
    expect(dlg).toHaveAccessibleDescription(/删除后不能恢复/)
    expect(screen.getByText('连带影响')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['3 条子任务一起删除', '2 个文档解除关联'])
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: '删除' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('Tab 在弹窗里循环', async () => {
    const user = userEvent.setup()
    render(<ConfirmDialog open title="确认" onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: '确定' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus()
  })

  it('open 为 false 时不渲染', () => {
    render(<ConfirmDialog open={false} title="确认" onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})
