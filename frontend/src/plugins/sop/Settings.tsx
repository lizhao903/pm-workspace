// 设置 > 插件 > SOP 编排（SOP-07）：同时调模型的步骤数。整个插件跨所有执行算，ai、提取、分类、逐项处理、Agent 节点占名额；
// 多出来的步骤排队（仍是执行中，运行页显示「排队中」），改了立即生效：调大马上放排队的进来，调小时在跑的不打断。
// 前端只挡不是整数的，超出 1..16 交给后端，原样显示它的 400
import { useState } from 'react'
import { QueryState, SOP_MODEL_CONCURRENCY_MAX, errorText, usePatchSopSettings, useSopSettings, type SopSettings } from '../../core/data'
import { Button, Field, Input } from '../../core/ui'
import './sop.css'

type Note = { ok: boolean; text: string }

export default function SopSettingsSection() {
  const settings = useSopSettings()
  return (
    <QueryState query={settings} errorTitle="读不到 SOP 的设置">
      {(s) => <Body s={s} />}
    </QueryState>
  )
}

function Body({ s }: { s: SopSettings }) {
  const save = usePatchSopSettings()
  // 没改过时跟着后端的值走
  const [draft, setDraft] = useState<string | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const value = draft ?? String(s.model_concurrency)
  const n = Number(value)
  const bad = /^\d+$/.test(value.trim()) ? undefined : `填 1 到 ${SOP_MODEL_CONCURRENCY_MAX} 的整数`
  const changed = !bad && n !== s.model_concurrency

  const submit = () => {
    setNote(null)
    if (bad || !changed || save.isPending) return
    save.mutate({ model_concurrency: n }, {
      onSuccess: (r) => { setDraft(null); setNote({ ok: true, text: `已保存：最多同时 ${r.model_concurrency} 个步骤调模型，立即生效` }) },
      onError: (e) => setNote({ ok: false, text: `没保存：${errorText(e)}` }),
    })
  }

  return (
    <form className="sop-settings" aria-label="SOP 设置" noValidate onSubmit={(e) => { e.preventDefault(); submit() }}>
      <div className="sop-settings-title">执行并发</div>
      <Field label="同时调模型的步骤数" wrap={false} error={draft !== null ? bad : undefined}
        hint="本机推理慢时调小，消息多时多出来的步骤排队。AI、提取、分类、逐项处理、Agent 节点算在内，跨所有执行一起算；改了立即生效，调小时正在调的不打断">
        <div className="sop-settings-row">
          <Input type="number" min={1} max={SOP_MODEL_CONCURRENCY_MAX} step={1} inputMode="numeric" className="sop-settings-input"
            aria-label="同时调模型的步骤数" value={value} invalid={draft !== null && !!bad}
            onChange={(e) => { setDraft(e.target.value); setNote(null) }} />
          <span className="sop-settings-muted">个</span>
          <Button type="submit" variant="outline" size="sm" disabled={!changed || save.isPending}>{save.isPending ? '保存中…' : '保存'}</Button>
        </div>
      </Field>
      {note && <div className={note.ok ? 'sop-settings-ok' : 'sop-settings-err'} role={note.ok ? 'status' : 'alert'}>{note.text}</div>}
      <div className="sop-settings-now" aria-label="此刻">
        此刻 {s.running} 个步骤在调模型{s.queued > 0 ? `，${s.queued} 个在排队` : '，没有排队的'}
      </div>
    </form>
  )
}
