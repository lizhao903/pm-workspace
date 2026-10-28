// 联系人列表（SPEC-contacts-1，CT-03a）：搜索、分组和渠道筛选、星标、按最近联系或姓名首字母分段、每次渲染 100 行。
// 联系人就是干系人名册（/api/stakeholders），一次拉全在前端筛；打开的联系人放在地址里（?c=<id>），别的模块可以直接链过来。
// IM 身份（/api/im-identities）也一次拉全，按联系人合进 im；新建、编辑、删除在抽屉里（CT-03b）。
import { Fragment, useCallback, useDeferredValue, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { errorText, identitiesByContact, useContacts, useDictionaries, useIdentities, useSetContactStarred } from '../../core/data'
import { Avatar, Button, ErrorState, IconClose, IconSearch, LoadingState, PageTitle, SearchSelect, cls } from '../../core/ui'
import { ContactForm } from './ContactForm'
import { ContactView } from './ContactView'
import { GroupPill, ImBadges, Star } from './parts'
import {
  DEFAULT_GROUP, IM_CHANNELS, PAGE, ago, applyFilter, blankDraft, draftOf, groupItems, groupOf, groupView, hasImField, sectionCounts,
  sectionOf, toRows, mergeIm, type Sort,
} from './model'
import './contacts.css'

export default function Page() {
  const contacts = useContacts()
  const dicts = useDictionaries({ withItems: true })
  const star = useSetContactStarred()
  const identities = useIdentities()
  // 抽屉的表单态：新建，或编辑地址里打开的那个人
  const [form, setForm] = useState<'create' | 'edit' | null>(null)
  const [params, setParams] = useSearchParams()
  const openId = params.get('c')
  const [q, setQ] = useState('')
  const dq = useDeferredValue(q)
  const [group, setGroup] = useState<string | null>(null)
  const [starredOnly, setStarredOnly] = useState(false)
  const [channel, setChannel] = useState('')
  const [sort, setSort] = useState<Sort>('recent')

  const setOpen = useCallback((id: string | null) => {
    // 换人或关掉都回到查看态
    setForm(null)
    setParams((p) => {
      const n = new URLSearchParams(p)
      if (id) n.set('c', id)
      else n.delete('c')
      return n
    }, { replace: true })
  }, [setParams])

  // 身份接口能用才合进 im；不能用（老后端 404、出错）时不显示 IM 列，和 CT-03a 一样
  const byContact = useMemo(() => (identities.data ? identitiesByContact(identities.data) : null), [identities.data])
  const list = useMemo(() => mergeIm(contacts.data ?? [], byContact), [contacts.data, byContact])
  const items = useMemo(() => groupItems(dicts.data), [dicts.data])
  const all = useMemo(() => toRows(list), [list])
  const rows = useMemo(() => applyFilter(all, { q: dq, group, starredOnly, channel, sort }), [all, dq, group, starredOnly, channel, sort])
  const counts = useMemo(() => sectionCounts(rows, sort), [rows, sort])
  const gv = useMemo(() => groupView(items, list), [items, list])
  const withIm = hasImField(list)

  // 先渲染 PAGE 行；筛选、搜索或排序一变就回到前 PAGE 行
  const sig = [group, starredOnly, channel, dq.trim(), sort].join('|')
  // 条件变了就在渲染时重置（React 允许的「随输入调整状态」写法）；只比 sig 不重置的话，改回原条件会恢复成之前展开的行数
  const [lim, setLim] = useState({ sig, n: PAGE })
  if (lim.sig !== sig) setLim({ sig, n: PAGE })
  const limit = lim.sig === sig ? lim.n : PAGE
  const shown = rows.slice(0, limit)
  const opened = openId ? list.find((c) => c.id === openId) ?? null : null

  const nameOf = (id: string) => list.find((c) => c.id === id)?.name ?? '另一个联系人'
  const title = (
    <PageTitle count={contacts.data ? list.length : undefined} desc="客户、合作伙伴、同事和供应商，按最近联系排序"
      actions={<Button variant="primary" size="sm" onClick={() => setForm('create')}>新建联系人</Button>}>联系人</PageTitle>
  )
  if (contacts.isPending) return <div className="ct-page">{title}<LoadingState /></div>
  if (contacts.isError && !contacts.data) {
    return (
      <div className="ct-page">
        {title}
        <ErrorState title="联系人没加载出来" error={errorText(contacts.error)} onRetry={() => void contacts.refetch()} />
      </div>
    )
  }

  return (
    <div className="ct-page">
      {title}
      <div className="toolbar ct-toolbar">
        <div className="search">
          <IconSearch />
          <input type="search" placeholder="搜索姓名、公司、电话、邮箱、标签" aria-label="搜索联系人" value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.preventDefault(); setQ('') } }} />
          {q && <button type="button" className="search-clear" aria-label="清空" title="清空" onClick={() => setQ('')}><IconClose size={10} /></button>}
        </div>
        <div className="seg" role="group" aria-label="分组">
          <button type="button" className={cls(!group && 'on')} aria-pressed={!group} onClick={() => setGroup(null)}>
            全部<span className="seg-n">{list.length}</span>
          </button>
          {gv.seg.map((g) => (
            <button key={g.key} type="button" className={cls(group === g.key && 'on')} aria-pressed={group === g.key} onClick={() => setGroup(g.key)}>
              {g.label}<span className="seg-n">{gv.countOf(g.key)}</span>
            </button>
          ))}
        </div>
        {gv.more.length > 0 && (
          <SearchSelect value={group && gv.more.some((g) => g.key === group) ? group : ''} placeholder={`更多分组 ${gv.more.length}`}
            searchPlaceholder="搜分组" aria-label="更多分组"
            options={gv.more.map((g) => ({ value: g.key, label: g.label, hint: `${gv.countOf(g.key)} 人${g.enabled ? '' : ' · 已停用'}` }))}
            onChange={(v) => setGroup(v || null)} />
        )}
        <button type="button" className={cls('chip', starredOnly && 'chip-on')} aria-pressed={starredOnly} onClick={() => setStarredOnly(!starredOnly)}>只看星标</button>
        {withIm && (
          <label className={cls('chip chip-select', channel && 'chip-on')}>
            <select value={channel} aria-label="IM 渠道" onChange={(e) => setChannel(e.target.value)}>
              <option value="">IM 渠道：不限</option>
              {IM_CHANNELS.map((ch) => (
                <option key={ch.key} value={ch.key}>有{ch.label}（{list.filter((c) => c.im?.[ch.key]).length}）</option>
              ))}
            </select>
          </label>
        )}
        <div className="spacer" />
        <label className="ct-sort">
          排序
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="recent">最近联系</option>
            <option value="name">姓名</option>
          </select>
        </label>
      </div>

      {star.isError && <div className="ct-err" role="alert">星标没改成：{errorText(star.error)}</div>}

      {list.length === 0 ? (
        <div className="empty">
          <div className="empty-title">还没有联系人</div>
          <div className="empty-desc">把常打交道的人记下来，找人时不用翻聊天记录</div>
        </div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="empty-title">没有匹配的联系人</div>
          <div className="empty-desc">换个关键词，或清掉分组、星标和渠道筛选</div>
        </div>
      ) : (
        <div className={cls('ct-table', !withIm && 'ct-no-im')} role="table" aria-label="联系人" aria-rowcount={rows.length}>
          <div className="ct-tr ct-th" role="row">
            <span role="columnheader" aria-label="星标" /><span role="columnheader">姓名</span><span role="columnheader">公司</span>
            <span role="columnheader">分组</span><span role="columnheader">电话</span>
            {withIm && <span role="columnheader">IM 渠道</span>}
            <span role="columnheader">邮箱</span><span role="columnheader">最近联系</span>
          </div>
          {shown.map((r, i) => {
            const c = r.c
            const sec = sectionOf(r, sort)
            return (
              <Fragment key={c.id}>
                {/* 每段第一行前插分段标题：最近联系按时间，姓名按首字母 */}
                {(i === 0 || sectionOf(shown[i - 1], sort) !== sec) && (
                  <div className="ct-sec" role="row"><span role="rowheader">{sec}</span><span className="seg-n">{counts.get(sec)}</span></div>
                )}
                <div role="row" tabIndex={0} aria-label={c.name} aria-selected={openId === c.id} className={cls('ct-tr', openId === c.id && 'sel')}
                  onClick={() => setOpen(c.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) setOpen(c.id) }}>
                  <span role="cell"><Star on={c.starred} name={c.name} onToggle={() => star.mutate({ id: c.id, on: !c.starred })} /></span>
                  <span role="cell" className="ct-who">
                    <Avatar name={c.name} src={c.photo || undefined} />
                    <span className="ct-who-text">
                      <span className="ct-who-name ellipsis">{c.name}</span>
                      {c.title && <span className="ct-who-title ellipsis">{c.title}</span>}
                    </span>
                  </span>
                  <span role="cell" className="ellipsis">{c.company || <span className="faint">-</span>}</span>
                  <span role="cell"><GroupPill items={items} g={groupOf(c)} /></span>
                  <span role="cell" className="ct-mono ellipsis">{c.phone || <span className="faint">-</span>}</span>
                  {withIm && <span role="cell"><ImBadges im={c.im ?? {}} /></span>}
                  <span role="cell" className="ellipsis">{c.email || <span className="faint">-</span>}</span>
                  <span role="cell" className="muted">{ago(c.last_contact_at) ?? <span className="faint">未联系</span>}</span>
                </div>
              </Fragment>
            )
          })}
          {rows.length > limit && (
            <button type="button" className="ct-more" onClick={() => setLim({ sig, n: limit + PAGE })}>
              显示更多<span className="seg-n">还有 {rows.length - limit} 人</span>
            </button>
          )}
        </div>
      )}

      {form === 'create' ? (
        <ContactForm key="create" contact={null} initial={blankDraft(DEFAULT_GROUP)} groups={items} identities={identities.data} nameOf={nameOf}
          onCancel={() => setForm(null)} onClose={() => setForm(null)}
          onSaved={(r) => { if (!r.failed.length) { setForm(null); setOpen(r.contact.id) } }} />
      ) : form === 'edit' && opened ? (
        <ContactForm key={`edit:${opened.id}`} contact={opened} initial={draftOf(opened)} groups={items} identities={identities.data}
          nameOf={nameOf} onCancel={() => setForm(null)} onClose={() => { setForm(null); setOpen(null) }}
          onSaved={(r) => { if (!r.failed.length) setForm(null) }} />
      ) : openId && (
        <ContactView key={openId} contact={opened} groups={items} imCount={opened ? byContact?.get(opened.id)?.length ?? 0 : 0}
          onEdit={() => setForm('edit')} onClose={() => setOpen(null)}
          star={<Star on={!!opened?.starred} name={opened?.name ?? ''} onToggle={() => opened && star.mutate({ id: opened.id, on: !opened.starred })} />} />
      )}
    </div>
  )
}
