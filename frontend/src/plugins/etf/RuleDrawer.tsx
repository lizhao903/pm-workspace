// 规则抽屉（SPEC-etf-3）：新建和编辑共用。内置规则可以改阈值、范围、严重度和启停，本期没有删除。
import { useState } from 'react'
import { errorText, useCreateEtfRule, usePatchEtfRule, type EtfFund, type EtfOperator, type EtfRule, type EtfScope, type EtfSeverity } from '../../core/data'
import { Button, Drawer, Field, Input, Select, Switch } from '../../core/ui'
import { METRICS, OPERATORS, SCOPES, SEVERITY, blankRule, draftErrors, draftOf, type RuleDraft } from './model'

const METRIC_OPTIONS = Object.entries(METRICS).map(([value, m]) => ({ value, label: m.unit ? `${m.label}（${m.unit}）` : m.label }))
const OP_OPTIONS = Object.entries(OPERATORS).map(([value, label]) => ({ value, label }))
const SCOPE_OPTIONS = Object.entries(SCOPES).map(([value, label]) => ({ value, label }))
const SEV_OPTIONS = (['info', 'warn', 'critical'] as const).map((k) => ({ value: k, label: SEVERITY[k].label }))

export function RuleDrawer({ rule, funds, onClose }: { rule: EtfRule | null; funds: EtfFund[]; onClose: () => void }) {
  const [init] = useState<RuleDraft>(() => (rule ? draftOf(rule) : blankRule()))
  const [d, setD] = useState<RuleDraft>(init)
  const [tried, setTried] = useState(false)
  const [err, setErr] = useState('')
  const create = useCreateEtfRule()
  const patch = usePatchEtfRule()
  const busy = create.isPending || patch.isPending
  const dirty = JSON.stringify(d) !== JSON.stringify(init)
  const errors = draftErrors(d)
  const set = <K extends keyof RuleDraft>(k: K, v: RuleDraft[K]) => setD((x) => ({ ...x, [k]: v }))

  const scopeOptions = d.scope === 'symbol'
    ? funds.map((f) => ({ value: f.symbol, label: `${f.symbol} ${f.name}` }))
    : [...new Map(funds.map((f) => [f.underlying, { value: f.underlying, label: `${f.track_index}（${f.underlying}）` }])).values()]

  const save = () => {
    setTried(true)
    setErr('')
    if (errors.length) return
    const body = {
      name: d.name.trim(), metric: d.metric, operator: d.operator, threshold: Number(d.threshold), scope: d.scope,
      scope_value: d.scope === 'all' ? '' : d.scope_value, severity: d.severity, enabled: d.enabled,
    }
    const done = { onSuccess: onClose, onError: (e: unknown) => setErr(errorText(e)) }
    if (rule) patch.mutate({ id: rule.id, patch: body }, done)
    else create.mutate(body, done)
  }

  return (
    <Drawer open onClose={onClose} dirty={dirty} kicker={rule ? '编辑规则' : '新建规则'}
      aria-label={rule ? rule.name : '新建规则'}
      footer={(requestClose) => (
        <>
          <span className="spacer" />
          {(tried && errors[0]) || err ? <span className="field-err" role="alert">{err || errors[0]}</span> : null}
          <Button onClick={requestClose}>取消</Button>
          <Button variant="primary" disabled={busy || errors.length > 0} onClick={save}>{rule ? '保存' : '新建'}</Button>
        </>
      )}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); save() }}>
      <Field label="名称" required hint={rule?.builtin ? '内置规则' : undefined} error={tried && !d.name.trim() ? '名称必填' : undefined}>
        <Input value={d.name} autoFocus maxLength={50} onChange={(e) => set('name', e.target.value)} />
      </Field>
      <Field label="指标">
        <Select aria-label="指标" options={METRIC_OPTIONS} value={d.metric} onValueChange={(v) => set('metric', v)} />
      </Field>
      <div className="field-row">
        <Field label="比较">
          <Select aria-label="比较" options={OP_OPTIONS} value={d.operator} onValueChange={(v) => set('operator', v as EtfOperator)} />
        </Field>
        <Field label="阈值" required error={errors.includes('阈值要是数字') ? '阈值要是数字' : undefined}
          hint={d.metric === 'inflow_streak' ? '连续流入记正数、流出记负数，例如流出 3 天用「≤ -3」' : undefined}>
          <Input aria-label="阈值" inputMode="decimal" invalid={errors.includes('阈值要是数字')} value={d.threshold} onChange={(e) => set('threshold', e.target.value)} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="范围">
          <Select aria-label="范围" options={SCOPE_OPTIONS} value={d.scope}
            onValueChange={(v) => setD((x) => ({ ...x, scope: v as EtfScope, scope_value: '' }))} />
        </Field>
        {d.scope !== 'all' && (
          <Field label={d.scope === 'symbol' ? 'ETF' : '跟踪指数'} required>
            <Select aria-label={d.scope === 'symbol' ? 'ETF' : '跟踪指数'} options={[{ value: '', label: '请选择' }, ...scopeOptions]}
              value={d.scope_value} onValueChange={(v) => set('scope_value', v)} />
          </Field>
        )}
      </div>
      <Field label="严重度">
        <Select aria-label="严重度" options={SEV_OPTIONS} value={d.severity} onValueChange={(v) => set('severity', v as EtfSeverity)} />
      </Field>
      <Switch checked={d.enabled} onCheckedChange={(on) => set('enabled', on)}>启用</Switch>
      <p className="etf-faint etf-hint">
        样本不足的指标不判定：量比、跟踪误差要 20 个交易日，历史分位要 60 个交易日。份额类指标遇到分红、拆分这类跳变时命中会标「待核」。
      </p>
      </form>
    </Drawer>
  )
}
