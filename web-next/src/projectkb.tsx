// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 项目知识库（TSK-0721，SPEC-projects-16）：设置里的「项目知识库」块、支持材料标签顶上的入口条（SPEC-projects-11.27）。
// 正式产品 frontend/src/plugins/projects/ProjectKb.tsx；绑定存在项目插件表 projects_kb，这里记在 Project.kb 上。
// 原型没有后端：「立即同步」等一会儿后把项目里的笔记、文本文件、文档目录里的 md/txt 收进知识库（kbStore），
// 不支持的类型记成跳过；没绑时按「<项目名> 项目知识库」新建并绑定、挂到项目默认 Agent。
import { useEffect, useRef, useState } from 'react'
import type { Agent, KnowledgeBase } from './agentdata'
import type { ContentItem } from './data'
import { kbStore, useKbStore } from './kbdata'
import { newId } from './ids'
import { docsDirFiles, kbSyncLine, type KbSyncResult, type Project } from './projectdata'
import { timeAgo } from './ui'

const PEEK = 5
const NONE = '__none__'
/** 只收文本：md、markdown、txt、text（正式产品同） */
const TEXT_EXT = /\.(md|markdown|txt|text)$/i
/** 演示里同步跑多久 */
const SYNC_MS = 1200

export interface ProjectKbEnv {
  kbs: KnowledgeBase[]
  agents: Agent[]
  content: ContentItem[]
  /** 去 设置 / 知识库 打开这个库 */
  onOpenKb: (id: string) => void
  /** 新建一个知识库（加进 设置 / 知识库） */
  onCreateKb: (kb: KnowledgeBase) => void
  /** 把知识库挂到 Agent 上（只加这一个，不动别的） */
  onAttachKb: (agentId: string, kbId: string) => void
}

/** 项目默认 Agent：agent_ids 里第一个还在的 */
const defaultAgent = (p: Project, agents: Agent[]) => p.agent_ids.map((id) => agents.find((a) => a.id === id)).find(Boolean)

function KbSyncResultView({ r }: { r: KbSyncResult }) {
  const [open, setOpen] = useState(false)
  if (r.error) return <div className="field-err">没同步成：{r.error}</div>
  return (
    <div className="pj-kb-res">
      <span>{r.created ? `新建了「${r.kb_name}」并绑定；` : ''}{kbSyncLine(r)}</span>
      {r.failures.length > 0 && (
        <ul className="pj-kb-problems" aria-label="失败的资料">
          {r.failures.slice(0, PEEK).map((f, i) => <li key={i} className="field-err">{f.title}：{f.reason}</li>)}
          {r.failed > PEEK && <li className="list-sub">另有 {r.failed - PEEK} 条失败</li>}
        </ul>
      )}
      {r.skipped > 0 && (
        <>
          <button className="link-btn" onClick={() => setOpen(!open)}>{open ? '收起跳过的' : `看跳过的 ${r.skipped} 条`}</button>
          {open && <ul className="pj-kb-problems" aria-label="跳过的资料">{r.skips.map((f, i) => <li key={i} className="list-sub">{f.title}：{f.reason}</li>)}</ul>}
        </>
      )}
    </div>
  )
}

/** 设置里的「项目知识库」块：换绑、新建、解绑，挂到项目默认 Agent，立即同步和上次结果 */
export function ProjectKbBlock({ p, env, onChange }: { p: Project; env: ProjectKbEnv; onChange: (x: Partial<Project>) => void }) {
  const store = useKbStore()
  const [syncing, setSyncing] = useState(false)
  const [fresh, setFresh] = useState<KbSyncResult | null>(null)
  const timer = useRef<number | null>(null)
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])
  const bound = p.kb?.kb_id ? env.kbs.find((k) => k.id === p.kb!.kb_id) : undefined
  const missing = !!p.kb?.kb_id && !bound
  const agent = defaultAgent(p, env.agents)
  const attached = !!(agent && bound && agent.kbs.includes(bound.id))
  const docsN = bound ? store.docs.filter((d) => d.kb_id === bound.id).length : 0

  const createKb = (): KnowledgeBase => {
    const kb: KnowledgeBase = { id: newId('kb'), name: `${p.name} 项目知识库`, desc: `「${p.name}」的项目资料，同步加进来的`, sources: ['project'], updated_at: new Date().toISOString() }
    env.onCreateKb(kb)
    if (agent) env.onAttachKb(agent.id, kb.id)
    return kb
  }
  const bindTo = (id: string) => onChange({ kb: id ? { kb_id: id } : undefined })

  // 同步：收笔记、文本类文件、文档目录里的文本文件；别的记跳过；按标题去重，已经收过的不重复收
  const sync = () => {
    setSyncing(true); setFresh(null)
    timer.current = window.setTimeout(() => {
      let kb = bound
      let created = false
      if (!kb) { kb = createKb(); created = true }
      const have = new Set(store.docs.filter((d) => d.kb_id === kb!.id).map((d) => d.title))
      const add: Parameters<typeof kbStore.addDocs>[0] = []
      const skips: KbSyncResult['skips'] = []
      const failures: KbSyncResult['failures'] = []
      for (const m of p.materials) {
        if (m.kind === 'note') { if (!have.has(m.name)) add.push({ kb_id: kb.id, title: m.name, source: { type: 'note' }, text: m.value }) }
        else if (m.kind === 'link') { if (!have.has(m.name)) add.push({ kb_id: kb.id, title: m.name, source: { type: 'link', ref: m.value }, text: `${m.name}\n${m.value}\n${m.tags.join(' ')}` }) }
        else if (m.kind === 'file' && TEXT_EXT.test(m.value)) { if (!have.has(m.name)) add.push({ kb_id: kb.id, title: m.name, source: { type: 'dir', ref: m.value }, text: `（${m.value} 的内容）` }) }
        else if (m.kind === 'folder' && !p.root) failures.push({ title: m.name, reason: '文件夹读不到：项目没设本地目录' })
        else skips.push({ title: m.name, reason: m.kind === 'folder' ? '原型读不了本机文件夹，正式产品逐个收里面的文本文件' : '不支持的类型（只收 md、markdown、txt、text）' })
      }
      for (const d of p.docs) {
        if (d.source.type !== 'library') continue
        const c = env.content.find((x) => x.id === (d.source as { content_id: string }).content_id)
        if (c && !have.has(c.title)) add.push({ kb_id: kb.id, title: c.title, source: { type: 'library', ref: c.id }, text: c.body })
      }
      for (const f of p.docs_dir ? docsDirFiles(p.docs_dir) : []) {
        if (!TEXT_EXT.test(f.name)) { skips.push({ title: f.rel, reason: '不支持的类型（只收 md、markdown、txt、text）' }); continue }
        if (f.size > 1024 * 1024) { skips.push({ title: f.rel, reason: '超过 1MB' }); continue }
        if (!have.has(f.rel)) add.push({ kb_id: kb.id, title: f.rel, source: { type: 'dir', ref: f.rel }, text: `（文档目录 ${f.rel} 的内容）` })
      }
      if (add.length) kbStore.addDocs(add)
      const r: KbSyncResult = { added: add.length, updated: 0, removed: 0, failed: failures.length, skipped: skips.length, failures, skips, created, kb_name: kb.name }
      onChange({ kb: { kb_id: kb.id, auto_created: created || p.kb?.auto_created, last_sync_at: new Date().toISOString(), last_result: r } })
      setFresh(r); setSyncing(false)
    }, SYNC_MS)
  }
  const last = fresh ?? p.kb?.last_result ?? null

  return (
    <section className="hook-sec">
      <div className="field-group-title">项目知识库<span className="field-hint">项目资料（文件、文件夹、笔记、链接的标题和备注、关联的文档、文档目录）同步进这里；项目 Agent 挂上它就能检索。SOP「每周一 10:00 整理项目知识库」可定时同步</span></div>
      <div className="pj-kb-row">
        <label className="field pj-grow"><span className="field-label">绑定的知识库</span>
          <select value={bound ? bound.id : NONE} disabled={syncing} onChange={(e) => bindTo(e.target.value === NONE ? '' : e.target.value)}>
            <option value={NONE}>不绑定</option>
            {env.kbs.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
        </label>
        <div className="act-row pj-kb-acts">
          <button className="act" disabled={syncing} onClick={() => { const kb = createKb(); onChange({ kb: { kb_id: kb.id, auto_created: true } }) }}>新建一个</button>
          {bound && <button className="act" onClick={() => env.onOpenKb(bound.id)}>打开知识库</button>}
        </div>
      </div>
      {missing && <span className="field-err">绑定的知识库已经删了；下次同步时按「项目名 项目知识库」新建一个，或在上面换一个</span>}
      {!p.kb?.kb_id && <span className="list-sub">还没绑：第一次同步时自动新建「项目名 项目知识库」并绑定，也可以先在上面选一个已有的</span>}
      {bound && (
        <span className="list-sub">
          {docsN} 篇{p.kb?.auto_created ? '，同步时自动建的' : ''}；
          {!agent ? '项目没有设 Agent，在 Agent 标签里加一个后可以挂上'
            : attached ? `已挂到项目默认 Agent「${agent.name}」`
              : <>项目默认 Agent「{agent.name}」还没挂上 <button className="link-btn" disabled={syncing} onClick={() => env.onAttachKb(agent.id, bound.id)}>挂上</button></>}
        </span>
      )}
      <div className="act-row pj-kb-acts">
        <button className="act act-primary" disabled={syncing} onClick={sync}>{syncing ? '同步中' : '立即同步'}</button>
        <span className="list-sub">{syncing ? '目录大时要一阵子，离开页面也会跑完' : p.kb?.last_sync_at ? `上次同步 ${timeAgo(p.kb.last_sync_at)}` : '还没同步过'}</span>
      </div>
      {last && !syncing && <KbSyncResultView r={last} />}
    </section>
  )
}

/** 支持材料标签顶上的入口：绑了的显示名字和篇数、点开知识库；没绑的指去设置 */
export function ProjectKbStrip({ p, env, onSettings }: { p: Project; env: ProjectKbEnv; onSettings: () => void }) {
  const store = useKbStore()
  const kb = p.kb?.kb_id ? env.kbs.find((k) => k.id === p.kb!.kb_id) : undefined
  const n = kb ? store.docs.filter((d) => d.kb_id === kb.id).length : 0
  return (
    <div className="pj-kb-strip" role="group" aria-label="项目知识库">
      <span className="list-sub">
        {kb ? <>项目知识库「{kb.name}」{n} 篇{p.kb?.last_sync_at ? `，上次同步 ${timeAgo(p.kb.last_sync_at)}` : '，还没同步过'}</>
          : p.kb?.kb_id ? '绑定的项目知识库已经删了' : '还没有项目知识库：资料可以同步进一个知识库，给项目 Agent 检索'}
      </span>
      {kb && <button className="link-btn" onClick={() => env.onOpenKb(kb.id)}>打开知识库</button>}
      <button className="link-btn" onClick={onSettings}>{kb ? '同步设置' : '去设置'}</button>
    </div>
  )
}
