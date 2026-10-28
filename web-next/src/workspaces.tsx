import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MODULES, TEMPLATES, fromTemplate, groupId, moduleOf, withGroups, type MenuGroup, type ModuleKey, type Workbench } from './workspacedata'
import { MARK_COLORS, Mark, MarkEditor } from './imagepick'
import { PageTitle } from './topbar'
import { AppLogo } from './logo'
import { cls } from './ui'
import { newId } from './ids'

// 左上角的工作台切换，和「设置 > 工作台与模块」页

/** 工作台标志：没设置图片也没设文字时，用产品的 logo */
export const BenchMark = ({ w, size = 30 }: { w: Workbench; size?: number }) =>
  !w.mark?.image && !w.mark?.text && !w.mark?.icon ? <AppLogo size={size} /> : <Mark image={w.mark?.image} icon={w.mark?.icon} text={w.mark?.text ?? ''} color={w.mark?.color ?? '#23221e'} size={size} />

export function WorkspaceSwitcher({ list, current, collapsed, onSwitch, onManage }: {
  list: Workbench[]; current: string; collapsed: boolean
  onSwitch: (id: string) => void; onManage: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // 弹窗挂到 body 上、按按钮位置固定定位：侧栏收起时只剩一条窄轨，还带滚动，放在侧栏里会被裁掉
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const toggle = () => {
    const r = ref.current?.getBoundingClientRect()
    if (r) setPos({ left: r.left, top: r.bottom + 2 })
    setOpen(!open)
  }
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { const t = e.target as Node; if (!ref.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const close = () => setOpen(false)
    window.addEventListener('mousedown', off)
    window.addEventListener('keydown', esc)
    window.addEventListener('resize', close)
    return () => { window.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc); window.removeEventListener('resize', close) }
  }, [open])
  const cur = list.find((w) => w.id === current) ?? list[0]
  return (
    <div className="ws-brand menu-wrap" ref={ref}>
      <button className="brand brand-btn" onClick={toggle} title={collapsed ? `一人之下 · ${cur.name}` : '切换工作台'} aria-haspopup="menu" aria-expanded={open}>
        {/* 左上角固定是产品 logo；当前工作台的标志缩小放在工作台名前面 */}
        <AppLogo size={30} />
        <div className="brand-text">
          <div className="brand-name">一人之下</div>
          <div className="brand-sub"><BenchMark w={cur} size={14} /><span className="ellipsis">{cur.name}</span></div>
        </div>
        <svg className="brand-chev" viewBox="0 0 16 16" width="12" height="12"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && pos && createPortal(
        <div className="menu ws-menu" role="menu" ref={menuRef} style={{ left: pos.left, top: pos.top }}>
          <div className="menu-label">切换工作台</div>
          {/* 工作台多了只滚这一段，底部的「设置」一直看得到 */}
          <div className="ws-menu-list">
          {list.map((w) => (
            <button key={w.id} className={cls('menu-item ws-menu-item', w.id === cur.id && 'on')} onClick={() => { onSwitch(w.id); setOpen(false) }}>
              <BenchMark w={w} size={24} />
              <span className="ws-menu-text"><span className="ellipsis">{w.name}</span><span className="list-sub ellipsis">{w.role}</span></span>
              {w.id === cur.id && <svg viewBox="0 0 16 16" width="12" height="12"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
            </button>
          ))}
          </div>
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => { onManage(); setOpen(false) }}>工作台与模块设置…</button>
        </div>,
        document.body,
      )}
    </div>
  )
}

export function WorkspacesPage({ list, current, onSwitch, onChange, onCreate, onDelete }: {
  list: Workbench[]
  current: string
  onSwitch: (id: string) => void
  onChange: (w: Workbench) => void
  onCreate: (w: Workbench) => void
  onDelete: (id: string) => void
}) {
  const [editing, setEditing] = useState(current)
  const [picking, setPicking] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  /** 未启用的模块要启用到哪一组；没选就放最后一组 */
  const [pick, setPick] = useState<Partial<Record<ModuleKey, string>>>({})
  useEffect(() => { setEditing(current) }, [current])
  const w = list.find((x) => x.id === editing) ?? list[0]
  const groups = w.groups
  const off = MODULES.filter((m) => !w.modules.includes(m.key))
  const set = (gs: MenuGroup[]) => onChange(withGroups(w, gs))
  const patchGroup = (gid: string, f: (x: MenuGroup) => MenuGroup) => set(groups.map((x) => (x.id === gid ? f(x) : x)))
  const swap = <T,>(arr: T[], i: number, j: number) => { const a = [...arr]; [a[i], a[j]] = [a[j], a[i]]; return a }

  const moveGroup = (i: number, d: -1 | 1) => { const j = i + d; if (j >= 0 && j < groups.length) set(swap(groups, i, j)) }
  const addGroup = () => set([...groups, { id: groupId(), name: '新分组', modules: [] }])
  // 删分组：里面的模块并到上一组（第一组就并到下一组），不会因为删分组把模块弄丢
  const removeGroup = (i: number) => {
    if (groups.length < 2) return
    const target = i > 0 ? i - 1 : 1
    set(groups.map((x, k) => (k === target ? { ...x, modules: [...x.modules, ...groups[i].modules] } : x)).filter((_, k) => k !== i))
  }
  const moveModule = (gid: string, k: ModuleKey, d: -1 | 1) => patchGroup(gid, (x) => {
    const i = x.modules.indexOf(k); const j = i + d
    return j < 0 || j >= x.modules.length ? x : { ...x, modules: swap(x.modules, i, j) }
  })
  const toGroup = (k: ModuleKey, gid: string) => set(groups.map((x) => ({ ...x, modules: x.id === gid ? [...x.modules.filter((m) => m !== k), k] : x.modules.filter((m) => m !== k) })))
  const disable = (k: ModuleKey) => set(groups.map((x) => ({ ...x, modules: x.modules.filter((m) => m !== k) })))

  const create = (t: (typeof TEMPLATES)[number]) => {
    const n = list.filter((x) => x.name.startsWith(t.name)).length
    const ws = fromTemplate(t, newId('ws'), n ? `${t.name} ${n + 1}` : t.name)
    onCreate(ws); setEditing(ws.id); setPicking(false)
  }

  return (
    <div className="page page-fill">
      <PageTitle parent="设置" count={`${list.length} 个工作台`} desc="一个工作台是一套菜单：开哪些功能模块、怎么分组、按什么顺序、默认打开哪个；数据所有工作台共用"
        actions={<button className="btn btn-primary" onClick={() => setPicking(!picking)}>新建工作台</button>}>工作台与模块</PageTitle>

      {picking && (
        <div className="tpl-grid">
          {TEMPLATES.map((t) => (
            <button key={t.role} className="tpl-card" onClick={() => create(t)}>
              <b>{t.role}</b>
              <span className="list-sub">{t.desc}</span>
              <span className="tpl-mods">{t.groups.map(([n, m]) => `${n ? `${n}：` : ''}${m.map((k) => moduleOf(k).label).join('、')}`).join(' / ')}</span>
            </button>
          ))}
        </div>
      )}

      <div className="ws-layout">
        <div className="ws-list">
          {list.map((x) => (
            <button key={x.id} className={cls('ws-list-item', x.id === w.id && 'on')} onClick={() => { setEditing(x.id); setConfirmDel(false) }}>
              <span className="ws-menu-text"><span className="ellipsis">{x.name}</span><span className="list-sub">{x.role} · {x.groups.length} 组 {x.modules.length} 个模块</span></span>
              {x.id === current && <span className="tag">当前</span>}
            </button>
          ))}
        </div>
        <div className="ws-edit">
          <section className="hook-sec">
            <div className="field-row name-with-mark">
              <MarkEditor image={w.mark?.image} icon={w.mark?.icon} text={w.mark?.text} color={w.mark?.color ?? '#23221e'} textPlaceholder="一人"
                onIcon={(icon) => onChange({ ...w, mark: { text: '', color: MARK_COLORS[7], ...w.mark, icon } })}
                onImage={(image) => onChange({ ...w, mark: { text: w.mark?.text ?? '', color: w.mark?.color ?? MARK_COLORS[7], image } })}
                onText={(text) => onChange({ ...w, mark: { color: MARK_COLORS[7], ...w.mark, text, icon: text ? undefined : w.mark?.icon } })}
                onColor={(color) => onChange({ ...w, mark: { text: '', ...w.mark, color } })}
                hint="显示在左上角；PNG、JPG，1MB 以内">
                <BenchMark w={w} size={44} />
              </MarkEditor>
              <label className="field"><span className="field-label">名称</span><input value={w.name} onChange={(e) => onChange({ ...w, name: e.target.value })} /></label>
              <label className="field"><span className="field-label">角色</span><input value={w.role} onChange={(e) => onChange({ ...w, role: e.target.value })} /></label>
            </div>
            <label className="field"><span className="field-label">默认打开</span>
              <select value={w.home} onChange={(e) => onChange({ ...w, home: e.target.value as ModuleKey })}>
                {w.modules.map((m) => <option key={m} value={m}>{moduleOf(m).label}</option>)}
              </select>
            </label>
            <div className="act-row">
              {w.id === current ? <span className="list-sub">正在用这个工作台，改动马上生效</span> : <button className="act act-primary" onClick={() => onSwitch(w.id)}>切换到这个工作台</button>}
              <span className="spacer" />
              {list.length > 1 && (confirmDel ? (
                <><span className="danger-text">只删配置，数据不受影响</span><button className="act act-quiet" onClick={() => setConfirmDel(false)}>取消</button><button className="act btn-danger" onClick={() => { onDelete(w.id); setConfirmDel(false) }}>删除</button></>
              ) : <button className="act act-quiet btn-danger-ghost" onClick={() => setConfirmDel(true)}>删除工作台</button>)}
            </div>
          </section>

          <section className="hook-sec">
            <div className="mount-head">
              <div className="field-group-title">菜单分组<span className="field-hint">左侧菜单按这里的分组和顺序显示；分组名留空只分隔不显示标题</span></div>
              <button className="act" onClick={addGroup}>加一个分组</button>
            </div>
            <div className="grp-list">
              {groups.map((x, gi) => (
                <div key={x.id} className="grp-card">
                  <div className="grp-head">
                    <span className="mod-order">
                      <button className="icon-btn icon-btn-sm" disabled={gi === 0} onClick={() => moveGroup(gi, -1)} title="分组上移"><svg viewBox="0 0 16 16" width="11" height="11"><path d="m4 10 4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
                      <button className="icon-btn icon-btn-sm" disabled={gi === groups.length - 1} onClick={() => moveGroup(gi, 1)} title="分组下移"><svg viewBox="0 0 16 16" width="11" height="11"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
                    </span>
                    <input className="grp-name" value={x.name} placeholder="不显示标题" onChange={(e) => patchGroup(x.id, (y) => ({ ...y, name: e.target.value }))} />
                    <span className="list-sub">{x.modules.length} 个模块</span>
                    <span className="spacer" />
                    {x.name && (
                      <label className="switch-line" title="侧栏里这组默认收起；在侧栏点分组标题也能随时展开、收起">
                        <input type="checkbox" checked={!!x.collapsed} onChange={(e) => patchGroup(x.id, (y) => ({ ...y, collapsed: e.target.checked }))} /><span className="switch" />默认折叠
                      </label>
                    )}
                    {groups.length > 1 && <button className="act act-quiet btn-danger-ghost" onClick={() => removeGroup(gi)} title="里面的模块会并到相邻的分组">删除分组</button>}
                  </div>
                  {x.modules.length ? x.modules.map((k, mi) => (
                    <div key={k} className="mod-row">
                      <span className="mod-order">
                        <button className="icon-btn icon-btn-sm" disabled={mi === 0} onClick={() => moveModule(x.id, k, -1)} title="上移"><svg viewBox="0 0 16 16" width="11" height="11"><path d="m4 10 4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
                        <button className="icon-btn icon-btn-sm" disabled={mi === x.modules.length - 1} onClick={() => moveModule(x.id, k, 1)} title="下移"><svg viewBox="0 0 16 16" width="11" height="11"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
                      </span>
                      <span className="mod-text"><b>{moduleOf(k).label}</b><span className="list-sub">{moduleOf(k).desc}</span></span>
                      {w.home === k && <span className="tag">默认打开</span>}
                      {groups.length > 1 && (
                        <select className="grp-move" value={x.id} onChange={(e) => toGroup(k, e.target.value)} title="移到别的分组">
                          {groups.map((y) => <option key={y.id} value={y.id}>{y.name || '（无标题分组）'}</option>)}
                        </select>
                      )}
                      <label className="switch-line" title={w.modules.length === 1 ? '至少留一个模块' : '关掉后放到「未启用」'}>
                        <input type="checkbox" checked disabled={w.modules.length === 1} onChange={() => disable(k)} /><span className="switch" />
                      </label>
                    </div>
                  )) : <div className="grp-empty">空分组：从别的分组移过来，或者在下面启用模块到这里</div>}
                </div>
              ))}
            </div>
          </section>

          {off.length > 0 && (
            <section className="hook-sec">
              <div className="field-group-title">未启用<span className="field-hint">不在菜单里显示，数据还在；启用时选放到哪一组</span></div>
              <div className="mod-list">
                {off.map((m) => (
                  <div key={m.key} className="mod-row off">
                    <span className="mod-text"><b>{m.label}</b><span className="list-sub">{m.desc}</span></span>
                    <select className="grp-move" value={pick[m.key] ?? groups[groups.length - 1].id} onChange={(e) => setPick({ ...pick, [m.key]: e.target.value })}>
                      {groups.map((y) => <option key={y.id} value={y.id}>{y.name || '（无标题分组）'}</option>)}
                    </select>
                    <button className="act" onClick={() => { const to = pick[m.key]; toGroup(m.key, to && groups.some((y) => y.id === to) ? to : groups[groups.length - 1].id) }}>启用</button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
