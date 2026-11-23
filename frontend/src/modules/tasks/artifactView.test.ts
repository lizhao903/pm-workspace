// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { describe, expect, it } from 'vitest'
import type { Artifact } from '../../core/data'
import { parseArtifactNote } from './artifactNote'
import { splitDiff, viewKindOf } from './artifactView'

const a = (p: Partial<Artifact>) => ({ path: '', url: '', note: '', ...p }) as Artifact
const kind = (p: Partial<Artifact>) => viewKindOf(a(p), parseArtifactNote(p.note ?? ''))

describe('viewKindOf', () => {
  it('文件要有本机路径；PR 和只有链接的提交、分支看不了', () => {
    expect(kind({ path: '/r/a.md' })).toBe('file')
    expect(kind({ url: 'https://x/a' })).toBeNull()
    expect(kind({ url: 'https://github.com/a/b/pull/1', note: '[pr] branch=x' })).toBeNull()
    expect(kind({ url: 'https://github.com/a/b/commit/abcdef1', note: '[commit] sha=abcdef1' })).toBeNull()
    expect(kind({ note: '[branch] branch=x' })).toBeNull()
  })
  it('提交要有仓库（repo= 或路径）和 sha（sha= 或 GitHub 提交链接）；分支要有仓库和 branch=', () => {
    expect(kind({ note: '[commit] sha=abcdef1 repo=/r' })).toBe('commit')
    expect(kind({ path: '/r', url: 'https://github.com/a/b/commit/abcdef1', note: '[commit] 修' })).toBe('commit')
    expect(kind({ path: '/r', note: '[commit] 没 sha' })).toBeNull()
    expect(kind({ path: '/r', note: '[branch] branch=feat/x' })).toBe('branch')
    expect(kind({ path: '/r', note: '[branch] 没分支名' })).toBeNull()
  })
})

describe('splitDiff', () => {
  it('按文件拆开，文件头到第一个 @@ 前是 meta，之后按 + - 着色', () => {
    const d = splitDiff([
      'diff --git a/x.go b/x.go', 'index 1..2', '--- a/x.go', '+++ b/x.go', '@@ -1,2 +1,2 @@', ' keep', '-old', '+new',
      'diff --git a/y.md b/y.md', 'new file mode 100644', '@@ -0,0 +1 @@', '+hi', '\\ No newline at end of file', '',
    ].join('\n'))
    expect(d.map((f) => f.path)).toEqual(['x.go', 'y.md'])
    expect(d[0].lines.map((l) => l.kind)).toEqual(['meta', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add'])
    expect(d[1].lines.map((l) => l.kind)).toEqual(['meta', 'meta', 'hunk', 'add', 'meta'])
  })
})
