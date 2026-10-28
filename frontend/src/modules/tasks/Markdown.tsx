// 正文和验收标准的 Markdown 预览：只认常用的几种写法（标题、列表、清单、引用、代码块、行内代码、加粗、链接），
// 一律生成 React 元素，不拼 HTML，原文里的标签按文字显示。
import type { ReactNode } from 'react'
import { parseBlocks } from './mdParse'

const RE_INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let at = 0
  for (const m of text.matchAll(RE_INLINE)) {
    if (m.index > at) out.push(text.slice(at, m.index))
    const k = out.length
    if (m[1] !== undefined) out.push(<code key={k}>{m[1]}</code>)
    else if (m[2] !== undefined) out.push(<strong key={k}>{m[2]}</strong>)
    else out.push(<a key={k} href={m[4]} target="_blank" rel="noreferrer">{m[3]}</a>)
    at = m.index + m[0].length
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}

export function Markdown({ source, empty = '没有内容' }: { source: string; empty?: string }) {
  const blocks = parseBlocks(source)
  if (!blocks.length) return <div className="md md-empty">{empty}</div>
  return (
    <div className="md">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'h': {
            const H = (['h3', 'h4', 'h5', 'h6'] as const)[b.level - 1]
            return <H key={i}>{inline(b.text)}</H>
          }
          case 'code':
            return <pre key={i}><code>{b.text}</code></pre>
          case 'quote':
            return <blockquote key={i}>{inline(b.text)}</blockquote>
          case 'list': {
            const L = b.ordered ? 'ol' : 'ul'
            return (
              <L key={i} className={b.items.some((x) => x.check !== undefined) ? 'md-checks' : undefined}>
                {b.items.map((x, j) => (
                  <li key={j}>
                    {x.check !== undefined && <input type="checkbox" checked={x.check} readOnly disabled aria-label={x.check ? '已完成' : '未完成'} />}
                    <span>{inline(x.text)}</span>
                  </li>
                ))}
              </L>
            )
          }
          case 'p':
            return <p key={i}>{inline(b.text)}</p>
        }
      })}
    </div>
  )
}
