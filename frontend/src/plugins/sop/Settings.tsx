// 设置 > 插件 > SOP 编排（SOP-07、AUTO-12）。
// 执行并发：同时调模型的步骤数。整个插件跨所有执行算，ai、提取、分类、逐项处理、Agent 节点占名额；
// 多出来的步骤排队（仍是执行中，运行页显示「排队中」），改了立即生效：调大马上放排队的进来，调小时在跑的不打断。
// 流水线治理（AUTO-12，SPEC-sop-15）：同时跑的 Claude Code 步骤数（多出来的排队）、每个需求累计跑 Claude Code 的次数和分钟数上限，
// 超了这一步暂停等人放行；token 用量拿不到，只按次数和时长控制。
// 每项各自保存；前端只挡不是整数的，超出范围交给后端，原样显示它的 400
import { useState } from 'react'
import {
  QueryState, SOP_CLAUDE_CONCURRENCY_MAX, SOP_MODEL_CONCURRENCY_MAX, SOP_TASK_MAX_MINUTES_MAX, SOP_TASK_MAX_RUNS_MAX, errorText,
  usePatchSopSettings, useSopSettings, type SopSettings, type SopSettingsPatch,
} from '../../core/data'
import { Button, Field, Input } from '../../core/ui'
import './sop.css'

type Note = { ok: boolean; text: string }
type Key = keyof SopSettingsPatch

export default function SopSettingsSection() {
  const settings = useSopSettings()
  return (
    <QueryState query={settings} errorTitle="读不到 SOP 的设置">
      {(s) => <Body s={s} />}
    </QueryState>
  )
}

/** 一项整数设置：自己的草稿、保存按钮和结果提示；min 为 0 的项 0 表示不限 */
function LimitField({ k, label, hint, value, min, max, unit, saved }: {
  k: Key
  label: string
  hint: string
  value: number
  min: number
  max: number
  unit: string
  /** 保存成功后的提示 */
  saved: (s: SopSettings) => string
}) {
  const save = usePatchSopSettings()
  // 没改过时跟着后端的值走
  const [draft, setDraft] = useState<string | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const cur = draft ?? String(value)
  const n = Number(cur)
  const bad = /^\d+$/.test(cur.trim()) ? undefined : min === 0 ? `填 0 到 ${max} 的整数，0 是不限` : `填 ${min} 到 ${max} 的整数`
  const changed = !bad && n !== value
  const busy = save.isPending

  const submit = () => {
    setNote(null)
    if (bad || !changed || busy) return
    save.mutate({ [k]: n }, {
      onSuccess: (r) => { setDraft(null); setNote({ ok: true, text: saved(r) }) },
      onError: (e) => setNote({ ok: false, text: `没保存：${errorText(e)}` }),
    })
  }

  return (
    <form className="sop-settings-item" aria-label={label} noValidate onSubmit={(e) => { e.preventDefault(); submit() }}>
      <Field label={label} wrap={false} error={draft !== null ? bad : undefined} hint={hint}>
        <div className="sop-settings-row">
          <Input type="number" min={min} max={max} step={1} inputMode="numeric" className="sop-settings-input"
            aria-label={label} value={cur} invalid={draft !== null && !!bad}
            onChange={(e) => { setDraft(e.target.value); setNote(null) }} />
          <span className="sop-settings-muted">{unit}</span>
          <Button type="submit" variant="outline" size="sm" disabled={!changed || busy}>{busy ? '保存中…' : '保存'}</Button>
        </div>
      </Field>
      {note && <div className={note.ok ? 'sop-settings-ok' : 'sop-settings-err'} role={note.ok ? 'status' : 'alert'}>{note.text}</div>}
    </form>
  )
}

const limitText = (n: number, unit: string) => (n === 0 ? '不限' : `${n} ${unit}`)

function Body({ s }: { s: SopSettings }) {
  return (
    <div className="sop-settings" aria-label="SOP 设置">
      <div className="sop-settings-title">执行并发</div>
      <LimitField k="model_concurrency" label="同时调模型的步骤数" value={s.model_concurrency} min={1} max={SOP_MODEL_CONCURRENCY_MAX} unit="个"
        hint="本机推理慢时调小，消息多时多出来的步骤排队。AI、提取、分类、逐项处理、Agent 节点算在内，跨所有执行一起算；改了立即生效，调小时正在调的不打断"
        saved={(r) => `已保存：最多同时 ${r.model_concurrency} 个步骤调模型，立即生效`} />
      <div className="sop-settings-now" aria-label="此刻">
        此刻 {s.running} 个步骤在调模型{s.queued > 0 ? `，${s.queued} 个在排队` : '，没有排队的'}
      </div>

      <div className="sop-settings-title">流水线治理</div>
      <LimitField k="claude_concurrency" label="同时跑的 Claude Code 步骤数" value={s.claude_concurrency ?? 3} min={1} max={SOP_CLAUDE_CONCURRENCY_MAX} unit="个"
        hint="跨所有执行一起算，多出来的 Claude Code 步骤排队，排到了自动发起；改了立即生效，调小时正在跑的不打断"
        saved={(r) => `已保存：最多同时 ${r.claude_concurrency} 个 Claude Code 步骤，立即生效`} />
      <div className="sop-settings-now" aria-label="Claude Code 此刻">
        此刻 {s.claude_running ?? 0} 个 Claude Code 步骤在跑{(s.claude_queued ?? 0) > 0 ? `，${s.claude_queued} 个在排队` : '，没有排队的'}
      </div>
      <LimitField k="task_max_claude_runs" label="每个需求最多跑 Claude Code 的次数" value={s.task_max_claude_runs ?? 30} min={0} max={SOP_TASK_MAX_RUNS_MAX} unit="次"
        hint="按步骤关联的任务累计，重试、评审退回、测试退回的每一轮都算；没关联任务的按同一次流水线算。到了上限，下一次发起前这一步暂停，发通知等你放行。0 是不限"
        saved={(r) => `已保存：每个需求最多 ${limitText(r.task_max_claude_runs, '次')}`} />
      <LimitField k="task_max_claude_minutes" label="每个需求 Claude Code 累计时长上限" value={s.task_max_claude_minutes ?? 1440} min={0} max={SOP_TASK_MAX_MINUTES_MAX} unit="分钟"
        hint="同一个需求历次 Claude Code 跑的时间加起来（在跑的算到现在）。到了上限，下一次发起前暂停；正在跑的那次不打断，它有自己的超时。0 是不限"
        saved={(r) => `已保存：每个需求累计最多 ${limitText(r.task_max_claude_minutes, '分钟')}`} />
      {!s.token_limit_supported && (
        <div className="sop-settings-muted" aria-label="token 上限">
          token 上限暂不支持：Claude Code 的执行记录里没有 token 用量，目前只按次数和时长控制。
        </div>
      )}
    </div>
  )
}
