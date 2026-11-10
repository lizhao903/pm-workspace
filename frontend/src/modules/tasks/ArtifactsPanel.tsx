// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 任务抽屉的产出物（DEV-08b，SPEC-tasks-5）：按提交、分支、PR、文件分组，有链接的新窗口打开，
// 只有本机路径的显示相对路径、可复制绝对路径；可以手工登记一条（来源记成 manual）。
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  QueryState, errorText, useObjectArtifacts, useRecordArtifact, type Artifact, type ArtifactSource, type WorkObject,
} from '../../core/data'
import { Button, Input, Tag } from '../../core/ui'
import { groupArtifacts, locationOf, shortSha, type ParsedNote } from './artifactNote'
import { timeAgo } from './model'
import './artifacts.css'

const SOURCE_LABEL: Record<ArtifactSource, string> = { manual: '手动登记', agent: 'Agent', run: '执行扫描', mcp: 'MCP 回写' }

/** lead：行首额外的内容（产出物视图放种类标签，TSK-0497） */
export function ArtifactRow({ a, p, copied, onCopy, lead }: {
  a: Artifact; p: ParsedNote; copied: boolean; onCopy: (a: Artifact) => void; lead?: ReactNode
}) {
  const file = p.kind === 'file'
  const label = file ? (a.url ? a.title || a.url : a.rel_path || a.path) : p.text || a.title || a.url || a.rel_path
  // 文件的备注放第二行；代码类的备注已经当标题用了
  const sub = file ? p.text : ''
  return (
    <li className="art-row" data-kind={p.kind}>
      {lead}
      <span className="art-main">
        {p.kind === 'commit' && p.sha && <span className="art-sha" title={p.sha}>{shortSha(p.sha)}</span>}
        {p.branch && <span className="art-branch"><Tag>{p.branch}</Tag></span>}
        {a.url
          ? <a className="ellipsis art-link" href={a.url} target="_blank" rel="noopener noreferrer" title={a.url}>{label}</a>
          : <span className={file ? 'ellipsis art-path' : 'ellipsis'} title={a.path}>{label}</span>}
        {sub && <span className="ellipsis art-sub">{sub}</span>}
      </span>
      <span className="src-tag" data-source={a.source} title={`来源：${a.source}`}>{SOURCE_LABEL[a.source] ?? a.source}</span>
      {a.path && !a.url && (
        <Button size="sm" title={a.path} onClick={() => onCopy(a)}>{copied ? '已复制' : '复制路径'}</Button>
      )}
      <span className="art-at">{timeAgo(a.created_at)}</span>
    </li>
  )
}

function AddForm({ objectId, onDone }: { objectId: string; onDone: () => void }) {
  const record = useRecordArtifact(objectId)
  const [loc, setLoc] = useState('')
  const [note, setNote] = useState('')
  const where = locationOf(loc)
  const bad = !!loc.trim() && !where
  const save = () => {
    if (!where || record.isPending) return
    record.mutate({ ...where, note: note.trim() }, { onSuccess: onDone })
  }
  return (
    <form className="art-form" aria-label="登记产出物" onSubmit={(e) => { e.preventDefault(); save() }}>
      <Input className="mono-input" value={loc} autoFocus invalid={bad} aria-label="链接或本机绝对路径"
        placeholder="链接或本机绝对路径" onChange={(e) => setLoc(e.target.value)} />
      <Input value={note} aria-label="备注" placeholder="备注；提交写成 [commit] sha=… branch=…"
        onChange={(e) => setNote(e.target.value)} />
      {bad && <span className="field-err">链接以 http 开头，路径要写绝对路径</span>}
      {record.error && <span className="field-err">{errorText(record.error)}</span>}
      <div className="art-form-acts">
        <Button type="submit" variant="primary" size="sm" disabled={!where || record.isPending}>{record.isPending ? '登记中' : '登记'}</Button>
        <Button size="sm" onClick={onDone}>取消</Button>
      </div>
    </form>
  )
}

/** focused：从任务行、看板、产出物视图点产出标记进来（?focus=artifacts，TSK-0497），打开后滚到这一块 */
export function ArtifactsPanel({ task, focused }: { task: WorkObject; focused?: boolean }) {
  const q = useObjectArtifacts(task.id)
  const [adding, setAdding] = useState(false)
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }, [focused, task.id])
  const [copied, setCopied] = useState('')
  const items = q.data?.data ?? []
  const groups = groupArtifacts(items)
  const copy = (a: Artifact) => {
    navigator.clipboard?.writeText(a.path).then(() => setCopied(a.id), () => setCopied(''))
  }
  return (
    <section ref={ref} className="dev-slot" data-slot="artifacts" data-task={task.id} aria-label="产出物">
      <div className="dev-slot-head">
        <span className="field-group-title">产出物<span className="art-hint">提交、分支、PR、文件</span></span>
        <span className="art-spacer" />
        {!adding && <Button size="sm" onClick={() => setAdding(true)}>登记产出物</Button>}
      </div>
      <QueryState query={q} compact>{() => (
        <>
          {!items.length && !adding && <div className="art-empty">还没有产出物</div>}
          {groups.map((g) => (
            <div key={g.key} className="art-group" role="group" aria-label={g.label}>
              <div className="art-group-name">{g.label}<span className="seg-n"> {g.items.length}</span></div>
              <ul className="art-list">
                {g.items.map(({ a, p }) => <ArtifactRow key={a.id} a={a} p={p} copied={copied === a.id} onCopy={copy} />)}
              </ul>
            </div>
          ))}
        </>
      )}</QueryState>
      {adding && <AddForm objectId={task.id} onDone={() => setAdding(false)} />}
    </section>
  )
}
