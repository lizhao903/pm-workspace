// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 模型服务商抽屉，照原型 web-next/src/models.tsx ProviderDrawer（SPEC-settings-7）。新建和编辑共用。
// 和原型不同的地方（后端决定的）：
// - 测试连接只能对已保存的服务商做：新建点「接入」先保存再自动测一次，抽屉留着看结果；编辑时有没保存的改动就「保存并测试」。
// - 后端没有「启用哪些模型」，只有一个默认模型（model）：模型区列出测试拉回的模型，点一个设为默认。
// - API Key 只显示后端给的掩码；输入框空着保存不改，清空要单独确认。
import { useState } from 'react'
import {
  errorText, useCreateProvider, useDeleteProvider, usePatchProvider, useSetDefaultProvider,
  type AgentProvider, type ProviderCheck,
} from '../../../core/data'
import { Button, cls, ConfirmDialog, Drawer, Field, Input, Select, Tag } from '../../../core/ui'
import { CAP_LABEL, keyOptional, type FieldKey, type ProviderKindDef } from './catalog'
import { createBody, fallbackOptions, initialForm, missingFields, modelList, patchBody, statusOf, type ProviderForm } from './model'
import { ProviderLogo } from './ProviderLogo'

const SOURCE_HINT = {
  tested: '服务商实际返回的模型',
  manual: '上面「模型 ID」里填的',
  catalog: '内置目录，测通后换成服务商实际返回的列表',
}

export function ProviderDrawer({ def, provider, providers = [], check, testing, testError, onTest, onCreated, onClose }: {
  def: ProviderKindDef
  /** 没有就是新建 */
  provider?: AgentProvider
  /** 已接入的全部服务商，「失败时改用」从里面挑 */
  providers?: AgentProvider[]
  check?: ProviderCheck
  testing: boolean
  /** 测试请求本身失败（不是 ok=false） */
  testError?: unknown
  onTest: (id: string) => void
  /** 新建成功：抽屉换成编辑这一条 */
  onCreated: (p: AgentProvider) => void
  onClose: () => void
}) {
  const creating = !provider
  const [form, setForm] = useState<ProviderForm>(() => initialForm(def, provider))
  const [baseline, setBaseline] = useState(form)
  const [show, setShow] = useState(false)
  const [tried, setTried] = useState(false)
  const [confirm, setConfirm] = useState<'delete' | 'clear-key' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const create = useCreateProvider()
  const patch = usePatchProvider()
  const remove = useDeleteProvider()
  const setDefault = useSetDefaultProvider()
  const busy = create.isPending || patch.isPending || remove.isPending || setDefault.isPending

  const missing = missingFields(def, form, provider)
  const nameBad = tried && !form.name.trim()
  const pending = provider ? patchBody(def, form, provider) : null
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline)
  const hasChanges = creating ? true : Object.keys(pending ?? {}).length > 0
  const st = provider ? statusOf(provider, check) : 'untested'
  const models = modelList(def, form, check)
  const keyField = def.fields.find((f) => f.key === 'api_key')

  const setValue = (k: FieldKey, v: string) => setForm({ ...form, values: { ...form.values, [k]: v } })
  const valid = () => {
    setTried(true)
    return !missing.length && !!form.name.trim()
  }
  // 保存后表单按后端返回的重排一次（地址会被规范化），密钥输入框清空
  const reset = (p: AgentProvider) => {
    const f = initialForm(def, p)
    setForm(f)
    setBaseline(f)
  }

  function save(thenTest: boolean) {
    setError(null)
    if (!valid()) return
    if (creating) {
      create.mutate(createBody(def, form), {
        onSuccess: (p) => { reset(p); onCreated(p); onTest(p.id) },
        onError: (e) => setError(`接入失败：${errorText(e)}`),
      })
      return
    }
    if (!hasChanges) {
      if (thenTest) onTest(provider.id)
      else onClose()
      return
    }
    patch.mutate({ id: provider.id, patch: pending! }, {
      onSuccess: (p) => {
        if (thenTest) { reset(p); onTest(p.id) } else onClose()
      },
      onError: (e) => setError(`保存失败：${errorText(e)}`),
    })
  }

  function clearKey() {
    if (!provider) return
    patch.mutate({ id: provider.id, patch: { api_key: '' } }, {
      onSuccess: () => { setConfirm(null); setValue('api_key', '') },
      onError: (e) => { setConfirm(null); setError(`清空 API Key 失败：${errorText(e)}`) },
    })
  }

  function del() {
    if (!provider) return
    remove.mutate(provider.id, {
      onSuccess: () => { setConfirm(null); onClose() },
      onError: (e) => { setConfirm(null); setError(`删除失败：${errorText(e)}`) },
    })
  }

  function makeDefault() {
    if (!provider) return
    setDefault.mutate(provider.id, { onError: (e) => setError(`设为默认失败：${errorText(e)}`) })
  }

  const testLine = () => {
    if (creating) return <span className="pv-muted">接入后自动测一次</span>
    if (testing) return null
    if (testError) return <span className="danger-text">测试没发出去：{errorText(testError)}</span>
    if (hasChanges) return <span className="pv-muted">改了配置，保存后才按新配置测</span>
    if (!check) return <span className="pv-muted">还没测过；改了凭证要重新测一次</span>
    if (check.result.ok) {
      const n = check.result.models?.length ?? 0
      return <span className="pv-ok">连接成功，{n ? `列出 ${n} 个模型` : '没有列出模型'} · {check.result.latency_ms} ms</span>
    }
    return <span className="danger-text">{check.result.message}</span>
  }

  return (
    <Drawer open onClose={onClose} dirty={dirty} className="pv-drawer"
      kicker={creating ? `接入 ${def.label}` : '配置模型服务商'}
      footer={(requestClose) => (
        <>
          {!creating && <Button variant="danger-ghost" disabled={busy} onClick={() => setConfirm('delete')}>删除服务商</Button>}
          <div className="spacer" />
          <Button onClick={requestClose}>取消</Button>
          <Button variant="primary" disabled={busy} onClick={() => save(false)}>{creating ? '接入' : '保存'}</Button>
        </>
      )}>
      <div className="pv-form">
        {provider && st === 'error' && check && (
          <div className="pv-alert" role="alert">
            <b>连接异常</b>{check.result.message}。用它的会话和 Agent 暂时用不了，改好凭证后测试连接并保存。
          </div>
        )}
        {error && <div className="pv-alert" role="alert">{error}</div>}

        <div className="pv-profile">
          <ProviderLogo kind={def.kind} size={48} />
          <div className="pv-profile-text">
            <h2 className="ellipsis">{form.name.trim() || def.label}</h2>
            <div className="pv-muted">{def.label}{def.desc && ` · ${def.desc}`}</div>
          </div>
          {provider && (provider.is_default
            ? <Tag>默认服务商</Tag>
            : <Button size="sm" variant="outline" disabled={busy} onClick={makeDefault}>设为默认</Button>)}
        </div>

        <Field label="名称" required error={nameBad ? '必填' : undefined}
          hint={`同一家接多个账号时用来区分，比如「${def.label} 公司账号」`}>
          <Input value={form.name} invalid={nameBad} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>

        {def.fields.map((f) => {
          const bad = tried && missing.includes(f.key)
          if (f.key === 'api_key') {
            const has = !!provider?.has_api_key
            const clearable = keyOptional(def)
            return (
              <Field key={f.key} label={<>{f.label}{f.hint && <span className="pv-field-hint">{f.hint}</span>}</>}
                required={f.required && !keyOptional(def) && !has} error={bad ? '必填' : undefined}>
                <span className="pv-secret">
                  <Input type={show ? 'text' : 'password'} className="pv-mono" autoComplete="off" invalid={bad}
                    value={form.values.api_key} placeholder={has ? '不改就留空' : f.placeholder}
                    onChange={(e) => setValue('api_key', e.target.value)} />
                  <Button size="sm" onClick={() => setShow(!show)}>{show ? '隐藏' : '显示'}</Button>
                </span>
                {has && (
                  <span className="pv-key-line">
                    <span>当前：<code className="pv-mono">{provider.api_key_masked || '已配置'}</code></span>
                    <Button size="sm" variant="danger-ghost" disabled={busy || !clearable}
                      title={clearable ? undefined : '这一类服务商必须有 API Key，只能换不能清空'}
                      onClick={() => setConfirm('clear-key')}>清空</Button>
                  </span>
                )}
              </Field>
            )
          }
          return (
            <Field key={f.key} label={<>{f.label}{f.hint && <span className="pv-field-hint">{f.hint}</span>}</>}
              required={f.required} error={bad ? '必填' : undefined}>
              <Input value={form.values[f.key]} placeholder={f.placeholder} invalid={bad} className={f.key === 'base_url' ? 'pv-mono' : undefined}
                onChange={(e) => setValue(f.key, e.target.value)} />
            </Field>
          )
        })}
        {keyField === undefined && provider?.has_api_key && (
          <div className="pv-key-line">
            <span>当前 API Key：<code className="pv-mono">{provider.api_key_masked || '已配置'}</code></span>
            <Button size="sm" variant="danger-ghost" disabled={busy} onClick={() => setConfirm('clear-key')}>清空</Button>
          </div>
        )}

        <div className="pv-test-line">
          <Button variant="outline" disabled={busy || testing} onClick={() => save(true)}>
            {testing ? '测试中…' : creating ? '接入并测试' : hasChanges ? '保存并测试' : '测试连接'}
          </Button>
          {testLine()}
        </div>

        <div className="field">
          <span className="field-label">默认模型<span className="pv-field-hint">会话和 Agent 没指定模型时用它；点一个设为默认</span></span>
          {models.rows.length ? (
            <>
              <div className="pv-muted">{SOURCE_HINT[models.source]} · {models.rows.length} 个</div>
              {models.source === 'tested' && form.model && !check?.result.models?.includes(form.model) && (
                <div className="danger-text pv-note">默认模型「{form.model}」不在服务商返回的列表里，换一个再保存</div>
              )}
              <div className="pv-models" role="radiogroup" aria-label="默认模型">
                {models.rows.map((m) => {
                  const on = form.model === m.id
                  return (
                    <label key={m.id} className={cls('pv-model', on && 'on')}>
                      <input type="radio" name="pv-model" checked={on} onChange={() => setForm({ ...form, model: m.id })} />
                      <span className="pv-model-name ellipsis" title={m.name}>{m.name}</span>
                      {m.known && <code className="pv-model-id ellipsis">{m.id}</code>}
                      {!!m.caps.length && <span className="pv-caps">{m.caps.map((c) => <span key={c} className="pv-cap">{CAP_LABEL[c]}</span>)}</span>}
                      {m.context !== undefined && (
                        <span className="pv-model-meta">{m.context}K 上下文{m.price ? ` · $${m.price[0]} / $${m.price[1]}` : ''}</span>
                      )}
                    </label>
                  )
                })}
              </div>
            </>
          ) : <span className="pv-muted">在上面「模型 ID」里填了之后这里会列出来</span>}
        </div>

        <Field label={<>失败时改用<span className="pv-field-hint">它连不上、返回 5xx 被暂停调用（熔断）时，改用这个服务商和它的默认模型</span></>}>
          <Select aria-label="失败时改用" value={form.fallback} options={fallbackOptions(providers, provider?.id, form.fallback)}
            onValueChange={(v) => setForm({ ...form, fallback: v })} />
        </Field>

        <label className="pv-switch-row">
          <span><span className="field-label">启用</span><span className="pv-muted">停用后它下面的模型都不能用，配置保留</span></span>
          <span className="pv-switch-line">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            <span className="pv-switch" />
          </span>
        </label>
      </div>

      <ConfirmDialog open={confirm === 'clear-key'} danger title="清空 API Key？" confirmLabel="清空" busy={patch.isPending}
        onCancel={() => setConfirm(null)} onConfirm={clearKey}>
        保险箱里这条密钥会被删掉，之后调用不再带 Key。不想改密钥的话，输入框空着保存就行。
      </ConfirmDialog>
      <ConfirmDialog open={confirm === 'delete'} danger title={`删除「${provider?.name ?? ''}」？`} confirmLabel="删除" busy={remove.isPending}
        onCancel={() => setConfirm(null)} onConfirm={del}
        impacts={[
          '保险箱里它的 API Key 一起删掉',
          ...(provider?.is_default ? ['它是默认服务商，删除后最早接入的启用服务商成为默认'] : []),
        ]}>
        删除后用它的会话需要换一个服务商才能继续对话。
      </ConfirmDialog>
    </Drawer>
  )
}
