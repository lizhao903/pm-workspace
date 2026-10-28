import { describe, expect, it } from 'vitest'
import type { Category, LocalDir, WorkObject } from '../../core/data'
import { buildTree, builtinModel, charCount, emptyText, fileSize, folderModel, STARRED, UNCATEGORIZED, type Filter } from './model'

const cat = (id: string, name: string, sort: number, total: number, children: Category[] = []): Category => ({
  id, type_id: 'doc', parent_id: null, name, slug: id, path: `/${id}/`, depth: 0, color: '', description: '', sort_order: sort,
  created_at: '', updated_at: '', count: 0, total_count: total, children,
})
const tree = [cat('c_b', '技术方案', 20, 1), cat('c_a', '需求文档', 10, 2, [cat('c_a1', '子类', 0, 1)])]

let n = 0
const obj = (p: Partial<WorkObject>): WorkObject => ({
  id: `obj_${++n}`, type_id: 'doc', ref: '', title: 't', body: '', status: 'draft', priority: '', owner: '', owner_id: null,
  category_id: null, project_id: null, source: '', props: null, workdir: '', due_at: null, started_at: null, completed_at: null,
  archived_at: null, deleted_at: null, created_at: '', updated_at: '2026-10-01T00:00:00Z', tags: [], link_count: 0, participants: [], ...p,
})
const docs = [
  obj({ id: 'a', title: '权限 PRD', category_id: 'c_a', tags: ['云端', '权限'], updated_at: '2026-10-03T00:00:00Z' }),
  obj({ id: 'a1', title: '子类里的', category_id: 'c_a1', tags: ['云端'], body: '## 接口\n正文里有 Webhook', updated_at: '2026-10-02T00:00:00Z' }),
  obj({ id: 'b', title: '方案', category_id: 'c_b', props: { starred: true } }),
  obj({ id: 'x', title: '没分类' }),
]
const all: Filter = { kind: '', tags: [], q: '' }
const starred = (o: WorkObject) => o.props?.starred === true

describe('工作台文档的视图模型', () => {
  it('筛选项：星标 + 一级分类按 sort_order（数量取分类树的 total_count）+ 有才列的未分类', () => {
    const m = builtinModel(docs, tree, all, starred)
    expect(m.kinds.map((k) => [k.key, k.label, k.count])).toEqual([
      [STARRED, '星标', 1], ['c_a', '需求文档', 2], ['c_b', '技术方案', 1], [UNCATEGORIZED, '未分类', 1],
    ])
    expect(m.rows.map((d) => d.id)).toEqual(['a', 'a1', 'b', 'x'])
  })

  it('子分类的文档归到一级分类下筛，树里按各级分类名嵌套', () => {
    const m = builtinModel(docs, tree, { ...all, kind: 'c_a' }, starred)
    expect(m.rows.map((d) => d.id)).toEqual(['a', 'a1'])
    const t = buildTree(builtinModel(docs, tree, all, starred).rows, m.order)
    expect(t.dirs.map((d) => [d.name, d.count])).toEqual([['需求文档', 2], ['技术方案', 1], ['未分类', 1]])
    expect(t.dirs[0].dirs.map((d) => [d.path, d.count])).toEqual([['需求文档/子类', 1]])
  })

  it('标签多选是 AND：两个都要有', () => {
    expect(builtinModel(docs, tree, { ...all, tags: ['云端'] }, starred).rows.map((d) => d.id)).toEqual(['a', 'a1'])
    expect(builtinModel(docs, tree, { ...all, tags: ['云端', '权限'] }, starred).rows.map((d) => d.id)).toEqual(['a'])
  })

  it('搜索不分大小写，匹配标题、正文、文件夹路径、标签，多个词都要命中', () => {
    const q = (s: string) => builtinModel(docs, tree, { ...all, q: s }, starred).rows.map((d) => d.id)
    expect(q('webhook')).toEqual(['a1'])
    expect(q('需求文档')).toEqual(['a', 'a1'])
    expect(q('权限')).toEqual(['a'])
    expect(q('云端 子类')).toEqual(['a1'])
  })

  it('星标筛选和空状态分开说', () => {
    const m = builtinModel(docs, tree, { ...all, kind: STARRED }, starred)
    expect(m.rows.map((d) => d.id)).toEqual(['b'])
    expect(emptyText(builtinModel([], tree, { ...all, kind: STARRED }, starred), { ...all, kind: STARRED })).toBe('还没有文档')
    expect(emptyText(builtinModel(docs.slice(0, 2), tree, { ...all, kind: STARRED }, starred), { ...all, kind: STARRED })).toBe('还没有加星标的文档')
    expect(emptyText(m, { ...all, q: 'zzz' })).toBe('没有匹配的内容')
  })
})

describe('本地目录的视图模型', () => {
  const dir: LocalDir = { id: 'dir_1', path: '/tmp/d', name: 'd', position: 0, created_at: '', updated_at: '' }
  const f = (rel: string, ext: string) => ({ rel, path: `/tmp/d/${rel}`, name: rel.split('/').pop() ?? rel, ext, size: 10, modified: '2026-10-01T00:00:00Z' })
  const list = { path: '/tmp/d', files: [f('README.md', 'md'), f('docs/a/b/c/d/e/deep.md', 'md'), f('notes.txt', 'txt')], skipped: 2, truncated: false }

  it('筛选项是出现过的扩展名，大写、按字母序；Markdown 只认 md、markdown', () => {
    const m = folderModel(dir, list, all)
    expect(m.kinds.map((k) => [k.key, k.label, k.count])).toEqual([['md', 'MD', 2], ['txt', 'TXT', 1]])
    expect(m.docs.map((d) => d.markdown)).toEqual([true, true, false])
    expect(m.docs[1].dirs).toEqual(['docs', 'a', 'b', 'c', 'd', 'e'])
    expect(m.docs[0].meta).toEqual(['d/README.md', '10 B'])
  })

  it('按文件名、路径搜；空目录说没有可读的文本文件', () => {
    expect(folderModel(dir, list, { ...all, q: 'deep' }).rows.map((d) => d.title)).toEqual(['deep.md'])
    const empty = folderModel(dir, { ...list, files: [] }, all)
    expect(emptyText(empty, all)).toBe('这个目录下没有可读的文本文件')
  })
})

describe('小工具', () => {
  it('字数去掉空白和 # > * ` -', () => expect(charCount('# 标题\n- 一 **二**')).toBe(4))
  it('文件大小', () => {
    expect(fileSize(512)).toBe('512 B')
    expect(fileSize(6587)).toBe('6.4 KB')
    expect(fileSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
