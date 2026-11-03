import { afterEach, describe, expect, it } from 'vitest'
import { terminalLauncherRegistry, terminalLauncherStore } from './terminalLaunch'

const launch = async () => ({ command: 'gogogo' })

afterEach(() => { terminalLauncherStore.removeOwner('terminal'); terminalLauncherStore.removeOwner('other') })

describe('终端入口扩展点（内核 0048）', () => {
  it('同一时间只有一个，按插件撤掉', () => {
    terminalLauncherRegistry('terminal').register({ page: '/terminal', launch })
    expect(() => terminalLauncherRegistry('other').register({ page: '/x', launch })).toThrow('终端入口已由插件 terminal 登记')
    expect(terminalLauncherStore.list().map((x) => x.plugin)).toEqual(['terminal'])
    terminalLauncherStore.removeOwner('terminal')
    expect(terminalLauncherStore.list()).toEqual([])
    terminalLauncherRegistry('other').register({ page: '/x', launch })
    expect(terminalLauncherStore.list()[0].page).toBe('/x')
  })
})
