// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import { mergeFilePages, type Category, type LocalDir, type LocalFileEntry, type LocalFileKind, type LocalFileList, type WorkObject } from '../../core/data'
import {
  buildTree, builtinModel, categoryOptions, charCount, defaultCategory, docPatch, docRevisionText, draftOfObject, emptyText, fileSize,
  flattenTree, folderModel, listNote, NO_PROJECT, projectOptions, sameDocDraft, STARRED, UNCATEGORIZED, type Filter,
} from './model'

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

  it('老后端没有 kind 时按文本；筛选项是出现过的文件种类；Markdown 只认 md、markdown', () => {
    const m = folderModel(dir, list, all)
    expect(m.kinds.map((k) => [k.key, k.label, k.count])).toEqual([['text', '文本', 3]])
    expect(m.docs.map((d) => d.kindLabel)).toEqual(['MD', 'MD', 'TXT'])
    expect(m.docs.map((d) => d.markdown)).toEqual([true, true, false])
    expect(m.docs[1].dirs).toEqual(['docs', 'a', 'b', 'c', 'd', 'e'])
    expect(m.docs[0].meta).toEqual(['d/README.md', '10 B'])
  })

  it('按文件名、路径搜；空目录说没有可读的文本文件', () => {
    expect(folderModel(dir, list, { ...all, q: 'deep' }).rows.map((d) => d.title)).toEqual(['deep.md'])
    const empty = folderModel(dir, { ...list, files: [] }, all)
    expect(emptyText(empty, all)).toBe('这个目录下没有认得的文档')
  })

  const k = (rel: string, kind: LocalFileKind): LocalFileEntry => ({ ...f(rel, rel.split('.').pop() ?? ''), kind })
  const mixed = [k('a.md', 'text'), k('b/r.pdf', 'pdf'), k('b/p.png', 'image'), k('c.docx', 'office'), k('d.xlsx', 'office'), k('e.pptx', 'office')]

  it('全部文档：种类按 文本、PDF、图片、Office 排，按种类筛；只有文本 md 按 Markdown 渲染', () => {
    const m = folderModel(dir, { path: '/tmp/d', files: mixed, skipped: 0, truncated: false }, all)
    expect(m.kinds.map((x) => [x.key, x.label, x.count])).toEqual([['text', '文本', 1], ['pdf', 'PDF', 1], ['image', '图片', 1], ['office', 'Office 文档', 3]])
    expect(m.docs.map((d) => d.fileKind)).toEqual(['text', 'pdf', 'image', 'office', 'office', 'office'])
    expect(m.docs.map((d) => d.markdown)).toEqual([true, false, false, false, false, false])
    const office = folderModel(dir, { path: '/tmp/d', files: mixed, skipped: 0, truncated: false }, { ...all, kind: 'office' })
    expect(office.rows.map((d) => d.title)).toEqual(['c.docx', 'd.xlsx', 'e.pptx'])
  })

  it('分页合起来是全量：文件按页顺序接上，skipped 累加，任一页截断就算截断', () => {
    const page = (files: LocalFileEntry[], p: Partial<LocalFileList>): LocalFileList => ({ path: '/tmp/d', files, skipped: 0, truncated: false, ...p })
    const pages = [page(mixed.slice(0, 2), { skipped: 3, next_cursor: 'c1' }), page(mixed.slice(2, 5), { skipped: 1, next_cursor: 'c2' }),
      page(mixed.slice(5), { skipped: 0, truncated: true, reason: 'depth', visited: 99 })]
    const m = mergeFilePages(pages, false)
    expect(m?.files.map((x) => x.rel)).toEqual(mixed.map((x) => x.rel))
    expect([m?.skipped, m?.truncated, m?.reason, m?.visited, m?.loading]).toEqual([4, true, 'depth', 99, false])
    expect(mergeFilePages([], false)).toBeUndefined()
    expect(mergeFilePages(pages.slice(0, 1), true)?.loading).toBe(true)
  })

  it('搜索覆盖全量：几千个文件里按文件名、路径搜', () => {
    const many = Array.from({ length: 5000 }, (_, i) => k(`dir${i % 50}/sub/file-${i}.md`, 'text'))
    many.push(k('深处/很深/季度复盘.pdf', 'pdf'))
    const m = folderModel(dir, { path: '/tmp/d', files: many, skipped: 0, truncated: false }, { ...all, q: '季度 复盘' })
    expect(m.rows.map((d) => d.title)).toEqual(['季度复盘.pdf'])
    expect(folderModel(dir, { path: '/tmp/d', files: many, skipped: 0, truncated: false }, { ...all, q: 'dir7/sub/file-4957' }).rows).toHaveLength(1)
    // 同一份清单再算一遍，Doc 是同一个对象（缓存住了）
    const a = folderModel(dir, { path: '/tmp/d', files: many, skipped: 0, truncated: false }, all).docs[0]
    expect(folderModel(dir, { path: '/tmp/d', files: many, skipped: 0, truncated: false }, all).docs[0]).toBe(a)
  })

  it('工作目录小字：还在列、跳过、没列全', () => {
    expect(listNote(undefined)).toBeUndefined()
    expect(listNote({ path: '', files: [], skipped: 0, truncated: false })).toBeUndefined()
    expect(listNote({ path: '', files: mixed, skipped: 0, truncated: false, loading: true })?.text).toBe('已列 6 个，还在列')
    const n = listNote({ path: '', files: mixed, skipped: 12, truncated: true, reason: 'visited', visited: 200000 })
    expect(n?.text).toBe('没列全 · 跳过 12 个')
    expect(n?.title).toContain('200,000 项')
    expect(listNote({ path: '', files: [], skipped: 0, truncated: true, reason: 'depth' })?.title).toContain('太深')
  })

  it('内容树摊平：收起的文件夹不展开，展开的里面文件夹在前、文件在后', () => {
    const m = folderModel(dir, { path: '/tmp/d', files: mixed, skipped: 0, truncated: false }, all)
    const t = buildTree(m.rows)
    const shut = flattenTree(t, () => false).map((r) => (r.t === 'dir' ? `d:${r.d.name}` : r.f.title))
    expect(shut).toEqual(['d:b', 'a.md', 'c.docx', 'd.xlsx', 'e.pptx'])
    const open = flattenTree(t, () => true).map((r) => (r.t === 'dir' ? `d:${r.d.name}:${r.depth}` : `${r.f.title}:${r.depth}`))
    expect(open).toEqual(['d:b:0', 'r.pdf:1', 'p.png:1', 'a.md:0', 'c.docx:0', 'd.xlsx:0', 'e.pptx:0'])
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

describe('新建和编辑', () => {
  it('分类下拉：按顺序摊平，子分类带父名，最后是未分类', () => {
    expect(categoryOptions(tree)).toEqual([
      { value: 'c_a', label: '需求文档' }, { value: 'c_a1', label: '需求文档 / 子类' }, { value: 'c_b', label: '技术方案' }, { value: '', label: '未分类' },
    ])
    expect(categoryOptions([])).toEqual([{ value: '', label: '未分类' }])
  })

  it('默认分类：当前筛选是分类就用它，否则取排在最前的', () => {
    expect(defaultCategory(tree, 'c_b')).toBe('c_b')
    expect(defaultCategory(tree, 'c_a1')).toBe('c_a1')
    expect(defaultCategory(tree, STARRED)).toBe('c_a')
    expect(defaultCategory(tree, '')).toBe('c_a')
    expect(defaultCategory([], '')).toBe('')
  })

  it('保存只带改过的字段，标题去空白，分类清空传 null', () => {
    const base = draftOfObject(obj({ title: '旧', body: '正文', category_id: 'c_a' }))
    expect(sameDocDraft(base, { ...base })).toBe(true)
    expect(docPatch(base, { ...base })).toEqual({})
    expect(docPatch(base, { ...base, title: ' 新 ' })).toEqual({ title: '新' })
    expect(docPatch(base, { ...base, body: '改了', category: '' })).toEqual({ body: '改了', category_id: null })
  })

  it('修订的说法：正文只说字数变化，分类和状态用显示名', () => {
    const names = { cat: (id: string) => (id === 'c_b' ? '技术方案' : id), status: (k: string) => (k === 'final' ? '定稿' : k) }
    expect(docRevisionText({ field: 'created', old_value: '', new_value: 't' }, names)).toBe('新建')
    expect(docRevisionText({ field: 'body', old_value: 'ab', new_value: 'abcd' }, names)).toBe('改了正文（多 2 字）')
    expect(docRevisionText({ field: 'body', old_value: 'abc', new_value: 'a' }, names)).toBe('改了正文（少 2 字）')
    expect(docRevisionText({ field: 'title', old_value: 'A', new_value: 'B' }, names)).toBe('标题从「A」改成「B」')
    expect(docRevisionText({ field: 'category_id', old_value: '', new_value: 'c_b' }, names)).toBe('分类改成「技术方案」')
    expect(docRevisionText({ field: 'status', old_value: 'draft', new_value: 'final' }, names)).toBe('状态从「draft」改成「定稿」')
    expect(docRevisionText({ field: 'project_id', old_value: '', new_value: 'p1' }, names)).toBe('归到项目')
  })
})

describe('按项目筛（C-04）', () => {
  const ds = [
    obj({ id: 'p1d', title: '甲', category_id: 'c_a', project_id: 'p1', project_title: '支付' }),
    obj({ id: 'p2d', title: '乙', category_id: 'c_a', project_id: 'p_gone', project_title: '旧项目' }),
    obj({ id: 'nod', title: '丙', category_id: 'c_a' }),
  ]
  it('项目单选，NO_PROJECT 是不属于项目；筛项目后空分类不说「这个分类下还没有内容」', () => {
    expect(builtinModel(ds, tree, { ...all, project: 'p1' }, starred).rows.map((d) => d.id)).toEqual(['p1d'])
    expect(builtinModel(ds, tree, { ...all, project: NO_PROJECT }, starred).rows.map((d) => d.id)).toEqual(['nod'])
    expect(builtinModel(ds, tree, all, starred).rows[0].project).toEqual({ id: 'p1', name: '支付' })
    const f = { ...all, kind: 'c_b', project: 'p1' }
    expect(emptyText(builtinModel(ds, tree, f, starred), f)).toBe('没有符合筛选的内容')
  })
  it('下拉：在用的项目按名字排带篇数，项目不在了的照列，最后是不属于项目', () => {
    const m = builtinModel(ds, tree, all, starred)
    expect(projectOptions(m.docs, [{ id: 'p3', title: '增长' }, { id: 'p1', title: '支付' }])).toEqual([
      { value: 'p3', label: '增长', hint: '0 篇' }, { value: 'p1', label: '支付', hint: '1 篇' },
      { value: 'p_gone', label: '旧项目', hint: '1 篇' }, { value: NO_PROJECT, label: '不属于项目', hint: '1 篇' },
    ])
  })
  it('本地目录不按项目筛', () => {
    const dir: LocalDir = { id: 'dir_1', path: '/tmp/d', name: 'd', position: 0, created_at: '', updated_at: '' }
    const list = { path: '/tmp/d', files: [{ rel: 'a.md', path: '/tmp/d/a.md', name: 'a.md', ext: 'md', size: 1, modified: '2026-10-01T00:00:00Z' }], skipped: 0, truncated: false }
    expect(folderModel(dir, list, { ...all, project: 'p1' }).rows).toHaveLength(1)
  })
})
