import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { ExecutorTestReply, ExecutorsSection } from './ExecutorsSection'

afterEach(() => vi.unstubAllGlobals())
it('执行器支持查询、新建、编辑、启停和删除', async () => {
  const user = userEvent.setup()
  let list = [{ id: 'exec_1', name: 'Claude Code', kind: 'claude', bin: 'claude', desc: '', enabled: true }]
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/probe')) return new Response(JSON.stringify({ data: { path: '/bin/cli', version: 'test 1', warnings: [] } }))
    const method = init?.method ?? 'GET'
    if (method === 'POST') list.push({ ...JSON.parse(String(init?.body)), id: 'exec_2' })
    if (method === 'PUT') list = list.map((x) => x.id === 'exec_2' ? { ...JSON.parse(String(init?.body)), id: x.id } : x)
    if (method === 'DELETE') list = list.filter((x) => !String(url).endsWith(x.id))
    return new Response(JSON.stringify({ data: method === 'GET' ? list : method === 'DELETE' ? null : list.at(-1) }), { status: method === 'POST' ? 201 : 200 })
  }))
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ExecutorsSection /></QueryClientProvider>)
  expect(await screen.findByText('Claude Code', { selector: 'strong' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '新建执行器' }))
  await user.type(screen.getByRole('textbox', { name: '执行器名称' }), '我的 DS')
  await user.selectOptions(screen.getByRole('combobox', { name: '执行器类型' }), 'deepseek')
  expect(screen.getByRole('textbox', { name: '程序路径' })).toHaveValue('dsh')
  await user.click(screen.getByRole('button', { name: '保存' }))
  expect(await screen.findByText('我的 DS', { selector: 'strong' })).toBeInTheDocument()
  await user.type(screen.getByRole('textbox', { name: '搜索执行器' }), '我的 DS')
  expect(screen.queryByText('Claude Code', { selector: 'strong' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '编辑' }))
  await user.clear(screen.getByRole('textbox', { name: '执行器名称' }))
  await user.type(screen.getByRole('textbox', { name: '执行器名称' }), '新 DS')
  await user.click(screen.getByRole('checkbox', { name: '启用' }))
  await user.click(screen.getByRole('button', { name: '保存' }))
  await user.clear(screen.getByRole('textbox', { name: '搜索执行器' }))
  expect(await screen.findByText('新 DS', { selector: 'strong' })).toBeInTheDocument()
  expect(screen.getByText('已停用')).toBeInTheDocument()
  const card = screen.getByText('新 DS', { selector: 'strong' }).closest('article') as HTMLElement
  await user.click(within(card).getByRole('button', { name: '删除' }))
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '删除' }))
  expect(await screen.findByText('Claude Code', { selector: 'strong' })).toBeInTheDocument()
  expect(list).toHaveLength(1)
})

it('保存失败保留表单，取消未保存改动需要确认', async () => {
  const user = userEvent.setup()
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (String(_url).endsWith('/probe')) return new Response(JSON.stringify({ data: { path: '/bin/cli', version: 'test 1', warnings: [] } }))
    if ((init?.method ?? 'GET') === 'POST') return new Response(JSON.stringify({ error: { code: 'conflict', message: '执行器名称已存在' } }), { status: 409 })
    return new Response(JSON.stringify({ data: [] }))
  }))
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ExecutorsSection /></QueryClientProvider>)
  await user.click(screen.getByRole('button', { name: '新建执行器' }))
  expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  await user.type(screen.getByRole('textbox', { name: '执行器名称' }), '重复名称')
  await user.click(screen.getByRole('button', { name: '保存' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('执行器名称已存在')
  expect(screen.getByRole('textbox', { name: '执行器名称' })).toHaveValue('重复名称')
  await user.click(screen.getByRole('button', { name: '取消' }))
  expect(screen.getByRole('alertdialog')).toHaveTextContent('放弃未保存的改动')
  await user.click(screen.getByRole('button', { name: '继续编辑' }))
  expect(screen.getByRole('textbox', { name: '执行器名称' })).toHaveValue('重复名称')
})

it('展示配置警告与模型，探测完整路径和版本，测试所选服务商', async () => {
  const user = userEvent.setup()
  const calls: { url: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
    const data = String(url).endsWith('/api/agent-providers') ? [{ id: 'p1', name: '我的服务商', model: 'model-v3', enabled: true }]
      : String(url).endsWith('/probe') ? { path: '/opt/bin/dsh', version: 'dsh 1.2.3', warnings: [] }
      : String(url).endsWith('/test') ? { reply: '连接正常', model: 'model-v3' }
      : [{ id: 'exec_1', name: 'DS', kind: 'deepseek', bin: 'dsh', desc: '', enabled: true, provider_id: '', warnings: ['未选择模型服务商'] }]
    return new Response(JSON.stringify({ data }))
  }))
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ExecutorsSection /></QueryClientProvider>)
  expect(await screen.findByText(/配置缺失：未选择模型服务商/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '编辑' }))
  expect(screen.getByRole('button', { name: '发送测试' })).toBeDisabled()
  expect(await screen.findByText('dsh 1.2.3', { selector: 'code' })).toBeInTheDocument()
  await user.click(await screen.findByRole('button', { name: '使用完整路径' }))
  expect(screen.getByRole('textbox', { name: '程序路径' })).toHaveValue('/opt/bin/dsh')
  await user.selectOptions(screen.getByRole('combobox', { name: '模型服务商' }), 'p1')
  await user.click(screen.getByRole('button', { name: '发送测试' }))
  expect(await screen.findByText('连接正常')).toBeInTheDocument()
  expect(calls.find((x) => x.url.endsWith('/test'))?.body).toMatchObject({ executor: { provider_id: 'p1', bin: '/opt/bin/dsh' } })
})

it('Codex CLI 默认使用本机 ChatGPT 登录，测试通过 CLI 发送', async () => {
  const user = userEvent.setup()
  let tested: unknown
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/probe')) return new Response(JSON.stringify({ data: { path: '/opt/bin/codex', version: 'codex-cli 1.0', warnings: [] } }))
    if (String(url).endsWith('/test')) { tested = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ data: { reply: 'Codex 回复正常', model: '本机默认模型' } })) }
    return new Response(JSON.stringify({ data: [] }))
  }))
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ExecutorsSection /></QueryClientProvider>)
  await user.click(screen.getByRole('button', { name: '新建执行器' }))
  await user.type(screen.getByRole('textbox', { name: '执行器名称' }), 'ChatGPT')
  await user.selectOptions(screen.getByRole('combobox', { name: '执行器类型' }), 'codex')
  expect(screen.getByRole('textbox', { name: '程序路径' })).toHaveValue('codex')
  expect(screen.getByRole('checkbox', { name: /使用本机 Codex/ })).toBeChecked()
  expect(screen.queryByRole('combobox', { name: '模型服务商' })).not.toBeInTheDocument()
  await user.click(await screen.findByRole('button', { name: '使用完整路径' }))
  await user.click(screen.getByRole('button', { name: '发送测试' }))
  expect(await screen.findByText('Codex 回复正常')).toBeInTheDocument()
  expect(tested).toMatchObject({ executor: { kind: 'codex', bin: '/opt/bin/codex', use_cli_config: true } })
  await user.click(screen.getByRole('checkbox', { name: /使用本机 Codex/ }))
  expect(screen.getByRole('combobox', { name: '模型服务商' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '发送测试' })).toBeDisabled()
})

it('环境查询回复按四类表格展示，支持 Markdown JSON', () => {
  render(<ExecutorTestReply reply={'```json\n{"skill":["review"],"mcp":["pmw"],"rag":[],"rule":["AGENTS.md"]}\n```'} />)
  const table = screen.getByRole('table')
  expect(within(table).getByText('review')).toBeInTheDocument()
  expect(within(table).getByText('pmw')).toBeInTheDocument()
  expect(within(table).getByText('AGENTS.md')).toBeInTheDocument()
  expect(within(table).getByText('无 / 未确认')).toBeInTheDocument()
})
it('环境查询无法解析时显示原文，不误报空列表', () => {
  render(<ExecutorTestReply reply='无法查询环境' />)
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  expect(screen.getByText('无法查询环境')).toBeInTheDocument()
})
