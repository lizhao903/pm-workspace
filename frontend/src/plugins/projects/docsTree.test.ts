// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { LocalFileEntry } from '../../core/data'
import { buildDocsTree, defaultOpen, flattenDocsTree } from './docsTree'

const f = (rel: string): LocalFileEntry => {
  const name = rel.replace(/\\/g, '/').split('/').pop() ?? rel
  return {
    rel, path: `/p/docs/${rel}`, name, ext: name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '',
    kind: 'text', size: 1, modified: '2026-11-11T00:00:00Z',
  }
}

/** 摊平成好比的字符串：文件夹 d:<路径>，文件 f:<rel> */
const flat = (files: LocalFileEntry[], isOpen: (p: string) => boolean = () => true) =>
  flattenDocsTree(buildDocsTree(files), isOpen).map((r) => (r.t === 'dir' ? `d:${r.path}` : `f:${r.file.rel}`))

const tree = [
  f('b.md'), f('a.md'),
  f('prd/z.md'), f('prd/2026/q1.md'),
  f('img/logo.png'),
]

describe('项目文档目录树', () => {
  it('按 rel 分层，文件夹在前、文件在后，各自按名字排', () => {
    expect(flat(tree)).toEqual([
      'd:img', 'f:img/logo.png',
      'd:prd', 'd:prd/2026', 'f:prd/2026/q1.md', 'f:prd/z.md',
      'f:a.md', 'f:b.md',
    ])
  })

  it('层级深度从顶层算起，文件夹带子树文件数', () => {
    const rows = flattenDocsTree(buildDocsTree(tree), () => true).filter((r) => r.t === 'dir')
    expect(rows.map((r) => [r.t === 'dir' ? r.path : '', r.t === 'dir' ? r.depth : -1, r.t === 'dir' ? r.count : -1])).toEqual([
      ['img', 0, 1],
      ['prd', 0, 2],
      ['prd/2026', 1, 1],
    ])
  })

  it('默认第一层展开、更深收起', () => {
    expect(defaultOpen('prd')).toBe(true)
    expect(defaultOpen('prd/2026')).toBe(false)
    expect(flat(tree, defaultOpen)).toEqual([
      'd:img', 'f:img/logo.png',
      'd:prd', 'd:prd/2026', 'f:prd/z.md',
      'f:a.md', 'f:b.md',
    ])
  })

  it('重复 rel 只留一份，拆不出文件名的跳过，反斜杠当分隔符', () => {
    expect(flat([f('a.md'), f('a.md'), f(''), f('.')])).toEqual(['f:a.md'])
    expect(flat([f('prd\\b.md')])).toEqual(['d:prd', 'f:prd\\b.md'])
  })
})
