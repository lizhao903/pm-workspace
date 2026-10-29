// 文档标签（SPEC-projects-8）：列出 type=doc 且 project_id 为本项目的文档。
// 「加文档」把「文档」里的一篇归到本项目（改它的 project_id），「移除」只是移出项目，文档本身不动；状态取文档类型的状态集。
// 规格里「项目目录里的文件」和文档类型（PRD、技术方案）等项目资料合并时做（PJ-03），这里只关联工作台文档。
import { useMemo, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router'
import { errorText, useAllObjects, useObjectTypes, usePatchObject, useSetStatus, type WorkObject } from '../../core/data'
import { Button, EmptyState, ErrorState, LoadingState, SearchSelect } from '../../core/ui'
import { ago } from './model'

const DOC = 'doc'
/** 来源列：现在只关联工作台文档；项目目录里的文件等「项目资料与文档合并」（P-2）再加，到时显示路径 */
const LIBRARY = '文档库'

export function DocsTab({ projectId, adding, onAdding }: {
  projectId: string
  /** 加文档的内联表单开着没有；右上「加文档」打开 */
  adding: boolean
  onAdding: (on: boolean) => void
}) {
  const navigate = useNavigate()
  const types = useObjectTypes()
  const docs = useAllObjects({ type: [DOC], project: projectId, sort: '-updated_at' })
  // 候选只在表单打开时取
  const library = useAllObjects({ type: [DOC], sort: '-updated_at' }, { enabled: adding })
  const link = usePatchObject()
  const setStatus = useSetStatus()
  const [pick, setPick] = useState('')
  const [err, setErr] = useState('')

  const statuses = useMemo(() => types.data?.find((t) => t.id === DOC)?.statuses ?? [], [types.data])
  const rows = docs.data?.data ?? []
  const cands = (library.data?.data ?? []).filter((d) => d.project_id !== projectId)

  const close = () => { setPick(''); onAdding(false) }
  const submit = () => {
    if (!pick) return
    setErr('')
    link.mutate({ id: pick, patch: { project_id: projectId } }, { onSuccess: close, onError: (e) => setErr(`没加上：${errorText(e)}`) })
  }
  const unlink = (d: WorkObject) => {
    setErr('')
    link.mutate({ id: d.id, patch: { project_id: null } }, { onError: (e) => setErr(`${d.title} 没移除：${errorText(e)}`) })
  }
  const changeStatus = (d: WorkObject, status: string) => {
    setErr('')
    setStatus.mutate({ id: d.id, status }, { onError: (e) => setErr(`${d.title} 没改成：${errorText(e)}`) })
  }

  const form = adding && (
    <div className="pj-inline-form">
      <SearchSelect variant="field" aria-label="选一篇文档" value={pick} placeholder="选一篇文档" searchPlaceholder="搜文档标题"
        disabled={!library.data} emptyText={library.isError ? '文档列表没取到' : '「文档」里没有别的文档了'}
        options={cands.map((d) => ({ value: d.id, label: d.title || '未命名', hint: d.project_title ? `在「${d.project_title}」` : d.category_name || undefined }))}
        onChange={setPick} />
      {pick && cands.find((d) => d.id === pick)?.project_id && <span className="pj-muted pj-wrap">这篇已属于别的项目，加上后改归本项目</span>}
      <div className="pj-act-row">
        <Button variant="primary" disabled={!pick || link.isPending} onClick={submit}>加上</Button>
        <Button onClick={close}>取消</Button>
      </div>
    </div>
  )

  let body
  if (docs.isError) body = <ErrorState title="文档没加载出来" error={errorText(docs.error)} onRetry={() => void docs.refetch()} />
  else if (docs.isPending || types.isPending) body = <LoadingState />
  else if (!rows.length) body = !adding && <EmptyState title="还没有产品文档" desc="把「文档」里的 PRD、方案归到这个项目，在这里集中看" action={<Button variant="primary" onClick={() => onAdding(true)}>加文档</Button>} />
  else {
    body = (
      <div className="pj-table" role="table" aria-label="项目文档">
        <div className="pj-doc pj-th" role="row">
          <span role="columnheader">文档</span><span role="columnheader">类型</span><span role="columnheader">来源</span><span role="columnheader">状态</span>
          <span role="columnheader">更新</span><span role="columnheader" aria-label="操作" />
        </div>
        {rows.map((d) => {
          const st = statuses.find((s) => s.key === d.status)
          return (
            <div key={d.id} className="pj-doc" role="row">
              <span role="cell" className="ellipsis">
                <button type="button" className="pj-link pj-doc-title" title="在「文档」里打开" onClick={() => navigate(`/docs?doc=${encodeURIComponent(d.id)}`)}>{d.title || '未命名'}</button>
              </span>
              <span role="cell"><span className="tag">{d.category_name || '未分类'}</span></span>
              <span role="cell" className="pj-doc-src ellipsis">{LIBRARY}</span>
              <span role="cell">
                <select className="pj-chip-select pj-doc-status" aria-label={`${d.title} 的状态`} value={d.status}
                  style={{ '--c': st?.color || 'var(--faint)' } as CSSProperties} onChange={(e) => changeStatus(d, e.target.value)}>
                  {!st && <option value={d.status}>{d.status}</option>}
                  {statuses.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </span>
              <span role="cell" className="pj-muted" title={d.updated_at}>{ago(d.updated_at)}</span>
              <span role="cell"><Button size="sm" disabled={link.isPending} onClick={() => unlink(d)}>移除</Button></span>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="pj-tab">
      {form}
      {err && <div className="pj-err" role="alert">{err}</div>}
      {body}
    </div>
  )
}
