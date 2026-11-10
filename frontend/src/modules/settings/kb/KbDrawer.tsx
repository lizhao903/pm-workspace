// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

// 知识库抽屉（SPEC-settings-14）：新建，或改名称、说明、来源分类，以及删除。
// 来源分类是「文档」的分类（后端 categories，type 为 doc）；分类没有启停，已经选了但被删掉的照样列出来方便取消。
// 保存后抽屉不关：新建的切成编辑这一个。
import { useState } from 'react'
import { errorText, useCreateKb, useDeleteKb, usePatchKb, type KnowledgeBase } from '../../../core/data'
import { Avatar, Button, cls, ConfirmDialog, Drawer, Field, Input } from '../../../core/ui'
import { agentNames } from './model'
import { useDocCategories } from './categories'

type Draft = { name: string; desc: string; sources: string[] }
const draftOf = (kb?: KnowledgeBase): Draft => ({ name: kb?.name ?? '', desc: kb?.desc ?? '', sources: kb?.sources ?? [] })
const same = (a: Draft, b: Draft) => a.name === b.name && a.desc === b.desc && a.sources.join() === b.sources.join()

/** 在用的 Agent：名字标签，多了先露几个 */
const CHIPS = 8
function UserChips({ list }: { list: { id: string; name: string }[] }) {
  const [all, setAll] = useState(false)
  return (
    <div className="kb-user-list">
      {(all ? list : list.slice(0, CHIPS)).map((a) => (
        <span key={a.id} className="tag kb-user" title={a.name}><Avatar name={a.name} size={16} /><span className="ellipsis">{a.name}</span></span>
      ))}
      {list.length > CHIPS && <button type="button" className="kb-link" onClick={() => setAll(!all)}>{all ? '收起' : `还有 ${list.length - CHIPS} 个`}</button>}
    </div>
  )
}

export function KbDrawer({ kb, onClose, onCreated, onDeleted }: {
  /** 没有就是新建 */
  kb?: KnowledgeBase
  onClose: () => void
  onCreated: (k: KnowledgeBase) => void
  onDeleted?: () => void
}) {
  const creating = !kb
  const cats = useDocCategories()
  const create = useCreateKb()
  const patch = usePatchKb()
  const remove = useDeleteKb()
  const [draft, setDraft] = useState<Draft>(() => draftOf(kb))
  const [tried, setTried] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const base = draftOf(kb)
  const dirty = creating ? !!(draft.name.trim() || draft.desc.trim() || draft.sources.length) : !same(draft, base)
  const busy = create.isPending || patch.isPending || remove.isPending
  const nameBad = tried && !draft.name.trim()
  const users = kb?.agents ?? []
  // 全部文档分类，加上已经选了但分类树里没有的（被删了）
  const options = [...cats.list, ...draft.sources.filter((id) => cats.loaded && !cats.list.some((c) => c.id === id)).map((id) => ({ id, label: cats.label(id) }))]
  const toggle = (id: string) => setDraft({ ...draft, sources: draft.sources.includes(id) ? draft.sources.filter((x) => x !== id) : [...draft.sources, id] })

  const save = () => {
    setTried(true)
    setError(null)
    const name = draft.name.trim()
    if (!name) return
    const body = { name, desc: draft.desc.trim(), sources: draft.sources }
    if (!kb) {
      create.mutate(body, { onSuccess: (k) => onCreated(k), onError: (e) => setError(errorText(e)) })
      return
    }
    patch.mutate({ id: kb.id, patch: body }, {
      onSuccess: (k) => setDraft(draftOf(k)),
      onError: (e) => setError(errorText(e)),
    })
  }
  const doDelete = () => {
    if (!kb) return
    // 删掉后列表一刷抽屉就卸了，mutate 的回调不会再来，用 mutateAsync 的 Promise 收尾
    remove.mutateAsync(kb.id).then(
      () => { setConfirmDel(false); onDeleted?.() },
      (e: unknown) => { setConfirmDel(false); setError(`删除失败：${errorText(e)}`) },
    )
  }

  return (
    <Drawer open onClose={onClose} kicker={creating ? '新建知识库' : '知识库'} aria-label={creating ? '新建知识库' : `知识库 ${kb.name}`} dirty={dirty}
      footer={(requestClose) => (
        <>
          {!creating && <Button variant="danger-ghost" disabled={busy} onClick={() => setConfirmDel(true)}>删除</Button>}
          <span className="spacer" />
          <Button onClick={requestClose}>取消</Button>
          <Button variant="primary" disabled={busy || (!creating && !dirty)} onClick={save}>{creating ? '创建' : '保存'}</Button>
        </>
      )}>
      <div className="form kb-form">
        {error && <div className="kbx-alert kbx-alert-bad" role="alert">{error}</div>}
        <Field label="名称" required>
          <Input value={draft.name} autoFocus={creating} invalid={nameBad} placeholder="比如：竞品资料" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <Field label="说明">
          <Input value={draft.desc} placeholder="放了什么、给谁用" onChange={(e) => setDraft({ ...draft, desc: e.target.value })} />
        </Field>
        <Field wrap={false} label={<>文档分类<span className="kbx-hint">选了的分类里的文档会收进来，可以多选，也可以不选只手动加</span></>}
          hint="本地目录、上传的文件、网页和笔记，在知识库详情里加">
          <div className="kb-cats" role="group" aria-label="文档分类">
            {!cats.loaded ? <span className="kb-muted">加载中</span> : !options.length ? <span className="kb-muted">「文档」里还没有分类</span>
              : options.map((c) => (
                <label key={c.id} className={cls('kb-cat', draft.sources.includes(c.id) && 'on')}>
                  <input type="checkbox" checked={draft.sources.includes(c.id)} onChange={() => toggle(c.id)} />{c.label}
                </label>
              ))}
          </div>
        </Field>
        <Field wrap={false} label="在用的 Agent">
          {users.length ? <UserChips list={users} /> : <span className="kb-muted">还没有 Agent 挂这个知识库，到「设置 / Agent」里挂</span>}
        </Field>
      </div>
      {kb && (
        <ConfirmDialog open={confirmDel} danger title={`删除知识库「${kb.name}」？`} confirmLabel="删除" busy={remove.isPending}
          onConfirm={doDelete} onCancel={() => setConfirmDel(false)}>
          {users.length ? `${agentNames(users)} 挂着它，删除后会自动卸下` : '删除后不能恢复，原文档不受影响'}
        </ConfirmDialog>
      )}
    </Drawer>
  )
}
