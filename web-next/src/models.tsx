// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { useState } from 'react'
import {
  CAP_LABEL, PROVIDER_GROUPS, PROVIDER_KINDS, catalogModel, kindOf, testProvider,
  type ModelConf, type Provider, type ProviderKind,
} from './modeldata'
import { PageTitle } from './topbar'
import { cls, timeAgo } from './ui'
import { newId } from './ids'

// 设置 > 模型服务商。服务商的配置和要启用哪些模型都在抽屉里改，跟连接器一个路数

export function ProviderLogo({ kind, size = 36 }: { kind: ProviderKind; size?: number }) {
  const k = kindOf(kind)
  return <span className="pv-logo" style={{ width: size, height: size, background: k.color, fontSize: size * 0.36 }}>{k.short}</span>
}

const STATUS = {
  ok: { label: '连接正常', color: '#2f7d43' },
  error: { label: '连接异常', color: '#c0352b' },
  untested: { label: '未测试', color: '#a19d92' },
  off: { label: '已停用', color: '#a19d92' },
}
const Pill = ({ label, color }: { label: string; color: string }) => <span className="pill" style={{ '--c': color } as React.CSSProperties}><span className="pill-dot" />{label}</span>
const mask = (v: string) => (v.length <= 8 ? '•'.repeat(v.length) : `${v.slice(0, 6)}${'•'.repeat(8)}${v.slice(-4)}`)

/* ---------- 服务商 ---------- */

export function ProvidersPage({ providers, models, selected, onOpen, onAdd }: {
  providers: Provider[]; models: ModelConf[]; selected: string | null
  onOpen: (id: string) => void; onAdd: (kind: ProviderKind) => void
}) {
  return (
    <div className="page page-fill">
      <PageTitle parent="设置" count={`${providers.length} 个已接入`} desc="配好 API Key 和地址、测通之后，勾选要启用的模型，Agent 和 SOP 就能选用">模型服务商</PageTitle>
      <div className="section-label">已接入</div>
      {!providers.length && <div className="mount-empty">还没接模型服务商，从下面挑一家接入</div>}
      <div className="pv-grid">
        {providers.map((p) => {
          const st = !p.enabled ? STATUS.off : STATUS[p.status]
          const ms = models.filter((m) => m.provider_id === p.id)
          return (
            <button key={p.id} className={cls('pv-card', selected === p.id && 'sel')} onClick={() => onOpen(p.id)}>
              <ProviderLogo kind={p.kind} />
              <span className="pv-text">
                <span className="pv-name" title={p.name}>{p.name}</span>
                <span className={cls('pv-hint', p.enabled && p.status === 'error' && 'danger-text')}>{p.enabled && p.status === 'error' ? '连接异常，点开看原因' : `${kindOf(p.kind).label} · ${ms.filter((m) => m.enabled).length}/${ms.length} 个模型启用`}</span>
              </span>
              <span className="provider-st"><Pill {...st} />{p.checked_at && <span className="pv-hint">{timeAgo(p.checked_at)}检查</span>}</span>
            </button>
          )
        })}
      </div>
      {PROVIDER_GROUPS.map((g) => (
        <section key={g}>
          <div className="section-label">添加服务商 · {g}</div>
          <div className="pv-grid">
            {PROVIDER_KINDS.filter((k) => k.group === g).map((k) => {
              const linked = providers.some((p) => p.kind === k.kind)
              return (
                <button key={k.kind} className="pv-card pv-card-add" onClick={() => onAdd(k.kind)}>
                  <ProviderLogo kind={k.kind} />
                  <span className="pv-text"><span className="pv-name" title={k.label}>{k.label}</span><span className="pv-hint">{k.desc || (k.catalog.length ? `${k.catalog.length} 个模型` : '模型 ID 自己填')}</span></span>
                  <span className="pv-add">{linked ? '再接一个' : '接入'}</span>
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

export function ProviderDrawer({ provider, kind, models, providers = [], onClose, onSave, onDelete, onFail, delPlan }: {
  provider: Provider | null
  kind: ProviderKind
  models: ModelConf[]
  /** 已接入的全部服务商，「失败时改用」从里面挑 */
  providers?: Provider[]
  onClose: () => void
  /** 保存服务商，同时把勾选的目录模型同步成启用 / 不启用 */
  onSave: (p: Provider, models: ModelConf[]) => void
  onDelete: () => void
  /** 测试或保存时对方返回了错误（不含没填必填项）：App 记一条运行异常 */
  onFail?: (id: string, name: string, error: string) => void
  /** 删除前算出的影响；block 有值时不能删 */
  delPlan?: { block?: string; impact: string[] }
}) {
  const def = kindOf(kind)
  const creating = !provider
  const id = provider?.id ?? newId('pv')
  const [name, setName] = useState(provider?.name ?? def.label)
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...Object.fromEntries(def.fields.map((f) => [f.key, ''])), ...provider?.values }))
  const [enabled, setEnabled] = useState(provider?.enabled ?? true)
  const [fallback, setFallback] = useState(provider?.fallback_id ?? '')
  const [show, setShow] = useState<Record<string, boolean>>({})
  const [test, setTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'error'; error?: string }>(() => (provider ? { state: provider.status === 'ok' ? 'ok' : provider.status === 'error' ? 'error' : 'idle', error: provider.error } : { state: 'idle' }))
  const [tried, setTried] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  // 目录里的模型 + 自定义服务商手填的模型 ID
  // 没有内置模型目录的（自定义、vLLM）用手填的模型 ID
  const catalog = !def.catalog.length
    ? (values.model_ids ?? '').split(/[,，\s]+/).filter(Boolean).map((m) => ({ id: m, name: m, context: 128, caps: [] as never[] }))
    : def.catalog
  const mine = models.filter((m) => m.provider_id === id)
  const [picked, setPicked] = useState<string[]>(() => (provider ? mine.filter((m) => m.enabled).map((m) => m.id) : def.catalog.slice(0, 2).map((m) => m.id)))
  const missing = def.fields.filter((f) => f.required && !values[f.key]?.trim())

  const runTest = () => {
    setTest({ state: 'running' })
    window.setTimeout(() => {
      const r = testProvider(kind, values)
      setTest(r.ok ? { state: 'ok' } : { state: 'error', error: r.error })
      // 还没保存的新服务商不记，保存时出错才记
      if (!r.ok && provider && !missing.length && r.error) onFail?.(id, name.trim() || def.label, r.error)
    }, 700)
  }
  const save = () => {
    setTried(true)
    if (missing.length || !name.trim()) return
    const r = testProvider(kind, values)
    const p: Provider = { id, kind, name: name.trim(), values, enabled, fallback_id: fallback || undefined, status: test.state === 'ok' ? 'ok' : test.state === 'error' ? 'error' : r.ok ? 'untested' : 'error', error: r.ok ? undefined : r.error, checked_at: test.state === 'ok' || test.state === 'error' ? new Date().toISOString() : provider?.checked_at }
    const next = catalog.map((c) => {
      const old = mine.find((m) => m.id === c.id)
      return old ? { ...old, enabled: picked.includes(c.id) } : { ...catalogModel(id, c), enabled: picked.includes(c.id) }
    })
    onSave(p, next)
    if (p.status === 'error' && p.error && test.state !== 'error') onFail?.(id, p.name, p.error)
  }

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <span className="drawer-kicker">{creating ? `接入 ${def.label}` : '配置模型服务商'}</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="关闭 (Esc)">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="drawer-body form">
        {provider?.enabled && provider.status === 'error' && (
          <div className="detail-alert">
            <span><b>连接异常</b>{provider.error}。它下面的 {mine.filter((m) => m.enabled).length} 个模型暂时用不了，用到它们的场景和 Agent 会退回默认模型。改好凭证后测试连接并保存。</span>
          </div>
        )}
        <div className="profile">
          <ProviderLogo kind={kind} size={48} />
          <div className="profile-text">
            <h2>{name || def.label}</h2>
            <div className="list-sub">{def.label}{def.desc && ` · ${def.desc}`}</div>
          </div>
        </div>
        <label className="field">
          <span className="field-label">名称<em>*</em><span className="field-hint">同一家接多个账号时用来区分，比如「Anthropic 公司账号」</span></span>
          <input value={name} className={cls(tried && !name.trim() && 'bad')} onChange={(e) => setName(e.target.value)} />
          {tried && !name.trim() && <span className="field-err">必填</span>}
        </label>
        {def.fields.map((f) => (
          <label key={f.key} className="field">
            <span className="field-label">{f.label}{f.required && <em>*</em>}{f.hint && <span className="field-hint">{f.hint}</span>}</span>
            <span className="secret-line">
              <input className={cls(f.type === 'secret' && !show[f.key] && 'mono', tried && missing.includes(f) && 'bad')}
                type={f.type === 'secret' && !show[f.key] ? 'password' : 'text'} value={values[f.key] ?? ''} placeholder={f.placeholder}
                onChange={(e) => { setValues({ ...values, [f.key]: e.target.value }); setTest({ state: 'idle' }) }} />
              {f.type === 'secret' && <button type="button" className="act act-quiet" onClick={() => setShow({ ...show, [f.key]: !show[f.key] })}>{show[f.key] ? '隐藏' : '显示'}</button>}
            </span>
            {tried && missing.includes(f) && <span className="field-err">必填</span>}
            {f.type === 'secret' && provider?.values[f.key] && !show[f.key] && <span className="field-hint-line">当前：{mask(provider.values[f.key])}</span>}
          </label>
        ))}
        <div className="test-line">
          <button className="act" onClick={runTest} disabled={test.state === 'running'}>{test.state === 'running' ? '测试中…' : '测试连接'}</button>
          {test.state === 'ok' && <span className="ok-text">连接成功，能列出模型</span>}
          {test.state === 'error' && <span className="danger-text">{test.error}</span>}
          {test.state === 'idle' && <span className="list-sub">改了凭证要重新测一次</span>}
        </div>

        <div className="field">
          <span className="field-label">启用的模型<span className="field-hint">勾选的模型 Agent 和 SOP 可以选用</span></span>
          {catalog.length ? (
            <>
              <div className="model-picks-bar">
                <span className="list-sub">已选 {picked.length} / {catalog.length}</span>
                <button type="button" className="act act-quiet" onClick={() => setPicked(picked.length === catalog.length ? [] : catalog.map((m) => m.id))}>{picked.length === catalog.length ? '全不选' : '全选'}</button>
              </div>
              <div className="model-picks">
                {catalog.map((m) => {
                  const on = picked.includes(m.id)
                  return (
                    <label key={m.id} className={cls('model-pick', on && 'on')}>
                      <input type="checkbox" checked={on} onChange={(e) => setPicked(e.target.checked ? [...picked, m.id] : picked.filter((x) => x !== m.id))} />
                      <span className="model-pick-check" aria-hidden>{on && <svg viewBox="0 0 16 16" width="10" height="10"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>}</span>
                      <span className="model-pick-name ellipsis">{m.name}</span>
                      <code className="model-pick-id ellipsis">{m.id}</code>
                      <span className="cap-tags">{m.caps.map((c) => <span key={c} className="ability-tag">{CAP_LABEL[c]}</span>)}</span>
                      <span className="model-pick-meta">{m.context}K 上下文{'price' in m && m.price ? ` · $${m.price[0]} / $${m.price[1]}` : ''}</span>
                    </label>
                  )
                })}
              </div>
            </>
          ) : <span className="list-sub">在上面「模型 ID」里填了之后这里会列出来</span>}
        </div>

        <label className="field">
          <span className="field-label">失败时改用<span className="field-hint">它连不上、返回 5xx 被暂停调用（熔断）时，改用这个服务商和它的默认模型</span></span>
          <select aria-label="失败时改用" value={fallback} onChange={(e) => setFallback(e.target.value)}>
            <option value="">不改用，直接报错</option>
            {providers.filter((x) => x.id !== id).map((x) => (
              <option key={x.id} value={x.id} disabled={!x.enabled && x.id !== fallback}>{x.enabled ? x.name : `${x.name}（已停用）`}</option>
            ))}
          </select>
        </label>

        <label className="switch-row">
          <span><span className="field-label">启用</span><span className="switch-hint">停用后它下面的模型都不能用，配置保留</span></span>
          <span className="switch-line"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /><span className="switch" /></span>
        </label>
      </div>
      <div className="drawer-foot">
        {confirmDel ? (
          <>
            <span className="danger-text">{delPlan?.block ? `不能删除：${delPlan.block}` : `删除后它下面的 ${mine.length} 个模型一起移除${delPlan?.impact.length ? `；${delPlan.impact.join('；')}` : ''}`}</span>
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>{delPlan?.block ? '知道了' : '取消'}</button>
            {!delPlan?.block && <button className="btn btn-danger" onClick={onDelete}>删除</button>}
          </>
        ) : (
          <>
            {!creating && <button className="btn btn-ghost btn-danger-ghost" onClick={() => setConfirmDel(true)}>删除服务商</button>}
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={onClose}>取消</button>
            <button className="btn btn-primary" onClick={save}>{creating ? '接入' : '保存'}</button>
          </>
        )}
      </div>
    </aside>
  )
}
