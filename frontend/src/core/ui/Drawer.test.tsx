// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Drawer } from './Drawer'
import { DrawerHostContext } from './hostContext'
import { SearchSelect } from './SearchSelect'

function Harness({ dirty = false, onClose }: { dirty?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(false)
  const [proj, setProj] = useState('')
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>打开抽屉</button>
      <Drawer open={open} kicker="编辑任务" dirty={dirty}
        onClose={() => { setOpen(false); onClose?.() }}
        footer={(close) => <button type="button" onClick={close}>取消</button>}>
        <input aria-label="标题" />
        <SearchSelect aria-label="项目" value={proj} onChange={setProj} options={[{ value: 'p1', label: '官网改版' }]} />
      </Drawer>
    </>
  )
}

describe('Drawer', () => {
  it('打开时焦点进入抽屉，Esc 关闭后焦点回到触发按钮', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    const trigger = screen.getByRole('button', { name: '打开抽屉' })
    await user.click(trigger)

    expect(screen.getByRole('dialog', { name: '编辑任务' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '标题' })).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('关闭按钮和 footer 里的取消都能关', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: '打开抽屉' }))
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '打开抽屉' }))
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('抽屉里的选择器按 Esc 只关选择器，不关抽屉', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: '打开抽屉' }))
    await user.click(screen.getByRole('button', { name: '项目' }))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: '编辑任务' })).toBeInTheDocument()
  })

  it('有未保存改动：Esc 先弹确认，继续编辑留在抽屉，放弃改动才关闭', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<Harness dirty onClose={onClose} />)
    const trigger = screen.getByRole('button', { name: '打开抽屉' })
    await user.click(trigger)
    const title = screen.getByRole('textbox', { name: '标题' })

    await user.keyboard('{Escape}')
    const confirm = screen.getByRole('alertdialog', { name: '放弃未保存的改动？' })
    expect(confirm).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    // 焦点落在「继续编辑」上，误按回车也不会丢内容
    expect(screen.getByRole('button', { name: '继续编辑' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: '继续编辑' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: '编辑任务' })).toBeInTheDocument()
    expect(title).toHaveFocus()

    // 确认弹窗上的 Esc 只关确认，不连带关抽屉
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: '编辑任务' })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '取消' }))
    await user.click(screen.getByRole('button', { name: '放弃改动' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('外壳给了抽屉位置就停靠进去，没给就挂在 body 上', () => {
    const slot = document.createElement('div')
    document.body.appendChild(slot)
    const { unmount } = render(
      <DrawerHostContext.Provider value={slot}>
        <Drawer open kicker="停靠" onClose={() => {}} />
      </DrawerHostContext.Provider>,
    )
    expect(slot).toContainElement(screen.getByRole('dialog', { name: '停靠' }))
    unmount()
    expect(slot).toBeEmptyDOMElement()

    render(<Drawer open kicker="浮着" onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: '浮着' }).parentElement).toBe(document.body)
    slot.remove()
  })
})
