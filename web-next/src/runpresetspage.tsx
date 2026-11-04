// 设置「角色」（SPEC-settings-24，AUTO-03 由预置提示词升级）：交给 Claude Code 时选的角色。
// 逐个改场景名、权限、默认目录、执行要求、输出要求，设为默认（单选）、删除、加一个，整组保存。原型只放内存（runpresets.ts）；
// 正式产品 frontend/src/modules/settings/runprompts/RunPresetsSection.tsx，接口 GET / PUT /api/run-prompts。
import { useState } from 'react'
import { PageTitle } from './topbar'
import { DIR_KIND_OPTIONS, PERMISSION_OPTIONS, PRESET_MAX, blankRole, presetIssues, saveRunPresets, useRunPresets, type RunPreset } from './runpresets'

export function RunPresetsPage() {
  const saved = useRunPresets()
  const [draft, setDraft] = useState<RunPreset[] | null>(null)
  const [note, setNote] = useState('')
  const list = draft ?? saved
  const edit = (next: RunPreset[]) => { setDraft(next); setNote('') }
  const patch = (i: number, p: Partial<RunPreset>) => edit(list.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const bad = list.some((_, i) => Object.keys(presetIssues(list, i)).length > 0)
  const save = () => {
    if (bad || draft === null) return
    saveRunPresets(draft)
    setDraft(null)
    setNote(draft.length ? `已保存：${draft.length} 个角色` : '已保存：不用角色')
  }
  return (
    <div className="page page-fill up-page">
      <PageTitle parent="设置" desc="交给 Claude Code 时选一个角色：执行要求和输出要求拼进提示词，权限决定能不能改文件">角色</PageTitle>
      <div className="list-sub">每个角色写清要它做什么、能不能改文件、结束时怎么回报，比如研发评审只读、结束时回报 verdict 和 issues。交给 Claude Code 的弹窗里选一个，标了默认的打开时就选上。只读角色流式执行时不放开文件编辑；终端方式的权限由启动命令决定，只读只写进提示词。</div>
      {list.map((p, i) => {
        const err = draft !== null ? presetIssues(list, i) : {}
        return (
          <section key={p.id || `new-${i}`} className="up-card rp-card" aria-label={p.scene || `第 ${i + 1} 条`}>
            <div className="act-row">
              <label className="field" style={{ flex: 1 }}>
                <span className="field-label">角色场景 *</span>
                <input className={err.scene ? 'bad' : undefined} value={p.scene} placeholder="如：产品经理工作台" onChange={(e) => patch(i, { scene: e.target.value })} />
                {err.scene && <span className="field-err">{err.scene}</span>}
              </label>
              <label className="check">
                <input type="checkbox" checked={p.default} onChange={() => edit(list.map((x, j) => ({ ...x, default: j === i ? !p.default : false })))} />默认
              </label>
              <button className="btn btn-ghost" onClick={() => edit(list.filter((_, j) => j !== i))}>删除</button>
            </div>
            <div className="act-row">
              <label className="field" style={{ flex: 1 }}>
                <span className="field-label">权限</span>
                <select className="select" value={p.permission} onChange={(e) => patch(i, { permission: e.target.value as RunPreset['permission'] })}>
                  {PERMISSION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              <label className="field" style={{ flex: 1 }}>
                <span className="field-label">默认目录</span>
                <select className="select" value={p.dir_kind} onChange={(e) => patch(i, { dir_kind: e.target.value as RunPreset['dir_kind'] })}>
                  {DIR_KIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <span className="list-sub">项目档案上线后按它选工作目录，现在只记下</span>
              </label>
            </div>
            <label className="field">
              <span className="field-label">执行要求 *</span>
              <textarea className={err.content ? 'qs-input bad' : 'qs-input'} rows={3} value={p.content} placeholder="交给 Claude Code 时要它照做的事"
                onChange={(e) => patch(i, { content: e.target.value })} />
              {err.content && <span className="field-err">{err.content}</span>}
            </label>
            <label className="field">
              <span className="field-label">输出要求</span>
              <textarea className={err.output ? 'qs-input bad' : 'qs-input'} rows={2} value={p.output}
                placeholder={'如：结束时用 pmw_finish_run 回报 result：{"verdict": "pass 或 reject", "issues": [...]}'}
                onChange={(e) => patch(i, { output: e.target.value })} />
              {err.output ? <span className="field-err">{err.output}</span> : <span className="list-sub">可选：结束时要它怎么回报，如用 pmw_finish_run 回报 result 的结构</span>}
            </label>
          </section>
        )
      })}
      {!list.length && <div className="list-sub">还没有角色，交给 Claude Code 时只能手写附加说明。</div>}
      <div className="act-row">
        <button className="btn" disabled={list.length >= PRESET_MAX} onClick={() => edit([...list, blankRole()])}>
          {list.length >= PRESET_MAX ? `最多 ${PRESET_MAX} 个` : '加一个角色'}
        </button>
        <span className="spacer" />
        {draft !== null && <button className="btn btn-ghost" onClick={() => { setDraft(null); setNote('') }}>撤销改动</button>}
        <button className="btn btn-primary" disabled={draft === null || bad} onClick={save}>保存</button>
      </div>
      {note && <div className="list-sub" role="status">{note}</div>}
    </div>
  )
}
