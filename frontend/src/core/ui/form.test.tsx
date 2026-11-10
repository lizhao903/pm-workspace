// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Textarea } from './form'

let content = 0
const spy = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(() => content)
afterEach(() => { content = 0 })
afterAll(() => { spy.mockRestore() })

function Box({ autoGrow = true }: { autoGrow?: boolean }) {
  const [v, setV] = useState('')
  return <Textarea aria-label="正文" rows={5} autoGrow={autoGrow} value={v} onChange={(e) => setV(e.target.value)} />
}

describe('Textarea autoGrow', () => {
  it('高度跟内容走：打字、粘贴变高，删短了变回去；带 grow（不出滚动条、不给手动拉）', () => {
    content = 100
    render(<Box />)
    const box = screen.getByRole('textbox', { name: '正文' }) as HTMLTextAreaElement
    expect(box).toHaveClass('textarea', 'grow')
    expect(box.style.height).toBe('100px')
    content = 640
    fireEvent.change(box, { target: { value: '长文\n'.repeat(30) } })
    expect(box.style.height).toBe('640px')
    content = 100
    fireEvent.change(box, { target: { value: '短' } })
    expect(box.style.height).toBe('100px')
  })

  it('没开 autoGrow 的不动高度', () => {
    content = 500
    render(<Box autoGrow={false} />)
    const box = screen.getByRole('textbox', { name: '正文' })
    expect(box).not.toHaveClass('grow')
    expect(box.style.height).toBe('')
  })

  it('外面传的 ref 照样拿得到元素', () => {
    let el: HTMLTextAreaElement | null = null
    render(<Textarea aria-label="x" autoGrow ref={(x) => { el = x }} />)
    expect(el).toBe(screen.getByRole('textbox', { name: 'x' }))
  })
})
