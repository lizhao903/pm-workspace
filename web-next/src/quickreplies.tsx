import { useState } from 'react'
import { QUICK_REPLIES } from './data'
import { cls } from './ui'

// 快捷回复设置：即时通讯分类下、消息过期下面的一块，和具体渠道无关。
// 消息详情的「反馈」和列表行的「回复」菜单都读 QUICK_REPLIES；原型直接改这份数组（刷新页面回到种子数据），
// 正式产品存在 IM 设置里（GET / PATCH /api/im/settings 的 quick_replies，整组替换）

const MAX = 20
const MAX_TEXT = 200

type QR = { text: string; done: boolean }

export function ImQuickReplies() {
  const [saved, setSaved] = useState<QR[]>(() => QUICK_REPLIES.map((q) => ({ ...q })))
  const [list, setList] = useState<QR[]>(saved)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const edit = (next: QR[]) => { setList(next); setNote(null) }
  const patch = (i: number, p: Partial<QR>) => edit(list.map((q, j) => (j === i ? { ...q, ...p } : q)))
  const texts = list.map((q) => q.text.trim())
  const issue = (i: number) => {
    const t = texts[i]
    if (!t) return '不能为空'
    if (t.length > MAX_TEXT) return `最多 ${MAX_TEXT} 字`
    if (texts.indexOf(t) !== i) return '和上面的重复了'
    return null
  }
  const bad = list.some((_, i) => issue(i))
  const clean = list.map((q) => ({ text: q.text.trim(), done: q.done }))
  const changed = JSON.stringify(clean) !== JSON.stringify(saved)
  const save = () => {
    if (bad || !changed) return
    QUICK_REPLIES.splice(0, QUICK_REPLIES.length, ...clean)
    setSaved(clean)
    setList(clean)
    setNote({ ok: true, text: clean.length ? `已保存：${clean.length} 条快捷回复` : '已保存：不用快捷回复' })
  }

  return (
    <div className="im-expiry im-qrset">
      <div className="im-qrset-head">
        <span className="im-expiry-label">快捷回复</span>
        <span className="field-hint-line">消息详情的「反馈」和列表的「回复」菜单里用。勾「并处理」的，发完同时把消息标为已处理</span>
      </div>
      {list.map((q, i) => {
        const err = issue(i)
        return (
          <div key={i} className="im-qrset-row">
            <input value={q.text} placeholder="回复内容" aria-label={`第 ${i + 1} 条快捷回复`} className={cls(err && 'bad')}
              onChange={(e) => patch(i, { text: e.target.value })} />
            <label className="im-qrset-done"><input type="checkbox" checked={q.done} onChange={(e) => patch(i, { done: e.target.checked })} />并处理</label>
            <button className="icon-btn icon-btn-sm" title="上移" disabled={i === 0}
              onClick={() => edit(list.map((x, j) => (j === i - 1 ? list[i] : j === i ? list[i - 1] : x)))}>
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 12.5v-9M4 7.5l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <button className="icon-btn icon-btn-sm" title="删除这条" onClick={() => edit(list.filter((_, j) => j !== i))}>
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
            {err && <span className="field-err">{err}</span>}
          </div>
        )
      })}
      {!list.length && <span className="muted">还没有快捷回复。</span>}
      <div className="im-qrset-foot">
        <button className="btn btn-ghost" disabled={list.length >= MAX} onClick={() => edit([...list, { text: '', done: false }])}>
          {list.length >= MAX ? `最多 ${MAX} 条` : '加一条'}
        </button>
        <span className="spacer" />
        {changed && <button className="btn btn-ghost" onClick={() => { setList(saved); setNote(null) }}>撤销改动</button>}
        <button className="btn btn-outline" disabled={!changed || bad} onClick={save}>保存</button>
        {note && <span className={note.ok ? 'ok-text' : 'field-err'}>{note.text}</span>}
      </div>
    </div>
  )
}
