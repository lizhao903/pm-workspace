// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 知识库列表（SPEC-settings-10）：卡片网格，篇数和状态读后端算好的 counts；按文档标题搜时才去取各库的文档。
import { useState } from 'react'
import { useKbDocsOf, type KnowledgeBase } from '../../../core/data'
import { Button, cls, EmptyState, PageTitle, Pill } from '../../../core/ui'
import { ago, hit, kbState } from './model'
import { AgentHeads, BookIcon, KbSearchBox, SourceTags } from './parts'

export const KB_DESC = '一组可检索的资料：工作台文档、本地目录文件、上传的文件、网页和笔记；挂到 Agent 上，回答和写作时先在这里找依据'

export function KbList({ kbs, selected, missing, onOpen, onNew }: {
  kbs: KnowledgeBase[]
  /** 抽屉打开的那一个，卡片高亮 */
  selected: string | null
  /** 地址里的知识库已经不在了 */
  missing?: boolean
  onOpen: (id: string) => void
  onNew: () => void
}) {
  const [q, setQ] = useState('')
  const kw = q.trim()
  // 名称、说明之外也按文档标题搜：有关键词才取各库的文档
  const docsOf = useKbDocsOf(kbs.map((k) => k.id), !!kw)
  const rows = kbs.map((k) => {
    const own = hit(`${k.name} ${k.desc}`, kw)
    const matched = kw && !own ? (docsOf[k.id] ?? []).filter((d) => hit(d.title, kw)) : []
    return { k, ok: own || matched.length > 0, matched }
  }).filter((x) => x.ok)

  return (
    <div className="page kb-page">
      <PageTitle parent="设置" count={kbs.length} desc={KB_DESC}
        actions={<Button variant="primary" onClick={onNew}>新建知识库</Button>}>知识库</PageTitle>
      {missing && <div className="kbx-alert kbx-alert-info" role="status">要打开的知识库已经不在了，可能刚被删除</div>}
      {kbs.length > 0 && (
        <div className="kb-toolbar">
          <KbSearchBox value={q} onChange={setQ} placeholder="搜知识库名称、说明、里面的文档标题" />
          {kw && <span className="kb-muted">命中 {rows.length} 个</span>}
        </div>
      )}
      {!kbs.length && <EmptyState title="还没有知识库" desc="点右上角「新建知识库」，选文档分类或本地目录当来源" />}
      {kbs.length > 0 && !rows.length && <EmptyState title="没有匹配的知识库" desc="换个关键词试试" />}
      <div className="kb-grid">
        {rows.map(({ k, matched }) => {
          const st = kbState(k.counts)
          return (
            <button key={k.id} type="button" className={cls('kb-card', selected === k.id && 'sel')} data-kb={k.id} onClick={() => onOpen(k.id)}>
              <div className="kb-card-head">
                <BookIcon />
                <span className="kb-name ellipsis" title={k.name}>{k.name}</span>
                <Pill label={st.label} color={st.color} />
              </div>
              <div className="kb-muted kb-desc">{k.desc || '没有说明'}</div>
              <SourceTags ids={k.sources} />
              {matched.length > 0 && <div className="kbx-matched ellipsis">命中文档：{matched.map((d) => d.title).join('、')}</div>}
              <div className="kbx-counts">
                <span><b>{k.counts.docs}</b> 篇</span>
                <span className={cls(k.counts.pending > 0 && 'kbx-warn')}><b>{k.counts.pending}</b> 待索引</span>
                <span className={cls(k.counts.failed > 0 && 'kbx-bad')}><b>{k.counts.failed}</b> 失败</span>
              </div>
              <div className="kb-foot">
                <span>{ago(k.counts.last_doc_at ?? k.updated_at)}更新</span>
                <span className="spacer" />
                <AgentHeads list={k.agents} />
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
