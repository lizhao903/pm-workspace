// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 发起执行抽屉（SPEC-sop-6）：按流程 fields 填输入、逐步确认开关；必填空着标红不关抽屉，发起失败抽屉不关、显示错误。
// 成功后关抽屉、打开这次执行的运行页。在任务上发起（SOP-06）时带 object，执行关联到它，抽屉上写明是哪条任务
import { useState } from 'react'
import { errorText, useStartSopRun, type SopFlow, type SopJson } from '../../core/data'
import { Button, Checkbox, Drawer, Field, Input, Select, Textarea } from '../../core/ui'
import { initialValues, missingRequired } from './model'
import { KindTag } from './parts'

export function StartDrawer({ flow, initial, object, onClose, onStarted }: {
  flow: SopFlow
  /** 「用同样的输入再执行」时预填那次的输入；在任务上发起时是从任务字段预填的 */
  initial?: SopJson | null
  /** 这次执行关联到的工作对象（SOP-06） */
  object?: { id: string; ref: string; title: string }
  onClose: () => void
  onStarted: (runId: string) => void
}) {
  const [vals, setVals] = useState<Record<string, string>>(() => initialValues(flow, initial))
  const [stepThrough, setStepThrough] = useState(false)
  const [tried, setTried] = useState(false)
  const start = useStartSopRun()
  const missing = missingRequired(flow, vals)
  const set = (k: string, v: string) => setVals((m) => ({ ...m, [k]: v }))

  const submit = () => {
    setTried(true)
    if (missing.length || start.isPending) return
    start.mutate({ flowId: flow.id, body: { input: vals, step_through: stepThrough, ...(object ? { object_id: object.id } : {}) } }, { onSuccess: (r) => onStarted(r.id) })
  }

  return (
    <Drawer open onClose={onClose} kicker="执行 SOP" aria-label={`执行 ${flow.name}`} footer={(close) => (
      <>
        <div className="spacer" />
        <Button onClick={close}>取消</Button>
        <Button variant="primary" disabled={start.isPending} onClick={submit}>{start.isPending ? '正在发起' : '开始执行'}</Button>
      </>
    )}>
      <div className="form">
        <div>
          <h2 className="sop-start-title">{flow.name}</h2>
          {flow.desc && <div className="sop-muted">{flow.desc}</div>}
          {object && <div className="sop-start-object">关联任务 {object.ref} {object.title}，输入已按任务字段预填，可以改</div>}
        </div>
        {flow.fields.map((f) => {
          const bad = tried && missing.includes(f)
          return (
            <Field key={f.key} label={f.label} required={f.required} error={bad ? '必填' : undefined}>
              {f.type === 'textarea' ? (
                <Textarea rows={5} value={vals[f.key]} placeholder={f.placeholder} invalid={bad} onChange={(e) => set(f.key, e.target.value)} />
              ) : f.type === 'select' ? (
                <Select value={vals[f.key]} options={(f.options ?? []).map((o) => ({ value: o.value, label: o.label }))} onValueChange={(v) => set(f.key, v)} />
              ) : (
                <Input value={vals[f.key]} placeholder={f.placeholder} invalid={bad} onChange={(e) => set(f.key, e.target.value)} />
              )}
            </Field>
          )
        })}
        <div className="sop-field-group">
          <Checkbox className="sop-check-lg" checked={stepThrough} onCheckedChange={setStepThrough}>逐步确认</Checkbox>
          <div className="sop-muted">每一步执行前都停下来，让你检查、修改这一步的输入。不勾的话只在人工检查步骤停下。执行中也可以随时切换。</div>
        </div>
        <div className="sop-section-label">将依次执行</div>
        <ol className="sop-mini-flow">
          {flow.steps.map((s) => <li key={s.key}>{s.name}<KindTag kind={s.kind} /></li>)}
        </ol>
        {start.isError && <div className="field-err" role="alert">发起失败：{errorText(start.error)}</div>}
      </div>
    </Drawer>
  )
}
