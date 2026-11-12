// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useEffect, useId, useState } from 'react'
import { errorText, useAgentProviders } from '../../../core/data'
import { useExecutors, useSaveExecutor, useDeleteExecutor, executorsApi, type ExecutorProbe, type Executor, type ExecutorInput } from '../../../core/data/executors'
import { ChatPanel, Button, Checkbox, ConfirmDialog, Drawer, EmptyState, ErrorState, Field, Input, LoadingState, PageTitle, Select, Textarea } from '../../../core/ui'
import '../runprompts/runprompts.css'
import './executors.css'

const TYPES = [{ value: 'claude', label: 'Claude Code' }, { value: 'deepseek', label: 'DeepSeek' }, { value: 'codex', label: 'Codex CLI（ChatGPT）' }]
const blank = (): ExecutorInput => ({ name: '', kind: 'claude', bin: 'claude', desc: '', enabled: true, provider_id: '' })

export function ExecutorsSection() {
  const query = useExecutors()
  const remove = useDeleteExecutor()
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Executor | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Executor | null>(null)
  const list = (query.data ?? []).filter((x) => `${x.name} ${x.kind} ${x.bin} ${x.desc}`.toLowerCase().includes(search.trim().toLowerCase()))
  return <div className="rp-page">
    <PageTitle parent="设置" count={query.data?.length} desc="管理本机 CLI 执行器配置" actions={<Button variant="primary" onClick={() => setEditing('new')}>新建执行器</Button>}>执行器</PageTitle>
    <Input aria-label="搜索执行器" placeholder="搜索名称、类型、程序路径或说明" value={search} onChange={(e) => setSearch(e.target.value)} />
    {query.isPending ? <LoadingState /> : query.isError ? <ErrorState title="执行器没加载出来" error={errorText(query.error)} onRetry={() => void query.refetch()} /> : <>
      {!list.length && <EmptyState title={search ? '没有匹配的执行器' : '还没有执行器'} />}
      <div className="executor-list">{list.map((item) => <article className="executor-card" key={item.id}>
        <header className="executor-card-header">
          <div className="executor-card-identity"><span className="executor-card-icon" aria-hidden="true">›_</span><div><div className="executor-card-title"><strong>{item.name}</strong><span className={`executor-card-status${item.enabled ? ' is-enabled' : ''}`}><i />{item.enabled ? '已启用' : '已停用'}</span></div><div className="executor-card-type">{TYPES.find((x) => x.value === item.kind)?.label ?? item.kind}</div></div></div>
          <div className="executor-card-actions"><Button size="sm" onClick={() => setEditing(item)}>编辑</Button><Button size="sm" variant="danger-ghost" onClick={() => { remove.reset(); setDeleting(item) }}>删除</Button></div>
        </header>
        <div className="executor-card-model"><span className="executor-card-label">模型服务</span><div><span>{item.provider_name || '未选择模型服务商'}</span><span className="executor-card-model-name">{item.model || '未配置模型'}</span></div></div>
        <div className="executor-card-runtime"><div className="executor-card-path"><span className="executor-card-label">程序路径</span><code>{item.bin}</code></div><ExecutorVersion item={item} /></div>
        {!!item.warnings?.length && <div className="executor-warning" role="status">⚠ 配置缺失：{item.warnings.join('；')}</div>}
        {item.desc && <div className="executor-card-desc">{item.desc}</div>}
      </article>)}</div>
    </>}
    {editing && <ExecutorEditor key={editing === 'new' ? 'new' : editing.id} initial={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    <ConfirmDialog open={!!deleting} title={`删除执行器「${deleting?.name ?? ''}」？`} danger busy={remove.isPending} confirmLabel="删除" onCancel={() => setDeleting(null)}
      onConfirm={() => { if (deleting) remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) }) }}>
      删除此配置，不会卸载本机 CLI。
      {remove.isError && <div role="alert">{errorText(remove.error)}</div>}
    </ConfirmDialog>
  </div>
}

function ExecutorEditor({ initial, onClose }: { initial?: Executor; onClose: () => void }) {
  const [draft, setDraft] = useState<ExecutorInput>(() => initial ? { name: initial.name, kind: initial.kind, bin: initial.bin, desc: initial.desc, enabled: initial.enabled, provider_id: initial.provider_id ?? '', use_cli_config: initial.use_cli_config ?? false } : blank())
  const save = useSaveExecutor()
  const providers = useAgentProviders()
  const [probe, setProbe] = useState<ExecutorProbe | null>(null)
  const [probeError, setProbeError] = useState('')
  const initialMessage = ('这个会话加载到了什么 skills、什么 MCP、什么 RAG、什么规则？只需要给我名字即可，按 JSON 结构返回：{"skill":[],"mcp":[],"rag":[],"rule":[]}。只列出当前会话确实可见或已加载的项目，不要猜测；无法确认或没有的类别返回空数组。只返回 JSON。')
  useEffect(() => {
    setProbe(null); setProbeError('')
    const controller = new AbortController()
    const timer = window.setTimeout(() => { if (draft.bin.trim()) void executorsApi.probe(draft, controller.signal).then(setProbe, (e) => { if (!controller.signal.aborted) setProbeError(errorText(e)) }) }, 600)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [draft.bin, draft.kind, draft.use_cli_config])
  const baseline = initial ? { name: initial.name, kind: initial.kind, bin: initial.bin, desc: initial.desc, enabled: initial.enabled, provider_id: initial.provider_id ?? '', use_cli_config: initial.use_cli_config ?? false } : blank()
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline)
  const patch = (value: Partial<ExecutorInput>) => setDraft((old) => ({ ...old, ...value }))
  return <Drawer open kicker={initial ? '编辑执行器' : '新建执行器'} onClose={onClose} dirty={dirty}
    footer={(requestClose) => <><Button onClick={requestClose}>取消</Button><Button variant="primary" disabled={save.isPending || !draft.name.trim() || !draft.bin.trim()} onClick={() => save.mutate({ id: initial?.id, input: draft }, { onSuccess: onClose })}>{save.isPending ? '保存中…' : '保存'}</Button></>}>
    <div className="form executor-editor">
      <section className="executor-editor-section" aria-label="基本信息"><h3>基本信息</h3>
      <div className="executor-editor-grid">
      <Field label="名称" required><Input aria-label="执行器名称" value={draft.name} maxLength={100} onChange={(e) => patch({ name: e.target.value })} /></Field>
      <Field label="类型" required><Select aria-label="执行器类型" value={draft.kind} options={TYPES} onValueChange={(kind) => patch({ kind: kind as Executor['kind'], bin: kind === 'claude' ? 'claude' : kind === 'codex' ? 'codex' : 'dsh', use_cli_config: kind === 'codex' })} /></Field>
      </div>
      <Field label="说明"><Textarea aria-label="执行器说明" rows={2} value={draft.desc} maxLength={1000} placeholder="可选，说明这个执行器的用途" onChange={(e) => patch({ desc: e.target.value })} /></Field>
      <Checkbox checked={draft.enabled} onCheckedChange={(enabled) => patch({ enabled })}>启用</Checkbox>
      </section>
      <section className="executor-editor-section" aria-label="运行配置"><h3>运行配置</h3>
      <Field label="程序路径" required hint="填写程序绝对路径；输入命令名可探测完整路径与版本"><Input aria-label="程序路径" value={draft.bin} onChange={(e) => patch({ bin: e.target.value })} /></Field>
      {(probe?.path || probe?.version) && <dl className="executor-editor-metadata">
        {probe.path && <div><dt>解析路径</dt><dd><code>{probe.path}</code>{probe.path !== draft.bin && <Button size="sm" onClick={() => patch({ bin: probe.path })}>使用完整路径</Button>}</dd></div>}
        {probe.version && <div><dt>版本</dt><dd><code>{probe.version}</code></dd></div>}
      </dl>}
      {(probeError || !!probe?.warnings?.length) && <div className="executor-warning" role="status">⚠ {probeError || probe?.warnings.join('；')}</div>}
      {draft.kind === 'codex' && <Checkbox checked={!!draft.use_cli_config} onCheckedChange={(use_cli_config) => patch({ use_cli_config })}>使用本机 Codex 登录和模型配置（ChatGPT）</Checkbox>}
      {!(draft.kind === 'codex' && draft.use_cli_config) && <Field label="模型服务商" hint="模型使用所选服务商配置的模型名称及版本">
        <Select aria-label="模型服务商" value={draft.provider_id ?? ''} options={[{ value: '', label: '请选择模型服务商' }, ...(providers.data ?? []).map((p) => ({ value: p.id, label: `${p.name} · ${p.model || '未配置模型'}${p.enabled ? '' : '（已停用）'}` })), ...(draft.provider_id && !(providers.data ?? []).some((p) => p.id === draft.provider_id) ? [{ value: draft.provider_id, label: '服务商已删除或尚未加载' }] : [])]} onValueChange={(provider_id) => patch({ provider_id })} />
      </Field>
      }
      {draft.kind === 'codex' && <div>
        <dl className="executor-editor-metadata"><div><dt>base_url</dt><dd><code>{draft.use_cli_config ? probe?.base_url || (probe ? '未显式配置（使用 CLI 默认路由）' : '读取中…') : (providers.data ?? []).find((p) => p.id === draft.provider_id)?.base_url || '未选择服务商或未配置地址'}</code></dd></div>
          {draft.use_cli_config && probe?.config_source && <div><dt>配置来源</dt><dd><code>{probe.config_source}</code></dd></div>}
        </dl>
        {draft.use_cli_config && <p className="executor-editor-hint">仅展示本机文件配置，运行时可能被环境变量或 CLI 默认值覆盖。</p>}
      </div>}
      {providers.isError && <div role="alert">服务商加载失败：{errorText(providers.error)}</div>}
      {!draft.provider_id && !(draft.kind === 'codex' && draft.use_cli_config) && <div className="executor-warning">⚠ 未选择模型服务商，配置尚不完整</div>}
      </section>
      <section aria-label="配置测试" className="executor-test executor-editor-section">
        <h3>测试验证</h3>
        <p className="rp-muted">{draft.kind === 'codex' && draft.use_cli_config ? '通过 Codex CLI 使用本机登录和默认模型，在临时目录中进行只读测试。' : draft.kind === 'codex' ? '通过 Codex CLI 在临时目录中以只读沙箱测试所选服务商和模型；服务商需要支持 Responses API。' : '通过所选本机 CLI，在临时目录中以只读模式测试当前配置；程序、认证或服务商不兼容时直接报错。'}</p>
        {draft.kind === 'codex' && <ExecutorCommand draft={draft} />}
        <div className="executor-editor-chat-label">测试对话</div>
        <ChatPanel key={JSON.stringify([draft.kind, draft.bin, draft.provider_id, draft.use_cli_config])}
          initialInput={initialMessage} inputLabel="测试消息" sendLabel="发送测试"
          emptyText="查询当前会话加载的 Skill、MCP、RAG 和规则，也可以继续追问。"
          disabled={!draft.provider_id && !(draft.kind === 'codex' && draft.use_cli_config)}
          onSend={async (messages, signal) => {
            const result = await executorsApi.test(draft, messages.at(-1)!.content, messages.slice(0, -1), signal)
            return result.reply
          }}
          renderMessage={(message) => message.role === 'assistant' ? <ExecutorTestReply reply={message.content} /> : message.content}
        />
      </section>
      {save.isError && <div role="alert">{errorText(save.error)}</div>}
    </div>
  </Drawer>
}

function ExecutorVersion({ item }: { item: Executor }) {
  const [result, setResult] = useState<ExecutorProbe | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    setResult(null); setError('')
    const controller = new AbortController()
    void executorsApi.probe(item, controller.signal).then(setResult, (e) => { if (!controller.signal.aborted) setError(errorText(e)) })
    return () => controller.abort()
  }, [item.bin, item.kind])
  return <>
    {result?.version && <div className="executor-card-version"><span className="executor-card-label">版本</span><span>{result.version}</span></div>}
    {(error || (!!result?.warnings?.length && !item.warnings?.length)) && <div className="executor-warning">⚠ {error || result?.warnings.join('；')}</div>}
  </>
}

export function ExecutorTestReply({ reply }: { reply: string }) {
  let inventory: Record<string, string[]> | null = null
  try {
    const text = reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const value: unknown = JSON.parse(text)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>
      if (['skill', 'mcp', 'rag', 'rule'].every((key) => Array.isArray(record[key]) && record[key].every((name: unknown) => typeof name === 'string'))) inventory = record as Record<string, string[]>
    }
  } catch { /* Keep the original reply visible when the model does not return the requested shape. */ }
  if (!inventory) return <div style={{ whiteSpace: 'pre-wrap' }}>{reply}</div>
  return <div role="status"><table className="executor-inventory"><thead><tr><th>类别</th><th>名称</th></tr></thead><tbody>
    {([['skill', 'Skill'], ['mcp', 'MCP'], ['rag', 'RAG'], ['rule', '规则']] as const).map(([key, label]) => <tr key={key}><th scope="row">{label}</th><td>{inventory[key].length ? inventory[key].map((name, i) => <div key={i}>{name}</div>) : '无 / 未确认'}</td></tr>)}
  </tbody></table><p className="rp-muted">当前测试会话自报的加载项，仅在此展示。</p></div>
}

function ExecutorCommand({ draft }: { draft: ExecutorInput }) {
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  const [command, setCommand] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setCommand(''); setError(''); setCopied(false)
    const timer = window.setTimeout(() => {
      void executorsApi.command(draft, controller.signal).then((r) => { if (!controller.signal.aborted) setCommand(r.command) }, (e) => { if (!controller.signal.aborted) setError(errorText(e)) })
    }, 400)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [draft.kind, draft.bin, draft.provider_id, draft.use_cli_config])
  return <section className="executor-command" aria-label="终端验证命令">
    <div className="executor-command-head"><Button className="executor-command-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded((value) => !value)}><span aria-hidden="true">{expanded ? '▾' : '▸'}</span><strong>bash</strong></Button><Button size="sm" disabled={!command} onClick={() => {
      void navigator.clipboard.writeText(command).then(() => { setCopied(true); setError('') }, () => setError('复制失败，请手动选择命令复制'))
    }}>{copied ? '已复制' : 'Copy'}</Button></div>
    {error && <p role="alert">{error}</p>}
    <div id={contentId} hidden={!expanded}>
      {command ? <pre><code>{command}</code></pre> : !error && <p className="rp-muted">正在生成命令…</p>}
      <p className="rp-muted">复制到终端即可执行。指定服务商时，优先读取 PMW_CODEX_API_KEY；未设置则提示输入密钥。命令不包含已保存的密钥。</p>
    </div>
  </section>
}
