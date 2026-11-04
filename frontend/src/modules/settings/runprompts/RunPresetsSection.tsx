// 设置「角色」（SPEC-settings-24，AUTO-03 由预置提示词升级）：交给 Claude Code 时选的角色。
// 逐个改场景名、执行要求、权限（只读 / 允许改文件）、默认目录、输出要求，设为默认（单选，弹窗打开时就选上它）、删除、加一个；
// 保存时整组替换（PUT /api/run-prompts）。内置六个角色，后端会把没见过的内置角色补在末尾，删掉的不补回。
// 前端先挡空的、重复的、超长的，其余以后端为准，400 时显示它的 message。照 IM 快捷回复的设置写（plugins/im/ChannelPanel.tsx）。
import { useState } from 'react'
import { errorText, useRunPresets, useSaveRunPresets, type RunPreset } from '../../../core/data'
import { Button, Checkbox, ErrorState, Field, IconButton, IconClose, Input, LoadingState, PageTitle, Select, Textarea } from '../../../core/ui'
import {
  DIR_KIND_OPTIONS, PERMISSION_OPTIONS, PRESET_CONTENT_MAX, PRESET_MAX, PRESET_OUTPUT_MAX, PRESET_SCENE_MAX, blankRole, cleanPresets, presetIssues, toggleDefault,
} from './presetModel'
import './runprompts.css'

type Note = { ok: boolean; text: string }

export function RunPresetsSection() {
  const q = useRunPresets()
  const save = useSaveRunPresets()
  const saved = q.data
  const [draft, setDraft] = useState<RunPreset[] | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const list = draft ?? saved ?? []
  const edit = (next: RunPreset[]) => { setDraft(next); setNote(null) }
  const patch = (i: number, p: Partial<RunPreset>) => edit(list.map((x, j) => (j === i ? { ...x, ...p } : x)))

  const bad = list.some((_, i) => Object.keys(presetIssues(list, i)).length > 0)
  const changed = draft !== null && JSON.stringify(cleanPresets(draft)) !== JSON.stringify(cleanPresets(saved ?? []))

  const submit = () => {
    setNote(null)
    if (bad || !changed || save.isPending) return
    save.mutate(cleanPresets(list), {
      onSuccess: (r) => { setDraft(null); setNote({ ok: true, text: r.length ? `已保存：${r.length} 个角色` : '已保存：不用角色' }) },
      onError: (e) => setNote({ ok: false, text: `没保存：${errorText(e)}` }),
    })
  }

  const title = <PageTitle parent="设置" desc="交给 Claude Code 时选一个角色：执行要求和输出要求拼进提示词，权限决定能不能改文件">角色</PageTitle>
  if (q.isPending) return <div className="rp-page">{title}<LoadingState /></div>
  if (q.isError) return <div className="rp-page">{title}<ErrorState title="角色没加载出来" error={errorText(q.error)} onRetry={() => void q.refetch()} /></div>

  return (
    <form className="rp-page" aria-label="角色" noValidate onSubmit={(e) => { e.preventDefault(); submit() }}>
      {title}
      <div className="rp-muted">
        每个角色写清要它做什么、能不能改文件、结束时怎么回报，比如研发评审只读、结束时回报 verdict 和 issues。
        交给 Claude Code 的弹窗里选一个，标了默认的打开时就选上。只读角色流式执行时不放开文件编辑；终端方式的权限由启动命令决定，只读只写进提示词。
      </div>
      <div className="rp-list">
        {list.map((p, i) => {
          const err = draft !== null ? presetIssues(list, i) : {}
          return (
            <div key={p.id || `new-${i}`} className="rp-item">
              <div className="rp-row">
                <Field label="角色场景" required error={err.scene}>
                  <Input value={p.scene} placeholder="如：产品经理工作台" aria-label={`第 ${i + 1} 条的角色场景`} invalid={!!err.scene}
                    maxLength={PRESET_SCENE_MAX + 10} onChange={(e) => patch(i, { scene: e.target.value })} />
                </Field>
                <Checkbox className="rp-default" checked={p.default} onCheckedChange={() => edit(toggleDefault(list, i))}>默认</Checkbox>
                <IconButton label={`删除「${p.scene.trim() || `第 ${i + 1} 条`}」`} size="sm" onClick={() => edit(list.filter((_, j) => j !== i))}><IconClose /></IconButton>
              </div>
              <div className="rp-row rp-opts">
                <Field label="权限">
                  <Select value={p.permission ?? 'accept_edits'} aria-label={`第 ${i + 1} 条的权限`} options={PERMISSION_OPTIONS}
                    onValueChange={(v) => patch(i, { permission: v as RunPreset['permission'] })} />
                </Field>
                <Field label="默认目录" hint="项目档案上线后按它选工作目录，现在只记下">
                  <Select value={p.dir_kind ?? 'any'} aria-label={`第 ${i + 1} 条的默认目录`} options={DIR_KIND_OPTIONS}
                    onValueChange={(v) => patch(i, { dir_kind: v as RunPreset['dir_kind'] })} />
                </Field>
              </div>
              <Field label="执行要求" required error={err.content}>
                <Textarea rows={3} value={p.content} placeholder="交给 Claude Code 时要它照做的事" aria-label={`第 ${i + 1} 条的执行要求`}
                  invalid={!!err.content} maxLength={PRESET_CONTENT_MAX + 100} onChange={(e) => patch(i, { content: e.target.value })} />
              </Field>
              <Field label="输出要求" error={err.output} hint="可选：结束时要它怎么回报，如用 pmw_finish_run 回报 result 的结构">
                <Textarea rows={2} value={p.output ?? ''} placeholder={'如：结束时用 pmw_finish_run 回报 result：{"verdict": "pass 或 reject", "issues": [...]}'}
                  aria-label={`第 ${i + 1} 条的输出要求`} invalid={!!err.output} maxLength={PRESET_OUTPUT_MAX + 100}
                  onChange={(e) => patch(i, { output: e.target.value })} />
              </Field>
            </div>
          )
        })}
        {!list.length && <div className="rp-muted">还没有角色，交给 Claude Code 时只能手写附加说明。</div>}
      </div>
      <div className="rp-actions">
        <Button size="sm" disabled={list.length >= PRESET_MAX}
          onClick={() => edit([...list, blankRole()])}>{list.length >= PRESET_MAX ? `最多 ${PRESET_MAX} 个` : '加一个角色'}</Button>
        <span className="spacer" />
        {draft !== null && <Button size="sm" variant="ghost" onClick={() => { setDraft(null); setNote(null) }}>撤销改动</Button>}
        <button type="submit" className="btn btn-outline btn-sm" disabled={!changed || bad || save.isPending}>{save.isPending ? '保存中…' : '保存'}</button>
      </div>
      {note && <div className={note.ok ? 'rp-ok' : 'rp-err'} role={note.ok ? 'status' : 'alert'}>{note.text}</div>}
    </form>
  )
}
