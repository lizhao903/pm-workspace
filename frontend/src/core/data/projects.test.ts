import { describe, expect, it } from 'vitest'
import type { WorkObject } from '../api'
import { mergeProjectProps, projectView } from './projects'

const obj = (p: Partial<WorkObject>) => ({
  id: 'obj_1', ref: 'PRJ-0001', type_id: 'project', title: '工作台', body: '', status: 'planning', workdir: '', props: null,
  created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z', ...p,
}) as WorkObject

describe('项目字段', () => {
  it('name、desc、root 来自 title、body、workdir；props 没有的 key 按空值', () => {
    const v = projectView(obj({ title: 'A', body: '说明', workdir: '/tmp/a' }))
    expect(v).toMatchObject({ name: 'A', desc: '说明', root: '/tmp/a', color: '', mark: { text: '' }, related: [] })
  })

  it('props 里的值不可信：类型不对的丢掉，图片必须是 data:image/', () => {
    const v = projectView(obj({ props: { color: 3, mark: { text: '工', icon: 'code', image: 'http://x/y.png' }, related: [{ path: '/a', label: 1 }, 'bad'] } }))
    expect(v.color).toBe('')
    expect(v.mark).toEqual({ text: '工', icon: 'code' })
    expect(v.related).toEqual([{ path: '/a', label: '' }])
  })

  it('合并保存只动给了的 key，别的 props 原样留着', () => {
    const cur = { color: '#3d4fd6', agent_ids: ['ag1'], mark: { text: '', icon: 'folder' } }
    expect(mergeProjectProps(cur, { mark: { text: '工' } })).toEqual({ color: '#3d4fd6', agent_ids: ['ag1'], mark: { text: '工' } })
    expect(mergeProjectProps(null, { related: [{ path: '/a', label: '' }] })).toEqual({ related: [{ path: '/a', label: '' }] })
  })
})
