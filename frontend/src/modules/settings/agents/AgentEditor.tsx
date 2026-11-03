// Agent 配置页，照原型 web-next/src/agents.tsx AgentEditor（SPEC-settings-9）。
// 和原型不同的地方：
// - 工具与权限（AG-02b）存在单独的授权接口：草稿里另记一份，保存时先存 Agent 再整组 PUT 授权。
// - 右边的调试对话接 AG-02c，用当前没保存的配置（含授权）跑。?tab=tools 直接打开工具与权限（会话里权限没开时跳过来）。
// - 离开确认用路由的 useBlocker：返回按钮、切二级菜单、侧栏换模块都先在底栏确认。
// - 模型存服务商加模型名（provider_id + model）；新建时模型空着表示用第一个可用的，保存时才定。
import { useEffect, useRef, useState } from 'react'
import { useBlocker, useLocation, useNavigate, useSearchParams } from 'react-router'
import {
  errorText, useAgentGrants, useAgentImpact, useCategoryTree, useConnectorDefs, useConnectors, useCreateAgent, useCreateKb, useDeleteAgent,
  useKnowledgeBases, usePatchAgent, usePutAgentGrants, useSkills, type Agent, type AgentGrantMode, type AgentThinking, type KnowledgeBase, type Skill,
} from '../../../core/data'
import { Button, Checkbox, cls, Input, PageTitle, Select, Switch, Tag, Textarea } from '../../../core/ui'
import { AgentAvatar } from '../../../core/ui/AgentAvatar'
import { DebugChat } from './DebugChat'
import { timeAgo } from '../providers/model'
import { AvatarEditor } from './AgentAvatar'
import { MountPicker } from './MountPicker'
import {
  blankDraft, choiceKey, createBody, defaultChoice, draftOf, draftPatch, EDITOR_TABS, editorIssues, grantsBody, grantsEqual, hasAll, MANY_MODELS,
  mountableConns, mountGrants, newGrants, normDir, THINKING_OPTIONS, toolsOn, unmountGrants, type AgentDraft, type EditorTab, type Grants, type ModelChoice,
} from './model'
import { MiniSearch, Unmount } from './parts'
import { ToolsTab } from './ToolsTab'
import { TriggersTab } from './Triggers'

/** 每个 Agent 上次看的标签，只在内存里记 */
const lastTab = new Map<string, EditorTab>()

const SKILL_SOURCE: Record<string, string> = { builtin: '内置', custom: '自定义' }
const skillSource = (s: Skill) => SKILL_SOURCE[s.source] ?? '插件'
const isTab = (t: string | null): t is EditorTab => EDITOR_TABS.some((x) => x.key === t)
// 调试面板叠在编辑区下面（1100px 以下）时默认收起，编辑区留够高度
const narrow = () => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 1100px)').matches

export function AgentEditor({ agent, models }: { agent: Agent | null; models: ModelChoice[] }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [params] = useSearchParams()
  const creating = !agent
  const [base, setBase] = useState<AgentDraft>(() => (agent ? draftOf(agent) : blankDraft()))
  const [d, setD] = useState<AgentDraft>(base)
  const [tab, setTab] = useState<EditorTab>(() => {
    const want = params.get('tab')
    if (agent && isTab(want)) return want
    return agent ? lastTab.get(agent.id) ?? 'basic' : 'basic'
  })
  const [tried, setTried] = useState(false)
  // 新建保存后换成这个 Agent 的配置页，「已保存」带过来
  const [saved, setSaved] = useState(() => !!(location.state as { saved?: boolean } | null)?.saved)
  const [saveErr, setSaveErr] = useState<string | null>(() => {
    const e = (location.state as { grantsError?: string } | null)?.grantsError
    return e ? `Agent 已创建，工具权限没存上：${e}` : null
  })
  const [confirmDel, setConfirmDel] = useState(false)
  const [pickModel, setPickModel] = useState(false)
  const [modelQ, setModelQ] = useState('')
  const [openConn, setOpenConn] = useState<string | null>(null)
  const [debugFolded, setDebugFolded] = useState(narrow)

  const create = useCreateAgent()
  const patch = usePatchAgent()
  const putGrants = usePutAgentGrants()
  const del = useDeleteAgent()
  const impact = useAgentImpact(agent?.id ?? null, confirmDel)
  const grants = useAgentGrants(agent ? [agent.id] : [])[agent?.id ?? '']
  const skills = useSkills().data ?? []
  const kbs = useKnowledgeBases().data ?? []
  const conns = useConnectors().data ?? []
  const defs = useConnectorDefs().data ?? []
  // 工具授权：新建按 newAgent，已有的等授权取回来（取回前不算改动、不让存授权）
  const [gBase, setGBase] = useState<Grants | null>(() => (agent ? null : newGrants()))
  const [g, setG] = useState<Grants>(() => newGrants())

  const grantsChanged = !!gBase && !grantsEqual(gBase, g)
  const changed = Object.keys(draftPatch(base, d)).length > 0 || grantsChanged
  // 保存、删除后自己跳走时不拦
  const leaving = useRef(false)
  const changedRef = useRef(changed)
  useEffect(() => { changedRef.current = changed }, [changed])
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    !leaving.current && changedRef.current && currentLocation.pathname !== nextLocation.pathname)

  // 别处改了这个 Agent（列表上启停、删技能摘掉了挂载）：没有未保存的改动就跟上
  const serverDraft = agent ? JSON.stringify(draftOf(agent)) : ''
  // 只看内容变没变：agent 每次读回都是新对象
  useEffect(() => {
    if (!serverDraft || changedRef.current) return
    const next = JSON.parse(serverDraft) as AgentDraft
    setBase(next)
    setD(next)
  }, [serverDraft])

  // 授权取回来、保存后读回：没有未保存的授权改动就跟上。渲染时对一下上次看到的，不用 effect 再渲染一遍
  const serverGrants = grants ? JSON.stringify(grants.grants) : ''
  const [seenGrants, setSeenGrants] = useState('')
  if (serverGrants && serverGrants !== seenGrants) {
    setSeenGrants(serverGrants)
    const next = JSON.parse(serverGrants) as Grants
    if (!gBase || grantsEqual(gBase, g)) setG(next)
    setGBase(next)
  }

  useEffect(() => {
    if (!saved) return
    const t = window.setTimeout(() => setSaved(false), 1500)
    return () => window.clearTimeout(t)
  }, [saved])

  const go = (t: EditorTab) => { if (agent) lastTab.set(agent.id, t); setTab(t) }
  const set = (p: Partial<AgentDraft>) => { setD({ ...d, ...p }); setSaveErr(null); setSaved(false) }
  const toggleId = (key: 'skills' | 'kbs', id: string) => set({ [key]: d[key].includes(id) ? d[key].filter((x) => x !== id) : [...d[key], id] })

  // 模型：新建时没选就是第一个可用的
  const fallback = defaultChoice(models)
  const curKey = d.provider_id ? choiceKey(d.provider_id, d.model) : fallback?.key
  const curModel = models.find((m) => m.key === curKey)
  const mountedSkills = d.skills.map((id) => skills.find((s) => s.id === id)).filter((s): s is Skill => !!s)
  const mountedKbs = d.kbs.map((id) => kbs.find((k) => k.id === id)).filter((k): k is KnowledgeBase => !!k)
  const badConns = conns.filter((c) => d.mcps.includes(c.id) && c.status === 'error').map((c) => c.name)
  const issues = editorIssues(d, curModel, badConns)
  // 连接器：挂着的按 mcps 顺序（删掉的不列），能挂的是还没挂、获取过工具清单、没暂停没断开的
  const defLabel = (tool: string) => defs.find((x) => x.tool === tool)?.label ?? tool
  const { all: allConns, mountable } = mountableConns(conns, defLabel)
  const mountedConns = d.mcps.map((id) => allConns.find((c) => c.id === id)).filter((c) => !!c)
  const candidates = allConns.filter((c) => mountable.has(c.id) && !d.mcps.includes(c.id))
  const counts: Partial<Record<EditorTab, number>> = {
    skills: mountedSkills.length, tools: gBase ? toolsOn(g, mountedConns) : undefined, kbs: mountedKbs.length, triggers: d.triggers.length,
  }
  const issueText = Object.values(issues).filter(Boolean).join('；')
  const busy = create.isPending || patch.isPending || putGrants.isPending
  const dirty = creating || changed

  const setGrants = (next: Grants) => { setG(next); setSaveErr(null); setSaved(false) }
  const setMode = (key: string, m: AgentGrantMode) => setGrants({ ...g, [key]: m })
  const mountConn = (id: string) => {
    const c = allConns.find((x) => x.id === id)
    if (!c) return
    setD({ ...d, mcps: [...d.mcps, id] })
    setGrants(mountGrants(g, c))
    setOpenConn(id)
  }
  const unmountConn = (id: string) => {
    setD({ ...d, mcps: d.mcps.filter((x) => x !== id) })
    setGrants(unmountGrants(g, id))
    if (openConn === id) setOpenConn(null)
  }
  // 调试用当前（没保存的）配置：服务商没选时用默认的那个
  const pick = d.provider_id ? { provider_id: d.provider_id, model: d.model } : { provider_id: fallback?.providerId ?? '', model: fallback?.model ?? '' }
  const debugConfig = {
    agent_id: agent?.id, name: d.name.trim(), desc: d.desc, ...pick, instructions: d.instructions, skills: d.skills, mcps: d.mcps, kbs: d.kbs,
    grants: grantsBody(g, allConns),
  }

  const save = () => {
    setTried(true)
    setSaveErr(null)
    if (!d.name.trim()) { go('basic'); return }
    if (!agent) {
      create.mutate(createBody(d, fallback), {
        onSuccess: (a) => {
          lastTab.set(a.id, tab)
          leaving.current = true
          const open = () => void navigate(`/settings/agents/${encodeURIComponent(a.id)}`, { replace: true, state: { saved: true } })
          // 授权和后端新建的默认一样就不用再存
          if (grantsEqual(g, newGrants())) { open(); return }
          putGrants.mutate({ id: a.id, grants: grantsBody(g, allConns) }, {
            onSuccess: open,
            onError: (e) => void navigate(`/settings/agents/${encodeURIComponent(a.id)}`, { replace: true, state: { grantsError: errorText(e) } }),
          })
        },
        onError: (e) => setSaveErr(`创建失败：${errorText(e)}`),
      })
      return
    }
    const p = draftPatch(base, d)
    if (!Object.keys(p).length && !grantsChanged) return
    if (p.name !== undefined) p.name = d.name.trim()
    // 先存 Agent（挂载变了授权的实际档位才对得上），再整组存授权
    const saveGrants = () => {
      if (!grantsChanged) { setSaved(true); return }
      const body = grantsBody(g, allConns)
      putGrants.mutate({ id: agent.id, grants: body }, {
        onSuccess: (r) => { setGBase(r.grants); setG(r.grants); setSaved(true) },
        onError: (e) => setSaveErr(`工具权限保存失败：${errorText(e)}`),
      })
    }
    if (!Object.keys(p).length) { saveGrants(); return }
    patch.mutate({ id: agent.id, patch: p }, {
      onSuccess: (a) => {
        const next = draftOf(a)
        setBase(next)
        setD(next)
        saveGrants()
      },
      onError: (e) => setSaveErr(`保存失败：${errorText(e)}`),
    })
  }

  const remove = () => {
    if (!agent) return
    del.mutate(agent.id, {
      onSuccess: () => { leaving.current = true; void navigate('/settings/agents') },
      onError: (e) => { setConfirmDel(false); setSaveErr(errorText(e)) },
    })
  }

  return (
    <div className={cls('ag-editor-grid', debugFolded && 'debug-folded')}>
    <div className="ag-editor">
      <PageTitle parent="Agent" desc={d.desc || undefined}>{creating ? '新建 Agent' : d.name || '未命名'}</PageTitle>
      <div className="ag-editor-head">
        <Button onClick={() => void navigate('/settings/agents')}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Agent
        </Button>
        <span className="ag-sub">会话、执行记录和产出结果在左侧「会话」菜单里看</span>
      </div>

      <div className="ag-tabs" role="tablist" aria-label="配置">
        {EDITOR_TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={cls(tab === t.key && 'on')} onClick={() => go(t.key)} title={issues[t.key]}>
            {t.label}
            {counts[t.key] !== undefined && <span className="seg-n">{counts[t.key]}</span>}
            {issues[t.key] && <span className="ag-dot" aria-label={issues[t.key]} />}
          </button>
        ))}
      </div>

      <div className="ag-body" role="tabpanel">
        {tab === 'basic' && (
          <>
            <div className="ag-ident">
              <AvatarEditor agent={d} onChange={(p) => set(p)} />
              <div className="ag-ident-fields">
                <input className={cls('ag-title-input', tried && !d.name.trim() && 'bad')} aria-label="名称" value={d.name} maxLength={100}
                  placeholder="Agent 名称，比如：消息分诊助手" aria-invalid={(tried && !d.name.trim()) || undefined} onChange={(e) => set({ name: e.target.value })} />
                <input className="ag-desc-input" aria-label="说明" value={d.desc} maxLength={500} placeholder="一句话说明它负责什么"
                  onChange={(e) => set({ desc: e.target.value })} />
              </div>
            </div>
            <section className="ag-sec">
              <Switch className="ag-switch-row" checked={d.enabled} onCheckedChange={(v) => set({ enabled: v })}>
                <span className="ag-switch-text">
                  <span className="ag-sec-title">启用</span>
                  <span className="ag-sub">{d.enabled ? '启用中，会按触发方式自动运行' : '停用后不再被触发，已有会话和执行记录保留'}</span>
                </span>
              </Switch>
            </section>
          </>
        )}

        {tab === 'model' && (
          <ModelTab models={models} curKey={curKey} issue={issues.model} pick={pickModel} q={modelQ}
            thinking={d.thinking ?? 'default'} onThinking={(t) => set({ thinking: t })}
            onPick={(open) => { setPickModel(open); setModelQ('') }} onQ={setModelQ}
            onSelect={(m) => { set({ provider_id: m.providerId, model: m.model }); setPickModel(false) }} />
        )}

        {tab === 'instructions' && (
          <section className="ag-sec">
            <div className="ag-sec-title">指令<span className="ag-hint">告诉它是谁、负责什么、按什么规矩做事</span></div>
            <Textarea className="ag-prompt" aria-label="指令" rows={10} value={d.instructions} maxLength={20000}
              placeholder={'比如：\n你是产品经理的消息分诊助手。先确认发消息的人是谁，再判断要不要跟进……'}
              onChange={(e) => set({ instructions: e.target.value })} />
          </section>
        )}

        {tab === 'skills' && (
          <section className="ag-sec">
            <div className="ag-mount-head">
              <div className="ag-sec-title">技能<span className="ag-hint">一段可复用的做事方法，挂上后 Agent 遇到对应的事就按它做</span></div>
              <MountPicker label="挂载技能" items={skills.filter((k) => !d.skills.includes(k.id))} empty="技能都挂上了"
                text={(k) => `${k.name} ${k.desc}`} group={skillSource} onPick={(id) => toggleId('skills', id)}
                render={(k) => <span className="ag-mount-text"><b>{k.name}</b><span className="ag-sub">{k.desc}</span></span>} />
            </div>
            {mountedSkills.length ? (
              <div className="ag-mount-list">
                {mountedSkills.map((k) => (
                  <div key={k.id} className="ag-mount-card" data-skill={k.id}>
                    <span className="ag-mount-icon ag-icon-skill" aria-hidden="true"><svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 2 9.4 6.6 14 8 9.4 9.4 8 14 6.6 9.4 2 8 6.6 6.6Z" fill="currentColor" /></svg></span>
                    <span className="ag-mount-text">
                      <span><b>{k.name}</b><Tag>{skillSource(k)}</Tag></span>
                      <span className="ag-sub ag-clamp">{k.instructions}</span>
                      {k.uses.length > 0 && <span className="ag-uses">用到：{k.uses.join('、')}</span>}
                    </span>
                    <Unmount name={k.name} onClick={() => toggleId('skills', k.id)} />
                  </div>
                ))}
              </div>
            ) : <div className="ag-mount-empty">还没挂技能</div>}
          </section>
        )}

        {tab === 'tools' && (gBase ? (
          <ToolsTab grants={g} mounted={mountedConns} candidates={candidates} open={openConn} onOpen={setOpenConn} onMode={setMode}
            onMount={mountConn} onUnmount={unmountConn} onGoConnectors={() => void navigate('/settings/connectors')} />
        ) : <div className="ag-mount-empty">正在读工具权限</div>)}

        {tab === 'kbs' && <KbTab mounted={mountedKbs} all={kbs} mountedIds={d.kbs} onToggle={(id) => toggleId('kbs', id)}
          onCreated={(kb) => setD((x) => ({ ...x, kbs: x.kbs.includes(kb.id) ? x.kbs : [...x.kbs, kb.id] }))} />}

        {tab === 'triggers' && <TriggersTab triggers={d.triggers} tried={tried} onChange={(ts) => set({ triggers: ts })} />}
      </div>

      <div className="ag-foot">
        {blocker.state === 'blocked' ? (
          <>
            <span className="ag-foot-note"><span className="ag-warn">有未保存的修改，离开后会丢掉</span></span>
            <Button onClick={() => blocker.reset()}>继续编辑</Button>
            <Button variant="danger" onClick={() => blocker.proceed()}>放弃修改</Button>
          </>
        ) : confirmDel ? (
          <DeleteConfirm impact={impact} busy={del.isPending} onCancel={() => setConfirmDel(false)} onDelete={remove} />
        ) : (
          <>
            <span className="ag-foot-note">
              {saveErr && <span className="danger-text" role="alert">{saveErr}</span>}
              {issueText && <span className="danger-text">{issueText}</span>}
              {!creating && changed && <span>有未保存的修改，切换标签不会丢</span>}
            </span>
            {!creating && <Button variant="danger-ghost" onClick={() => { setSaveErr(null); setConfirmDel(true) }}>删除</Button>}
            <Button variant="primary" disabled={!dirty || busy} onClick={save}>
              {creating ? (busy ? '正在创建' : '创建') : busy ? '正在保存' : saved || !dirty ? '已保存' : '保存'}
            </Button>
          </>
        )}
      </div>
    </div>
    <DebugChat config={debugConfig} name={d.name.trim()} avatar={<AgentAvatar agent={d} size={22} />} folded={debugFolded} onFold={setDebugFolded} onGoTools={() => go('tools')} />
    </div>
  )
}

function ModelTab({ models, curKey, issue, pick, q, onPick, onQ, onSelect, thinking, onThinking }: {
  thinking: AgentThinking
  onThinking: (t: AgentThinking) => void
  models: ModelChoice[]
  curKey: string | undefined
  issue: string | undefined
  pick: boolean
  q: string
  onPick: (open: boolean) => void
  onQ: (q: string) => void
  onSelect: (m: ModelChoice) => void
}) {
  // 只列可用的加当前选中的
  const usable = models.filter((m) => m.ok || m.key === curKey)
  const cur = models.find((m) => m.key === curKey)
  const opt = (m: ModelChoice) => (
    <label key={m.key} className={cls('ag-model-opt', m.key === curKey && 'on', !m.ok && 'bad')}>
      <input type="radio" name="agent-model" checked={m.key === curKey} disabled={!m.ok} onChange={() => onSelect(m)} />
      <span><b>{m.label}</b><span className={cls('ag-sub', !m.ok && 'danger-text')}>{m.note}</span></span>
    </label>
  )
  let body
  if (usable.length <= MANY_MODELS) {
    body = usable.length ? <div className="ag-model-list">{usable.map(opt)}</div>
      : <div className="ag-mount-empty">还没有可用的模型，先去「设置 / 模型服务商」接入一家</div>
  } else if (!pick) {
    body = (
      <div className="ag-model-cur">
        {cur ? opt(cur) : <span className="ag-mount-empty">还没选模型</span>}
        <Button size="sm" variant="outline" onClick={() => onPick(true)}>换模型<span className="seg-n">{usable.filter((m) => m.ok).length} 个可用</span></Button>
      </div>
    )
  } else {
    // 换模型：按服务商分组，能搜模型名和服务商
    const hits = usable.filter((m) => hasAll(`${m.label} ${m.model} ${m.note} ${m.group}`, q))
    const groups = [...new Set(hits.map((m) => m.group))]
    body = (
      <div className="ag-model-chooser">
        <div className="ag-model-chooser-bar">
          <MiniSearch value={q} onChange={onQ} placeholder="搜模型或服务商" autoFocus full />
          <Button size="sm" onClick={() => onPick(false)}>收起</Button>
        </div>
        {groups.map((g) => (
          <div key={g} className="ag-model-group" role="group" aria-label={g}>
            <div className="menu-label">{g}</div>
            <div className="ag-model-list">{hits.filter((m) => m.group === g).map(opt)}</div>
          </div>
        ))}
        {!hits.length && <div className="ag-mount-empty">没有匹配的模型</div>}
      </div>
    )
  }
  return (
    <section className="ag-sec">
      <div className="ag-sec-title">模型</div>
      {issue && <div className="ag-banner ag-banner-danger" role="alert">{issue}，Agent 调用会失败，换一个可用的模型。</div>}
      {body}
      <div className="ag-thinking">
        <label className="ag-sec-title" htmlFor="ag-thinking">思考<span className="ag-hint">调模型时要不要先想、想多深；本机模型想得越多越慢</span></label>
        <Select id="ag-thinking" className="ag-thinking-select" value={thinking} options={THINKING_OPTIONS}
          onValueChange={(v) => onThinking(v as AgentThinking)} />
        <span className="ag-sub">{THINKING_OPTIONS.find((o) => o.value === thinking)?.hint}。模型不支持时自动按模型默认跑。</span>
      </div>
    </section>
  )
}

function KbTab({ mounted, all, mountedIds, onToggle, onCreated }: {
  mounted: KnowledgeBase[]
  all: KnowledgeBase[]
  mountedIds: string[]
  onToggle: (id: string) => void
  onCreated: (kb: KnowledgeBase) => void
}) {
  const cats = useCategoryTree('doc').data ?? []
  const createKb = useCreateKb()
  const [form, setForm] = useState<{ name: string; sources: string[]; dir: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const catName = (id: string) => cats.find((c) => c.id === id)?.name ?? '已删除的分类'
  // 来源是文档分类名，挂了本地目录的加「本地目录 N 个」；篇数取知识库自己的计数，和知识库列表一致
  const kbLine = (k: KnowledgeBase) => {
    const dirs = k.settings?.dirs?.length ?? 0
    const src = [...k.sources.map(catName), ...(dirs ? [`本地目录 ${dirs} 个`] : [])]
    return `${src.length ? src.join('、') : '没选来源'} · ${k.counts?.docs ?? 0} 篇`
  }
  const { dir, error: dirErr } = normDir(form?.dir ?? '')
  const ready = !!form && !!form.name.trim() && !dirErr && (form.sources.length > 0 || !!dir) && !createKb.isPending
  const submit = () => {
    if (!form || !ready) return
    setErr(null)
    createKb.mutate({ name: form.name.trim(), sources: form.sources, settings: dir ? { dirs: [{ path: dir, auto_sync: true }] } : undefined }, {
      onSuccess: (kb) => { onCreated(kb); setForm(null) },
      onError: (e) => setErr(errorText(e)),
    })
  }
  return (
    <section className="ag-sec">
      <div className="ag-mount-head">
        <div className="ag-sec-title">知识库<span className="ag-hint">回答和写作时会先在这些资料里找依据</span></div>
        <Button size="sm" aria-expanded={!!form} onClick={() => { setErr(null); setForm(form ? null : { name: '', sources: [], dir: '' }) }}>新建知识库</Button>
        <MountPicker label="挂载知识库" items={all.filter((k) => !mountedIds.includes(k.id))} empty="知识库都挂上了"
          text={(k) => `${k.name} ${k.desc}`} onPick={onToggle}
          render={(k) => <span className="ag-mount-text"><b>{k.name}</b><span className="ag-sub">{kbLine(k)}</span></span>} />
      </div>
      {form && (
        <div className="ag-kb-new" role="group" aria-label="新建知识库">
          <Input value={form.name} aria-label="知识库名称" placeholder="知识库名称，比如：竞品资料" autoFocus maxLength={100}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <div className="ag-chips" role="group" aria-label="文档分类">
            {cats.map((c) => (
              <Checkbox key={c.id} className={cls('ag-chip', form.sources.includes(c.id) && 'on')} checked={form.sources.includes(c.id)}
                onChange={() => setForm({ ...form, sources: form.sources.includes(c.id) ? form.sources.filter((y) => y !== c.id) : [...form.sources, c.id] })}>
                {c.depth > 0 ? `${'· '.repeat(c.depth)}${c.name}` : c.name}
              </Checkbox>
            ))}
            {!cats.length && <span className="ag-sub">还没有文档分类</span>}
          </div>
          <Input className="ag-mono" invalid={!!dirErr} value={form.dir} aria-label="本地目录" placeholder="本地目录（可选），比如 /Volumes/docs/客户/远川科技"
            onChange={(e) => setForm({ ...form, dir: e.target.value })} />
          {dirErr && <span className="field-err">{dirErr}</span>}
          {err && <span className="field-err" role="alert">{err}</span>}
          <div className="ag-row">
            <Button size="sm" variant="primary" disabled={!ready} onClick={submit}>{createKb.isPending ? '正在建' : '建好并挂上'}</Button>
            <Button size="sm" onClick={() => { setForm(null); setErr(null) }}>取消</Button>
            <span className="ag-sub">选文档分类或填本地目录，至少一样；以后在知识库详情的「设置」里还能加目录</span>
          </div>
        </div>
      )}
      {mounted.length ? (
        <div className="ag-mount-list">
          {mounted.map((k) => (
            <div key={k.id} className="ag-mount-card" data-kb={k.id}>
              <span className="ag-mount-icon ag-icon-kb" aria-hidden="true"><svg viewBox="0 0 16 16" width="13" height="13"><path d="M3 3.5h4.5v9H3zM8.5 3.5H13v9H8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg></span>
              <span className="ag-mount-text">
                <b>{k.name}</b>
                <span className="ag-sub">{kbLine(k)} · {timeAgo(Date.parse(k.updated_at))}更新</span>
              </span>
              <Unmount name={k.name} onClick={() => onToggle(k.id)} />
            </div>
          ))}
        </div>
      ) : !form && <div className="ag-mount-empty">还没挂知识库</div>}
    </section>
  )
}

function DeleteConfirm({ impact, busy, onCancel, onDelete }: {
  impact: ReturnType<typeof useAgentImpact>
  busy: boolean
  onCancel: () => void
  onDelete: () => void
}) {
  if (!impact.data) {
    return (
      <>
        <span className="ag-foot-note">{impact.isError ? <span className="danger-text">检查删除影响失败：{errorText(impact.error)}</span> : '正在检查删除的影响'}</span>
        <Button onClick={onCancel}>取消</Button>
      </>
    )
  }
  const { blocks, items } = impact.data
  if (blocks.length) {
    return (
      <>
        <span className="danger-text ag-del-note" role="alert">不能删除：{blocks.map((b) => b.text).join('；')}</span>
        <Button onClick={onCancel}>知道了</Button>
      </>
    )
  }
  return (
    <>
      <span className="danger-text ag-del-note">{items.length ? `删除后${items.map((b) => b.text).join('；')}` : '删除后会话和执行记录保留'}</span>
      <Button onClick={onCancel}>取消</Button>
      <Button variant="danger" disabled={busy} onClick={onDelete}>{busy ? '正在删除' : '删除'}</Button>
    </>
  )
}
