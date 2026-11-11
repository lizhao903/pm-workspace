import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { ChatPanel } from './ChatPanel'

it('连续对话携带历史，清空后重置', async () => {
  const user = userEvent.setup()
  const send = vi.fn().mockResolvedValue('回复')
  render(<ChatPanel initialInput="环境查询" onSend={send} />)
  await user.click(screen.getByRole('button', { name: /^发送$/ }))
  await screen.findByText('回复')
  await user.type(screen.getByRole('textbox', { name: '消息' }), '继续{Enter}')
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
  expect(send.mock.calls[1][0].map((m: { content: string }) => m.content)).toEqual(['环境查询', '回复', '继续'])
  await waitFor(() => expect(screen.getByRole('button', { name: '清空对话' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: '清空对话' }))
  expect(screen.getByRole('log')).toHaveTextContent('发送消息，开始对话')
})
it('失败重试不重复添加用户消息，卸载取消请求', async () => {
  const user = userEvent.setup()
  const send = vi.fn().mockRejectedValueOnce(new Error('连接失败')).mockResolvedValueOnce('成功')
  const view = render(<ChatPanel initialInput="测试" onSend={send} />)
  await user.click(screen.getByRole('button', { name: /^发送$/ }))
  await screen.findByRole('alert')
  await user.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByText('成功')
  expect(send.mock.calls[1][0]).toHaveLength(1)
  send.mockImplementation(() => new Promise(() => {}))
  await user.type(screen.getByRole('textbox', { name: '消息' }), '下一条{Enter}')
  const signal = send.mock.calls[2][1] as AbortSignal
  view.unmount()
  expect(signal.aborted).toBe(true)
})
