import { describe, expect, it } from 'vitest'
import type { WorkObject } from '../../core/data'
import { firstLine, searchProjects, SEARCH_MAX } from './search'

const proj = (id: string, title: string, body = '', workdir = '') => ({ id, title, body, workdir, props: {} }) as unknown as WorkObject

describe('searchProjects', () => {
  const rows = [
    proj('p1', '客户端改版', 'Octok 的桌面客户端', '/work/octok-desktop'),
    proj('p2', 'Octok 官网', '营销站', '/work/site'),
    proj('p3', '内部工具', '', '/work/tools'),
  ]
  it('按名称、说明、目录搜，不分大小写；名称开头命中的排前面', () => {
    expect(searchProjects(rows, 'octok').map((p) => p.id)).toEqual(['p2', 'p1'])
    expect(searchProjects(rows, 'TOOLS').map((p) => p.id)).toEqual(['p3'])
  })
  it('多个词每个都要命中；空输入不出结果', () => {
    expect(searchProjects(rows, 'octok 桌面').map((p) => p.id)).toEqual(['p1'])
    expect(searchProjects(rows, '  ')).toEqual([])
  })
  it('最多给 SEARCH_MAX 条', () => {
    const many = Array.from({ length: 10 }, (_, i) => proj('x' + i, '项目' + i))
    expect(searchProjects(many, '项目')).toHaveLength(SEARCH_MAX)
  })
  it('firstLine 取第一个非空行', () => {
    expect(firstLine('\n  第一行 \n第二行')).toBe('第一行')
    expect(firstLine('')).toBe('')
  })
})
