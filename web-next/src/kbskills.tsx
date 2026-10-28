import { useEffect, useMemo, useRef, useState } from 'react'
import { ABILITIES, type Agent, type KnowledgeBase, type Skill } from './agentdata'
import { seedContent, type ContentItem } from './data'
import { defaultSettings, embedOptions, inDir, kbStore, KB_DOC_SOURCE, KB_DOC_STATUS, searchKb, splitChunks, useKbStore, type Chunk, type KbDoc, type KbSettings } from './kbdata'
import { seedProviders, type Provider } from './modeldata'
import './kb.css'
import { AgentAvatar } from './agents'
import { SearchSelect } from './searchselect'
import { useEnumView, type EnumView } from './enumdata'
import { PageTitle } from './topbar'
import { cls, timeAgo } from './ui'
import { newId } from './ids'

// 设置 > 知识库、技能。两样都能挂到 Agent 上；这里是集中管理的地方

/** 能被检索的一篇资料：工作台文档或本地目录里的文件 */
export interface SearchDoc { id: string; title: string; body: string; source: string }

// 分类的显示名读「文档分类」枚举；本地目录不算来源，挂在知识库设置的 dirs 里
const sourceLabel = (e: EnumView, k: string) => e.label(k)
const usedBy = (agents: Agent[], f: (a: Agent) => boolean) => agents.filter(f)
/** 卡片、列表里的头像：露前几个，其余收成 +N，全名在 title 里 */
const AVATARS = 5
const Users = ({ list }: { list: Agent[] }) => (
  <span className="kb-users" title={list.length > AVATARS ? list.map((a) => a.name).join('、') : undefined}>
    {list.length ? list.slice(0, AVATARS).map((a) => <span key={a.id} title={a.name}><AgentAvatar agent={a} size={20} /></span>) : <span className="list-sub">没有 Agent 在用</span>}
    {list.length > AVATARS && <span className="kb-users-more">+{list.length - AVATARS}</span>}
  </span>
)
/** 抽屉里的「在用的 Agent」：名字 chip，多了先露几个 */
const CHIPS = 8
function UserChips({ list }: { list: Agent[] }) {
  const [all, setAll] = useState(false)
  return (
    <div className="kb-user-list">
      {(all ? list : list.slice(0, CHIPS)).map((a) => <span key={a.id} className="tag kb-user" title={a.name}><AgentAvatar agent={a} size={16} /><span className="kb-user-name">{a.name}</span></span>)}
      {list.length > CHIPS && <button className="link-btn" onClick={() => setAll(!all)}>{all ? '收起' : `还有 ${list.length - CHIPS} 个`}</button>}
    </div>
  )
}
/** 删除确认里点名：最多列三个 */
const names = (list: Agent[]) => (list.length > 3 ? `${list.slice(0, 3).map((a) => a.name).join('、')} 等 ${list.length} 个 Agent` : list.map((a) => a.name).join('、'))
const SearchBox = ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) => (
  <div className="search">
    <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
    <input placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
  </div>
)
const hit = (hay: string, q: string) => { const h = hay.toLowerCase(); return q.trim().toLowerCase().split(/\s+/).filter(Boolean).every((w) => h.includes(w)) }

const Pill = ({ label, color }: { label: string; color: string }) => <span className="pill" style={{ '--c': color } as React.CSSProperties}><span className="pill-dot" />{label}</span>

/** 简单的关键词检索：问题拆成词，标题命中算 3 分、正文命中算 1 分 */
export function searchDocs(docs: SearchDoc[], q: string, top = 5) {
  const words = q.split(/[\s，。,.？?、：:！!]+/).filter((w) => w.length >= 2)
  const hits = docs.map((d) => {
    const score = words.reduce((n, w) => n + (d.title.includes(w) ? 3 : 0) + (d.body.includes(w) ? 1 : 0), 0)
    const at = words.map((w) => d.body.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0
    return { d, score, snippet: d.body.replace(/[#>*`-]/g, '').slice(Math.max(0, at - 20), at + 70).replace(/\s+/g, ' ') }
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score)
  return hits.slice(0, top)
}

/* ---------- 知识库 ---------- */

/** 知识库整体的状态：有失败先报失败，其次待索引 */
const kbState = (docs: KbDoc[]) => {
  const failed = docs.filter((d) => d.status === 'failed').length
  const pending = docs.filter((d) => d.status === 'pending').length
  if (failed) return { label: `${failed} 篇失败`, color: KB_DOC_STATUS.failed.color }
  if (pending) return { label: `${pending} 篇待索引`, color: KB_DOC_STATUS.pending.color }
  return { label: '已索引', color: KB_DOC_STATUS.indexed.color }
}
const latest = (docs: KbDoc[], fallback: string) => docs.reduce((m, d) => (d.updated_at > m ? d.updated_at : m), fallback)
/** 待索引里正在跑的显示成「索引中」 */
const statusPill = (d: KbDoc, busy: string[]) => (d.status === 'pending' && busy.includes(d.id) ? { label: '索引中', color: '#3d4fd6' } : KB_DOC_STATUS[d.status])
const docRef = (d: KbDoc) => (d.source.type === 'library' ? '' : d.source.ref ?? '')
const BookIcon = () => <span className="mount-icon kb-icon"><svg viewBox="0 0 16 16" width="13" height="13"><path d="M3 3.5h4.5v9H3zM8.5 3.5H13v9H8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg></span>

export function KnowledgePage({ kbs, agents, selected, onOpen, onNew, content = seedContent, providers = seedProviders, onOpenAgent }: {
  kbs: KnowledgeBase[]; agents: Agent[]
  /** 旧的按来源现算资料的入口，现在篇数由 kbdata 的文档列表算，不再用 */
  docsOf?: (kb: KnowledgeBase) => SearchDoc[]
  selected: string | null
  /** 打开知识库的编辑抽屉（名称、说明、来源分类、删除） */
  onOpen: (id: string) => void
  onNew: () => void
  /** 「文档」模块的全部文档，加文档时从这里挑；不传用种子数据 */
  content?: ContentItem[]
  /** 模型服务商，向量化模型从这里选；不传用种子数据 */
  providers?: Provider[]
  /** 点挂着这个知识库的 Agent，跳到它的配置 */
  onOpenAgent?: (id: string) => void
}) {
  const [open, setOpen] = useState<string | null>(null)
  const kb = open ? kbs.find((k) => k.id === open) : undefined
  if (kb) return <KbDetail key={kb.id} kb={kb} agents={agents} content={content} providers={providers} editing={selected === kb.id} onBack={() => setOpen(null)} onEdit={() => onOpen(kb.id)} onOpenAgent={onOpenAgent} />
  return <KbList kbs={kbs} agents={agents} selected={selected} onOpen={setOpen} onNew={onNew} />
}

function KbList({ kbs, agents, selected, onOpen, onNew }: { kbs: KnowledgeBase[]; agents: Agent[]; selected: string | null; onOpen: (id: string) => void; onNew: () => void }) {
  const catEnum = useEnumView('content_category')
  const { docs: all } = useKbStore()
  const [q, setQ] = useState('')
  const docsOf = (id: string) => all.filter((d) => d.kb_id === id)
  // 名称、说明之外，也按里面文档的标题搜
  const rows = kbs.map((k) => {
    const docs = docsOf(k.id)
    const own = hit(`${k.name} ${k.desc}`, q)
    const matched = q.trim() && !own ? docs.filter((d) => hit(d.title, q)) : []
    return { k, docs, ok: own || matched.length > 0, matched }
  }).filter((x) => x.ok)
  return (
    <div className="page page-fill">
      <PageTitle parent="设置" count={kbs.length} desc="一组可检索的资料：工作台文档、本地目录文件、上传的文件、网页和笔记；挂到 Agent 上，回答和写作时先在这里找依据"
        actions={<button className="btn btn-primary" onClick={onNew}>新建知识库</button>}>知识库</PageTitle>
      <div className="toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="搜知识库名称、说明、里面的文档标题" />
        {q.trim() && <span className="list-sub">命中 {rows.length} 个</span>}
      </div>
      {!rows.length && <div className="empty"><div className="empty-title">{kbs.length ? '没有匹配的知识库' : '还没有知识库'}</div><div className="list-sub">{kbs.length ? '换个关键词试试' : '点右上角「新建知识库」，选文档分类当来源；本地目录、文件在详情里加'}</div></div>}
      <div className="kb-grid">
        {rows.map(({ k, docs, matched }) => {
          const users = usedBy(agents, (a) => a.kbs.includes(k.id))
          const pending = docs.filter((d) => d.status === 'pending').length
          const failed = docs.filter((d) => d.status === 'failed').length
          return (
            <button key={k.id} className={cls('kb-card', selected === k.id && 'sel')} onClick={() => onOpen(k.id)}>
              <div className="kb-card-head">
                <BookIcon />
                <span className="kb-name ellipsis">{k.name}</span>
                <Pill {...kbState(docs)} />
              </div>
              <div className="list-sub kb-desc">{k.desc || '没有说明'}</div>
              <div className="kb-sources">{k.sources.map((s) => <span key={s} className="tag">{sourceLabel(catEnum, s)}</span>)}</div>
              {matched.length > 0 && <div className="kbx-matched ellipsis">命中文档：{matched.map((d) => d.title).join('、')}</div>}
              <div className="kbx-counts">
                <span><b>{docs.length}</b> 篇</span>
                <span className={cls(pending > 0 && 'kbx-warn')}><b>{pending}</b> 待索引</span>
                <span className={cls(failed > 0 && 'kbx-bad')}><b>{failed}</b> 失败</span>
              </div>
              <div className="kb-foot">
                <span>{timeAgo(latest(docs, k.updated_at))}更新</span>
                <span className="spacer" />
                <Users list={users} />
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

type KbTab = 'docs' | 'search' | 'settings'
const KB_TABS: { key: KbTab; label: string }[] = [{ key: 'docs', label: '文档' }, { key: 'search', label: '检索测试' }, { key: 'settings', label: '设置' }]

function KbDetail({ kb, agents, content, providers, editing, onBack, onEdit, onOpenAgent }: {
  kb: KnowledgeBase; agents: Agent[]; content: ContentItem[]; providers: Provider[]; editing: boolean
  onBack: () => void; onEdit: () => void; onOpenAgent?: (id: string) => void
}) {
  const { docs: all, settings, busy } = useKbStore()
  const s = settings.find((x) => x.kb_id === kb.id) ?? defaultSettings(kb.id)
  const docs = useMemo(() => all.filter((d) => d.kb_id === kb.id), [all, kb.id])
  const [tab, setTab] = useState<KbTab>('docs')
  // 阅读视图：哪一篇、要定位到第几段；at 用来让同一段再点一次也能重新闪一下
  const [reading, setReading] = useState<{ id: string; chunk?: number; at: number } | null>(null)
  const [adding, setAdding] = useState(false)
  const reindex = (ids: string[]) => kbStore.reindex(ids, providers)
  const doc = reading ? docs.find((d) => d.id === reading.id) : undefined
  const pending = docs.filter((d) => d.status === 'pending').length

  const actions = tab === 'docs' && !doc ? (
    <>
      <button className="btn btn-outline" disabled={!docs.length} onClick={() => reindex(docs.map((d) => d.id))}>全部重新索引</button>
      <button className="btn btn-primary" onClick={() => setAdding(true)}>加文档</button>
    </>
  ) : tab === 'settings' ? <button className="btn btn-outline" onClick={onEdit}>改名称和分类</button> : null

  return (
    <div className="page page-fill kbx-page">
      <PageTitle parent={<button className="tb-parent-btn" onClick={onBack} title="回到知识库列表">知识库</button>} count={docs.length} desc={kb.desc} actions={actions} icon={<BookIcon />}>{kb.name}</PageTitle>
      <button className="link-btn kbx-mobile-back" onClick={onBack}>返回知识库列表</button>
      <div className="project-tabs np-tabs">
        {KB_TABS.map((t) => (
          <button key={t.key} className={cls(tab === t.key && 'on')} onClick={() => { setTab(t.key); if (t.key === 'docs') setReading(null) }}>
            {t.label}
            {t.key === 'docs' && (docs.some((d) => d.status === 'failed') ? <span className="side-dot" title="有索引失败的文档" /> : pending > 0 && <span className="seg-n">{pending} 待索引</span>)}
          </button>
        ))}
      </div>
      {tab === 'docs' && (doc
        ? <KbReader key={doc.id} doc={doc} busy={busy.includes(doc.id)} settings={s} focus={reading?.chunk} flashAt={reading?.at ?? 0} onBack={() => setReading(null)} onReindex={() => reindex([doc.id])} onRemove={() => { kbStore.removeDoc(doc.id); setReading(null) }} />
        : <KbDocs kb={kb} docs={docs} busy={busy} settings={s} content={content} adding={adding} onAdding={setAdding} onRead={(id) => setReading({ id, at: Date.now() })} onReindex={reindex} />)}
      {tab === 'search' && <KbSearch kb={kb} docs={docs} settings={s} onJump={(id, chunk) => { setTab('docs'); setReading({ id, chunk, at: Date.now() }) }} />}
      {tab === 'settings' && <KbSettingsTab kb={kb} docs={docs} settings={s} agents={agents} providers={providers} editing={editing} onEdit={onEdit} onReindex={reindex} onOpenAgent={onOpenAgent} />}
    </div>
  )
}

/* ---------- 文档列表 ---------- */

type DocFilter = '' | 'pending' | 'failed' | 'excluded'
type AddKind = 'library' | 'upload' | 'link' | 'note'
const ADD_KINDS: { key: AddKind; label: string }[] = [{ key: 'library', label: '从「文档」挑' }, { key: 'upload', label: '上传文件' }, { key: 'link', label: '网页链接' }, { key: 'note', label: '写笔记' }]
const TEXT_FILE = /\.(md|markdown|txt|csv)$/i

function KbDocs({ kb, docs, busy, settings, content, adding, onAdding, onRead, onReindex }: {
  kb: KnowledgeBase; docs: KbDoc[]; busy: string[]; settings: KbSettings; content: ContentItem[]; adding: boolean
  onAdding: (v: boolean) => void; onRead: (id: string) => void; onReindex: (ids: string[]) => void
}) {
  const catEnum = useEnumView('content_category')
  const [filter, setFilter] = useState<DocFilter>('')
  const [q, setQ] = useState('')
  const [confirmRm, setConfirmRm] = useState<string | null>(null)
  const count = (f: DocFilter) => docs.filter((d) => (f === 'excluded' ? d.excluded : !f || d.status === f)).length
  const rows = docs.filter((d) => (filter === 'excluded' ? d.excluded : !filter || d.status === filter) && hit(`${d.title} ${docRef(d)} ${d.text}`, q))
  const inLib = new Set(docs.filter((d) => d.source.type === 'library').map((d) => d.source.ref))
  // 自动同步开着时，来源分类里新出现、还没收进来的文档
  const missing = settings.auto_sync ? content.filter((c) => kb.sources.includes(c.category) && !inLib.has(c.id)) : []
  const searchable = docs.filter((d) => d.status === 'indexed' && !d.excluded)
  const addLib = (ids: string[]) => {
    const picked = content.filter((c) => ids.includes(c.id))
    onReindex(kbStore.addDocs(picked.map((c) => ({ kb_id: kb.id, title: c.title, source: { type: 'library', ref: c.id }, text: c.body }))))
  }
  return (
    <>
      {adding && <KbAddForm kb={kb} content={content} inLib={inLib} onLib={addLib} onClose={() => onAdding(false)} onAdded={onReindex} />}
      {missing.length > 0 && (
        <div className="detail-alert detail-info">
          <span><b>来源分类里有 {missing.length} 篇还没收进来</b>{missing.slice(0, 3).map((c) => c.title).join('、')}{missing.length > 3 ? ` 等` : ''}</span>
          <button className="act" onClick={() => addLib(missing.map((c) => c.id))}>收进来</button>
        </div>
      )}
      <div className="toolbar">
        <div className="seg">
          {([['', '全部'], ['pending', '待索引'], ['failed', '失败'], ['excluded', '已排除']] as const).map(([k, l]) => <button key={k} className={cls(filter === k && 'on')} onClick={() => setFilter(k)}>{l}<span className="seg-n">{count(k)}</span></button>)}
        </div>
        <SearchBox value={q} onChange={setQ} placeholder="搜标题、路径、正文" />
        <span className="spacer" />
        <span className="list-sub">参与检索 {searchable.length} 篇 · {searchable.reduce((n, d) => n + d.chunks, 0)} 段</span>
      </div>
      {!docs.length && !adding && <div className="empty"><div className="empty-title">知识库里还没有文档</div><div className="list-sub">从「文档」里挑、上传文件、填网址，或者直接写一篇笔记</div><button className="btn btn-primary" onClick={() => onAdding(true)}>加文档</button></div>}
      {docs.length > 0 && !rows.length && <div className="empty"><div className="empty-title">没有匹配的文档</div><div className="list-sub">换个筛选或关键词试试</div></div>}
      {rows.length > 0 && (
        <div className="task-table">
          <div className="kbx-row task-th"><span>文档</span><span>来源</span><span>段数</span><span>状态</span><span>更新</span><span /></div>
          {rows.map((d) => (
            <div key={d.id} className={cls('kbx-row', d.excluded && 'kbx-off')}>
              <span className="kbx-main">
                <button className="kbx-title ellipsis" onClick={() => onRead(d.id)} title={d.title}>{d.title}</button>
                {d.status === 'failed' && d.error ? <span className="kbx-err">{d.error}</span>
                  : <span className="kbx-ref ellipsis" title={docRef(d) || undefined}>{d.source.type === 'library' ? `分类：${catEnum.label(content.find((c) => c.id === d.source.ref)?.category ?? '')}` : docRef(d) || `${d.text.length} 字`}</span>}
              </span>
              <span><span className="tag">{KB_DOC_SOURCE[d.source.type]}</span></span>
              <span className="run-muted">{d.status === 'failed' ? '-' : d.chunks}</span>
              <span className="kbx-state">
                <Pill {...statusPill(d, busy)} />
                {d.excluded && <span className="tag">已排除</span>}
              </span>
              <span className="run-muted">{timeAgo(d.updated_at)}</span>
              <span className="kbx-ops">
                {confirmRm === d.id ? (
                  <>
                    <button className="act act-danger" onClick={() => { kbStore.removeDoc(d.id); setConfirmRm(null) }}>确认移除</button>
                    <button className="act act-quiet" onClick={() => setConfirmRm(null)}>取消</button>
                  </>
                ) : (
                  <>
                    <button className="act act-quiet" disabled={busy.includes(d.id)} onClick={() => onReindex([d.id])}>{busy.includes(d.id) ? '索引中' : d.status === 'pending' ? '开始索引' : '重新索引'}</button>
                    <button className="act act-quiet" title={d.excluded ? '恢复后重新参与检索' : '资料留着，暂时不参与检索'} onClick={() => kbStore.patchDoc(d.id, { excluded: !d.excluded })}>{d.excluded ? '恢复' : '排除'}</button>
                    <button className="act act-quiet" onClick={() => setConfirmRm(d.id)}>移除</button>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function KbAddForm({ kb, content, inLib, onLib, onClose, onAdded }: {
  kb: KnowledgeBase; content: ContentItem[]; inLib: Set<string | undefined>
  onLib: (ids: string[]) => void; onClose: () => void; onAdded: (ids: string[]) => void
}) {
  const catEnum = useEnumView('content_category')
  const [kind, setKind] = useState<AddKind>('library')
  const [picked, setPicked] = useState<string[]>([])
  const [files, setFiles] = useState<File[]>([])
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [tried, setTried] = useState(false)
  const badUrl = !/^https?:\/\/\S+\.\S+/.test(url.trim())
  const options = useMemo(() => [...content].sort((a, b) => a.category.localeCompare(b.category)).map((c) => ({
    value: c.id, label: c.title, group: catEnum.label(c.category), keywords: c.tags.join(' '), hint: inLib.has(c.id) ? '已在库里' : undefined, disabled: inLib.has(c.id),
  })), [content, catEnum, inLib])
  const switchKind = (k: AddKind) => { setKind(k); setTried(false); setTitle(''); setText('') }
  const add = async () => {
    setTried(true)
    if (kind === 'library') { if (!picked.length) return; onLib(picked) }
    if (kind === 'upload') {
      if (!files.length) return
      // 文本类文件直接读出正文；其他格式先收进来，索引时再报原因
      const read = await Promise.all(files.map(async (f) => ({ kb_id: kb.id, title: f.name, source: { type: 'upload' as const, ref: f.name }, text: TEXT_FILE.test(f.name) ? await f.text() : '' })))
      onAdded(kbStore.addDocs(read))
    }
    if (kind === 'link') {
      if (badUrl) return
      const u = url.trim()
      onAdded(kbStore.addDocs([{ kb_id: kb.id, title: title.trim() || u.replace(/^https?:\/\//, ''), source: { type: 'link', ref: u }, text: text.trim() || `${title.trim() || u}\n${u}` }]))
    }
    if (kind === 'note') {
      if (!title.trim() || !text.trim()) return
      onAdded(kbStore.addDocs([{ kb_id: kb.id, title: title.trim(), source: { type: 'note' }, text: text.trim() }]))
    }
    onClose()
  }
  return (
    <div className="inline-form kbx-add">
      <div className="seg seg-sm">{ADD_KINDS.map((k) => <button key={k.key} className={cls(kind === k.key && 'on')} onClick={() => switchKind(k.key)}>{k.label}</button>)}</div>
      {kind === 'library' && (
        <>
          <SearchSelect multiple variant="field" value={picked} onChange={setPicked} placeholder="选一篇或几篇文档" searchPlaceholder="搜文档标题、标签"
            options={options} emptyText="「文档」里还没有文档" missingLabel={() => '已删除的文档'} />
          {tried && !picked.length && <span className="field-err">至少选一篇</span>}
        </>
      )}
      {kind === 'upload' && (
        <>
          <div className="act-row">
            <label className="act">选文件<input type="file" multiple hidden accept=".md,.markdown,.txt,.csv,.pdf,.docx" onChange={(e) => setFiles([...(e.target.files ?? [])])} /></label>
            <span className="field-hint-line">{files.length ? files.map((f) => f.name).join('、') : '支持 .md、.txt、.csv，.pdf 和 .docx 要带可提取的文字'}</span>
          </div>
          {tried && !files.length && <span className="field-err">先选文件</span>}
        </>
      )}
      {kind === 'link' && (
        <>
          <input className={cls('mono', tried && badUrl && 'bad')} value={url} placeholder="https://..." onChange={(e) => setUrl(e.target.value)} />
          <input value={title} placeholder="标题（留空用网址）" onChange={(e) => setTitle(e.target.value)} />
          <textarea rows={3} value={text} placeholder="正文摘录（可选）：要登录才能看的页面抓不到正文，把关键段落贴在这里" onChange={(e) => setText(e.target.value)} />
          {tried && badUrl && <span className="field-err">填一个 http 或 https 开头的网址</span>}
        </>
      )}
      {kind === 'note' && (
        <>
          <input value={title} className={cls(tried && !title.trim() && 'bad')} placeholder="标题，比如：远川演示前要确认的事" onChange={(e) => setTitle(e.target.value)} />
          <textarea rows={5} value={text} className={cls(tried && !text.trim() && 'bad')} placeholder="直接写；保存后会切段、索引" onChange={(e) => setText(e.target.value)} />
          {tried && (!title.trim() || !text.trim()) && <span className="field-err">标题和正文都要填</span>}
        </>
      )}
      <div className="act-row">
        <button className="act act-primary" onClick={add}>加进知识库</button>
        <button className="act act-quiet" onClick={onClose}>取消</button>
      </div>
    </div>
  )
}

/* ---------- 阅读视图 ---------- */

/** 命中片段里去掉 Markdown 记号，换行压成空格 */
const plain = (x: string) => x.replace(/```/g, '').replace(/^\s*(#+|>|-|\d+\.)\s*/gm, '').replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim()
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function Marked({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>
  const parts = text.split(new RegExp(`(${terms.map(esc).join('|')})`, 'gi'))
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i} className="kbx-mark">{p}</mark> : p))}</>
}

/** 全文按段显示：每段前面标第几段；和下一段重叠的那几个字单独标出来 */
function ChunkedText({ text, chunks, focus, flashAt }: { text: string; chunks: Chunk[]; focus?: number; flashAt: number }) {
  const refs = useRef<(HTMLDivElement | null)[]>([])
  useEffect(() => {
    if (focus === undefined) return
    refs.current[focus]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focus, flashAt])
  return (
    <div className="kbx-text">
      {chunks.map((c, i) => {
        const from = i ? Math.max(chunks[i - 1].end, c.start) : 0
        const next = chunks[i + 1]
        const ov = next && next.start < c.end ? Math.max(next.start, from) : c.end
        const lead = i && c.start < chunks[i - 1].end ? chunks[i - 1].end - c.start : 0
        return (
          <div key={focus === i ? `${i}-${flashAt}` : i} ref={(el) => { refs.current[i] = el }} className={cls('kbx-chunk', i % 2 === 1 && 'alt', focus === i && 'focus')}>
            <span className="kbx-chunk-tag">第 {i + 1} 段 · {c.end - c.start} 字{lead > 0 && ` · 开头 ${lead} 字和上一段重叠`}</span>
            <div className="kbx-chunk-body">{text.slice(from, ov)}{ov < c.end && <mark className="kbx-overlap" title="这几个字同时属于下一段">{text.slice(ov, c.end)}</mark>}</div>
          </div>
        )
      })}
    </div>
  )
}

function KbReader({ doc, busy, settings, focus, flashAt, onBack, onReindex, onRemove }: {
  doc: KbDoc; busy: boolean; settings: KbSettings; focus?: number; flashAt: number
  onBack: () => void; onReindex: () => void; onRemove: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [confirmRm, setConfirmRm] = useState(false)
  const chunks = useMemo(() => splitChunks(doc.text, settings.chunk_size, settings.overlap), [doc.text, settings.chunk_size, settings.overlap])
  const isNote = doc.source.type === 'note'
  // 笔记改完停一会儿就自动重新索引
  const reindexRef = useRef(onReindex)
  reindexRef.current = onReindex
  useEffect(() => {
    if (!editing || doc.status !== 'pending') return
    const t = window.setTimeout(() => reindexRef.current(), 900)
    return () => window.clearTimeout(t)
  }, [editing, doc.text, doc.title, doc.status])
  const edit = (p: Partial<KbDoc>) => kbStore.patchDoc(doc.id, { ...p, status: 'pending', error: undefined, updated_at: new Date().toISOString() })
  return (
    <div className="kbx-reader">
      <div className="kbx-reader-bar">
        <button className="link-btn" onClick={onBack}>返回文档列表</button>
        <span className="spacer" />
        {isNote && <button className={cls('act', editing && 'act-primary')} onClick={() => { if (editing && doc.status === 'pending') onReindex(); setEditing(!editing) }}>{editing ? '改完了' : '编辑笔记'}</button>}
        <button className="act" disabled={busy} onClick={onReindex}>{busy ? '索引中' : doc.status === 'pending' ? '开始索引' : '重新索引'}</button>
        <button className="act" onClick={() => kbStore.patchDoc(doc.id, { excluded: !doc.excluded })}>{doc.excluded ? '恢复参与检索' : '排除'}</button>
        {confirmRm ? <button className="act act-danger" onClick={onRemove}>确认移除</button> : <button className="act act-quiet" onClick={() => setConfirmRm(true)}>移除</button>}
      </div>
      <div className="kbx-reader-head">
        {editing ? <input className="kbx-title-input" value={doc.title} onChange={(e) => edit({ title: e.target.value })} /> : <h2 className="kbx-reader-title">{doc.title}</h2>}
        <div className="kbx-reader-meta">
          <span className="tag">{KB_DOC_SOURCE[doc.source.type]}</span>
          {docRef(doc) && <code className="ellipsis" title={docRef(doc)}>{docRef(doc)}</code>}
          <Pill {...statusPill(doc, busy ? [doc.id] : [])} />
          {doc.excluded && <span className="tag">已排除</span>}
          <span className="run-muted">{timeAgo(doc.updated_at)}更新</span>
        </div>
        {doc.status === 'failed' && doc.error && <div className="detail-alert kbx-alert-bad"><span><b>索引失败</b>{doc.error}</span></div>}
        {doc.excluded && <div className="detail-alert detail-info"><span>这篇暂时不参与检索，资料还留着；点「恢复参与检索」放回去</span></div>}
        {doc.text.trim() && (
          <div className="kbx-reader-sum">
            按每段 {settings.chunk_size} 字、重叠 {settings.overlap} 字切成 <b>{chunks.length}</b> 段
            {doc.status === 'indexed' && doc.chunks !== chunks.length && <span className="kbx-warn"> · 上次索引是 {doc.chunks} 段，重新索引后按新的切分</span>}
          </div>
        )}
      </div>
      {editing ? (
        <textarea className="kbx-editor" value={doc.text} onChange={(e) => edit({ text: e.target.value })} />
      ) : doc.text.trim() ? <ChunkedText text={doc.text} chunks={chunks} focus={focus} flashAt={flashAt} />
        : <div className="io-empty">没有可显示的正文{doc.source.type === 'link' ? '：网页没抓到内容' : doc.source.type === 'upload' ? '：文件里没提取到文字' : ''}</div>}
      {editing && <div className="field-hint-line kbx-edit-hint">{doc.status === 'pending' ? '停笔一会儿就会重新索引' : '已按最新内容索引'}</div>}
    </div>
  )
}

/* ---------- 检索测试 ---------- */

const SAMPLE_Q: Record<string, string[]> = {
  kb_product: ['权限变更多久生效', '导出按钮放在哪', '离线同步先用哪个方案'],
  kb_feedback: ['欧盟数据驻留有什么要求', '远川财务部审批流怎么走', '导出慢的反馈'],
  kb_notes: ['审计日志保留多久', '审批流能不能复用工单', '这周周报进行中的事'],
}

function KbSearch({ kb, docs, settings, onJump }: { kb: KnowledgeBase; docs: KbDoc[]; settings: KbSettings; onJump: (id: string, chunk: number) => void }) {
  const [q, setQ] = useState('')
  const [asked, setAsked] = useState('')
  const hits = useMemo(() => (asked ? searchKb(docs, settings, asked) : []), [docs, settings, asked])
  const inScope = docs.filter((d) => d.status === 'indexed' && !d.excluded)
  const out = docs.length - inScope.length
  const ask = (x: string) => { setQ(x); setAsked(x.trim()) }
  return (
    <div className="kbx-search">
      <div className="secret-line">
        <input value={q} autoFocus placeholder="输入一个问题，比如：权限模型月底演示要做到哪一步" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setAsked(q.trim())} />
        <button className="act act-primary" disabled={!q.trim()} onClick={() => setAsked(q.trim())}>检索</button>
      </div>
      <div className="kbx-search-meta">
        <span className="list-sub">在 {inScope.length} 篇已索引的文档里找{out > 0 && `，待索引、失败、已排除的 ${out} 篇不参与`}；按问题和每段的词重合度打分，列前 5 段</span>
      </div>
      {!asked && (SAMPLE_Q[kb.id] ?? []).length > 0 && (
        <div className="kbx-samples"><span className="list-sub">试试：</span>{SAMPLE_Q[kb.id].map((x) => <button key={x} className="chip" onClick={() => ask(x)}>{x}</button>)}</div>
      )}
      {asked && (hits.length ? (
        <ol className="kbx-hits">
          {hits.map((h, i) => (
            <li key={`${h.doc.id}-${h.index}`} className="kbx-hit">
              <div className="kbx-hit-head">
                <span className="kbx-rank">{i + 1}</span>
                <button className="link-btn ellipsis" onClick={() => onJump(h.doc.id, h.index)} title="打开这篇，定位到这一段">{h.doc.title} · 第 {h.index + 1} 段</button>
                <span className="spacer" />
                <span className="kbx-score" title={`命中 ${h.terms.length} 个检索词`}><span className="kbx-bar"><span style={{ width: `${Math.round(h.score * 100)}%` }} /></span>相关度 {Math.round(h.score * 100)}%</span>
              </div>
              <div className="kbx-hit-body"><Marked text={plain(h.doc.text.slice(h.chunk.start, h.chunk.end))} terms={h.terms} /></div>
              <div className="kbx-hit-src"><span className="tag">{KB_DOC_SOURCE[h.doc.source.type]}</span>{docRef(h.doc) && <code className="ellipsis">{docRef(h.doc)}</code>}</div>
            </li>
          ))}
        </ol>
      ) : <div className="io-empty">没有命中。换个说法，或者看看相关文档是不是还没索引、被排除了</div>)}
    </div>
  )
}

/* ---------- 设置 ---------- */

const CHUNK_SIZES = [200, 300, 500, 800, 1200]
const OVERLAPS = [0, 30, 50, 100]

function KbSettingsTab({ kb, docs, settings: s, agents, providers, editing, onEdit, onReindex, onOpenAgent }: {
  kb: KnowledgeBase; docs: KbDoc[]; settings: KbSettings; agents: Agent[]; providers: Provider[]; editing: boolean
  onEdit: () => void; onReindex: (ids: string[]) => void; onOpenAgent?: (id: string) => void
}) {
  const catEnum = useEnumView('content_category')
  const [dir, setDir] = useState('')
  const [dirErr, setDirErr] = useState('')
  const [confirmDir, setConfirmDir] = useState<string | null>(null)
  const set = (p: Partial<KbSettings>) => kbStore.setSettings({ ...s, ...p })
  const users = usedBy(agents, (a) => a.kbs.includes(kb.id))
  const cats = kb.sources
  const embeds = embedOptions(providers)
  const pv = providers.find((p) => p.id === s.embed.provider_id)
  const pending = docs.filter((d) => d.status === 'pending')
  // 切分方式改了以后段数会变的文档
  const resized = docs.filter((d) => d.status === 'indexed' && d.chunks !== splitChunks(d.text, s.chunk_size, s.overlap).length)
  const total = docs.filter((d) => d.status !== 'failed').reduce((n, d) => n + splitChunks(d.text, s.chunk_size, s.overlap).length, 0)
  const addDir = () => {
    const p = dir.trim().replace(/\/+$/, '')
    if (!p.startsWith('/')) return setDirErr('填绝对路径，以 / 开头')
    if (s.dirs.some((d) => d.path === p)) return setDirErr('这个目录已经挂上了')
    set({ dirs: [...s.dirs, { path: p, auto_sync: true, synced_at: new Date().toISOString() }] })
    setDir(''); setDirErr('')
  }
  const syncDir = (path: string) => {
    set({ dirs: s.dirs.map((d) => (d.path === path ? { ...d, synced_at: new Date().toISOString() } : d)) })
    onReindex(docs.filter((d) => inDir(d, path)).map((d) => d.id))
  }
  return (
    <div className="kbx-settings">
      <section className="hook-sec">
        <div className="mount-head"><div className="field-group-title">来源</div></div>
        <div className="kbx-set-line">
          <span className="kbx-set-label">文档分类</span>
          <span className="kb-sources">{cats.length ? cats.map((x) => <span key={x} className="tag">{catEnum.label(x)}</span>) : <span className="list-sub">没选分类</span>}</span>
          <span className="spacer" />
          <button className={cls('act', editing && 'act-primary')} onClick={onEdit}>修改</button>
        </div>
        <label className="switch-row">
          <span>分类里新加的文档自动收进来<span className="switch-hint">关掉后只收手动加的；「文档」页顶上会提示还没收进来的篇目</span></span>
          <input type="checkbox" className="switch" checked={s.auto_sync} onChange={(e) => set({ auto_sync: e.target.checked })} />
        </label>
        <div className="kbx-set-label">本地目录<span className="field-hint">只收 .md、.txt 文件</span></div>
        {s.dirs.length ? (
          <div className="kbx-dirs">
            {s.dirs.map((d) => {
              const n = docs.filter((x) => inDir(x, d.path)).length
              return (
                <div key={d.path} className="kbx-dir">
                  <span className="kbx-dir-main">
                    <code className="ellipsis" title={d.path}>{d.path}</code>
                    <span className="run-muted">{n} 个文件{d.synced_at && ` · ${timeAgo(d.synced_at)}同步`}</span>
                  </span>
                  {confirmDir === d.path ? (
                    <span className="kbx-dir-ops">
                      <span className="danger-text">{n ? `目录里的 ${n} 篇会一起移出` : '移除这个目录'}</span>
                      <button className="act act-danger" onClick={() => { kbStore.removeDir(kb.id, d.path); setConfirmDir(null) }}>移除</button>
                      <button className="act act-quiet" onClick={() => setConfirmDir(null)}>取消</button>
                    </span>
                  ) : (
                    <span className="kbx-dir-ops">
                      <label className="switch-line" title="目录里的文件有变动时自动重新索引">
                        <input type="checkbox" checked={d.auto_sync} onChange={(e) => set({ dirs: s.dirs.map((x) => (x.path === d.path ? { ...x, auto_sync: e.target.checked } : x)) })} />
                        <span className="switch" />自动同步
                      </label>
                      <button className="act act-quiet" onClick={() => syncDir(d.path)}>立即同步</button>
                      <button className="act act-quiet" onClick={() => setConfirmDir(d.path)}>移除</button>
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        ) : <div className="mount-empty">还没挂本地目录</div>}
        <div className="secret-line">
          <input className={cls('mono', dirErr && 'bad')} value={dir} placeholder="/Volumes/docs/客户/远川科技" onChange={(e) => { setDir(e.target.value); setDirErr('') }} onKeyDown={(e) => e.key === 'Enter' && addDir()} />
          <button className="act" disabled={!dir.trim()} onClick={addDir}>挂上目录</button>
        </div>
        {dirErr && <span className="field-err">{dirErr}</span>}
      </section>

      <section className="hook-sec">
        <div className="field-group-title">切分方式<span className="field-hint">检索按段来找；段太长答案不准，段太短上下文不够</span></div>
        <div className="field-row">
          <label className="field"><span className="field-label">每段多少字</span>
            <select value={s.chunk_size} onChange={(e) => { const v = Number(e.target.value); set({ chunk_size: v, overlap: Math.min(s.overlap, Math.floor(v / 2)) }) }}>{CHUNK_SIZES.map((x) => <option key={x} value={x}>{x} 字</option>)}</select>
          </label>
          <label className="field"><span className="field-label">段间重叠</span>
            <select value={s.overlap} onChange={(e) => set({ overlap: Number(e.target.value) })}>{OVERLAPS.filter((x) => x <= s.chunk_size / 2).map((x) => <option key={x} value={x}>{x ? `${x} 字` : '不重叠'}</option>)}</select>
          </label>
        </div>
        <span className="list-sub">按这个设置，现有文档共切成 {total} 段；尽量在换行和句号处断开</span>
        {resized.length > 0 && (
          <div className="detail-alert kbx-alert-warn">
            <span><b>有 {resized.length} 篇段数变了</b>重新索引后检索才按新的切分</span>
            <button className="act" onClick={() => onReindex(resized.map((d) => d.id))}>重新索引这 {resized.length} 篇</button>
          </div>
        )}
      </section>

      <section className="hook-sec">
        <div className="field-group-title">向量化模型<span className="field-hint">换模型后已有的向量作废，全部要重新索引</span></div>
        <SearchSelect variant="field" value={`${s.embed.provider_id}|${s.embed.model}`} searchPlaceholder="搜服务商或模型"
          options={embeds.map((x) => ({ value: `${x.provider.id}|${x.model}`, label: `${x.provider.name} · ${x.model}`, group: x.provider.name, keywords: x.label, hint: x.provider.status === 'error' ? '连接异常' : x.provider.status === 'untested' ? '未测试' : undefined }))}
          emptyText="还没有能做向量化的服务商，到「设置 / 模型服务商」接一个"
          missingLabel={() => `${s.embed.model}（服务商已删除）`}
          onChange={(v) => { const [provider_id, ...m] = v.split('|'); kbStore.setEmbed(kb.id, { provider_id, model: m.join('|') }) }} />
        {pv?.status === 'error' && <div className="detail-alert kbx-alert-bad"><span><b>{pv.name} 连接异常</b>{pv.error ?? ''}；重新索引会失败，换一个模型或先修好服务商</span></div>}
        {(!pv || !pv.enabled) && <div className="detail-alert kbx-alert-bad"><span>当前用的服务商已停用或删除，换一个模型</span></div>}
        {pending.length > 0 && (
          <div className="detail-alert kbx-alert-warn">
            <span><b>{pending.length} 篇待索引</b>用 {s.embed.model} 重新算向量</span>
            <button className="act" onClick={() => onReindex(pending.map((d) => d.id))}>开始索引</button>
          </div>
        )}
      </section>

      <section className="hook-sec">
        <div className="field-group-title">挂了这个知识库的 Agent<span className="field-hint">在 Agent 配置里挂、卸</span></div>
        {users.length ? (
          <div className="kbx-agents">
            {users.map((a) => {
              const inner = <><AgentAvatar agent={a} size={28} /><span className="kbx-agent-text"><b className="ellipsis">{a.name}</b><span className="run-muted ellipsis">{a.desc}</span></span>{!a.enabled && <span className="tag">已停用</span>}</>
              return onOpenAgent
                ? <button key={a.id} className="kbx-agent" onClick={() => onOpenAgent(a.id)} title="打开 Agent 配置">{inner}<svg viewBox="0 0 16 16" width="12" height="12"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
                : <div key={a.id} className="kbx-agent">{inner}</div>
            })}
          </div>
        ) : <div className="mount-empty">还没有 Agent 挂这个知识库，到「设置 / Agent」里挂</div>}
      </section>
    </div>
  )
}

export function KbDrawer({ kb, agents, onClose, onSave, onDelete }: {
  kb: KnowledgeBase | null
  agents: Agent[]
  /** 旧参数，篇数和检索都挪到知识库详情页了 */
  docsOf?: (kb: KnowledgeBase) => SearchDoc[]
  onClose: () => void
  onSave: (k: KnowledgeBase) => void
  onDelete: () => void
  /** 旧参数，重新索引挪到知识库详情页了 */
  onReindex?: (id: string) => void
}) {
  const catEnum = useEnumView('content_category')
  const creating = !kb
  const [d, setD] = useState<KnowledgeBase>(() => kb ?? { id: newId('kb'), name: '', desc: '', sources: [], updated_at: new Date().toISOString() })
  const [tried, setTried] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const users = usedBy(agents, (a) => a.kbs.includes(d.id))
  // 停用的分类不再出现，已经选上的照常列出来，方便取消
  const all = catEnum.items.filter((i) => i.enabled || d.sources.includes(i.key)).map((i) => i.key)
  const toggle = (k: string) => setD({ ...d, sources: d.sources.includes(k) ? d.sources.filter((x) => x !== k) : [...d.sources, k] })
  const save = () => {
    setTried(true)
    if (!d.name.trim()) return
    onSave({ ...d, name: d.name.trim(), updated_at: new Date().toISOString() })
  }
  return (
    <aside className="drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">{creating ? '新建知识库' : '知识库'}</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)"><svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg></button>
      </div>
      <div className="drawer-body form">
        <label className="field"><span className="field-label">名称<em>*</em></span><input value={d.name} autoFocus={creating} className={cls(tried && !d.name.trim() && 'bad')} placeholder="比如：竞品资料" onChange={(e) => setD({ ...d, name: e.target.value })} /></label>
        <label className="field"><span className="field-label">说明</span><input value={d.desc} placeholder="放了什么、给谁用" onChange={(e) => setD({ ...d, desc: e.target.value })} /></label>
        <div className="field">
          <span className="field-label">文档分类<span className="field-hint">选了的分类里的文档会收进来，可以多选，也可以不选只手动加</span></span>
          <div className="dep-list">
            {all.map((k) => <label key={k} className={cls('dep-chip', d.sources.includes(k) && 'on')}><input type="checkbox" checked={d.sources.includes(k)} onChange={() => toggle(k)} />{sourceLabel(catEnum, k)}</label>)}
          </div>
          <span className="field-hint-line">本地目录、上传的文件、网页和笔记，在知识库详情里加</span>
        </div>
        <div className="field">
          <span className="field-label">在用的 Agent</span>
          {users.length ? <UserChips list={users} /> : <span className="list-sub">还没有 Agent 挂这个知识库，到「设置 / Agent」里挂</span>}
        </div>
      </div>
      <div className="drawer-foot">
        {confirmDel ? (
          <>
            <span className="danger-text">{users.length ? `${names(users)} 挂着它，删除后会自动卸下` : '删除后不能恢复，原文档不受影响'}</span>
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>取消</button>
            <button className="btn btn-danger" onClick={onDelete}>删除</button>
          </>
        ) : (
          <>
            {!creating && <button className="btn btn-ghost btn-danger-ghost" onClick={() => setConfirmDel(true)}>删除</button>}
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={onClose}>取消</button>
            <button className="btn btn-primary" onClick={save}>{creating ? '创建' : '保存'}</button>
          </>
        )}
      </div>
    </aside>
  )
}

/* ---------- 技能 ---------- */

export function SkillsPage({ skills, agents, selected, onOpen, onNew }: { skills: Skill[]; agents: Agent[]; selected: string | null; onOpen: (id: string) => void; onNew: () => void }) {
  const [src, setSrc] = useState<'' | Skill['source']>('')
  const [q, setQ] = useState('')
  const rows = skills.filter((k) => (!src || k.source === src) && hit(`${k.name} ${k.desc} ${k.uses.join(' ')}`, q))
  return (
    <div className="page page-fill">
      <PageTitle parent="设置" count={skills.length} desc="可复用的做事方法：说明怎么做、什么时候用、用到哪些工具；挂到 Agent 上就会按它做"
        actions={<button className="btn btn-primary" onClick={onNew}>新建技能</button>}>技能</PageTitle>
      <div className="toolbar">
        <div className="seg">
          {([['', '全部'], ['内置', '内置'], ['自定义', '自定义']] as const).map(([k, l]) => <button key={k} className={cls(src === k && 'on')} onClick={() => setSrc(k)}>{l}<span className="seg-n">{k ? skills.filter((x) => x.source === k).length : skills.length}</span></button>)}
        </div>
        <SearchBox value={q} onChange={setQ} placeholder="搜技能名称、说明、用到的工具" />
      </div>
      {/* 一个都没有和筛不到分开说 */}
      {!rows.length && (skills.length
        ? <div className="empty"><div className="empty-title">没有匹配的技能</div><div className="list-sub">换个关键词或来源试试</div></div>
        : <div className="empty"><div className="empty-title">还没有技能</div><div className="list-sub">点右上角「新建技能」</div></div>)}
      {rows.length > 0 && <div className="task-table">
        <div className="skill-row task-th"><span>技能</span><span>来源</span><span>用到</span><span>在用的 Agent</span></div>
        {rows.map((k) => (
          <div key={k.id} role="button" tabIndex={0} className={cls('skill-row', selected === k.id && 'sel')} onClick={() => onOpen(k.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(k.id)}>
            <span className="task-main">
              <span className="task-title"><span className="ellipsis">{k.name}</span></span>
              <span className="task-meta"><span className="ellipsis">{k.desc}</span></span>
            </span>
            <span><span className={cls('tag', k.source === '自定义' && 'tag-custom')}>{k.source}</span></span>
            <span className="cap-tags">{k.uses.slice(0, 3).map((u) => <span key={u} className="ability-tag">{u}</span>)}{k.uses.length > 3 && <span className="ability-tag">+{k.uses.length - 3}</span>}</span>
            <span><Users list={usedBy(agents, (a) => a.skills.includes(k.id))} /></span>
          </div>
        ))}
      </div>}
    </div>
  )
}

export function SkillDrawer({ skill, isNew, agents, toolNames, onClose, onSave, onDelete, onDuplicate }: {
  skill: Skill | null
  /** 复制出来还没保存的技能：按新建处理 */
  isNew?: boolean
  agents: Agent[]
  /** 可以写进「用到」的工具：内置工具 + 连接器工具 */
  toolNames: string[]
  onClose: () => void
  onSave: (k: Skill) => void
  onDelete: () => void
  onDuplicate: (k: Skill) => void
}) {
  const creating = !skill || !!isNew
  const readonly = skill?.source === '内置'
  const [d, setD] = useState<Skill>(() => skill ?? { id: newId('sk'), name: '', desc: '', source: '自定义', uses: [], instructions: '', when: '' })
  const [tried, setTried] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const users = usedBy(agents, (a) => a.skills.includes(d.id))
  // 内置能力就那几项，常显成勾选 chip；连接器工具几百个，只显示选了的，「加工具」里按连接器分组搜
  const builtin = ABILITIES.map((a) => a.label)
  const picked = d.uses.filter((u) => !builtin.includes(u))
  const toolOptions = useMemo(() => [...new Set(toolNames)].map((t) => {
    const i = t.indexOf(' · ')
    return { value: t, label: i > 0 ? t.slice(i + 3) : t, group: i > 0 ? t.slice(0, i) : '其他', keywords: t }
  }).sort((a, b) => a.group.localeCompare(b.group, 'zh-CN')), [toolNames])
  const setPicked = (xs: string[]) => setD({ ...d, uses: [...d.uses.filter((u) => builtin.includes(u)), ...xs] })
  const save = () => { setTried(true); if (d.name.trim() && d.instructions.trim()) onSave({ ...d, name: d.name.trim() }) }
  return (
    <aside className="drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">{creating ? '新建技能' : readonly ? '内置技能' : '技能'}</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)"><svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg></button>
      </div>
      <div className="drawer-body form">
        {readonly && <div className="detail-alert detail-info"><span>内置技能不能直接改；要按自己的习惯调，点下面「复制一份来改」</span></div>}
        <label className="field"><span className="field-label">名称<em>*</em></span><input value={d.name} disabled={readonly} autoFocus={creating} className={cls(tried && !d.name.trim() && 'bad')} placeholder="比如：竞品分析" onChange={(e) => setD({ ...d, name: e.target.value })} /></label>
        <label className="field"><span className="field-label">一句话说明</span><input value={d.desc} disabled={readonly} onChange={(e) => setD({ ...d, desc: e.target.value })} /></label>
        <label className="field"><span className="field-label">什么时候用<span className="field-hint">Agent 靠这句话判断该不该用这个技能</span></span>
          <input value={d.when ?? ''} disabled={readonly} placeholder="比如：用户要对比几家竞品、或者问某家竞品最近更新了什么时" onChange={(e) => setD({ ...d, when: e.target.value })} />
        </label>
        <label className="field"><span className="field-label">怎么做<em>*</em><span className="field-hint">步骤、格式、注意事项</span></span>
          <textarea rows={7} className={cls('agent-prompt json-area', tried && !d.instructions.trim() && 'bad')} disabled={readonly} value={d.instructions} onChange={(e) => setD({ ...d, instructions: e.target.value })} />
        </label>
        <div className="field">
          <span className="field-label">用到的工具<span className="field-hint">只是说明；Agent 有没有这些工具的权限，在 Agent 配置里定</span></span>
          <div className="dep-list">
            {builtin.map((t) => (
              <label key={t} className={cls('dep-chip', d.uses.includes(t) && 'on', readonly && 'disabled')}>
                <input type="checkbox" disabled={readonly} checked={d.uses.includes(t)} onChange={() => setD({ ...d, uses: d.uses.includes(t) ? d.uses.filter((x) => x !== t) : [...d.uses, t] })} />{t}
              </label>
            ))}
          </div>
          <div className="dep-list skill-tools">
            {picked.map((t) => (
              <label key={t} className={cls('dep-chip on skill-tool', readonly && 'disabled')} title={t}>
                <input type="checkbox" disabled={readonly} checked onChange={() => setPicked(picked.filter((x) => x !== t))} /><span className="ellipsis">{t}</span>
              </label>
            ))}
            {!readonly && (
              <SearchSelect multiple value={picked} onChange={setPicked} placeholder={picked.length ? '加工具' : '加连接器工具'} searchPlaceholder="搜连接器或工具名"
                options={toolOptions} emptyText="还没有接入带工具的连接器" missingLabel={(v) => v} menuWidth={360} active={false} />
            )}
            {readonly && !picked.length && <span className="list-sub">没有用到连接器工具</span>}
          </div>
        </div>
        <div className="field">
          <span className="field-label">在用的 Agent</span>
          {users.length ? <UserChips list={users} /> : <span className="list-sub">还没有 Agent 挂这个技能</span>}
        </div>
      </div>
      <div className="drawer-foot">
        {confirmDel ? (
          <>
            <span className="danger-text">{users.length ? `${names(users)} 挂着它，删除后会自动卸下` : '删除后不能恢复'}</span>
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>取消</button>
            <button className="btn btn-danger" onClick={onDelete}>删除</button>
          </>
        ) : readonly ? (
          <>
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={onClose}>关闭</button>
            <button className="btn btn-primary" onClick={() => onDuplicate(skill!)}>复制一份来改</button>
          </>
        ) : (
          <>
            {!creating && <button className="btn btn-ghost btn-danger-ghost" onClick={() => setConfirmDel(true)}>删除</button>}
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={onClose}>取消</button>
            <button className="btn btn-primary" onClick={save}>{creating ? '创建' : '保存'}</button>
          </>
        )}
      </div>
    </aside>
  )
}
