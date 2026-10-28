import { describe, expect, it } from 'vitest'
import type { ProjectMaterial } from '../../core/data'
import { allTags, dirOf, joinPath, matchMaterial, newestFirst, resolvePath, splitTags } from './materialModel'

const mat = (p: Partial<ProjectMaterial>): ProjectMaterial => ({
  id: 'mt_1', project_id: 'obj_p', kind: 'file', name: '访谈', value: '/x/a.md', category: '', status: '', tags: [], source: 'manual',
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...p,
})

describe('支持材料的路径', () => {
  it('目录前缀：没填默认 materials，只有文件名时为空，结尾斜杠也认', () => {
    expect(dirOf('')).toBe('materials')
    expect(dirOf('  ')).toBe('materials')
    expect(dirOf('a.md')).toBe('')
    expect(dirOf('materials/a.md')).toBe('materials')
    expect(dirOf('/x/y/')).toBe('/x/y')
    expect(dirOf('/a.md')).toBe('/')
  })

  it('拼文件名', () => {
    expect(joinPath('', 'a.md')).toBe('a.md')
    expect(joinPath('/x', 'a.md')).toBe('/x/a.md')
    expect(joinPath('/', 'a.md')).toBe('/a.md')
    expect(joinPath('/x', '')).toBe('/x/')
  })

  it('相对路径拼上项目目录，绝对路径原样，没设项目目录时返回 null', () => {
    expect(resolvePath(' /abs/a.md ', '/root')).toBe('/abs/a.md')
    expect(resolvePath('materials/a.md', '/root/')).toBe('/root/materials/a.md')
    expect(resolvePath('./a.md', '/root')).toBe('/root/a.md')
    expect(resolvePath('a.md', '')).toBeNull()
    expect(resolvePath('~/a.md', '')).toBe('~/a.md')
  })
})

describe('支持材料的标签和筛选', () => {
  it('中英文逗号都能分隔，去空白、空项、重复', () => {
    expect(splitTags(' 访谈, 竞品，,访谈 ')).toEqual(['访谈', '竞品'])
    expect(splitTags('')).toEqual([])
  })

  it('出现过的标签按先后，新加的在前', () => {
    const rows = [mat({ id: 'a', tags: ['x', 'y'] }), mat({ id: 'b', tags: ['y', 'z'] })]
    expect(allTags(rows)).toEqual(['x', 'y', 'z'])
    expect(newestFirst(rows).map((m) => m.id)).toEqual(['b', 'a'])
  })

  it('搜名称、值、标签不区分大小写；种类和标签同时生效', () => {
    const m = mat({ kind: 'link', name: 'Figma 稿', value: 'https://figma.com/x', tags: ['设计'] })
    expect(matchMaterial(m, { q: 'FIGMA', kind: '', tag: '' })).toBe(true)
    expect(matchMaterial(m, { q: '设计', kind: 'link', tag: '设计' })).toBe(true)
    expect(matchMaterial(m, { q: '', kind: 'file', tag: '' })).toBe(false)
    expect(matchMaterial(m, { q: '', kind: '', tag: '访谈' })).toBe(false)
    expect(matchMaterial(m, { q: '没有', kind: '', tag: '' })).toBe(false)
  })
})
