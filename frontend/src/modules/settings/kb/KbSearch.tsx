// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 检索测试（SPEC-settings-12）：后端按关键词打分（口径同原型 searchKb），列命中的段落，检索词高亮，点标题跳到那一段。
// 示例问题原型是按种子知识库写死的，真实的库没有对应的示例，不显示。
import { useState } from 'react'
import { errorText, useKbSearch, type KnowledgeBase } from '../../../core/data'
import { Button, Input } from '../../../core/ui'
import { docRef, KB_DOC_SOURCE, markParts, plain } from './model'

function Marked({ text, terms }: { text: string; terms: string[] }) {
  return <>{markParts(text, terms).map((p, i) => (i % 2 ? <mark key={i} className="kbx-mark">{p}</mark> : p))}</>
}

export function KbSearch({ kb, onJump }: { kb: KnowledgeBase; onJump: (docId: string, chunk: number) => void }) {
  const [q, setQ] = useState('')
  const [asked, setAsked] = useState('')
  const res = useKbSearch(kb.id, asked)
  const { searchable, docs } = kb.counts
  const out = docs - searchable
  // 同一个问题再点一次也重新检索（中间可能重新索引过）
  const ask = () => {
    const t = q.trim()
    if (t === asked) void res.refetch()
    else setAsked(t)
  }

  return (
    <div className="kbx-search">
      <div className="kbx-search-line">
        <Input value={q} autoFocus aria-label="问题" placeholder="输入一个问题，比如：权限模型月底演示要做到哪一步"
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) ask() }} />
        <Button variant="primary" disabled={!q.trim()} onClick={ask}>检索</Button>
      </div>
      <div className="kb-muted">
        在 {searchable} 篇已索引的文档里找{out > 0 && `，待索引、失败、已排除的 ${out} 篇不参与`}；按问题和每段的词重合度打分，列前 {kb.settings.top} 段
      </div>
      {asked && res.isError && (
        <div className="kbx-alert kbx-alert-bad" role="alert">
          <span><b>检索失败</b>{errorText(res.error)}</span>
          <Button size="sm" onClick={() => void res.refetch()}>重试</Button>
        </div>
      )}
      {asked && res.isPending && <div className="kb-muted">检索中</div>}
      {asked && res.data && (res.data.hits.length ? (
        <ol className="kbx-hits" aria-label="命中的段落">
          {res.data.hits.map((h, i) => {
            const pct = Math.round(h.score * 100)
            return (
              <li key={`${h.doc_id}-${h.index}`} className="kbx-hit">
                <div className="kbx-hit-head">
                  <span className="kbx-rank">{i + 1}</span>
                  <button type="button" className="kb-link ellipsis" onClick={() => onJump(h.doc_id, h.index)} title="打开这篇，定位到这一段">
                    {h.title} · 第 {h.index + 1} 段
                  </button>
                  <span className="spacer" />
                  <span className="kbx-score" title={`命中 ${h.terms.length} 个检索词`}>
                    <span className="kbx-bar"><span style={{ width: `${pct}%` }} /></span>相关度 {pct}%
                  </span>
                </div>
                <div className="kbx-hit-body"><Marked text={plain(h.text)} terms={h.terms} /></div>
                <div className="kbx-hit-src">
                  <span className="tag">{KB_DOC_SOURCE[h.source.type] ?? h.source.type}</span>
                  {docRef(h) && <code className="ellipsis">{docRef(h)}</code>}
                </div>
              </li>
            )
          })}
        </ol>
      ) : <div className="kbx-none">没有命中。换个说法，或者看看相关文档是不是还没索引、被排除了</div>)}
    </div>
  )
}
