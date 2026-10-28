import { useMemo, useState } from 'react'
import { PageTitle } from './topbar'
import { IM_CHANNELS, type Contact, type Group } from './data'
import { useEnumView } from './enumdata'
import { MarkEditor } from './imagepick'
import { Avatar, GroupPill, ImBadges, ImMark, Star, ago, cls } from './ui'

/* ---------- 联系人 ---------- */

export function ContactsPage({ contacts, selected, onOpen, onNew, onStar }: {
  contacts: Contact[]; selected: string | null
  onOpen: (id: string) => void; onNew: () => void; onStar: (id: string) => void
}) {
  const groupItems = useEnumView('contact_group').items
  const [q, setQ] = useState('')
  const [group, setGroup] = useState<Group | null>(null)
  const [starredOnly, setStarredOnly] = useState(false)
  const [channel, setChannel] = useState('')
  const [sort, setSort] = useState<'recent' | 'name'>('recent')

  const kw = q.trim().toLowerCase()
  const rows = useMemo(() => contacts
    .filter((c) => (!group || c.group === group) && (!starredOnly || c.starred) && (!channel || c.im[channel])
      && (!kw || [c.name, c.company, c.title, c.phone.replace(/\s/g, ''), c.email, ...c.tags, ...Object.values(c.im)].some((v) => v.toLowerCase().includes(kw.replace(/\s/g, '')) || v.toLowerCase().includes(kw))))
    .sort((a, b) => sort === 'name'
      ? a.name.localeCompare(b.name, 'zh-CN')
      : (b.last_contact_at ?? '').localeCompare(a.last_contact_at ?? '')),
  [contacts, group, starredOnly, channel, kw, sort])

  const countOf = (g: Group) => contacts.filter((c) => c.group === g).length

  return (
    <div className="page">
      <PageTitle count={contacts.length} desc="客户、合作伙伴、同事和供应商，按最近联系排序" actions={
        <button className="btn btn-primary" onClick={onNew}>
          <svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          新建联系人
        </button>
      }>联系人</PageTitle>

      <div className="toolbar">
        <div className="search">
          <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder="搜索姓名、公司、电话、邮箱、IM 编号" value={q} onChange={(e) => setQ(e.target.value)} />
          {q && <button className="search-clear" onClick={() => setQ('')} title="清空">
            <svg viewBox="0 0 16 16" width="12" height="12"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>}
        </div>
        <div className="seg">
          <button className={cls(!group && 'on')} onClick={() => setGroup(null)}>全部<span className="seg-n">{contacts.length}</span></button>
          {/* 停用的分组还有人在用时照样列出来，不然这些联系人筛不到 */}
          {groupItems.filter((g) => g.enabled || countOf(g.key) > 0).map((g) => (
            <button key={g.key} className={cls(group === g.key && 'on')} onClick={() => setGroup(g.key)}>{g.label}<span className="seg-n">{countOf(g.key)}</span></button>
          ))}
        </div>
        <button className={cls('chip', starredOnly && 'chip-on')} onClick={() => setStarredOnly(!starredOnly)}>只看星标</button>
        <label className={cls('chip chip-select', channel && 'chip-on')}>
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">IM 渠道：不限</option>
            {IM_CHANNELS.map((ch) => (
              <option key={ch.key} value={ch.key}>有{ch.label}（{contacts.filter((c) => c.im[ch.key]).length}）</option>
            ))}
          </select>
        </label>
        <div className="spacer" />
        <label className="sort">
          排序
          <select value={sort} onChange={(e) => setSort(e.target.value as 'recent' | 'name')}>
            <option value="recent">最近联系</option>
            <option value="name">姓名</option>
          </select>
        </label>
      </div>

      {contacts.length === 0 ? (
        <div className="empty">
          <div className="empty-title">还没有联系人</div>
          <div className="muted">把常打交道的人记下来，找人时不用翻聊天记录</div>
          <button className="btn btn-primary" onClick={onNew}>新建第一个联系人</button>
        </div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="empty-title">没有匹配的联系人</div>
          <div className="muted">换个关键词，或清掉分组、星标和渠道筛选</div>
        </div>
      ) : (
        <div className="table">
          <div className="tr th">
            <span /><span>姓名</span><span>公司</span><span>分组</span><span>电话</span><span>IM 渠道</span><span>邮箱</span><span>最近联系</span>
          </div>
          {rows.map((c) => (
            <div key={c.id} role="button" tabIndex={0} className={cls('tr', selected === c.id && 'sel')}
              onClick={() => onOpen(c.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(c.id)}>
              <span><Star on={c.starred} onClick={() => onStar(c.id)} /></span>
              <span className="who">
                <Avatar name={c.name} src={c.photo} />
                <span className="who-text">
                  <span className="who-name ellipsis">{c.name}</span>
                  {c.title && <span className="who-title ellipsis">{c.title}</span>}
                </span>
              </span>
              <span className="ellipsis">{c.company || <span className="faint">-</span>}</span>
              <span><GroupPill g={c.group} /></span>
              <span className="mono">{c.phone || <span className="faint">-</span>}</span>
              <span><ImBadges im={c.im} /></span>
              <span className="ellipsis">{c.email || <span className="faint">-</span>}</span>
              <span className="muted">{ago(c.last_contact_at) ?? <span className="faint">未联系</span>}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------- 联系人抽屉：查看 / 编辑 / 新建 共用 ---------- */

export type Draft = Omit<Contact, 'id' | 'created_at'>
const blank: Draft = { name: '', company: '', title: '', phone: '', email: '', group: '客户', tags: [], im: {}, note: '', starred: false, last_contact_at: null }

export function ContactDrawer({ contact, initial, onClose, onSave, onDelete, onTouch, delImpact }: {
  contact: Contact | null
  /** 新建时的预填，消息页「存为联系人」用 */
  initial?: Partial<Draft>
  onClose: () => void
  onSave: (d: Draft) => void
  onDelete: () => void
  onTouch: () => void
  /** 删除的连带影响，列在确认里 */
  delImpact?: string[]
}) {
  const groupEnum = useEnumView('contact_group')
  const creating = !contact
  const [editing, setEditing] = useState(creating)
  // 新建时的分组取设置里的默认值
  const [draft, setDraft] = useState<Draft>(contact ?? { ...blank, group: groupEnum.defaultKey ?? blank.group, ...initial })
  const [tagInput, setTagInput] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  const [tried, setTried] = useState(false)

  const errors = {
    name: !draft.name.trim() ? '姓名必填' : '',
    email: draft.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email) ? '邮箱格式不对' : '',
  }
  const invalid = Object.values(errors).some(Boolean)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const addTag = () => {
    const t = tagInput.trim()
    if (t && !draft.tags.includes(t)) set('tags', [...draft.tags, t])
    setTagInput('')
  }
  const save = () => {
    setTried(true)
    if (invalid) return
    // 空编号不落库：清掉一个渠道 = 删掉这个渠道
    const im = Object.fromEntries(Object.entries(draft.im).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v))
    onSave({ ...draft, name: draft.name.trim(), im })
    if (!creating) setEditing(false)
  }

  const head = (
    <div className="drawer-head">
      <span className="drawer-kicker">{creating ? '新建联系人' : editing ? '编辑联系人' : '联系人'}</span>
      <div className="spacer" />
      {!editing && contact && (
        <button className="icon-btn" title="编辑" onClick={() => { setDraft(contact); setEditing(true) }}>
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M10.5 2.5 13.5 5.5 5.5 13.5H2.5v-3Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
        </button>
      )}
      <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
        <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
    </div>
  )

  if (editing) {
    const field = (k: 'name' | 'company' | 'title' | 'phone' | 'email', label: string, ph: string, req = false) => (
      <label className="field">
        <span className="field-label">{label}{req && <em>*</em>}</span>
        <input value={draft[k]} placeholder={ph} autoFocus={k === 'name'}
          className={cls(tried && errors[k as 'name' | 'email'] && 'bad')}
          onChange={(e) => set(k, e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()} />
        {tried && errors[k as 'name' | 'email'] && <span className="field-err">{errors[k as 'name' | 'email']}</span>}
      </label>
    )
    return (
      <aside className="drawer">
        {head}
        <div className="drawer-body form">
          <div className="name-with-mark">
            <MarkEditor image={draft.photo} onImage={(photo) => set('photo', photo)} hint="没有图片时按名字生成">
              <Avatar name={draft.name || '新'} size={48} src={draft.photo} />
            </MarkEditor>
            {field('name', '姓名', '例如 许知行', true)}
          </div>
          <div className="field-row">
            {field('company', '公司', '所在单位')}
            {field('title', '职位', '例如 IT 总监')}
          </div>
          <div className="field">
            <span className="field-label">分组</span>
            <div className="seg seg-full">
              {groupEnum.optionsWith(draft.group).map((g) => <button key={g.key} type="button" className={cls(draft.group === g.key && 'on')} onClick={() => set('group', g.key)}>{g.label}</button>)}
            </div>
          </div>
          <div className="field-row">
            {field('phone', '电话', '手机或座机')}
            {field('email', '邮箱', 'name@company.com')}
          </div>
          <div className="field">
            <span className="field-label">IM 渠道<span className="field-hint">填各渠道上能搜到这个人的编号，没有的留空</span></span>
            <div className="im-form">
              {IM_CHANNELS.map((ch) => (
                <label key={ch.key} className="im-form-row">
                  <ImMark ch={ch} />
                  <input value={draft.im[ch.key] ?? ''} placeholder={ch.hint}
                    onChange={(e) => set('im', { ...draft.im, [ch.key]: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && save()} />
                </label>
              ))}
            </div>
          </div>
          <div className="field">
            <span className="field-label">标签</span>
            <div className="tag-input">
              {draft.tags.map((t) => (
                <span key={t} className="tag">{t}
                  <button type="button" onClick={() => set('tags', draft.tags.filter((x) => x !== t))} title="移除">
                    <svg viewBox="0 0 16 16" width="10" height="10"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                  </button>
                </span>
              ))}
              <input value={tagInput} placeholder={draft.tags.length ? '' : '输入后回车添加'} onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); addTag() }
                  if (e.key === 'Backspace' && !tagInput && draft.tags.length) set('tags', draft.tags.slice(0, -1))
                }} onBlur={addTag} />
            </div>
          </div>
          <label className="field">
            <span className="field-label">备注</span>
            <textarea rows={5} value={draft.note} placeholder="怎么认识的、关心什么、下次聊什么" onChange={(e) => set('note', e.target.value)} />
          </label>
        </div>
        <div className="drawer-foot">
          <button className="btn btn-ghost" onClick={() => (creating ? onClose() : (setEditing(false), setTried(false)))}>取消</button>
          <div className="spacer" />
          <button className="btn btn-primary" onClick={save}>{creating ? '创建' : '保存'}</button>
        </div>
      </aside>
    )
  }

  const c = contact!
  const row = (label: string, value: React.ReactNode, copy?: string) => (
    <>
      <dt>{label}</dt>
      <dd>
        {value || <span className="faint">未填写</span>}
        {copy && <button className="copy" onClick={() => navigator.clipboard?.writeText(copy)}>复制</button>}
      </dd>
    </>
  )
  return (
    <aside className="drawer">
      {head}
      <div className="drawer-body">
        <div className="profile">
          <MarkEditor image={c.photo} onImage={(photo) => onSave({ ...c, photo })} hint="没有图片时按名字生成">
            <Avatar name={c.name} size={56} src={c.photo} />
          </MarkEditor>
          <div className="profile-text">
            <h2>{c.name}<Star on={c.starred} onClick={() => onSave({ ...c, starred: !c.starred })} /></h2>
            <div className="muted">{[c.title, c.company].filter(Boolean).join(' · ') || '未填写职位与公司'}</div>
          </div>
        </div>
        <div className="quick">
          <a className={cls('quick-btn', !c.phone && 'disabled')} href={c.phone ? `tel:${c.phone.replace(/\s/g, '')}` : undefined}>打电话</a>
          <a className={cls('quick-btn', !c.email && 'disabled')} href={c.email ? `mailto:${c.email}` : undefined}>发邮件</a>
          <button className="quick-btn" onClick={onTouch}>记一次联系</button>
        </div>
        <dl className="props">
          {row('分组', <GroupPill g={c.group} />)}
          {row('电话', c.phone && <span className="mono">{c.phone}</span>, c.phone || undefined)}
          {row('邮箱', c.email, c.email || undefined)}
          {row('标签', c.tags.length ? <span className="tags">{c.tags.map((t) => <span key={t} className="tag">{t}</span>)}</span> : null)}
          {row('最近联系', ago(c.last_contact_at))}
          {row('添加于', new Date(c.created_at).toLocaleDateString('zh-CN'))}
        </dl>
        <div className="section-label">IM 渠道</div>
        <div className="im-list">
          {IM_CHANNELS.map((ch) => {
            const id = c.im[ch.key]
            return (
              <div key={ch.key} className={cls('im-row', !id && 'im-row-empty')}>
                <ImMark ch={ch} />
                {id ? <span className="mono ellipsis">{id}</span> : <span className="faint">未填写</span>}
                <span className="spacer" />
                {id && ch.link && <a className="copy" href={ch.link(id)} target="_blank" rel="noreferrer">打开</a>}
                {id && <button className="copy" onClick={() => navigator.clipboard?.writeText(id)}>复制</button>}
              </div>
            )
          })}
        </div>
        <div className="section-label">备注</div>
        <div className="prose">{c.note ? c.note.split('\n').map((l, i) => <p key={i}>{l || ' '}</p>) : <p className="faint">还没有备注</p>}</div>
      </div>
      <div className="drawer-foot">
        {confirmDel ? (
          <>
            <span className="danger-text">确定删除「{c.name}」？{delImpact?.length ? `删除后${delImpact.join('；')}` : ''}</span>
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>取消</button>
            <button className="btn btn-danger" onClick={onDelete}>删除</button>
          </>
        ) : (
          <>
            <button className="btn btn-ghost btn-danger-ghost" onClick={() => setConfirmDel(true)}>删除</button>
            <div className="spacer" />
            <button className="btn btn-primary" onClick={() => { setDraft(c); setEditing(true) }}>编辑</button>
          </>
        )}
      </div>
    </aside>
  )
}
