// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置 > 插件 > 工作区（AUTO-07）：给需求工作区分端口段的范围。每个在用的工作区占一段（测试环境用），清理后归还。
// 改了只管以后的分配，已经分出去的不动。范围不能和工作台自己用的端口重叠（后端也挡）。
// 另有测试环境保留时长（AUTO-09）：研发 pipeline 测试通过后测试环境留给人工验收多久，单独保存。
import { useState } from 'react'
import {
  MAX_ENV_KEEP_HOURS, QueryState, errorText, portRangeError, useSaveWorktreeSettings, useWorktreeSettings, type WorktreeSettings,
} from '../../core/data'
import { Button, Field, Input } from '../../core/ui'
import './worktree.css'

type Note = { ok: boolean; text: string }

export default function WorktreeSettingsSection() {
  const settings = useWorktreeSettings()
  return (
    <QueryState query={settings} errorTitle="读不到工作区的设置">
      {(s) => <Body s={s} />}
    </QueryState>
  )
}

function Body({ s }: { s: WorktreeSettings }) {
  const save = useSaveWorktreeSettings()
  const [min, setMin] = useState(String(s.port_min))
  const [max, setMax] = useState(String(s.port_max))
  const [block, setBlock] = useState(String(s.port_block))
  const [note, setNote] = useState<Note | null>(null)
  const n = { min: Number(min), max: Number(max), block: Number(block) }
  const bad = portRangeError(n.min, n.max, n.block, s.reserved)
  const changed = n.min !== s.port_min || n.max !== s.port_max || n.block !== s.port_block
  const blocks = bad ? 0 : Math.floor((n.max - n.min + 1) / n.block)

  const submit = () => {
    setNote(null)
    if (bad || !changed || save.isPending) return
    save.mutate({ port_min: n.min, port_max: n.max, port_block: n.block }, {
      onSuccess: (r) => setNote({ ok: true, text: `已保存：${r.port_min}–${r.port_max}，每段 ${r.port_block} 个，以后准备的工作区按这个分` }),
      onError: (e) => setNote({ ok: false, text: `没保存：${errorText(e)}` }),
    })
  }
  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => { set(e.target.value); setNote(null) }

  return (
    <form className="wt-settings" aria-label="工作区设置" noValidate onSubmit={(e) => { e.preventDefault(); submit() }}>
      <div className="wt-settings-title">工作区端口</div>
      <Field label="端口范围和每段个数" wrap={false} error={changed ? bad : undefined}
        hint={`每个在用的工作区分一段端口给测试环境用，清理后归还。不能和工作台自己用的 ${s.reserved[0]}–${s.reserved[1]} 重叠；改了只管以后的分配`}>
        <div className="wt-settings-row">
          <Input type="number" inputMode="numeric" className="wt-settings-input" aria-label="起始端口" value={min} invalid={changed && !!bad} onChange={edit(setMin)} />
          <span className="wt-muted">到</span>
          <Input type="number" inputMode="numeric" className="wt-settings-input" aria-label="结束端口" value={max} invalid={changed && !!bad} onChange={edit(setMax)} />
          <span className="wt-muted">每段</span>
          <Input type="number" inputMode="numeric" className="wt-settings-input" aria-label="每段端口数" value={block} invalid={changed && !!bad} onChange={edit(setBlock)} />
          <span className="wt-muted">个</span>
          <Button type="submit" variant="outline" size="sm" disabled={!changed || !!bad || save.isPending}>{save.isPending ? '保存中…' : '保存'}</Button>
        </div>
      </Field>
      {note && <div className={note.ok ? 'wt-settings-ok' : 'wt-settings-err'} role={note.ok ? 'status' : 'alert'}>{note.text}</div>}
      <div className="wt-muted" aria-label="此刻">
        能分 {blocks} 段，此刻 {s.active} 个工作区在用{s.dir ? `，放在 ${s.dir}` : ''}
      </div>
      <KeepHours s={s} />
    </form>
  )
}

/** 测试环境保留时长：单独一行、单独保存（不和端口一起），1 到 168 小时 */
function KeepHours({ s }: { s: WorktreeSettings }) {
  const save = useSaveWorktreeSettings()
  const [hours, setHours] = useState(String(s.env_keep_hours))
  const [note, setNote] = useState<Note | null>(null)
  const n = Number(hours)
  const bad = !Number.isInteger(n) || n < 1 || n > MAX_ENV_KEEP_HOURS ? `要是 1 到 ${MAX_ENV_KEEP_HOURS} 的整数` : undefined
  const changed = n !== s.env_keep_hours
  const submit = () => {
    setNote(null)
    if (bad || !changed || save.isPending) return
    save.mutate({ env_keep_hours: n }, {
      onSuccess: (r) => setNote({ ok: true, text: `已保存：测试通过后保留 ${r.env_keep_hours} 小时` }),
      onError: (e) => setNote({ ok: false, text: `没保存：${errorText(e)}` }),
    })
  }
  return (
    <>
      <Field label="测试环境保留时长" wrap={false} error={changed ? bad : undefined}
        hint="研发 pipeline 测试通过后，测试环境留着给人工验收；到点、验收结束、任务完成或工作区清理时回收">
        <div className="wt-settings-row">
          <Input type="number" inputMode="numeric" className="wt-settings-input" aria-label="保留小时数" value={hours} invalid={changed && !!bad}
            onChange={(e) => { setHours(e.target.value); setNote(null) }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }} />
          <span className="wt-muted">小时</span>
          <Button type="button" variant="outline" size="sm" disabled={!changed || !!bad || save.isPending} onClick={submit}>
            {save.isPending ? '保存中…' : '保存'}
          </Button>
        </div>
      </Field>
      {note && <div className={note.ok ? 'wt-settings-ok' : 'wt-settings-err'} role={note.ok ? 'status' : 'alert'}>{note.text}</div>}
    </>
  )
}
