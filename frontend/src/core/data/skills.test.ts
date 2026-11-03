import { describe, expect, it } from 'vitest'
import { invalidationsFor } from './invalidate'
import { skillKeys } from './skillKeys'
import { skillReadonly } from './skills'

describe('技能的数据层', () => {
  it('技能改动刷技能；插件启停也刷技能（插件技能跟着出现、消失）', () => {
    expect(invalidationsFor({ kind: 'skill' })).toContainEqual(skillKeys.all)
    expect(invalidationsFor({ kind: 'plugin' })).toContainEqual(skillKeys.all)
  })

  it('只有自定义技能能改', () => {
    expect(skillReadonly({ source: 'custom' })).toBe(false)
    expect(skillReadonly({ source: 'builtin' })).toBe(true)
    expect(skillReadonly({ source: 'video' })).toBe(true)
  })
})
