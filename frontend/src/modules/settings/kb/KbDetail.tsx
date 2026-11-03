// 知识库详情（SPEC-settings-11.1 到 11.3）：顶栏、标签条，下面是文档、检索测试、设置三个标签。
// 「索引中」：后端在请求里同步索引，请求没回来的那几篇就是正在跑的，记在这一层，文档表和阅读视图共用。
import { useState } from 'react'
import { errorText, useKbDocs, useReindexKb, type KnowledgeBase } from '../../../core/data'
import { Button, cls, PageTitle } from '../../../core/ui'
import { KbDocs } from './KbDocs'
import { KbReader } from './KbReader'
import { KbSearch } from './KbSearch'
import { KbSettingsTab } from './KbSettingsTab'
import { BookIcon } from './parts'

export type KbTab = 'docs' | 'search' | 'settings'
const KB_TABS: { key: KbTab; label: string }[] = [{ key: 'docs', label: '文档' }, { key: 'search', label: '检索测试' }, { key: 'settings', label: '设置' }]

/** 阅读视图：哪一篇、要定位到第几段；at 让同一段再点一次也能重新闪一下 */
type Reading = { id: string; chunk?: number; at: number }

export function KbDetail({ kb, tab, onTab, onBack, editing, onEdit }: {
  kb: KnowledgeBase
  tab: KbTab
  onTab: (t: KbTab) => void
  onBack: () => void
  /** 抽屉正开着改这个知识库 */
  editing: boolean
  onEdit: () => void
}) {
  const docsQ = useKbDocs(kb.id)
  const docs = docsQ.data ?? []
  const reindexM = useReindexKb()
  const [busy, setBusy] = useState<string[]>([])
  const [reading, setReading] = useState<Reading | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const doc = reading ? docs.find((d) => d.id === reading.id) : undefined
  const pending = kb.counts.pending
  const failed = kb.counts.failed

  // 不给 ids 是全部
  const reindex = (ids?: string[]) => {
    const marked = ids ?? docs.map((d) => d.id)
    setError(null)
    setBusy((b) => [...b, ...marked])
    reindexM.mutate({ id: kb.id, docIds: ids }, {
      onError: (e) => setError(`重新索引失败：${errorText(e)}`),
      onSettled: () => setBusy((b) => b.filter((x) => !marked.includes(x))),
    })
  }

  const switchTab = (t: KbTab) => {
    if (t === 'docs') setReading(null)
    onTab(t)
  }

  const actions = tab === 'docs' && !doc ? (
    <>
      <Button variant="outline" disabled={!docs.length || busy.length > 0} onClick={() => reindex()}>全部重新索引</Button>
      <Button variant="primary" onClick={() => setAdding(true)}>加文档</Button>
    </>
  ) : tab === 'settings' ? <Button variant="outline" className={cls(editing && 'kb-btn-on')} onClick={onEdit}>改名称和分类</Button> : null

  return (
    <div className="page kb-page kbx-page">
      <PageTitle icon={<BookIcon />} count={kb.counts.docs} desc={kb.desc || undefined} actions={actions}
        parent={<button type="button" className="kb-parent-btn" onClick={onBack} title="回到知识库列表">知识库</button>}>{kb.name}</PageTitle>
      <button type="button" className="kb-link kbx-mobile-back" onClick={onBack}>返回知识库列表</button>
      <div className="kbx-tabs" role="tablist" aria-label="知识库详情">
        {KB_TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={cls(tab === t.key && 'on')} onClick={() => switchTab(t.key)}>
            {t.label}
            {t.key === 'docs' && (failed > 0
              ? <span className="side-dot" title="有索引失败的文档" />
              : pending > 0 && <span className="kbx-tab-n">{pending} 待索引</span>)}
          </button>
        ))}
      </div>
      {error && <div className="kbx-alert kbx-alert-bad" role="alert">{error}</div>}
      {tab === 'docs' && (docsQ.isError && !docsQ.data ? (
        <div className="kbx-alert kbx-alert-bad" role="alert">
          <span>文档没取到：{errorText(docsQ.error)}</span>
          <Button size="sm" onClick={() => void docsQ.refetch()}>重试</Button>
        </div>
      ) : !docsQ.data ? <div className="kb-muted">加载中</div> : doc ? (
        <KbReader key={doc.id} kb={kb} doc={doc} busy={busy.includes(doc.id)} focus={reading?.chunk} flashAt={reading?.at ?? 0}
          onBack={() => setReading(null)} onReindex={() => reindex([doc.id])} onRemoved={() => setReading(null)} />
      ) : (
        <KbDocs kb={kb} docs={docs} busy={busy} adding={adding} onAdding={setAdding}
          onRead={(id) => setReading({ id, at: Date.now() })} onReindex={reindex} />
      ))}
      {tab === 'search' && (
        <KbSearch kb={kb} onJump={(id, chunk) => { setReading({ id, chunk, at: Date.now() }); onTab('docs') }} />
      )}
      {tab === 'settings' && <KbSettingsTab kb={kb} docs={docs} editing={editing} onEdit={onEdit} onReindex={reindex} />}
    </div>
  )
}
