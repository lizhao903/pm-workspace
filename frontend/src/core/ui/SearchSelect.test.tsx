import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SearchSelect, type SearchOption } from './SearchSelect'

const OPTIONS: SearchOption[] = [
  { value: 'p1', label: '官网改版', keywords: 'guanwang' },
  { value: 'p2', label: '支付接入', hint: '进行中' },
  { value: 'p3', label: '数据看板', disabled: true },
  { value: 'p4', label: '会员体系' },
]

const optionNames = () => screen.getAllByRole('option').map((o) => o.querySelector('.ss-label')?.textContent)

function Single({ onChange, initial = '' }: { onChange?: (v: string) => void; initial?: string }) {
  const [v, setV] = useState(initial)
  return (
    <SearchSelect aria-label="项目" value={v} noneLabel="全部项目" options={OPTIONS}
      onChange={(x) => { setV(x); onChange?.(x) }} />
  )
}

describe('SearchSelect', () => {
  it('点开列出全部选项，最上面是 noneLabel', async () => {
    const user = userEvent.setup()
    render(<Single />)
    const trigger = screen.getByRole('button', { name: '项目' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('combobox')).toHaveFocus()
    expect(optionNames()).toEqual(['全部项目', '官网改版', '支付接入', '数据看板', '会员体系'])
  })

  it('输入即筛：label、keywords、hint 都能搜到，没匹配给提示', async () => {
    const user = userEvent.setup()
    render(<Single />)
    await user.click(screen.getByRole('button', { name: '项目' }))
    const input = screen.getByRole('combobox')

    await user.type(input, '支付')
    expect(optionNames()).toEqual(['支付接入'])

    await user.clear(input)
    await user.type(input, 'GUANWANG')
    expect(optionNames()).toEqual(['官网改版'])

    await user.clear(input)
    await user.type(input, '进行中')
    expect(optionNames()).toEqual(['支付接入'])

    await user.clear(input)
    await user.type(input, '不存在')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText('没有匹配的选项')).toBeInTheDocument()
  })

  it('上下键移动高亮、跳过不能选的，回车选中并关闭', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Single onChange={onChange} />)
    const trigger = screen.getByRole('button', { name: '项目' })
    await user.click(trigger)
    const input = screen.getByRole('combobox')
    const activeLabel = () => document.getElementById(input.getAttribute('aria-activedescendant') ?? '')?.textContent

    // 没选时停在「全部项目」上
    expect(activeLabel()).toBe('全部项目')
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(activeLabel()).toContain('支付接入')
    // 「数据看板」禁用，直接跳到「会员体系」
    await user.keyboard('{ArrowDown}')
    expect(activeLabel()).toBe('会员体系')
    await user.keyboard('{ArrowUp}')
    expect(activeLabel()).toContain('支付接入')

    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith('p2')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger).toHaveTextContent('支付接入')
    expect(trigger).toHaveFocus()
  })

  it('输入后回车选第一条匹配项', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Single onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: '项目' }))
    await user.keyboard('会员{Enter}')
    expect(onChange).toHaveBeenCalledWith('p4')
  })

  it('Esc 关闭、不改值，焦点回到触发按钮；触发按钮上按下键能打开', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Single onChange={onChange} initial="p1" />)
    const trigger = screen.getByRole('button', { name: '项目' })
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await user.keyboard('{ArrowDown}{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveTextContent('官网改版')
  })

  it('当前值不在选项里时照样显示', () => {
    render(<SearchSelect aria-label="项目" value="gone" options={OPTIONS} missingLabel={() => '已删除的项目'} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: '项目' })).toHaveTextContent('已删除的项目')
  })

  it('多选：勾选不关弹层，回调整个数组', async () => {
    const user = userEvent.setup()
    function Multi() {
      const [v, setV] = useState<string[]>([])
      return <SearchSelect multiple aria-label="项目" value={v} onChange={setV} options={OPTIONS} />
    }
    render(<Multi />)
    await user.click(screen.getByRole('button', { name: '项目' }))
    await user.click(screen.getByRole('option', { name: '官网改版' }))
    await user.click(screen.getByRole('option', { name: /支付接入/ }))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(screen.getByText('已选 2 项')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '项目' })).toHaveTextContent('官网改版、支付接入')
  })
})
