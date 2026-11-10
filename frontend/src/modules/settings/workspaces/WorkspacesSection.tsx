// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置里的「工作台与模块」分节（CORE-10b），照原型 web-next/src/workspaces.tsx WorkspacesPage。
// 能改标志、名称、角色、默认模块、分组和模块顺序，从模板新建、删除。
// 改动马上写后端，需要的插件按启用的模块推出来一起存。数据所有工作台共用，这里只改菜单
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { moduleStore } from '../../../core/plugin'
import {
  errorText, QueryState, useCreateWorkspace, useDeleteWorkspace, usePatchWorkspace, usePlugins, useWorkspaces, useWorkspaceTemplates,
  type PluginInfo, type Workspace, type WorkspaceGroup, type WorkspaceMark, type WorkspaceTemplate,
} from '../../../core/data'
import { Button, cls, Field, IconButton, Input, MARK_COLORS, MarkEditor, PageTitle, Select, Switch, type MarkValue } from '../../../core/ui'
import {
  CATALOG_IDS, MODULE_CATALOG, missingPlugins, missingText, moduleKeyOf, moduleLabel, PLUGIN_STATE_TEXT, pluginOfModule,
  pluginsForModules, pluginState, resolveCurrent, useCurrentWorkspaceId, type MissingPlugin,
} from '../../../core/shell/workspace'
import { MissingPluginsDialog, PLUGINS_PATH } from '../../../core/shell/WorkspacePrompt'
import { useWorkspaceSwitch } from '../../../core/shell/useWorkspaceSwitch'
import { WorkspaceMarkView } from '../../../core/shell/WorkspaceSwitcher'
import './workspaces.css'

type Undo = { ws: string; groups: WorkspaceGroup[]; name: string; into: string; n: number }

const swap = <T,>(arr: readonly T[], i: number, j: number) => {
  const a = [...arr]
  ;[a[i], a[j]] = [a[j], a[i]]
  return a
}

/** 没设过底色时用的底色（原型 MARK_COLORS[7]） */
const MARK_BASE = MARK_COLORS[7]

/** 编辑器给回的文字、图标、图片，加上底色拼成工作台的 mark；没有的字段不带 */
const toMark = (m: MarkValue, color: string): WorkspaceMark => ({
  text: m.text, color, ...(m.icon && { icon: m.icon }), ...(m.image && { image: m.image }),
})

let gseq = 0
const newGroupId = () => `g${Date.now().toString(36)}${(gseq += 1)}`

export function WorkspacesSection() {
  const q = useWorkspaces()
  return (
    <div className="page ws-page">
      {q.data === undefined && <PageTitle parent="设置">工作台与模块</PageTitle>}
      <QueryState query={q}>{(list) => <Editor list={list} />}</QueryState>
    </div>
  )
}

function Editor({ list }: { list: Workspace[] }) {
  const navigate = useNavigate()
  const current = resolveCurrent(list, useCurrentWorkspaceId())
  const [editingId, setEditingId] = useState<string | null>(null)
  const w = list.find((x) => x.id === editingId) ?? current ?? list[0]
  const [picking, setPicking] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [undo, setUndo] = useState<Undo | null>(null)
  const undoTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(undoTimer.current), [])
  // 未启用的模块要启用到哪一组；没选就放最后一组
  const [pick, setPick] = useState<Record<string, string>>({})
  const [creating, setCreating] = useState<{ t: WorkspaceTemplate; missing: MissingPlugin[] } | null>(null)

  const plugins = usePlugins().data
  const templates = useWorkspaceTemplates()
  // 现在登记着的模块（内核加在跑的插件），插件停用后跟着少
  const live = useSyncExternalStore(moduleStore.subscribe, moduleStore.list)
  const patch = usePatchWorkspace()
  const create = useCreateWorkspace()
  const remove = useDeleteWorkspace()
  const { switchTo, prompt } = useWorkspaceSwitch()

  if (!w) return null
  const groups = w.groups
  const fail = (what: string) => (e: unknown) => setError(`${what}失败：${errorText(e)}`)
  const save = (id: string, p: Parameters<typeof patch.mutate>[0]['patch']) => {
    setError(null)
    patch.mutate({ id, patch: p }, { onError: fail('保存') })
  }
  // 分组一改，需要的插件跟着启用的模块重算
  const set = (gs: WorkspaceGroup[], ws: Workspace = w) =>
    save(ws.id, { groups: gs, plugins: pluginsForModules(gs.flatMap((x) => x.modules)) })
  const patchGroup = (gid: string, f: (x: WorkspaceGroup) => WorkspaceGroup) => set(groups.map((x) => (x.id === gid ? f(x) : x)))

  const moveGroup = (i: number, d: -1 | 1) => { const j = i + d; if (j >= 0 && j < groups.length) set(swap(groups, i, j)) }
  const addGroup = () => set([...groups, { id: newGroupId(), name: '新分组', modules: [], collapsed: false }])
  // 删分组：里面的模块并到上一组（第一组就并到下一组），不会因为删分组把模块弄丢；几秒内可以撤销
  const removeGroup = (i: number) => {
    if (groups.length < 2) return
    const target = i > 0 ? i - 1 : 1
    set(groups.map((x, k) => (k === target ? { ...x, modules: [...x.modules, ...groups[i].modules] } : x)).filter((_, k) => k !== i))
    setUndo({ ws: w.id, groups, name: groups[i].name, into: groups[target].name, n: groups[i].modules.length })
    window.clearTimeout(undoTimer.current)
    undoTimer.current = window.setTimeout(() => setUndo(null), 8000)
  }
  const undoRemove = () => {
    const ws = undo ? list.find((x) => x.id === undo.ws) : undefined
    if (undo && ws) set(undo.groups, ws)
    setUndo(null)
  }
  const moveModule = (gid: string, k: string, d: -1 | 1) => patchGroup(gid, (x) => {
    const i = x.modules.indexOf(k)
    const j = i + d
    return j < 0 || j >= x.modules.length ? x : { ...x, modules: swap(x.modules, i, j) }
  })
  const toGroup = (k: string, gid: string) =>
    set(groups.map((x) => ({ ...x, modules: x.id === gid ? [...x.modules.filter((m) => m !== k), k] : x.modules.filter((m) => m !== k) })))
  const disable = (k: string) => set(groups.map((x) => ({ ...x, modules: x.modules.filter((m) => m !== k) })))

  // 未启用：目录里的模块，加上目录外、现在在跑的插件模块（设置不算模块）
  const extra = live.filter((m) => !CATALOG_IDS.has(m.id) && m.id !== 'settings').map((m) => ({ key: moduleKeyOf(m.id), label: m.label, desc: '插件模块' }))
  const off = [...MODULE_CATALOG, ...extra].filter((m) => !w.modules.includes(m.key))

  const doCreate = (t: WorkspaceTemplate, toPlugins = false) => {
    setError(null)
    const n = list.filter((x) => x.name.startsWith(t.name)).length
    create.mutate({ template: t.id, name: n ? `${t.name} ${n + 1}` : t.name }, {
      onSuccess: (ws) => {
        setEditingId(ws.id)
        setPicking(false)
        setConfirmDel(false)
        if (toPlugins) void navigate(PLUGINS_PATH)
      },
      onError: fail('新建'),
    })
  }
  // 选模板时先看缺哪些插件
  const pickTemplate = (t: WorkspaceTemplate) => {
    const missing = plugins ? missingPlugins(t.plugins, plugins) : []
    if (missing.length) setCreating({ t, missing })
    else doCreate(t)
  }

  const doDelete = () => {
    setError(null)
    remove.mutate(w.id, { onSuccess: () => { setEditingId(null); setConfirmDel(false) }, onError: fail('删除') })
  }

  const missing = plugins ? missingPlugins(w.plugins, plugins) : []

  return (
    <>
      <PageTitle parent="设置" count={`${list.length} 个工作台`}
        desc="一个工作台是一套菜单：开哪些功能模块、怎么分组、按什么顺序、默认打开哪个；数据所有工作台共用"
        actions={<Button variant="primary" aria-expanded={picking} onClick={() => setPicking(!picking)}>新建工作台</Button>}>
        工作台与模块
      </PageTitle>

      {error && <div className="ws-banner ws-banner-danger" role="alert">{error}</div>}

      {picking && (
        <QueryState query={templates}>{(ts) => (
          <div className="tpl-grid" aria-label="从模板新建">
            {ts.map((t) => {
              const lack = plugins ? missingPlugins(t.plugins, plugins) : []
              return (
                <button key={t.id} type="button" className="tpl-card" disabled={create.isPending} onClick={() => pickTemplate(t)}>
                  <b>{t.role}</b>
                  <span className="ws-sub">{t.description}</span>
                  <span className="tpl-mods">
                    {t.groups.map((g) => `${g.name ? `${g.name}：` : ''}${g.modules.map((k) => moduleLabel(k, live)).join('、')}`).join(' / ')}
                  </span>
                  {lack.length > 0 && <span className="tpl-lack">需要插件：{lack.map(missingText).join('；')}</span>}
                </button>
              )
            })}
          </div>
        )}</QueryState>
      )}

      <div className="ws-layout">
        <div className="ws-list" role="list" aria-label="工作台">
          {list.map((x) => (
            <button key={x.id} type="button" role="listitem" aria-current={x.id === w.id || undefined}
              className={cls('ws-list-item', x.id === w.id && 'on')}
              onClick={() => { setEditingId(x.id); setConfirmDel(false); setUndo(null) }}>
              <span className="ws-list-text">
                <span className="ellipsis">{x.name}</span>
                <span className="ws-sub">{x.role ? `${x.role} · ` : ''}{x.groups.length} 组 {x.modules.length} 个模块</span>
              </span>
              {x.id === current?.id && <span className="tag">当前</span>}
            </button>
          ))}
        </div>

        <div className="ws-edit">
          <section className="ws-sec">
            <div className="ws-name-row">
              <MarkEditor key={`${w.id}-mark`} mark={{ text: w.mark?.text ?? '', icon: w.mark?.icon, image: w.mark?.image }}
                color={w.mark?.color ?? MARK_BASE} textPlaceholder="一人" hint="显示在左上角；PNG、JPG，1MB 以内"
                onMark={(m) => save(w.id, { mark: toMark(m, w.mark?.color ?? MARK_BASE) })}
                onColor={(c) => save(w.id, { mark: toMark({ text: w.mark?.text ?? '', icon: w.mark?.icon, image: w.mark?.image }, c) })}>
                <WorkspaceMarkView w={w} size={44} />
              </MarkEditor>
              <TextField key={`${w.id}-name`} label="名称" required value={w.name} onCommit={(name) => save(w.id, { name })} />
              <TextField key={`${w.id}-role`} label="角色" value={w.role} onCommit={(role) => save(w.id, { role })} />
            </div>
            <Field label="默认打开">
              <Select value={w.home} onValueChange={(home) => save(w.id, { home })}
                options={w.modules.map((m) => ({ value: m, label: moduleLabel(m, live) }))} />
            </Field>
            <div className="ws-act-row">
              {w.id === current?.id
                ? <span className="ws-sub">正在用这个工作台，改动马上生效</span>
                : <Button variant="outline" size="sm" onClick={() => switchTo(w)}>切换到这个工作台</Button>}
              <span className="spacer" />
              {list.length > 1 && (confirmDel ? (
                <>
                  <span className="ws-danger-text">只删配置，数据不受影响</span>
                  <Button size="sm" onClick={() => setConfirmDel(false)}>取消</Button>
                  <Button size="sm" variant="danger" disabled={remove.isPending} onClick={doDelete}>删除</Button>
                </>
              ) : <Button size="sm" variant="danger-ghost" onClick={() => setConfirmDel(true)}>删除工作台</Button>)}
            </div>
          </section>

          <section className="ws-sec" aria-label="需要的插件">
            <div className="ws-sec-title">需要的插件<span className="ws-hint">按启用的模块推出来；切到这个工作台时缺的会提示</span></div>
            {w.plugins.length === 0
              ? <span className="ws-sub">只用内核模块，不需要插件</span>
              : <PluginNeeds plugins={w.plugins} list={plugins} missing={missing} onManage={() => { void navigate(PLUGINS_PATH) }} />}
          </section>

          <section className="ws-sec">
            <div className="ws-sec-head">
              <div className="ws-sec-title">菜单分组<span className="ws-hint">左侧菜单按这里的分组和顺序显示；分组名留空只分隔不显示标题</span></div>
              <Button size="sm" variant="outline" onClick={addGroup}>加一个分组</Button>
            </div>
            {undo && undo.ws === w.id && (
              <div className="ws-banner">
                <span>
                  已删除分组{undo.name ? `「${undo.name}」` : '（无标题）'}
                  {undo.n ? `，里面的 ${undo.n} 个模块并到了${undo.into ? `「${undo.into}」` : '相邻的分组'}` : ''}
                </span>
                <span className="spacer" />
                <Button size="sm" variant="outline" onClick={undoRemove}>撤销</Button>
              </div>
            )}
            <div className="grp-list">
              {groups.map((x, gi) => (
                <div key={x.id} className="grp-card" role="group" aria-label={x.name || '无标题分组'}>
                  <div className="grp-head">
                    <Order first={gi === 0} last={gi === groups.length - 1} what="分组" onMove={(d) => moveGroup(gi, d)} />
                    <GroupName key={`${w.id}-${x.id}-${x.name}`} value={x.name} onCommit={(name) => patchGroup(x.id, (y) => ({ ...y, name }))} />
                    <span className="ws-sub">{x.modules.length} 个模块</span>
                    <span className="spacer" />
                    {x.name && (
                      <Switch checked={x.collapsed} onCheckedChange={(c) => patchGroup(x.id, (y) => ({ ...y, collapsed: c }))}
                        title="侧栏里这组默认收起；在侧栏点分组标题也能随时展开、收起">默认折叠</Switch>
                    )}
                    {groups.length > 1 && (
                      <Button size="sm" variant="danger-ghost" title="里面的模块会并到相邻的分组" onClick={() => removeGroup(gi)}>删除分组</Button>
                    )}
                  </div>
                  {x.modules.length ? x.modules.map((k, mi) => (
                    <div key={k} className="mod-row">
                      <Order first={mi === 0} last={mi === x.modules.length - 1} what={moduleLabel(k, live)} onMove={(d) => moveModule(x.id, k, d)} />
                      <ModText k={k} live={live} list={plugins} />
                      {w.home === k && <span className="tag">默认打开</span>}
                      {groups.length > 1 && (
                        <Select className="grp-move" value={x.id} aria-label={`${moduleLabel(k, live)}移到别的分组`} onValueChange={(to) => toGroup(k, to)}
                          options={groups.map((y) => ({ value: y.id, label: y.name || '（无标题分组）' }))} />
                      )}
                      <Switch checked disabled={w.modules.length === 1} aria-label={`启用${moduleLabel(k, live)}`}
                        title={w.modules.length === 1 ? '至少留一个模块' : '关掉后放到「未启用」'} onCheckedChange={() => disable(k)} />
                    </div>
                  )) : <div className="grp-empty">空分组：从别的分组移过来，或者在下面启用模块到这里</div>}
                </div>
              ))}
            </div>
          </section>

          {off.length > 0 && (
            <section className="ws-sec" aria-label="未启用的模块">
              <div className="ws-sec-title">未启用<span className="ws-hint">不在菜单里显示，数据还在；启用时选放到哪一组</span></div>
              <div className="mod-list">
                {off.map((m) => {
                  const to = pick[m.key] && groups.some((y) => y.id === pick[m.key]) ? pick[m.key] : groups[groups.length - 1].id
                  return (
                    <div key={m.key} className="mod-row off">
                      <ModText k={m.key} live={live} list={plugins} desc={m.desc} />
                      <Select className="grp-move" value={to} aria-label={`${m.label}放到哪一组`} onValueChange={(v) => setPick({ ...pick, [m.key]: v })}
                        options={groups.map((y) => ({ value: y.id, label: y.name || '（无标题分组）' }))} />
                      <Button size="sm" variant="outline" onClick={() => toGroup(m.key, to)}>启用</Button>
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </div>
      </div>

      {prompt}
      {creating && (
        <MissingPluginsDialog name={creating.t.name} missing={creating.missing} proceedLabel="先不装，照样新建"
          onInstall={() => { const t = creating.t; setCreating(null); doCreate(t, true) }}
          onProceed={() => { const t = creating.t; setCreating(null); doCreate(t) }}
          onCancel={() => setCreating(null)} />
      )}
    </>
  )
}

function PluginNeeds({ plugins, list, missing, onManage }: {
  plugins: string[]
  list: PluginInfo[] | undefined
  missing: MissingPlugin[]
  onManage: () => void
}) {
  if (!list) return <span className="ws-sub">{plugins.join('、')}</span>
  if (!missing.length) return <span className="ws-sub">都已启用（{plugins.length} 个）</span>
  return (
    <div className="ws-needs">
      <ul>{missing.map((m) => <li key={m.id} className={cls(m.state === 'unavailable' && 'ws-need-na')}>{missingText(m)}</li>)}</ul>
      {missing.some((m) => m.state !== 'unavailable') && <Button size="sm" variant="outline" onClick={onManage}>去插件管理安装</Button>}
    </div>
  )
}

function ModText({ k, live, list, desc }: { k: string; live: readonly { id: string; label: string }[]; list: PluginInfo[] | undefined; desc?: string }) {
  const plugin = pluginOfModule(k)
  const state = plugin && list ? pluginState(plugin, list) : 'ok'
  return (
    <span className="mod-text">
      <b>{moduleLabel(k, live)}</b>
      <span className="ws-sub">{desc ?? MODULE_CATALOG.find((m) => m.key === k)?.desc ?? '插件模块'}</span>
      {state !== 'ok' && <span className="ws-mod-lack">要插件，{PLUGIN_STATE_TEXT[state]}，菜单里先不显示</span>}
    </span>
  )
}

function Order({ first, last, what, onMove }: { first: boolean; last: boolean; what: string; onMove: (d: -1 | 1) => void }) {
  return (
    <span className="mod-order">
      <IconButton size="sm" label={`${what}上移`} disabled={first} onClick={() => onMove(-1)}><Arrow up /></IconButton>
      <IconButton size="sm" label={`${what}下移`} disabled={last} onClick={() => onMove(1)}><Arrow /></IconButton>
    </span>
  )
}

const Arrow = ({ up }: { up?: boolean }) => (
  <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
    <path d={up ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** 文本框失焦或回车才保存，免得每敲一个字发一次请求；必填的清空后失焦恢复原值 */
function TextField({ label, value, required, onCommit }: { label: ReactNode; value: string; required?: boolean; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value)
  const bad = required && !v.trim()
  const commit = () => {
    const t = v.trim()
    if (required && !t) { setV(value); return }
    if (t !== value) onCommit(t)
  }
  return (
    <Field label={label} required={required} error={bad ? '必填，留空会恢复原来的名称' : undefined}>
      <Input value={v} invalid={bad} onChange={(e) => setV(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
    </Field>
  )
}

function GroupName({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value)
  return (
    <input className="grp-name" value={v} placeholder="不显示标题" aria-label="分组名" onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v.trim() !== value) onCommit(v.trim()) }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
  )
}
