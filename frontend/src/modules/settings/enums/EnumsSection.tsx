// 设置里的「枚举值」（ALIGN-14），照原型 web-next/src/enums.tsx EnumsPage（SPEC-settings-17）。
// 左边按模块分组的字典，右边选中字典的值；改动攒在草稿里，保存时按差异写 /api/dictionaries 的接口。
// 后端没有建字典、删字典、合并数据的接口：「新建枚举」置灰，被用过的值不能删，只能停用。
import { Fragment, useEffect, useMemo, useState } from 'react'
import { errorText, useDictionaries, useDictItemsAll, useSaveDictItems } from '../../../core/data'
import { Button, cls, ErrorState, IconButton, IconSearch, LoadingState, PageTitle, Switch } from '../../../core/ui'
import { ENUM_COLORS, FIXED, MANY, matchGroup, MODULES, newItem, planEmpty, sameGroup, savePlan, toGroup, validate, type EnumGroup, type EnumItem } from './model'
import './enums.css'

export function EnumsSection() {
  const dq = useDictionaries()
  const dicts = useMemo(() => dq.data ?? [], [dq.data])
  const iq = useDictItemsAll(dicts.map((d) => d.id))
  const failed = dq.error ?? iq.find((q) => q.error)?.error
  const ready = !!dq.data && iq.every((q) => q.data)
  const groups = ready ? dicts.map((d, n) => toGroup(d, iq[n].data!)) : []

  const [active, setActive] = useState('')
  const [q, setQ] = useState('')
  const [dirty, setDirty] = useState(false)
  const [leaveTo, setLeaveTo] = useState<string | null>(null)
  const current = groups.find((g) => g.key === active) ?? groups[0]
  const pick = (key: string) => {
    if (dirty && key !== current?.key) { setLeaveTo(key); return }
    setActive(key)
    setLeaveTo(null)
  }
  const shown = groups.filter((g) => matchGroup(g, q))

  if (failed) return <ErrorState error={failed} onRetry={() => { void dq.refetch(); iq.forEach((x) => { if (x.error) void x.refetch() }) }} />
  if (!ready) return <LoadingState />

  return (
    <div className="en-page">
      <PageTitle parent="设置" count={groups.length}>枚举值</PageTitle>
      <div className="en-list">
        <div className="en-list-head">
          <span className="en-sub">按模块分组</span>
          <Button variant="outline" size="sm" disabled title="暂不支持新建枚举">新建枚举</Button>
        </div>
        <label className="search search-full search-sm">
          <IconSearch />
          <input placeholder="搜索枚举或值" aria-label="搜索枚举或值" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="en-groups">
          {MODULES.filter((m) => shown.some((g) => g.module === m)).map((m) => (
            <div key={m} role="group" aria-label={m}>
              <div className="en-mod">{m}</div>
              {shown.filter((g) => g.module === m).map((g) => (
                <button key={g.key} type="button" className={cls('en-g', g.key === current?.key && 'on')} aria-current={g.key === current?.key || undefined}
                  onClick={() => pick(g.key)}>
                  <span className="ellipsis">{g.name}</span>
                  <span className="en-g-dots" aria-hidden="true">{g.items.filter((i) => i.enabled).slice(0, 5).map((i) => <i key={i.key} style={{ background: i.color }} />)}</span>
                  <span className="en-count">{g.items.length}</span>
                </button>
              ))}
            </div>
          ))}
          {!shown.length && <div className="en-empty">没有匹配的枚举</div>}
        </div>
      </div>
      {current ? (
        <GroupEditor key={current.key} group={current} onDirty={setDirty} leaving={!!leaveTo} onStay={() => setLeaveTo(null)}
          onLeave={() => { if (leaveTo) { setDirty(false); setActive(leaveTo); setLeaveTo(null) } }} />
      ) : <div className="en-none">选一个枚举</div>}
    </div>
  )
}

function ColorPick({ value, onChange, disabled }: { value: string; onChange: (c: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="en-color-wrap">
      <button type="button" className="en-dot" style={{ background: value }} disabled={disabled} aria-label="改颜色" title="改颜色" aria-expanded={open}
        onClick={() => setOpen(!open)} />
      {open && (
        <span className="menu en-color-menu" onMouseLeave={() => setOpen(false)}>
          {ENUM_COLORS.map((c) => (
            <button key={c} type="button" className={cls('en-dot', c === value && 'on')} style={{ background: c }} aria-label={'颜色 ' + c}
              onClick={() => { onChange(c); setOpen(false) }} />
          ))}
        </span>
      )}
    </span>
  )
}

const Up = () => <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="m4 10 4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
const Down = () => <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>

function GroupEditor({ group, onDirty, leaving, onStay, onLeave }: {
  group: EnumGroup
  onDirty: (dirty: boolean) => void
  /** 左栏点了别的枚举、草稿还没保存：底栏换成确认 */
  leaving: boolean
  onStay: () => void
  onLeave: () => void
}) {
  const save = useSaveDictItems()
  const [d, setD] = useState(group)
  // 库里的值变了（保存完刷新、别处改了）：草稿没改过或刚保存过就跟上
  const sig = JSON.stringify(group)
  const [seen, setSeen] = useState(sig)
  const [follow, setFollow] = useState(false)
  if (sig !== seen) {
    const prev = JSON.parse(seen) as EnumGroup
    setSeen(sig)
    if (follow || sameGroup(d, prev) || sameGroup(d, group)) { setD(group); setFollow(false) }
  }
  const [removing, setRemoving] = useState<string | null>(null)
  const [tried, setTried] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveErr, setSaveErr] = useState('')
  const [q, setQ] = useState('')
  const [showOff, setShowOff] = useState(false)

  const dirty = !sameGroup(d, group)
  useEffect(() => { onDirty(dirty) }, [dirty, onDirty])
  useEffect(() => {
    if (!saved) return
    const t = window.setTimeout(() => setSaved(false), 1600)
    return () => window.clearTimeout(t)
  }, [saved])

  const wired = group.items.some((i) => i.usage !== undefined)
  const fixed = FIXED.has(group.key)
  const patch = (k: string, p: Partial<EnumItem>) => setD({ ...d, items: d.items.map((i) => (i.key === k ? { ...i, ...p } : i)) })
  const isNew = (i: EnumItem) => !i.id
  const many = d.items.length > MANY
  const kw = q.trim().toLowerCase()
  // 沉底的只算保存过的停用值；这次刚关掉的留在原位，免得一点就跳走
  const sunk = (i: EnumItem) => many && !i.enabled && group.items.some((g) => g.key === i.key && !g.enabled)
  const indexed = d.items.map((i, n) => ({ i, n }))
  const matched = kw ? indexed.filter(({ i }) => `${i.label} ${i.key} ${i.desc}`.toLowerCase().includes(kw)) : null
  const live = matched ?? indexed.filter(({ i }) => !sunk(i))
  const off = matched ? [] : indexed.filter(({ i }) => sunk(i))
  const visible = [...live, ...(showOff ? off : [])]
  // 上下移只在同一段里挪：跳过收起的停用值
  const move = (i: number, dir: -1 | 1) => {
    let j = i + dir
    while (j >= 0 && j < d.items.length && sunk(d.items[j]) !== sunk(d.items[i])) j += dir
    if (j < 0 || j >= d.items.length) return
    const items = [...d.items]
    ;[items[i], items[j]] = [items[j], items[i]]
    setD({ ...d, items })
  }
  const errors = useMemo(() => validate(d), [d])

  const add = () => {
    setQ('')
    setD({ ...d, items: [...d.items, newItem(d)] })
  }
  const askRemove = (i: EnumItem) => {
    if (!i.usage || isNew(i)) {
      setD({ ...d, items: d.items.filter((x) => x.key !== i.key), default_key: d.default_key === i.key ? undefined : d.default_key })
      if (removing === i.key) setRemoving(null)
      return
    }
    setRemoving(i.key)
  }
  const removingItem = d.items.find((i) => i.key === removing)
  const reset = () => { setD(group); setTried(false); setSaveErr(''); setRemoving(null) }
  const submit = async () => {
    setTried(true)
    setSaveErr('')
    if (errors.length) return
    const plan = savePlan(group, { ...d, items: d.items.map((i) => ({ ...i, label: i.label.trim() })) })
    if (planEmpty(plan)) return
    setFollow(true)
    try {
      await save.mutateAsync({ plan, current: group.items.flatMap((i) => (i.id ? [{ key: i.key, id: i.id }] : [])) })
      setTried(false)
      setSaved(true)
    } catch (e) {
      setSaveErr(errorText(e))
    }
  }

  return (
    <div className="en-editor">
      <div className="en-head">
        <h2 className="en-title">
          {group.name}
          <span className="en-key">{group.key}</span>
          {group.builtin && <span className="tag">内置</span>}
        </h2>
        <div className="en-sub">{group.desc}</div>
      </div>

      {many && (
        <div className="en-toolbar">
          <label className="search search-sm">
            <IconSearch />
            <input placeholder="搜值：显示名、Key、说明" aria-label="搜值" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <span className="en-sub">{matched ? `命中 ${matched.length} / ${d.items.length} 个` : `${d.items.length} 个值，${d.items.filter((i) => !i.enabled).length} 个停用`}</span>
        </div>
      )}
      <div className="en-table" role="table" aria-label={group.name + '的值'}>
        <div className="en-row en-th" role="row">
          <span role="columnheader">顺序</span><span role="columnheader">颜色</span><span role="columnheader">显示名</span>
          <span role="columnheader">Key</span><span role="columnheader">说明</span><span role="columnheader">{wired ? '使用中' : ''}</span>
          <span role="columnheader">默认</span><span role="columnheader">启用</span><span role="columnheader" />
        </div>
        {visible.map(({ i, n }, vi) => {
          const sameSeg = (k: number) => k >= 0 && k < d.items.length && sunk(d.items[k]) === sunk(i)
          const canUp = !kw && indexed.slice(0, n).some(({ n: k }) => sameSeg(k))
          const canDown = !kw && indexed.slice(n + 1).some(({ n: k }) => sameSeg(k))
          const name = i.label || i.key
          return (
            <Fragment key={(i.id ?? 'new') + i.key + n}>
              {/* 收起的停用值展开后，接在启用值后面，中间插一条收起按钮 */}
              {vi === live.length && off.length > 0 && (
                <button type="button" className="en-add en-off-toggle" onClick={() => setShowOff(false)}>收起已停用的 {off.length} 个</button>
              )}
              <div className={cls('en-row', !i.enabled && 'off')} role="row" aria-label={name}>
                <span className="en-order">
                  <IconButton size="sm" label="上移" title={kw ? '搜索时不能调顺序' : '上移'} disabled={!canUp} onClick={() => move(n, -1)}><Up /></IconButton>
                  <IconButton size="sm" label="下移" title={kw ? '搜索时不能调顺序' : '下移'} disabled={!canDown} onClick={() => move(n, 1)}><Down /></IconButton>
                </span>
                <span><ColorPick value={i.color} onChange={(c) => patch(i.key, { color: c })} /></span>
                <span className="en-label">
                  <input value={i.label} placeholder="显示名" aria-label="显示名" aria-invalid={(tried && !i.label.trim()) || undefined}
                    className={cls(tried && !i.label.trim() && 'bad')} onChange={(e) => patch(i.key, { label: e.target.value })} />
                </span>
                <span>
                  {isNew(i)
                    ? <input className="en-mono" aria-label="Key" value={i.key}
                      onChange={(e) => {
                        const k = e.target.value.trim()
                        setD({ ...d, items: d.items.map((x, m) => (m === n ? { ...x, key: k } : x)), default_key: d.default_key === i.key ? k : d.default_key })
                      }} />
                    : <code className="en-k" title="key 创建后不能改">{i.key}</code>}
                </span>
                <span><input className="en-desc" value={i.desc} placeholder="说明（可选）" aria-label="说明" onChange={(e) => patch(i.key, { desc: e.target.value })} /></span>
                <span className="en-used">{i.usage === undefined || isNew(i) ? '' : `${i.usage} 条`}</span>
                <span>
                  <input type="radio" name={`def-${group.key}`} aria-label="默认" checked={d.default_key === i.key} disabled={!i.enabled}
                    onChange={() => setD({ ...d, default_key: i.key })} title="新建时默认选这个" />
                </span>
                <span>
                  <Switch aria-label="启用" checked={i.enabled} disabled={i.locked || d.default_key === i.key}
                    title={i.locked ? '系统值，程序逻辑依赖它，不能停用' : i.enabled ? '停用后新建和编辑时不再出现，已有数据照常显示' : '启用'}
                    onCheckedChange={(v) => patch(i.key, { enabled: v })} />
                </span>
                <span>
                  {i.locked
                    ? <span className="en-lock" title="系统值：可以改显示名、颜色和说明，不能停用或删除">系统值</span>
                    : <Button size="sm" variant="danger-ghost" onClick={() => askRemove(i)}>删除</Button>}
                </span>
              </div>
            </Fragment>
          )
        })}
        {matched && !matched.length && <div className="en-empty">没有匹配的值</div>}
        {!showOff && off.length > 0 && <button type="button" className="en-add en-off-toggle" onClick={() => setShowOff(true)}>已停用 {off.length} 个，点开查看</button>}
        {removingItem && (
          <div className="en-merge" role="status">
            <span>
              「{removingItem.label || removingItem.key}」有 {removingItem.usage} 条数据在用，不能删除
              {removingItem.enabled ? '；停用后新建和编辑时不再出现，已有数据照常显示' : '，已经停用了'}
            </span>
            {removingItem.enabled && (
              <Button size="sm" variant="primary" disabled={d.default_key === removingItem.key}
                title={d.default_key === removingItem.key ? '默认值不能停用，先换一个默认值' : undefined}
                onClick={() => { patch(removingItem.key, { enabled: false }); setRemoving(null) }}>停用</Button>
            )}
            <Button size="sm" onClick={() => setRemoving(null)}>{removingItem.enabled ? '取消' : '知道了'}</Button>
          </div>
        )}
        <button type="button" className="en-add" disabled={fixed} title={fixed ? '这几个值由程序固定，不能加新值' : undefined} onClick={add}>加一个值</button>
      </div>

      {tried && errors.length > 0 && <div className="en-issues" role="alert"><ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul></div>}
      {saveErr && <div className="en-issues" role="alert">保存失败：{saveErr}</div>}

      <div className="en-foot">
        {leaving ? (
          <>
            <span className="en-warn">有未保存的修改，切走后会丢掉</span>
            <span className="spacer" />
            <Button onClick={onStay}>继续编辑</Button>
            <Button variant="danger" onClick={onLeave}>放弃修改</Button>
          </>
        ) : (
          <>
            <span className="spacer" />
            {dirty && <Button onClick={reset}>放弃修改</Button>}
            <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => { void submit() }}>
              {save.isPending ? '保存中' : saved ? '已保存' : dirty ? '保存' : '没有修改'}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
