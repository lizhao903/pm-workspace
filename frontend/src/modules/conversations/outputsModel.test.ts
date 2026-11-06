import { describe, expect, it } from 'vitest'
import type { Artifact } from '../../core/data'
import { commitSha, groupObjects, groupOutputs } from './outputsModel'

const art = (id: string, over: Partial<Artifact> = {}): Artifact => ({
  id, object_id: null, session_id: null, run_id: null, title: '', path: '/p', base_dir: '', url: '', platform: 'local', size: 0,
  source: 'mcp', note: '', created_at: '', updated_at: '', rel_path: '/p', kind: '', display_kind: 'other', ...over,
})
const commit = (id: string, sha: string, obj: string, repo = 'fullstack') => art(id, {
  title: '第三十七批提交', note: `[commit] sha=${sha} branch=b repo=/r/${repo}`, object_id: 'obj_' + obj, object_ref: 'TSK-' + obj, object_title: '任务 ' + obj,
})

describe('产出结果分组（B-08）', () => {
  it('从备注取提交号', () => {
    expect(commitSha({ note: '[commit] sha=995ce6e branch=x' })).toBe('995ce6e')
    expect(commitSha({ note: '[commit] branch=x' })).toBe('')
  })

  it('同一提交号合并成一行，不同仓库目录也算一次提交；其他的一条一行，顺序按每组最新一条', () => {
    const gs = groupOutputs([
      commit('a1', '995ce6e', '1'),
      art('f1', { title: '周报.md' }),
      commit('a2', '995ce6e', '2', 'frontend'),
      commit('a3', 'abc1234', '3'),
      commit('a4', '995ce6e', '2'),
      art('c0', { note: '[commit] branch=x' }),
    ])
    expect(gs.map((g) => g.key)).toEqual(['commit:995ce6e', 'f1', 'commit:abc1234', 'c0'])
    expect(gs[0].items.map((a) => a.id)).toEqual(['a1', 'a2', 'a4'])
    expect(gs[0].head.id).toBe('a1')
    expect(gs[0].sha).toBe('995ce6e')
    expect(gs[3].sha).toBeUndefined()
    // 涉及的任务按对象去重
    expect(groupObjects(gs[0]).map((o) => o.ref)).toEqual(['TSK-1', 'TSK-2'])
  })

  it('长提交号显示前 7 位', () => {
    expect(groupOutputs([commit('a', '0123456789abcdef', '1')])[0].sha).toBe('0123456')
  })
})
