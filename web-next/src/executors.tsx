// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置 > 执行器（本机 CLI 执行器配置，SPEC-settings-29）。正式产品 frontend/src/modules/settings/executors/ExecutorsSection.tsx、
// core/data/executors.ts（/api/executors），SOP 的「Claude Code」节点按这里配的执行器跑（7b454ca6）。
// 原型没有后端：卡片列表、搜索、新建/编辑抽屉（类型、程序路径探测、模型服务商、测试对话、Codex 的终端命令）、删除确认都在本页模拟；
// 「探测」把命令名补成 /usr/local/bin/<名字> 并给一个演示版本号，测试对话固定回一段加载项 JSON。
import { useEffect, useState } from 'react'
import type { ModelConf, Provider } from './modeldata'
import { PageTitle } from './topbar'
import './setx.css'

export type ExecutorKind = 'claude' | 'deepseek' | 'codex'
export interface Executor { id: string; name: string; kind: ExecutorKind; bin: string; desc: string; enabled: boolean; provider_id?: string; use_cli_config?: boolean }
type ExecutorInput = Omit<Executor, 'id'>
type Probe = { path: string; version: string; warnings: string[]; base_url?: string; config_source?: string }

const TYPES: { value: ExecutorKind; label: string }[] = [{ value: 'claude', label: 'Claude Code' }, { value: 'deepseek', label: 'DeepSeek' }, { value: 'codex', label: 'Codex CLI（ChatGPT）' }]
const VERSION: Record<ExecutorKind, string> = { claude: '2.1.4 (Claude Code)', deepseek: 'dsh 0.9.2', codex: 'codex-cli 0.48.0' }
const blank = (): ExecutorInput => ({ name: '', kind: 'claude', bin: 'claude', desc: '', enabled: true, provider_id: '' })
const TEST_PROMPT = '这个会话加载到了什么 skills、什么 MCP、什么 RAG、什么规则？只需要给我名字即可，按 JSON 结构返回：{"skill":[],"mcp":[],"rag":[],"rule":[]}。只列出当前会话确实可见或已加载的项目，不要猜测；无法确认或没有的类别返回空数组。只返回 JSON。'

/** 演示数据：一个能用的 Claude Code、一个没选服务商的 DeepSeek、一个停用的 Codex */
export const seedExecutors: Executor[] = [
  { id: 'ex_claude', name: 'Claude Code（本机）', kind: 'claude', bin: '/usr/local/bin/claude', desc: 'SOP 里「Claude Code」节点默认用它', enabled: true, provider_id: 'pv_anthropic' },
  { id: 'ex_dsh', name: 'DeepSeek', kind: 'deepseek', bin: 'dsh', desc: '', enabled: true, provider_id: '' },
  { id: 'ex_codex', name: 'Codex', kind: 'codex', bin: '/usr/local/bin/codex', desc: '用本机 ChatGPT 登录', enabled: false, use_cli_config: true },
]

/** 模拟 POST /api/executors/probe：命令名补成完整路径；路径里带 missing 的当找不到 */
function probe(x: ExecutorInput): Probe {
  const bin = x.bin.trim()
  if (!bin) return { path: '', version: '', warnings: [] }
  if (bin.includes('missing')) return { path: '', version: '', warnings: [`找不到可执行文件：${bin}`] }
  const path = bin.startsWith('/') ? bin : `/usr/local/bin/${bin}`
  return { path, version: VERSION[x.kind], warnings: [], ...(x.kind === 'codex' && x.use_cli_config && { base_url: '', config_source: '~/.codex/config.toml' }) }
}
/** 卡片上的「配置缺失」：没选服务商（Codex 用本机配置时不用选） */
const warningsOf = (x: ExecutorInput, providers: Provider[]) => [
  ...(!x.provider_id && !(x.kind === 'codex' && x.use_cli_config) ? ['未选择模型服务商'] : []),
  ...(x.provider_id && !providers.some((p) => p.id === x.provider_id) ? ['所选服务商已删除'] : []),
]

export function ExecutorsPage({ providers, models }: { providers: Provider[]; models: ModelConf[] }) {
  const [list, setList] = useState(seedExecutors)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Executor | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Executor | null>(null)
  const modelOf = (pid?: string) => models.find((m) => m.provider_id === pid && m.enabled)?.id
  const q = search.trim().toLowerCase()
  const shown = list.filter((x) => `${x.name} ${x.kind} ${x.bin} ${x.desc}`.toLowerCase().includes(q))
  const save = (input: ExecutorInput, id?: string) => {
    setList((xs) => (id ? xs.map((x) => (x.id === id ? { ...input, id } : x)) : [...xs, { ...input, id: `ex_${Date.now().toString(36)}` }]))
    setEditing(null)
  }
  return (
    <div className="page setx-page">
      <PageTitle parent="设置" count={list.length} desc="管理本机 CLI 执行器配置" actions={<button className="act act-primary" onClick={() => setEditing('new')}>新建执行器</button>}>执行器</PageTitle>
      <input aria-label="搜索执行器" placeholder="搜索名称、类型、程序路径或说明" value={search} onChange={(e) => setSearch(e.target.value)} />
      {!shown.length && <div className="empty"><div className="empty-title">{search ? '没有匹配的执行器' : '还没有执行器'}</div></div>}
      {shown.map((item) => {
        const pv = providers.find((p) => p.id === item.provider_id)
        const pr = probe(item)
        const warns = warningsOf(item, providers)
        return (
          <article className="setx-card" key={item.id}>
            <header className="exe-card-header">
              <div className="exe-identity">
                <span className="exe-icon" aria-hidden="true">›_</span>
                <div>
                  <div className="setx-card-head"><b>{item.name}</b><span className={item.enabled ? 'exe-status on' : 'exe-status'}><i />{item.enabled ? '已启用' : '已停用'}</span></div>
                  <div className="exe-type">{TYPES.find((t) => t.value === item.kind)?.label ?? item.kind}</div>
                </div>
              </div>
              <div className="act-row">
                <button className="act" onClick={() => setEditing(item)}>编辑</button>
                <button className="act act-quiet btn-danger-ghost" onClick={() => setDeleting(item)}>删除</button>
              </div>
            </header>
            <div className="exe-row"><span className="exe-label">模型服务</span><span>{pv?.name || '未选择模型服务商'}</span><span className="muted setx-sm">{modelOf(item.provider_id) || '未配置模型'}</span></div>
            <div className="exe-runtime">
              <div className="exe-row"><span className="exe-label">程序路径</span><code>{item.bin}</code></div>
              {pr.version && <div className="exe-row"><span className="exe-label">版本</span><span className="muted setx-sm">{pr.version}</span></div>}
              {pr.warnings.length > 0 && !warns.length && <div className="setx-warn">注意：{pr.warnings.join('；')}</div>}
            </div>
            {warns.length > 0 && <div className="setx-warn" role="status">配置缺失：{warns.join('；')}</div>}
            {item.desc && <div className="muted setx-sm">{item.desc}</div>}
          </article>
        )
      })}
      {editing && (
        <ExecutorEditor key={editing === 'new' ? 'new' : editing.id} initial={editing === 'new' ? undefined : editing} providers={providers} models={models}
          onClose={() => setEditing(null)} onSave={(x) => save(x, editing === 'new' ? undefined : editing.id)} />
      )}
      {deleting && (
        <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) setDeleting(null) }}>
          <div className="qs" role="alertdialog" aria-label="删除执行器">
            <div className="qs-head"><b>删除执行器「{deleting.name}」？</b></div>
            <div>删除此配置，不会卸载本机 CLI。</div>
            <div className="act-row"><span className="spacer" />
              <button className="act act-quiet" onClick={() => setDeleting(null)}>取消</button>
              <button className="act btn-danger" onClick={() => { setList((xs) => xs.filter((x) => x.id !== deleting.id)); setDeleting(null) }}>删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ExecutorEditor({ initial, providers, models, onClose, onSave }: {
  initial?: Executor; providers: Provider[]; models: ModelConf[]; onClose: () => void; onSave: (x: ExecutorInput) => void
}) {
  const base: ExecutorInput = initial
    ? { name: initial.name, kind: initial.kind, bin: initial.bin, desc: initial.desc, enabled: initial.enabled, provider_id: initial.provider_id ?? '', use_cli_config: initial.use_cli_config ?? false }
    : blank()
  const [draft, setDraft] = useState<ExecutorInput>(base)
  const [pr, setPr] = useState<Probe | null>(null)
  const [msgs, setMsgs] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [input, setInput] = useState(TEST_PROMPT)
  const [sending, setSending] = useState(false)
  const [asking, setAsking] = useState(false)
  // 改了程序路径、类型后过一会儿再探测（正式产品 600ms 防抖）
  useEffect(() => {
    setPr(null)
    const t = window.setTimeout(() => setPr(probe(draft)), 600)
    return () => window.clearTimeout(t)
  }, [draft.bin, draft.kind, draft.use_cli_config])
  // 换了执行器的关键配置，测试对话重开
  useEffect(() => { setMsgs([]); setInput(TEST_PROMPT) }, [draft.kind, draft.bin, draft.provider_id, draft.use_cli_config])
  const dirty = JSON.stringify(draft) !== JSON.stringify(base)
  const patch = (v: Partial<ExecutorInput>) => setDraft((d) => ({ ...d, ...v }))
  const cliCfg = draft.kind === 'codex' && !!draft.use_cli_config
  const pv = providers.find((p) => p.id === draft.provider_id)
  const close = () => (dirty ? setAsking(true) : onClose())
  const send = () => {
    const text = input.trim()
    if (!text || sending) return
    setMsgs((xs) => [...xs, { role: 'user', content: text }])
    setInput('')
    setSending(true)
    window.setTimeout(() => {
      const reply = text === TEST_PROMPT.trim()
        ? JSON.stringify({ skill: ['web-video-presentation'], mcp: ['pmw', 'github'], rag: [], rule: ['CLAUDE.md'] })
        : '原型没有真的执行器：这里只演示对话的样子。'
      setMsgs((xs) => [...xs, { role: 'assistant', content: reply }])
      setSending(false)
    }, 700)
  }
  const command = `PMW_CODEX_API_KEY=\${PMW_CODEX_API_KEY:?先设置密钥} ${draft.bin || 'codex'} exec --sandbox read-only${cliCfg ? '' : ` -c model_provider=pmw -c model_providers.pmw.base_url=${pv?.values.base_url || 'https://api.example.com/v1'} -m ${models.find((m) => m.provider_id === pv?.id && m.enabled)?.id ?? '<模型>'}`} "列出当前目录"`
  return (
    <div className="setx-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <aside className="drawer setx-drawer" aria-label={initial ? '编辑执行器' : '新建执行器'}>
        <div className="drawer-head">
          <span className="drawer-kicker">{initial ? '编辑执行器' : '新建执行器'}</span>
          <div className="spacer" />
          <button className="icon-btn" onClick={close} title="关闭 (Esc)">
            <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className="drawer-body form">
          <section className="setx-sec" aria-label="基本信息"><h3>基本信息</h3>
            <div className="setx-grid2">
              <label className="field"><span className="field-label">名称<em>*</em></span><input value={draft.name} maxLength={100} onChange={(e) => patch({ name: e.target.value })} /></label>
              <label className="field"><span className="field-label">类型<em>*</em></span>
                <select className="select" value={draft.kind} onChange={(e) => { const kind = e.target.value as ExecutorKind; patch({ kind, bin: kind === 'claude' ? 'claude' : kind === 'codex' ? 'codex' : 'dsh', use_cli_config: kind === 'codex' }) }}>
                  {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </label>
            </div>
            <label className="field"><span className="field-label">说明</span><textarea rows={2} value={draft.desc} maxLength={1000} placeholder="可选，说明这个执行器的用途" onChange={(e) => patch({ desc: e.target.value })} /></label>
            <label className="setx-demo"><input type="checkbox" checked={draft.enabled} onChange={(e) => patch({ enabled: e.target.checked })} /> 启用</label>
          </section>
          <section className="setx-sec" aria-label="运行配置"><h3>运行配置</h3>
            <label className="field"><span className="field-label">程序路径<em>*</em><span className="field-hint">填写程序绝对路径；输入命令名可探测完整路径与版本</span></span>
              <input value={draft.bin} onChange={(e) => patch({ bin: e.target.value })} /></label>
            {pr && (pr.path || pr.version) && (
              <dl className="exe-meta">
                {pr.path && <div><dt>解析路径</dt><dd><code>{pr.path}</code>{pr.path !== draft.bin && <button className="act" onClick={() => patch({ bin: pr.path })}>使用完整路径</button>}</dd></div>}
                {pr.version && <div><dt>版本</dt><dd><code>{pr.version}</code></dd></div>}
              </dl>
            )}
            {!!pr?.warnings.length && <div className="setx-warn" role="status">注意：{pr.warnings.join('；')}</div>}
            {draft.kind === 'codex' && <label className="setx-demo"><input type="checkbox" checked={cliCfg} onChange={(e) => patch({ use_cli_config: e.target.checked })} /> 使用本机 Codex 登录和模型配置（ChatGPT）</label>}
            {!cliCfg && (
              <label className="field"><span className="field-label">模型服务商<span className="field-hint">模型使用所选服务商配置的模型名称及版本</span></span>
                <select className="select" value={draft.provider_id ?? ''} onChange={(e) => patch({ provider_id: e.target.value })}>
                  <option value="">请选择模型服务商</option>
                  {providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {models.find((m) => m.provider_id === p.id && m.enabled)?.id ?? '未配置模型'}{p.enabled ? '' : '（已停用）'}</option>)}
                  {draft.provider_id && !providers.some((p) => p.id === draft.provider_id) && <option value={draft.provider_id}>服务商已删除或尚未加载</option>}
                </select>
              </label>
            )}
            {draft.kind === 'codex' && (
              <div>
                <dl className="exe-meta">
                  <div><dt>base_url</dt><dd><code>{cliCfg ? (pr ? pr.base_url || '未显式配置（使用 CLI 默认路由）' : '读取中…') : pv?.values.base_url || '未选择服务商或未配置地址'}</code></dd></div>
                  {cliCfg && pr?.config_source && <div><dt>配置来源</dt><dd><code>{pr.config_source}</code></dd></div>}
                </dl>
                {cliCfg && <p className="muted setx-sm">仅展示本机文件配置，运行时可能被环境变量或 CLI 默认值覆盖。</p>}
              </div>
            )}
            {!draft.provider_id && !cliCfg && <div className="setx-warn">未选择模型服务商，配置尚不完整</div>}
          </section>
          <section className="setx-sec" aria-label="配置测试"><h3>测试验证</h3>
            <p className="muted setx-sm">{cliCfg ? '通过 Codex CLI 使用本机登录和默认模型，在临时目录中进行只读测试。' : draft.kind === 'codex' ? '通过 Codex CLI 在临时目录中以只读沙箱测试所选服务商和模型；服务商需要支持 Responses API。' : '通过所选本机 CLI，在临时目录中以只读模式测试当前配置；程序、认证或服务商不兼容时直接报错。'}</p>
            {draft.kind === 'codex' && <ExecutorCommand command={command} />}
            <div className="field-label">测试对话</div>
            <div className="exe-chat">
              {!msgs.length && <div className="muted setx-sm">查询当前会话加载的 Skill、MCP、RAG 和规则，也可以继续追问。</div>}
              {msgs.map((m, i) => <div key={i} className={m.role === 'user' ? 'exe-chat-msg me' : 'exe-chat-msg'}>{m.role === 'assistant' ? <TestReply reply={m.content} /> : m.content}</div>)}
              {sending && <div className="muted setx-sm">正在测试…</div>}
              <textarea aria-label="测试消息" rows={3} value={input} onChange={(e) => setInput(e.target.value)} disabled={!draft.provider_id && !cliCfg} />
              <div className="act-row"><span className="spacer" /><button className="act act-primary" disabled={sending || !input.trim() || (!draft.provider_id && !cliCfg)} onClick={send}>发送测试</button></div>
            </div>
          </section>
        </div>
        <div className="drawer-foot">
          <span className="spacer" />
          <button className="act act-quiet" onClick={close}>取消</button>
          <button className="act act-primary" disabled={!draft.name.trim() || !draft.bin.trim()} onClick={() => onSave(draft)}>保存</button>
        </div>
      </aside>
      {asking && (
        <div className="qs-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) setAsking(false) }}>
          <div className="qs" role="alertdialog" aria-label="放弃修改">
            <div className="qs-head"><b>放弃没保存的修改？</b></div>
            <div className="act-row"><span className="spacer" />
              <button className="act act-quiet" onClick={() => setAsking(false)}>继续编辑</button>
              <button className="act btn-danger" onClick={onClose}>放弃</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 回复是约定的 JSON 就画成加载项表，否则原样显示 */
function TestReply({ reply }: { reply: string }) {
  let inv: Record<string, string[]> | null = null
  try {
    const v: unknown = JSON.parse(reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
    if (v && typeof v === 'object' && !Array.isArray(v) && ['skill', 'mcp', 'rag', 'rule'].every((k) => Array.isArray((v as Record<string, unknown>)[k]))) inv = v as Record<string, string[]>
  } catch { /* 不是约定的结构，原样显示 */ }
  if (!inv) return <>{reply}</>
  return (
    <div role="status">
      <table className="exe-inventory"><thead><tr><th>类别</th><th>名称</th></tr></thead><tbody>
        {([['skill', 'Skill'], ['mcp', 'MCP'], ['rag', 'RAG'], ['rule', '规则']] as const).map(([k, label]) => (
          <tr key={k}><th scope="row">{label}</th><td>{inv![k].length ? inv![k].map((n, i) => <div key={i}>{n}</div>) : '无 / 未确认'}</td></tr>
        ))}
      </tbody></table>
      <p className="muted setx-sm">当前测试会话自报的加载项，仅在此展示。</p>
    </div>
  )
}

function ExecutorCommand({ command }: { command: string }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [err, setErr] = useState('')
  return (
    <section className="exe-cmd" aria-label="终端验证命令">
      <div className="exe-cmd-head">
        <button className="link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '收起' : '展开'} bash</button>
        <button className="act" onClick={() => { void navigator.clipboard.writeText(command).then(() => { setCopied(true); setErr('') }, () => setErr('复制失败，请手动选择命令复制')) }}>{copied ? '已复制' : 'Copy'}</button>
      </div>
      {err && <p className="danger-text setx-sm" role="alert">{err}</p>}
      {open && <>
        <pre><code>{command}</code></pre>
        <p className="muted setx-sm" style={{ padding: '0 10px' }}>复制到终端即可执行。指定服务商时，优先读取 PMW_CODEX_API_KEY；未设置则提示输入密钥。命令不包含已保存的密钥。</p>
      </>}
    </section>
  )
}
