// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置里的「技能」分节（AG-01b6），照原型 web-next/src/kbskills.tsx SkillsPage（SPEC-settings-15）。
// 来源分内置、自定义、插件三组（插件技能原型里没有，有才出现这一档）；点行开技能抽屉（SPEC-settings-16）。
import { useState } from 'react'
import { QueryState, usePlugins, useSkills, type Skill } from '../../../core/data'
import { Avatar, Button, cls, EmptyState, IconClose, IconSearch, PageTitle } from '../../../core/ui'
import { filterSkills, GROUP_LABEL, groupOf, type SourceFilter, type SourceGroup } from './model'
import { SkillDrawer } from './SkillDrawer'
import './skills.css'

// 新建（含复制）成功后换成编辑同一条，slot 沿用新建时的 key，抽屉不重新挂载；
// created 是创建回来的那条，列表还没刷回来时先用它
type Open = { mode: 'new'; from?: Skill; slot: string } | { mode: 'edit'; id: string; slot?: string; created?: Skill }

/** 行上的头像：露前几个，其余收成 +N */
const AVATARS = 5
/** 用到的工具最多露几个 */
const USES = 3

export function SkillsSection() {
  const q = useSkills()
  const plugins = usePlugins()
  const [open, setOpen] = useState<Open | null>(null)
  const [src, setSrc] = useState<SourceFilter>('')
  const [kw, setKw] = useState('')
  const [seq, setSeq] = useState(0)

  const list = q.data ?? []
  const rows = filterSkills(list, src, kw)
  const count = (g: SourceGroup) => list.filter((s) => groupOf(s) === g).length
  const groups: SourceGroup[] = ['builtin', 'custom', ...(count('plugin') ? ['plugin' as const] : [])]
  const pluginName = (id: string) => plugins.data?.find((p) => p.id === id)?.name ?? id
  const editing = open?.mode === 'edit' ? list.find((s) => s.id === open.id) ?? open.created : undefined

  const openNew = (from?: Skill) => {
    setSeq(seq + 1)
    setOpen({ mode: 'new', from, slot: `new-${seq + 1}` })
  }
  const openEdit = (id: string) => setOpen({ mode: 'edit', id })

  const sourceTag = (s: Skill) => {
    const g = groupOf(s)
    return (
      <span className={cls('tag', 'sk-src', g !== 'builtin' && `sk-src-${g}`)} title={g === 'plugin' ? `插件：${pluginName(s.source)}` : undefined}>
        {GROUP_LABEL[g]}
      </span>
    )
  }

  const row = (s: Skill) => (
    <div key={s.id} role="button" tabIndex={0} className={cls('sk-row', editing?.id === s.id && 'sel')} data-skill={s.id}
      onClick={() => openEdit(s.id)} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openEdit(s.id) }}>
      <span className="sk-main">
        <span className="sk-name ellipsis">{s.name}</span>
        <span className="sk-desc ellipsis">{s.desc}</span>
      </span>
      <span>{sourceTag(s)}</span>
      <span className="sk-uses">
        {s.uses.slice(0, USES).map((u) => <span key={u} className="sk-use" title={u}>{u}</span>)}
        {s.uses.length > USES && <span className="sk-use" title={s.uses.slice(USES).join('、')}>+{s.uses.length - USES}</span>}
      </span>
      <span className="sk-users" title={s.agents.length > AVATARS ? s.agents.map((a) => a.name).join('、') : undefined}>
        {s.agents.length ? s.agents.slice(0, AVATARS).map((a) => <Avatar key={a.id} name={a.name} size={20} title={a.name} />)
          : <span className="sk-muted">没有 Agent 在用</span>}
        {s.agents.length > AVATARS && <span className="sk-more">+{s.agents.length - AVATARS}</span>}
      </span>
    </div>
  )

  return (
    <div className="page sk-page">
      <PageTitle parent="设置" count={q.data ? list.length : undefined}
        desc="可复用的做事方法：说明怎么做、什么时候用、用到哪些工具；挂到 Agent 上就会按它做"
        actions={<Button variant="primary" onClick={() => openNew()}>新建技能</Button>}>技能</PageTitle>
      <QueryState query={q}>
        {() => (
          <>
            <div className="sk-toolbar">
              <div className="sk-seg" role="group" aria-label="来源">
                {(['', ...groups] as SourceFilter[]).map((k) => (
                  <button key={k} type="button" className={cls(src === k && 'on')} aria-pressed={src === k} onClick={() => setSrc(k)}>
                    {k ? GROUP_LABEL[k] : '全部'}<span className="seg-n">{k ? count(k) : list.length}</span>
                  </button>
                ))}
              </div>
              <div className="search">
                <IconSearch />
                <input type="search" placeholder="搜技能名称、说明、用到的工具" aria-label="搜索技能" value={kw} onChange={(e) => setKw(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape' && kw) { e.preventDefault(); setKw('') } }} />
                {kw && <button type="button" className="search-clear" aria-label="清空" title="清空" onClick={() => setKw('')}><IconClose size={10} /></button>}
              </div>
            </div>
            {!rows.length ? (list.length
              ? <EmptyState title="没有匹配的技能" desc="换个关键词或来源试试" />
              : <EmptyState title="还没有技能" desc="点右上角「新建技能」" />)
              : (
                <div className="sk-table">
                  <div className="sk-row sk-th"><span>技能</span><span>来源</span><span>用到</span><span>在用的 Agent</span></div>
                  {rows.map(row)}
                </div>
              )}
          </>
        )}
      </QueryState>

      {open?.mode === 'new' ? (
        <SkillDrawer key={open.slot} copyFrom={open.from}
          onCreated={(s) => setOpen({ mode: 'edit', id: s.id, slot: open.slot, created: s })}
          onDuplicate={openNew} onClose={() => setOpen(null)} />
      ) : open && editing ? (
        <SkillDrawer key={open.slot ?? editing.id} skill={editing} pluginName={pluginName(editing.source)}
          onCreated={() => undefined} onDuplicate={openNew} onClose={() => setOpen(null)} />
      ) : null}
    </div>
  )
}
