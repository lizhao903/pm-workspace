import { useMemo, useState } from 'react'
import { ABILITIES, type Agent, type KnowledgeBase, type Skill } from './agentdata'
import { AgentAvatar } from './agents'
import { SearchSelect } from './searchselect'
import { useEnumView, type EnumView } from './enumdata'
import { PageTitle } from './topbar'
import { cls, timeAgo } from './ui'
import { newId } from './ids'

// 设置 > 知识库、技能。两样都能挂到 Agent 上；这里是集中管理的地方

/** 能被检索的一篇资料：工作台文档或本地目录里的文件 */
export interface SearchDoc { id: string; title: string; body: string; source: string }

// 分类的显示名读「文档分类」枚举
const sourceLabel = (e: EnumView, k: string) => (k.startsWith('dir:') ? `本地目录 · ${k.slice(4)}` : e.label(k))
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

const KB_STATUS = { ready: { label: '已索引', color: '#2f7d43' }, indexing: { label: '索引中', color: '#3d4fd6' }, stale: { label: '有更新待索引', color: '#b0570b' } }
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

export function KnowledgePage({ kbs, agents, docsOf, selected, onOpen, onNew }: {
  kbs: KnowledgeBase[]; agents: Agent[]; docsOf: (kb: KnowledgeBase) => SearchDoc[]; selected: string | null
  onOpen: (id: string) => void; onNew: () => void
}) {
  const catEnum = useEnumView('content_category')
  const [q, setQ] = useState('')
  const rows = kbs.filter((k) => hit(`${k.name} ${k.desc}`, q))
  return (
    <div className="page page-fill">
      <PageTitle parent="设置" count={kbs.length} desc="一组可检索的资料，来源是文档分类或本地目录；挂到 Agent 上，回答和写作时先在这里找依据"
        actions={<button className="btn btn-primary" onClick={onNew}>新建知识库</button>}>知识库</PageTitle>
      <div className="toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="搜知识库名称和说明" />
        {q.trim() && <span className="list-sub">命中 {rows.length} 个</span>}
      </div>
      {!rows.length && <div className="empty"><div className="empty-title">{kbs.length ? '没有匹配的知识库' : '还没有知识库'}</div><div className="list-sub">{kbs.length ? '换个关键词试试' : '点右上角「新建知识库」，选文档分类或本地目录当来源'}</div></div>}
      <div className="kb-grid">
        {rows.map((k) => {
          const users = usedBy(agents, (a) => a.kbs.includes(k.id))
          const n = docsOf(k).length
          return (
            <button key={k.id} className={cls('kb-card', selected === k.id && 'sel')} onClick={() => onOpen(k.id)}>
              <div className="kb-card-head">
                <span className="mount-icon kb-icon"><svg viewBox="0 0 16 16" width="13" height="13"><path d="M3 3.5h4.5v9H3zM8.5 3.5H13v9H8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg></span>
                <span className="kb-name ellipsis">{k.name}</span>
                <Pill {...KB_STATUS[k.status ?? 'ready']} />
              </div>
              <div className="list-sub kb-desc">{k.desc || '没有说明'}</div>
              <div className="kb-sources">{k.sources.map((s) => <span key={s} className="tag">{sourceLabel(catEnum, s)}</span>)}</div>
              <div className="kb-foot">
                <span>{n} 篇 · {timeAgo(k.updated_at)}更新</span>
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

export function KbDrawer({ kb, agents, folders, docsOf, onClose, onSave, onDelete, onReindex }: {
  kb: KnowledgeBase | null
  agents: Agent[]
  folders: string[]
  docsOf: (kb: KnowledgeBase) => SearchDoc[]
  onClose: () => void
  onSave: (k: KnowledgeBase) => void
  onDelete: () => void
  onReindex: (id: string) => void
}) {
  const catEnum = useEnumView('content_category')
  const creating = !kb
  const [d, setD] = useState<KnowledgeBase>(() => kb ?? { id: newId('kb'), name: '', desc: '', sources: [], docs: 0, updated_at: new Date().toISOString(), status: 'ready' })
  const [q, setQ] = useState('')
  const [asked, setAsked] = useState('')
  const [tried, setTried] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const docs = useMemo(() => docsOf(d), [d, docsOf])
  const hits = useMemo(() => (asked ? searchDocs(docs, asked) : []), [docs, asked])
  const users = usedBy(agents, (a) => a.kbs.includes(d.id))
  const changed = kb && JSON.stringify(kb.sources) !== JSON.stringify(d.sources)
  // 停用的分类不再出现，已经选上的照常列出来，方便取消
  const all = [...catEnum.items.filter((i) => i.enabled || d.sources.includes(i.key)).map((i) => i.key), ...folders.map((f) => `dir:${f}`)]
  const toggle = (k: string) => setD({ ...d, sources: d.sources.includes(k) ? d.sources.filter((x) => x !== k) : [...d.sources, k] })
  const save = () => {
    setTried(true)
    if (!d.name.trim() || !d.sources.length) return
    // 来源变了就要重新索引
    onSave({ ...d, name: d.name.trim(), docs: docs.length, updated_at: new Date().toISOString(), status: changed ? 'stale' : d.status ?? 'ready' })
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
          <span className="field-label">来源<em>*</em><span className="field-hint">文档分类或本地目录，可以多选</span></span>
          <div className="dep-list">
            {all.map((k) => <label key={k} className={cls('dep-chip', d.sources.includes(k) && 'on')}><input type="checkbox" checked={d.sources.includes(k)} onChange={() => toggle(k)} />{sourceLabel(catEnum, k)}</label>)}
          </div>
          {!folders.length && <span className="field-hint-line">在「文档」里选了本地目录后，本地目录也能当来源</span>}
          {tried && !d.sources.length && <span className="field-err">至少选一个来源</span>}
        </div>
        {!creating && (
          <div className="kb-index">
            <Pill {...KB_STATUS[kb!.status ?? 'ready']} />
            <span className="list-sub">{docs.length} 篇 · {kb!.status === 'indexing' ? '正在重新索引…' : `上次索引 ${timeAgo(kb!.updated_at)}`}</span>
            <span className="spacer" />
            <button className="act" disabled={kb!.status === 'indexing'} onClick={() => onReindex(kb!.id)}>重新索引</button>
          </div>
        )}

        <section className="field-group">
          <div className="field-group-title">检索测试<span className="field-hint">输入一个问题，看会命中哪些资料；用当前勾选的来源算</span></div>
          <div className="secret-line">
            <input value={q} placeholder="比如：权限模型月底演示要做到哪一步" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setAsked(q.trim())} />
            <button className="act act-primary" disabled={!q.trim()} onClick={() => setAsked(q.trim())}>检索</button>
          </div>
          {asked && (hits.length ? (
            <ol className="kb-hits">
              {hits.map((h) => (
                <li key={h.d.id}>
                  <div className="kb-hit-head"><b>{h.d.title}</b><span className="tag">{h.d.source}</span><span className="kb-score">匹配 {h.score}</span></div>
                  <div className="list-sub">…{h.snippet}…</div>
                </li>
              ))}
            </ol>
          ) : <div className="io-empty">没有命中。换个说法，或者检查来源有没有选对</div>)}
        </section>

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
            {changed && <span className="list-sub">来源改了，保存后需要重新索引</span>}
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
      {!rows.length && <div className="empty"><div className="empty-title">没有匹配的技能</div><div className="list-sub">换个关键词或来源试试</div></div>}
      {rows.length > 0 && <div className="task-table">
        <div className="skill-row task-th"><span>技能</span><span>来源</span><span>用到</span><span>在用的 Agent</span></div>
        {rows.map((k) => (
          <div key={k.id} className={cls('skill-row', selected === k.id && 'sel')} onClick={() => onOpen(k.id)}>
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
