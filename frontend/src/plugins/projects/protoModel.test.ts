import { describe, expect, it } from 'vitest'
import type { ProjectPrototype } from '../../core/data'
import { PORT_FROM, PORT_TO, absDir, defaultPort, portConflict, relDir, runningFor, sortProtos, startLabel } from './protoModel'

const proto = (id: string, status: ProjectPrototype['status'], port = 8000, name = id) => ({ id, status, port, name }) as ProjectPrototype

describe('原型排序', () => {
  it('运行中、崩溃、启停中、已停止，同状态按加入顺序', () => {
    const rows = [proto('a', 'stopped'), proto('b', 'running'), proto('c', 'starting'), proto('d', 'crashed'), proto('e', 'running')]
    expect(sortProtos(rows).map((p) => p.id)).toEqual(['b', 'e', 'd', 'c', 'a'])
  })
})

describe('默认端口', () => {
  it('从 PORT_FROM 找第一个本项目没用着的，都满了给 PORT_TO', () => {
    expect(defaultPort([])).toBe(PORT_FROM)
    expect(defaultPort([{ port: PORT_FROM }, { port: PORT_FROM + 1 }])).toBe(PORT_FROM + 2)
    const all = Array.from({ length: PORT_TO - PORT_FROM + 1 }, (_, i) => ({ port: PORT_FROM + i }))
    expect(defaultPort(all)).toBe(PORT_TO)
  })
})

describe('前端能先说的端口冲突', () => {
  const rows = [proto('a', 'running', 8001, '看板'), proto('b', 'stopped', 8002)]
  it('范围不对', () => {
    expect(portConflict(80, '', rows, '工作台')).toBe('端口要在 1024 到 65535 之间')
    expect(portConflict(NaN, '', rows, '工作台')).toBe('端口要在 1024 到 65535 之间')
  })
  it('本项目另一个在跑的占着；已停止的不算，自己不算', () => {
    expect(portConflict(8001, 'x', rows, '工作台')).toBe('8001 端口被「工作台 / 看板」占着')
    expect(portConflict(8001, 'a', rows, '工作台')).toBeNull()
    expect(portConflict(8002, 'x', rows, '工作台')).toBeNull()
  })
})

describe('目录换算', () => {
  it('在项目目录下给相对路径，项目目录本身是空串，别处原样', () => {
    expect(relDir('/p/app/web', '/p/app/')).toBe('web')
    expect(relDir('/p/app', '/p/app')).toBe('')
    expect(relDir('/q/other', '/p/app')).toBe('/q/other')
    expect(relDir('/p/application', '/p/app')).toBe('/p/application')
    expect(relDir('/x', '')).toBe('/x')
  })
  it('存绝对路径：空串是项目目录，相对路径拼上；没设项目目录时相对路径不行', () => {
    expect(absDir('', '/p/app/')).toBe('/p/app')
    expect(absDir('web', '/p/app')).toBe('/p/app/web')
    expect(absDir('/abs', '')).toBe('/abs')
    expect(absDir('web', '')).toBeNull()
    expect(absDir('', '')).toBeNull()
  })
})

describe('文字', () => {
  it('已运行时长', () => {
    const now = Date.parse('2026-10-29T10:00:00Z')
    expect(runningFor('2026-10-29T09:59:30Z', now)).toBe('不到 1 分钟')
    expect(runningFor('2026-10-29T09:55:00Z', now)).toBe('5 分钟')
    expect(runningFor('2026-10-29T08:00:00Z', now)).toBe('2 小时')
    expect(runningFor('2026-10-27T07:00:00Z', now)).toBe('2 天 3 小时')
  })
  it('启动按钮', () => {
    expect(startLabel('stopped')).toBe('启动')
    expect(startLabel('crashed')).toBe('重新启动')
    expect(startLabel('starting')).toBe('启动中…')
  })
})
