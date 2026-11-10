// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { QueryClient, type QueryKey } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import { setApiBase } from '../api'
import { applyChange, type Change } from './invalidate'
import { dataKeys } from './keys'
import { terminalSocketUrl } from './terminal'

describe('终端 WebSocket 地址', () => {
  afterEach(() => setApiBase(''))

  it('默认同源，http 换成 ws、https 换成 wss', () => {
    expect(terminalSocketUrl('pn_ab', undefined, 'http://127.0.0.1:7780')).toBe('ws://127.0.0.1:7780/api/terminal/sessions/pn_ab/ws')
    expect(terminalSocketUrl('pn_ab', undefined, 'https://bro.example')).toBe('wss://bro.example/api/terminal/sessions/pn_ab/ws')
  })

  it('after 大于 0 才带上', () => {
    expect(terminalSocketUrl('pn_ab', 0, 'http://h')).toBe('ws://h/api/terminal/sessions/pn_ab/ws')
    expect(terminalSocketUrl('pn_ab', 1234, 'http://h')).toBe('ws://h/api/terminal/sessions/pn_ab/ws?after=1234')
  })

  it('设了接口地址就跟着它', () => {
    setApiBase('http://127.0.0.1:7796/')
    expect(terminalSocketUrl('pn_ab', undefined, 'http://other')).toBe('ws://127.0.0.1:7796/api/terminal/sessions/pn_ab/ws')
  })
})

describe('终端的失效（TERM-01b）', () => {
  const keys = {
    sessions: dataKeys.terminal.sessions,
    protos: dataKeys.terminal.prototypes,
    projProtos: dataKeys.projectPrototypes.list('obj_p1'),
  } satisfies Record<string, QueryKey>
  async function stale(c: Change) {
    const qc = new QueryClient()
    for (const k of Object.values(keys)) qc.setQueryData(k, {})
    await applyChange(qc, c)
    return (Object.keys(keys) as (keyof typeof keys)[]).filter((n) => qc.getQueryState(keys[n])?.isInvalidated)
  }

  it('会话新建、结束只刷会话列表', async () => {
    expect(await stale({ kind: 'terminal-session' })).toEqual(['sessions'])
  })

  it('任一项目的原型启停，终端那份跨项目的原型列表也刷', async () => {
    expect(await stale({ kind: 'project-prototype', projectId: 'obj_p1' })).toEqual(['protos', 'projProtos'])
  })
})
