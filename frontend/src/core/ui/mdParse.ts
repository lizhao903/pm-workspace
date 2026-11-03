// Markdown 的块级解析，只认常用写法，见 Markdown.tsx（DOC-01b 从 tasks 挪来）

export type Block =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; ordered: boolean; items: { text: string; check?: boolean }[] }
  | { kind: 'p'; text: string }

const RE_H = /^(#{1,4})\s+(.*)$/
const RE_LI = /^\s*([-*+]|\d+[.)])\s+(.*)$/
const RE_CHECK = /^\[([ xX])\]\s+(.*)$/

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push({ kind: 'p', text: para.join('\n') })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trimStart().startsWith('```')) {
      flush()
      const buf: string[] = []
      for (i++; i < lines.length && !lines[i].trimStart().startsWith('```'); i++) buf.push(lines[i])
      out.push({ kind: 'code', text: buf.join('\n') })
      continue
    }
    if (!line.trim()) { flush(); continue }
    const h = RE_H.exec(line)
    if (h) { flush(); out.push({ kind: 'h', level: h[1].length, text: h[2] }); continue }
    if (line.startsWith('>')) {
      flush()
      const last = out[out.length - 1]
      const text = line.replace(/^>\s?/, '')
      if (last?.kind === 'quote') last.text += '\n' + text
      else out.push({ kind: 'quote', text })
      continue
    }
    const li = RE_LI.exec(line)
    if (li) {
      flush()
      const ordered = /\d/.test(li[1])
      const c = RE_CHECK.exec(li[2])
      const item = c ? { text: c[2], check: c[1] !== ' ' } : { text: li[2] }
      const last = out[out.length - 1]
      if (last?.kind === 'list' && last.ordered === ordered) last.items.push(item)
      else out.push({ kind: 'list', ordered, items: [item] })
      continue
    }
    para.push(line)
  }
  flush()
  return out
}

export type MdHeading = { id: string; level: number; text: string }

/** 标题导航：第 n 个标题的 id 是 `${prefix}${n}`，和 Markdown 组件 headingIds 给标题加的 id 对得上 */
export function mdHeadings(source: string, prefix = 'h'): MdHeading[] {
  const out: MdHeading[] = []
  for (const b of parseBlocks(source)) if (b.kind === 'h') out.push({ id: `${prefix}${out.length}`, level: b.level, text: b.text })
  return out
}
