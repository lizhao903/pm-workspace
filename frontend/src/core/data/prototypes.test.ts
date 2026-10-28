import { describe, expect, it } from 'vitest'
import { PROTOTYPE_LOG_MAX, mergeLogs, prototypesPollMs, type ProjectPrototype, type PrototypeLogLine } from './prototypes'

const proto = (status: ProjectPrototype['status']) => ({ status }) as ProjectPrototype
const line = (seq: number): PrototypeLogLine => ({ seq, at: '', text: `l${seq}` })

describe('原型列表的轮询间隔', () => {
  it('有启动中的每秒，有运行中的每 3 秒，都停着不轮询', () => {
    expect(prototypesPollMs(undefined)).toBe(false)
    expect(prototypesPollMs([proto('stopped'), proto('crashed')])).toBe(false)
    expect(prototypesPollMs([proto('running'), proto('stopped')])).toBe(3000)
    expect(prototypesPollMs([proto('running'), proto('starting')])).toBe(1000)
  })
})

describe('日志增量拼接', () => {
  it('只接 seq 更大的行', () => {
    expect(mergeLogs([line(1), line(2)], [line(2), line(3)]).map((l) => l.seq)).toEqual([1, 2, 3])
  })

  it('最多留最后 PROTOTYPE_LOG_MAX 行', () => {
    const prev = Array.from({ length: PROTOTYPE_LOG_MAX }, (_, i) => line(i + 1))
    const out = mergeLogs(prev, [line(PROTOTYPE_LOG_MAX + 1)])
    expect(out).toHaveLength(PROTOTYPE_LOG_MAX)
    expect(out[0].seq).toBe(2)
    expect(out.at(-1)!.seq).toBe(PROTOTYPE_LOG_MAX + 1)
  })
})
