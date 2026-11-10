// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 项目知识库（TSK-0721）：设置里的「项目知识库」块，资料标签顶上的入口条。
// 每个项目绑一个知识库，项目资料（文件、文件夹、笔记、链接、关联的文档、文档目录）同步进去；
// 没绑时第一次同步（SOP 节点或这里的「立即同步」）按「<项目名> 项目知识库」新建并绑定。增量、只动同步加进来的由后端管。
import { useState } from 'react'
import { useNavigate } from 'react-router'
import {
  errorText, kbPagePath, kbSyncLine, useAgents, useBindProjectKb, useKnowledgeBases, useProjectKb, useSyncProjectKb,
  type ProjectKbSync,
} from '../../core/data'
import { Button, Select } from '../../core/ui'
import { ago } from './model'

/** 失败、跳过的原因最多先露几条 */
const PEEK = 5
const NONE = '__none__'

/** 一次同步的结果：一句话汇总，失败的原因，跳过的可展开 */
export function KbSyncResultView({ r }: { r: ProjectKbSync }) {
  const [open, setOpen] = useState(false)
  if (r.error) return <div className="pj-kb-res field-err" role="alert">没同步成：{r.error}</div>
  return (
    <div className="pj-kb-res">
      <span>{r.created ? `新建了「${r.kb_name}」并绑定；` : ''}{kbSyncLine(r)}</span>
      {r.failures.length > 0 && (
        <ul className="pj-kb-problems" aria-label="失败的资料">
          {r.failures.slice(0, PEEK).map((f, i) => <li key={i} className="field-err">{f.title}：{f.reason}</li>)}
          {r.failed > PEEK && <li className="pj-kb-note">另有 {r.failed - PEEK} 条失败</li>}
        </ul>
      )}
      {r.skipped > 0 && (
        <>
          <button type="button" className="pj-link" onClick={() => setOpen(!open)}>{open ? '收起跳过的' : `看跳过的 ${r.skipped} 条`}</button>
          {open && (
            <ul className="pj-kb-problems" aria-label="跳过的资料">
              {r.skips.map((f, i) => <li key={i} className="pj-kb-note">{f.title}：{f.reason}</li>)}
              {r.skipped > r.skips.length && <li className="pj-kb-note">另有 {r.skipped - r.skips.length} 条</li>}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

/** 设置里的「项目知识库」块：换绑、新建、解绑，挂到项目默认 Agent，立即同步和上次结果 */
export function ProjectKbBlock({ projectId }: { projectId: string }) {
  const navigate = useNavigate()
  const kb = useProjectKb(projectId)
  const kbs = useKnowledgeBases()
  const agents = useAgents()
  const bind = useBindProjectKb(projectId)
  const sync = useSyncProjectKb(projectId)
  const [err, setErr] = useState('')
  const v = kb.data
  const agent = v?.default_agent_id ? agents.data?.find((a) => a.id === v.default_agent_id) : undefined
  const busy = bind.isPending || sync.isPending
  const doBind = (body: Parameters<typeof bind.mutate>[0]) => {
    setErr('')
    bind.mutate(body, { onError: (e) => setErr(errorText(e)) })
  }
  const options = [{ value: NONE, label: '不绑定' }, ...(kbs.data ?? []).map((k) => ({ value: k.id, label: k.name }))]
  const last = sync.data ?? v?.last_result ?? null

  return (
    <section className="pj-block" aria-label="项目知识库">
      <h2 className="pj-sec-title">项目知识库<span className="pj-hint">项目资料（文件、文件夹、笔记、链接的标题和备注、关联的文档、文档目录）同步进这里；项目 Agent 挂上它就能检索。SOP「每周一 10:00 整理项目知识库」可定时同步</span></h2>
      {kb.isError && <span className="field-err" role="alert">没加载出来：{errorText(kb.error)}</span>}
      {v && (
        <>
          <div className="pj-kb-row">
            <label className="field pj-grow">
              <span className="field-label">绑定的知识库</span>
              <Select aria-label="绑定的知识库" value={v.kb_id && !v.missing ? v.kb_id : NONE} options={options} disabled={busy || !kbs.data}
                onValueChange={(id) => doBind({ kb_id: id === NONE ? '' : id })} />
            </label>
            <div className="pj-act-row pj-kb-acts">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => doBind({ create: true, attach_agent: !!agent })}>新建一个</Button>
              {v.kb && <Button size="sm" variant="outline" onClick={() => void navigate(kbPagePath(v.kb!.id))}>打开知识库</Button>}
            </div>
          </div>
          {v.missing && <span className="field-err">绑定的知识库已经删了；下次同步时按「项目名 项目知识库」新建一个，或在上面换一个</span>}
          {!v.kb_id && <span className="pj-kb-note">还没绑：第一次同步时自动新建「项目名 项目知识库」并绑定，也可以先在上面选一个已有的</span>}
          {v.kb && (
            <span className="pj-kb-note">
              {v.kb.docs} 篇{v.auto_created ? '，同步时自动建的' : ''}；
              {!v.default_agent_id ? '项目没有设 Agent，在 Agent 标签里加一个后可以挂上'
                : v.agent_attached ? `已挂到项目默认 Agent「${agent?.name ?? v.default_agent_id}」`
                  : <>项目默认 Agent「{agent?.name ?? v.default_agent_id}」还没挂上 <button type="button" className="pj-link" disabled={busy} onClick={() => doBind({ attach_agent: true })}>挂上</button></>}
            </span>
          )}
          <div className="pj-act-row pj-kb-acts">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => { setErr(''); sync.mutate(undefined, { onError: (e) => setErr(errorText(e)) }) }}>
              {sync.isPending ? '同步中' : '立即同步'}
            </Button>
            <span className="pj-kb-note">
              {sync.isPending ? '目录大时要一阵子，离开页面也会跑完'
                : v.last_sync_at ? `上次同步 ${ago(v.last_sync_at)}` : '还没同步过'}
            </span>
          </div>
          {last && !sync.isPending && <KbSyncResultView r={last} />}
        </>
      )}
      {err && <span className="field-err" role="alert">{err}</span>}
    </section>
  )
}

/** 资料标签顶上的入口：绑了的显示名字和篇数、点开知识库；没绑的指去设置 */
export function ProjectKbStrip({ projectId, onSettings }: { projectId: string; onSettings?: () => void }) {
  const navigate = useNavigate()
  const kb = useProjectKb(projectId)
  const v = kb.data
  if (!v) return null
  return (
    <div className="pj-kb-strip" role="group" aria-label="项目知识库">
      <span className="pj-kb-note">
        {v.kb ? <>项目知识库「{v.kb.name}」{v.kb.docs} 篇{v.last_sync_at ? `，上次同步 ${ago(v.last_sync_at)}` : '，还没同步过'}</>
          : v.missing ? '绑定的项目知识库已经删了' : '还没有项目知识库：资料可以同步进一个知识库，给项目 Agent 检索'}
      </span>
      {v.kb && <button type="button" className="pj-link" onClick={() => void navigate(kbPagePath(v.kb!.id))}>打开知识库</button>}
      {onSettings && <button type="button" className="pj-link" onClick={onSettings}>{v.kb ? '同步设置' : '去设置'}</button>}
    </div>
  )
}
