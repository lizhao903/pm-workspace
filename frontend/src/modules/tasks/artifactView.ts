// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 产出物查看的纯逻辑（DEV-08b 补，SPEC-tasks-5.40 到 5.44）：哪些条目能在工作台里点开看、看哪种，
// 以及把一次提交的 diff 拆成逐个文件、逐行着色。接口见 docs/api-contract.md「查看产出物」。
import { errorText, isApiError, type Artifact, type ArtifactChangedFile } from '../../core/data'
import type { ParsedNote } from './artifactNote'

export type ArtifactViewKind = 'file' | 'commit' | 'branch'

const GH_COMMIT = /\/commit\/[0-9a-f]{7,64}/i

/**
 * 能在工作台里看的种类；看不了的回 null（照旧走链接或只能复制路径）：
 * - 文件：有本机路径；
 * - 提交：有仓库（备注 repo= 或本机路径）且有 sha（备注 sha= 或 GitHub 提交链接）；
 * - 分支：有仓库且备注里有 branch=；
 * - PR、只有链接的提交和分支：没有本机仓库，照旧打开链接。
 */
export function viewKindOf(a: Artifact, p: ParsedNote): ArtifactViewKind | null {
  const repo = !!(p.repo || a.path)
  switch (p.kind) {
    case 'file': return a.path ? 'file' : null
    case 'commit': return repo && (p.sha || GH_COMMIT.test(a.url)) ? 'commit' : null
    case 'branch': return repo && p.branch ? 'branch' : null
    default: return null
  }
}

/** 查看失败时说清原因：越界 403、仓库取不到 409（repo_unavailable）、不在了 404；后端的 message 写明了是哪一种 */
export function viewErrorText(e: unknown): string {
  if (isApiError(e)) {
    if (e.status === 403) return `不能在工作台里看：${e.message}`
    if (e.status === 409) return `仓库取不到：${e.message}`
    if (e.status === 404) return `找不到：${e.message}`
  }
  return `读取失败：${errorText(e)}`
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx'
export type DiffFile = { path: string; lines: { kind: DiffLineKind; text: string }[] }

/** diff --git a/x b/y 里取新路径；带空格、引号的路径取不准时回退到整行 */
function pathOfHeader(line: string): string {
  const m = /^diff --git "?a\/.*?"? "?b\/(.*?)"?$/.exec(line)
  return m ? m[1] : line.slice('diff --git '.length)
}

function lineKind(l: string, inHeader: boolean): DiffLineKind {
  if (l.startsWith('@@')) return 'hunk'
  if (inHeader) return 'meta'
  if (l.startsWith('+')) return 'add'
  if (l.startsWith('-')) return 'del'
  if (l.startsWith('\\')) return 'meta'
  return 'ctx'
}

/** 把 git show 的 patch 拆成逐个文件；文件头（index、---、+++ 等）到第一个 @@ 之前都算 meta */
export function splitDiff(diff: string): DiffFile[] {
  const out: DiffFile[] = []
  let cur: DiffFile | null = null
  let inHeader = false
  const lines = diff.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  for (const l of lines) {
    if (l.startsWith('diff --git ')) {
      cur = { path: pathOfHeader(l), lines: [{ kind: 'meta', text: l }] }
      out.push(cur)
      inHeader = true
      continue
    }
    if (!cur) continue
    const kind = lineKind(l, inHeader)
    if (kind === 'hunk') inHeader = false
    cur.lines.push({ kind, text: l })
  }
  return out
}

const STATUS_LABEL: Record<string, string> = { A: '新增', M: '修改', D: '删除', R: '改名', C: '复制', T: '类型变了' }
export const fileStatusLabel = (s: string) => STATUS_LABEL[s] ?? s

/** 一个改动文件的增删：二进制写「二进制」 */
export const fileDelta = (f: ArtifactChangedFile) => (f.binary ? '二进制' : `+${f.additions} -${f.deletions}`)

/** 文件大小：B、KB、MB */
export function sizeText(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
