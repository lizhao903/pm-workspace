import { describe, expect, it } from 'vitest'
import type { WorkObject } from '../api'
import {
  ATTACHMENT_TAG, attachmentAdded, attachmentContentUrl, attachmentHref, attachmentMaterial, needsFetch, skipKey, skippedAttachments,
  type ImAttachmentFile,
} from './attachments'
import type { ProjectMaterial } from './materials'

const file = (over: Partial<ImAttachmentFile> = {}): ImAttachmentFile => ({ id: 'a1', name: '权限点清单 v2.xlsx', kind: 'file', size: 48213, ...over })
const link: ImAttachmentFile = { id: 'a2', name: 'Figma', kind: 'link', url: 'https://www.figma.com/design/roles-v4' }
const mat = (over: Partial<ProjectMaterial>): ProjectMaterial => ({
  id: 'mt1', project_id: 'p1', kind: 'file', name: '', value: '', category: '', status: '', tags: [], source: 'manual', created_at: '', updated_at: '', ...over,
})

describe('附件加进资料', () => {
  it('链接直接加，值是 url，打消息附件标签', () => {
    expect(needsFetch(link)).toBe(false)
    expect(attachmentMaterial(link)).toEqual({ kind: 'link', value: link.url, name: 'Figma', tags: [ATTACHMENT_TAG] })
  })
  it('文件要先获取，获取后值是 local', () => {
    expect(needsFetch(file())).toBe(true)
    expect(needsFetch(file({ fetch: 'error' }))).toBe(true)
    expect(attachmentMaterial(file())).toBeNull()
    const done = file({ fetch: 'done', local: '/d/attachments/slack/权限点清单 v2.xlsx' })
    expect(needsFetch(done)).toBe(false)
    expect(attachmentMaterial(done)).toEqual({ kind: 'file', value: done.local, name: done.name, tags: [ATTACHMENT_TAG] })
  })
  it('已加入按种类和 value 认，没获取的文件不算', () => {
    const rows = [mat({ kind: 'file', value: '/d/attachments/slack/a.pdf' }), mat({ kind: 'link', value: link.url })]
    expect(attachmentAdded(rows, link)).toBe(true)
    expect(attachmentAdded(rows, file({ fetch: 'done', local: '/d/attachments/slack/a.pdf' }))).toBe(true)
    expect(attachmentAdded(rows, file({ fetch: 'done', local: '/d/attachments/slack/b.pdf' }))).toBe(false)
    expect(attachmentAdded(rows, file())).toBe(false)
    expect(attachmentAdded(undefined, link)).toBe(false)
  })
})

describe('读内容的地址', () => {
  it('获取过的文件用 download_url，链接用 url，没获取的没有', () => {
    expect(attachmentHref(file({ fetch: 'done', local: '/x', download_url: '/api/im/attachments/slack/a.pdf' }))).toBe('/api/im/attachments/slack/a.pdf')
    expect(attachmentHref(file())).toBeNull()
    expect(attachmentHref(link)).toBe(link.url)
  })
  it('资料的 value 在附件目录下时用最后两段拼', () => {
    expect(attachmentContentUrl('/d/attachments/slack/权限 v2.xlsx', '/d/attachments/')).toBe(`/api/im/attachments/slack/${encodeURIComponent('权限 v2.xlsx')}`)
    expect(attachmentContentUrl('/d/attachments/slack/sub/a.pdf', '/d/attachments')).toBeNull()
    expect(attachmentContentUrl('/other/a.pdf', '/d/attachments')).toBeNull()
    expect(attachmentContentUrl('/d/attachments/slack/a.pdf', '')).toBeNull()
  })
})

describe('不加入的记录', () => {
  it('键是消息 id 加附件 id；props 里不是字符串数组的按空', () => {
    expect(skipKey('msg_1', 'att_1')).toBe('msg_1:att_1')
    const o = (props: Record<string, unknown> | null) => ({ props }) as WorkObject
    expect(skippedAttachments(o({ skipped_attachments: ['msg_1:att_1', 3] }))).toEqual(['msg_1:att_1'])
    expect(skippedAttachments(o({ skipped_attachments: 'x' }))).toEqual([])
    expect(skippedAttachments(o(null))).toEqual([])
    expect(skippedAttachments(undefined)).toEqual([])
  })
})
