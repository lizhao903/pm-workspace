import { describe, expect, it } from 'vitest'
import type { ImMaterialSource, ProjectMaterial, WorkObject } from '../../core/data'
import { allTags, dirOf, editDraftOf, editPatch, foldNote, joinPath, matchMaterial, newestFirst, recentDocsAndMaterials, resolvePath, sourceLabel, sourceMessage, splitTags, switchableKinds, valueError } from './materialModel'

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

describe('概览的最近的文档和材料', () => {
  it('文档和材料合在一起按时间倒序取前 5 条，标签是文档类别或材料种类', () => {
    const doc = (id: string, at: string, category_name = '') => ({ id, title: `文档${id}`, category_name, updated_at: at }) as WorkObject
    const docs = [doc('d1', '2026-10-05T00:00:00Z', 'PRD'), doc('d2', '2026-10-01T00:00:00Z')]
    const mats = [1, 2, 3, 4].map((i) => mat({ id: `m${i}`, name: `材料${i}`, kind: i === 1 ? 'link' : 'file', created_at: `2026-10-0${i + 1}T00:00:00Z` }))
    const got = recentDocsAndMaterials(docs, mats)
    expect(got.map((x) => x.title)).toEqual(['文档d1', '材料4', '材料3', '材料2', '材料1'])
    expect(got[0].tag).toBe('PRD')
    expect(got[4].tag).toBe('链接')
    expect(recentDocsAndMaterials([docs[1]], []).map((x) => x.tag)).toEqual(['文档'])
  })
})

describe('来自 IM 消息的出处、长笔记折叠（0009）', () => {
  const src = (p: Partial<ImMaterialSource>): ImMaterialSource => ({
    material_id: 'mt_1', project_id: 'obj_p', kind: 'messages', attachment_id: '', title: '', channel: 'slack', conversation_id: null,
    conversation: '#product', senders: ['林原'], message_ids: ['m1'], first_at: '', last_at: '', created_at: '', ...p,
  })
  it('出处文案：一组写条数，一条写发信人，私聊写和谁；附件照 SPEC-projects-11.16', () => {
    expect(sourceLabel(src({ message_ids: ['m1', 'm2'] }))).toBe('来自 IM 消息：群「#product」 · 2 条')
    expect(sourceLabel(src({ conversation: '' }))).toBe('来自 IM 消息：和 林原 的私聊 · 林原 的一条')
    expect(sourceLabel(src({ conversation: '', senders: ['a', 'b', 'c', 'd'], message_ids: ['m1', 'm2'] }))).toBe('来自 IM 消息：和 a、b、c 等 的私聊 · 2 条')
    expect(sourceLabel(src({ kind: 'attachment', conversation: '' }))).toBe('来自 林原（私聊）的消息')
    expect(sourceLabel(src({ kind: 'attachment' }))).toBe('来自 林原（#product）的消息')
  })
  it('点出处打开最后一条（还在的最新一条）；没有消息时为空', () => {
    expect(sourceMessage(src({ message_ids: ['gone', 'm1', 'm2'] }))).toBe('m2')
    expect(sourceMessage(src({ message_ids: [] }))).toBe('')
  })
  it('超过 9 行的笔记先露 8 行', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `第${i + 1}行`).join('\n')
    expect(foldNote(lines(9))).toBeNull()
    expect(foldNote(lines(12))).toEqual({ head: lines(8), rest: 4 })
  })
})

describe('编辑资料', () => {
  const m = (over: Partial<ProjectMaterial>): ProjectMaterial => ({
    id: 'mt1', project_id: 'p', kind: 'note', name: '名字', value: '正文', category: '', status: '', tags: ['a'], source: 'manual', created_at: '', updated_at: '', ...over,
  })
  it('能换的种类：笔记和链接、文件和文件夹；锁住时只有自己', () => {
    expect(switchableKinds('note')).toEqual(['note', 'link'])
    expect(switchableKinds('folder')).toEqual(['file', 'folder'])
    expect(switchableKinds('file', true)).toEqual(['file'])
  })
  it('按种类校验值：笔记 5000 字（按字数）、链接要 http(s)', () => {
    expect(valueError('note', '字'.repeat(5000))).toBe('')
    expect(valueError('note', '字'.repeat(5001))).toBe('超过 5000 字（现在 5001 字）')
    expect(valueError('note', '𠀀'.repeat(5000))).toBe('')
    expect(valueError('link', 'ftp://x')).toBe('链接要以 http:// 或 https:// 开头')
    expect(valueError('link', 'https://x.com/a')).toBe('')
    expect(valueError('note', '  ')).toBe('内容不能为空')
  })
  it('只带改了的字段；换种类连 value 一起带；路径按项目目录补全', () => {
    const note = m({})
    expect(editPatch(note, editDraftOf(note), '/r')).toEqual({})
    expect(editPatch(note, { ...editDraftOf(note), name: ' 新名字 ', tags: 'a，b' }, '/r')).toEqual({ name: '新名字', tags: ['a', 'b'] })
    expect(editPatch(note, { ...editDraftOf(note), kind: 'link', value: 'https://x.com' }, '/r')).toEqual({ kind: 'link', value: 'https://x.com' })
    expect(editPatch(note, { ...editDraftOf(note), kind: 'link' }, '/r')).toEqual({ error: '链接要以 http:// 或 https:// 开头' })
    const file = m({ kind: 'file', value: '/r/a.md' })
    expect(editPatch(file, { ...editDraftOf(file), value: 'b.md' }, '/r')).toEqual({ value: '/r/b.md' })
    expect(editPatch(file, { ...editDraftOf(file), kind: 'folder' }, '/r')).toEqual({ kind: 'folder', value: '/r/a.md' })
    expect(editPatch(file, { ...editDraftOf(file), value: 'b.md' }, '')).toHaveProperty('error')
  })
})
