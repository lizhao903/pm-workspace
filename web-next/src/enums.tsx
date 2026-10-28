import { useEffect, useMemo, useState } from 'react'
import { PageTitle } from './topbar'
import { ENUM_COLORS, KEY_RE, MODULES, type EnumGroup, type EnumItem } from './enumdata'
import { cls } from './ui'

// 枚举值管理：左边枚举列表（按模块分组），右边是选中枚举的值。改动先攒在草稿里，保存才生效

/** 每个值被多少条数据用着；没接数据的枚举返回空 */
export type UsageFn = (group: string, key: string) => number | undefined

function ColorPick({ value, onChange, disabled }: { value: string; onChange: (c: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="menu-wrap">
      <button className="color-dot" style={{ background: value }} disabled={disabled} onClick={() => setOpen(!open)} title="改颜色" />
      {open && (
        <span className="menu color-menu" onMouseLeave={() => setOpen(false)}>
          {ENUM_COLORS.map((c) => <button key={c} className={cls('color-dot', c === value && 'on')} style={{ background: c }} onClick={() => { onChange(c); setOpen(false) }} />)}
        </span>
      )}
    </span>
  )
}

export function EnumsPage({ groups, usage, onSave, onMigrate, onDeleteGroup }: {
  groups: EnumGroup[]
  usage: UsageFn
  onSave: (g: EnumGroup) => void
  /** 删除一个被用过的值时，把数据里的 from 改成 to */
  onMigrate: (group: string, from: string, to: string) => void
  onDeleteGroup: (key: string) => void
}) {
  const [active, setActive] = useState(groups[0]?.key ?? '')
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const current = groups.find((g) => g.key === active)
  const kw = q.trim().toLowerCase()
  const shown = groups.filter((g) => !kw || [g.name, g.key, g.desc, ...g.items.map((i) => i.label)].some((v) => v.toLowerCase().includes(kw)))

  return (
    <div className="enum-page">
      <div className="enum-list">
        <div className="enum-list-head">
          <PageTitle parent="设置" count={groups.length}>枚举值</PageTitle>
          <span className="list-sub">按模块分组</span>
          <button className="act" onClick={() => setCreating(true)}>新建枚举</button>
        </div>
        <div className="search search-full search-sm">
          <svg viewBox="0 0 16 16" width="13" height="13"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input placeholder="搜索枚举或值" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="enum-groups">
          {MODULES.filter((m) => shown.some((g) => g.module === m)).map((m) => (
            <div key={m}>
              <div className="subnav-group">{m}</div>
              {shown.filter((g) => g.module === m).map((g) => (
                <button key={g.key} className={cls('enum-g', g.key === active && !creating && 'on')} onClick={() => { setActive(g.key); setCreating(false) }}>
                  <span className="ellipsis">{g.name}</span>
                  <span className="enum-g-dots">{g.items.filter((i) => i.enabled).slice(0, 5).map((i) => <i key={i.key} style={{ background: i.color }} />)}</span>
                  <span className="tree-count">{g.items.length}</span>
                </button>
              ))}
            </div>
          ))}
          {!shown.length && <div className="tree-empty">没有匹配的枚举</div>}
        </div>
      </div>
      {creating ? (
        <NewGroup taken={groups.map((g) => g.key)} onCancel={() => setCreating(false)} onCreate={(g) => { onSave(g); setActive(g.key); setCreating(false) }} />
      ) : current ? (
        <GroupEditor key={current.key} group={current} usage={usage} onSave={onSave} onMigrate={onMigrate}
          onDelete={() => { onDeleteGroup(current.key); setActive(groups.find((g) => g.key !== current.key)?.key ?? '') }} />
      ) : <div className="lib-reader-empty">选一个枚举</div>}
    </div>
  )
}

function NewGroup({ taken, onCancel, onCreate }: { taken: string[]; onCancel: () => void; onCreate: (g: EnumGroup) => void }) {
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [desc, setDesc] = useState('')
  const [tried, setTried] = useState(false)
  const keyErr = !key.trim() ? '必填' : !KEY_RE.test(key) ? '只能用字母、数字、下划线和中划线' : taken.includes(key) ? '已经有这个 key 了' : ''
  const create = () => {
    setTried(true)
    if (!name.trim() || keyErr) return
    onCreate({ key, name: name.trim(), module: '自定义', desc, builtin: false, items: [{ key: 'v1', label: '选项 1', color: ENUM_COLORS[0], desc: '', enabled: true }] })
  }
  return (
    <div className="enum-editor">
      <div className="list-head"><div><h1 className="list-title">新建枚举</h1><div className="list-sub">自定义枚举建好后，可以在以后的自定义字段里引用</div></div></div>
      <div className="form enum-new">
        <label className="field">
          <span className="field-label">名称<em>*</em></span>
          <input value={name} placeholder="比如：客户行业" className={cls(tried && !name.trim() && 'bad')} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Key<em>*</em><span className="field-hint">数据里存的标识，创建后不能改</span></span>
          <input className={cls('mono-input', tried && keyErr && 'bad')} value={key} placeholder="customer_industry" onChange={(e) => setKey(e.target.value.trim())} />
          {tried && keyErr && <span className="field-err">{keyErr}</span>}
        </label>
        <label className="field">
          <span className="field-label">说明</span>
          <input value={desc} onChange={(e) => setDesc(e.target.value)} />
        </label>
        <div className="act-row">
          <button className="btn btn-primary" onClick={create}>创建</button>
          <button className="btn btn-ghost" onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>
  )
}

function GroupEditor({ group, usage, onSave, onMigrate, onDelete }: {
  group: EnumGroup
  usage: UsageFn
  onSave: (g: EnumGroup) => void
  onMigrate: (group: string, from: string, to: string) => void
  onDelete: () => void
}) {
  const [d, setD] = useState(group)
  const [removing, setRemoving] = useState<{ key: string; to: string } | null>(null)
  /** 待保存的合并：保存时才真的改数据 */
  const [merges, setMerges] = useState<{ from: string; to: string }[]>([])
  const [tried, setTried] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => { setD(group); setMerges([]) }, [group])

  const dirty = JSON.stringify(d) !== JSON.stringify(group)
  const useOf = (k: string) => usage(group.key, k)
  const wired = group.items.some((i) => useOf(i.key) !== undefined)
  const patch = (k: string, p: Partial<EnumItem>) => setD({ ...d, items: d.items.map((i) => (i.key === k ? { ...i, ...p } : i)) })
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= d.items.length) return
    const items = [...d.items]
    ;[items[i], items[j]] = [items[j], items[i]]
    setD({ ...d, items })
  }
  const isNew = (k: string) => !group.items.some((i) => i.key === k)
  const errors = useMemo(() => {
    const out: string[] = []
    const keys = d.items.map((i) => i.key)
    d.items.forEach((i, n) => {
      if (!i.label.trim()) out.push(`第 ${n + 1} 个值没有显示名`)
      if (!KEY_RE.test(i.key)) out.push(`「${i.label || i.key}」的 key 只能用字母、数字、下划线和中划线`)
      else if (keys.indexOf(i.key) !== n) out.push(`key「${i.key}」重复了`)
    })
    if (!d.items.some((i) => i.enabled)) out.push('至少保留一个启用的值')
    if (d.default_key && !d.items.some((i) => i.key === d.default_key && i.enabled)) out.push('默认值必须是一个启用的值')
    return out
  }, [d])

  const add = () => {
    let n = d.items.length + 1
    while (d.items.some((i) => i.key === `v${n}`)) n += 1
    setD({ ...d, items: [...d.items, { key: `v${n}`, label: '', color: ENUM_COLORS[d.items.length % ENUM_COLORS.length], desc: '', enabled: true }] })
  }
  const askRemove = (k: string) => {
    const used = useOf(k) ?? 0
    if (!used || isNew(k)) { setD({ ...d, items: d.items.filter((i) => i.key !== k), default_key: d.default_key === k ? undefined : d.default_key }); return }
    setRemoving({ key: k, to: d.items.find((i) => i.key !== k && i.enabled)?.key ?? '' })
  }
  const confirmRemove = () => {
    if (!removing?.to) return
    setMerges((m) => [...m, { from: removing.key, to: removing.to }])
    setD({ ...d, items: d.items.filter((i) => i.key !== removing.key), default_key: d.default_key === removing.key ? removing.to : d.default_key })
    setRemoving(null)
  }
  const save = () => {
    setTried(true)
    if (errors.length) return
    merges.forEach((m) => onMigrate(group.key, m.from, m.to))
    onSave({ ...d, items: d.items.map((i) => ({ ...i, label: i.label.trim() })) })
    setMerges([])
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1600)
  }

  return (
    <div className="enum-editor">
      <div className="list-head">
        <div>
          <h1 className="list-title">
            {group.builtin ? d.name : <input className="editor-title enum-title" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />}
            <span className="enum-key">{group.key}</span>
            {group.builtin && <span className="tag">内置</span>}
          </h1>
          <div className="list-sub">{d.desc}</div>
        </div>
      </div>

      <div className="enum-table">
        <div className="enum-row enum-th">
          <span>顺序</span><span>颜色</span><span>显示名</span><span>Key</span><span>说明</span><span>{wired ? '使用中' : ''}</span><span>默认</span><span>启用</span><span />
        </div>
        {d.items.map((i, n) => {
          const used = useOf(i.key)
          return (
            <div key={i.key + n} className={cls('enum-row', !i.enabled && 'off')}>
              <span className="enum-order">
                <button className="icon-btn icon-btn-sm" disabled={n === 0} onClick={() => move(n, -1)} title="上移">
                  <svg viewBox="0 0 16 16" width="11" height="11"><path d="m4 10 4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
                <button className="icon-btn icon-btn-sm" disabled={n === d.items.length - 1} onClick={() => move(n, 1)} title="下移">
                  <svg viewBox="0 0 16 16" width="11" height="11"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </span>
              <span><ColorPick value={i.color} onChange={(c) => patch(i.key, { color: c })} /></span>
              <span className="enum-label">
                <input value={i.label} placeholder="显示名" className={cls(tried && !i.label.trim() && 'bad')} onChange={(e) => patch(i.key, { label: e.target.value })} />
              </span>
              <span>
                {isNew(i.key)
                  ? <input className="mono-input" value={i.key} onChange={(e) => setD({ ...d, items: d.items.map((x, k) => (k === n ? { ...x, key: e.target.value.trim() } : x)), default_key: d.default_key === i.key ? e.target.value.trim() : d.default_key })} />
                  : <code className="enum-k" title="key 创建后不能改">{i.key}</code>}
              </span>
              <span><input className="enum-desc" value={i.desc} placeholder="说明（可选）" onChange={(e) => patch(i.key, { desc: e.target.value })} /></span>
              <span className="run-muted">{used === undefined ? '' : `${used} 条`}</span>
              <span><input type="radio" name={`def-${group.key}`} checked={d.default_key === i.key} disabled={!i.enabled} onChange={() => setD({ ...d, default_key: i.key })} title="新建时默认选这个" /></span>
              <span>
                <label className={cls('switch-line', i.locked && 'disabled')} title={i.locked ? '系统值，程序逻辑依赖它，不能停用' : i.enabled ? '停用后新建和编辑时不再出现，已有数据照常显示' : '启用'}>
                  <input type="checkbox" checked={i.enabled} disabled={i.locked || d.default_key === i.key} onChange={(e) => patch(i.key, { enabled: e.target.checked })} />
                  <span className="switch" />
                </label>
              </span>
              <span>
                {i.locked
                  ? <span className="enum-lock" title="系统值：可以改显示名、颜色和说明，不能停用或删除">系统值</span>
                  : <button className="act act-quiet btn-danger-ghost" onClick={() => askRemove(i.key)}>删除</button>}
              </span>
            </div>
          )
        })}
        {removing && (
          <div className="enum-merge">
            <span>「{d.items.find((i) => i.key === removing.key)?.label}」有 {useOf(removing.key)} 条数据在用，删除前要把它们合并到：</span>
            <select value={removing.to} onChange={(e) => setRemoving({ ...removing, to: e.target.value })}>
              {d.items.filter((i) => i.key !== removing.key && i.enabled).map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}
            </select>
            <button className="act act-primary" disabled={!removing.to} onClick={confirmRemove}>合并并删除</button>
            <button className="act act-quiet" onClick={() => setRemoving(null)}>取消</button>
          </div>
        )}
        <button className="enum-add" onClick={add}>加一个值</button>
      </div>

      {merges.length > 0 && (
        <div className="banner banner-warn enum-pending">
          保存后会改动数据：{merges.map((m) => `${useOf(m.from)} 条「${group.items.find((i) => i.key === m.from)?.label}」改为「${d.items.find((i) => i.key === m.to)?.label}」`).join('；')}
        </div>
      )}
      {tried && errors.length > 0 && <div className="editor-issues has-error"><ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul></div>}

      <div className="hook-foot enum-foot">
        {confirmDel ? (
          <>
            <span className="danger-text">删除整个枚举「{group.name}」？</span>
            <span className="spacer" />
            <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>取消</button>
            <button className="btn btn-danger" onClick={onDelete}>删除</button>
          </>
        ) : (
          <>
            {!group.builtin && <button className="btn btn-ghost btn-danger-ghost" onClick={() => setConfirmDel(true)}>删除枚举</button>}
            <span className="spacer" />
            {dirty && <button className="btn btn-ghost" onClick={() => { setD(group); setMerges([]); setTried(false) }}>放弃修改</button>}
            <button className="btn btn-primary" disabled={!dirty} onClick={save}>{saved ? '已保存' : dirty ? '保存' : '没有修改'}</button>
          </>
        )}
      </div>
    </div>
  )
}
