import { describe, expect, it } from 'vitest'
import type { Artifact } from '../../core/data'
import { groupArtifacts, locationOf, parseArtifactNote, shortSha } from './artifactNote'

describe('parseArtifactNote', () => {
  it('提交：sha、branch、repo 和余下的备注', () => {
    expect(parseArtifactNote('[commit] sha=a1b2c3d4e5f6 branch=feat/x repo=/abs/path  修好了排序')).toEqual({
      kind: 'commit', sha: 'a1b2c3d4e5f6', branch: 'feat/x', repo: '/abs/path', text: '修好了排序',
    })
  })

  it('分支和 PR', () => {
    expect(parseArtifactNote('[branch] branch=feat/x repo=/r')).toEqual({ kind: 'branch', branch: 'feat/x', repo: '/r', text: '' })
    expect(parseArtifactNote('[pr] branch=feat/x 第二版')).toEqual({ kind: 'pr', branch: 'feat/x', text: '第二版' })
  })

  it('没有前缀的算文件，备注原样', () => {
    expect(parseArtifactNote('v2，已评审')).toEqual({ kind: 'file', text: 'v2，已评审' })
    expect(parseArtifactNote('')).toEqual({ kind: 'file', text: '' })
  })

  it('前缀不在开头、不认识的种类、大小写不对都算文件', () => {
    expect(parseArtifactNote('见 [commit] sha=abc').kind).toBe('file')
    expect(parseArtifactNote('[tag] v1.0').kind).toBe('file')
    expect(parseArtifactNote('[Commit] sha=abc').kind).toBe('file')
  })

  it('key=value 缺项：没给的就是 undefined', () => {
    const p = parseArtifactNote('[commit] branch=main')
    expect(p).toEqual({ kind: 'commit', branch: 'main', text: '' })
    expect(p.sha).toBeUndefined()
    expect(parseArtifactNote('[commit]')).toEqual({ kind: 'commit', text: '' })
  })

  it('空值当作没给', () => {
    expect(parseArtifactNote('[commit] sha= branch=main')).toEqual({ kind: 'commit', branch: 'main', text: '' })
  })

  it('多余空格：前后、键值之间、前缀后面没空格', () => {
    expect(parseArtifactNote('  [commit]   sha=abc1234    branch=dev   说明  ')).toEqual({
      kind: 'commit', sha: 'abc1234', branch: 'dev', text: '说明',
    })
    expect(parseArtifactNote('[branch]branch=x')).toEqual({ kind: 'branch', branch: 'x', text: '' })
  })

  it('不认识的 key 到此为止，后面都算备注', () => {
    expect(parseArtifactNote('[commit] sha=abc foo=bar branch=x')).toEqual({ kind: 'commit', sha: 'abc', text: 'foo=bar branch=x' })
  })
})

describe('shortSha', () => {
  it('取前 7 位', () => {
    expect(shortSha('a1b2c3d4e5f6')).toBe('a1b2c3d')
    expect(shortSha('abc')).toBe('abc')
  })
})

describe('groupArtifacts', () => {
  const art = (id: string, note: string) => ({ id, note }) as Artifact
  it('按提交、分支、PR、文件排，空组不出现，组内保持原顺序', () => {
    const g = groupArtifacts([art('1', 'x'), art('2', '[pr] branch=a'), art('3', '[commit] sha=b'), art('4', '[commit] sha=c')])
    expect(g.map((x) => x.key)).toEqual(['commit', 'pr', 'file'])
    expect(g[0].items.map((x) => x.a.id)).toEqual(['3', '4'])
  })
})

describe('locationOf', () => {
  it('链接、绝对路径、不合法', () => {
    expect(locationOf(' https://github.com/a/b/pull/1 ')).toEqual({ url: 'https://github.com/a/b/pull/1' })
    expect(locationOf('/Users/x/a.md')).toEqual({ path: '/Users/x/a.md' })
    expect(locationOf('docs/a.md')).toBeNull()
    expect(locationOf('')).toBeNull()
  })
})
