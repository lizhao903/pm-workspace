// AI 协助面板（SPEC-sop-10）：对话接 POST /api/sop/assist（SOP-04a），不保存。AI 的改动先作为提案出现在对话里，
// 点「应用到流程」才替换画布；只有最近一次应用、且之后没有别的改动时能「撤销」（撤销只退回这次提案）。
// 收起只是藏起来（hidden），对话和没决定的提案在本次编排页里保留
import { useEffect, useRef, useState } from 'react'
import { errorText, useSopAssist, type SopDraft } from '../../core/data'
import { Button, IconButton, IconClose, cls } from '../../core/ui'
import type { Draft } from './edit'
import { KindTag } from './parts'

export type AiMsg = { id: number; role: 'user' | 'ai'; text: string; notes?: string[]; proposal?: SopDraft; state?: 'new' | 'applied' | 'undone'; error?: boolean }

const EXAMPLES = [
  '报销审核流程：收到报销单，AI 识别发票金额，如果金额大于 5000 就经理审批，否则财务直接复核，最后打款并通知申请人',
  '竞品周报：同时抓取三家竞品官网更新和应用商店评论，AI 总结变化，人工校对，然后发到产品群',
  '客户投诉处理：AI 分类投诉，如果是紧急问题就电话回访，否则工单跟进，最后人工确认已解决',
]

/** 发给接口的草稿：去掉画布位置（AI 不管位置） */
// IM 触发的过滤、顺序、拦截和文件夹也带上（TSK-0490），AI 改的时候照着现在的设置
const forAssist = (d: Draft): SopDraft => ({
  ...(d.id ? { id: d.id } : {}), name: d.name, desc: d.desc, trigger: d.trigger, fields: d.fields, steps: d.steps,
  ...(d.trigger === 'im' && d.im ? { im: d.im } : {}), ...(d.folder_id ? { folder_id: d.folder_id } : {}),
})

export function AiPanel({ hidden, draft, selected, onApply, onUndo, canUndo, onClose }: {
  hidden: boolean
  draft: Draft
  /** 选中步骤的下标 */
  selected: number | null
  onApply: (d: SopDraft) => void
  onUndo: () => void
  /** 最近一次应用的提案还能撤销（之后没有别的改动） */
  canUndo: boolean
  onClose: () => void
}) {
  const [msgs, setMsgs] = useState<AiMsg[]>(() => [{
    id: 0, role: 'ai',
    text: draft.steps.length
      ? `正在编辑「${draft.name}」。可以让我加步骤、删步骤、把几步改成并行，或者检查一下流程。`
      : '用一段话描述这个流程：从什么开始、每一步做什么、哪里要人看、哪里有分支或可以同时做。我先拆成步骤给你看，你确认后再放到画布上。',
  }])
  const [text, setText] = useState('')
  const assist = useSopAssist()
  const thinking = assist.isPending
  const listRef = useRef<HTMLDivElement>(null)
  const seq = useRef(1)

  useEffect(() => {
    const el = listRef.current
    if (el && 'scrollTo' in el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [msgs, thinking])

  const push = (m: Omit<AiMsg, 'id'>) => {
    const id = seq.current
    seq.current += 1
    setMsgs((list) => [...list, { ...m, id }])
  }
  const send = (raw = text) => {
    const t = raw.trim()
    if (!t || thinking) return
    push({ role: 'user', text: t })
    setText('')
    assist.mutate({ message: t, draft: forAssist(draft), ...(selected !== null ? { selected } : {}) }, {
      onSuccess: (r) => push({ role: 'ai', text: r.text, notes: r.notes, proposal: r.draft, state: r.draft ? 'new' : undefined }),
      onError: (e) => push({ role: 'ai', text: `没能生成流程：${errorText(e)}`, error: true }),
    })
  }
  const mark = (id: number, state: AiMsg['state']) => setMsgs((m) => m.map((x) => (x.id === id ? { ...x, state } : x)))
  const lastApplied = [...msgs].reverse().find((m) => m.state === 'applied')?.id

  const anchor = draft.steps[selected ?? draft.steps.length - 1]
  const chips = draft.steps.length ? ['检查一下流程', `在${anchor?.name || '最后一步'}之后加一个人工检查`, '加一个判断分支'] : []

  return (
    <aside className="sop-ai-panel" hidden={hidden} aria-label="AI 协助">
      <div className="sop-ai-head">
        <span className="sop-ai-mark" aria-hidden="true">AI</span>
        <span className="sop-ai-title">AI 协助</span>
        <span className="spacer" />
        <IconButton label="收起 AI 协助" title="收起" onClick={onClose}><IconClose /></IconButton>
      </div>
      <div className="sop-ai-msgs" ref={listRef} aria-live="polite">
        {msgs.map((m) => (
          <div key={m.id} className={cls('sop-ai-msg', `sop-ai-${m.role}`)}>
            <div className={cls('sop-ai-bubble', m.error && 'sop-ai-error')}>
              <div>{m.text}</div>
              {!!m.notes?.length && <ul className="sop-ai-notes">{m.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
              {m.proposal && (
                <div className={cls('sop-ai-proposal', m.state === 'undone' && 'undone')}>
                  <ol className="sop-ai-steps">
                    {m.proposal.steps.map((s) => {
                      const of = s.branch && m.proposal!.steps.find((x) => x.key === s.branch!.of)
                      return (
                        <li key={s.key}>
                          <span className="ellipsis">{s.name}</span>
                          <KindTag kind={s.kind} />
                          {of && <span className="sop-ai-step-note">{of.cases?.find((c) => c.key === s.branch!.case)?.label ?? s.branch!.case} 分支</span>}
                          {(s.after?.length ?? 0) > 1 && <span className="sop-ai-step-note">汇合</span>}
                        </li>
                      )
                    })}
                  </ol>
                  <div className="sop-act-row">
                    {m.state === 'new' && <>
                      <Button variant="primary" size="sm" onClick={() => { onApply(m.proposal!); mark(m.id, 'applied') }}>应用到流程</Button>
                      <Button size="sm" onClick={() => mark(m.id, 'undone')}>不用了</Button>
                    </>}
                    {m.state === 'applied' && <>
                      <span className="sop-ai-state">已应用</span>
                      {m.id === lastApplied && canUndo && <Button size="sm" onClick={() => { onUndo(); mark(m.id, 'undone') }}>撤销</Button>}
                    </>}
                    {m.state === 'undone' && <span className="sop-ai-state">未采用</span>}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
        {thinking && (
          <div className="sop-ai-msg sop-ai-ai"><div className="sop-ai-bubble sop-ai-typing" aria-label="AI 正在回复"><span /><span /><span /></div></div>
        )}
        {msgs.length === 1 && !draft.steps.length && (
          <div className="sop-ai-examples">
            <div className="sop-ai-examples-title">试试这些描述</div>
            {EXAMPLES.map((e) => <button key={e} type="button" className="sop-ai-example" disabled={thinking} onClick={() => send(e)}>{e}</button>)}
          </div>
        )}
      </div>
      <div className="sop-ai-input">
        {chips.length > 0 && (
          <div className="sop-ai-chips">
            {chips.map((c) => <button key={c} type="button" className="sop-ai-chip" disabled={thinking} onClick={() => send(c)}>{c}</button>)}
          </div>
        )}
        <div className="sop-ai-box">
          <textarea rows={3} value={text} aria-label="和 AI 说"
            placeholder={draft.steps.length ? '比如：把 A 和 B 改成并行 / 删掉 C / 在 D 之后加一个人工检查' : '描述这个流程…'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() } }} />
          <div className="sop-ai-box-foot">
            <span className="field-hint-line">⌘Enter 发送；AI 的改动要你点「应用」才生效</span>
            <Button variant="primary" size="sm" disabled={!text.trim() || thinking} onClick={() => send()}>发送</Button>
          </div>
        </div>
      </div>
    </aside>
  )
}
