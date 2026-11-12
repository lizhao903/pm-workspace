// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// Agent 供应商：配置 Agent 到底调哪家模型服务。三种接入方式——OpenAI 兼容端点、
// Google Gemini、本机 Ollama。
//
// 这一页最硬的一条约束：API Key 是只写的。后端从不返回明文，界面上只出现
// api_key_masked（形如 sk-…f3a2）。任何时候都不要试图把明文回填到输入框里，
// 「留空 = 不改」这套三态就是为了让明文永远不用往回走一遍。
import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { api } from '../../lib/api'
import type { AgentProvider, AgentProviderInput, ProviderKind, ProviderTestResult } from '../../lib/types'
import { Button, ConfirmDialog, Field, RelativeTime, Select, TextInput } from '../../components/ui'
import { SectionHead, errText, useAsyncAction } from './common'

/** 三种接入方式各自的默认端点与说明。默认端点与后端 providerDefaultBaseURL 保持一致。 */
interface KindMeta {
  kind: ProviderKind
  label: string
  baseURL: string
  /** 表单里跟在 base_url 下面的一句话 */
  hint: string
  /** ollama 跑在本机、没有鉴权，是唯一不需要密钥的 */
  needsKey: boolean
}

const KINDS: KindMeta[] = [
  {
    kind: 'openai',
    label: 'OpenAI 兼容',
    baseURL: 'https://api.openai.com/v1',
    needsKey: true,
    hint: '凡是提供 /v1/chat/completions 的端点都走这一类。兼容端点可改成自己的地址，如 DeepSeek、Moonshot、本地 vLLM。',
  },
  {
    kind: 'gemini',
    label: 'Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    needsKey: true,
    hint: 'Google 官方端点。用自建代理时把地址换成代理的 v1beta 前缀。',
  },
  {
    kind: 'ollama',
    label: '本机 Ollama',
    baseURL: 'http://localhost:11434',
    needsKey: false,
    hint: '跑在本机的模型服务，不需要 API Key，确认 ollama 正在运行即可。端口改过就在这里改。',
  },
]

function metaOf(kind: ProviderKind): KindMeta {
  return KINDS.find((k) => k.kind === kind) ?? KINDS[0]
}

const KIND_OPTIONS = KINDS.map((k) => ({ value: k.kind, label: k.label }))

/** 表单内部状态。api_key 只出不进：编辑时初值永远是空串，空串表示「不改」。 */
interface FormState {
  name: string
  kind: ProviderKind
  base_url: string
  model: string
  api_key: string
  enabled: boolean
}

function blankForm(kind: ProviderKind, name = ''): FormState {
  return { name, kind, base_url: metaOf(kind).baseURL, model: '', api_key: '', enabled: true }
}

function formOf(p: AgentProvider): FormState {
  return { name: p.name, kind: p.kind, base_url: p.base_url, model: p.model, api_key: '', enabled: p.enabled }
}

/** 测试结果的两种配色都从 token 推导，没有新增 CSS 类，所以走内联 style。 */
function resultStyle(ok: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '8px',
    padding: '6px 9px',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-sm)',
    color: ok ? 'var(--ok)' : 'var(--danger)',
    background: ok ? 'var(--ok-soft)' : 'var(--danger-soft)',
    border: `1px solid color-mix(in srgb, ${ok ? 'var(--ok)' : 'var(--danger)'} 26%, transparent)`,
  }
}

const DEFAULT_TAG_STYLE: CSSProperties = {
  color: 'var(--accent)',
  borderColor: 'var(--accent-line)',
  background: 'var(--accent-soft)',
  fontWeight: 600,
  flex: 'none',
}

export default function ProvidersSection() {
  const { busy, error, setError, run } = useAsyncAction()

  const [items, setItems] = useState<AgentProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState<FormState | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<AgentProvider | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  // 测试结果不持久化，只是当次反馈；成功时带回的 models 用来把模型输入框升级成下拉。
  const [results, setResults] = useState<Record<string, ProviderTestResult>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await api.providers())
    } catch {
      setItems([]) // 读失败一律按空态，不弹横幅（写操作的失败才显示）
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const startCreate = (kind: ProviderKind, name: string) => {
    setEditingId(null)
    setError(null)
    setCreating(blankForm(kind, name))
  }

  /**
   * 探测失败是正常业务结果，后端一律 200 + ok=false，message 已经归类成人话，
   * 直接原样显示，不要再包一层「操作失败」。走到 catch 的只有接口层面的错（如记录已被删）。
   */
  const test = async (p: AgentProvider) => {
    setTestingId(p.id)
    setError(null)
    try {
      const r = await api.testProvider(p.id)
      setResults((m) => ({ ...m, [p.id]: r }))
    } catch (e) {
      setResults((m) => ({ ...m, [p.id]: { ok: false, latency_ms: 0, message: errText(e) } }))
    } finally {
      setTestingId(null)
    }
  }

  const submitCreate = async (d: FormState) => {
    const ok = await run(() => api.createProvider({
      name: d.name.trim(),
      kind: d.kind,
      base_url: d.base_url.trim(),
      model: d.model.trim(),
      enabled: d.enabled,
      // ollama 不需要密钥，别把空串送过去徒增一次校验
      ...(metaOf(d.kind).needsKey ? { api_key: d.api_key } : {}),
    }))
    if (ok) { setCreating(null); await load() }
  }

  const submitEdit = async (p: AgentProvider, d: FormState) => {
    const patch: AgentProviderInput = {
      name: d.name.trim(),
      kind: d.kind,
      base_url: d.base_url.trim(),
      model: d.model.trim(),
      enabled: d.enabled,
    }
    // 关键：api_key 字段**不传**才是「保持不变」。留空时绝不能带上这个键。
    if (d.api_key !== '') patch.api_key = d.api_key
    const ok = await run(() => api.updateProvider(p.id, patch))
    if (ok) { setEditingId(null); await load() }
  }

  return (
    <div className="st-sec">
      <SectionHead
        title="Agent 供应商"
        desc={
          <>
            配置 Agent 调用哪家模型服务：OpenAI 兼容端点（含 DeepSeek、Moonshot、本地 vLLM 等一切
            /v1/chat/completions 接口）、Google Gemini、或者跑在本机的 Ollama。
            底部对话框和后续的 Agent 功能都会用「默认」那一个。
          </>
        }
        actions={
          <>
            <Button small disabled={busy || loading} onClick={() => void load()}>刷新</Button>
            <Button
              variant="primary"
              small
              onClick={() => startCreate('openai', '')}
            >
              + 新建供应商
            </Button>
          </>
        }
      />

      {/* 明文落库这件事必须让用户自己知道，不能藏在文档里 */}
      <p className="st-note muted">
        API Key <strong>明文存在本机的 SQLite 库里</strong>（就是「数据与备份」页里那个文件）。
        这是一个单人本地工具，没有加了也没处放钥匙的密钥库，所以这里选择了诚实而不是假装加密。
        代价是：<strong>这个库一旦要共享给别人、同步上云、或者发出去做备份，必须先把密钥清理掉</strong>
        （用下面每个供应商的「清除密钥」，或者直接删掉该供应商）。界面本身只会显示脱敏串，后端从不返回明文。
      </p>

      {error ? <div className="error-banner">{error}</div> : null}

      {creating ? (
        <div className="st-card st-create">
          <div className="card-title">新建供应商</div>
          <ProviderForm
            mode="create"
            value={creating}
            busy={busy}
            onChange={setCreating}
            onCancel={() => { setCreating(null); setError(null) }}
            onSubmit={() => void submitCreate(creating)}
          />
        </div>
      ) : null}

      {loading ? <div className="skeleton v-sk v-sk-title" /> : null}

      {!loading && items.length === 0 && !creating ? (
        <EmptyState onPick={startCreate} />
      ) : null}

      {items.map((p) => (
        <div key={p.id} className="st-card">
          <div className="card-title">
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
              <span className="st-row-name truncate" style={{ color: 'var(--text)', fontSize: 'var(--fs-md)' }}>
                {p.name}
              </span>
              <span className="tag" style={{ flex: 'none' }}>{metaOf(p.kind).label}</span>
              {p.is_default ? <span className="tag" style={DEFAULT_TAG_STYLE}>默认</span> : null}
              {!p.enabled ? <span className="tag st-tag-off">已停用</span> : null}
            </span>
            <span className="faint" style={{ flex: 'none', fontWeight: 400 }}>
              更新于 <RelativeTime value={p.updated_at} />
            </span>
          </div>

          <div className="kv st-kv">
            <span className="faint">模型</span>
            <span className="mono">{p.model || <span className="faint">未指定</span>}</span>
            <span className="faint">base_url</span>
            <span className="mono st-break">{p.base_url}</span>
            <span className="faint">API Key</span>
            <span>
              {p.has_api_key
                ? <><span className="mono">{p.api_key_masked}</span> <span className="faint">已配置</span></>
                : metaOf(p.kind).needsKey
                  ? <span style={{ color: 'var(--warn)' }}>未配置（这一类必须有密钥才能调用）</span>
                  : <span className="faint">未配置（本机 Ollama 不需要）</span>}
            </span>
          </div>

          {results[p.id] ? <TestResult result={results[p.id]} /> : null}

          {/* 测试拿到模型列表之后，直接在这里换模型——这是配完连接最想干的一件事 */}
          {results[p.id]?.ok && (results[p.id].models?.length ?? 0) > 0 ? (
            <div className="st-inline-acts st-left">
              <span className="faint" style={{ fontSize: 'var(--fs-sm)' }}>切换模型</span>
              <Select
                value={p.model}
                disabled={busy}
                style={{ maxWidth: '280px' }}
                options={[
                  ...(p.model && !results[p.id].models?.includes(p.model)
                    ? [{ value: p.model, label: `${p.model}（当前）` }]
                    : []),
                  ...(results[p.id].models ?? []).map((m) => ({ value: m, label: m })),
                ]}
                onValueChange={(m) => void run(async () => { await api.updateProvider(p.id, { model: m }); await load() })}
              />
            </div>
          ) : null}

          <div className="st-inline-acts st-left">
            <Button small disabled={testingId === p.id || busy} onClick={() => void test(p)}>
              {testingId === p.id ? '测试中…' : '测试连接'}
            </Button>
            <Button
              small
              disabled={busy || p.is_default}
              title={p.is_default ? '已经是默认供应商' : '底部对话框和后续的 Agent 功能会用默认供应商'}
              onClick={() => void run(async () => { await api.setDefaultProvider(p.id); await load() })}
            >
              {p.is_default ? '当前默认' : '设为默认'}
            </Button>
            <Button
              small
              disabled={busy}
              onClick={() => { setCreating(null); setError(null); setEditingId(editingId === p.id ? null : p.id) }}
            >
              {editingId === p.id ? '收起' : '编辑'}
            </Button>
            <Button small variant="danger" disabled={busy} onClick={() => { setError(null); setDeleting(p) }}>
              删除
            </Button>
          </div>

          {editingId === p.id ? (
            <EditForm
              provider={p}
              busy={busy}
              models={results[p.id]?.ok ? results[p.id].models ?? [] : []}
              onCancel={() => { setEditingId(null); setError(null) }}
              onSubmit={(d) => void submitEdit(p, d)}
              onClearKey={() => void run(async () => { await api.updateProvider(p.id, { api_key: '' }); await load() })}
            />
          ) : null}
        </div>
      ))}

      <ConfirmDialog
        open={deleting !== null}
        title={`删除供应商「${deleting?.name ?? ''}」？`}
        confirmText="删除"
        danger
        busy={busy}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void (async () => {
          if (!deleting) return
          const ok = await run(() => api.deleteProvider(deleting.id))
          if (ok) { setDeleting(null); setEditingId(null); await load() }
        })()}
      >
        <p className="st-note">
          这条配置连同它保存的 API Key 会一起从库里删掉，不能撤销。
        </p>
        {deleting?.is_default ? (
          <p className="st-note" style={{ color: 'var(--warn)' }}>
            这是当前的默认供应商。删除后会自动把最早创建的那个启用供应商提为默认；一个都没有就先没有默认，
            需要你新建一个再设。
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}

/** 一条测试结果。成功给延迟与模型数，失败**原样显示后端的 message**，不要再包一层。 */
function TestResult({ result }: { result: ProviderTestResult }) {
  const n = result.models?.length ?? 0
  const label = result.ok ? '连接成功' : '连接失败'
  return (
    <div style={resultStyle(result.ok)} role="status">
      <strong style={{ flex: 'none' }}>{label}</strong>
      {/* 成功时后端的 message 就是「连接成功」，跟标签重了就不再说一遍 */}
      {result.message && result.message !== label ? <span>{result.message}</span> : null}
      {result.latency_ms > 0 ? <span className="mono">{result.latency_ms} ms</span> : null}
      {result.ok ? <span>{n > 0 ? `拿到 ${n} 个模型` : '未返回模型列表'}</span> : null}
    </div>
  )
}

/** 一个供应商都没有时的快速入口：点一下预填好对应类型的默认端点。 */
function EmptyState({ onPick }: { onPick: (kind: ProviderKind, name: string) => void }) {
  return (
    <div className="st-card">
      <div className="card-title">还没有配置任何供应商</div>
      <p className="st-note muted">
        选一种接入方式开始，端点会按类型预填好，改成自己的地址也行。
      </p>
      <div className="st-inline-acts st-left">
        <Button variant="primary" onClick={() => onPick('openai', 'OpenAI')}>快速添加 · OpenAI 兼容</Button>
        <Button onClick={() => onPick('gemini', 'Gemini')}>快速添加 · Gemini</Button>
        <Button onClick={() => onPick('ollama', '本机 Ollama')}>快速添加 · 本机 Ollama</Button>
      </div>
      <p className="st-note faint">
        本机 Ollama 不需要 API Key，确认 ollama 正在运行（默认 http://localhost:11434）即可；
        建好之后点「测试连接」就能把本机已拉取的模型列出来直接选。
      </p>
    </div>
  )
}

/** 编辑表单自己持有一份草稿，收起再展开会回到当前已保存的值。 */
function EditForm({ provider, busy, models, onCancel, onSubmit, onClearKey }: {
  provider: AgentProvider
  busy: boolean
  models: string[]
  onCancel: () => void
  onSubmit: (d: FormState) => void
  onClearKey: () => void
}) {
  const [draft, setDraft] = useState<FormState>(() => formOf(provider))
  return (
    <div className="st-inline-form">
      <ProviderForm
        mode="edit"
        value={draft}
        busy={busy}
        models={models}
        hasKey={provider.has_api_key}
        maskedKey={provider.api_key_masked}
        savedKind={provider.kind}
        onChange={setDraft}
        onCancel={onCancel}
        onSubmit={() => onSubmit(draft)}
        onClearKey={onClearKey}
      />
    </div>
  )
}

interface ProviderFormProps {
  mode: 'create' | 'edit'
  value: FormState
  busy: boolean
  /** 测试连接成功后拿到的模型列表；非空时模型字段升级成下拉 */
  models?: string[]
  hasKey?: boolean
  maskedKey?: string
  /** 已保存的 kind（不是草稿里的）：能不能清除密钥取决于库里现在是什么，不是表单上选了什么 */
  savedKind?: ProviderKind
  onChange: (d: FormState) => void
  onCancel: () => void
  onSubmit: () => void
  onClearKey?: () => void
}

function ProviderForm({
  mode, value, busy, models = [], hasKey, maskedKey, savedKind, onChange, onCancel, onSubmit, onClearKey,
}: ProviderFormProps) {
  // 有模型列表时默认用下拉，但留一个「手动输入」的兜底：列表未必全（网关常只回一部分）。
  const [manualModel, setManualModel] = useState(false)
  const meta = metaOf(value.kind)
  const useSelect = models.length > 0 && !manualModel

  const set = (patch: Partial<FormState>) => onChange({ ...value, ...patch })

  // 切 kind 时把 base_url 换成新类型的默认端点：留着上一个类型的地址，
  // 下次「测试连接」只会得到一条看不懂的报错。后端在只改 kind 时也是这么处理的。
  const setKind = (kind: ProviderKind) => set({ kind, base_url: metaOf(kind).baseURL })

  // 新建时必须当场给密钥（后端对 openai / gemini 是硬校验）；编辑时留空就是不改。
  const keyRequired = mode === 'create' && meta.needsKey
  // 后端校验的是库里那条记录的 kind，所以清除密钥的可用性只能跟着 savedKind 走
  const savedKeyRequired = savedKind !== undefined && metaOf(savedKind).needsKey
  const canSubmit = value.name.trim() !== '' && value.base_url.trim() !== '' && (!keyRequired || value.api_key !== '')

  return (
    <>
      <Field label="名称" hint="自己认得就行，会显示在列表和后续的模型选择里">
        <TextInput
          value={value.name}
          placeholder="如 DeepSeek 线上 / 本机 Ollama"
          disabled={busy}
          onValueChange={(v) => set({ name: v })}
        />
      </Field>

      <Field label="接入方式" hint={meta.hint}>
        <Select
          value={value.kind}
          options={KIND_OPTIONS}
          disabled={busy}
          onValueChange={(v) => setKind(v as ProviderKind)}
        />
      </Field>

      <Field label="base_url" hint="切换接入方式会重填成该类型的默认端点；自建端点 / 代理在这里改">
        <TextInput
          className="mono"
          value={value.base_url}
          placeholder={meta.baseURL}
          disabled={busy}
          onValueChange={(v) => set({ base_url: v })}
        />
      </Field>

      {meta.needsKey ? (
        <Field
          label="API Key"
          hint={
            mode === 'create'
              ? '只写字段：保存后界面只会显示脱敏串，后端不再返回明文。'
              : hasKey
                ? <>当前已配置 <span className="mono">{maskedKey}</span>。<strong>留空则保持现有密钥不变</strong>，填了才覆盖。</>
                : <>这一类必须有密钥才能调用，填一个保存即可。</>
          }
        >
          <TextInput
            type="password"
            autoComplete="off"
            value={value.api_key}
            placeholder={mode === 'edit' && hasKey ? '留空则保持现有密钥不变' : 'sk-…'}
            disabled={busy}
            onValueChange={(v) => set({ api_key: v })}
          />
        </Field>
      ) : (
        <Field label="API Key" hint="本机 Ollama 没有鉴权，不需要密钥。">
          <div className="st-frozen">不适用</div>
        </Field>
      )}

      <Field
        label="模型"
        hint={
          models.length > 0
            ? '这些是刚才「测试连接」从该供应商拿回来的可用模型。'
            : '先随便填一个，保存后点「测试连接」就能把该供应商的可用模型列出来直接选。'
        }
      >
        {useSelect ? (
          <Select
            value={value.model}
            disabled={busy}
            options={[
              ...(value.model && !models.includes(value.model)
                ? [{ value: value.model, label: `${value.model}（当前）` }]
                : []),
              ...models.map((m) => ({ value: m, label: m })),
              { value: '__manual__', label: '手动输入…' },
            ]}
            onValueChange={(v) => {
              if (v === '__manual__') { setManualModel(true); return }
              set({ model: v })
            }}
          />
        ) : (
          <TextInput
            className="mono"
            value={value.model}
            placeholder={value.kind === 'ollama' ? 'qwen3.5:4b' : value.kind === 'gemini' ? 'gemini-2.0-flash' : 'gpt-4o-mini'}
            disabled={busy}
            onValueChange={(v) => set({ model: v })}
          />
        )}
      </Field>

      {models.length > 0 && manualModel ? (
        <Button small disabled={busy} onClick={() => setManualModel(false)}>改回从列表选</Button>
      ) : null}

      <label className="v-check">
        <input
          type="checkbox"
          checked={value.enabled}
          disabled={busy}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        启用
      </label>

      <div className="st-inline-acts">
        {mode === 'edit' && hasKey && onClearKey ? (
          // 能不能清除看的是**已保存**的 kind：请求里只带 api_key，后端拿它跟库里的 kind 比。
          // 草稿上刚把 openai 改成 ollama 还没保存的话，这时清除仍然会被后端拒。
          <Button
            small
            variant="danger"
            disabled={busy || savedKeyRequired}
            title={
              savedKeyRequired
                ? 'OpenAI 兼容 / Gemini 必须有密钥，后端会拒绝清空。想让库里不再留这条明文：要么先把接入方式改成本机 Ollama 并保存，要么直接删掉这个供应商。'
                : '把库里保存的明文密钥清掉；库要共享或上云之前该做这一步'
            }
            onClick={onClearKey}
            style={{ marginRight: 'auto' }}
          >
            清除密钥
          </Button>
        ) : null}
        <Button small disabled={busy} onClick={onCancel}>取消</Button>
        <Button small variant="primary" disabled={busy || !canSubmit} onClick={onSubmit}>
          {busy ? '保存中…' : mode === 'create' ? '创建' : '保存'}
        </Button>
      </div>
    </>
  )
}
