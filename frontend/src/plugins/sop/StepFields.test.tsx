// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SopFieldGroup, SopStepDef } from '../../core/data'
import type { Draft } from './edit'
import { CondEditor, FieldsPanel } from './StepFields'

// TSK-0490：条件从「这一步能拿到的字段」里选，旧写法一键转成结构化条件，一句话的挪进说明；字段面板点了交出路径
const GROUPS: SopFieldGroup[] = [
  { source: 'trigger', label: 'IM 消息自动带入', open: false, fields: [
    { path: 'relevance', type: 'string', label: '和我的关系', declared: true,
      values: [{ value: 'me', label: '@我' }, { value: 'all', label: '@所有人' }, { value: 'dm', label: '私聊' }, { value: '', label: '无关（空串）' }] },
    { path: 'conversation_id', type: 'string', label: '会话 id', declared: true },
  ] },
  { source: 'step', step: 'read', kind: 'im_get_message', label: '「读」（读取消息）的输出', open: false, fields: [
    { path: 'message.text', type: 'string', label: '正文', declared: true },
  ] },
]

function stub() {
  const bodies: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://x')
    if (u.pathname === '/api/sop/step-fields') {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ data: GROUPS, meta: { total: GROUPS.length } }))
    }
    return new Response(JSON.stringify({ data: [] }))
  }))
  return bodies
}

const two = [{ key: 'yes', label: '是' }, { key: 'no', label: '否' }]
const draftOf = (s: SopStepDef): Draft => ({ name: 'x', desc: '', trigger: 'im', fields: [], steps: [{ key: 'read', name: '读', kind: 'im_get_message', after: [] }, s] })

function Harness({ initial, onStep }: { initial: SopStepDef; onStep: (s: SopStepDef) => void }) {
  const [s, setS] = useState(initial)
  return (
    <CondEditor step={s} draft={draftOf(s)} tried loop={false}
      onChange={(p) => { const n = { ...s, ...p }; setS(n); onStep(n) }} />
  )
}

function mount(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('结构化条件（TSK-0490）', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('旧写法一键转成结构化条件，字段从候选里选，值按取值说明下拉', async () => {
    const bodies = stub()
    let last: SopStepDef | undefined
    mount(<Harness initial={{ key: 'd', name: '判断', kind: 'decide', after: ['read'], cases: two, rule: 'relevance 不等于 me' }} onStep={(s) => { last = s }} />)
    fireEvent.click(screen.getByRole('button', { name: '转成结构化条件' }))
    expect(last).toMatchObject({ rule: undefined, cond: { logic: 'and', items: [{ field: 'relevance', op: 'ne', value: 'me' }] } })
    // 字段候选按这一步取，选项按来源分组
    await waitFor(() => expect(bodies).toContainEqual(expect.objectContaining({ step: 'd' })))
    await screen.findByRole('option', { name: 'message.text · 正文' })
    expect(screen.getByRole('combobox', { name: '第 1 条条件的值' })).toHaveValue('me')
    fireEvent.click(screen.getByRole('button', { name: '加一条条件' }))
    fireEvent.change(screen.getByRole('combobox', { name: '第 2 条条件的字段' }), { target: { value: 'conversation_id' } })
    fireEvent.change(screen.getByRole('textbox', { name: '第 2 条条件的值' }), { target: { value: 'cv_1' } })
    fireEvent.click(screen.getByRole('radio', { name: '满足任一条（或）' }))
    expect(last?.cond).toEqual({ logic: 'or', items: [{ field: 'relevance', op: 'ne', value: 'me' }, { field: 'conversation_id', op: 'eq', value: 'cv_1' }] })
  })

  it('一句话的条件挪进说明，改用条件；删光条件回到人工判断', () => {
    stub()
    let last: SopStepDef | undefined
    mount(<Harness initial={{ key: 'd', name: '判断', kind: 'decide', after: ['read'], cases: two, desc: '原说明', rule: '来源群组是某群且没有 @我' }} onStep={(s) => { last = s }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('是一句话')
    fireEvent.click(screen.getByRole('button', { name: '挪进说明，改用条件' }))
    expect(last).toMatchObject({ rule: undefined, desc: '原说明\n来源群组是某群且没有 @我', cond: { items: [{ field: '', op: 'eq', value: '' }] } })
    fireEvent.click(screen.getByRole('button', { name: '删掉第 1 条条件' }))
    expect(last?.cond).toBeUndefined()
    expect(screen.getByText('人工判断：执行到这里停下，由人选走哪个分支。')).toBeInTheDocument()
  })

  it('字段面板按来源分组，点了交出路径', async () => {
    stub()
    const picked: string[] = []
    const s: SopStepDef = { key: 'm', name: '标', kind: 'im_mark_message', after: ['read'] }
    mount(<FieldsPanel draft={draftOf(s)} stepKey="m" onPick={(p) => picked.push(p)} />)
    fireEvent.click(await screen.findByRole('button', { name: /^relevance/ }))
    expect(picked).toEqual(['relevance'])
    expect(screen.getByText('「读」（读取消息）的输出')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^relevance/ })).toHaveTextContent('me=@我')
  })
})
