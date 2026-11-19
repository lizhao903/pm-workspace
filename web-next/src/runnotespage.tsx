// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 设置「快捷说明」（SPEC-settings-32，用户 2026-11-19 提）：「交给执行」弹窗附加说明上面那排芯片的名称、文字、顺序。
// 原型只放内存（runnotes.ts）；正式产品 frontend/src/modules/settings/runnotes/RunNotesSection.tsx，接口 GET / PUT /api/run-quick-notes。
import { useState } from 'react'
import { PageTitle } from './topbar'
import { NOTE_MAX, noteIssues, saveRunQuickNotes, sameNotes, useRunQuickNotes, type RunQuickNote } from './runnotes'
import { GrowArea, cls } from './ui'

export function RunNotesPage() {
  const saved = useRunQuickNotes()
  const [list, setList] = useState<RunQuickNote[]>(saved)
  const [note, setNote] = useState('')
  const issues = noteIssues(list)
  const bad = issues.some((x) => x.label || x.text)
  const changed = !sameNotes(list, saved)
  const put = (i: number, p: Partial<RunQuickNote>) => { setList((xs) => xs.map((x, j) => (j === i ? { ...x, ...p } : x))); setNote('') }
  const move = (i: number, d: -1 | 1) => { setList((xs) => { const n = [...xs]; [n[i], n[i + d]] = [n[i + d], n[i]]; return n }); setNote('') }
  const save = () => {
    if (bad || !changed) return
    saveRunQuickNotes(list)
    const n = list.length
    setNote(n ? `已保存：${n} 条快捷说明` : '已保存：不用快捷说明')
  }
  return (
    <div className="page page-fill up-page">
      <PageTitle parent="设置" count={`${saved.length} 条`} desc="「交给执行」弹窗里附加说明上面的快捷选项：点一个把文字追加进附加说明">快捷说明</PageTitle>
      <div className="list-sub">芯片按这里的顺序排；点一个把它的文字追加进附加说明（另起一行，已经有的不重复加），之后还能手改。只帮着填附加说明，不影响权限和角色。</div>
      {list.map((n, i) => (
        <div key={i} className="up-card rn-card">
          <div className="rn-row">
            <label className="field rn-label">
              <span className="field-label">名称</span>
              <input value={n.label} className={cls(issues[i].label && 'bad')} placeholder="芯片上显示，最多 12 字" onChange={(e) => put(i, { label: e.target.value })} />
              {issues[i].label && <span className="field-err">{issues[i].label}</span>}
            </label>
            <span className="spacer" />
            <button className="act act-quiet" disabled={i === 0} onClick={() => move(i, -1)}>上移</button>
            <button className="act act-quiet" disabled={i === list.length - 1} onClick={() => move(i, 1)}>下移</button>
            <button className="act act-quiet btn-danger-ghost" onClick={() => { setList((xs) => xs.filter((_, j) => j !== i)); setNote('') }}>删除</button>
          </div>
          <label className="field">
            <span className="field-label">文字</span>
            <GrowArea rows={2} value={n.text} className={cls(issues[i].text && 'bad')} placeholder="点了追加进附加说明的内容，最多 500 字" onChange={(e) => put(i, { text: e.target.value })} />
            {issues[i].text && <span className="field-err">{issues[i].text}</span>}
          </label>
        </div>
      ))}
      {!list.length && <div className="mount-empty">还没有快捷说明，弹窗里写「还没有快捷说明，在设置里加」</div>}
      <div className="act-row">
        <button className="btn btn-ghost" disabled={list.length >= NOTE_MAX} onClick={() => { setList((xs) => [...xs, { label: '', text: '' }]); setNote('') }}>
          {list.length >= NOTE_MAX ? `最多 ${NOTE_MAX} 条` : '加一条'}
        </button>
        <span className="spacer" />
        {changed && <button className="btn btn-ghost" onClick={() => { setList(saved); setNote('') }}>撤销改动</button>}
        <button className="btn" disabled={!changed || bad} onClick={save}>保存</button>
      </div>
      {note && <div className="list-sub" role="status">{note}</div>}
    </div>
  )
}
