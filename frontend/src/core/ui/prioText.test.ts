import { describe, expect, it } from 'vitest'
import { prioText } from './prioText'

describe('优先级显示名', () => {
  it('编号加字典名称', () => {
    expect(prioText('P0', { label: '紧急' })).toBe('P0 紧急')
  })

  it('没有名称、名称就是编号或已带编号时不重复', () => {
    expect(prioText('P1')).toBe('P1')
    expect(prioText('P1', { label: ' ' })).toBe('P1')
    expect(prioText('P1', { label: 'P1' })).toBe('P1')
    expect(prioText('P1', { label: 'P1 高' })).toBe('P1 高')
  })
})
